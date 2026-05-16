# WatchOMacho — the beginner's book

A guided tour of the project for someone who has never touched Cloudflare, never built an AI agent, and isn't sure what half the words mean. Read it top to bottom and you'll know what every line in this repo does and *why*.

No prior experience required. Some JavaScript familiarity helps but isn't strictly needed.

---

## Foreword: why this book exists

WatchOMacho is small — about 1,400 lines of TypeScript across four files — but it touches six different Cloudflare products and three different families of AI ideas (chat models, embeddings, retrieval-augmented generation, agent loops). Reading the code without context is like reading a recipe written in a language you don't speak: you can see the *steps* but you don't know what any of the *ingredients* are.

This book hands you the ingredients first. By the end you'll be able to fork the project and confidently change anything in it.

We move from the very general to the very specific:

1. What is a "serverless" platform, and what's Cloudflare?
2. What is a Worker?
3. What is each Cloudflare storage thing (D1, R2, KV, Vectorize) actually *for*?
4. What is Workers AI?
5. What is an AI agent (versus a chatbot)?
6. What is a vector embedding, and what is RAG?
7. The agent loop: perceive → recall → think → act → remember.
8. A code tour of WatchOMacho.
9. Multi-step missions and why they're harder than they look.
10. Cost, safety, and the budget gates.
11. Making it yours.

---

## Chapter 1 — The serverless world

For most of the history of the web, if you wanted a website you ran a **server**: an actual computer (yours or a rented one) sitting in a rack somewhere, with an operating system, running a program that listens for HTTP requests and sends back responses. You paid for that computer 24/7, whether anyone visited your site or not. You patched its OS, watched its CPU graphs, restarted it when it crashed, and prayed when your one server in one city went down.

**Serverless** is a different deal. You don't have a server. You upload your *function* (a little program — "when an HTTP request comes in, do this and return a response") and the cloud provider takes care of everything else: running it, scaling it, putting copies of it physically close to whoever is calling it. You're charged not for "a computer running for a month" but for "the milliseconds and memory your function actually used". When nobody's visiting, you pay nothing.

The trade-off: your function has to start fast, finish fast, and not assume anything sticks around between invocations (no in-process state, no local files that survive).

**Cloudflare** is one of the big players in this space. They run an enormous network of data centres — over 300 cities — primarily as a CDN (content delivery network) for caching static files near users. Then they realised they could also run *your code* on the same network. That product is called **Cloudflare Workers**.

When you call `watchomacho.daylila.com`, your request hits whichever Cloudflare data centre is closest to you. The Worker code spins up *there*, executes, and replies — all in tens of milliseconds. You never know which physical machine ran your code, and that's the point.

> **Why we picked Cloudflare for this project**: it has a generous free tier (we can run WatchOMacho indefinitely for £0), it offers compute *and* storage *and* AI on one network, and the developer experience (the `wrangler` CLI) is unusually polished.

---

## Chapter 2 — What's a Worker?

