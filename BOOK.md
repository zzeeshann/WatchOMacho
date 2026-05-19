# WatchOMacho — the book

A guided tour of the project. Written for someone who has not seen the code, may not know Cloudflare, and wants to understand both *what the agent does* and *why every part of the stack exists*.

The text moves from very general (*what is a serverless agent?*) to very specific (*how does the planner decide which Tavily queries to run?*). You don't need prior experience with Cloudflare, agents, or RAG. JavaScript familiarity helps but isn't required.

---

## Foreword — what this is, and what it isn't

WatchOMacho is a **research agent you give jobs to**.

You hand it a *thing to research* — a postcode, a person, a country, a company, an abstract topic. You also give it a *way of researching* — a markdown procedure document called a **skill**. The agent applies the skill to the target, performs web research, and writes a markdown **report** that lives on the target's public page. On the cadence you set, it comes back and writes another report, building up that page over time.

That sentence — *"a research agent you give jobs to"* — is the entire product. Everything in this codebase exists to serve it.

What WatchOMacho is **not**:

- *Not a chatbot.* It doesn't reply to messages. You define the task; it executes autonomously and writes to a page.
- *Not a passive feed-watcher.* It does not monitor news firehoses or wait for events. It is *target-driven*: you set the agenda.
- *Not a one-shot research tool.* Each target accumulates reports over time. The thirtieth report on a target is informed by the first twenty-nine via vector recall.
- *Not a perfect substitute for a search engine.* It synthesises extracted web content into a structured markdown report with citations. Quality reflects the source material and the model.

The rest of the book unpacks how this is built. We start with the cloud platform underneath everything, then climb up to the agent's brain.

---

## Chapter 1 — Why Cloudflare?

For most of the web's history, running a website meant renting a server: a physical computer in a rack, billed 24/7 whether anyone visited or not. You patched its OS, monitored its CPU, restarted it when it crashed, and prayed when your single machine in one city went down.

**Serverless** rejects all of that. You upload your *function* — a small program that says *"when an HTTP request arrives, do this"* — and the cloud provider handles the rest: running it, scaling it, placing copies of it close to whoever is calling. You pay only for the milliseconds and memory your function actually uses. When nobody's visiting, you pay nothing.

The trade-off: your function has to start fast, finish fast, and not assume anything sticks around between invocations.

**Cloudflare** is one of the giants in this space. They run an enormous network of data centres in over 300 cities — primarily as a CDN, then they realised they could run your code on the same network. The product is **Cloudflare Workers**. Today they offer compute (Workers), storage (D1, R2, KV, Vectorize), AI inference (Workers AI), and scheduling (Cron Triggers) — all bound together on the same edge network.

For WatchOMacho this is ideal:
- **One vendor, one CLI, one dashboard, one bill** for compute + storage + AI.
- **Generous free tier**: tens of thousands of free requests per day, free Workers AI neurons, 5 GB of D1, 10 GB of R2, 30 million queried Vectorize dimensions per month.
- **Single-region or global doesn't matter** — the same Worker code runs in every data centre automatically.
- **A polished CLI (`wrangler`)** that handles deploys, secrets, database creation, schema migrations.

The £0 monthly cost at hobby scale is what makes this project sustainable as a personal toy. Once usage grows, Workers Paid ($5/mo) lifts every cap by orders of magnitude.

---

## Chapter 2 — What is a Worker?

A Cloudflare Worker is a self-contained JavaScript/TypeScript program that exports a `fetch` handler:

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello world");
  }
};
```

Three things to notice:

1. **`request`** is a standard Web `Request` object — the same one you'd get with `fetch()` in a browser. No Node.js, no Express. The Web Platform is the platform.
2. **`env`** is your bindings: handles to your databases, buckets, vector index, AI models, secrets. Every Cloudflare resource you allocate gets bound into this object. Talking to D1 isn't HTTP — it's `env.DB.prepare("SELECT …")`. Talking to an LLM isn't HTTP — it's `env.AI.run("…")`. The handles are typed and in-process.
3. **`ctx.waitUntil(promise)`** lets your handler keep working *after* the response has been sent. The user gets their reply instantly; meanwhile the Worker continues writing to the database, calling APIs, embedding text. This is essential for agents that have to do slow work without making the caller wait.

A Worker can also export `scheduled` for cron triggers:

```ts
async scheduled(event, env, ctx) {
  ctx.waitUntil(doWork(env));
}
```

That handler runs on a cron schedule you define in `wrangler.toml`. WatchOMacho's cron fires every hour and walks through any targets due for an update.

**Limits to know:**
- Free plan: ~10 ms CPU per request (extended via `waitUntil`).
- Workers Paid: 30 s CPU per request.
- No filesystem. No long-lived in-memory state. Anything that persists goes into a binding.

The whole of [src/index.ts](src/index.ts) is one Worker — the `fetch` handler routes incoming HTTP requests; the `scheduled` handler runs on the cron tick.

---

## Chapter 3 — The four storage primitives

A Worker on its own forgets everything between invocations. Cloudflare provides a small zoo of storage products; each is good at exactly one thing.

### D1 — SQL for serverless

**Mental model:** managed, replicated SQLite. You write standard SQL, you bind to a database in `wrangler.toml`, you call `env.DB.prepare("...").bind(...).all()` from your Worker.

**Good for:** structured, relational data with rows, columns, and indexes. Anything you'd say "I want to query this" about.

WatchOMacho uses D1 for eight tables — [schema.sql](schema.sql) is short and worth reading top to bottom:

| Table | Purpose |
| --- | --- |
| `targets` | Things being researched. One row per HA0 4GP / Bhutan / "AI agents". |
| `skills` | Reusable research procedures. Each row holds a markdown procedure document. |
| `reports` | Every report the agent writes. Lives on the target's page. |
| `runs` | Audit log: every research attempt (cron / manual), success or failure. |
| `settings` | Live runtime config the admin can edit (budgets, cron cap, etc.). |
| `daily_usage` | Per-UTC-day counters for the budget gates. |
| `login_attempts` | IP + timestamp + success-bit, for the login throttle. |

Why SQL for all this? Because the dashboard needs "all reports for this target, sorted by date" and "which target is due to run next" — and SQL is what you reach for. The agent itself rarely needs joins, but the humans looking at it do.

### R2 — object storage

**Mental model:** S3 (Amazon's object store), cheaper, with no egress fees. You `put` a blob at a key like `reports/foo.md`; you `get` it back later.

**Good for:** large blobs you don't want to query, just store and retrieve whole.

WatchOMacho uses R2 for **the full markdown of every report**. A short snippet (~240 chars) lives in D1 for quick listing; the full ~500-word body lives in R2 at `reports/<timestamp>-<id>.md`. When you load a report page, the Worker fetches the row from D1 (for metadata), then fetches the body from R2.

The split exists because D1 is great at *querying* but not at *storing long strings* — you don't want to put kilobytes of text into every D1 row.

### Vectorize — semantic memory

**Mental model:** a database that doesn't index by exact strings — it indexes by *meaning*. You give it a list of 768 numbers (a "vector embedding") representing a piece of text, and later you can ask *"what's similar to this other vector?"* and get the closest matches back.

WatchOMacho uses Vectorize so the agent can **remember everything it has ever written**, and pull the most relevant past reports when working on a new one.

Each time the agent writes a report:
1. We embed `title + body` into 768 numbers using `bge-base-en-v1.5`.
2. Store the vector with metadata `{target_id, target_name, target_slug, skill_slug, title, snippet, created_at}`.

When the agent writes a *new* report on the same target, it queries Vectorize with the new task's text and gets back the 4 most similar past reports. Those are passed to the LLM as context with the instruction *"do not repeat — build on these, surface what's changed."*

This is the entire memory mechanism. It's called **RAG** in the trade: Retrieval-Augmented Generation.

### KV — key/value (not used)

KV is Cloudflare's globally-replicated string-to-string dictionary. Good for caches and session stores. WatchOMacho doesn't use it because D1's `settings` table plays the same role and gives us joined queries when we want them. Worth knowing it exists.

---

## Chapter 4 — Workers AI: the brain

Cloudflare runs LLMs and embedding models on its own GPUs and exposes them as a binding. Your Worker calls `env.AI.run(modelName, input)` and gets the response back — no API keys, no rate-limit dance, no separate service.

WatchOMacho uses two models:

### Chat model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`

