# Architecture

Fast reference. For setup + the high-level picture, read [README.md](README.md).

---

## System diagram

```
                    ┌──────────────────────┐
                    │  CRON (every hour)   │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   ADMIN HTTP REQ     │
                    │   /admin/targets/X/run │
                    └──────────┬───────────┘
                               │
              ┌────────────────▼───────────────┐
              │  Worker (src/index.ts)         │
              │   - routes HTTP                 │
              │   - cron handler                │
              └────────────────┬───────────────┘
                               │
                   ┌───────────▼────────────┐
                   │  agent.ts              │
                   │   runResearch(target,  │
                   │      skill)            │
                   └───────────┬────────────┘
                               │
          ┌───────────────┬───────────┬──────────────┐
          ▼               ▼           ▼              ▼
      ┌──────────────┐ ┌─────────┐  ┌──────┐  ┌──────────────┐
      │ TOOLS:       │ │ Workers │  │ D1   │  │ Vectorize    │
      │  tavily      │ │   AI    │  │      │  │   (memory)   │
      │  (search +   │ │ bge-base│  │      │  │              │
      │   extract)   │ │ +chat   │  │      │  │              │
      │              │ │  fallback│ │      │  │              │
      └──────────────┘ └─────────┘  └──────┘  └──────────────┘
          │                          │
          │                          ▼
          │                      ┌──────┐
          └──────────────────────►  R2  │ (full markdown of each report
                                 └──────┘   + /static/tailwind.v2.css)
```

External: Tavily (web search + extract) — the only web tool. Anthropic via Cloudflare AI Gateway when the active chat model is `anthropic/...`.
Internal: Workers AI (embeddings always; chat fallback), D1, R2, Vectorize, Durable Objects.

---

## The research loop, step by step

For each `runResearch(target, skill, triggeredBy)` call:

| # | Step | Calls | Cost |
| --- | --- | --- | --- |
| 1 | **Budget check** | D1 read | ~free |
| 2 | **Build tool call** — read `skill.tool_slug`, `skill.tool_op`, `skill.tool_params_json`, `skill.tool_sources_json` directly from the row (no markdown parsing). NULL tool_slug = writer-only skill. | local | free |
| 3 | **Plan** — LLM picks **N** search queries where N = `target.queries_per_run` (NULL falls back to global default 10). Planner prompt scales with N. Skipped if the tool call isn't Tavily/search. | 1 chat call | ~150–300 neurons (Llama) / ~$0.001 (Haiku) |
| 4 | **Gather** — dispatch the tool call. Today always Tavily. Results pass through 3 filters (see "Gather pipeline" below). | N HTTP calls (one per query) | Tavily: 1 credit/query |
| 5 | **Recall** — Vectorize semantic + D1 same-target recents, layered & deduped | 1 embed + 1 vector query + 1 D1 query | ~3 neurons + free |
| 6 | **Write** — LLM produces the markdown report from gathered sources + recalled context | 1 chat call | ~$0.013–0.026 (Haiku) |
| 7 | **Persist** — R2 put + D1 inserts + embed + Vectorize upsert + update target.next_run_at + runs audit row + heartbeat setting | 1 R2 put + ~4 D1 writes + 1 embed + 1 Vectorize upsert | ~3 neurons + free |

**Total per run (Haiku default):** ~2 chat calls + 1 embedding + N Tavily calls (default N=10) → roughly **$0.013–0.026 + N Tavily credits**. At 2 runs/day = **~$10–20/year + 600 Tavily credits/month** (free tier is 1000).

---

## Gather pipeline (Tavily side, post-2026-05-18)

