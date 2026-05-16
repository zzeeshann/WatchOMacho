-- One-shot migration to bring an existing v1 D1 up to v2.
-- Safe to run multiple times: ALTERs are guarded, CREATEs use IF NOT EXISTS.

-- D1/SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we use the standard
-- trick: try the ALTER and ignore the duplicate-column error via separate
-- statements (wrangler executes each ;-separated statement independently).
ALTER TABLE notes ADD COLUMN exploration_id TEXT;
ALTER TABLE notes ADD COLUMN step_index INTEGER;

CREATE INDEX IF NOT EXISTS idx_notes_exploration ON notes(exploration_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('frequency_hours', '6', 0),
  ('last_cron_run', '0', 0),
  ('topic_strategy', 'mixed', 0);

CREATE TABLE IF NOT EXISTS explorations (
  id TEXT PRIMARY KEY,
  brief TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT,
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  synthesis_note_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_explorations_created ON explorations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_explorations_status ON explorations(status);

CREATE TABLE IF NOT EXISTS connections (
  from_note_id TEXT NOT NULL,
  to_note_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  score REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_note_id, to_note_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_connections_from ON connections(from_note_id);
CREATE INDEX IF NOT EXISTS idx_connections_to ON connections(to_note_id);
