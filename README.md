# grabber

An agent that measures itself in **applications submitted**, not opportunities found.
It scrapes obscure channels, measures rarity instead of asserting it, has an LLM read
the survivors, arrives with the essay already drafted — and logs every prediction and
outcome so after a month it *knows* your hit rates instead of guessing.

**Total infrastructure cost: $0.** GitHub Actions (pipeline) + Cloudflare Workers/D1
(webhook, nags, dashboard) + Telegram (alerts + one-tap labels) + Gemini free tier (ranking, drafting).

```
GitHub Actions (every 4h)                    Cloudflare Worker (always on)
┌──────────────────────────────┐             ┌─────────────────────────────┐
│ ingest: devfolio unstop hn   │             │ /telegram  taps -> outcomes │
│         rss tg-relays        │──> D1 <────│ /api + dashboard            │
│ recall (IDF edge, top-50)    │  (SQLite)   │ cron: escalating deadline   │
│ rank   (Gemini reads them)   │             │       nags                  │
│ prep   (essay + resume cut)  │             └─────────────────────────────┘
│ notify (Telegram, max 2/day) │                          ▲
└──────────────────────────────┘                    your taps:
   nightly: IDF + calibration              Applied / Skip / Won / Rejected
```

## Setup (~30 min, once)

### 1. Cloudflare (D1 + Worker)
```bash
npm i -g wrangler && wrangler login
wrangler d1 create grabber                  # note database_id
# put database_id into worker/wrangler.toml
wrangler d1 execute grabber --file=schema.sql --remote
cd worker
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put TG_WEBHOOK_SECRET       # any random string
wrangler secret put DASH_TOKEN              # any random string
wrangler deploy                             # note the workers.dev URL
```

### 2. Telegram bot
1. Message **@BotFather** → `/newbot` → copy the token.
2. Point the webhook at the worker and register the command menu:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/telegram&secret_token=<TG_WEBHOOK_SECRET>"
   curl "https://api.telegram.org/bot<TOKEN>/setMyCommands" -H 'Content-Type: application/json' -d '{"commands":[
     {"command":"stats","description":"applications, win rates, corpus size"},
     {"command":"pending","description":"alerted but not applied, by deadline"},
     {"command":"applied","description":"application tracker with status"},
     {"command":"help","description":"list commands"}]}'
   ```
3. Message your bot `/start` — it replies with your `TELEGRAM_CHAT_ID`.

The bot is a two-way tracker, not just a firehose:
| Command | What you get |
|---|---|
| `/stats` | total/30-day application count, wins, rejections, awaiting-result, win rate overall and per category |
| `/pending` | everything you were alerted about but haven't applied to or skipped, sorted by days-to-deadline |
| `/applied` | your application log — each with 🏆 won / ❌ rejected / ⏳ waiting |
| Alert buttons | ✅ Applied / 🙅 Skip / 💤 Snooze, then 🏆 Won / ❌ Rejected — each tap is a tracked label |

### 3. LLM key
Free key from [aistudio.google.com](https://aistudio.google.com) → `GEMINI_API_KEY`.
(Optional fallback: free `GROQ_API_KEY` from console.groq.com.)

### 4. Profile corpus (private — see `profile/README.md`)
Drop `resume.md`, `bio.md`, `skills.yaml`, and every past essay into `profile/`, then:
```bash
export CF_ACCOUNT_ID=... CF_API_TOKEN=... D1_DB_ID=...
pip install -r pipeline/requirements.txt
python pipeline/scripts/seed_profile.py
```
The repo is public; `profile/` is gitignored and lives only in D1.

### 5. GitHub secrets
Repo → Settings → Secrets and variables → Actions.
**Secrets:** `CF_ACCOUNT_ID`, `CF_API_TOKEN` (D1 edit permission), `D1_DB_ID`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`,
optional `GROQ_API_KEY`, `TELETHON_API_ID`, `TELETHON_API_HASH`, `TELETHON_SESSION`.
**Variables:** `DASH_URL` (worker URL), optional `TG_RELAY_CHANNELS` (e.g. `@devfolio_updates,@oppfinder`).

### 6. First run
Actions tab → *grabber pipeline* → Run workflow (`ingest` first to build the corpus,
then `nightly` for IDF, then `run`).

### Optional: Telegram relay channels (poor-man's Twitter firehose)
API creds from [my.telegram.org](https://my.telegram.org), then
`python pipeline/scripts/make_session.py` → `TELETHON_SESSION` secret.

## Design decisions (why it's built this way)

1. **Applying is the bottleneck** — every alert ships with an essay draft in your voice
   (from your past essays), a resume re-cut, and a form checklist (`prep/drafts.py`).
2. **Popularity is a penalty** — source obscurity weights in `config.SOURCE_WEIGHTS`
   and per-feed weights in `feeds.yaml`; relay channels outrank job boards.
3. **Rarity is measured, not asserted** — nightly IDF over the whole ingested corpus
   (`rank/idf.py`); edge = Σ proficiency × idf(term). No hardcoded RARE dict to go stale.
4. **Guess for a month, then know** — every alert stores predicted P(win); every tap
   stores an outcome; `rank/calibrate.py` blends measured category hit rates into
   future predictions as labels accumulate.
5. **Two-stage ranking** — cheap IDF recall cuts thousands to `RECALL_TOP_K=50`,
   then the LLM actually reads the survivors (`rank/rank2.py`).
6. **Most losses are inaction** — the worker cron sends escalating nags at 7/3/1 days
   before every deadline you haven't acted on.
7. **Silence is the product** — hard `MAX_ALERTS_PER_DAY=2` budget plus `MIN_FIT_TO_ALERT=70`.
   An alert that fires daily is an alert you mute.

## Honest limitations
- Devfolio/Unstop endpoints are unofficial — expect to touch their parsers occasionally
  (each source fails independently; a broken one never kills a run).
- No free Twitter firehose exists; relay channels + RSS are the zero-cost approximation.
  The source interface is pluggable if you ever pay for one.
- Form auto-fill is a browser-extension problem — v2. Today the agent gets you to
  "everything drafted, form checklist in hand," which is most of the three hours.
- GitHub Actions cron drifts 5–15 min and pauses on 60 days of repo inactivity
  (any commit resets it). The worker (nags, taps, dashboard) has real uptime.