```
                  ┌──────────────────────────────┐
                  │  Planner LLM                  │
                  │  produces EXACTLY 10 queries  │
                  └──────────────┬───────────────┘
                                 │
                                 ▼
                    Tavily search × 10 queries
                    (max_results=20 per query)
                                 │
                                 ▼
                  ~100–200 raw candidates per run
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                                      │
   Filter 1: SCORE                                  │
   drop hits with score < tavily_min_score          │
   (admin-editable, default 0.4 — Tavily's          │
   bottom rail)                                      │
              │                                      │
              ▼                                      │
   ~10–60 survive (varies by news cycle)             │
              │                                      │
              ▼                                      │
   Filter 2: URL DEDUPE                              │
   drop any URL we've already kept this run          │
              │                                      │
              ▼                                      │
   Filter 3: TITLE JACCARD DEDUPE                    │
   normalise titles (lowercase, no punctuation,      │
   no stopwords) → Jaccard similarity ≥ 0.7 =       │
   same story, keep top 2 per cluster sorted by     │
   Tavily score                                      │
              │                                      │
              ▼                                      │
   Truncate each source's content to
   max_chars_per_source (default 4000 ≈ 1000 toks).
   Global setting (CPU lever).
              │
              ▼
   Cap at target.tavily_max_final_sources (default 100).
   Per-target — natural ceiling is ~30–40.
              │
              ▼
                       Passed to Recall step
```

Counters at each stage are persisted to `last_run_attempt.gather_stats` AND to the per-row `runs.gather_stats_json` column (added in migration v9). Three rendering sites use the same `renderGatherFunnel()` helper: the Maintenance heartbeat (live, most-recent run), the Activity card per row (any historical run), and the report page header (single-report view).

---

## Recall pipeline (Vectorize side)

```
                target + skill description
                       │
                       ▼
              ┌────────────────┐
              │ Embed model    │ @cf/baai/bge-base-en-v1.5
              │ (768-dim)      │  (free, Workers AI)
              └────────┬───────┘
                       │
        ┌──────────────┼────────────────┐
        ▼                                ▼
   D1: last 2 same-target           Vectorize: top-10
   reports (chronological            semantic hits
   continuity, guaranteed)            (similarity ≥ 0.65)
        │                                │
        │  ◄──── deduped against ────────┤
        │       (don't double-count)     │
        │                                │
        └────────────────┬───────────────┘
                         │
            same-target hits first,
            cross-target fallback,
            cap 5 total
                         │
                         ▼
                Recalled past reports
            (passed as [N] sources alongside
             web results in unified citation)
```

Recall is **best-effort** — if the embed call fails or Vectorize is empty, the writer just proceeds without prior-report context. Doesn't block writes.

---

## Observability (the Maintenance card)

Every run writes one settings row (`last_run_attempt`) that's read on each admin page load. Combined with the `runs` table, this gives four signals visible at a glance:

```
┌─ System heartbeat ───────────────────────────────────── cron 37m ago ▾ ┐
│                                                                         │
│  [in-flight banner — only when a run is currently running]              │
│                                                                         │
│  Cron        37m ago · next within the hour                             │
│  Last 24h    7 runs · 7 ✓ · avg 28s                                     │
│                                                                         │
│  Recent runs                                                            │
│    ✓  World News    2m ago · 14:23 · 19 May · 32.0s                     │
│    ✓  World News    1h ago · 13:21 · 19 May · 28.0s                     │
│    ...                                                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─ Memory & cleanup ──────── 11 R2 files · no orphans ──────────────── ▾ ┐
│                                                                         │
│  Stored report files (R2)                                               │
│  11 files · no orphans                              [Sweep orphans now] │
│                                                                         │
│  Recall memory (Vectorize)                                              │
│  Guardrails: layer 2 same-target recents · top-10 semantic ·            │
│              threshold 0.65 · cap 5 per run                             │
│                                                                         │
│  Embedding status                                                       │
│  Last successful embed 12h ago                        [Backfill memory] │
└─────────────────────────────────────────────────────────────────────────┘
```

State sources:

