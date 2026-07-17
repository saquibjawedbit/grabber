# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`grabber` is a zero-cost personal agent — **The System**, a strict mentor (in the *Solo Leveling* sense) whose one motive is to drive the owner to their declared goals via daily **quests**, accountability, penalties and leveling — and doubles as a general life agent (money, calendar, mail, people, health, research). It runs on free tiers only: Cloudflare Workers/D1/Workers AI, GitHub Actions, Telegram, with optional LLM fallbacks. The old job-board "opportunity engine" (watchers/IDF/alerts/calibration) was removed in favour of The System — see `docs/05-the-system.md`. Read `README.md` for the product story; this file covers how to work in the code.

## ⚠️ After every change, update the stale docs

Documentation in this repo is treated as part of the change, not an afterthought. **After any code change, update every doc the change touched, in the same commit** — do not leave docs describing how things used to work. Specifically:

- **`docs/`** — the architecture reference (`01`–`08` + `README.md`). Each doc cites `file:line` and describes real behavior; if you change a flow, table, tool, route, cron, constant, or prompt it documents, update that doc *and* any Mermaid diagram in it.
- **`CLAUDE.md`** (this file) — update the architecture/commands/conventions sections when they drift.
- **`schema.sql`** + **`migrations/`** — any table add/alter updates `schema.sql` and adds a migration (see below).
- **`README.md`** — update if setup, secrets, or the design principles change.

Before finishing a task, do a quick sweep: "what did I change, and which of the above now describes the old behavior?" Fix those. If a doc and the code disagree, the code wins — correct the doc.

## The two-runtime architecture

There are two execution environments that **share one D1 (SQLite) database**. The split is deliberate: I/O-bound, always-on, interactive work lives in the Worker; CPU-heavy or long-running work lives in GitHub Actions.