A Cloudflare Worker is a self-contained JavaScript (or TypeScript, or WebAssembly) program that exports a `fetch` handler:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello world");
  }
};
```

That's the simplest possible Worker. Three things are noteworthy:

1. **`request`** is a standard Web `Request` object. The same one you'd get with `fetch` in a browser. No Node.js, no Express. The Web Platform is the platform.
2. **`env`** is your bindings: handles to your databases, buckets, vector index, AI models, secrets. We'll meet each one. Crucially, `env` lets your code talk to those services *without* HTTP — it's all native, fast, in-process.
3. **`ctx.waitUntil(promise)`** lets your handler keep working *after* the response has been sent. The user gets their reply instantly; meanwhile the Worker can keep writing to the database, calling APIs, embedding text, etc. This is huge for an agent that has to do slow work without making the user wait.

A Worker can also export `scheduled` for cron triggers:

```ts
async scheduled(event, env, ctx) {
  ctx.waitUntil(doWork(env));
}
```

That handler runs on a cron schedule you define in `wrangler.toml`. For WatchOMacho, the cron is what makes it *autonomous* — nobody has to be watching for the agent to keep exploring.

**Limits to keep in mind:**

- Each invocation gets a chunk of CPU time. Free plan: ~10ms of CPU per request, expandable for waitUntil. Paid plan: ~30s.
- Wall-clock time can be much longer than CPU time, because waiting on `fetch` or AI doesn't burn CPU.
- No filesystem. No long-lived in-memory state. Everything that has to persist goes into a binding (D1, R2, KV, Vectorize, etc.).

The whole `src/index.ts` of WatchOMacho is just one Worker — the `fetch` handler routes incoming requests to the right place, and the `scheduled` handler runs on the cron tick.

---

## Chapter 3 — The storage primitives

A Worker on its own is amnesiac — every invocation forgets everything. To remember things between calls, Cloudflare gives you a small zoo of storage products. Each one is good at exactly one thing and *terrible* at others. Picking the right one for each kind of data is half the design work.

### D1 — SQL for serverless

**Mental model**: it's SQLite, but managed for you and replicated globally. You write standard SQL (`CREATE TABLE`, `SELECT`, `INSERT`), you bind to a database in `wrangler.toml`, and from your Worker you call `env.DB.prepare("...").bind(...).all()`.

**Good for**: structured, relational data with rows and columns and indexes. Anything where you'd say "I want to query this".

WatchOMacho uses D1 for **seven tables**:

| Table | What's in it |
| --- | --- |
| `notes` | One row per field note: title, country, lat/lon, snippet, source, R2 key, etc. |
| `runs` | Audit log of every learnOnce invocation: when, why, success or error, how long. |
| `settings` | Live config (frequency, topic strategy, budgets, last cron timestamp). |
| `explorations` | Multi-step missions: brief, plan JSON, current step, status, synthesis pointer. |
| `connections` | The memory graph — every recall edge between notes. |
| `daily_usage` | Per-UTC-day counters of notes/asks/missions written, for the budget gates. |
| `login_attempts` | IP + timestamp + success-bit, for the login throttle. |

Why SQL for all this? Because the dashboard needs to do things like *"all notes ordered by date, joined with their connections, grouped by country"* — and SQL is what you want for that. The agent doesn't need it for its core inference, but the *humans looking at it* do.

### R2 — object storage

**Mental model**: it's S3 (Amazon's object store), but cheaper, with no egress fees. You put a blob (a string, a file, an image) at a key like `notes/foo.md`; you `get` it back later by key.

**Good for**: large blobs you don't want to query, just store and retrieve whole. Think "files".

WatchOMacho uses R2 for **the full markdown of every field note**. The snippet (240 chars) lives in D1 for quick listing on the dashboard, but the full ~300-word body lives in R2 at `notes/<timestamp>-<id>.md`. When you load a single note page, the Worker fetches the snippet row from D1, then fetches the body from R2, then renders both as HTML.

This split exists because D1 is good at *querying* but not at *storing* — you don't want to put long strings into every D1 row when you'd rarely select them.

### KV — key/value (not used here)

**Mental model**: a globally-replicated, eventually-consistent string-to-string dictionary. Good for caches, feature flags, simple session stores.

WatchOMacho doesn't use it because D1's `settings` table already plays the same role (and gives us joined queries when we want them). Worth knowing it exists.

### Vectorize — semantic memory

This is the magical one, and it deserves its own chapter. Skip ahead to Chapter 6 if you can't wait. For now:

**Mental model**: a database that doesn't index by exact strings — it indexes by *meaning*. You give it a list of numbers (a "vector embedding") that represents a piece of text, and later you can ask it *"what's similar to this other vector?"* and get the closest matches back.

That's the entire mechanism behind the agent's memory.

---

## Chapter 4 — Workers AI: the brain

Cloudflare runs LLMs and embedding models on its own GPUs and exposes them as a binding. Your Worker calls `env.AI.run(modelName, input)` and gets a response back — no API keys, no separate service, no rate-limit dance.

WatchOMacho uses **two** models:

### A chat model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

This is Meta's Llama 3.3 70-billion-parameter instruction-tuned model, quantised to FP8 for speed. It's the part of the agent that *writes things*: field notes, mission plans, syntheses, answers to "ask".

When the Worker calls `env.AI.run(CHAT_MODEL, { messages: [...] })`, Cloudflare ships those messages to a Llama GPU, gets the generated tokens back, and returns them to the Worker. From the developer's seat it's exactly one async function call.

You give the model two kinds of messages: a **system** message that sets its personality and rules (the `CONTRACT` constant in `agent.ts`), and one or more **user** messages with the actual prompt.

### An embedding model: `@cf/baai/bge-base-en-v1.5`

This one is different. You don't ask it to write text — you ask it to *describe* text as a list of 768 numbers (a vector). Texts about similar topics produce similar vectors. Texts about unrelated topics produce dissimilar ones.

We use embeddings for two things:

1. **Storing memory**: when the agent writes a note, we embed `title + body`, store the vector in Vectorize.
2. **Recall**: when we want to find related past notes, we embed the *query* (the new topic, or the user's question), then ask Vectorize *"give me the most similar vectors you have"*. The result is the most semantically relevant past notes.

This is called **cosine similarity** in the trade — measure the angle between two vectors. We don't have to implement it; Vectorize does it.

> **Why 768 dimensions?** It's an artefact of how the bge-base-en-v1.5 model was trained. Different embedding models output different dimensions. If you change the model, you have to recreate the Vectorize index with the matching dimension — otherwise your old vectors are in a different "space" and similarity becomes nonsense.

---

## Chapter 5 — What is an agent? (vs a chatbot)

A **chatbot** is reactive. You type, it responds, you type again, it responds again. It has no autonomy, no persistent memory (or only the conversation's), no goals beyond replying to whatever you said.

An **agent** is at least one of these:

1. **Autonomous** — it acts on its own schedule, not just in response to you.
2. **Persistent** — it has memory that survives across runs.
3. **Tool-using** — it can call external functions / APIs to do work, not just generate words.
4. **Goal-directed** — it pursues an objective over multiple steps.

WatchOMacho is all four. It runs autonomously (cron); it persists every note and links them in a graph; it calls public APIs (Wikipedia, OSM, Open-Meteo); and missions give it multi-step goals.

The shape of a single agent step is what people call **the agent loop**:

```
        ┌───────────────┐
        │   Perceive    │  ← fetch raw data (Wikipedia summary, country profile)
        └──────┬────────┘
               │
        ┌──────▼────────┐
        │    Recall     │  ← retrieve related memories from Vectorize
        └──────┬────────┘
               │
        ┌──────▼────────┐
        │    Think      │  ← call the chat model with raw data + recalled memory
        └──────┬────────┘
               │
        ┌──────▼────────┐
        │     Act       │  ← in our case, the "act" is producing a note
        └──────┬────────┘
               │
        ┌──────▼────────┐
        │   Remember    │  ← embed + store in Vectorize, write D1 row, save R2 blob,
        └───────────────┘     record connection edges