| Field | Read from | Refresh frequency |
|---|---|---|
| Cron last ran | `settings.last_cron_run` | once per cron tick |
| In-flight banner | `settings.last_run_attempt` when `outcome === "in_flight"` | every step boundary |
| Last 24h digest | `SELECT COUNT/SUM/AVG FROM runs WHERE created_at > now-24h` | every admin page load |
| Recent runs mini-list | `SELECT runs JOIN targets ORDER BY created_at DESC LIMIT 6` | every admin page load |
| Per-row gather funnel (Activity card) | `runs.gather_stats_json` (added v9) | written on every persist |
| R2 stats | live `env.REPORTS.list()` | every admin page load |
| Embedding status | `settings.embed_last_ok_at` / `embed_last_error` | every embedReport call |

Step boundaries inside `runResearch` flow: `init → plan → gather → recall → write → persist → done`. Failures tag the error message with the step (`gather: Tavily timeout`, `write: 5021: ... exceeded context window`). Activity row on target page renders `failed @ <step>` badge.

---

---

## D1 schema

Eight tables. Full source in [schema.sql](schema.sql). Headlines:

### `targets`

```sql
id TEXT PRIMARY KEY
slug TEXT UNIQUE
name TEXT
kind TEXT                          -- 'postcode' / 'place' / 'topic' / 'person' / 'company' / freeform
description TEXT
status TEXT                        -- 'active' / 'paused' / 'archived'
cadence_hours INTEGER              -- 1, 6, 12, 24, 72, 168
primary_skill_id TEXT
last_run_at INTEGER                -- unix ms
next_run_at INTEGER                -- unix ms; cron picks where this <= now
created_at, updated_at
```

### `skills`

```sql
id TEXT PRIMARY KEY
slug TEXT UNIQUE
name TEXT
description TEXT
procedure_md TEXT                  -- the source of truth — agent reads this at run time
author TEXT                        -- 'user' | 'agent'
used_count INTEGER                 -- incremented after each successful run
created_at, updated_at
```

### `reports`

```sql
id TEXT PRIMARY KEY
target_id TEXT
skill_id TEXT
title TEXT
snippet TEXT                       -- ~240 chars, shown on dashboards
r2_key TEXT                        -- where the full markdown lives
word_count INTEGER
sources_json TEXT                  -- JSON: [{title, url}, ...]
run_id TEXT
created_at
```

### `runs`

```sql
id TEXT PRIMARY KEY
target_id TEXT
skill_id TEXT
triggered_by TEXT                  -- 'cron' | 'manual' (CHECK constrained, v8)
status TEXT                        -- 'success' | 'error' (CHECK constrained, v8)
report_id TEXT                     -- if successful
duration_ms INTEGER
error TEXT                         -- prefixed with failing step: "gather: …", "write: …", "watchdog: …"
gather_stats_json TEXT             -- v9 — JSON snapshot of the Tavily funnel (queries/raw/score/url/title/final)
created_at
```

### `settings`

Key/value strings.

| Key | Default | Purpose |
| --- | --- | --- |
| `daily_report_limit` | `20` | Cap on reports written per UTC day |
| `daily_search_limit` | `500` | Cap on Tavily credits consumed per UTC day |
| `cron_max_per_tick` | `2` | Max targets advanced per hourly cron tick |
| `last_cron_run` | `0` | Last successful cron timestamp |

### `daily_usage`

```sql
date TEXT PRIMARY KEY              -- 'YYYY-MM-DD' UTC
reports INTEGER
searches INTEGER
updated_at INTEGER
```

### `login_attempts`

```sql
ip TEXT, ts INTEGER, ok INTEGER    -- for the throttle
```

---

## Vectorize metadata

Each entry keyed by `report_id`, with:

```json
{
  "target_id": "...",
  "target_name": "...",
  "target_slug": "...",
  "skill_slug": "...",
  "title": "...",
  "snippet": "...",
  "created_at": 1234567890000
}
```

Recall filters out same-target matches at query time (we surface same-target history separately via D1).

---

## R2 layout

```
reports/<created_at>-<report_id>.md
```

The full markdown of every report. `text/markdown; charset=utf-8`. Never queried; only fetched by `r2_key`.

---

## File responsibilities

