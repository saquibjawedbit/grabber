-- Grabber D1 schema. Apply with:
--   wrangler d1 execute grabber --file=schema.sql --remote

-- The tenant layer (migration 011). The System is federated multi-tenant: one `users`
-- row per onboarded person, each with their OWN BotFather bot token; one Worker
-- multiplexes every bot via /tg/<webhook_id>. bot_token / google_refresh_token are
-- stored encrypted. See worker/src/tenant.js and docs/09-multi-tenant.md.
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_token            TEXT,                                  -- BYO BotFather token (encrypted)
  bot_username         TEXT,
  bot_id               INTEGER,
  webhook_id           TEXT UNIQUE,                           -- opaque path: /tg/<webhook_id>
  webhook_secret       TEXT,                                  -- per-bot webhook secret header
  owner_chat_id        TEXT,                                  -- captured on first /start
  timezone             TEXT NOT NULL DEFAULT 'Asia/Kolkata',  -- IANA; drives per-tenant cron gates
  dashboard_token      TEXT UNIQUE,                           -- gates this tenant's /api/*
  notify_secret        TEXT UNIQUE,                           -- gates this tenant's /ingest/notification
  google_refresh_token TEXT,                                  -- per-user Gmail+Calendar OAuth (encrypted)
  gmail_address        TEXT,
  gmail_app_password   TEXT,
  status               TEXT NOT NULL DEFAULT 'active',        -- active | paused | revoked
  created_at           TEXT NOT NULL,
  email                TEXT,                                  -- account login (migration 015)
  password_hash        TEXT,                                  -- pbkdf2$<iters>$<salt>$<hash>
  plan                 TEXT NOT NULL DEFAULT 'trial',         -- trial | pro (migration 016)
  trial_ends_at        TEXT,                                  -- 14-day free trial end (ISO)
  plan_expires_at      TEXT,                                  -- pro period end, renewed by Razorpay webhook
  rzp_sub_id           TEXT                                   -- Razorpay subscription id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- Legacy beta invite table (migration 011). Superseded by email/password signup (015);
-- kept inert so old rows/queries don't break.
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  used_by    INTEGER,
  created_at TEXT NOT NULL
);

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
  user_id    INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,              -- resume | essay:<name> | skills | bio | conversation_summary
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)             -- migration 013: was PK(key)
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
  context    TEXT,                     -- the exchange it was learned from, for provenance
  user_id    INTEGER NOT NULL DEFAULT 1 -- tenant (migration 012)
);

-- Old chat beyond the active window is folded into a rolling summary
-- (profile key 'conversation_summary') instead of being deleted.
CREATE TABLE IF NOT EXISTS chat_history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  role    TEXT NOT NULL,               -- user | assistant
  content TEXT NOT NULL,
  at      TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1   -- tenant (migration 012)
);

-- General-agent reminders ("remind me Thursday to follow up"), fired by the hourly cron.
CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  due_at     TEXT NOT NULL,            -- UTC ISO
  created_at TEXT NOT NULL,
  notified   INTEGER NOT NULL DEFAULT 0,
  done       INTEGER NOT NULL DEFAULT 0,
  user_id    INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
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
  user_id    INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,             -- "HDFC savings", "Zerodha"
  kind       TEXT NOT NULL,             -- bank | wallet | investment | card
  balance    REAL,
  currency   TEXT NOT NULL DEFAULT 'INR',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)           -- migration 013: was PK(name)
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
  updated_at  TEXT,
  user_id     INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
);

CREATE TABLE IF NOT EXISTS emails (
  id          TEXT PRIMARY KEY,        -- gmail message id
  thread_id   TEXT,
  sender      TEXT,
  subject     TEXT,
  snippet     TEXT,
  received_at TEXT,
  kind        TEXT,                    -- recruiter | opportunity | statement | other
  surfaced    INTEGER NOT NULL DEFAULT 0,
  user_id     INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
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
  reminded   INTEGER NOT NULL DEFAULT 0,
  user_id    INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
);

CREATE TABLE IF NOT EXISTS health (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,                 -- weight | waist | sleep | run_km | workout
  value  REAL,
  unit   TEXT,
  note   TEXT,
  at     TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1   -- tenant (migration 012)
);

