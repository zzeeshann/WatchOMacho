# WatchOMacho

An autonomous AI agent that wanders the world through public archives — Wikipedia, OpenStreetMap, REST Countries, Open-Meteo — and writes short field notes about what it finds. It runs on its own schedule, remembers what it has already learned, links new notes back into a growing memory graph, and serves a vintage explorer-journal dashboard.

Built end-to-end on Cloudflare: Workers (compute), Workers AI (the brain), Vectorize (memory), R2 (note storage), D1 (structured store + audit log), Cron Triggers (autonomy).

> **New here? Open [BOOK.md](BOOK.md).** It walks complete beginners through what Cloudflare is, what each piece (Workers / Workers AI / D1 / R2 / Vectorize) does, what an agent loop actually is, how RAG works, and how WatchOMacho is glued together. ~10 short chapters; no prior knowledge assumed.

## What it does (v3)

- **Digest mode (new)**: in `digest` strategy, the agent doesn't wander randomly — it watches live feeds (USGS earthquakes, surging Wikipedia articles) every cron tick and only writes a short note when an event matches one of your **interest subscriptions** by semantic similarity. Quiet days cost nothing.
- **Interest subscriptions**: freeform topics like *"Pacific volcanism"* or *"central Asian languages"*. Each is embedded once; incoming events are matched by cosine similarity above a tunable threshold. Set, mute, and delete from the admin panel.
- **Per-topic public digest**: the public dashboard shows recent matches grouped under each topic, so "today's signal from the world" is the front door instead of a random map dot.
- **Autonomous runs**: every N hours (configurable live, no redeploy) it picks a topic and writes a ~300-word field note.
- **Smarter topic choice**: rotates between *random country*, *random Wikipedia*, *bridge mode* (LLM picks a topic that connects two past notes), a *gap* bias toward unvisited countries, or *digest* (live-feed interest-monitor).
- **Persistent memory**: every note is embedded with `bge-base-en-v1.5` and stored in Vectorize. The agent retrieves the 3–4 most similar past notes before writing, so the new note can explicitly connect to what it already knows.
- **Real knowledge graph**: every retrieval edge is persisted in a `connections` table, so the map can draw the actual links the agent has made — not just where it's been.
- **Missions** (multi-step research): admin sends a brief like *"Explore high-altitude human settlements and what makes life there possible"*. The LLM plans 3–5 sub-topics, the agent writes a note on each, then writes a closing **synthesis** note that ties them together. Missions resume across cron ticks and admin pageloads.
- **Ask**: RAG over every field note the agent has written.
- **Public dashboard**: stats, a sepia journey map with a chronological travel path *and* connection arcs between linked notes, the digest, recent field notes.
- **Admin panel**: trigger runs, dispatch missions, ask, manage subscriptions, set cadence + topic strategy + daily budgets, see active missions and recent runs.

## Safety, abuse, and cost gates

