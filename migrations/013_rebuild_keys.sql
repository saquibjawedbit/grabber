-- Rebuild the tables whose PRIMARY KEY / UNIQUE is a NATURAL key that collides across
-- tenants (SQLite can't ALTER a key, so each is copy-drop-rename). Every legacy row is
-- assigned to tenant #1. Two tenants can now both own an account "HDFC", a person
-- "Ankit", or earn award "streak_30". people/awards keep their autoincrement `id` (and
-- its exact values) so interactions.person_id / awards.goal_id references stay valid.
--
-- No PRAGMA foreign_keys toggle: D1 runs a --file in one implicit transaction where that
-- pragma is a no-op, keeps FK enforcement off by default, and the only referencing table
-- (interactions -> people) is empty — so the DROP/rename can't be blocked.

-- profile: PK (key) -> (user_id, key)
CREATE TABLE profile_new (
  user_id    INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO profile_new (user_id, key, content, updated_at)
  SELECT 1, key, content, updated_at FROM profile;
DROP TABLE profile;
ALTER TABLE profile_new RENAME TO profile;

-- state: PK (key) -> (user_id, key)
CREATE TABLE state_new (
  user_id    INTEGER NOT NULL DEFAULT 1,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO state_new (user_id, key, value, updated_at)
  SELECT 1, key, value, updated_at FROM state;
DROP TABLE state;
ALTER TABLE state_new RENAME TO state;

-- accounts: PK (name) -> (user_id, name)
CREATE TABLE accounts_new (
  user_id    INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  balance    REAL,
  currency   TEXT NOT NULL DEFAULT 'INR',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);
INSERT INTO accounts_new (user_id, name, kind, balance, currency, updated_at)
  SELECT 1, name, kind, balance, currency, updated_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- holdings: PK (name) -> (user_id, name)
CREATE TABLE holdings_new (
  user_id    INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  category   TEXT,
  value      REAL NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);
INSERT INTO holdings_new (user_id, name, kind, category, value, note, updated_at)
  SELECT 1, name, kind, category, value, note, updated_at FROM holdings;
DROP TABLE holdings;
ALTER TABLE holdings_new RENAME TO holdings;

-- people: keep id PK; UNIQUE(name) -> UNIQUE(user_id, name)
CREATE TABLE people_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 1,
  name         TEXT NOT NULL,
  relation     TEXT,
  how_met      TEXT,
  status       TEXT DEFAULT 'active',
  notes        TEXT,
  next_step    TEXT,
  last_contact TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(user_id, name)
);
INSERT INTO people_new (id, user_id, name, relation, how_met, status, notes, next_step, last_contact, created_at)
  SELECT id, 1, name, relation, how_met, status, notes, next_step, last_contact, created_at FROM people;
DROP TABLE people;
ALTER TABLE people_new RENAME TO people;

-- awards: keep id PK; UNIQUE(key) -> UNIQUE(user_id, key)
CREATE TABLE awards_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL DEFAULT 1,
  key               TEXT NOT NULL,
  title             TEXT NOT NULL,
  icon              TEXT,
  detail            TEXT,
  goal_id           INTEGER REFERENCES goals(id),
  xp                INTEGER NOT NULL DEFAULT 25,
  awarded_at        TEXT NOT NULL,
  reward            TEXT,
  reward_claimed_at TEXT,
  UNIQUE(user_id, key)
);
INSERT INTO awards_new (id, user_id, key, title, icon, detail, goal_id, xp, awarded_at, reward, reward_claimed_at)
  SELECT id, 1, key, title, icon, detail, goal_id, xp, awarded_at, reward, reward_claimed_at FROM awards;
DROP TABLE awards;
ALTER TABLE awards_new RENAME TO awards;

-- merchant_category: PK (pattern) -> (user_id, pattern)
CREATE TABLE merchant_category_new (
  user_id    INTEGER NOT NULL DEFAULT 1,
  pattern    TEXT NOT NULL,
  category   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pattern)
);
INSERT INTO merchant_category_new (user_id, pattern, category, created_at)
  SELECT 1, pattern, category, created_at FROM merchant_category;
DROP TABLE merchant_category;
ALTER TABLE merchant_category_new RENAME TO merchant_category;

-- notify_allow: PK (pattern) -> (user_id, pattern)
CREATE TABLE notify_allow_new (
  user_id    INTEGER NOT NULL DEFAULT 1,
  pattern    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, pattern)
);
INSERT INTO notify_allow_new (user_id, pattern, kind, created_at)
  SELECT 1, pattern, kind, created_at FROM notify_allow;
DROP TABLE notify_allow;
ALTER TABLE notify_allow_new RENAME TO notify_allow;