Meta's Llama 3.3 70-billion-parameter instruction-tuned model, quantised to FP8 for speed. This is the part of the agent that *writes things*: research plans, report bodies, skill procedures.

You give it two kinds of messages:
- A **system** message that sets its personality and rules.
- One or more **user** messages with the actual prompt.

`env.AI.run(CHAT_MODEL, { messages: [...], max_tokens: 1200 })` returns the generated text.

If your account doesn't have access to 70B or you want lower cost, swap to `@cf/meta/llama-3.1-8b-instruct-fast` — same API, smaller model, faster, and a more generous free-tier quota. Quality dips meaningfully but is still acceptable for a hobby agent.

### Embedding model: `@cf/baai/bge-base-en-v1.5`

Different shape of model. You don't ask it to write — you ask it to *describe* text as a list of 768 numbers. Texts about similar topics produce similar vectors; unrelated texts produce dissimilar ones.

WatchOMacho uses embeddings for two things:
1. **Storing memory:** every report is embedded and put into Vectorize.
2. **Recall:** when writing a new report, we embed the *task description* (target + skill), query Vectorize for similar past reports, and pass them into the LLM as context.

The number 768 is an artefact of how `bge-base-en-v1.5` was trained. If you change the embedding model you must recreate the Vectorize index with the matching dimension.

---

## Chapter 5 — Tavily: the agent's eyes

Cloudflare doesn't have a Google-style web search product. So we use [Tavily](https://tavily.com) — a search API built specifically for AI agents. Crucially, it returns *extracted full-page content* alongside each result, not just a 150-character snippet, so the writer LLM has real material to synthesise from.

Tavily's **Researcher (Free)** plan gives 1000 credits/month with no credit card. We set the API key as a Worker secret (`TAVILY_API_KEY`) and call it from [src/apis.ts](src/apis.ts).

One tool, two operations:

- **`/search`** — keyword search. Returns top N results, each with `title`, `url`, and the page's `raw_content` already extracted and cleaned. Optional knobs: `topic` (`general` / `news` / `finance`), `time_range` (`day` / `week` / `month` / `year`), `search_depth` (`basic` = 1 credit, `advanced` = 2). Default is basic.
- **`/extract`** — read a list of specific URLs in full. Useful for RSS feeds or curated source lists. 1 credit per 5 URLs.

We dedupe by URL, keep up to 20 results across all queries in a run, cap each page's content at 4000 chars, and feed them to the LLM as numbered citations. The LLM cites them as `[1]`, `[2]`, etc. in the body.

**Tavily is the agent's general-purpose eyes.** One HTTP call per planned query (search mode) or one per batch of up to 20 URLs (extract mode). For most research targets this is enough — Tavily can find anything addressable from the open web.

> **Sidebar: typed UK tools (post-Level-3 addition, 2026-05-17).** Tavily isn't the *only* outside-world tool any more. Four UK public-data tools sit alongside it: HM Land Registry sold prices (postcode → property transactions), ONS / postcodes.io (postcode → administrative geography), data.police.uk (postcode → crime stats), and Companies House (name or postcode → companies). They're free, mostly keyless, and each returns structured rows that we flatten to a markdown table for the writer LLM. A skill declares which it wants via headers (`**Land Registry op:** sold-prices` etc.) and `gatherSources` dispatches over the list. See Chapter 9 for the full tool catalog.

---

## Chapter 6 — What is an agent?

