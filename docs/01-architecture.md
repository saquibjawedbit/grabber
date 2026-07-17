# 1. High-Level Design

## 1.1 The core idea: two runtimes, one database

grabber deliberately splits into **two execution environments that share a single D1
(SQLite) database**. The split is not arbitrary — it maps exactly onto the constraint
"what actually needs a real machine?"

```mermaid
flowchart TB
  subgraph edge["Cloudflare Worker — always on, I/O-bound"]
    direction TB
    fetch["fetch() handler"]
    sched["scheduled() handler — hourly cron"]
    fetch --- sched
  end

  subgraph ci["GitHub Actions — scheduled / event-driven, heavy"]
    direction TB
    nightly["nightly.yml<br/>IDF + calibration (CPU)"]
    research["research.yml<br/>Playwright browsing agent (minutes)"]
    email["email.yml<br/>Gmail IMAP poll (protocol Workers lack)"]
  end

  db[("D1 — one SQLite DB<br/>25 tables")]

  edge <-->|"env.DB binding"| db
  ci <-->|"REST API (pipeline/grabber/db.py)"| db
```

**Why the Worker holds almost everything.** Watchers, ranking, drafting, alerts, the
chat agent, memory, senses, money, initiative and the dashboard are all I/O-bound
(network + DB + LLM calls). A Cloudflare Worker is always on, has zero cold-start cost,
and gets the `AI` binding for free — so it is the natural home. See
`worker/src/index.js` and every module it imports.

**Why anything runs in GitHub Actions.** Only three jobs cannot live in a Worker
(`pipeline/grabber/main.py:1`):

| Job | Why it can't be a Worker |
|-----|--------------------------|
| **IDF recompute** | Tokenises the whole `postings` corpus and counts document frequency — more CPU than a Worker invocation gets. `pipeline/grabber/rank/idf.py` |
| **Deep research** | Browses for 5–15 minutes with a headless Chromium; a Worker has no browser and short wall-clock limits. `pipeline/grabber/research/runner.py` |
| **Gmail poll** | Speaks **IMAP**, which Workers cannot. `pipeline/grabber/gmail_imap.py` |

Everything else — including *classifying* the mail that IMAP fetched — happens in the
Worker.

## 1.2 The shared database as the integration bus

There is no direct RPC between the two runtimes. **D1 is the message bus.** Both sides
speak SQLite; they coordinate by reading and writing rows.

```mermaid
flowchart LR
  subgraph W["Worker"]
    w1["agent spawn_research tool<br/>INSERT research(status=queued)"]
    w2["classifyInbox<br/>reads emails WHERE surfaced=0"]
    w3["runWatchers<br/>reads idf, writes postings/alerts"]
  end
  subgraph A["Actions"]
    a1["research runner<br/>reads research by id, writes report_md"]
    a2["gmail_imap<br/>writes emails(kind=unclassified)"]
    a3["idf.recompute<br/>writes idf table"]
  end
  db[("D1")]
  w1 -->|"row id via GH dispatch"| a1
  a1 --> db
  w1 --> db
  a2 --> db --> w2
  a3 --> db --> w3
```

Two access paths to the same DB:

- **Worker** → the `DB` binding, e.g. `env.DB.prepare(sql).bind(...).all()`. Configured
  in `worker/wrangler.toml:20` (`binding = "DB"`, `database_name = "grabber"`).
- **Python** → D1's HTTP REST API, wrapped in `class D1` at `pipeline/grabber/db.py:9`.
  It POSTs `{sql, params}` to `.../d1/database/<id>/query`, retries `429`/`5xx` with
  exponential backoff, and raises on failure. Authenticated with the same
  `CF_ACCOUNT_ID` / `CF_API_TOKEN` used for the AI binding.

**A concrete cross-runtime handoff — `spawn_research`:** the agent inserts a `research`
row (`status='queued'`), then fires a GitHub `repository_dispatch` carrying only the
**row id** (`worker/src/agent.js:313`). The Actions runner reads the question from D1 by
that id, works, and writes `report_md` / `status='done'` back. The id is all that
travels through the (public) dispatch payload — see §1.6.

## 1.3 The Worker: two entry points

`worker/src/index.js` exports exactly two handlers (`worker/src/index.js:823`):

