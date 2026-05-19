# WatchOMacho

A research agent you give jobs to. You hand it a **target** (a postcode, a person, a company, a topic) and a **skill** (a reusable research procedure) — the agent applies the skill, writes a report, and keeps the target's page fresh on a cadence you set.

Built end-to-end on Cloudflare: Workers, Workers AI, Vectorize, R2, D1, Cron Triggers. The agent has five tools available — web search/extraction via [Tavily](https://tavily.com), plus four typed UK public-data tools (HM Land Registry sold prices, ONS / postcodes.io geography, data.police.uk crime stats, Companies House). A skill can declare one or more tools.

> **New to the project?** Read [BOOK.md](BOOK.md) — a guided tour from "what is Cloudflare?" to "how the agent's research loop works", in 14 short chapters. No prior experience assumed.
>
> **Want a quick reference?** [ARCHITECTURE.md](ARCHITECTURE.md) has the schema, data flow, API surface, and bindings in scannable tables.
>
> **Where it's going?** [ROADMAP.md](ROADMAP.md) lays out the improvement ladder, cost trajectory, and what's deliberately deferred.

## The two concepts

```
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │  SKILL   │ →  │  TARGET  │ →  │  REPORT  │
   │ markdown │    │ /target/ │    │ markdown │
   │ procedure│    │   :slug  │    │ output   │
   └──────────┘    └──────────┘    └──────────┘
```

- **Target** — a thing the agent watches. Each target has its own page that accumulates reports over time. Statuses: `active`, `paused`, `archived`.
- **Skill** — a named markdown procedure the agent reads at run-time. Skills are reusable across targets (apply *housing research* to SW1A 1AA, SE1, E14, …). You can write skills by hand or describe a brief and let the agent synthesise the procedure.

A **report** is what comes out when the agent runs a skill against a target. The cron walks active targets and re-runs the attached skill on each one's cadence. Quiet targets stay quiet, busy ones keep producing updates.

## What a run does, end-to-end

For each `(target, skill)` execution:

1. **Plan** — the LLM, given the skill's procedure and the target's identity, returns up to 10 web search queries. (Skipped if the skill doesn't declare a Tavily search op — e.g. extract-mode or pure typed-tool skills.)
2. **Gather** — the agent dispatches over the skill's declared tools in order. Tavily search/extract for web work; Land Registry / ONS / Police / Companies House for typed UK data. Results pass through score / URL / title-similarity filters; structured tool output is flattened to markdown so the writer sees one consistent source format.
3. **Recall** — Vectorize returns the most relevant past reports + last 2 same-target reports via D1. They become `[N]` archive citations (📚) alongside web sources in the same numbered footer — so the new report *builds on* prior ones rather than repeating, and the archive becomes a navigable graph.
4. **Write** — the LLM writes a markdown report following the skill's output structure, citing every source (web + archive) inline by number.
5. **Persist** — markdown in R2, row in D1, embedding in Vectorize, audit log in `runs`, step-level heartbeat in `settings` so the admin Maintenance card can show *exactly* what just happened (Tavily funnel, last step, last error) without ever opening a log file.

Two LLM calls + N tool calls per run. Predictable cost (~$0.01–0.02 on Claude Haiku 4.5, free on Workers AI Llama), predictable structure, fully observable.

## Setup — about 10 minutes

You need a Cloudflare account (free tier works), `npm`, Node 18+, and a free [Tavily API key](https://app.tavily.com) (1000 credits/month on the Researcher Free plan).

### 1. Install

```bash
git clone <this repo>
cd watchomacho
npm install
npx wrangler login
```

### 2. Create the storage bindings

```bash
npm run db:create
# → copy the returned database_id into wrangler.toml under [[d1_databases]]

npm run db:init         # creates targets, skills, reports, runs, settings, etc.
npm run bucket:create   # creates the R2 bucket
npm run vector:create   # creates the Vectorize index (768 dims, cosine)
```

If you're upgrading from any earlier version, run the v6 migration instead of `db:init` — it drops the old data model and creates the new one — then chain through any later migrations:

```bash
npx wrangler d1 execute watchomacho-db --remote --file=migration-v6.sql
npx wrangler d1 execute watchomacho-db --remote --file=migration-v7.sql
npx wrangler d1 execute watchomacho-db --remote --file=migration-v8.sql
npx wrangler d1 execute watchomacho-db --remote --file=migration-v9.sql
```

The first deploy after v9 also creates the `ResearchRunner` Durable Object (SQLite backend, declared in `wrangler.toml`). No manual setup — `wrangler deploy` handles it. The DO is what manual "Run Now" routes through so it gets a 15-minute alarm budget instead of the 30-second `waitUntil` cap on HTTP handlers.

### 3. Set the secrets

```bash
# admin panel password
SECRET=$(openssl rand -hex 32)
echo "$SECRET" | npx wrangler secret put ADMIN_SECRET
echo "$SECRET"  # save it

# Tavily API key (free at app.tavily.com)
npx wrangler secret put TAVILY_API_KEY

# Optional — Companies House developer key (free, register at
# developer.company-information.service.gov.uk). Only needed if you want
# skills that call the companies_house tool. Without it, that one tool
# short-circuits to no results; everything else keeps working.
npx wrangler secret put CH_API_KEY

# Optional — AI Gateway (paid Anthropic / Google chat models, bypasses
# Workers AI's shared 10k neurons/day pool). See "Chat models" below.
npx wrangler secret put AI_GATEWAY_ACCOUNT_ID    # Cloudflare account ID (hex string in dashboard URL)
npx wrangler secret put AI_GATEWAY_NAME          # Gateway name you created in CF dashboard
npx wrangler secret put CF_AIG_TOKEN             # CF API token with "AI Gateway: Run" scope (Unified Billing — recommended)
# ─ OR ─ if you'd rather bring your own Anthropic key + pay Anthropic directly:
npx wrangler secret put ANTHROPIC_API_KEY        # console.anthropic.com key
```

Without `TAVILY_API_KEY` the agent still runs but produces thinner reports (LLM general knowledge only — fine for famous topics, useless for postcodes). Without `CH_API_KEY` only the Companies House tool is unavailable. Without the AI Gateway secrets the dropdown's Haiku option errors when selected; Workers AI models keep working.

### 4. Deploy

```bash
npm run deploy
```

If you set a custom-domain route in `wrangler.toml`, wrangler handles DNS + SSL automatically. Otherwise you'll get a `*.workers.dev` URL.

### 5. First run

1. Open `/admin/login` and unlock with your secret.
2. Open **Skills** → write or synthesise one (e.g. *"Housing research for UK postcodes"*).
3. Open **Admin** → add a target (e.g. `SW1A 1AA`), attach the skill, tick *Run once immediately*.
4. ~30 seconds later, the target's public page (`/target/sw1a-1aa`) shows the first report.
5. Every cron tick after that, the agent re-runs the skill and appends an update.

## The toolbox

Five tools are wired in [src/apis.ts](src/apis.ts) and registered in the `TOOLS` const. The catalog is rendered live at `/admin/tools`. A skill declares which tools it uses via markdown headers in its `procedure_md`:

| Tool | Operations | Inputs | Key needed? |
| --- | --- | --- | --- |
| **Tavily** | `search`, `extract` | keyword query / URL list | yes (free 1000/mo) |
| **HM Land Registry** | `sold-prices` | UK postcode | no |
| **ONS / postcodes.io** | `context` | UK postcode | no |
| **data.police.uk** | `crimes` | UK postcode (England/Wales/NI) | no |
| **Companies House** | `search`, `by-postcode` | name / UK postcode | yes (free) |

A skill declares a tool with a header like `**Tavily op:** search` or `**Land Registry op:** sold-prices`. Per-tool optional headers (e.g. `**Months:** 6`, `**Search topic:** news`) live underneath. Multi-tool skills are normal — a "postcode dossier" skill might declare all five.

Adding a new tool means: add a fetch function to `apis.ts`, add a `TOOLS` entry, add a dispatch case in `gatherSources` (in [src/agent.ts](src/agent.ts)). The synthesis prompt and `/admin/tools` page pick up the new entry automatically.

## Customising

### The agent's voice

The system prompt for the report writer is in `writeReport()` inside [src/agent.ts](src/agent.ts). Defaults to a restrained editorial tone. Change it freely.

### Cadence

Per target, set from the admin: 1h / 6h / 12h / 24h / 3d / weekly. The hourly cron walks `targets` looking for `next_run_at <= now` and runs at most `cron_max_per_tick` (default 2) per tick.

### Daily budgets

Set from `/admin`:

- `daily_report_limit` — caps how many reports the agent will write in a UTC day (default 20)
- `daily_search_limit` — caps Tavily credits consumed per UTC day (default 500)
- `cron_max_per_tick` — how many targets the cron advances per hour (default 2)

Counters reset at 00:00 UTC.

### Search tuning & run guardrails

Same admin card hosts the per-run knobs:

- `tavily_min_score` — drop Tavily hits below this relevance score (default 0.4)
- `max_final_sources` — cap on how many sources reach the writer (default 100; lower if writer payload is causing slow runs)
- `max_chars_per_source` — chars from each source's content sent to the writer (default 4000)
- `max_run_seconds` — soft kill switch on the DO alarm. Default 90s. Aborts in-flight Tavily / Anthropic fetches when wall-clock exceeds, writes an error runs row tagged with the step. Hard ceiling above is the 15-min DO alarm limit.

### Chat models

The chat model is editable live from `/admin`. Dropdown options:

**Cloudflare Workers AI** (free 10k neurons/day, shared across all models on your account):
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — ~28 reports/day
- `@cf/meta/llama-3.1-8b-instruct-fast` — ~100 reports/day, weaker writing
- Mistral Small 3.1, Llama 4 Scout, Gemma 3, QwQ, DeepSeek R1 etc. (see allow-list in `agent.ts`)

**Anthropic via AI Gateway** (paid, bypasses Workers AI quota):
- `anthropic/claude-haiku-4-5-20251001` — **default**. ~$0.01 per WatchOMacho report. Best writing quality among the cheap tier. Routed through your `watchomacho` AI Gateway.

The dispatcher (`runChat()` in `agent.ts`) routes by model-id prefix: `@cf/...` → `env.AI.run`; `anthropic/...` → `https://gateway.ai.cloudflare.com/.../anthropic/v1/messages` with either `cf-aig-authorization` (Unified Billing — Cloudflare pays Anthropic on your behalf via prepaid credits) or `x-api-key` (BYOK — you pay Anthropic directly).

Every report records which model wrote it (`reports.chat_model` column), displayed on the report page and in the report list. Useful for comparing model quality over time.

Embeddings still go to Workers AI's `@cf/baai/bge-base-en-v1.5` — they're tiny (~3 neurons each) and easy to keep on the free pool.

## Cost

Hobby use (~5 reports/day on Haiku 4.5):

- **Cloudflare AI Gateway credits: ~$1.60/month** (Haiku, ~$0.01 per report)
- Tavily: free (1000 credits/mo cap; ~25 credits/day at 5 basic searches each)
- Workers requests: free (under 100k/day)
- Workers AI (embeddings only): free (under 10k neurons/day)
- Vectorize: free (under 30M queried dimensions/month)
- R2: free (under 10GB; one Tailwind CSS bundle + reports)
- D1: free (under 5GB)
- Cron Triggers: free

At 20 reports/day on Haiku: ~$6/month.

**To stay 100% free**, switch the dropdown to a Workers AI model (Llama 3.1 8B fast gives ~100 reports/day on the shared neurons pool) and don't bother with AI Gateway / Anthropic. Reports look thinner but the loop still works.
- D1: 5GB free
- Cron Triggers: free

If you need more, Cloudflare Workers Paid ($5/mo) + a paid Tavily plan covers a serious workload.

## API surface

Public (no auth):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Home — list of active targets |
| `GET` | `/target/:slug` | Target page with all reports |
| `GET` | `/skill/:slug` | Skill detail with procedure |
| `GET` | `/report/:id` | Single report |
| `GET` | `/api/targets` | Active targets (JSON) |
| `GET` | `/api/skills` | Skills (JSON, without `procedure_md`) |

Admin (cookie auth):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/login` | Login page |
| `POST` | `/admin/login` | Set admin cookie (IP-throttled) |
| `POST` | `/admin/logout` | Clear cookie |
| `GET` | `/admin` | Overview |
| `GET` | `/admin/skills` | Skill library |
| `GET` | `/admin/tools` | Read-only catalog of tools skills can call |
| `POST` | `/admin/skills` | Create (form: `mode=synthesize&brief=…` or `mode=write&name&procedure_md`) |
| `POST` | `/admin/skills/:slug/update` | Edit |
| `POST` | `/admin/skills/:slug/delete` | Delete |
| `POST` | `/admin/targets` | Create target (form: `name`, optional `kind`, `description`, `cadence_hours`, `skill_slug`, `run_now`) |
| `GET` | `/admin/targets/:slug` | Edit page |
| `POST` | `/admin/targets/:slug/update` | Patch target |
| `POST` | `/admin/targets/:slug/run` | Run immediately |
| `POST` | `/admin/targets/:slug/delete` | Delete target + reports |
| `GET` / `POST` | `/admin/settings` | Read / write budgets |
| `POST` | `/admin/cron/tick` | Manually trigger a cron tick (testing) |

## Security

- Admin cookie: `HttpOnly`, `Secure`, `SameSite=Strict`. CSRF-safe by construction.
- Login throttle: 10 failed attempts per IP per 10-minute window → HTTP 429.
- Constant-time secret compare (XOR-fold).
- Strict CSP, no external scripts, no inline event handlers beyond what the dashboard ships.
- All D1 queries use prepared statements with bound parameters. No string concat into SQL.
- All HTML rendered server-side with explicit escaping.
- Markdown renderer is a hand-rolled subset (no `<img>`, no raw HTML) — even agent-written reports can't inject script.
