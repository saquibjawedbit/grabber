# grabber — The System

A **zero-cost personal agent** on Telegram: a strict mentor (in the *Solo Leveling* sense)
whose one motive is to drive you to your declared **goals** — issuing daily **quests**,
holding a nightly **reckoning**, penalising failure and **leveling you up** — while doubling
as a general life agent (money, calendar, mail, people, memory, deep research).

It runs entirely on **free tiers** — Cloudflare Workers/D1/Workers AI, GitHub Actions,
Telegram — and is now **federated multi-tenant**: anyone can bring their own bot and get
their own isolated System.

> Live: **https://grabber.saquibjawed.workers.dev** · Architecture reference: **[`docs/`](./docs/)**
> (start with [`docs/05-the-system.md`](./docs/05-the-system.md) and
> [`docs/09-multi-tenant.md`](./docs/09-multi-tenant.md)).

---

## How it works

Declare a goal — what you want to become, the target, the deadline. The System plans a
roadmap of measurable milestones, then every morning issues **quests** (done-tonight tasks)
toward the current milestone. You tap ✅ / ⏳ / ❌. Every night is a **reckoning**: unfinished
quests fail, failure costs XP and your streak, and the plan re-tunes. Clear quests to gain
XP, rank up **E → S**, and unlock real-world rewards you set for yourself.

Alongside the mentor it quietly runs your life: logs spending from bank notifications,
tracks calories/health/metrics, watches your calendar and mail, remembers durable facts
about you, and can dispatch a browsing agent to dig for ~10 minutes and write a cited report.

## Two runtimes, one database

I/O-bound always-on work lives in a Cloudflare Worker; CPU-heavy work lives in GitHub
Actions. Both share one D1 (SQLite) database.

```
GitHub Actions (Python)                     Cloudflare Worker (always on)
┌──────────────────────────────┐            ┌──────────────────────────────┐
│ research.yml  Playwright dig  │            │ /tg/<id>  per-bot webhooks   │
│   (dispatched, ~10 min)       │──> D1 <───│ /telegram owner (tenant #1)  │
│ email.yml     Gmail IMAP poll │  (SQLite)  │ /signup + /api/register      │
└──────────────────────────────┘            │ /api + dashboard             │
        ▲                                    │ hourly cron: reminders,      │
   borrows the Worker's IP for               │   senses, money, The System  │
   web search (CI IPs get blocked)           └──────────────────────────────┘
```

Every per-owner D1 table carries a `user_id`; a scoped-`env` seam
([`worker/src/tenant.js`](worker/src/tenant.js)) + a fail-loud DB guard keep tenants
isolated. See [`docs/09-multi-tenant.md`](docs/09-multi-tenant.md).

## Get your own System (onboarding)

1. In Telegram, open **@BotFather** → `/newbot` → copy your bot token.
2. Go to **`/signup`**: paste the token, then set an **email + password**. It validates the
   bot, provisions your tenant (token encrypted at rest, password PBKDF2-hashed), and points
   the bot's webhook here. Log back in anytime at **`/login`**.
3. Open your bot and send **`/start`** — it binds to your chat and hands you your first quest.
   You're running your own isolated System, with a private dashboard link.

Target: link → first quest in under 4 minutes. A 90-second walkthrough plays on the landing
and signup pages (drop a recording at `worker/public/onboarding.mp4`).

| Command | What you get |
|---|---|
| `/goals` | your goals and progress |
| `/quests` | today's quests (tap ✅ / ⏳ / ❌) |
| `/rank` | your level, XP and streak |
| `/research` | recent deep dives |
| `/memories` | what it knows about you |
| `/help` | command list |

Send text, a voice note, a video, a screenshot, or a text file — it reads them all.

## Deploy your own (owner setup)

You (the deployer) are **tenant #1**, running off env secrets; everyone else self-registers.

### 1. Cloudflare (D1 + Vectorize + Worker)
```bash
npm i -g wrangler && wrangler login
wrangler d1 create grabber                 # put database_id into worker/wrangler.toml
wrangler vectorize create grabber-memories --dimensions=384 --metric=cosine
wrangler d1 execute grabber --file=schema.sql --remote          # full schema (multi-tenant)
cd worker && wrangler deploy
```

### 2. Secrets (`wrangler secret put <NAME>`)
| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | the owner's bot + chat (tenant #1) |
| `TG_WEBHOOK_SECRET` | owner webhook secret (random string) |
| `DASH_TOKEN` | gates `/api/*` and the dashboard (random string) |
| `NOTIFY_SECRET` | the owner's phone-notification bridge |
| `MASTER_KEY` | AES-GCM key encrypting every tenant's bot/OAuth secrets at rest — `python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"` |
| `GH_TOKEN` | PAT so `spawn_research` can dispatch the research workflow |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | read-only Gmail + Calendar (owner) — run `pipeline/scripts/google_auth.py` |
| `SERPER_API_KEY`, `GOOGLE_CSE_KEY` | optional web-search providers (fail soft to DuckDuckGo → Wikipedia) |