| File | Lines | What's in it |
| --- | --- | --- |
| [src/apis.ts](src/apis.ts) | ~150 | Tavily integration (search + extract) and the `TOOLS` registry. All fetches accept an optional `AbortSignal`. |
| [src/agent.ts](src/agent.ts) | ~1900 | Targets (with per-target Tavily knobs) / skills (with explicit `tool_slug` etc. columns) / reports CRUD, `runChat()` dispatcher (Workers AI + Anthropic via AI Gateway, signal-aware), `skillToolCalls(skill)` (column-based), `gatherSources` (Tavily only today), `planResearch(n)` with N-scaling prompt, `runResearch` loop (signal-threaded for guardrails), `cronTick` (with `reapStalledRun` watchdog), budget gates, and the `ResearchRunner` Durable Object class wrapping manual runs in a 15-min alarm budget |
| [src/index.ts](src/index.ts) | ~660 | HTTP routing (public pages, gated `/api/*` JSON endpoints with `requireApiKey()`, `/static/tailwind.v2.css` from R2, admin CRUD, `/admin/targets/:slug/run` → ResearchRunner DO), auth/cookie, `readForm`, `scheduled` handler, security headers, re-export of `ResearchRunner` |
| [src/dashboard.ts](src/dashboard.ts) | ~2100 | All HTML rendering: public pages + admin pages (Console, dedicated `/admin/targets`, skills, tools, target edit), markdown renderer with `<sup class="cite">` citation rewriter, canonical Sources footer from D1, shared `renderGatherFunnel()` helper, the `renderHeartbeatCard` (24h digest + recent-runs mini-list) |

Total: ~4400 lines of TypeScript. Tailwind CSS is built locally via `npm run build:css` and served from R2 (not bundled into the Worker).

---

## HTTP API surface

### Public HTML (no auth)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | Home — list of active targets |
| GET | `/target/:slug` | Target page with all reports |
| GET | `/skill/:slug` | Skill detail with writer instructions |
| GET | `/report/:id` | Single report (date + word count only on header — no admin info) |

### JSON API (gated by `X-API-Key: <WATCHOMACHO_API_KEY>`)

`requireApiKey()` runs before every `/api/*` GET. Missing secret → 503. Missing/wrong header → 401. Constant-time compare.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/targets` | Active targets |
| GET | `/api/skills` | Skill list |
| GET | `/api/reports/recent?limit=N` | Latest reports across targets (1–50, default 10). Slim — summary + source_count, no body. |
| GET | `/api/reports/:id` | Full report — D1 metadata + R2 `body_markdown` + `sources[]` with `kind: "web" \| "archive"` |

### Admin (cookie auth, set via `/admin/login`)

| Method | Path | Action |
| --- | --- | --- |
| GET | `/admin/login` | Login page |
| POST | `/admin/login` | Set admin cookie. IP-throttled. |
| POST | `/admin/logout` | Clear cookie |
| GET | `/admin` | Console — heartbeat + settings + cleanup + diagnostics |
| GET | `/admin/targets` | Dedicated targets list + add form |
| GET | `/admin/targets/:slug` | Target edit page (Configure + Activity) |
| POST | `/admin/targets` | Create target |
| POST | `/admin/targets/:slug/update` | Patch target (incl. per-target Tavily knobs) |
| POST | `/admin/targets/:slug/run` | Run immediately (routes through DO) |
| POST | `/admin/targets/:slug/delete` | Delete target + reports |
| GET | `/admin/skills` | Skill library |
| POST | `/admin/skills` | Create skill — `mode=synthesize&brief=…` OR `mode=write` with `tool_slug`, `tool_op`, `topic`, `time_range`, `depth`, `procedure_md` |
| POST | `/admin/skills/:slug/update` | Edit skill |
| POST | `/admin/skills/:slug/delete` | Delete skill |
| GET | `/admin/tools` | Read-only catalog (Tavily only today) |
| GET | `/admin/settings` | Current settings + usage (JSON) |
| POST | `/admin/settings` | Update budgets + run guardrails |
| POST | `/admin/cron/tick` | Run a cron tick now (testing) |
| POST | `/admin/storage/gc` | Sweep R2 orphans |
| POST | `/admin/memory/backfill` | Re-embed every report into Vectorize |
| POST | `/admin/reports/:id/delete` | Delete a single report |

---

## Run Now path (Durable Object)

Manual runs cannot use the HTTP handler's `ctx.waitUntil` directly — it caps at **30 seconds** of wall-clock after the response, which is below the steady-state pipeline duration for slower skills. The fix is to schedule the work into a `ResearchRunner` Durable Object, whose `alarm()` runs in the scheduled-handler context with a **15-minute** budget.

```
POST /admin/targets/:slug/run
        │
        ▼
  stub = env.RESEARCH_RUNNER.get(idFromName(slug))   ← one DO per target
        │  (serialises back-to-back clicks on the same target)
        ▼
  await stub.scheduleManualRun(slug)
        │  · writes { targetSlug, triggeredBy } to DO storage
        │  · ctx.storage.setAlarm(now + 1s)
        ▼
  return 302 → /admin/targets/:slug?queued=1
        │
        ▼   (~1s later)
  ResearchRunner.alarm()  fires in scheduled context
        │  · reads max_run_seconds setting (default 90s)
        │  · creates AbortController, setTimeout(maxRunSeconds * 1000)
        │  · re-fetches target + skill from D1
        │  · runResearch(env, target, skill, "manual", controller.signal)
        │  · clearTimeout, delete pending job from DO storage
        ▼
  DO becomes idle, Cloudflare hibernates it ~10s later (no further charges)
