# Task: Memory Layer Upgrade

Move the memory layer from a linear D1 scan to a proper vector index, and add the
retrieval-quality pieces the current design is missing — without losing the parts
that already work well (decoupled extraction, reconcile pass, semantic dedup).

## Why

The memory *design* is strong (extraction runs after the reply so it can't lose a
race — `memory.js:1-11`; `reconcile()` re-reads the whole set; dedup is semantic on
cosine ≥ 0.90). The memory *retrieval* is the weak part:

- **Hard `LIMIT 400` / `LIMIT 200` scan in JS.** `recallMemories` (`memory.js:56`)
  and `saveMemory`'s dedup check (`memory.js:112`) both `SELECT ... ORDER BY id DESC
  LIMIT 400` and compute cosine in a JS loop. Past 400 facts they only ever see the
  *newest* 400, so old facts stop being recalled **and** stop blocking duplicates —
  the agent silently re-saves things it already knows.
- **Recall is pure cosine top-K.** No recency, importance, or decay signal.
- **One flat table.** No episodic/semantic split, no reflections/summaries of memory.

Cloudflare **Vectorize** is on the same free tier and removes the ceiling.

## Guardrails (do not break these)

- **D1 `memories` rows stay the source of truth.** Vectorize holds only vectors +
  ids for search. A rebuild-from-D1 path must always be possible.
- Extraction stays **decoupled from the agent loop** (runs in `rememberExchange` /
  `waitUntil`, never as a competing tool step).
- Every external call **fails soft**: if Vectorize is down, fall back to the D1 scan
  rather than losing a write or a recall (repo convention — see CLAUDE.md).
- `schema.sql` + a new `migrations/` file for any table change; update the docs the
  change touches (`docs/` memory section, CLAUDE.md module map) **in the same commit**.

## Plan

### Phase 1 — Vectorize-backed recall & dedup (removes the ceiling) ✅
- [x] Create a Vectorize index (384-dim, cosine) — matches `bge-small-en-v1.5`.
      Add the binding to `worker/wrangler.toml`. *(index `grabber-memories` created)*
- [x] On `saveMemory`: after the D1 insert, upsert `{id, values, metadata:{category}}`
      into Vectorize. Keep writing the packed vector to D1 too (rebuild source).
- [x] Rewrite dedup check in `saveMemory` to `query()` Vectorize top-K instead of the
      400-row scan; keep the ≥ 0.90 near-duplicate rule and the `exclude` set.
      *(also: a near-dup hit whose D1 row is gone = stale index entry, deleted on the spot)*
- [x] Rewrite `recallMemories` to `query()` Vectorize (topK = `RECALL_K`), then hydrate
      facts from D1 by id. Keep un-embedded rows riding along (fetch a few `WHERE
      embedding IS NULL`).
- [x] `forgetMemory` / reconcile deletes must also delete from Vectorize by id.
- [x] **Fallback:** wrap every Vectorize call; on error — or an *empty* index, which is
      what deployed-but-not-backfilled looks like — fall back to the existing D1
      cosine scan so recall/dedup degrade instead of failing.

### Phase 2 — Backfill & consistency ✅
- [x] One-shot `/api/vector-backfill` admin endpoint (gated by `DASH_TOKEN`) to backfill
      all existing D1 vectors into Vectorize (batches of 100, idempotent).
- [x] Extend `reconcile()` so a merge/forget keeps D1 and Vectorize in sync — free:
      reconcile routes through `saveMemory`/`forgetMemory`, which both mirror the index.

### Phase 3 — Retrieval quality (optional, after the ceiling is gone)
- [ ] Hybrid ranking: blend cosine with recency (`updated_at`) and an importance score,
      instead of pure top-K cosine.
- [ ] Consider a lightweight importance/decay field on `memories` (schema + migration).
- [ ] Optional: periodic "reflection" pass that summarizes clusters of related facts.

## Verification (no test suite in this repo)

- [x] Offline harness (mocked AI/DB/Vectorize bindings): save mirrors into the index;
      identical fact dedupes via the index; recall hydrates from D1 in score order;
      **empty index falls back to the D1 scan** (pre-backfill window); forget deletes
      from both stores; a throwing index degrades soft on save *and* recall. 6/6 pass.
- [x] **Deployed** (version c5a474a3, 2026-07-18) with the `VECTORIZE` binding live.
      Backfill done via `wrangler vectorize insert` (19/19 D1 vectors; index reports
      vectorCount 19). Round-trip verified: querying by a stored id returns itself at
      score 0.99999, neighbours at ~0.72 — below the 0.90 dedup threshold, as expected.
      (`/api/vector-backfill` remains the tokened rebuild path for the future.)
- [x] Live spot-check (via `wrangler dev --remote` against the real D1/Vectorize/AI
      bindings): saving an existing fact verbatim → `{ok, id:10, "already known"}`
      (deduped through the index); a paraphrase below 0.90 inserted (id 36), appeared
      in the index at score 0.99999, then `DELETE /api/memory?id=36` removed it from
      **both** stores (D1 count 0, index vectorCount back to 19). Test data cleaned up.

## Files in scope

- `worker/src/memory.js` — recall, dedup, save, forget, reconcile, backfill
- `worker/src/agent.js` — `context()` recall call (should be transparent)
- `worker/wrangler.toml` — Vectorize binding
- `schema.sql` + `migrations/00X_memory_vectorize.sql`
- `docs/` (memory section) + `CLAUDE.md` module map

## Out of scope

- The agent loop / tool protocol (`runAgent`) — unchanged.
- The extraction prompt and reconcile prompt logic — unchanged (only their write/delete
  side effects gain a Vectorize mirror).

---

# Task: Agent Loop Upgrades (borrow from frameworks, not the framework)

Two targeted improvements that give us the useful parts of a framework (LangChain /
LangGraph) without the dependency weight, the bundle-size hit on Workers, or fighting
our model-specific workarounds (the gpt-oss reasoning-channel salvage in `llm.js:13`,
the protocol-nudge/final-compose fallback in `agent.js:445-472`). Keep the hand-rolled
loop — it's the right call for one owner + one model + a JSON-text protocol.

## 1. Typed tool schema (validate args before `tool.run`)

**Why.** Tools are described as prose `desc` strings (`agent.js:30`, etc.) and
`runAgent` trusts whatever JSON the model emits — `tool.run(env, action.args || {})`
(`agent.js:460`). A malformed or missing arg only fails *inside* the tool, or worse
does the wrong thing silently. A lightweight schema catches it at the boundary and
lets us hand the model a precise error to self-correct.

- [x] Add an optional `args` schema to each tool entry (plain object: field → `{type,
      required, enum?}`), alongside the existing `desc`. No new dependency.
      *(validator coerces leniently: `"5"` → `5`, `"true"` → `true` — the model does this
      constantly and every tool already tolerated it via `Number()`)*
- [x] In `runAgent`, before calling `tool.run`, validate `action.args` against the
      schema. On failure, the error becomes an `{error: "invalid args: …"}` tool result
      in the `transcript` so the model retries with corrected args — never a crashed
      step. Same check added to `/api/tool` so manual testing exercises it.
- [x] Auto-render arg types into the prompt's tool list (`toolList()`) as a compact
      `[checked args: …]` signature, so `desc` and the real contract can't drift apart.
- [x] Roll out incrementally: schemas added to `web_search`, `web_fetch`, `save_memory`,
      `forget_memory`, `set_reminder`, `cancel_reminder`, `spawn_research`, `watch_app`,
      the goal/quest writers, the money/body/people writers, and the apply tools.
      Untyped tools keep working. `list_goals.status` and `log_transaction.category`
      deliberately unchecked (both have smarter fallbacks than an enum error).
      Validator: 10/10 offline cases pass (required/coercion/enum/empty-string).

**Guardrail.** Validation failure must degrade to a retry with feedback, never a
thrown step — mirror the existing "broke protocol → nudge, keep going" behavior.

## 2. Graph/state mindset (adopt the pattern, not the package)

**Only if/when** we add planning, parallel tool calls, or streaming — not now. Captured
so we reach for the pattern instead of importing LangGraph reflexively.

- [ ] If tool count or step complexity grows, replace the growing string `transcript`
      (`agent.js:439`) with an explicit step/state list (structured tool-call records),
      which is easier to compact, branch, and reason about.
- [ ] Consider a planner→executor split only if single-loop reasoning starts missing
      multi-step tasks — encode it as our own small state machine, not a framework.
- [ ] Parallel independent tool calls (e.g. fan out `get_calendar` + `search_email`)
      would need the state model above first.

**Trigger to revisit the whole "no framework" decision:** going multi-provider *inside
the Worker* (the pipeline already does NVIDIA→Gemini→Groq — `pipeline/grabber/config.py`)
or serving more than one owner. Until then, hand-rolled wins.

## Verification

- [x] `validateArgs` exercised offline: missing-required, numeric-string coercion,
      bad-number rejection, enum rejection, optional-enum absent, boolean coercion,
      empty-string-as-missing — 10/10 pass. Untyped tools bypass validation (opt-in).
- [x] Live spot-check (via `wrangler dev --remote`, real bindings):
      `set_reminder` without `due_at` → `invalid args: missing required arg "due_at"
      (string)`; `complete_quest` with `action:"finished"` → enum error listing the
      valid values; `cancel_reminder` with `id:"999999"` (string) → coerced, reached
      the tool, returned "no reminder with that id". All three exactly as designed.

## Files in scope

- `worker/src/agent.js` — tool registry entries, `toolList()`, `runAgent` validation.
- `worker/src/system.js`, `apply.js`, `life.js` — add `args` schemas to their tools.
- `CLAUDE.md` — note the typed-tool convention in the conventions section.
