# Architecture

Fast reference. For narrative explanation, read [BOOK.md](BOOK.md). For setup, [README.md](README.md).

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
       ┌───────────┬───────────┼───────────┬──────────────┐
       ▼           ▼           ▼           ▼              ▼
   ┌───────┐  ┌────────┐  ┌─────────┐  ┌──────┐  ┌──────────────┐
   │ Brave │  │  Wiki  │  │ Workers │  │ D1   │  │ Vectorize    │
   │ Search│  │  REST  │  │   AI    │  │      │  │   (memory)   │
   │       │  │        │  │ Llama+  │  │      │  │              │
   │       │  │        │  │ bge-base│  │      │  │              │
   └───────┘  └────────┘  └─────────┘  └──────┘  └──────────────┘
       │                                  │
       │                                  ▼
       │                              ┌──────┐
       └──────────────────────────────►  R2  │ (full markdown of each report)
                                      └──────┘
```

External: Brave Search, Wikipedia REST, Nominatim (rare).
Internal: Workers AI (chat + embeddings), D1, R2, Vectorize.

---

## The research loop, step by step

For each `runResearch(target, skill, triggeredBy)` call:

| # | Step | Calls | Cost |
| --- | --- | --- | --- |
| 1 | **Budget check** | D1 read | ~free |
| 2 | **Plan** — LLM picks 3–6 search queries | 1 chat call | ~150–300 neurons |
| 3 | **Gather** — N Brave searches in parallel | N HTTP calls | N Brave queries (~$0 free tier) |
| 4 | **Recall** — Vectorize for related past reports + D1 for same-target history | 1 embed + 1 vector query + 1 D1 query | ~3 neurons + free |
| 5 | **Wikipedia grounding** (first run for target only) | 1 HTTP call | free |
| 6 | **Write** — LLM produces the markdown report | 1 chat call | ~200–500 neurons |
| 7 | **Persist** — R2 put + D1 insert + embed + Vectorize upsert + update target.next_run_at + audit row | 1 R2 put + 4 D1 writes + 1 embed + 1 Vectorize upsert | ~3 neurons + free |

**Total per run:** ~2 chat calls + 1 embedding + 5–7 search queries → roughly **500–1000 neurons + 5–7 Brave queries**.

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
triggered_by TEXT                  -- 'cron' | 'manual'
status TEXT                        -- 'success' | 'error'
report_id TEXT                     -- if successful
duration_ms INTEGER
error TEXT
created_at
```

### `settings`

Key/value strings.

| Key | Default | Purpose |
| --- | --- | --- |
| `daily_report_limit` | `20` | Cap on reports written per UTC day |
| `daily_search_limit` | `500` | Cap on Brave queries per UTC day |
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
| [src/apis.ts](src/apis.ts) | ~150 | `braveSearch`, `wikipediaSummary`, `geocodeQuery` |
| [src/agent.ts](src/agent.ts) | ~550 | Targets / skills / reports CRUD, `runResearch` loop, `cronTick`, budget gates |
| [src/index.ts](src/index.ts) | ~400 | HTTP routing, auth/cookie, `readForm`, `scheduled` handler, security headers |
| [src/dashboard.ts](src/dashboard.ts) | ~900 | All HTML rendering: public pages + admin pages + safe markdown renderer |

Total: ~2000 lines of TypeScript.

---

## HTTP API surface

### Public (no auth)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | Home — list of active targets |
| GET | `/target/:slug` | Target page with all reports |
| GET | `/skill/:slug` | Skill detail with procedure |
| GET | `/report/:id` | Single report |
| GET | `/api/targets` | Active targets (JSON) |
| GET | `/api/skills` | Skills (JSON, without `procedure_md`) |

### Admin (cookie auth, set via `/admin/login`)

| Method | Path | Action |
| --- | --- | --- |
| GET | `/admin/login` | Login page |
| POST | `/admin/login` | Set admin cookie. IP-throttled. |
| POST | `/admin/logout` | Clear cookie |
| GET | `/admin` | Overview |
| GET | `/admin/skills` | Skill library |
| POST | `/admin/skills` | Create skill — `mode=synthesize&brief=…` OR `mode=write&name&procedure_md` |
| POST | `/admin/skills/:slug/update` | Edit skill |
| POST | `/admin/skills/:slug/delete` | Delete skill |
| POST | `/admin/targets` | Create target — `name`, optional `kind`, `description`, `cadence_hours`, `skill_slug`, `run_now` |
| GET | `/admin/targets/:slug` | Edit page |
| POST | `/admin/targets/:slug/update` | Patch target |
| POST | `/admin/targets/:slug/run` | Run immediately |
| POST | `/admin/targets/:slug/delete` | Delete target + reports |
| GET | `/admin/settings` | Current settings + usage (JSON) |
| POST | `/admin/settings` | Update budgets |
| POST | `/admin/cron/tick` | Run a cron tick now (testing) |

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

## Secrets

| Secret | Required? | Purpose |
| --- | --- | --- |
| `ADMIN_SECRET` | yes | Admin panel password. Generate with `openssl rand -hex 32`. |
| `BRAVE_API_KEY` | recommended | Brave Search Free AI plan key. Without it, web search is skipped — reports become LLM-knowledge-only. |

Set both via `npx wrangler secret put …`. Never commit.

---

## Models

| Use | Model |
| --- | --- |
| Chat (planning + report writing + skill synthesis) | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Embeddings (memory) | `@cf/baai/bge-base-en-v1.5` |

Configured as constants in [src/agent.ts](src/agent.ts:26-27). Swap by editing those two lines and redeploying.

To downgrade chat to a smaller, cheaper, more generous-quota model: `@cf/meta/llama-3.1-8b-instruct-fast`.
