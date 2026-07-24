-- The tenant layer: The System goes from single-owner to federated multi-tenant.
-- Identity used to live entirely in env secrets (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID /
-- Google OAuth). It now lives in data: one `users` row per onboarded person, each with
-- their OWN BotFather bot token. One Worker multiplexes every bot, routing each bot's
-- webhook to /tg/<webhook_id>. See docs/09-multi-tenant.md and worker/src/tenant.js.
--
-- bot_token / google_refresh_token are stored ENCRYPTED (AES-GCM via env.MASTER_KEY) once
-- onboarding lands — a bot token is full account control, so a leaked D1 dump must not
-- hand over every user's bot.
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_token            TEXT,                                  -- BYO BotFather token (encrypted)
  bot_username         TEXT,                                  -- from getMe
  bot_id               INTEGER,                               -- numeric bot id from getMe
  webhook_id           TEXT UNIQUE,                           -- opaque path segment: /tg/<webhook_id>
  webhook_secret       TEXT,                                  -- per-bot X-Telegram-Bot-Api-Secret-Token
  owner_chat_id        TEXT,                                  -- captured on first /start
  timezone             TEXT NOT NULL DEFAULT 'Asia/Kolkata',  -- IANA; drives per-tenant cron gates
  dashboard_token      TEXT UNIQUE,                           -- gates this tenant's /api/*
  notify_secret        TEXT UNIQUE,                           -- gates this tenant's /ingest/notification
  google_refresh_token TEXT,                                  -- per-user Gmail+Calendar OAuth (encrypted)
  gmail_address        TEXT,
  gmail_app_password   TEXT,                                  -- only if the IMAP fallback is kept (encrypted)
  status               TEXT NOT NULL DEFAULT 'active',        -- active | paused | revoked
  created_at           TEXT NOT NULL
);

-- Seed the existing owner as tenant #1. The migration that adds `user_id` to every table
-- defaults it to 1, so all legacy rows belong to this tenant automatically. Token / chat_id
-- stay NULL here — worker/src/tenant.js `syntheticOwner` fills tenant #1 from env secrets
-- until onboarding writes them, so the owner keeps working with zero behavior change.
INSERT OR IGNORE INTO users (id, timezone, status, created_at)
  VALUES (1, 'Asia/Kolkata', 'active', datetime('now'));

-- Beta invite gating: a code is claimed by exactly one signup.
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  used_by    INTEGER,                                         -- users.id once claimed
  created_at TEXT NOT NULL
);
