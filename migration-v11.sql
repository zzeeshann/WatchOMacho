-- v10 → v11: targets get per-target Tavily knobs.
--
-- Before: tavily_min_score, max_final_sources, queries_per_run were all
-- global settings in the `settings` table — every target shared them. Bad
-- fit: World News wants 10 broad queries with min_score 0.4; a postcode
-- crime skill wants 2 narrow queries with stricter filtering. Changing
-- knobs for one target silently changed them for every other target.
--
-- After: knobs live on each `targets` row. NULL = fall back to the global
-- default in `settings` (so the existing globals still act as the
-- house-default for newly-added targets that haven't been tuned yet). The
-- planner prompt is also parameterised over queries_per_run — no more
-- "EXACTLY 10" baked in.
--
-- Globals that STAY in settings (genuinely worker-wide kill switches, not
-- tool tuning):
--   max_chars_per_source — caps the writer prompt size (CPU control)
--   max_run_seconds      — soft kill switch for hung runs
--   chat_model           — one model, one editorial voice

ALTER TABLE targets ADD COLUMN queries_per_run INTEGER;
ALTER TABLE targets ADD COLUMN tavily_min_score REAL;
ALTER TABLE targets ADD COLUMN tavily_max_final_sources INTEGER;
