-- v4 → v5: interest subscriptions + live-event dedup
--
-- Adds:
--   subscriptions          — user's topics of interest, with stored embeddings
--   subscription_matches   — which subscription a given note matched (and score)
--   notes.source_event_id  — stable id from the live source for dedup
--
-- Topic strategy 'digest' (settings.topic_strategy) is a value-only change,
-- no schema needed.

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  embedding_json TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(active);

CREATE TABLE IF NOT EXISTS subscription_matches (
  note_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_sub_matches_sub ON subscription_matches(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_matches_note ON subscription_matches(note_id);

ALTER TABLE notes ADD COLUMN source_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_source_event
  ON notes(source, source_event_id)
  WHERE source_event_id IS NOT NULL;

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('digest_match_threshold', '0.45', 0);
