# WatchOMacho

An autonomous AI agent that wanders the world through public archives — Wikipedia, OpenStreetMap, REST Countries, Open-Meteo — and writes short field notes about what it finds. It runs on its own schedule, remembers what it has already learned, and serves a vintage explorer-journal dashboard.

Built end-to-end on Cloudflare: Workers (compute), Workers AI (the brain), Vectorize (memory), R2 (note storage), D1 (audit log), Cron Triggers (autonomy).

## What it does

- **Every 6 hours**, on its own, picks a topic and writes a ~300-word field note.
- **Remembers** every note via vector embeddings, so it doesn't repeat itself.
- **Connects dots** — when memory matches, it ends each note with a callback to something it learned before.
- **Listens** to admin prompts ("tell me about Bhutan") and queries against its memory.
- **Publishes** everything on a public dashboard with a world map of its journey.

## Architecture

```
        cron / HTTP /run / HTTP /ask
                    │
                    ▼
            Cloudflare Worker
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   Public APIs  Workers AI   Memory
   (Wikipedia,  (Llama 3.3,  (Vectorize
   REST         bge embed)   + R2 + D1)
   Countries,
   OSM,
   Open-Meteo)
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

npm run db:init        # creates the notes + runs tables
npm run bucket:create  # creates the R2 bucket
npm run vector:create  # creates the Vectorize index (768 dims, cosine)
```

### 3. Set the admin secret

This is the password that unlocks `/admin/login`. Pick something long and random — keep it somewhere safe.

```bash
npm run secret
# paste your secret when prompted
```

### 4. Deploy

```bash
npm run deploy
```

You'll get a URL like `https://watchomacho.<your-subdomain>.workers.dev`. Open it.

### 5. First run

The public dashboard is empty until the agent learns something. Two options:

- Go to `/admin/login`, enter your secret, click **Run agent now** in the panel.
- Or wait up to 6 hours for the first cron tick.

The first run takes ~10–15 seconds (one chat call + two embedding calls + a few public API hits).

## Customizing

### The agent's personality

The agent reads a `CONTRACT` string in `src/agent.ts`. Edit it freely — change the tone, the rules, the topics it focuses on. The next run picks up the changes.

For an even cleaner setup, move the contract into R2 (`NOTES.put("contract.md", text)`) and `NOTES.get("contract.md")` at the top of `learnOnce`. Then you can edit it without redeploying.

### How often it runs

`wrangler.toml`:

```toml
[triggers]
crons = ["0 */6 * * *"]   # every 6 hours
# crons = ["0 */2 * * *"]  # every 2 hours
# crons = ["0 9 * * *"]    # daily at 09:00 UTC
```

Cron syntax: `minute hour day-of-month month day-of-week`.

### The model

`src/agent.ts` uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default. If your account doesn't have access, swap to `@cf/meta/llama-3.1-8b-instruct-fast` — same API, smaller and faster, still produces good notes.

The embedding model `@cf/baai/bge-base-en-v1.5` outputs 768-dim vectors. If you change the embedding model, you must recreate the Vectorize index with matching dimensions.

### Adding sources

`src/apis.ts` has one function per API. To add a new one (e.g. Hacker News, USGS earthquakes), write a fetcher there and branch into it from `pickTopic()` in `src/agent.ts`.

## Cost

Realistic monthly cost at 4 runs/day on Cloudflare's free tier: **£0**.

- Workers requests: free under 100k/day
- Workers AI: 10k neurons/day free; each run uses ~50–200 neurons
- Vectorize: 30M queried dimensions/month free
- R2: 10GB free, $0 egress
- D1: 5GB free
- Cron Triggers: free

If the agent goes viral or you run it every minute, you'd hit the Workers Paid plan ($5/mo) and pay metered usage on top.

## Local development

```bash
cp .dev.vars.example .dev.vars
# edit ADMIN_SECRET in .dev.vars
npm run dev
```

Note: D1, Vectorize, and Workers AI work against your real Cloudflare account even in `wrangler dev` (unless you pass `--local`, in which case some bindings don't work). Easiest path is to just dev against your real bindings — they're free.

## File map

```
watchomacho/
├── wrangler.toml        # Cloudflare bindings + cron
├── schema.sql           # D1 tables
├── package.json
├── tsconfig.json
├── .dev.vars.example
└── src/
    ├── index.ts         # router + cron entry
    ├── agent.ts         # learning loop + ask()
    ├── apis.ts          # public API clients
    └── dashboard.ts     # all HTML
```

That's it. Four source files, ~900 lines total, six Cloudflare products in one project.
