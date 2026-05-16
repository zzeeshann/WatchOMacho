# WatchOMacho

A research agent you give jobs to. You hand it a **target** (a postcode, a person, a company, a topic) and a **skill** (a reusable research procedure) — the agent applies the skill, writes a report, and keeps the target's page fresh on a cadence you set.

Built end-to-end on Cloudflare: Workers, Workers AI, Vectorize, R2, D1, Cron Triggers. Web research via [Tavily](https://tavily.com) — one tool, two operations (search + extract).

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

1. **Plan** — the LLM, given the skill's procedure and the target's identity, returns 3–6 web search queries. (Skipped if the skill declares `**Tavily op:** extract` with explicit URLs.)
2. **Gather** — Tavily runs every query in parallel; each result already includes the page's extracted full content. For extract-mode skills, Tavily reads the listed URLs in full.
3. **Recall** — Vectorize returns the most relevant past reports (so the new one *builds on* prior ones rather than repeating).
4. **Write** — the LLM writes a ~500-word markdown report following the skill's output structure, citing sources by number.
5. **Persist** — markdown in R2, row in D1, embedding in Vectorize, audit log in `runs`.

Two LLM calls + N Tavily calls per run. Predictable cost, predictable structure.

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
```

### 3. Set the secrets

```bash
# admin panel password
SECRET=$(openssl rand -hex 32)
echo "$SECRET" | npx wrangler secret put ADMIN_SECRET
echo "$SECRET"  # save it

# Tavily API key (free at app.tavily.com)
npx wrangler secret put TAVILY_API_KEY
# paste your key when prompted
```

Without `TAVILY_API_KEY` the agent still runs but produces thinner reports (LLM general knowledge only — fine for famous topics, useless for postcodes).

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

### Models

[src/agent.ts](src/agent.ts) uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for chat and `@cf/baai/bge-base-en-v1.5` for embeddings. If your account doesn't have access to Llama 3.3 70B, swap to `@cf/meta/llama-3.1-8b-instruct-fast` — same API, smaller, still fine.

## Cost

On the free tier, with 20 reports/day and ~5 searches per report:

- Workers requests: free under 100k/day
- Workers AI: 10k neurons/day free. Two chat calls + one embedding per report ≈ ~250 neurons. 20 reports/day ≈ 5k neurons — under the cap.
- Tavily: 1000 credits/month free on the Researcher plan = ~33/day. At 1 credit per basic search and 5 searches per report, that's ~6 reports/day before paying. Lower `daily_report_limit` (or `daily_search_limit`) to stay zero-cost, or upgrade Tavily's plan.
- Vectorize: 30M queried dimensions/month free
- R2: 10GB free, no egress
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
