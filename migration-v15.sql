-- migration-v15.sql — edition_pieces: generic per-piece store for everything
-- WatchOMacho creates beyond the briefing + day-map. One row per (report, kind);
-- a new piece-type is a new `kind` value, never a schema change. Body lives in R2
-- (like reports.r2_key + day-maps), metadata + status here. Per-piece status/error
-- support modular regeneration: a single failed piece is visible and re-runnable
-- without rebuilding the whole edition.
--
-- Apply: wrangler d1 execute watchomacho-db --remote --file=migration-v15.sql
-- (kinds today: 'lesson', 'lab'. briefing + map stay on the reports row.)

CREATE TABLE IF NOT EXISTS edition_pieces (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL,              -- reports.id this edition is built on
  target_id   TEXT,                       -- denormalised for target-scoped queries
  kind        TEXT NOT NULL,              -- 'lesson' | 'lab' | <future>
  title       TEXT,                       -- lesson headline / lab title
  summary     TEXT,                       -- lesson lede / lab concept
  slug        TEXT,                       -- url slug
  r2_key      TEXT,                       -- body in R2 (lessons/...md, labs/...html)
  word_count  INTEGER,                    -- lessons
  meta_json   TEXT,                       -- per-kind forward-proof extras
  status      TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'failed'
  error       TEXT,                       -- last failure reason
  chat_model  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(report_id, kind)                 -- regen UPSERTs the same (report, kind)
);

CREATE INDEX IF NOT EXISTS idx_edition_pieces_report
  ON edition_pieces(report_id);
CREATE INDEX IF NOT EXISTS idx_edition_pieces_target_kind
  ON edition_pieces(target_id, kind, created_at);
