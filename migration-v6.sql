-- v5 → v6: FULL WIPE. Old data model (random-walker field notes, missions,
-- subscriptions, live-event digest) is gone. New shape: targets the agent
-- researches, skills the agent applies, reports it accumulates per target.
--
-- WARNING: this drops every old table. Run only if you want a clean reset.

DROP TABLE IF EXISTS subscription_matches;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS connections;
DROP TABLE IF EXISTS explorations;
DROP TABLE IF EXISTS daily_usage;
DROP TABLE IF EXISTS login_attempts;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS notes;

-- Targets: things the agent is researching. One row per HA0 4GP, Bhutan, etc.
CREATE TABLE targets (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,                                -- 'postcode' | 'place' | 'topic' | 'person' | 'company' | freeform
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'paused' | 'archived'
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  primary_skill_id TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_targets_status_next ON targets(status, next_run_at);
CREATE INDEX idx_targets_created ON targets(created_at DESC);

-- Skills: reusable procedures the agent owns. procedure_md is the agent's
-- own instruction document — read at run time as the system prompt.
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  procedure_md TEXT NOT NULL,
  author TEXT NOT NULL,                     -- 'user' | 'agent'
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_skills_created ON skills(created_at DESC);

-- Reports: every research run produces one. Lives on the target's page,
-- accumulating over time.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  skill_id TEXT,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  word_count INTEGER,
  sources_json TEXT,                        -- JSON: [{title, url}, ...]
  run_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_reports_target ON reports(target_id, created_at DESC);
CREATE INDEX idx_reports_skill ON reports(skill_id);

-- Runs: audit log for every research run (cron / mission / manual).
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  skill_id TEXT,
  triggered_by TEXT NOT NULL,               -- 'cron' | 'mission' | 'manual'
  status TEXT NOT NULL,                     -- 'success' | 'error'
  report_id TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_runs_created ON runs(created_at DESC);

-- Live config the admin can edit.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('daily_report_limit', '20', 0),
  ('daily_search_limit', '500', 0),
  ('cron_max_per_tick', '2', 0),
  ('last_cron_run', '0', 0);

-- Per-day spend counters.
CREATE TABLE daily_usage (
  date TEXT PRIMARY KEY,
  reports INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Login throttle, IP-keyed (carried over from v3).
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

CREATE INDEX idx_login_attempts_ip_ts ON login_attempts(ip, ts);