-- Calorie tracking (migration 009). A meal keeps kcal + macros together in one row
-- (four parallel `health` series would drift apart); the dashboard buckets by IST day
-- and stacks the macro calories.
CREATE TABLE IF NOT EXISTS meals (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,               -- "2 eggs + 2 rotis + milk"
  kcal      REAL NOT NULL,
  protein_g REAL,                        -- macros optional: the agent estimates when
  carbs_g   REAL,                        -- the owner doesn't state them
  fat_g     REAL,
  note      TEXT,
  at        TEXT NOT NULL,               -- UTC ISO; the dashboard buckets by IST day
  user_id   INTEGER NOT NULL DEFAULT 1   -- tenant (migration 012)
);

CREATE INDEX IF NOT EXISTS idx_meals_at ON meals(at);

CREATE TABLE IF NOT EXISTS holdings (
  user_id    INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- asset | liability
  category   TEXT,                      -- investment | property | vehicle | loan | card_debt | other
  value      REAL NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)           -- migration 013: was PK(name)
);

CREATE TABLE IF NOT EXISTS interactions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id),
  what      TEXT NOT NULL,
  at        TEXT NOT NULL,
  user_id   INTEGER NOT NULL DEFAULT 1   -- tenant (migration 012)
);

CREATE TABLE IF NOT EXISTS merchant_category (
  user_id    INTEGER NOT NULL DEFAULT 1,
  pattern    TEXT NOT NULL,             -- lowercase counterparty fragment
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pattern)        -- migration 013: was PK(pattern)
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
  surfaced    INTEGER NOT NULL DEFAULT 0,
  user_id     INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
);

CREATE TABLE IF NOT EXISTS notify_allow (
  user_id    INTEGER NOT NULL DEFAULT 1,
  pattern    TEXT NOT NULL,            -- lowercase substring matched against app + title
  kind       TEXT NOT NULL,            -- what it usually is
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pattern)       -- migration 013: was PK(pattern)
);

CREATE TABLE IF NOT EXISTS people (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  name         TEXT NOT NULL,
  relation     TEXT,                    -- friend | family | recruiter | founder | mentor | colleague | dating
  how_met      TEXT,
  status       TEXT DEFAULT 'active',   -- active | cold | closed
  notes        TEXT,
  next_step    TEXT,
  last_contact TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(user_id, name)                 -- migration 013: was UNIQUE(name)
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
  error       TEXT,
  user_id     INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
);

CREATE TABLE IF NOT EXISTS state (
  user_id    INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)            -- migration 013: was PK(key)
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
  notification_id INTEGER,
  user_id    INTEGER NOT NULL DEFAULT 1  -- tenant (migration 012)
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
  progress   REAL NOT NULL DEFAULT 0,       -- cached 0..1, recomputed on quest/milestone change
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  user_id    INTEGER NOT NULL DEFAULT 1     -- tenant (migration 012)
);

-- The persistent roadmap: a goal decomposes into ordered milestones (the planner writes
-- these). Daily quests aim at the current 'active' milestone, so progress is real.
CREATE TABLE IF NOT EXISTS milestones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goals(id),
  seq         INTEGER NOT NULL,               -- order 1..N
  title       TEXT NOT NULL,
  done_when   TEXT,                           -- definition of done
  steps       TEXT,                           -- JSON array of concrete day-sized steps (quest material)
  target_date TEXT,                           -- ISO date, spaced across the runway
  status      TEXT NOT NULL DEFAULT 'pending',-- pending | active | done | skipped
  created_at  TEXT NOT NULL,
  done_at     TEXT,
  user_id     INTEGER NOT NULL DEFAULT 1      -- tenant (migration 012)
);

CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id);

-- Concrete, done-tonight tasks the System issues toward a goal/milestone. A quest is a
-- prediction+commitment; its resolution is the label (cf. the old alerts/outcomes).
CREATE TABLE IF NOT EXISTS quests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id       INTEGER REFERENCES goals(id),   -- nullable: standalone quests allowed
  milestone_id  INTEGER REFERENCES milestones(id), -- nullable: the milestone it advances
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'daily',  -- daily | milestone | urgent | side
  status        TEXT NOT NULL DEFAULT 'issued', -- issued | doing | done | failed | skipped
  xp            INTEGER NOT NULL DEFAULT 10,
  due_at        TEXT,                           -- UTC ISO; default end of the owner's today
  issued_at     TEXT NOT NULL,
  resolved_at   TEXT,
  tg_message_id INTEGER,
  user_id       INTEGER NOT NULL DEFAULT 1    -- tenant (migration 012)
);