A **chatbot** is reactive. You type, it responds. Stateless or near-stateless. No goals beyond replying.

An **agent** has at least some of:
- **Autonomy** — acts on its own schedule.
- **Persistence** — memory survives across runs.
- **Tool-using** — calls external APIs to do work.
- **Goal-directed** — pursues an objective over multiple steps.

WatchOMacho is all four. The cron makes it autonomous. The D1+R2+Vectorize stack gives it persistence. Tavily is the tool it uses. And every research run is a multi-step plan-search-recall-write loop.

The shape of one research run looks like this:

```
        ┌───────────────┐
        │      Plan     │  ← LLM call: "given this skill and target, what to search for?"
        └──────┬────────┘     (skipped in extract mode — sources are explicit)
               │
        ┌──────▼────────┐
        │    Gather     │  ← Tavily: N parallel /search calls (each result already
        └──────┬────────┘     includes extracted full-page content), or one /extract
               │              call against an explicit URL list
        ┌──────▼────────┐
        │    Recall     │  ← Vectorize: 4 most similar past reports + same-target history
        └──────┬────────┘
               │
        ┌──────▼────────┐
        │     Write     │  ← LLM call: produce a markdown report citing sources
        └──────┬────────┘
               │
        ┌──────▼────────┐
        │    Persist    │  ← R2 (markdown body) + D1 (row) + Vectorize (new embedding) + runs log
        └───────────────┘
```

Two LLM calls + N Tavily calls per run. Predictable cost, predictable structure.

---

## Chapter 7 — The three concepts

This is the only chapter that matters for *using* the agent. The rest is plumbing.

### Target

A target is *the thing being researched*. Anything you can name: `HA0 4GP`, `Bhutan`, `Pacific volcanism`, `OpenAI`, `Elinor Ostrom`. Targets are persistent: once you add one, it has its own URL (`/target/<slug>`) and accumulates reports there forever.

Fields a target has:
- **Name** (display label) and **slug** (URL-safe).
- **Kind** (optional): postcode / place / topic / person / company / freeform. Helps the agent set context.
- **Description** (optional): a sentence explaining *why* you care, fed to the agent as extra context.
- **Status**: `active` / `paused` / `archived`. Only `active` targets are picked by the cron.
- **Cadence**: how often the cron should re-run the skill on this target (1 h / 6 h / 12 h / 24 h / 3 days / weekly).
- **Primary skill**: which skill the cron applies. (V4 attaches one skill per target.)
- **Last and next run timestamps**: cron uses `next_run_at <= now` to decide what's due.

Targets live in the [`targets`](schema.sql) table.

### Skill

A skill is *a reusable research procedure*. Concretely, a markdown document that tells the agent how to approach a kind of research question. Examples a user might write:

- **Public-health topic research** — surface stats, leading orgs, recent news, evidence-based interventions, controversies, demographics.
- **UK postcode housing research** — current market prices, planning permissions, demographics, crime, transport.
- **Company brief** — leadership, recent news, products, financial signals, controversies.
- **Person profile** — biography, recent public statements, work, controversies.

Skills are reusable. One *postcode housing research* skill can be applied to twenty different postcodes. Each application produces a fresh report; the skill itself stays unchanged.

Skills have two authors:
- **user-written**: you paste the procedure markdown yourself.
- **agent-synthesised**: you provide a one-line brief and the LLM writes the procedure document for you. Useful when you know what you want but don't want to draft the structure.

Skills live in the [`skills`](schema.sql) table. The procedure markdown is the single source of truth — when the agent runs, it reads `procedure_md` as part of the system prompt.

The cron and the admin "Run now" button both call the same `runResearch(target, skill, triggeredBy)` function in [src/agent.ts](src/agent.ts). The only difference is what set the run in motion.

---

## Chapter 8 — A worked example

Imagine you want to keep an eye on men's mental health globally. Here's the actual flow.

**Step 1: Create a skill.** You open `/admin/skills` and use *Synthesise a skill*:

> Research a public-health topic. Surface current statistics, leading organisations, recent news (last 12 months), evidence-based interventions, controversies, demographics affected. Lean on WHO, NHS, CDC, gov.uk, peer-reviewed studies. Avoid commercial wellness sites.

The LLM writes a `procedure_md` like:

```markdown
# Public-health topic research

**Purpose:** Produce a current-state report on a public-health topic, anchored in evidence.

**When to use:** Topics about diseases, conditions, social-health phenomena, or population health interventions.

**Approach:** Lean on official health bodies (WHO, NHS, CDC), gov.uk for UK context, and peer-reviewed research. Avoid commercial sites and supplement vendors.

**Search queries:**
- {target} statistics 2026
- {target} WHO OR NHS guidelines
- {target} peer reviewed research 2025 2026
- {target} latest news
- {target} interventions evidence

**Output structure:**
- # {target} — what we know now
- Current data
- Recent developments
- What works (evidence-based interventions)
- What's contested
- Sources
```

This document is now in the `skills` table, with a public page at `/skill/public-health-topic-research`.

**Step 2: Create a target.** You open `/admin`, fill in *Add a target*:

| Field | Value |
| --- | --- |
| Name | `Men's mental health` |
| Kind | `topic` |
| Description | `Patterns, causes, evidence-based interventions, and current data on mental-health outcomes specifically in men.` |
| Cadence | every 24 hours |
| Skill to apply | the one you just made |
| Run once immediately | ✓ |

Submit. You land on `/admin/targets/mens-mental-health`. In the background:

**Step 3: First run.** The agent calls `runResearch(target, skill, 'manual')`:

