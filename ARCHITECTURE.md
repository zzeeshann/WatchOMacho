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
          ┌───────────────┬───────────┬──────────────┐
          ▼               ▼           ▼              ▼
      ┌──────────────┐ ┌─────────┐  ┌──────┐  ┌──────────────┐
      │ TOOLS:       │ │ Workers │  │ D1   │  │ Vectorize    │
      │  tavily      │ │   AI    │  │      │  │   (memory)   │
      │  land_reg    │ │ Llama+  │  │      │  │              │
      │  ons         │ │ bge-base│  │      │  │              │
      │  police      │ │         │  │      │  │              │
      │  companies   │ │         │  │      │  │              │
      └──────────────┘ └─────────┘  └──────┘  └──────────────┘
          │                          │
          │                          ▼
          │                      ┌──────┐
          └──────────────────────►  R2  │ (full markdown of each report
                                 └──────┘   + /static/tailwind.v1.css)
```

External: Tavily (web search + extract), HM Land Registry SPARQL, postcodes.io (ONS area data), data.police.uk, Companies House.
Internal: Workers AI (chat + embeddings), D1, R2, Vectorize.

---

## The research loop, step by step

For each `runResearch(target, skill, triggeredBy)` call:

| # | Step | Calls | Cost |
| --- | --- | --- | --- |
| 1 | **Budget check** | D1 read | ~free |
| 2 | **Parse skill** — scan procedure_md for any registered tool's `**<Tool> op:**` header; collect each tool's per-tool params into a `SkillToolCall[]`. Default to one Tavily search if none declared. | local | free |
| 3 | **Plan** — LLM picks 3–6 search queries (only if at least one tool call is Tavily search) | 1 chat call | ~150–300 neurons |
| 4 | **Gather** — dispatch over the `SkillToolCall[]`. Each tool's handler fetches and flattens to markdown `{ title, url, content }`. Typed-tool output (Land Registry rows, ONS context, police crimes, Companies House hits) is rendered as a markdown table or labelled block so the writer sees a uniform source format. | N HTTP calls across the tools | Tavily: N credits; everything else: free |
| 5 | **Recall** — Vectorize for related past reports + D1 for same-target history | 1 embed + 1 vector query + 1 D1 query | ~3 neurons + free |
| 6 | **Write** — LLM produces the markdown report from gathered sources + recalled context | 1 chat call | ~300–700 neurons |
| 7 | **Persist** — R2 put + D1 insert + embed + Vectorize upsert + update target.next_run_at + audit row | 1 R2 put + 4 D1 writes + 1 embed + 1 Vectorize upsert | ~3 neurons + free |

**Total per run:** ~2 chat calls + 1 embedding + (3–6 Tavily calls if used) + (0–N typed-tool HTTP calls) → roughly **600–1200 neurons + 0–6 Tavily credits**. Typed-tool calls are upstream-rate-limited but cost nothing.

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
| [src/apis.ts](src/apis.ts) | ~540 | Five tool integrations (Tavily search/extract, Land Registry SPARQL, ONS via postcodes.io, data.police.uk, Companies House) + `TOOLS` registry |
| [src/agent.ts](src/agent.ts) | ~1280 | Targets / skills / reports CRUD, `runChat()` dispatcher (Workers AI + Anthropic via AI Gateway), `parseSkillTools` (multi-tool), `gatherSources` dispatch + per-tool gatherers (with Tavily score filter), `runResearch` loop, `cronTick`, budget gates |
| [src/index.ts](src/index.ts) | ~530 | HTTP routing (incl. `/static/tailwind.v1.css` from R2 + `/admin/targets/:slug/run` background invocation via `ctx.waitUntil`), auth/cookie, `readForm`, `scheduled` handler, security headers |
| [src/dashboard.ts](src/dashboard.ts) | ~1360 | All HTML rendering: public pages + admin pages (incl. `/admin/tools` rendering any registered tool), markdown renderer with `<sup class="cite">` citation rewriter, canonical Sources footer from D1, `stripMarkdown()` helper for snippets |

Total: ~3700 lines of TypeScript. Tailwind CSS is built locally via `npm run build:css` and served from R2 (not bundled into the Worker).

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
| GET | `/admin/tools` | Read-only catalog of all five tools and their skill-markdown headers |
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
| `TAVILY_API_KEY` | recommended | Tavily Researcher Free plan key (1000 credits/month). Without it, web search/extract is skipped — reports rely on LLM general knowledge + whichever typed tools the skill declares. |
| `CH_API_KEY` | optional | Companies House developer API key (free, register at developer.company-information.service.gov.uk). Only needed if a skill calls the `companies_house` tool. Without it that one tool short-circuits to no results; everything else keeps working. |
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