```

Every `learnOnce` call in WatchOMacho runs exactly this loop. Missions are *loops of loops* — the agent decides on sub-topics, then runs the loop on each, then runs one more loop to synthesise.

If you compare this to a chatbot, the only step a chatbot really has is **think**. Everything else — having data to start from, remembering anything, taking real action, storing what happened — is absent. That's why people care about agents.

---

## Chapter 6 — Vector embeddings and RAG, demystified

You probably hear "RAG" everywhere. **R**etrieval **A**ugmented **G**eneration. It sounds fancy. It's actually one of the simplest tricks in machine learning.

The problem RAG solves: LLMs have a fixed context window, and they only know what they were trained on. If you want the model to *also* know about your private documents, your last 47 field notes, or yesterday's news, you have two choices:

1. **Fine-tune** the model on your data. Expensive, slow, fragile, has to be redone whenever your data changes.
2. **Retrieve** the relevant bits of your data at prompt time and stuff them into the context, then let the LLM generate normally.

Option 2 is RAG. It's just *search, then prompt*.

The trick is the *search* step — how do you find which of your 47 documents are relevant to the user's question? You could grep for keywords, but that misses everything that uses different words for the same idea ("the war" vs "the conflict"). What you want is *semantic search* — find documents that *mean* the same thing.

That's where vector embeddings come in. An embedding model is trained so that *texts with similar meaning produce vectors that are close together in 768-dimensional space*. So:

1. You embed every document once, store the vectors in a vector DB.
2. When a query comes in, embed it.
3. Ask the vector DB *"give me the documents whose vectors are closest to this one"*.
4. Stuff those documents into the LLM's prompt.
5. The LLM generates an answer that uses them.

WatchOMacho does this in two places:

- **`recall()`** (called inside every `learnOnce`): embed the current topic, fetch top-4 related past notes, paste their snippets into the chat prompt.
- **`ask()`**: embed the user's question, fetch top-3 notes, fetch the full bodies from R2, paste them in, let the LLM answer.

That's RAG. No magic.

> **Why we store both the vector (in Vectorize) AND a copy in D1**: Vectorize tells us *which* notes to use; D1 + R2 give us the actual contents. Vector databases generally don't store huge text blobs.

---

## Chapter 7 — Connections: the memory graph

Standard RAG retrieves memories but discards the act of retrieval. You ask, you get docs, you generate, the docs are gone — the system never knew it used them.

WatchOMacho saves them. Every time a new note is written, we record an edge in the `connections` table: `from_note_id → to_note_id, kind='recall', score=0.71`. That's the agent saying "while writing X I remembered Y".

After a few weeks, those edges form a graph. The map in the dashboard draws them as thin lines between pins, so you can literally see what the agent has been connecting.

Synthesis notes from missions add a different kind of edge: `kind='exploration', score=1.0`, pointing from the synthesis to each step note it summarises. The map shows these in teal instead of oxblood.

This is one of the small things that turns "an agent that writes things" into "an agent that builds knowledge" — the structure is visible, queryable, and accumulating.

---

## Chapter 8 — A code tour of WatchOMacho

Now the fun bit. Four files. Open them in another window and follow along.

### `src/index.ts` — the router

Two responsibilities:

1. **`fetch(request, env, ctx)`** — handle HTTP requests. Just one giant if/else routing requests to the right handler. Public routes (`/`, `/note/:id`, `/api/*`) need no auth. Admin routes check the cookie via `isAdmin()`. Login throttle and security headers are wired here.
2. **`scheduled(event, env, ctx)`** — runs once per cron tick (hourly). First pumps any in-flight missions forward by one step, then checks `frequency_hours`; if it's time, calls `learnOnce(env, "cron")`.

The interesting bit is `readForm`: it accepts form-urlencoded, multipart, *or* JSON request bodies and returns a normalised `{ field: value }` object. That makes the API equally friendly to a browser form and a `curl` script.

### `src/apis.ts` — the public APIs

Five fetch wrappers. Each function hides the messy JSON shape of one public API and returns a clean little object:

- `randomWikipedia()` — pulls a random article summary from the Wikipedia REST API.
- `wikipediaSummary(title)` — looks up a specific article by title.
- `randomCountry()` — random country profile (capital, languages, currencies, coords) from REST Countries.
- `reverseGeocode(lat, lon)` — coords → country/city via OpenStreetMap Nominatim.
- `geocodeQuery(q)` — free-text → coords via Nominatim (the inverse).
- `currentWeather(lat, lon)` — current temperature + wind via Open-Meteo.

Everything here is **keyless and free**. The agent never has to authenticate to anything except its own Cloudflare bindings.

### `src/agent.ts` — the brain

Where the real action is. The file is structured top-to-bottom:

1. **Constants** — model IDs and the `CONTRACT` (system prompt). Editing the contract is how you change the agent's voice.
2. **Budget gates** — `checkBudget()`, `bumpUsage()`, `getDailyUsage()`. These run before every neuron-spending action.
3. **Settings helpers** — `getSetting()` / `setSetting()`. The agent reads its own config from D1, so the admin panel can change behaviour without redeploying.
4. **Topic selection** — `pickTopic()`, plus `pickUnvisitedCountry`, `pickRandomWiki`, `pickBridge`. Strategy-driven dispatcher.
5. **Memory** — `recall()` and `persistConnections()`. The first pulls related notes; the second writes the edges.
6. **Writing & persistence** — `writeNote()` produces text, `runStep()` is the common per-note pipeline (recall → write → store in D1 + R2 + Vectorize → write edges → bump usage).
7. **Public entry: `learnOnce()`** — the single-shot agent loop. Picks a topic, calls `runStep`, logs to the `runs` table.
8. **Explorations** — `startExploration()` makes a plan; `advanceExploration()` does one step at a time, guarded by a single-writer claim; `synthesiseExploration()` writes the closing note.
9. **`ask()`** — RAG against memory.

The whole file is plain functions. No classes, no state — everything that has to persist gets handed an `env` and goes into D1/R2/Vectorize.

### `src/dashboard.ts` — every pixel of HTML

Four exported renderers — `renderDashboard`, `renderNotePage`, `renderAdminLogin`, `renderAdminPanel` — each returns a complete HTML string. No client framework. The dashboard JS that *is* there is small inline `<script>` blocks for the ask/explore/settings forms and the Leaflet map.

It's about half styling and half data fetching. The styling lives in two big constants (`FONTS`, `BASE_CSS`) plus per-page CSS. The data fetching is all D1 queries; the rendering is template literals with `escapeHtml` applied to every interpolated value.

One subtle bit: the map's inline `<script>` embeds JSON via `jsonForScript()` rather than raw `JSON.stringify()`. The difference matters because `</script>` inside a string literal would close the script tag and let an attacker inject markup. The wrapper escapes `</`, `<!--`, U+2028 and U+2029 specifically.

---

## Chapter 9 — Multi-step missions and why they're harder than single notes

A single `learnOnce` is ~15 seconds wall-clock — one chat call, two embedding calls, a few HTTP fetches. Comfortably inside a Worker's CPU budget.

A 5-step mission is *five* of those, plus a synthesis. Sixty seconds of wall-clock. **No single Worker invocation can hold sixty seconds open** — `waitUntil` caps you well before that.

So missions need to be **resumable**. The state lives in the `explorations` row (`current_step`, `status`, `plan_json`); each call to `advanceExploration` reads that state, does one step, updates it, and returns. Whoever calls it next continues where the last one left off.

In WatchOMacho, *three* different things call `advanceExploration`:

1. The dispatcher's own `ctx.waitUntil` chain immediately after `POST /admin/explore`. Drives the mission as far as one Worker invocation can.
2. The hourly cron's `scheduled` handler. Picks up where (1) left off, every hour.
3. **The admin pageload** (`GET /admin`). When you open the panel, the page pushes any in-flight mission forward by up to 3 steps in the background. So if you're sitting there watching, progress feels real-time.

Three concurrent pumpers is great for liveness but **bad for correctness** if they all try to advance the same exploration at the same time — you'd get duplicate step-3 notes. That's where the `advancing_at` column comes in: an `UPDATE … SET advancing_at = ? WHERE … AND (advancing_at IS NULL OR advancing_at < cutoff)` compare-and-swap. Only one caller wins; the others see `changes === 0` and bail out gracefully. If a winner crashes mid-step, the 60-second staleness window lets the next pump take over.

This is the same pattern people use for distributed cron jobs and queue consumers. We're using it for an LLM agent, but the idea is identical: **single-writer lock with a stale-tolerant timeout**.

---

## Chapter 10 — Cost, safety, and the budget gates

When you have an autonomous agent connected to a paid AI, the question is no longer "will this work?" but "what if it works *too much*?" A bug in the cron loop or a stranger guessing your admin secret could burn through your free neurons in an afternoon, or worse, your bank account once you're past the free tier.

WatchOMacho has four lines of defence, layered from cheap to expensive:

### 1. Security headers (every response)

`Content-Security-Policy` restricts where the page can load scripts/styles/images/fonts from. The CSP we ship allows *exactly* the three externals the dashboard actually needs (OSM tiles, unpkg's Leaflet, Google Fonts) and nothing else. If an attacker somehow got HTML into a note title, they couldn't load a malicious script to actually run anything.

`X-Frame-Options: DENY` prevents your site from being embedded in someone else's `<iframe>` for clickjacking.

`X-Content-Type-Options: nosniff` stops the browser from guessing content types.

`Referrer-Policy: strict-origin-when-cross-origin` keeps the URL paths of your notes out of HTTP `Referer` headers when users click outbound links.

`Permissions-Policy` disables APIs (camera, mic, geolocation) the page has no business asking for.

All of these are free; they're just headers.

### 2. Cookie hygiene

The admin cookie is `HttpOnly` (JavaScript can't read it), `Secure` (only sent over HTTPS), `SameSite=Strict` (only sent on same-origin requests). The last one alone defeats most CSRF — a malicious site can't make your browser POST `/admin/run` on your behalf.

### 3. Login throttle

The admin secret is 256 random bits, so brute-forcing it is computationally infeasible. But credential-stuffing and typo storms still create noise. The Worker checks `login_attempts` for the client IP and refuses any further attempts once 10 failures have hit that IP in the last 10 minutes — *without* even running the constant-time comparison. The Worker also opportunistically prunes old rows so the table stays small.

### 4. Daily budget gates

This is the one you actually care about. Three caps, settable from the admin panel:

- `daily_note_limit` — every `runStep` (which means every cron-written note, manual run, mission step, and synthesis) checks this first.
- `daily_ask_limit` — every `ask()` checks this first.
- `daily_mission_limit` — every `startExploration` checks this first.

When the count for the current UTC day equals the limit, the relevant function throws `BudgetExceeded`. The fetch handler catches that and returns HTTP 429 with a JSON message naming the kind, the limit, and the used count. The admin UI's ask/explore forms detect 429 and show a friendly message instead of crashing.

Counts live in the `daily_usage` table, keyed by `YYYY-MM-DD` UTC. There's no scheduled "reset" — when the day rolls over, the row for the new day starts at zero automatically.

Setting a limit to `0` disables that gate entirely. Setting it absurdly high (like 999999) is silently clamped at 10000 server-side, so a typo can't blow the budget.

---

## Chapter 11 — Making it yours

Things you can do without writing a line of new code:

- **Change the personality**: edit `CONTRACT` in `agent.ts` and redeploy. The voice changes immediately.
- **Change the cadence**: set frequency from 1 hour to 24 hours in the admin panel.
- **Change the strategy**: from the admin panel, switch between mixed / random / bridge / gap.
- **Send specific missions**: type the brief in the admin panel.

Things that require small code changes:

- **Add a source**: write a new fetcher in `apis.ts` (modelled on `randomWikipedia` or `randomCountry`), then add it as a new branch in `pickTopic`.
- **Change the model**: swap `CHAT_MODEL` for any other Workers AI chat model. If you swap the embedding model, you also have to recreate the Vectorize index with the new dimension.
- **Change the note shape**: the markdown the agent writes is just whatever the LLM returns. Edit the `userPrompt` template in `writeNote()`.

Things that need a bit more rewiring:

- **Multilingual notes**: the contract assumes English. Edit it to ask for notes in another language *and* swap the embedding model for a multilingual one (e.g. `@cf/baai/bge-m3`).
- **Image generation**: Workers AI has image models (`@cf/stabilityai/stable-diffusion-xl-*`). Add a step in `runStep` to generate a cover image, save the bytes to R2 alongside the markdown, render it on the note page.
- **A different vector store**: nothing forces you to use Vectorize — you could swap in Pinecone, Qdrant, etc. The interface used is tiny: `query(vector, options)` and `upsert(items)`. The interesting question is what `env.MEMORY` becomes.

Things that are conceptually possible but require real work:

- **Self-critique**: after writing each note, ask the model to score it (specificity, novelty, connection density). Store the score. Use the top-scoring notes as few-shot examples in future prompts.
- **Tool use beyond fetching**: let the model decide what to fetch. Currently the agent's actions are fixed (fetch Wikipedia OR fetch a country profile). A tool-use agent would let the LLM call `search`, `geocode`, `weather` etc. on its own.
- **A real graph view**: the map shows connections geographically, but a dedicated *graph* view (nodes + edges, force-directed) would expose the actual memory structure better. Use Cytoscape.js or vis-network.

---

## Glossary

**Binding** — a handle, declared in `wrangler.toml`, that connects your Worker code to a Cloudflare resource (D1, R2, Vectorize, Workers AI, secret). Available as a property of `env`.

**Cron trigger** — a cron-syntax schedule that fires your Worker's `scheduled` handler periodically.

**CSP (Content-Security-Policy)** — an HTTP header that tells the browser which origins your page is allowed to load scripts/styles/images from. The browser refuses anything else.

**D1** — Cloudflare's serverless SQL database. SQLite under the hood, replicated globally.

**Embedding** — a list of numbers (a vector) that represents a piece of text as a point in some high-dimensional space. Similar texts → nearby vectors.

**fetch handler** — the function a Worker exports to handle incoming HTTP requests.

**Frequency** — in this project, how many hours pass between autonomous notes. The cron fires hourly, but only writes if the frequency timer has elapsed.

**KV** — Cloudflare's eventually-consistent string-to-string key-value store. Not used here.

**LLM** — Large Language Model. The kind of model that generates text given a prompt (Llama 3.3, GPT-4, Claude, etc.). Distinct from an embedding model.

**Neuron** — Cloudflare's unit of Workers AI billing. Roughly proportional to model size × tokens generated.

**R2** — Cloudflare's S3-compatible object storage. Blobs by key.

**RAG** — Retrieval-Augmented Generation. The pattern: retrieve relevant docs, paste them into the prompt, generate.

**Scheduled handler** — the function a Worker exports to be called on a cron schedule, distinct from `fetch`.

**Vector / vector space** — geometric metaphor for representing text as points so similarity can be measured by distance.

**Vectorize** — Cloudflare's serverless vector database. Stores embeddings, returns nearest neighbours.

**`waitUntil`** — a method on `ctx` that lets your handler hand a promise back to the runtime, so the Worker can keep doing work after the response has been sent.

**Worker** — a single TypeScript/JavaScript program that exports a `fetch` (and optionally `scheduled`) handler, deployed to Cloudflare.

**wrangler** — the CLI you use to develop, configure, and deploy Workers.

---

*That's the book. The code's in [src/](src/) — go read it.*
