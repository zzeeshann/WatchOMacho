-- WatchOMacho schema. Runs in Cloudflare D1.

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,            -- 'world-explorer'
  place TEXT,                     -- city or named place if any
  country TEXT,                   -- resolved country name
  lat REAL,
  lon REAL,
  snippet TEXT NOT NULL,          -- ~240 chars preview shown on the dashboard
  source TEXT NOT NULL,           -- 'wikipedia' | 'restcountries' | 'user-prompt'
  source_url TEXT,
  r2_key TEXT NOT NULL,           -- path in R2 holding the full markdown
  word_count INTEGER,
  created_at INTEGER NOT NULL,    -- unix ms
  triggered_by TEXT NOT NULL      -- 'cron' | 'manual' | 'prompt'
);

CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_country ON notes(country);

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