1. **Cloudflare Worker** (`worker/`) — always on. Handles the Telegram webhook (chat + every quest button tap → XP/streak), the conversational agent loop, the dashboard + JSON API, and an hourly cron (reminders, senses, money, The System's quest issuance + nightly reckoning). This is where almost all logic lives.
2. **GitHub Actions pipeline** (`pipeline/`, Python) — scheduled/dispatched. Only two jobs, because only these genuinely need a real machine:
   - `research.yml` (dispatched by the agent via `repository_dispatch`): a Playwright browsing agent that digs for ~10 min and writes a cited report to D1 (time).
   - `email.yml` (every 20 min): poll Gmail over IMAP and write matching mail to D1 (Workers can't speak IMAP).
   - *(The old `nightly.yml` IDF/calibration job was removed with the opportunity engine.)*

D1 is reached two ways: from the Worker via the `DB` binding (`env.DB.prepare(...)`), and from Python via D1's REST API (`pipeline/grabber/db.py`, class `D1`). **`schema.sql` is the source of truth for the shared schema**; `migrations/` holds incremental changes. When you add/alter a table, update `schema.sql` and add a migration. Note: 6 opportunity-engine tables (`postings`, `idf`, `alerts`, `outcomes`, `drafts`, `calibration`) plus `watchers` are now **inert** — kept so the current dashboard keeps querying, pending a cleanup migration.

### Cross-runtime coupling to remember
- The research runner (CI) borrows the **Worker's IP** to run web searches, because search engines 202-challenge CI datacenter IPs. It calls back through `DASH_URL`/`DASH_TOKEN`. See `research.yml` comments and `pipeline/grabber/config.py`.
- The research repo is **public**, so its Actions logs are public. Only a job *id* travels through the dispatch payload; the runner reads the question from D1 and never echoes memories/profile/report bodies. Do not add `echo`s of job content to workflows.
- `profile/` (resume, bio, skills, past essays) is **gitignored** and lives only in D1. It's seeded with `pipeline/scripts/seed_profile.py`.

## Worker internals

Entry point `worker/src/index.js` exports `{ fetch, scheduled }`:
- `fetch` routes: `/telegram` (webhook — text/voice/video/image/file, and callback buttons → `outcomes` labels), `/api/*` (dashboard API + admin/backfill endpoints, gated by `DASH_TOKEN`), `/ingest/notification` (phone bridge, gated by its own `NOTIFY_SECRET`), and static assets (`public/index.html`, the single-file dashboard).
- `scheduled` runs hourly: reminders, senses, money, and `runSystem` — each wrapped so one failure never stops the others. `runSystem` self-gates on the IST hour (issue quests at 07:00, hold the reckoning at 21:00).

Module map (all under `worker/src/`):
- `agent.js` — the agent. Defines `TOOLS`, assembles the system prompt, and runs a **JSON-protocol tool loop** (`MAX_STEPS = 8`): the model replies with exactly one JSON object, `{"tool","args"}` or `{"reply"}`. Also owns chat-history compaction into a rolling summary.
- `system.js` — **The System**: `goals`/`quests` CRUD, XP/level/streak (in `state`), quest generation, `issueDaily`, `debrief` (the nightly reckoning), `runSystem` (cron entry), and `SYSTEM_TOOLS`. The strict-mentor motive lives here.
- `llm.js` — the single `llm(env, prompt)` call (Workers AI `@cf/openai/gpt-oss-120b`) plus `extractJson`. **gpt-oss quirk**: it sometimes stops inside its reasoning channel without emitting a final message; `llm` salvages that text but returns `salvaged: true` so callers never ship raw reasoning to the owner. `extractJson` scans for the *last* balanced `{...}`.
- `memory.js` — durable-fact memory: extraction after each exchange, embedding-based recall (`recallMemories`), reconcile/backfill.
- `perception.js`, `persona.js` — how the agent sees the owner ("How I see you") and the configurable voice used across every prompt. **Default persona is now The System** (strict mentor); `voiceBlock` always injects the voice.
- `senses.js` — mail classification, calendar polling, phone-notification ingest.
- `life.js` — money: bank-notification → `transactions`, accounts/holdings/health/people tools.
- `apply.js` — application packs (draft cover note + package, `applications` table) — kept as the mentor's "get things done for you" lever.

Tools carry their own `group`; `SYSTEM_TOOLS`, `APPLY_TOOLS` and `LIFE_TOOLS` are spread into `TOOLS`.

## Common commands

Worker (from `worker/`):
```bash
npx wrangler deploy                              # deploy the worker
npx wrangler dev                                 # local dev
npx wrangler tail                                # live logs
npx wrangler secret put <NAME>                   # set a secret (see wrangler.toml header for the full list)
npx wrangler d1 execute grabber --file=../schema.sql --remote     # apply schema
npx wrangler d1 execute grabber --remote --command "SELECT ..."   # ad-hoc query
```

Pipeline (from `pipeline/`, needs `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DB_ID` in env):
```bash
pip install -r requirements.txt
python -m grabber.main email                     # Gmail IMAP poll
python -m grabber.main research <job_id>         # run one research job
python scripts/seed_profile.py                   # seed private profile/ into D1
```

Apply the schema/migrations: `wrangler d1 execute grabber --remote --file=../schema.sql` (fresh DB) or `--file=../migrations/002_the_system.sql` (add `goals`/`quests` to an existing DB).

There is **no test suite and no linter configured** in this repo. Verify Worker changes with `wrangler dev` / `wrangler tail`, and the pipeline by running the relevant `python -m grabber.main` command against a dev D1. Several `/api/*` endpoints exist specifically for manual testing: `/api/cron` (trigger cron work with `&senses=1&system=1&force=1`, or `&issue=1`/`&debrief=1`), `/api/rank` (The System's level/XP/streak), `/api/tool?name=<tool>&args=<json>` (run one agent tool directly), and `/ai-debug` (check the AI binding) — all require `?t=<DASH_TOKEN>`.

## LLM providers

Worker: Workers AI only (`@cf/openai/gpt-oss-120b` for chat, `@cf/openai/whisper` for voice, `@cf/mistralai/mistral-small-3.1-24b-instruct` for image OCR). Pipeline (`pipeline/grabber/rank/llm.py`, `config.py`): Cloudflare Workers AI primary, with NVIDIA → Gemini → Groq fallbacks tried in order on error/rate-limit, gapped by `LLM_CALL_GAP_S` to stay under free-tier RPM. Model IDs and keys are all in `pipeline/grabber/config.py`.

## Conventions

- The owner is in **IST**; the Worker builds prompts with the owner's local date (`localNow()` in `agent.js`) and stores/schedules everything (reminders `due_at`, cron reasoning) in **UTC ISO**. Preserve this split — mixing them silently computes weekdays off the wrong day.
- Comments here explain *why*, often citing a specific failure that motivated the code (the gpt-oss reasoning-channel trap, DDG blocking CI IPs, D1's 100-bound-param limit forcing 20-row insert batches). Match that density and tone; don't strip the rationale.
- Every external source/tool fails soft and independently — a broken parser or backend must never kill a run. Keep new integrations in that mold (try/catch, fall through, record `last_error`).
- Never claim a write succeeded unless the tool call returned ok — this is an explicit rule in the agent's system prompt, and code should honor the same principle.