```

Guardrails inside the alarm handler:

| Guardrail | Behaviour |
|---|---|
| **`max_run_seconds`** (default 90s, range 5–600s) | DO alarm's `setTimeout` calls `controller.abort()` when exceeded. All Tavily + Anthropic fetches downstream see the same signal and throw `AbortError`. The existing `runResearch` catch records `"<step>: max_run_seconds exceeded"` in the runs table. |
| **AbortController plumbing** | Signal threads through `runResearch → planResearch / gatherSources / writeReport → runChat → runAnthropicChat → fetch(..., { signal })`. Tavily search/extract also accept the signal. |
| **Watchdog (in `cronTick`)** | Once per hour, `reapStalledRun` scans `last_run_attempt`. If `outcome === 'in_flight'` and age > `max_run_seconds + 30s grace`, writes an error runs row and updates the heartbeat to `outcome: error` — catches the rare case where the DO alarm itself was killed before its catch could run. |
| **Workers Logs** | `[observability] enabled=true` in wrangler.toml. 7-day retention of `console.log` + uncaught errors in the Cloudflare dashboard. Filter by run id to replay any failure after the fact. |

Cost ceiling per stuck-but-aborted run: 90s × 0.128 GB = ~11.5 GB-seconds. Free quota is 13,000 GB-seconds/day. Unreachable from accidents.

Cron does **not** route through the DO — it already runs in the scheduled context with 15 min wall-clock available, and `runResearch` accepts an optional signal (omitted by cron, since cron has no hard soft-cap of its own beyond Cloudflare's 15-min hard limit).

---

## Cron behaviour

Cron schedule: `0 * * * *` (hourly).

On each tick (see `cronTick()` in `agent.ts`):

```sql
SELECT * FROM targets
 WHERE status = 'active'
   AND primary_skill_id IS NOT NULL
   AND (next_run_at IS NULL OR next_run_at <= now)
 ORDER BY COALESCE(next_run_at, 0) ASC
 LIMIT cron_max_per_tick