1. **Plan** (LLM call). Returns a JSON object: `{ "queries": ["men's mental health statistics 2026", "men's mental health WHO guidelines", ...] }`.
2. **Gather** (Tavily `/search`, 5 parallel queries). Returns ~20 deduped results — each one a link to a WHO / NHS / peer-reviewed / news page, plus the extracted text of that page.
3. **Recall** (Vectorize). No prior reports for this target. Picks up no related context (empty Vectorize). Skip.
4. **Write** (LLM call). Given skill + target + extracted content from 20 sources, writes a 500-word markdown report citing `[1]`-`[20]`.
5. **Persist.** Markdown goes to R2. Row goes to `reports`. Embedding goes to Vectorize. Audit row goes to `runs`. Target's `last_run_at` and `next_run_at` updated.

You reload `/target/mens-mental-health`. The first report is there with cited sources.

**Step 4: Tomorrow (cron tick).** Around the same time the next day, the cron fires. The handler:
1. Selects active targets where `next_run_at <= now`. Finds yours.
2. Runs `runResearch(target, skill, 'cron')`.
3. This time, *Recall* surfaces yesterday's report. The LLM is instructed *"do not repeat — build on this, surface what's changed."*
4. New report appears at the top of the target's page.

The target accumulates reports over time. After a month you have ~30 reports tracing how the field moved.

---

## Chapter 9 — The codebase, file by file

Four source files, all in [src/](src/).

### `src/apis.ts` — external sources (~540 lines)

The agent's outside-world layer. Five tool integrations plus a generalised `TOOLS` registry:

- **`tavilySearch(apiKey, query, options)`** — single web search via Tavily's `/search`. Each result already includes the page's extracted full content. Optional `topic` / `time_range` / `search_depth` / `max_results`. Gracefully no-ops if the API key isn't configured.
- **`tavilyExtract(apiKey, urls, depth)`** — read a list of specific URLs in full via Tavily's `/extract`. Up to 20 URLs per call. Used by skills that declare `**Tavily op:** extract`.
- **`landRegSoldPrices(postcode, { months, limit })`** — query HM Land Registry's open-data SPARQL endpoint for sold-price transactions in a postcode. Free, keyless. Returns rows with date, address, type, price.
- **`onsContext(postcode)`** — postcodes.io lookup (built on ONS classifications). Returns country, region, council, ward, parliamentary constituency, LSOA, MSOA, parish for a UK postcode. Free, keyless.
- **`policeCrimes(postcode, { months })`** — data.police.uk street-level crime around a postcode, aggregated by category. Free, keyless. England/Wales/NI only.
- **`companiesHouseSearch(apiKey, query, { limit, postcode })`** — search Companies House by name; if `postcode` is set, post-filter to matching registered offices. Requires the free `CH_API_KEY`.
- **`TOOLS`** — `Record<slug, ToolEntry>`. Each entry has a `summary`, an `operations` map (per-op `description` + `when_to_use`), and a `headers` list documenting the skill-markdown headers the tool reads. `synthesizeSkill` renders this catalog into its system prompt; `/admin/tools` renders it as a read-only page. Code + metadata live together so they can't drift apart.

Every function returns `[]` (or `null`) instead of throwing — a tool that fails is just a missing source row, not a broken run.

### `src/agent.ts` — the brain (~1280 lines)

Where every business decision lives. Seven sections:

1. **Basics + budgets + settings.** `uid()`, `slugify()`, the `BudgetExceeded` error, daily usage tracking, settings get/set.
2. **Chat dispatcher.** `runChat(env, model, input)` routes by model-id prefix: `@cf/...` → `env.AI.run` (Workers AI); `anthropic/...` → POST to `https://gateway.ai.cloudflare.com/.../anthropic/v1/messages` via AI Gateway. The three chat call sites (`synthesizeSkill`, `planResearch`, `writeReport`) all go through this — embeddings stay on `env.AI.run` directly. Two auth modes for Anthropic: `cf-aig-authorization: Bearer {CF_AIG_TOKEN}` (Unified Billing — Cloudflare pays Anthropic) or `x-api-key: {ANTHROPIC_API_KEY}` (BYOK).
3. **Targets.** `createTarget`, `getTargetBySlug`, `listTargets`, `updateTarget`, `deleteTarget`. CRUD plus a unique-slug helper that handles collisions.
4. **Skills.** `createSkillFromMarkdown` (user-written), `synthesizeSkill` (LLM writes the procedure, using `buildSkillTemplate()` to render the TOOLS catalog dynamically), `listSkills`, `updateSkill`, `deleteSkill`. The skill schema is *the procedure_md is the source of truth* — when running, we pass it as the system prompt's "skill" section.
5. **Reports.** `listReportsForTarget`, `getReportById`. (No `createReport` — reports are only created by `runResearch`.)
6. **The research loop.** Functions chained inside `runResearch`:
   - `parseSkillTools(procedure_md)` → `SkillToolCall[]`. Scans for every registered tool's op header (e.g. `**Tavily op:**`, `**Land Registry op:**`) and builds a list of tool calls with per-tool params. Defaults to one Tavily search if no tool is declared.
   - `planResearch(skill, target)` → JSON list of queries (only called if at least one tool call is Tavily search)
   - `gatherSources(queries, target, calls)` → dispatches over `calls`. `gatherTavily` runs `/search` (dropping results below 0.4 relevance score) or `/extract`; `gatherLandRegistry`, `gatherOns`, `gatherPolice`, `gatherCompaniesHouse` call their typed function and flatten the structured result to a markdown table or labelled block. Output is one uniform `GatheredSource[]` regardless of tool.
   - `recallMemory(target, skill)` → past reports for this target + related from elsewhere
   - `writeReport(...)` → the report markdown. System prompt requires `## Section name` markdown for headings and explicitly forbids writing a Sources section (the page renders the canonical one from `sources_json`).
   - Pre-flight `checkBudget` + `getChatModel` are inside the `try/catch` so any failure (including budget exhaustion or auth errors) gets logged to the `runs` table with `status='error'` and the exception message.
7. **Cron.** `cronTick` walks due targets and runs each via `runResearch`.

### `src/index.ts` — routes (~400 lines)