- **Daily budgets**: separate caps for *notes / day*, *asks / day*, *missions / day*, set live from the admin panel. Caps are checked before any Workers-AI call — when exhausted, endpoints return `429` with a friendly JSON message and the daily counter resets at 00:00 UTC.
- **Login throttle**: 10 failed `/admin/login` attempts per IP in any rolling 10-minute window locks that IP out (HTTP 429) without even reaching the secret-compare.
- **Single-writer mission lock**: each exploration has a stale-tolerant `advancing_at` claim, so concurrent pumpers (cron + dispatcher's `waitUntil` + admin pageload) can't write duplicate step notes.
- **Constant-time secret compare**: admin secret check uses XOR-fold equality regardless of input length.
- **Cookies**: `HttpOnly`, `Secure`, `SameSite=Strict` — CSRF-safe by construction.
- **Security headers on every response**: strict CSP (allowing only the actual externals — OpenStreetMap tiles, unpkg for Leaflet, Google Fonts), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` disabling camera/mic/geolocation.
- **Safe JSON-in-script**: the map's inline `<script>` payload escapes `</`, `<!--`, and U+2028/U+2029 so a note title can't break out of the script tag.
- **Client-side popup escaping**: marker popups are built with an explicit HTML-escape on the title/place fields, and the note id is whitelist-validated before being put into a URL.
- **SQL injection-proof**: every D1 query uses `prepare().bind()`. No string concatenation into SQL.

## Architecture

```
       cron (hourly) / GET / / POST /admin/run / POST /admin/explore / POST /admin/ask
                                          │
                                          ▼
                              Cloudflare Worker (src/index.ts)
                                          │
                ┌─────────────────────────┼────────────────────────┐
                ▼                         ▼                        ▼
          Public APIs               Workers AI                 Memory
       (Wikipedia REST,        (Llama 3.3 70B chat,       (Vectorize 768-d
        REST Countries,         bge-base-en-v1.5         + R2 markdown blobs
        Nominatim,              embedding)                + D1 metadata, edges,
        Open-Meteo)                                        runs, missions,
                                                           usage, settings)
```

Source layout:

```
WatchOMacho/
├── wrangler.toml          # Cloudflare bindings + cron
├── schema.sql             # full v2 D1 schema (fresh installs)
├── migration-v2.sql       # v1 → v2 (explorations, connections, settings)
├── migration-v3.sql       # v2 → v3 (budgets, login_attempts)
├── migration-v4.sql       # v3 → v4 (exploration single-writer claim)
├── package.json
├── tsconfig.json
├── .dev.vars.example
├── README.md              # you are here
├── BOOK.md                # absolute-beginner companion book
└── src/
    ├── index.ts           # router + cron + scheduled handler
    ├── agent.ts           # learnOnce, ask, missions, memory, budgets
    ├── apis.ts            # Wikipedia / REST Countries / Nominatim / Open-Meteo
    └── dashboard.ts       # all server-rendered HTML
```

## Setup — about 10 minutes

You need a Cloudflare account (free tier works), `npm`, and Node 18+.

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

npm run db:init        # creates notes + runs + settings + explorations + connections + daily_usage + login_attempts
npm run bucket:create  # creates the R2 bucket
npm run vector:create  # creates the Vectorize index (768 dims, cosine)
```

If you're upgrading an existing v1 install, run the migrations in order:

```bash
npx wrangler d1 execute watchomacho-db --remote --file=migration-v2.sql
npx wrangler d1 execute watchomacho-db --remote --file=migration-v3.sql
npx wrangler d1 execute watchomacho-db --remote --file=migration-v4.sql
npx wrangler d1 execute watchomacho-db --remote --file=migration-v5.sql
```

### 3. Set the admin secret

This is the password that unlocks `/admin/login`. Use a long random string — it's the only thing standing between strangers and your Workers-AI budget.

```bash
# Generate + upload in one step (zsh / bash)
SECRET=$(openssl rand -hex 32)
echo "ADMIN_SECRET=$SECRET" >> .dev.vars     # for local dev (gitignored)
echo "$SECRET" | npx wrangler secret put ADMIN_SECRET
echo "$SECRET"                                # save this somewhere safe
```

### 4. Deploy

```bash
npm run deploy
```

If you set the custom-domain route in `wrangler.toml`, wrangler creates the DNS record and the SSL cert automatically (your domain has to be a Zone on the same Cloudflare account). Otherwise wrangler gives you a `*.workers.dev` URL.

### 5. First run

The public dashboard is empty until the agent learns something. Three options:

- Go to `/admin/login`, enter your secret, then **Trigger a single run** in the panel.
- **Send the agent on a mission** with a brief and a step count.
- Wait for the next cron tick (default frequency: 6 hours).

A single run takes ~10–15 seconds (one chat call + two embedding calls + a few public API hits). A 3-step mission takes 30–60 seconds, which exceeds one Worker invocation's `waitUntil` budget — the dispatcher kicks off as many steps as it can, then the hourly cron + every admin pageload pump it forward.

## Customizing

### The agent's personality

The agent reads a `CONTRACT` string in [src/agent.ts](src/agent.ts). Edit it freely — change the tone, the rules, the topics it focuses on. The next run picks up the changes.

### How often it runs

Two settings interact:

1. The cron schedule in `wrangler.toml` (default `0 * * * *` — fires every hour). This is the *maximum* resolution.
2. `frequency_hours` in the `settings` table (default 6), editable live from the admin panel. The scheduled handler only actually writes a note if `now - last_cron_run ≥ frequency_hours`.

So the cron always wakes up to *pump explorations forward*, but only writes a fresh autonomous note when the frequency setting says it's time.

### Topic strategy

Set from the admin panel (`/admin` → Cadence & strategy):

- **mixed** (default): 40% country, 35% wiki, 25% bridge (once memory exists)
- **random**: 50/50 wiki / country, no smart selection
- **bridge**: always picks a topic that connects two past notes via an LLM call
- **gap**: favours unvisited countries
- **digest**: skip the random walk entirely. Each cron tick fetches USGS earthquakes (mag 4.5+) and yesterday's surging Wikipedia articles, embeds each new event, and writes a short field note only when an event matches one of your subscriptions above `digest_match_threshold` (default 0.45). Add topics in the admin panel under *Interest subscriptions*. The daily-notes budget still gates writes, so a viral wiki day can't drain the budget.

### Daily budgets

Set from the admin panel (`/admin` → Budget & safety). Defaults are conservative:

- `daily_note_limit`: 30
- `daily_ask_limit`: 100
- `daily_mission_limit`: 5

Set any to `0` to disable the cap for that kind. Counters reset at 00:00 UTC.

### The model

[src/agent.ts](src/agent.ts) uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default. If your account doesn't have access, swap to `@cf/meta/llama-3.1-8b-instruct-fast` — same API, smaller and faster, still produces good notes.

The embedding model `@cf/baai/bge-base-en-v1.5` outputs 768-dim vectors. **If you change the embedding model you must recreate the Vectorize index with matching dimensions.**

### Adding sources

[src/apis.ts](src/apis.ts) has one function per API. To add a new one (e.g. Hacker News, USGS earthquakes), write a fetcher there and branch into it from `pickTopic()` in [src/agent.ts](src/agent.ts).

## Cost

Realistic monthly cost at 4 cron runs/day + a few admin missions, on Cloudflare's free tier: **£0**.

- Workers requests: free under 100k/day
- Workers AI: 10k neurons/day free; each run uses ~50–200 neurons; missions cost roughly `(steps + 1)` runs each
- Vectorize: 30M queried dimensions/month free
- R2: 10GB free, $0 egress
- D1: 5GB free
- Cron Triggers: free

If the agent goes viral or you set frequency to every hour with no budgets, you'd hit the Workers Paid plan ($5/mo) and pay metered usage on top. **That's why the budget gates exist.** Set them low and raise them deliberately.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit ADMIN_SECRET in .dev.vars
npm run dev
```

Note: D1, Vectorize, and Workers AI work against your real Cloudflare account even in `wrangler dev` (unless you pass `--local`, in which case some bindings don't work). Easiest path: dev against your real bindings — they're free.

## API surface

Public (no auth):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Dashboard HTML |
| `GET` | `/note/:id` | Single note HTML with linked-notes panel |
| `GET` | `/api/journey?limit=N` | Recent notes (JSON) |
| `GET` | `/api/stats` | Aggregate counters (JSON) |
| `GET` | `/api/connections?limit=N` | Memory graph edges (JSON) |

Admin (cookie auth):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/login` | Login page |
| `POST` | `/admin/login` | Set admin cookie. Throttled per IP. |
| `POST` | `/admin/logout` | Clear admin cookie |
| `GET` | `/admin` | Admin panel HTML. Also pumps in-flight missions. |
| `POST` | `/admin/run` | Trigger one note (form: optional `prompt`) |
| `POST` | `/admin/ask` | RAG question (form: `question`) |
| `POST` | `/admin/explore` | Dispatch mission (form: `brief`, `steps`) |
| `GET` | `/admin/explorations` | Recent missions (JSON) |
| `GET` | `/admin/settings` | Current settings (JSON) |
| `POST` | `/admin/settings` | Update settings (form fields: `frequency_hours`, `topic_strategy`, `daily_note_limit`, `daily_ask_limit`, `daily_mission_limit`) |
| `GET` | `/admin/usage` | Today's usage (JSON) |
| `GET` | `/admin/subscriptions` | List interest subscriptions (JSON) |
| `POST` | `/admin/subscriptions` | Add a new subscription (form: `topic`) |
| `POST` | `/admin/subscriptions/:id/toggle` | Mute / unmute (form: `active` = `0` or `1`) |
| `POST` | `/admin/subscriptions/:id/delete` | Delete a subscription |
| `POST` | `/admin/digest/scan` | Run one digest scan immediately (returns counts) |

All admin POST endpoints accept form-urlencoded, multipart, or JSON request bodies.

## Troubleshooting

**"Could not generate a plan"** when dispatching a mission: rare. The LLM occasionally returns prose instead of a list. The parser handles JSON arrays, bulleted lists, numbered lists, and comma-separated lines — but very long briefs sometimes confuse it. Re-dispatch with a shorter brief.

**"plan parse failed: …"** in mission errors: the raw LLM output is included so you can see exactly what came back. Usually fixable by rephrasing.

**Mission stuck at N/M for an hour**: a step crashed mid-claim. The `advancing_at` claim auto-expires after 60 seconds, so the next cron tick will retry.

**Map is empty**: the agent has only written notes about non-place topics (people, abstract concepts) that didn't resolve to coordinates. Trigger a `country` strategy run or dispatch a mission with geographic sub-topics.

**429 on the API**: daily budget exhausted. Bump it in the admin panel or wait until 00:00 UTC.