```

For each row: `runResearch(target, skill, 'cron')`.

After each successful run, `target.next_run_at = now + cadence_hours * 3600000`.

Daily budget gates stop early on `BudgetExceeded`.

---

## Bindings (wrangler.toml)

| Binding | Service | Used as |
| --- | --- | --- |
| `AI` | Workers AI | `env.AI.run(model, input)` for chat + embeddings |
| `DB` | D1 | `env.DB.prepare(sql).bind(...).run()` |
| `REPORTS` | R2 | `env.REPORTS.put(key, body)` / `.get(key)` |
| `MEMORY` | Vectorize | `env.MEMORY.upsert([...])` / `.query(vec)` |
| `RESEARCH_RUNNER` | Durable Object (SQLite backend) | `env.RESEARCH_RUNNER.get(env.RESEARCH_RUNNER.idFromName(targetSlug)).scheduleManualRun(slug)` — wraps `runResearch` in a 15-min DO alarm so manual "Run Now" isn't capped by the 30s `waitUntil` ceiling |

`[observability] enabled = true` is also set in `wrangler.toml` so console + errors are retained 7 days in the Cloudflare dashboard.

## Secrets

| Secret | Required? | Purpose |
| --- | --- | --- |
| `ADMIN_SECRET` | yes | Admin panel password. Generate with `openssl rand -hex 32`. |
| `TAVILY_API_KEY` | recommended | Tavily Researcher Free plan key (1000 credits/month). Without it, web search/extract is skipped — reports rely on LLM general knowledge only. |
| `WATCHOMACHO_API_KEY` | required for `/api/*` | Read-only key callers (daylila etc.) send in the `X-API-Key` header. Generate with `openssl rand -hex 32`. Unset → all `/api/*` endpoints return 503. |
| `AI_GATEWAY_ACCOUNT_ID` | optional | Cloudflare account ID (hex string in any dashboard URL). Required if you use `anthropic/...` chat models via AI Gateway. |
| `AI_GATEWAY_NAME` | optional | The gateway name you created in CF dashboard → AI → AI Gateway (e.g. `watchomacho`). Same requirement as `AI_GATEWAY_ACCOUNT_ID`. |
| `CF_AIG_TOKEN` | one of these two | Cloudflare API token with `AI Gateway: Run` scope. Enables Unified Billing — Cloudflare pays Anthropic on your behalf via prepaid credits loaded into your CF account. Single invoice. |
| `ANTHROPIC_API_KEY` | one of these two | Anthropic console API key. BYOK alternative to `CF_AIG_TOKEN` — you pay Anthropic directly. Use one OR the other, not both. |

Set all via `npx wrangler secret put …`. Never commit.

---

## Models

The chat model is editable live from `/admin`. The dispatcher (`runChat()` in `agent.ts`) routes by model-id prefix:

| Prefix | Path | Auth | Billing |
| --- | --- | --- | --- |
| `@cf/...` | `env.AI.run(model, input)` (Workers AI binding) | none | Cloudflare neurons pool (10k/day free) |
| `anthropic/...` | `https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_NAME}/anthropic/v1/messages` | `cf-aig-authorization: Bearer {CF_AIG_TOKEN}` OR `x-api-key: {ANTHROPIC_API_KEY}` | Cloudflare credits (Unified Billing) OR Anthropic directly (BYOK) |

| Use | Default | Notes |
| --- | --- | --- |
| Chat (planning + report writing + skill synthesis) | `anthropic/claude-haiku-4-5-20251001` | ~$0.01/report via Unified Billing. Allow-listed via `ALLOWED_CHAT_MODELS` in `agent.ts` (8 Workers AI options + 1 AI Gateway option as of writing). |
| Embeddings (memory) | `@cf/baai/bge-base-en-v1.5` | Always Workers AI. Tiny — fits comfortably in free pool. |

`DEFAULT_CHAT_MODEL` in `agent.ts` is what the cron tick + new installs use when the `chat_model` setting is missing. Adding a new model: append to `ALLOWED_CHAT_MODELS`, add a human-readable label to `CHAT_MODEL_LABELS`, and (if it's a new provider prefix) extend `runAnthropicChat`-style handler. Reports record their model in the `chat_model` column so you can A/B retrospectively.