```mermaid
flowchart TB
  subgraph fetch["fetch(request, env, ctx)"]
    direction TB
    r1["/telegram — webhook (chat + button taps)"]
    r2["/api/* — dashboard JSON + admin endpoints"]
    r3["/ingest/notification — phone bridge"]
    r4["/ai-debug — AI binding smoke test"]
    r5["ASSETS — public/index.html dashboard"]
  end
  subgraph scheduled["scheduled(event, env) — cron '0 * * * *'"]
    direction TB
    s1["runReminders"]
    s2["runNags"]
    s3["loop: senses · money · watchers · briefing · weekly · overnight"]
    s1 --> s2 --> s3
  end
```

The routing logic (`worker/src/index.js:823-861`): `/ai-debug` and `/ingest/notification`
are checked first, then `/telegram`, then any `/api/` prefix, and everything else falls
through to static assets (the dashboard HTML, served with `Cache-Control: no-cache` so a
redeploy is never masked by a stale cached copy).

Full route and cron detail is in [08-api-and-ops.md](./08-api-and-ops.md).

## 1.4 Request flow: an owner sends a Telegram message

The webhook is designed to **acknowledge Telegram instantly and think in the
background** — Telegram retries a webhook that doesn't answer in seconds, which would
double-process the message.

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner
  participant TG as Telegram
  participant W as Worker /telegram
  participant AI as Workers AI
  participant DB as D1

  O->>TG: message (text / voice / photo / file / button tap)
  TG->>W: POST /telegram (X-Telegram-Bot-Api-Secret-Token)
  W->>W: verify secret == TG_WEBHOOK_SECRET (else 403)
  alt command "/..."
    W->>DB: run the command query (stats/pending/applied/…)
    W-->>TG: sendMessage(reply)
  else button tap (callback_query)
    W->>DB: INSERT outcomes(alert_id, action)
    W-->>TG: edit buttons + answerCallbackQuery
  else voice / video
    W-->>TG: "🎧 listening…" placeholder
    W->>AI: @cf/openai/whisper (transcribe)
    Note over W: ctx.waitUntil — background
    W->>W: converse(transcript)
  else photo / image doc
    W-->>TG: "🖼 looking…" placeholder
    W->>AI: mistral-small (OCR + describe)
    W->>W: converse(image contents)
  else text
    W-->>TG: "🤔 …" placeholder (fast ack)
    W->>W: ctx.waitUntil(converse(text))
  end
  W->>AI: runAgent — JSON tool loop (see doc 03)
  AI-->>W: {reply}
  W-->>TG: editMessageText(placeholder → reply)
  W->>W: rememberExchange → memory sweep (see doc 04)
```

Key implementation facts:

- **Ownership gate:** every non-`/start` interaction checks `isOwner(chatId, env)` —
  `String(chatId) === String(env.TELEGRAM_CHAT_ID)` (`worker/src/index.js:159`). A
  stranger gets *"I'm a personal agent working for one person, and it isn't you. 🙂"*.
- **Placeholder pattern:** the Worker sends a fast placeholder ("🤔 …"), does the slow
  work under `ctx.waitUntil(...)`, then edits the placeholder into the real reply
  (`worker/src/index.js:398`, `converse` at `:295`).
- **Multimodality** is all Workers AI: Whisper for audio (`transcribe`, `:197`), Mistral
  for image OCR (`describeImage`, `:218` — chosen because llava's OCR is too weak and
  llama-3.2-vision is license-gated), and any text file becomes profile corpus
  (`ingestDocument`, `:324`).
- **HTML-safety fallback:** if `sendMessage`/`editMessageText` fails (usually the model
  emitted HTML-unsafe text), the Worker resends with `parse_mode` stripped
  (`worker/src/index.js:308`).

## 1.5 The hourly cron: how the agent acts unprompted

One cron trigger, `"0 * * * *"` (`worker/wrangler.toml:27`), drives all initiative.
Order matters and is deliberate (`worker/src/index.js:862`):

```mermaid
flowchart TB
  cron["scheduled() — top of every hour"]
  cron --> rem["runReminders — due reminders fire"]
  rem --> nag["runNags — deadline escalation 7d/3d/1d"]
  nag --> loop{"for each, isolated in try/catch"}
  loop --> senses["runSenses — classify mail, poll calendar"]
  loop --> money["processBankNotifications — bank alerts → transactions"]
  loop --> watch["runWatchers — check channels, rank, alert"]
  loop --> brief["runBriefing — 08 IST, only if worth it"]
  loop --> weekly["runWeekly — Sun 19 IST"]
  loop --> over["runOvernightResearch — 03 IST, picks its own question"]
