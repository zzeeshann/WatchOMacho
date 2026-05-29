-- v12 → v13: each briefing can pair with a generated comic.
--
-- A "comic" is a small SVG (rendered in code, never an image-gen model) that
-- captures the briefing's connecting thread as a few connected panels. It is
-- produced inside runResearch() right after the report is persisted (so BOTH
-- the cron and the manual "Run Now" path get one), gated by an on/off switch.
--
-- Storage mirrors reports exactly: the SVG lives in R2 under `comics/...`, and
-- the `reports` row gets two new columns pointing at it:
--   comic_r2_key — the R2 object key for the SVG (NULL = no comic for this run)
--   comic_slug   — a short descriptive slug for the comic's own public page
--                  (e.g. "iran-war-ripples"), so daylila can give it a URL.
-- Both are NULL on every pre-v13 report and on any run where comics are off —
-- the renderer + API treat NULL as "no comic" and just omit it.
--
-- Control is per-target, mirroring the v11 Tavily knobs:
--   targets.comic_enabled — 1 = on, 0 = off, NULL = inherit the global default
--                           (`comics_enabled` setting, below; ships 'off').
-- Per-target (not global-only) so turning comics on for World News doesn't
-- force them onto unrelated targets (crime feeds, postcode dossiers, etc.).
--
-- Safe ADD COLUMN in place — existing rows get NULL for all three.

ALTER TABLE reports ADD COLUMN comic_r2_key TEXT;
ALTER TABLE reports ADD COLUMN comic_slug TEXT;
ALTER TABLE targets ADD COLUMN comic_enabled INTEGER;

-- Global default for targets whose comic_enabled is NULL. 'off' so comics are
-- opt-in: flip a target's switch (or this global) to 'on' to start generating.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('comics_enabled', 'off', 0);
