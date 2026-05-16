-- v7 → v8: tighten the `runs` table to reject stale enum values.
--
-- Before: triggered_by and status were free-form TEXT. After the Mission
-- removal, the only legal triggered_by values are 'cron' | 'manual', and
-- status has always only been 'success' | 'error'. Add CHECK constraints
-- so the database refuses to store anything else.
--
-- SQLite can't add CHECK to an existing column in place, so we drop and
-- recreate. Safe here because the runs table holds no data we need to keep.

DROP TABLE IF EXISTS runs;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  target_id TEXT,
  skill_id TEXT,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('cron', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  report_id TEXT,
  duration_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_runs_created ON runs(created_at DESC);
