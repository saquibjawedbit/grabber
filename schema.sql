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
  category   TEXT DEFAULT 'fact',      -- identity | preference | skill | goal | project | contact | health | money | fact
  created_at TEXT NOT NULL,
  updated_at TEXT,
  embedding  TEXT,                     -- base64 Float32, normalised — recall is a dot product
  source     TEXT DEFAULT 'chat',      -- chat (agent chose to) | auto (post-reply sweep) | backfill
  context    TEXT                      -- the exchange it was learned from, for provenance
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


-- ---------------------------------------------------------------------------
-- Everything below reached production as hand-run DDL across phases 3-6 and was
-- never written back here, so a database built from this file was missing 15 of
-- the 25 tables the worker queries. These definitions are dumped verbatim from
-- the live DB (2026-07-17). Keep this file in step with prod from now on:
--   wrangler d1 execute grabber --remote --command "SELECT sql FROM sqlite_master"
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
  name       TEXT PRIMARY KEY,          -- "HDFC savings", "Zerodha"
  kind       TEXT NOT NULL,             -- bank | wallet | investment | card
  balance    REAL,
  currency   TEXT NOT NULL DEFAULT 'INR',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  company     TEXT,
  url         TEXT,
  source      TEXT,                     -- manual | inbox | alert:<id> | watcher
  fit         INTEGER,                  -- honest 0-10: should he even apply?
  cover_note  TEXT,                     -- the main copy-paste artifact
  package_md  TEXT,                     -- full pack: bullets, Q&A, checklist
  status      TEXT NOT NULL DEFAULT 'ready',  -- ready|applied|responded|interview|offer|rejected|dropped
  created_at  TEXT NOT NULL,
  applied_at  TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS emails (
  id          TEXT PRIMARY KEY,        -- gmail message id
  thread_id   TEXT,
  sender      TEXT,
  subject     TEXT,
  snippet     TEXT,
  received_at TEXT,
  kind        TEXT,                    -- recruiter | opportunity | statement | other
  surfaced    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,         -- google calendar event id
  title      TEXT,
  starts_at  TEXT,
  ends_at    TEXT,
  location   TEXT,
  link       TEXT,
  attendees  TEXT,
  updated_at TEXT NOT NULL,
  reminded   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS health (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,                 -- weight | waist | sleep | run_km | workout
  value  REAL,
  unit   TEXT,
  note   TEXT,
  at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holdings (
  name       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,             -- asset | liability
  category   TEXT,                      -- investment | property | vehicle | loan | card_debt | other
  value      REAL NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interactions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id),
  what      TEXT NOT NULL,
  at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_category (
  pattern    TEXT PRIMARY KEY,          -- lowercase counterparty fragment
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT NOT NULL,
  title       TEXT,
  body        TEXT,
  kind        TEXT,                    -- bank | recruiter | calendar | delivery | other
  amount      REAL,                    -- parsed when it's money (Phase 5 builds on this)
  direction   TEXT,                    -- debit | credit
  counterparty TEXT,
  posted_at   TEXT,
  received_at TEXT NOT NULL,
  surfaced    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notify_allow (
  pattern    TEXT PRIMARY KEY,         -- lowercase substring matched against app + title
  kind       TEXT NOT NULL,            -- what it usually is
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  relation     TEXT,                    -- friend | family | recruiter | founder | mentor | colleague | dating
  how_met      TEXT,
  status       TEXT DEFAULT 'active',   -- active | cold | closed
  notes        TEXT,
  next_step    TEXT,
  last_contact TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  depth       TEXT NOT NULL DEFAULT 'normal',   -- quick | normal | deep
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  report_md   TEXT,
  sources     TEXT,                             -- json array of urls read
  steps       INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  amount     REAL NOT NULL,
  direction  TEXT NOT NULL,             -- debit | credit
  counterparty TEXT,
  category   TEXT,                      -- food | transport | rent | shopping | subscription | income | other
  account    TEXT,
  note       TEXT,
  at         TEXT NOT NULL,
  source     TEXT NOT NULL,             -- notification | manual | email
  notification_id INTEGER
);

CREATE TABLE IF NOT EXISTS watchers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,              -- x | rss | page | search
  target       TEXT NOT NULL,              -- handle, feed url, page url, or query
  note         TEXT,                       -- why the owner wants it watched
  created_at   TEXT NOT NULL,
  last_checked TEXT,
  last_error   TEXT,
  hits         INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  UNIQUE(kind, target)
);


-- ---------------------------------------------------------------------------
-- The System (Solo-Leveling-style motive engine). Replaces the passive job-board
-- opportunity engine: the agent drives the owner toward their own declared goals
-- via daily quests, accountability, penalties and leveling. See docs/05-the-system.md.
-- ---------------------------------------------------------------------------

-- The owner's real objectives. Everything the System does is judged against these.
CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  why        TEXT,                          -- why it matters (fuels the mentor's pushing)
  target     TEXT,                          -- measurable definition of success
  deadline   TEXT,                          -- ISO date if any
  status     TEXT NOT NULL DEFAULT 'active',-- active | achieved | dropped
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Concrete, done-tonight tasks the System issues toward a goal. A quest is a
-- prediction+commitment; its resolution is the label (cf. the old alerts/outcomes).
CREATE TABLE IF NOT EXISTS quests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER REFERENCES goals(id),   -- nullable: standalone quests allowed
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'daily',  -- daily | milestone | urgent
  status        TEXT NOT NULL DEFAULT 'issued', -- issued | doing | done | failed | skipped
  xp            INTEGER NOT NULL DEFAULT 10,
  due_at        TEXT,                           -- UTC ISO; default end of the owner's today
  issued_at     TEXT NOT NULL,
  resolved_at   TEXT,
  tg_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_quests_issued ON quests(issued_at);
CREATE INDEX IF NOT EXISTS idx_quests_goal ON quests(goal_id);

-- The agent's work log: what The System did to move the owner's goals — quests issued
-- and resolved, reckonings, research spawned, applications drafted. This is what the
-- dashboard's "what I'm doing to hit your goals" feed reads.
CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,    -- goal | quest_issued | quest_done | quest_failed | reckoning | research | application | note
  summary TEXT NOT NULL,    -- one line, owner-facing
  detail  TEXT,             -- optional longer body
  goal_id INTEGER,
  quest_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);

-- XP / level / streak live as rows in `state`:
--   xp, level, streak, streak_best, system_last_issue, system_last_debrief
