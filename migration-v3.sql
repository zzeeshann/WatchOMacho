-- v3 migration: security + budget gates.
-- Idempotent; safe to re-run.

-- Per-day usage counters. Each cron note, manual run, ask, mission, and
-- mission step bumps a counter on the current UTC date. Budgets in the
-- settings table cap them.
CREATE TABLE IF NOT EXISTS daily_usage (
  date TEXT PRIMARY KEY,        -- 'YYYY-MM-DD' UTC
  notes INTEGER NOT NULL DEFAULT 0,
  asks INTEGER NOT NULL DEFAULT 0,
  missions INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Login attempts, keyed by IP. We never store the secret, just whether the
-- attempt succeeded. A sliding window over the last 10 minutes throttles
-- brute-force attempts.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL            -- 1 = success, 0 = failure
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_ts ON login_attempts(ip, ts);

-- Default budget settings. Pick conservative numbers; admin can raise them.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('daily_note_limit',    '30',  0),
  ('daily_ask_limit',     '100', 0),
  ('daily_mission_limit', '5',   0);
