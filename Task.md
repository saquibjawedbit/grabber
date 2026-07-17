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

### Phase 1 — Vectorize-backed recall & dedup (removes the ceiling)
- [ ] Create a Vectorize index (384-dim, cosine) — matches `bge-small-en-v1.5`.
      Add the binding to `worker/wrangler.toml`.
- [ ] On `saveMemory`: after the D1 insert, upsert `{id, values, metadata:{category}}`
      into Vectorize. Keep writing the packed vector to D1 too (rebuild source).
- [ ] Rewrite dedup check in `saveMemory` to `query()` Vectorize top-K instead of the
      400-row scan; keep the ≥ 0.90 near-duplicate rule and the `exclude` set.
- [ ] Rewrite `recallMemories` to `query()` Vectorize (topK = `RECALL_K`), then hydrate
      facts from D1 by id. Keep un-embedded rows riding along (fetch a few `WHERE
      embedding IS NULL`).
- [ ] `forgetMemory` / reconcile deletes must also delete from Vectorize by id.
- [ ] **Fallback:** wrap every Vectorize call; on error, fall back to the existing D1
      cosine scan so recall/dedup degrade instead of failing.

### Phase 2 — Backfill & consistency
- [ ] One-shot `/api/*` admin endpoint (gated by `DASH_TOKEN`) to backfill all existing
      D1 vectors into Vectorize.
- [ ] Extend `reconcile()` so a merge/forget keeps D1 and Vectorize in sync.

### Phase 3 — Retrieval quality (optional, after the ceiling is gone)
- [ ] Hybrid ranking: blend cosine with recency (`updated_at`) and an importance score,
      instead of pure top-K cosine.
- [ ] Consider a lightweight importance/decay field on `memories` (schema + migration).
- [ ] Optional: periodic "reflection" pass that summarizes clusters of related facts.

## Verification (no test suite in this repo)

- [ ] `wrangler dev` + `/api/tool?name=save_memory&args=...` — save a near-duplicate,
      confirm it dedupes via Vectorize.
- [ ] `/api/tool?name=...` recall path returns relevant facts with > 400 rows present.
- [ ] Kill/misconfigure the Vectorize binding → confirm graceful fallback to D1 scan.
- [ ] `wrangler tail` shows no unhandled errors on save/recall/forget.

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

- [ ] Add an optional `args` schema to each tool entry (plain object: field → `{type,
      required, enum?}`), alongside the existing `desc`. No new dependency.
- [ ] In `runAgent`, before calling `tool.run`, validate `action.args` against the
      schema. On failure, append the validation error to the `transcript` (same channel
      the protocol-nudge uses) so the model retries with corrected args — do NOT crash
      the step.
- [ ] Auto-render arg types into the prompt's tool list (`toolList()`, `agent.js:326`)
      from the schema, so `desc` and the real contract can't drift apart.
- [ ] Roll out incrementally: schema is optional, so untyped tools keep working — add
      schemas to the highest-traffic tools first (`save_memory`, `set_reminder`,
      `add_quest`, the LIFE_TOOLS money writers where a bad number is expensive).

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

- [ ] `wrangler dev`: call a tool with a missing/wrong-typed arg via
      `/api/tool?name=set_reminder&args=...` → confirm it returns a validation error and,
      in a real chat, the model self-corrects on the next step (`wrangler tail`).
- [ ] Confirm untyped tools still run unchanged (schema is opt-in).

## Files in scope

- `worker/src/agent.js` — tool registry entries, `toolList()`, `runAgent` validation.
- `worker/src/system.js`, `apply.js`, `life.js` — add `args` schemas to their tools.
- `CLAUDE.md` — note the typed-tool convention in the conventions section.
