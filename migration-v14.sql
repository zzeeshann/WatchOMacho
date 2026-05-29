-- v13 → v14: the "comic" becomes the "day-map".
--
-- v13 paired each briefing with a small code-drawn SVG (a fixed vertical
-- "thread" of panels). v14 replaces that with a richer artifact: a single
-- self-contained interactive HTML "map of the day" — an overview of how the
-- day's stories connect (the one thread, the forces, the cause→effect links)
-- followed by the beats. It is written in ONE LLM call as free-form HTML +
-- inline CSS + vanilla JS (optionally one cdnjs library), then served and
-- embedded inside a sandboxed iframe. daylila pulls it and presents it the
-- same way it presents a "lab".
--
-- Nothing was live on daylila for the comic, so we rename in place rather than
-- keep dead `comic_*` names. The artifact is now HTML (not SVG); the R2 object
-- key column is reused under its new name. Existing rows keep their old SVG
-- keys under the renamed column — harmless, they just render as the old image
-- in the iframe until the target produces a fresh day-map.
--
-- D1's SQLite supports ALTER TABLE ... RENAME COLUMN, so the rename is in place
-- and preserves all existing data.

ALTER TABLE reports RENAME COLUMN comic_r2_key TO day_map_r2_key;
ALTER TABLE reports RENAME COLUMN comic_slug   TO day_map_slug;
ALTER TABLE targets RENAME COLUMN comic_enabled TO day_map_enabled;

-- Settings rows: the global default + the best-effort heartbeat keys.
UPDATE settings SET key = 'day_map_enabled'     WHERE key = 'comics_enabled';
UPDATE settings SET key = 'day_map_last_ok_at'  WHERE key = 'comic_last_ok_at';
UPDATE settings SET key = 'day_map_last_error'  WHERE key = 'comic_last_error';

-- Make sure the global default exists (ships 'off' — day-maps are opt-in).
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('day_map_enabled', 'off', 0);
