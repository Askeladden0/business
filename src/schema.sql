PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  email                 TEXT NOT NULL UNIQUE,
  plan                  TEXT NOT NULL DEFAULT 'gratis',
  status                TEXT NOT NULL DEFAULT 'active',   -- active | past_due | canceled
  stripe_customer_id    TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end    TEXT,
  alert_level           TEXT NOT NULL DEFAULT 'viktig',   -- kritisk | viktig | alle
  delivery_mode         TEXT NOT NULL DEFAULT 'straks',   -- straks | daglig
  extra_recipients      TEXT NOT NULL DEFAULT '',         -- kommaseparert
  webhook_url           TEXT,
  webhook_kind          TEXT NOT NULL DEFAULT 'slack',    -- slack | json
  webhook_secret        TEXT,
  api_key               TEXT UNIQUE,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Én rad per enhet vi kjenner, delt mellom alle kunder. Dette er nøkkelen til
-- at marginalkostnaden er O(1) i antall kunder.
CREATE TABLE IF NOT EXISTS entities (
  orgnr        TEXT PRIMARY KEY,
  navn         TEXT,
  snapshot     TEXT,          -- JSON, normalisert
  raw_hash     TEXT,
  deleted      INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT,
  last_changed TEXT,
  fetch_error  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  orgnr       TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, orgnr)
);
CREATE INDEX IF NOT EXISTS idx_watches_orgnr ON watches(orgnr);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  orgnr         TEXT NOT NULL,
  navn          TEXT,
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL,   -- kritisk | viktig | info
  felt          TEXT,
  fra_verdi     TEXT,
  til_verdi     TEXT,
  occurred_at   TEXT NOT NULL DEFAULT (datetime('now')),
  dedup_key     TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_events_orgnr ON events(orgnr, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(occurred_at DESC);

-- Fan-out: én rad per (kunde, hendelse). Utestående rader er køen.
CREATE TABLE IF NOT EXISTS deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON deliveries(status, account_id);

CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  status      TEXT NOT NULL,   -- ok | error
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  detail      TEXT,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs ON job_runs(job, started_at DESC);

CREATE TABLE IF NOT EXISTS mail_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient   TEXT NOT NULL,
  subject     TEXT,
  kind        TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mail_log_time ON mail_log(created_at DESC);

-- Demper ops-varsler slik at én vedvarende feil ikke gir hundre e-poster.
CREATE TABLE IF NOT EXISTS alert_state (
  signature    TEXT PRIMARY KEY,
  last_sent_at TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT,
  handled_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