CREATE INDEX IF NOT EXISTS idx_quests_issued ON quests(issued_at);
CREATE INDEX IF NOT EXISTS idx_quests_goal ON quests(goal_id);

-- The agent's work log: what The System did to move the owner's goals — quests issued
-- and resolved, reckonings, research spawned, applications drafted, and its own
-- autonomous moves. This is what the dashboard's "what I'm doing" feed reads.
CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL,   -- goal | plan | quest_issued | quest_done | quest_failed | reckoning | milestone_done | research | application | autonomous | note
  actor    TEXT NOT NULL DEFAULT 'system',  -- owner | system
  summary  TEXT NOT NULL,   -- one line, owner-facing
  detail   TEXT,            -- optional longer body
  reasoning TEXT,           -- for autonomous moves: why it did this
  goal_id  INTEGER,
  quest_id INTEGER,
  user_id  INTEGER NOT NULL DEFAULT 1        -- tenant (migration 012)
);

CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);

-- Arbitrary numeric metrics the agent logs to track over time (weight, MRR, leetcode
-- solved, minutes practiced, anything). Charted per-name on the dashboard.
CREATE TABLE IF NOT EXISTS metrics (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,       -- metric key, lowercased: weight | mrr | leetcode | ...
  value   REAL NOT NULL,
  unit    TEXT,
  note    TEXT,
  goal_id INTEGER,             -- optional link to a goal
  at      TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 1        -- tenant (migration 012)
);

CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(name, at);

-- Awards: one-time recognition for sustained effort — streaks, quest totals, hunter-rank
-- promotions, and the 30-day transformation (a plan followed for a month with visible,
-- measured change). `key` UNIQUE + INSERT OR IGNORE make every grant idempotent.
CREATE TABLE IF NOT EXISTS awards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,                    -- e.g. streak_30, rank_C, transform30_1
  title      TEXT NOT NULL,
  icon       TEXT,                             -- emoji badge
  detail     TEXT,                             -- what earned it, with the numbers
  goal_id    INTEGER REFERENCES goals(id),
  xp         INTEGER NOT NULL DEFAULT 25,      -- bonus XP granted with the award
  awarded_at TEXT NOT NULL,
  reward     TEXT,                             -- tangible real-world treat, from memories, scaled to the win
  reward_claimed_at TEXT,                      -- when the owner marked the treat redeemed (NULL = still owed)
  UNIQUE(user_id, key)                         -- migration 013: was UNIQUE(key)
);

-- The planner's questions back to the owner: facts it needs to plan better (waist size,
-- hours free, equipment...). Answering stores the fact and re-plans the goal immediately.
CREATE TABLE IF NOT EXISTS plan_questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id     INTEGER NOT NULL REFERENCES goals(id),
  question    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',   -- open | answered | dismissed
  answer      TEXT,
  announced   INTEGER NOT NULL DEFAULT 0,     -- sent to Telegram yet?
  asked_at    TEXT NOT NULL,
  answered_at TEXT,
  user_id     INTEGER NOT NULL DEFAULT 1      -- tenant (migration 012)
);

CREATE INDEX IF NOT EXISTS idx_plan_questions_goal ON plan_questions(goal_id, status);

-- XP / level / streak live as rows in `state`, now keyed (user_id, key):
--   xp, level, streak, streak_best, system_last_issue, system_last_debrief

-- Composite indexes on the hot per-tenant read paths (migration 012). (user_id, id) is
-- valid on every table below (id is a string PK on emails/events, int elsewhere).
CREATE INDEX IF NOT EXISTS idx_memories_user      ON memories(user_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_history_user  ON chat_history(user_id, id);
CREATE INDEX IF NOT EXISTS idx_reminders_user     ON reminders(user_id, id);
CREATE INDEX IF NOT EXISTS idx_goals_user         ON goals(user_id, id);
CREATE INDEX IF NOT EXISTS idx_milestones_user    ON milestones(user_id, goal_id);
CREATE INDEX IF NOT EXISTS idx_quests_user        ON quests(user_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_activity_user      ON activity(user_id, id);
CREATE INDEX IF NOT EXISTS idx_metrics_user       ON metrics(user_id, id);
CREATE INDEX IF NOT EXISTS idx_research_user      ON research(user_id, id);
CREATE INDEX IF NOT EXISTS idx_transactions_user  ON transactions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_emails_user        ON emails(user_id, id);
CREATE INDEX IF NOT EXISTS idx_events_user        ON events(user_id, id);
