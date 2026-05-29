# WatchOMacho

A research agent you give jobs to. You hand it a **target** (a topic, a company, a postcode, a person) and a **skill** (a reusable research procedure) — the agent applies the skill, writes a markdown report, and keeps the target's page fresh on a cadence you set.

Built end-to-end on Cloudflare: Workers, Workers AI, Vectorize, R2, D1, Cron Triggers, Durable Objects. One web tool — [Tavily](https://tavily.com) — for search + page extraction.

> **Quick reference?** [ARCHITECTURE.md](ARCHITECTURE.md) has the schema, data flow, API surface, and bindings in scannable tables.
>
> **Where it's going?** [ROADMAP.md](ROADMAP.md) lays out the improvement ladder and what's deferred.

## The two concepts

```
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │  SKILL   │ →  │  TARGET  │ →  │  REPORT  │
   │ writer   │    │ /target/ │    │ markdown │
   │ instructns    │   :slug  │    │ output   │
   └──────────┘    └──────────┘    └──────────┘
```

- **Target** — a thing the agent watches. Each target has its own public page that accumulates reports over time. Statuses: `active`, `paused`, `archived`. Per-target Tavily knobs let you tune queries-per-run / min-score / max-final-sources independently.
- **Skill** — a named procedure the agent reads at run-time. Skills pick a tool + operation + parameters explicitly (no markdown-header magic), and have a free-text **writer instructions** field that feeds both the planner and the writer verbatim. WYSIWYG.

A **report** is what comes out when the agent runs a skill against a target. The hourly cron walks active targets and re-runs the attached skill on each one's cadence. Manual "Run now" routes through per-target Durable Objects with a 15-minute alarm budget.

## What a run does, end-to-end

For each `(target, skill)` execution:

1. **Plan** — the LLM, given the skill's writer instructions and the target, returns N web search queries. N is set per-target (default 10). The planner prompt scales with N (N=1: "the single most important query"; N=10: "EXACTLY 10 distinct angles").
2. **Gather** — the agent runs the skill's tool call. Today that's always Tavily (search or extract). Results pass through a min-score filter (per-target), URL dedupe, title-Jaccard story dedupe, and a final cap (per-target).
3. **Recall** — Vectorize returns the most relevant past reports + last 2 same-target reports via D1. They become `[N]` archive citations (📚) alongside web sources in the same numbered footer — so the new report builds on prior ones rather than repeating, and the archive becomes a navigable graph.
4. **Write** — the LLM writes a markdown report following the skill's output structure, citing every source (web + archive) inline by number. The writer also emits a YAML frontmatter block at the top — a real headline (`title`) and a 1–4 sentence editorial summary — so each report has its own story-specific title + abstract rather than a templated `target — skill (date)` string. A fallback path keeps the old template if the frontmatter is ever malformed (logs `writeReport: frontmatter parse failed` to worker logs).
5. **Persist** — markdown in R2, row in D1, embedding in Vectorize, audit log in `runs` (incl. per-run gather funnel JSON), step-level heartbeat in `settings` so the admin System heartbeat shows what's happening live.
6. **Comic** (optional, v13) — when comics are enabled for the target, one more LLM pass distils the finished briefing into a *spine* (the day's connecting thread) + 3–5 cause→effect panels. `renderComicSvg()` draws those into a fixed connection-chain SVG **in code** (brand palette, real text — never an image-gen model). The SVG is stored in R2 (`comics/*.svg`) and linked from the report row (`comic_r2_key` / `comic_slug`). Best-effort: a comic failure never fails the briefing. Runs on both the cron and manual paths (it lives in `runResearch`, not just the manual alarm). Toggle globally on the admin console or per-target on the target page (default off).

Two-to-three LLM calls + one Tavily batch per run. Predictable cost (~$0.05/run on Claude Sonnet 4.6, ~$0.01 on Haiku 4.5, free on Workers AI; the comic adds ~one short call when enabled), predictable structure, fully observable.

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

If you're upgrading from an earlier version, run every migration in order:

```bash
for v in 6 7 8 9 10 11 12 13; do
  npx wrangler d1 execute watchomacho-db --remote --file=migration-v$v.sql
done
```

The first deploy also creates the `ResearchRunner` Durable Object (SQLite backend, declared in `wrangler.toml`) — no manual step.

### 3. Set the secrets

```bash
# admin panel password
echo "$(openssl rand -hex 32)" | npx wrangler secret put ADMIN_SECRET

# Tavily API key (free at app.tavily.com)
npx wrangler secret put TAVILY_API_KEY

# Read-only JSON API key for /api/reports/*  (used by daylila and any other
# consumer). Callers send it in the X-API-Key header.
echo "$(openssl rand -hex 32)" | npx wrangler secret put WATCHOMACHO_API_KEY

# Optional — AI Gateway (paid chat models, bypasses Workers AI 10k neurons/day pool).
npx wrangler secret put AI_GATEWAY_ACCOUNT_ID    # Cloudflare account ID (hex string in dashboard URL)
npx wrangler secret put AI_GATEWAY_NAME          # Gateway name you created in CF dashboard
npx wrangler secret put CF_AIG_TOKEN             # CF API token with "AI Gateway: Run" scope (Unified Billing — recommended)
# ─ OR, bring your own Anthropic key + pay Anthropic directly: ─
npx wrangler secret put ANTHROPIC_API_KEY
```

Without `TAVILY_API_KEY` the agent still runs but produces thinner reports (LLM general knowledge only). Without `WATCHOMACHO_API_KEY` the JSON API returns 503 — public HTML pages keep working. Without the AI Gateway secrets the Anthropic dropdown options (Sonnet 4.6, Haiku 4.5) error; Workers AI models keep working — flip the dropdown to one as a fallback.

Build the Tailwind bundle and upload to R2:

```bash
npm run build:css
npx wrangler r2 object put watchomacho-reports/static/tailwind.v2.css \
  --file=tailwind.css --content-type="text/css; charset=utf-8"
```

### 4. Deploy

```bash
npm run deploy
```

If you set a custom-domain route in `wrangler.toml`, wrangler handles DNS + SSL automatically. Otherwise you'll get a `*.workers.dev` URL.

### 5. First run

1. Open `/admin/login` and unlock with your admin secret.
2. Open **Skills** → write or synthesise a skill (tool = Tavily, op = search, topic = news or general). The writer instructions go straight into the prompts.
3. Open **Targets** → add a target (e.g. `World News`), attach the skill, tick *Run once immediately*.
4. ~30 seconds later, the target's public page (`/target/world-news`) shows the first report.
5. Every cron tick after that, the agent re-runs the skill and appends an update.

## Admin layout

`/admin` is structured around frequency of use:

| Card | Always-open | Contents |
| --- | --- | --- |
| System heartbeat | yes | Cron last ran · in-flight banner (when live) · last 24h digest (N runs, X✓ Y✕, avg duration) · clickable recent-runs list with relative + absolute timestamps |
| Budgets & settings | collapsed | Chat model · daily report/Tavily caps · runs/hour · run guardrails (max chars per source, writer max tokens, max run seconds) |
| Memory & cleanup | collapsed | R2 orphan sweep · Vectorize recall status + Backfill memory button |
| Diagnostics | collapsed | Link to Cloudflare Workers Observability dashboard |

Targets and their add form live on their own page at `/admin/targets`. Each target's detail page (`/admin/targets/:slug`) hosts: the Configure card (status, cadence, primary skill, per-target Tavily knobs) and the Activity card (recent runs + reports for this target with the per-run gather funnel inline).

## Per-target tuning

Each target can override three Tavily defaults from its Configure card. NULL = use the global default.

| Knob | Default | Range |
| --- | --- | --- |
| `queries_per_run` | 10 | 1–20 |
| `tavily_min_score` | 0.35 | 0.0–1.0 |
| `tavily_max_final_sources` | 100 | 1–200 |

So a "broad news brief" target can ask for 10 queries with min-score 0 (keep everything), while a "focused company watch" target asks for 2 queries with min-score 0.7 — without colliding on globals.

## Chat models

Editable live from Budgets & settings. Dispatcher (`runChat()` in `agent.ts`) routes by model-id prefix.

**Workers AI** (free 10k neurons/day, shared across all models on your account):
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — ~28 reports/day
- `@cf/meta/llama-3.1-8b-instruct-fast` — ~100 reports/day, weaker writing
- Mistral Small 3.1, Llama 4 Scout, Gemma 3, QwQ, DeepSeek R1 (full allow-list in `agent.ts`)

**Anthropic via AI Gateway** (paid, bypasses Workers AI quota):
- `anthropic/claude-sonnet-4-6` — **default**. ~$0.05–0.45 per report depending on how many sources are kept (input tokens scale with `max_final_sources` × `max_chars_per_source`).
- `anthropic/claude-haiku-4-5-20251001` — fallback. ~$0.01 per report. Pick this if cost matters more than quality.

Every report records which model wrote it (`reports.chat_model`). Embeddings always go through Workers AI `@cf/baai/bge-base-en-v1.5` (free, tiny).

## Cost

Hobby use on **Sonnet 4.6** (1 target × 1 report/day):

- **AI Gateway: ~$1.50–13/month** depending on min-score (tight filter → ~$0.05/run, no filter → ~$0.44/run on a busy news skill)
- Tavily: free (1000 credits/mo cap; ~30 credits/day per news-style run)
- Everything else (Workers requests, Workers AI embeddings, Vectorize, R2, D1, Cron, Durable Objects): free

On **Haiku 4.5** the same workload costs ~$0.30–1.20/month. Switch via the chat-model dropdown anytime — no redeploy needed. Workers AI options stay in the dropdown as the $0 fallback.

## API surface

### Public (HTML, no auth)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Home — list of active targets |
| `GET` | `/target/:slug` | Target page with all reports |
| `GET` | `/skill/:slug` | Skill detail with writer instructions |
| `GET` | `/report/:id` | Single report |
| `GET` | `/comic/:id` | The report's paired comic SVG (`image/svg+xml`), if any. 404 when the report has no comic. |

### JSON API — gated by `X-API-Key: <WATCHOMACHO_API_KEY>`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/targets` | Active targets |
| `GET` | `/api/skills` | Skill list |
| `GET` | `/api/reports/recent?limit=N` | Latest reports across targets (1–50, default 10). Each row: LLM-authored `title` + `summary`, `date` (ISO ms), `briefing_date` (`YYYY-MM-DD` UTC — v12, the canonical "what day" field), `target {slug,name}`, `word_count`, `source_count`, public `url`, and `comic` (`{slug, url}` or `null` — v13; no inline SVG here to keep the feed light) |
| `GET` | `/api/reports/:id` | Full report: above metadata + `body_markdown` (from R2) + `sources[]` with `kind: "web" \| "archive"` + `comic` (`{slug, url, svg}` with the SVG inlined, or `null` — v13). Same `briefing_date` field as `/recent`. |

Daylila or any other dashboard polls `/api/reports/recent` for a feed and `/api/reports/:id` for full content, renders the markdown its own way.

### Admin (cookie auth)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET`/`POST` | `/admin/login`, `/admin/logout` | Auth |
| `GET` | `/admin` | Console (heartbeat + settings + cleanup) |
| `GET` | `/admin/targets`, `/admin/targets/:slug` | Targets list + edit |
| `POST` | `/admin/targets`, `/admin/targets/:slug/{update,run,delete}` | CRUD + run-now |
| `GET` | `/admin/skills`, `/admin/tools` | Skill library + tool catalog |
| `POST` | `/admin/skills`, `/admin/skills/:slug/{update,delete}` | Skill CRUD |
| `GET`/`POST` | `/admin/settings` | Read/write budgets + guardrails |
| `POST` | `/admin/cron/tick` | Manually trigger a cron tick (testing) |
| `POST` | `/admin/storage/gc` | Sweep R2 orphans |
| `POST` | `/admin/memory/backfill` | Re-embed every report into Vectorize |
| `POST` | `/admin/reports/:id/delete` | Delete a single report |

## Security

- Admin cookie: `HttpOnly`, `Secure`, `SameSite=Strict`. CSRF-safe by construction.
- Login throttle: 10 failed attempts per IP per 10-minute window → HTTP 429.
- Constant-time secret compare (XOR-fold) — admin AND JSON API.
- JSON API fails closed: missing `WATCHOMACHO_API_KEY` secret = 503, missing/wrong header = 401.
- Strict CSP, no external scripts, no inline event handlers beyond what the dashboard ships.
- All D1 queries use prepared statements with bound parameters.
- All HTML rendered server-side with explicit escaping.
- Markdown renderer is a hand-rolled subset (no `<img>`, no raw HTML) — even agent-written reports can't inject script.