```

- **Failure isolation:** reminders and nags run first (they are cheap and must never be
  starved), then the six initiative jobs run inside a `for` loop where **each is wrapped
  so one failing never stops the others** (`worker/src/index.js:866-881`). Briefing runs
  after senses/money/watchers because it *reports on* them.
- **Self-gating by clock:** the cron fires hourly, but `runBriefing`/`runWeekly`/
  `runOvernightResearch` each check the IST hour themselves and no-op unless it's their
  time (`worker/src/briefing.js:160`, `:222`, `:292`). This is why there is only one
  cron expression for many differently-timed jobs.
- **Idempotency:** nags gate each escalation level with `alerts.nag_level`
  (`worker/src/index.js:466`); briefings gate on a `state` row (`briefing_last = today`)
  so re-firing the same hour does nothing.

## 1.6 Security and privacy boundaries

The repo is **public**, which drives several hard rules.

```mermaid
flowchart TB
  subgraph secrets["Distinct secrets — a leak of one can't reach another's surface"]
    s1["TG_WEBHOOK_SECRET → /telegram"]
    s2["DASH_TOKEN → /api/* + dashboard"]
    s3["NOTIFY_SECRET → /ingest/notification"]
    s4["GH_TOKEN → research dispatch (Contents:rw only)"]
  end
  subgraph public["PUBLIC repo → public Actions logs"]
    p1["research runner prints only progress + fetched URLs"]
    p2["never echoes profile / memories / report body"]
    p3["only the job ID travels in the dispatch payload"]
  end
  subgraph wonly["Worker-only tables — never touched by Actions"]
    w1["accounts, holdings, transactions"]
    w2["people, interactions, health"]
  end
```

- **Separate secrets per surface** (`worker/wrangler.toml:29-40`): the phone bridge has
  its own `NOTIFY_SECRET` so a leaked `DASH_TOKEN` can't inject into the agent's senses
  (`worker/src/index.js:835`). The Telegram webhook validates
  `X-Telegram-Bot-Api-Secret-Token` (`:356`).
- **Public-log discipline:** `research.yml` and `runner.py` are explicitly forbidden from
  printing owner content; only the job id crosses the dispatch boundary
  (`.github/workflows/research.yml:6-11`, `pipeline/grabber/research/runner.py:1-7`).
- **`profile/` never enters git** — it's gitignored and lives only in D1, seeded by
  `pipeline/scripts/seed_profile.py` (`.gitignore`, top of the file).
- **The money/body/people domain is Worker-only.** `worker/src/life.js:1-7` states the
  boundary: no Actions job may read or write those tables while the repo is public,
  because that's where the owner's bank balance lives.
- **Untrusted web text:** the research agent treats every fetched page as untrusted data
  and is told to disobey embedded instructions (`runner.py:41-44`, `:192`).

## 1.7 Cost model — why it's $0

```mermaid
flowchart LR
  A["Cloudflare Workers + D1 + Workers AI<br/>free tier: 10k neurons/day"] --> Z["$0"]
  B["GitHub Actions<br/>free unlimited on public repos"] --> Z
  C["Telegram Bot API<br/>free"] --> Z
  D["Gemini / Groq / NVIDIA<br/>free-tier fallbacks"] --> Z
```

The primary LLM is Workers AI `@cf/openai/gpt-oss-120b` (~10k free neurons/day). Free-tier
rate is the real budget, which is why the whole opportunity engine is built around
*spending model calls sparingly*: a cheap non-LLM recall stage cuts candidates before any
LLM read, and there is a hard 2-alerts/day cap (see [05-opportunity-engine.md](./05-opportunity-engine.md)).

## 1.8 Deployment

```mermaid
flowchart TB
  subgraph once["One-time"]
    a["wrangler d1 create grabber → put id in wrangler.toml"]
    b["wrangler d1 execute grabber --file=schema.sql --remote"]
    c["wrangler secret put … (see wrangler.toml header)"]
    d["seed_profile.py → profile corpus into D1"]
    e["GitHub secrets/vars: CF_*, D1_DB_ID, TELEGRAM_*, GEMINI_*, DASH_URL, …"]
  end
  subgraph deploy["Each change"]
    f["cd worker && wrangler deploy"]
    g["schema change → update schema.sql + add migrations/*.sql"]
  end
  once --> deploy
```

There is **no test suite and no linter**. Verify the Worker with `wrangler dev` /
`wrangler tail`; verify the pipeline by running `python -m grabber.main <cmd>` against a
dev D1. The Worker also exposes manual-trigger endpoints (`/api/cron`, `/api/tool`,
`/ai-debug`) for testing without waiting for the real cron — see
[08-api-and-ops.md](./08-api-and-ops.md).