Pure routing. The Worker receives a `Request`, looks at method + path, and dispatches to either:
- A `render*` function from `dashboard.ts` for HTML pages, or
- An agent function from `agent.ts` for actions / API JSON.

Notable bits:
- **`isAdmin(req)`** — reads the `watchomacho_admin` cookie, does a constant-time compare against `ADMIN_SECRET`. Used to gate every admin route.
- **`readForm(req)`** — accepts form-urlencoded, multipart, or JSON request bodies indiscriminately. Keeps the admin UI simple.
- **`SECURITY_HEADERS`** — appended to every response. Strict CSP, no external scripts beyond Google Fonts, no inline frames.
- **The login throttle** — 10 failed attempts per IP per rolling 10 minutes → 429.
- **`scheduled`** at the bottom — the cron handler. Simply calls `cronTick(env)` inside `waitUntil`.

### `src/dashboard.ts` — HTML rendering (~900 lines)

Server-rendered HTML. No client framework. Every page is a string returned to the browser.

Sections:
- **Design tokens** — the Daylila colour palette, font setup, base CSS. All inlined per response.
- **Utilities** — `escapeHtml`, `formatDate`, `timeAgo`, `timeUntil`, and a hand-rolled safe markdown renderer (no raw HTML, no images, no script).
- **Page shell** — `shell(title, body)` wraps each page with header / nav / footer.
- **Public pages** — `renderHome`, `renderTargetPage`, `renderSkillPage`, `renderReportPage`.
- **Admin pages** — `renderAdminLogin`, `renderAdminPanel`, `renderAdminSkills`, `renderAdminTargetEdit`, `renderAdminTools`.

