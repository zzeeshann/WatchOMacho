-- WatchOMacho schema. Runs in Cloudflare D1.
-- All CREATE statements are idempotent so this file doubles as a migration.

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,            -- 'world-explorer'
  place TEXT,                     -- city or named place if any
  country TEXT,                   -- resolved country name
  lat REAL,
  lon REAL,
  snippet TEXT NOT NULL,          -- ~240 chars preview shown on the dashboard
  source TEXT NOT NULL,           -- 'wikipedia' | 'restcountries' | 'user-prompt' | 'exploration' | 'synthesis' | 'live-event'
  source_url TEXT,
  source_event_id TEXT,           -- stable id from the live source (USGS event id, "wiki-top:date:title"), for dedup
  r2_key TEXT NOT NULL,           -- path in R2 holding the full markdown
  word_count INTEGER,
  created_at INTEGER NOT NULL,    -- unix ms
  triggered_by TEXT NOT NULL,     -- 'cron' | 'manual' | 'prompt' | 'exploration' | 'digest'
  exploration_id TEXT,            -- if produced as part of an exploration
  step_index INTEGER              -- step number within that exploration
);

CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_country ON notes(country);
CREATE INDEX IF NOT EXISTS idx_notes_exploration ON notes(exploration_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_source_event
  ON notes(source, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'success' | 'error'
  topic_chosen TEXT,
  note_id TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

-- Key/value table for runtime config the admin can edit live.
-- Known keys:
--   frequency_hours          : how often the cron should actually run learnOnce (default '6')
--   last_cron_run            : unix ms of the last successful cron-triggered learn (default '0')
--   topic_strategy           : 'mixed' | 'random' | 'bridge' | 'gap' | 'digest' (default 'mixed')
--   digest_match_threshold   : cosine similarity needed for a live event to match a subscription (default '0.45')
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('frequency_hours', '6', 0),
  ('last_cron_run', '0', 0),
  ('topic_strategy', 'mixed', 0),
  ('digest_match_threshold', '0.45', 0);

-- Multi-step research missions kicked off from the admin panel.
-- The agent generates a plan, then writes one note per step, then a final
-- synthesis note that ties them together.
CREATE TABLE IF NOT EXISTS explorations (
  id TEXT PRIMARY KEY,
  brief TEXT NOT NULL,            -- the user's brief, verbatim
  status TEXT NOT NULL,           -- 'planning' | 'in_progress' | 'synthesizing' | 'complete' | 'error'
  plan_json TEXT,                 -- JSON array of sub-topic strings
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  synthesis_note_id TEXT,         -- the final connecting note, when written
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_explorations_created ON explorations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_explorations_status ON explorations(status);

-- Memory-recall edges. When the agent recalls past note B while writing note A,
-- we store (A, B, 'recall', score). The map and the journal use these to draw
-- the actual knowledge graph the agent is building.
CREATE TABLE IF NOT EXISTS connections (
  from_note_id TEXT NOT NULL,
  to_note_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'recall' | 'exploration' | 'manual'
  score REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_note_id, to_note_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_connections_from ON connections(from_note_id);
CREATE INDEX IF NOT EXISTS idx_connections_to ON connections(to_note_id);

-- User's freeform interest topics. Each row has an embedding (JSON-stringified
-- 768-float vector from bge-base-en-v1.5) so the live-feed scanner can match
-- incoming events by cosine similarity. Set active=0 to mute without deleting.
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  embedding_json TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(active);

-- Records which subscription a given note matched, and at what similarity.
-- Drives the per-topic digest view.
CREATE TABLE IF NOT EXISTS subscription_matches (
  note_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_sub_matches_sub ON subscription_matches(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_matches_note ON subscription_matches(note_id);
