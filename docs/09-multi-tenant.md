# 09 — Multi-tenant (federated bots)

The System started single-owner: identity lived in env secrets (`TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, one Google account). It is now **federated multi-tenant** — one Worker
and one D1 serve many people, each running an isolated System behind **their own BotFather
bot**. The original owner keeps working unchanged as **tenant #1**.

Telegram has no API to create bots, so "your own bot" means **bring-your-own token**: a user
makes a bot in @BotFather and registers its token; the one Worker multiplexes every bot by
routing each bot's webhook to a unique path.

## The one seam: a scoped `env` (`worker/src/tenant.js`)

Every function already reaches the world through `env` (`env.DB`, `env.TELEGRAM_BOT_TOKEN`,
`env.VECTORIZE`, …). So instead of threading a tenant through hundreds of signatures, each
entry point wraps `env` **once**:

- `scopeEnv(env, tenantRow)` → a `Proxy` where `env.DB` becomes a **tenant-guarded DB** and
  `env._tenant` is the tenant's `users` row. Unknown keys pass through, so every existing
  binding/secret read still works.
- Accessors: `uid(env)`, `tz(env)`, `ownerChat(env)`, `botToken(env)`, `webhookSecret(env)`.
- `syntheticOwner(env)` fabricates tenant #1 from the legacy env secrets, so the owner's bot,
  chat, dashboard token and Google account keep working with no `users` data.

### The DB guard (fail-loud)

`guardedDb` wraps `prepare(sql)`: if `sql` touches a **scoped** table (the 26 per-owner
tables) without mentioning `user_id`, it logs (`warn`) or throws (`strict`) — turning a
forgotten scope from a silent cross-tenant leak into a loud failure. Mode is
`env.TENANT_GUARD` = `off | warn | strict` (`wrangler.toml [vars]`). The retrofit added
`user_id` to all **244** scoped query sites; the guard + a grep lint catch regressions.
Inert opportunity-engine tables (`postings/idf/alerts/outcomes/drafts/calibration/watchers`)
are intentionally left global.

## Data model

`migration 011` adds `users` (the tenant table) + `invites`. `012` adds
`user_id INTEGER NOT NULL DEFAULT 1` to 18 tables (backfilling every legacy row to the
owner). `013` rebuilds the 8 tables whose natural key collided across tenants into composite
keys: `profile/state (user_id,key)`, `accounts/holdings (user_id,name)`,
`merchant_category/notify_allow (user_id,pattern)`, and `people/awards UNIQUE(user_id,…)`.
`emails`/`events` keep their global string PK (gmail/gcal ids don't collide) and just carry a
`user_id` column. `schema.sql` mirrors the final shape.

Key `users` columns: `bot_token`, `bot_username`, `bot_id`, `webhook_id` (the `/tg/<id>`
path), `webhook_secret`, `owner_chat_id`, `timezone`, `dashboard_token`, `notify_secret`,
`google_refresh_token`, `status`. `bot_token`/`webhook_secret`/`google_refresh_token` are
**encrypted at rest** (AES-GCM via `env.MASTER_KEY`; `encryptSecret`/`decryptSecret`), stored
as `enc:<base64(iv||ct)>`.

## Request routing (`worker/src/index.js` `fetch`)

Each entry point resolves its own tenant via `resolveTenant(env, by)` and 401/403s on a miss.
The legacy env secrets always map to tenant #1, so nothing about the owner breaks.

| Route | Resolves tenant by | Owner fallback |
|---|---|---|
| `POST /tg/<webhook_id>` | `webhook_id` → row; `handleTelegram` verifies the header vs `webhookSecret(env)` | — |
| `POST /telegram` | (alias) | tenant #1 |
| `GET/POST /api/*` | `?t=` → `dashboard_token` | `env.DASH_TOKEN` → tenant #1 |
| `POST /ingest/notification` | `X-Intelly-Secret` → `notify_secret` | `env.NOTIFY_SECRET` → tenant #1 |
| `scheduled()` cron | loops `SELECT id FROM users WHERE status='active'`, scopes each | — |

Outbound is automatic: `tg()`/`TG()`/`download()` read `botToken(env)`; proactive sends use
`ownerChat(env)`. Memory recall is partitioned by Vectorize **namespace = `String(uid)`**
(`memory.js`), with the D1 fallback scans also `user_id`-scoped so isolation holds even when
the index is down.

## Onboarding (`/signup` + `POST /api/register`)

1. User runs `/newbot` in @BotFather → gets a token.
2. Pastes token + invite code on **`/signup`** (`worker/public/signup.html`).
3. `handleRegister` (invite-gated): `getMe` validates the token and captures `{id, username}`
   → generates `webhook_id`/`webhook_secret`/`dashboard_token`/`notify_secret` → `INSERT users`
   (secrets encrypted) → `setWebhook` at `https://<host>/tg/<webhook_id>` with the per-bot
   `secret_token` → consumes the invite → returns the dashboard link + notify secret. Rolls
   back the row if `setWebhook` fails.
4. User opens their bot and sends `/start`; `handleCommand` binds `owner_chat_id` to that chat.

Seed an invite: `INSERT INTO invites (code, created_at) VALUES ('<code>', datetime('now'));`

## Verified

- Tenant-1 read equivalence: `/api/brain` (55KB) and `/api/system` (61KB) byte-identical
  before/after the retrofit; 0 `UNSCOPED` runtime warnings through cron + tools.
- Isolation: tenant-2 rows inserted directly into D1 never appear in tenant-1 endpoints.
- Encryption round-trips; onboarding validation (bad token/invite, getMe reject) returns
  correct 4xx without consuming the invite.

## Known follow-ups (not yet done)

- **Per-tenant timezone gating** — the cron issue/debrief/autonomy hours still fire on the IST
  clock for every tenant (`system.js` `ist()` + the `+330 minutes` SQL day-boundaries). Each
  `users` row already carries `timezone`; making the gates + day-boundary SQL tz-aware is the
  remaining work.
- **Phase 7 — per-user integrations.** Google OAuth is still one account (tenant #1). The
  research runner (`pipeline/grabber/research/runner.py`) reads `profile`/`memories` **without
  `user_id`** and replies via the global bot — so a non-owner tenant spawning research would
  read the owner's profile and DM the owner. Until the runner is made tenant-aware (read
  `user_id` with the job, scope its queries, reply via that tenant's bot), treat `spawn_research`
  as owner-only.
- **Guard to `strict`** in production once broader path coverage is confirmed (currently `warn`).
- **Free-tier ceiling**: the cron loop runs all tenants in one invocation; past ~5 active
  tenants, fan out to per-tenant sub-invocations (self-fetch) to stay under the subrequest/CPU cap.
- Opportunity-engine tables and real dashboard sessions (beyond bearer-token-in-URL) remain global.