The CSS deliberately matches [daylila.com](https://daylila.com) — DM Sans, warm off-white paper (`#FAF8F4`), forest-teal primary (`#1A6B62`), restrained editorial layout, single 768px column.

---

## Chapter 10 — Security model

Five layers, all small, all important.

### 1. Admin cookie

The admin panel is gated by a single secret stored as a Worker secret (`ADMIN_SECRET`). On successful login the secret is written into an `HttpOnly; Secure; SameSite=Strict` cookie. Every admin route calls `isAdmin(req)` which reads the cookie and compares against `env.ADMIN_SECRET` in constant time (XOR-fold).

`SameSite=Strict` means the cookie is never sent on cross-site requests — CSRF is structurally impossible.

### 2. Login throttle

If an IP makes 10 failed login attempts in 10 minutes, the endpoint returns 429 *without even checking the secret*. Kills credential-stuffing and typo storms.

### 3. Secret comparison

`timingSafeEqual()` compares cookies and submitted secrets character-by-character without short-circuiting on the first difference. Defeats timing-based extraction.

### 4. Content security policy

Every response carries strict headers:
```
content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
```

No external scripts beyond Google Fonts. No inline images from untrusted sources. No frames.

### 5. Safe markdown rendering

The agent writes markdown reports. The reports are user-visible HTML. If the markdown renderer allowed raw `<script>` tags, a hostile prompt could potentially produce a stored XSS.

The renderer in `dashboard.ts` is a hand-rolled subset: only headings, paragraphs, lists, bold/italic, inline code, and links. No raw HTML pass-through. Links are filtered — only `http(s)://` and relative paths are allowed; anything else (`javascript:`, `data:`, etc.) becomes `#`. All other characters are HTML-escaped before substitution.

### 6. SQL safety

Every D1 query uses `prepare("...").bind(...)`. No string concatenation into SQL. Even agent-written content (titles, skill names, report bodies) goes through bind parameters.

---

## Chapter 11 — Cost, budgets, and the gates

### Workers AI neurons

Cloudflare bills AI inference in "neurons" — a normalised compute unit so every model can be billed the same way. Rough costs:

| Operation | Neurons each |
| --- | --- |
| 1 chat call to Llama 3.3 70B (~3k in, 500 out) | 200–500 |
| 1 chat call to Llama 3.1 8B | 50–150 |
| 1 embedding (bge-base-en-v1.5) | 1–3 |

A typical research run = 2 chat calls + 1 embedding ≈ **~500–1000 neurons**.

### Daily quotas

Free plan: **10,000 neurons/day**, account-wide, resets at 00:00 UTC. That's ~10–20 reports/day depending on model. Larger models also have per-model caps stricter than the headline 10k.

Workers Paid ($5/mo): **10 million neurons/month** included → ~20,000 reports/month. Effectively unlimited for personal use.

### Tavily

Researcher (Free) plan: **1000 credits/month**. A basic search = 1 credit; an advanced search = 2; extract is 1 credit per 5 URLs. At ~5 basic searches per report, ~6 reports/day before the limit. Above that, Tavily's paid tiers start at low single digits per month.

### App-level budget gates

In addition to Cloudflare's caps, the app has its own per-day caps in the `settings` table:

| Setting | Default | What it caps |
| --- | --- | --- |
| `daily_report_limit` | 20 | New reports written per UTC day |
| `daily_search_limit` | 500 | Tavily credits consumed per UTC day |
| `cron_max_per_tick` | 2 | How many targets the cron advances per hourly tick |

When a cap is hit, the next call throws `BudgetExceeded`. The HTTP layer translates that to a 429 response with a friendly JSON message; the cron skips its remaining work and waits for the next tick.

These are the project's *own* safety rails. Set them low and raise deliberately.

---

## Chapter 12 — Making it yours

### The agent's voice

`writeReport()` in [src/agent.ts](src/agent.ts) sets the system prompt for the report writer. Defaults to a restrained editorial tone — no hype, no clichés, sentence-case headings, cite sources by number. Change it freely; the change picks up on the next run.

### The chat model

```ts
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";   // bigger / better
const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";        // smaller / cheaper
```

One constant in `agent.ts`. Swap, redeploy, done.

### Cron cadence

The cron schedule in `wrangler.toml` defines the *rate at which the Worker wakes up*. The per-target cadence in the `targets` table decides *which targets get updated on each wake-up*. Default Worker schedule is hourly:

```toml
[triggers]
crons = ["0 * * * *"]
```

If you want it less frequent, change to `0 */6 * * *` (every 6 hours), etc. Per-target you can pick weekly cadence for slow topics, hourly for fast-moving ones.

### Adding a new tool

The simplest extension: a new function in `apis.ts` that returns a typed result, and a way to plumb it into `runResearch`. For example, "lookup Land Registry sold prices for a UK postcode":
1. Add `landRegistry(postcode): Promise<...>` in `apis.ts`.
2. Optionally call it inside `runResearch` when `target.kind === 'postcode'` and inject the result into the `userMsg` block before `writeReport`.

The skill's procedure_md can also reference your tool by name; the model will mention it in its plan even if it can't directly call it. That's a UX detail to tune.

### A new domain

The agent is generic — any kind of research, any kind of target. If you want to bias the system toward a domain (housing, biology, finance), express it in the *skill*, not the code. Skills are the user-editable surface area on purpose.

---

## Chapter 13 — What's deliberately out of scope

Things considered and rejected (or deferred):

- **Tool-calling loop with model function calls.** Cleaner but more failure modes. Current "LLM plans queries → we execute → LLM writes" is simpler and predictable.
- **Multiple skills per target.** Schema supports a `primary_skill_id` only. Combining a "housing" run and a "transport" run is two targets, not one target with two skills. Reduces ambiguity.
- **Skill versioning.** Edit a skill → you've edited it. No history. (PR-worthy if anyone wants it.)
- **Self-improving Curator.** A periodic process that re-grades old reports and rewrites underperforming skills. Conceptually right, deferred until usage justifies it.
- **Authentication beyond a single admin secret.** Multi-user isn't the point — this is a personal tool. If you want shared use, an OAuth provider in front of the admin routes is the right move.
- **Per-source adapters (Land Registry, ONS, NOAA, USGS).** Easy to add (one function in `apis.ts` + reference in a skill). Not added by default because the agent has no idea what they mean — they need to be wired with intent.

---

## Chapter 14 — Where to look next

- **Quick start** — [README.md](README.md). 10-minute setup.
- **Architecture reference** — [ARCHITECTURE.md](ARCHITECTURE.md). Schema, data flow, API surface as quick-lookup tables.
- **The code itself** — [src/](src/). Four files, ~2000 lines total. Worth reading top to bottom.

---

That's the book. The shortest way to understand this project is to add a target, attach a skill, and watch a report appear. The shortest way to make it yours is to write the skill *you'd* use and apply it to *your* targets.

---

## Chapter 15 — Making the agent intelligent (memory)

Up to this point, every report was an island. The agent searched the web, wrote a report, persisted it, and forgot. Tomorrow's report on the same target had no memory of yesterday's coverage.

The fix was a two-step recall loop:

1. **Each report, when written, gets embedded** into a 768-number vector (Cloudflare Workers AI's `@cf/baai/bge-base-en-v1.5`) and upserted into a Vectorize index. Free, runs in milliseconds, one row per report.
2. **Each new report, before writing, queries Vectorize** for the most similar past reports, layered with the most recent same-target ones (via D1 for guaranteed chronological continuity).

What the writer prompt then sees: alongside today's fresh web sources, a numbered list of prior reports — each marked as a "PRIOR REPORT", each citeable as `[N]` like any other source. The system prompt explicitly says *"build on them, surface what's changed, don't repeat verbatim"*.

The footer renders all citations side by side. Web entries open externally; archive (📚) entries link to `/report/:id` internally. Click the superscript `[4]` in a body paragraph and you land on the prior report it builds on. The archive becomes a *graph*, not a stream.

Side benefit none of us predicted: when you delete a report, the cascade now has *three* artefacts to clean (R2 blob, D1 row, Vectorize entry, runs row). That forced us to build proper cleanup machinery — silent failures replaced with logged ones, self-healing R2 sweep, hourly cron sweep, live orphan count in the admin. Memory and good housekeeping turned out to be the same project.

---

## Chapter 16 — Making the agent visible (observability)

The previous chapter made the agent smarter. This one made it *legible*.

The problem we hit: a manual "Run now" click could disappear into the worker and leave zero trace. No row in the runs table, no error in the log, no signal at all. We learned this the hard way — clicked "Run now", got nothing, had to reverse-engineer our own admin pages to figure out *something happened but where did it go?*

The fix is a single setting row, `last_run_attempt`, written at the start of `runResearch` and updated at every step boundary:

```
init → plan → gather → recall → write → persist → done
```

Every Run now click writes this row before doing anything else. The worker dies mid-flight? The row still exists, frozen at whatever step it reached. The error path tags `runs.error` with the failing step (`gather: Tavily timeout`, `write: 5021: exceeded context window`). The Activity row badge becomes `failed @ gather` instead of an opaque red blob.

Then we extended the row with a `gather_stats` object — six counters tracking the candidate flow through every Tavily filter:

```
Tavily 10q · 166 raw → 10 (score) → 10 (URL) → 10 (story) → 10 final
```

That single line, displayed in the Maintenance card on each admin load, answers: *"is the agent actually searching? are sources making it through? where is the funnel choking?"* — without ever opening a log file.

The principle here is older than agents: **you can't operate what you can't see**. A pipeline with five stages and no inter-stage observability is a black box that occasionally produces output. Once we surfaced the funnel, every subsequent tuning question ("does lowering min_score help?") had an answer in real time — visible the moment we ran the next report.

---

## Chapter 17 — Making the sources good (gather tuning)

With memory in and observability live, the next question became obvious: *why are some reports thin?* The funnel told us. Tavily defaults are conservative (5 results per query), our planner was capped low (6 queries), and our score filter was strict (0.4). That meant 6 × 5 = 30 candidates max, ~10 surviving filter, a thin set reaching the writer.

Three changes, all visible in one funnel line:

- **Tavily `max_results: 5 → 20`** — its hard maximum. Same 1-credit cost per query (Tavily charges per request, not per result). 4× the candidate pool for $0.
- **Planner cap `6 → 10`** with a "exactly 10, always 10, never fewer" prompt — this exposed a quirk: Llama 3.3 70B (FP8-quantised on Workers AI) cheerfully ignores `"exactly N"` instructions and produces whatever feels right (sometimes 2). Haiku 4.5 follows it exactly. We did the A/B and switched the default chat model to Haiku.
- **Title-Jaccard dedupe**: same story from BBC + Reuters + AP used to eat 3 slots. Now they cluster (≥70% word overlap on normalised titles), the top 2 by Tavily score survive — preserves "where outlets disagree" cross-references without crowding diverse coverage out.

Then the third lever: stop forcing the report's *shape*. The original skill listed 7 fixed sections ("Wars and military", "Politics and policy", "Money and markets", …). Quiet news days produced "## Science and tech — Not enough source material yet." every single time. Cards filled with apology text.

The rewrite: tell the writer *the day's news decides the sections*. Group by what's shared. A quiet day might be 3 sections, a busy day 8. Always end with "Where outlets disagree" + "The story nobody's covering". Suddenly reports started leading with whatever the news actually was — Ukraine drone strike, Ebola declaration, India rupee — instead of repeating a template.

Both ends — search input AND output structure — became dynamic. The skill is now a *guidance document for the planner*, not a literal list of queries.

---

## Chapter 18 — Making the agent tunable (admin knobs)

The principle we settled on for surfacing knobs to admin: **one knob = one card position**.

Today there's one knob worth tuning by hand: `tavily_min_score`. So there's one admin field for it, in a card called "Search tuning". Stored in the existing `settings` table (no schema change). Read once per Tavily call. Validated 0–1 server-side. Default 0.4, the Tavily-documented bottom rail.

The card is *designed* to grow — if a third or fourth knob ever justifies admin exposure, the slot is there. But the discipline is "earn the UI" — most tuning is fine in code where it can't accidentally produce a state the user has to explain to themselves later.

Other things stayed code-side:
- Recall topK / similarity threshold / cap (set-and-forget guardrails)
- Title-Jaccard threshold + keep-per-cluster (algorithmic, not editorial)
- `MAX_CHARS_PER_SOURCE` (driven by model context window, not editorial choice)
- Planner cap (one number that should rarely change)

The line we drew: **editorial knobs in the skill markdown, system knobs in admin settings, algorithmic knobs in code**. Three layers, increasing surface area, decreasing editability — which exactly matches who should be allowed to change what.

---

That's the second half of the book — chapters 15–18 cover memory, observability, gather tuning, and admin knobs. Together with chapters 1–14 (the original v4 + Tavily + Level 3 typed tools narrative), it's the full picture of what WatchOMacho was.

---

## Chapter 19 — The door, not the room (the Durable Object rewrite)

A whole afternoon spent tuning knobs that didn't move the needle taught us a principle worth a chapter: **before tuning, find the wall.**

The symptom was simple. Clicking "Run now" on certain skills (Money & Finance, AI News — the slow ones) would silently die. No row in `runs`. No error in tail. Heartbeat frozen at `write` or `persist`. The report would never land. Same skill via the hourly cron worked fine.

The first diagnosis was wrong. Cloudflare's docs say Workers Free gives each invocation **10 ms of CPU**, and we assumed that was the constraint — string-encoding the writer prompt eats CPU, large prompts encode more, so the fix must be smaller prompts. Two admin knobs (`max_final_sources`, `max_chars_per_source`) shipped, and we started tuning. A few runs flipped from "stalled" to "succeeded". Looked like progress.

It wasn't. Lowering `max_final_sources` from 27 to 19 made one Money & Finance run succeed; lowering it to 15 didn't help another; lowering to 10 didn't help a third. The knob *correlated* with success but didn't *cause* it. Meanwhile cron-triggered runs of the exact same skill kept working — at **37 seconds**, well past the 30-second mark where manual runs were dying.

That asymmetry was the smoking gun. Cron and manual use different Cloudflare handlers:

- **Manual "Run now"** returns a redirect immediately, then runs the work inside `ctx.waitUntil(...)`. Per the docs: that gives you up to **30 seconds of wall-clock** after the response is sent. Same on Free and Paid. Same forever.
- **Cron** uses the `scheduled()` handler — up to **15 minutes wall-clock**. Same on Free.

The wall wasn't CPU. The wall was 30-second `waitUntil`. Anything that crossed it died with no exception — runtime termination isn't a throwable, the isolate is just gone mid-await. Every silent stall was Cloudflare killing the worker. The knobs that "fixed" some runs were just shaving a few seconds off, enough to squeak under the cliff on those specific clicks.

**This is the principle:** *if your pipeline takes 35 seconds and you're working inside a 30-second container, you don't need a faster pipeline. You need a bigger container.* Tuning to fit a 35s job into 29s is one bad day from the cliff. Moving the job out of `waitUntil` and into something with proper headroom solves it forever.

The right container is a **Durable Object alarm**.

```
TODAY:                          AFTER:
fetch handler                   fetch handler
  → ctx.waitUntil(                → DO stub.scheduleManualRun()
      runResearch(...)              (sets DO alarm for now+1s)
    )                             → return redirect
  → return redirect                                              
  (30s cap)                     DO alarm handler fires
                                  → runResearch(...)
                                  (15 minute cap)
                                  → DO hibernates when done
```

A Durable Object is a tiny stateful worker. Each instance is a single-threaded JavaScript context with its own SQLite, addressable by name (`idFromName("money-finance-briefing")`). Critically: a DO's `alarm()` callback runs in the scheduled-handler context — **15 minutes wall-clock**. That's 30× more headroom than `waitUntil`. And DOs are now on the Workers Free plan as long as you use the SQLite backend (the default for new DOs).

The implementation is ~80 lines: a `ResearchRunner` class extending `DurableObject`, a `scheduleManualRun(slug)` method that records the pending job and sets `setAlarm(now+1s)`, and an `alarm()` method that re-fetches target + skill (so it sees fresh values) and calls `runResearch()`. The route changes from `ctx.waitUntil(runResearch(...))` to `await stub.scheduleManualRun(slug)` and returns the redirect immediately. Cron stays where it is — it already has the 15-min budget.

Verification ran in one click. Money & Finance, the skill that had been failing all afternoon at exactly 30 seconds: **completed in 49 seconds**, status success, report landed. Then AI News with 100 sources × 4000 chars (a 400 KB writer payload): **39.5 seconds**, success. Skills the worker had been physically incapable of completing on the manual path now worked. No knob changed.

---

## Chapter 20 — Guardrails before you need them (the kill switch lesson)

The DO rewrite created a new failure mode by removing the old one. *We just gave the agent 15 minutes of wall-clock.* That's plenty of time for a hung Tavily call or a wedged Anthropic stream to burn through Workers Free's daily DO compute quota (13,000 GB-seconds — at 128 MB per DO, ~115 GB-seconds per stuck 15-minute run).

A second principle: **never raise a ceiling without putting a floor beneath it.**

So before declaring victory, we wired in four guardrails together — derived from the architect's sister project's "System Guardrails" pattern, written after a 7-hour DO incident that taught them *exactly* why this matters:

1. **`max_run_seconds` admin setting** — default 90s, range 5–600s. Below the 15-min hard cap but well above any successful run we've seen.
2. **AbortController plumbing** — a signal threads from `runResearch` → `gatherSources` → `tavilySearch` and `runResearch` → `writeReport` → `runAnthropicChat`, all the way to `fetch(..., { signal })`. When the timer fires, in-flight fetches throw `AbortError`. The existing catch records `"<step>: ..."` into the runs table — silent stalls become loud failures.
3. **Watchdog cron** — every hour, `cronTick` scans `last_run_attempt`. If it's still `in_flight` past `max_run_seconds + 30s grace`, the heartbeat is force-marked errored and a `runs` row is inserted. Catches the rare case where the DO alarm itself gets killed before its catch could fire.
4. **Workers Logs (`[observability]` in `wrangler.toml`)** — 7-day retention of console + errors in the Cloudflare dashboard. `wrangler tail` only shows live logs going forward, useless after the fact. Now any failure is replayable by run id.

We tested the abort by setting `max_run_seconds = 5` and clicking Run Now. The run aborted at exactly 5.6 seconds, wrote `write: max_run_seconds (5s) exceeded` to the runs table, updated the heartbeat to `outcome: error`. The mechanism was real, not theoretical.

The guardrails are *boring*. They don't add user-visible features. The 7-hour-DO incident in the architect's other project had been preventable by exactly this kind of plumbing — and yet it took an actual incident to motivate building it. Trusting their instinct to package guardrails *with* the new capability (not in a follow-up commit, not "we'll add it later") was the lesson. The cost of building them now is half a screen of code. The cost of not having them is one unattended runaway.

---

## Chapter 21 — Per-run visibility everywhere (the gather funnel column)

Adding the DO + guardrails left one rough edge. The Tavily funnel — `200 raw → 122 score → 111 url → 111 story → 100 final` — was only visible for the *most recent* run, because it was stored in `settings.last_run_attempt.gather_stats`. Open the next admin page after a fresh run and the previous funnel was gone.

The fix was a small schema migration (v9): add a `gather_stats_json TEXT` column to `runs`. Save the funnel snapshot into the column on every persist (success, error, watchdog-reaped). Render it on every Activity row and at the top of every report page using a shared `renderGatherFunnel()` helper.

Same data, three rendering sites — the Maintenance heartbeat (live), the Activity card per row (historical), and the report page header (single-report view). Now the funnel is *always* one click away regardless of how old the run is.

This is the third principle: **observability data, once captured, should be available everywhere it's relevant.** Capturing it for one panel and forgetting other panels existed was the smaller bug. The 20-minute migration is worth it: every retro question ("why did this report only have 12 sources when others have 60?") now has an answer on the report page itself.

---

## Chapter 22 — One last fix: stop capping what you cite

While reviewing the new per-report funnel rendering, an old bug surfaced: `reports.sources_json` had a `.slice(0, 20)` cap on persist. The writer was sent 100 sources, every `[N]` citation in the body assumed all 100 existed, but only [1]–[20] resolved to URLs in the footer. Citations [21]–[100] were dead links.

The cap dated from a time when `max_final_sources` was effectively always < 20. After raising it to 100, the cap on the persisted citation list never moved with it. The two ceilings had drifted out of sync.

Removed in one line. `sources_json` now stores everything the writer received — matching `max_final_sources`. The Activity meta line jumped from "20 web sources" to "100 web sources" and the report Sources footer suddenly contained all 100 links.

Fourth principle: **when two limits should be the same number, prefer one limit.** The double-cap (cap-100 on the writer, cap-20 on the store) was a footgun waiting for the day someone raised one and not the other. Now there's just one cap; whatever the writer sees, the footer stores.

---

That's chapters 19–22 — the architectural fix to the silent-stall problem (DO + Alarm), the guardrails that came with it (AbortController + watchdog + Workers Logs), the funnel-per-row migration, and the citation-cap cleanup. Together they took manual "Run Now" from "works for fast skills, dies silently for slow ones" to "works for any skill we've thrown at it, fails loudly when it fails at all".

The shortest way to understand this project is still: add a target, attach a skill, watch a report appear. The shortest way to *trust* it is: open the Maintenance card and watch the funnel. The shortest way to *operate* it is to know the soft cap (`max_run_seconds`) is yours to set, and the hard cap (the 15-minute DO alarm) is Cloudflare's.
