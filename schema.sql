-- Grabber D1 schema. Apply with:
--   wrangler d1 execute grabber --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS postings (
  id          TEXT PRIMARY KEY,          -- sha1(source:external_id)[:12]
  source      TEXT NOT NULL,             -- devfolio | unstop | hn | rss:<feed> | tg:<channel>
  external_id TEXT NOT NULL,
  url         TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  org         TEXT,
  deadline    TEXT,                      -- ISO date if known
  posted_at   TEXT,
  ingested_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);

-- Measured rarity (point 3). Recomputed nightly over the whole corpus.
CREATE TABLE IF NOT EXISTS idf (
  term       TEXT PRIMARY KEY,
  df         INTEGER NOT NULL,
  idf        REAL NOT NULL,
  updated_at TEXT NOT NULL
);

-- Profile corpus lives here, never in the public repo (resume, past essays, skills yaml).
CREATE TABLE IF NOT EXISTS profile (
  key        TEXT PRIMARY KEY,           -- resume | essay:<name> | skills | bio
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every alert is a logged prediction (point 4).
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  posting_id TEXT NOT NULL REFERENCES postings(id),
  category   TEXT,                       -- hackathon | fellowship | grant | job | contract | other
  fit        INTEGER,                    -- LLM fit score 0-100
  p_convert  REAL,                       -- blended predicted P(win | applied)
  llm_prior  REAL,                       -- raw LLM prior before calibration blend
  reasons    TEXT,
  angle      TEXT,
  sent_at    TEXT,
  tg_message_id INTEGER,
  nag_level  INTEGER DEFAULT 0           -- 0 none, 1 =7d, 2 =3d, 3 =1d, 4 =day-of
);

-- Every button tap is a label (point 4).
CREATE TABLE IF NOT EXISTS outcomes (
  alert_id INTEGER NOT NULL REFERENCES alerts(id),
  action   TEXT NOT NULL,                -- applied | skipped | snoozed | won | rejected
  at       TEXT NOT NULL
);

-- Pre-drafted application material (point 1).
CREATE TABLE IF NOT EXISTS drafts (
  alert_id   INTEGER PRIMARY KEY REFERENCES alerts(id),
  content_md TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Measured hit rates per category, blended into p_convert once n is meaningful.
CREATE TABLE IF NOT EXISTS calibration (
  category   TEXT PRIMARY KEY,
  n_applied  INTEGER NOT NULL DEFAULT 0,
  n_won      INTEGER NOT NULL DEFAULT 0,
  n_rejected INTEGER NOT NULL DEFAULT 0,
  rate       REAL,                       -- won / (won + rejected), NULL until n >= 5
  updated_at TEXT NOT NULL
);

-- Phase 1 conversational agent: durable facts about the owner + rolling chat context.
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fact       TEXT NOT NULL,
  category   TEXT DEFAULT 'fact',      -- identity | preference | skill | goal | project | contact | fact
  created_at TEXT NOT NULL
);

-- Old chat beyond the active window is folded into a rolling summary
-- (profile key 'conversation_summary') instead of being deleted.
CREATE TABLE IF NOT EXISTS chat_history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL,               -- user | assistant
  content TEXT NOT NULL,
  at      TEXT NOT NULL
);

-- General-agent reminders ("remind me Thursday to follow up"), fired by the hourly cron.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  due_at     TEXT NOT NULL,            -- UTC ISO
  created_at TEXT NOT NULL,
  notified   INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_postings_ingested ON postings(ingested_at);
CREATE INDEX IF NOT EXISTS idx_alerts_posting ON alerts(posting_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_alert ON outcomes(alert_id);
