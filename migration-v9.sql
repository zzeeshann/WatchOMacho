-- v8 → v9: persist per-run gather funnel onto each runs row.
--
-- Before: gather_stats lived only on `settings.last_run_attempt` (the live
-- heartbeat), so the full Tavily funnel (200 raw → 122 score → 111 url →
-- 111 title → 100 final) was visible only for the most-recent run. Once
-- the next run started, the previous funnel was gone.
--
-- After: every `runs` row carries its own snapshot of gather_stats, so the
-- Activity card and the report page can show the funnel for any historical
-- run. JSON TEXT keeps the migration simple (no per-counter columns) and
-- mirrors the shape we already store in last_run_attempt.gather_stats.
--
-- Safe to ADD COLUMN in place — SQLite supports it on non-CHECK columns,
-- and existing rows get NULL for this field (the renderer treats missing
-- as "no gather stats available" and just omits that part of the meta).

ALTER TABLE runs ADD COLUMN gather_stats_json TEXT;
