-- WatchOMacho v4 schema. Fresh installs run this; existing installs run
-- migration-v6.sql which does the same set of CREATE statements after
-- dropping the old tables.
--
-- Mental model: Targets (things the agent researches) get Skills (named
-- procedures) applied to them, producing Reports (markdown writeups) that
-- accumulate on each target's page over time. The cron walks active targets
-- and re-runs their skill on the configured cadence.

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  primary_skill_id TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER,
  -- Per-target Tavily knobs (v11). NULL = use the global default from the
  -- `settings` table. Keeps tuning out of the global namespace so changing
  -- one target's behaviour doesn't silently change every other target's.
  queries_per_run INTEGER,
  tavily_min_score REAL,
  tavily_max_final_sources INTEGER,
  -- Fixed daily anchor for scheduling (v12). 0-23, UTC. The next_run_at
  -- formula picks the next slot at `anchor + k*cadence_hours` (mod day)
  -- strictly after the just-finished run, so cadence no longer drifts
  -- by run-duration each cycle. NULL = inherit DEFAULT_ANCHOR_HOUR_UTC
  -- from src/agent.ts (currently 2 → 02:00 UTC).
  anchor_hour_utc INTEGER,
  -- Per-target comic switch (v13). 1 = generate a comic after each briefing,
  -- 0 = never, NULL = inherit the global `comics_enabled` setting (ships
  -- 'off'). See makeComic() in src/agent.ts.
  comic_enabled INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_targets_status_next ON targets(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_targets_created ON targets(created_at DESC);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- The writer instructions. Goes verbatim into the planner + writer
  -- system prompts. Replaces the old "parse markdown headers for tool
  -- selection" magic (v10+). Tool selection now lives in tool_slug etc.
  procedure_md TEXT NOT NULL,
  -- Explicit tool config (v10). Replaces the old markdown-header parser.
  -- NULL tool_slug means "writer only — no data gathering".
  tool_slug TEXT,
  tool_op TEXT,
  tool_params_json TEXT,    -- {"topic":"news","time_range":"day","depth":"basic"}
  tool_sources_json TEXT,   -- ["https://...","..."] (only used by tavily/extract)
  author TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_created ON skills(created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  skill_id TEXT,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  word_count INTEGER,
  sources_json TEXT,
  run_id TEXT,
  chat_model TEXT,                          -- which Workers AI model wrote this report
  -- Paired comic (v13). SVG lives in R2 under comic_r2_key; comic_slug is a
  -- short descriptive slug for the comic's own page. Both NULL = no comic.
  comic_r2_key TEXT,
  comic_slug TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_skill ON reports(skill_id);

CREATE TABLE IF NOT EXISTS runs (
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

CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('daily_report_limit', '20', 0),
  ('daily_search_limit', '500', 0),
  ('cron_max_per_tick', '2', 0),
  ('last_cron_run', '0', 0),
  ('chat_model', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 0),
  ('comics_enabled', 'off', 0);

CREATE TABLE IF NOT EXISTS daily_usage (
  date TEXT PRIMARY KEY,
  reports INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_ts ON login_attempts(ip, ts);