Point the owner bot's webhook at the legacy path:
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<TG_WEBHOOK_SECRET>"
```

### 3. Accounts & signup
Signup is **open** — email + password + a BYO bot token at `/signup`; `/login` returns the
tenant's dashboard. No invite gate. See who's signed up:
```bash
wrangler d1 execute grabber --remote --command \
 "SELECT id, email, bot_username, created_at FROM users WHERE id > 1 ORDER BY id;"
```
⚠️ Open signup means every tenant's chat turns run on your shared Workers AI free-tier
neuron budget. Add rate-limiting / email verification / a per-tenant daily cap before wide
promotion (tracked in `docs/09-multi-tenant.md`).

**Paywall:** each tenant gets a **14-day free trial**, then a soft lock (dashboard read-only,
quests paused, bot nags) until they upgrade to **₹149/month**. Wire real charging by setting
the Razorpay secrets (`RZP_KEY_ID`, `RZP_KEY_SECRET`, `RZP_PLAN_ID`, `RZP_WEBHOOK_SECRET` — see
`wrangler.toml`) and pointing a Razorpay webhook at `<WORKER_URL>/api/razorpay/webhook`.
Without them the trial + lock still work; `/upgrade` just reports charging isn't switched on.

### 4. LLM providers
**None needed by default** — the Worker uses Cloudflare Workers AI
(`@cf/openai/gpt-oss-120b`, ~10k free neurons/day, plus Whisper for voice and Mistral for
image OCR). The pipeline adds NVIDIA → Gemini → Groq fallbacks (`NVIDIA_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY`) tried in order on error/rate-limit.

### 5. Profile corpus (private)
Drop `resume.md`, `bio.md`, `skills.yaml`, and past essays into `profile/` (gitignored;
lives only in D1), then seed it:
```bash
export CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DB_ID=...
pip install -r pipeline/requirements.txt
python pipeline/scripts/seed_profile.py
```

### 6. GitHub Actions pipeline (research + mail)
Repo → Settings → Secrets and variables → Actions.
**Secrets:** `CF_ACCOUNT_ID`, `CF_API_TOKEN` (D1 edit), `D1_DB_ID`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, LLM fallback keys, `GMAIL_APP_PASSWORD`, `DASH_TOKEN`.
**Variables:** `GMAIL_ADDRESS`, `DASH_URL` (worker URL), `GOOGLE_CSE_ID`.
`email.yml` polls Gmail every 20 min; `research.yml` runs a browsing agent on dispatch.

## Design principles

1. **A strict mentor with one motive** — everything is judged against your declared goals;
   the tone pushes, penalises inaction, and rewards follow-through. Not a cheerleader.
2. **Zero infrastructure cost** — free tiers only. If it can't run at $0, it isn't built.
3. **Everything fails soft, independently** — a broken parser, a down index, or a dead
   provider degrades to a fallback; it never kills a run.
4. **D1 is the single source of truth** — facts *and* vectors. The Vectorize index is
   disposable and rebuildable (`/api/vector-backfill`).
5. **Never claim a write that didn't happen** — tools report the real result.
6. **Tenant isolation is enforced, not trusted** — every per-owner query carries `user_id`;
   a missed scope trips a fail-loud DB guard rather than leaking across tenants.
7. **Silence over noise** — quiet hours, budgets, and one nightly reckoning instead of a
   firehose.

## Docs
`docs/01-architecture` · `02-data-model` · `03-agent` · `04-memory` · `05-the-system` ·
`06-research-agent` · `07-senses-life-initiative` · `08-api-and-ops` · **`09-multi-tenant`**.
`CLAUDE.md` covers how to work in the code.

## Honest limitations
- **`spawn_research` is owner-only** until the Python runner is made tenant-aware — it
  currently reads the owner's profile and replies via the owner's bot.
- **Per-tenant timezones**: quest/reckoning hours fire on the owner's IST clock for all
  tenants (each `users` row stores a `timezone`; localizing the gates is pending).
- **Per-user Gmail/Calendar** uses one Google account (the owner's); per-tenant OAuth is
  pending.
- **Free-tier ceilings**: the hourly cron runs all tenants in one invocation — past a
  handful of active users, fan out to per-tenant sub-invocations.
- The old job-board "opportunity engine" (watchers, IDF, board alerts, calibration, the
  nightly pipeline) was **removed** in favour of The System; its tables are inert.
