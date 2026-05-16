# WatchOMacho refactor plan — Tavily + Tailwind

Two refactors bundled into one plan, executed in sequence:

1. **Tavily-only toolbox** — swap from `Brave + Wikipedia + Nominatim` to Tavily as the single research tool.
2. **Tailwind CSS migration** — replace inline `style=""` declarations in `dashboard.ts` with Tailwind utility classes, matching the daylila stack.

No new features. Behaviour after = behaviour before, but with richer content (Tavily extracts full pages, not snippets) and cleaner styling source (Tailwind utility classes, not inline strings).

> **For a fresh session executing this:** read this whole doc top-to-bottom before touching code. Then check the memory file at `~/.claude/projects/-Users-zi-pro-WatchOMacho/memory/MEMORY.md` for any drift in state. Then start at Phase 0.

---

## 0. Where we are right now (2026-05-16)

**Deployed:** `watchomacho.daylila.com` (Cloudflare Worker). Production version is whatever `wrangler deployments list` shows newest — check before assuming.

**Just shipped this session (already live, do not re-do):**
- Removed the Mission (one-shot) feature entirely (code + docs + DB)
- Added CHECK constraints on `runs.triggered_by` ∈ {`cron`, `manual`} and `runs.status` ∈ {`success`, `error`} (D1 migration v8)
- Renamed R2 bucket `watchomacho-notes` → `watchomacho-reports`
- Cleaned all v5 vocabulary (`field notes`, `random-walker`, `explorations`, etc.)
- Polished admin UI copy ("Cron max / tick" → "Runs / hour", "Tick cron now" → "Run cron now", etc.)

**Current data state:**
- D1: zero rows in every user table (targets, skills, reports, runs, daily_usage). Only `settings` has its 5 default rows. `login_attempts` has a handful of today's admin logins (auto-irrelevant).
- R2: empty.
- Vectorize: empty.

**Current toolbox (what this plan replaces):**
- `braveSearch(apiKey, query)` — Brave Search API, web/search endpoint
- `wikipediaSummary(title)` — Wikipedia REST API for first-run grounding
- `geocodeQuery(q)` — Nominatim, rarely used

**Current bindings (in `wrangler.toml`):**
- `DB` — D1 `watchomacho-db`
- `REPORTS` — R2 `watchomacho-reports`
- `MEMORY` — Vectorize `watchomacho-memory`
- `AI` — Workers AI

**Current secrets:**
- `ADMIN_SECRET` — admin panel password
- `BRAVE_API_KEY` — Brave Search Free AI plan

**Current chat model:** `@cf/mistralai/mistral-small-3.1-24b-instruct` (user-selectable in admin; Llama 3.3 70B available but has tight free quota).

---

## 1. Why this plan looks this way (decision log)

These were debated and decided this session. **Don't reopen unless you have new information.**

| Decision | Rationale |
|---|---|
| **Tavily-only, no Brave** | User already uses Tavily for daylila.com (their main site). Unified stack, one vendor, one mental model. Tavily free tier (1k credits/mo) covers our ~600 credits/mo usage at $0. |
| **No Cloudflare Browser Run** | Browser Run is "free" only inside Workers Paid ($5/mo). Tavily's `/search` already returns extracted content — Browser Run becomes unnecessary. Avoids the $5/mo upgrade and a second vendor. |
| **No Workers Paid upgrade** | Browser Run was the only reason we needed it. Without Browser Run, Workers Free is enough for now. |
| **No Wikipedia step** | User explicitly killed Wikipedia. If grounding is needed, it can be done via a Tavily search for the topic — same outcome, one tool. |
| **No Nominatim** | Barely used. Tavily can find places via normal search if needed. |
| **No D1 `tools` table** | Each tool has both metadata and an implementation function — they have to live together to avoid drift. TypeScript registry is the single source of truth. The admin UI just renders it. |
| **Skill markdown headers (not new schema cols)** | Skills are already markdown. New conventions are just more markdown — no schema migration, no UI redesign, agent can produce them via synthesis. |
| **One tool, two operations** | Tavily is conceptually one tool (`tavily`). It has two ops (`search` and `extract`). Treating it as two tools would be over-decomposition. |
| **Add Tailwind CSS** | Matches daylila's CSS approach (visual + DX consistency across the user's two Cloudflare projects). Replaces inline `style=""` declarations in `dashboard.ts` with utility classes. Pure presentation refactor — no behaviour change. |
| **No Astro, no MDX** | WatchOMacho is dynamic-everywhere (DB-backed pages, forms, admin actions). Astro shines for static-first content with islands — wrong shape for this app. MDX needs author-written content with embedded components; reports here are LLM-generated. Tailwind is just CSS, no framework lock-in, so it's the only piece of the daylila stack that maps cleanly onto WatchOMacho. |
| **Tailwind via CDN** (initially) | The Tailwind Play CDN script (`<script src="https://cdn.tailwindcss.com">`) lets us migrate inline styles with **zero build step**. Worker stays buildless (`wrangler deploy` as-is). If later we want a slimmer production CSS bundle, we run Tailwind CLI once and serve from R2 — easy upgrade path, not blocking. |

---

## 2. Non-goals (do NOT do these)

- ❌ Do NOT add Cloudflare Browser Run.
- ❌ Do NOT add a fallback to plain `fetch()` for web pages. Tavily handles extraction; no fallback needed until something forces it.
- ❌ Do NOT upgrade to Workers Paid as part of this work.
- ❌ Do NOT modify the D1 schema. No new tables, no new columns.
- ❌ Do NOT re-introduce Wikipedia/Nominatim "just in case."
- ❌ Do NOT add Anthropic API access. That's Level 4 (future), not this refactor.
- ❌ Do NOT change the report markdown structure or the cron behaviour.
- ❌ Do NOT add a multi-vendor abstraction layer. We have one tool. Inline is fine.
- ❌ Do NOT introduce Astro or MDX. Only Tailwind is being adopted from the daylila stack.
- ❌ Do NOT add a build pipeline (PostCSS config, Vite, etc.). Tailwind is loaded via CDN — keep the project buildless.
- ❌ Do NOT change the existing color palette or font (DM Sans / `#FAF8F4` / `#1A6B62`). Tailwind config extends these as theme tokens; visual output should be pixel-identical to today.
- ❌ Per the user's memory rule, do NOT swap models / deps / schemas without explicit confirmation — even in auto mode.

---

## 3. The four-level roadmap (context, not work)

This refactor effectively delivers what was previously called "Level 2/3" via Tavily. After this:

- **Done (post-refactor):** Tavily covers both search and full-page extraction in one vendor.
- **Future Level 3+:** typed UK-specific tools (Land Registry, ONS, Companies House) — only if specific repeated patterns emerge.
- **Future Level 4:** true agentic tool-use loop via Anthropic — only if the rigid plan-gather-write pipeline becomes the bottleneck.

None of these are in scope for this plan.

---

## 4. Phase-by-phase execution

### Phase 0 — Secrets & one-time you-actions

Before any deploy, **the user** does:

```
1. Get your Tavily API key from https://app.tavily.com (you already
   have a Researcher (Free) plan with 1,000 credits/month).
2. wrangler secret put TAVILY_API_KEY
   → paste the key when prompted.
```

That's the only manual step. Brave subscription stays live for now — we just stop using it.

---

### Phase 1 — Rip out the old toolbox

**`src/apis.ts`** (currently ~120 lines)
- Delete `braveSearch()` + `BraveResult` interface
- Delete `wikipediaSummary()` + `WikiSummary` interface
- Delete `geocodeQuery()` + `GeoHit` interface
- Keep `UA` constant (Tavily fetches will reuse it)

**`src/agent.ts`** (currently ~560 lines)
- Remove the Wikipedia-grounding step inside `runResearch`
- Remove imports of `wikipediaSummary`, `geocodeQuery`, `braveSearch`, `BraveResult`
- Remove `BRAVE_API_KEY` from `Env` interface (line ~16) and add `TAVILY_API_KEY`

**`wrangler.toml`**
- Replace the Brave-related comment block with one describing Tavily
- No new bindings (Tavily is a normal HTTPS fetch)

**`.dev.vars.example`**
- `BRAVE_API_KEY=...` → `TAVILY_API_KEY=...`

After Phase 1 the build won't compile — expected, mid-refactor. No deploy yet.

---

### Phase 2 — Wire in Tavily

Add to **`src/apis.ts`**:

```ts
export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;       // extracted content of the page, already cleaned
  score: number;         // relevance 0..1
  published_date?: string;
}

export interface TavilySearchOptions {
  topic?: "general" | "news" | "finance";
  time_range?: "day" | "week" | "month" | "year";
  search_depth?: "basic" | "advanced";   // basic = 1 credit, advanced = 2
  max_results?: number;                  // default 5
}

export async function tavilySearch(
  apiKey: string | undefined,
  query: string,
  options: TavilySearchOptions = {},
): Promise<TavilySearchResult[]> {
  if (!apiKey) return [];
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      api_key: apiKey,
      query: query.slice(0, 400),
      search_depth: options.search_depth ?? "basic",
      topic: options.topic ?? "general",
      time_range: options.time_range,
      max_results: options.max_results ?? 5,
      include_raw_content: true,        // we want the page text
    }),
  });
  if (!r.ok) return [];
  const data: any = await r.json();
  return (data.results ?? []).map((h: any) => ({
    title: String(h.title ?? ""),
    url: String(h.url ?? ""),
    content: String(h.raw_content ?? h.content ?? ""),
    score: Number(h.score ?? 0),
    published_date: h.published_date,
  }));
}

export interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

export async function tavilyExtract(
  apiKey: string | undefined,
  urls: string[],
  extract_depth: "basic" | "advanced" = "basic",
): Promise<TavilyExtractResult[]> {
  if (!apiKey || urls.length === 0) return [];
  const r = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      api_key: apiKey,
      urls: urls.slice(0, 20),         // hard cap per call
      extract_depth,
    }),
  });
  if (!r.ok) return [];
  const data: any = await r.json();
  return (data.results ?? []).map((r: any) => ({
    url: String(r.url ?? ""),
    raw_content: String(r.raw_content ?? ""),
  }));
}
```

**TOOLS registry** in the same file:

```ts
export const TOOLS = {
  tavily: {
    slug: "tavily",
    display: "Tavily",
    operations: {
      search: "Search the web by keyword. Returns top results WITH extracted full-page content. 1 credit/call (basic) or 2 credits (advanced).",
      extract: "Read a list of specific URLs in full. Returns clean text per URL. 1 credit per 5 URLs (basic) or 2 credits per 5 (advanced).",
    },
    when_to_use_search:
      "When the skill needs to discover relevant pages from the open web by keyword.",
    when_to_use_extract:
      "When the skill has specific URLs to read (RSS feeds, curated sources, etc.).",
  },
} as const;
```

Powers (a) future skill synthesis, (b) a read-only `/admin/tools` catalog page.

---

### Phase 3 — Skill markdown convention

A skill's `procedure_md` can declare its tool config via simple markdown headers. **All headers are optional** — a skill with none gets sensible defaults (search mode, basic depth, general topic, any time range).

```
# My skill

**Tavily op:** search          (default if not specified)
                OR
               extract          (forces URL-based mode)

**Sources:**                   (only used with extract op)
- https://feeds.bbci.co.uk/news/world/rss.xml
- https://rss.cnn.com/rss/edition_world.rss

**Search topic:** general | news | finance     (default: general)
**Time range:**   day | week | month | year     (default: any)
**Depth:**        basic | advanced              (default: basic)

**Procedure:**
<your normal skill procedure here>
```

Add `parseSkillTools(procedure_md)` to **`src/agent.ts`** — small regex-based parser. ~20 lines. No new dependencies. Returns:

```ts
{
  op: "search" | "extract",
  sources?: string[],
  topic?: "general" | "news" | "finance",
  timeRange?: "day" | "week" | "month" | "year",
  depth?: "basic" | "advanced",
}
```

---

### Phase 4 — Rewire `runResearch`

Current pipeline (in `src/agent.ts` `runResearch`):

```
plan → gather (Brave) → recall → wikipedia → write → persist
```

New pipeline:

```
plan → gather (Tavily) → recall → write → persist
```

The new `gather` step:

```ts
const parsed = parseSkillTools(skill.procedure_md);

let gatheredSources: { title: string; url: string; content: string }[] = [];

if (parsed.op === "extract" && parsed.sources?.length) {
  // RSS feeds / curated URL list — skip search entirely
  const extracted = await tavilyExtract(env.TAVILY_API_KEY, parsed.sources);
  gatheredSources = extracted.map((r) => ({
    title: r.url,
    url: r.url,
    content: r.raw_content,
  }));
} else {
  // Default: LLM plans queries → Tavily searches each
  const queries = await planResearchQueries(env, skill, target);  // existing fn, unchanged
  const searchResults = await Promise.all(
    queries.map((q) =>
      tavilySearch(env.TAVILY_API_KEY, q, {
        topic: parsed.topic ?? "general",
        time_range: parsed.timeRange,
        search_depth: parsed.depth ?? "basic",
      }),
    ),
  );
  // Flatten + dedupe by URL
  const seen = new Set<string>();
  for (const batch of searchResults) {
    for (const r of batch) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      gatheredSources.push({ title: r.title, url: r.url, content: r.content });
    }
  }
}

// Cap total content to keep LLM prompt under control
const MAX_CHARS_PER_SOURCE = 4000;
gatheredSources = gatheredSources.map((s) => ({
  ...s,
  content: s.content.slice(0, MAX_CHARS_PER_SOURCE),
}));
```

The rest of `runResearch` (recall, write, persist) is untouched — it just receives richer source content.

**Budget integration:** the existing `daily_search_limit` setting now means "Tavily credits per day." Update the field-help text on the admin settings card to say so.

---

### Phase 5 — Teach the synthesis prompt about Tavily

In `synthesizeSkill` (in `src/agent.ts`), prepend the TOOLS catalog to the system prompt:

```
Available tools you can call from a skill:

tavily (search):  Search the web by keyword. Returns top results with
                  extracted full-page content. Add **Tavily op:** search
                  to declare. Default if no Tavily op header.

tavily (extract): Read a list of specific URLs in full. Add
                  **Tavily op:** extract to declare, plus **Sources:**
                  list with one URL per bullet.

Optional headers for search mode:
  **Search topic:** general | news | finance
  **Time range:**   day | week | month | year
  **Depth:**        basic | advanced
```

Result: when a user briefs *"watch Apple stock hourly"*, the LLM auto-adds the appropriate headers. No human writes them.

---

### Phase 6 — Tiny UI tweak

**`src/dashboard.ts`**
- Add a new route `/admin/tools` and a `renderAdminTools()` function. Renders the `TOOLS` registry as a read-only table. ~30 lines. Add a nav link to it from `/admin/skills`.
- On `/admin/skills`, update the help text under the synthesise + by-hand forms to mention optional Tavily headers (~5 lines).

No other UI changes.

---

### Phase 7 — Docs alignment

Update docs that still describe the Brave + Wikipedia toolbox:

- **`README.md`** — concepts section + API table
- **`ARCHITECTURE.md`** — system diagram, file responsibilities table, research-loop table
- **`BOOK.md`** — apis.ts walkthrough, research loop chapter
- **`ROADMAP.md`** — note Level 2/3 effectively delivered by Tavily; reframe future levels
- **Memory file** `project_v4_state_and_roadmap.md` — update toolbox + deployed version + add an entry noting Tavily-only as of the deploy date

---

### Phase 8 — Deploy & verify

```
1. npx tsc --noEmit                          (must compile clean)
2. npx wrangler deploy                       (push to prod)
3. Visit /admin/skills → Synthesise a skill:
     name:  "Apple stocks pulse"
     brief: "Hourly check on Apple stock news. Focus on price moves,
             analyst notes, catalysts."
   → confirm the synthesised procedure includes:
     **Tavily op:** search
     **Search topic:** finance  (or news — either's fine)
     **Time range:** day
4. Visit /admin → Add target:
     name: Apple stocks
     kind: company
     cadence: every 1 hour
     skill: Apple stocks pulse
     ☑ Run once now
   [Add target]
5. Wait ~20 seconds, refresh, click the target → read the report
6. Confirm report content is richer than snippet-only (full sentences
   from sources, not 150-char fragments)
7. Glance at https://app.tavily.com → confirm ~1 credit consumed
```

If something's wrong: `npx wrangler rollback` returns to the previous version. **Zero data risk** — schema unchanged, R2 unchanged, Vectorize unchanged.

> **Important:** Phases 9–11 (Tailwind) should happen only AFTER Phase 8 passes verification. Don't bundle the Tavily and Tailwind changes into a single deploy — keep them as two separate "stop the world and verify" checkpoints. If Tavily breaks something, Tailwind work would muddy the diff.

---

### Phase 9 — Add Tailwind to the shell template

**Goal:** load Tailwind so `class="..."` declarations start working everywhere, without touching any existing inline styles yet.

**`src/dashboard.ts`** — find the `shell()` function (the HTML wrapper used by every page). Inside the `<head>`, just before the closing `</head>`:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  // Extend Tailwind with our existing design tokens so utility classes
  // like text-zee-primary / bg-zee-cream resolve to the same hex values
  // we already use inline. No design change.
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          'zee-primary': '#1A6B62',      // forest-teal
          'zee-cream':   '#FAF8F4',      // warm off-white background
          'zee-text':    '#1F1B16',      // existing var(--zee-text)
          'zee-muted':   '#6B6358',      // existing var(--zee-muted)
        },
        fontFamily: {
          sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        },
      },
    },
  };
</script>
```

**Verify:** deploy, refresh any admin page, view the source — confirm the CDN script loads (no 404, no console errors). Existing inline styles still render unchanged. Add `class="text-zee-primary"` to any single element as a smoke test; revert that test class after confirming.

**Why CDN, not built CSS:** zero build step, instant onboarding, easy revert. The CDN bundle is ~50KB gzipped — fine for an admin tool. If we ever want production-grade bundling, that's a 1-hour follow-up (Tailwind CLI → CSS file → serve from R2). Not blocking.

---

### Phase 10 — Migrate inline styles to Tailwind classes

**Scope:** all the `style="..."` attributes in `src/dashboard.ts`. Estimated ~80–120 occurrences. Pure find-and-replace, no logic touched.

**Approach:**
1. Open `src/dashboard.ts`. Work top-to-bottom, function by function:
   - `shell()`
   - `renderHome()`
   - `renderTargetPage()`
   - `renderSkillPage()`
   - `renderReportPage()`
   - `renderAdminLogin()`
   - `renderAdminPanel()`
   - `renderAdminSkills()`
   - `renderAdminTargetEdit()`
   - `renderAdminTools()` (added in Phase 6)
2. For each inline `style=""` block, translate to the equivalent Tailwind utility classes. Common mappings:
   - `style="display:flex;gap:8px"` → `class="flex gap-2"`
   - `style="margin-top:14px"` → `class="mt-3.5"` (or `mt-4` if exact px doesn't matter)
   - `style="font-size:13px;color:var(--zee-muted)"` → `class="text-[13px] text-zee-muted"`
   - `style="padding:24px 0 12px"` → `class="pt-6 pb-3"`
   - `style="border-bottom:1px solid rgba(232,228,222,0.6)"` → keep as inline style (one-off) or extend Tailwind config with a custom border color.
3. When a style is genuinely one-off and ugly to express in Tailwind, **leave it inline**. Don't force every pixel through utility classes. The goal is cleaner source for the common patterns, not religious purity.
4. Existing CSS variables in the `<style>` block at the top of `shell()` can mostly stay — they're used as `var(--zee-primary)` in inline styles. After migration, that `<style>` block can shrink (most rules become Tailwind classes), but leave whatever genuinely needs cascade-style CSS (`.card`, `.btn`, `:focus` rings, etc.). Tailwind doesn't have to be 100% — it just needs to handle the easy cases.

**`src/dashboard.ts` size impact:**
- Removes hundreds of repetitive `style="..."` characters.
- Net: probably ~50–100 lines shorter overall.

---

### Phase 11 — Visual verify + deploy Tailwind

```
1. npx tsc --noEmit
2. Local check: open the HTML output by visiting each route in a deployed preview
   (or compare deployed-vs-current via wrangler dev) — confirm pixel parity
   with the pre-Tailwind state.
   Pages to check:
     /                       (public targets list)
     /target/<slug>          (will be empty since no targets — verify "no
                              other targets" empty state)
     /skill/<slug>           (will be empty)
     /report/<id>            (won't have one — skip)
     /admin/login            (form layout)
     /admin                  (4 cards: add target / active targets / budgets / runs)
     /admin/skills           (synthesise + write-by-hand forms)
     /admin/targets/<slug>   (won't have one — skip)
     /admin/tools            (new from Phase 6 — read-only catalog)
3. npx wrangler deploy
4. Hit watchomacho.daylila.com on real browser. Light/dark contrast OK,
   spacing OK, fonts OK, no console errors.
5. If anything regressed: roll back, fix the offending function, redeploy.
```

---

### Phase 12 — Cleanup (separate session, after a few days of working Tavily + Tailwind)

- **User:** cancel the Brave $5/mo subscription at api-dashboard.search.brave.com
- **User:** `wrangler secret delete BRAVE_API_KEY`
- **Code:** remove any lingering Brave references in comments (sweep one more time)
- **Code:** if you want production-grade Tailwind (smaller CSS, no CDN warning in console), follow up with: run Tailwind CLI once locally, write the output CSS file to R2, swap the CDN `<script>` for a `<link>` tag pointing at the R2 asset. ~30 minutes of work, optional.

---

## 5. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tavily returns a different result shape than expected | Low | Test in Phase 8 before declaring done; the API hasn't changed in months |
| Tavily free tier exhausted faster than projected | Low | `daily_search_limit` setting still applies as a hard gate. Bump it down if needed. |
| Existing skills written assuming Brave snippets break | None | Pure content-source swap; LLM doesn't care where text came from. Defaults reproduce prior behaviour. |
| Workers AI rate-limit hit during testing | Already known issue | Mistral 24B is already the default — looser cap than Llama 70B |
| Tavily acquisition by Nebius (Feb 2026) changes pricing | Low | We're on free tier; if pricing changes, we re-evaluate then. |
| Tailwind CDN script blocked on first paint / shows un-styled flash | Low | CDN script blocks rendering until classes resolve. Acceptable for admin tool; revisit if it bothers you. |
| Inline style → Tailwind class translation produces visual regression | Medium | Phase 11 explicitly verifies pixel parity page-by-page. Roll back if regressions found. |
| Tailwind CDN flagged "not for production" in console | Yes (cosmetic) | Console warning only. Phase 12 has the optional production-build upgrade. |

---

## 6. What this preserves (zero migrations)

- D1 schema — unchanged
- R2 bucket — unchanged (`watchomacho-reports`)
- Vectorize index — unchanged (`watchomacho-memory`)
- All current skills — work without edit; defaults kick in
- All current targets — keep running
- Admin UI structure — same 4 cards
- Cron behaviour
- Budget gates (now metering Tavily credits in place of Brave queries)
- Recall step (past-report memory)

It's a brain transplant on a clean body. Nothing else moves.

---

## 7. Total scope

```
TAVILY PART
  ~250 lines deleted   (Brave + Wikipedia + Nominatim + wiring)
  ~150 lines added     (Tavily + TOOLS registry + skill parser + UI tweak)

TAILWIND PART
  ~10 lines added      (CDN script + tailwind.config in shell())
  ~50-100 lines net    (inline style="..." → class="..."; mostly shorter)
        shorter
                       ─────
Net: smaller codebase, simpler infra, one vendor, one CSS approach.
```

---

## 8. Phase ownership

| Phase | What | Who |
|---|---|---|
| 0 | Set `TAVILY_API_KEY` secret | User |
| 1 | Delete old apis (Brave/Wikipedia/Nominatim) | Agent |
| 2 | Add Tavily functions + TOOLS registry | Agent |
| 3 | Add skill markdown parser | Agent |
| 4 | Rewire `runResearch` gather step | Agent |
| 5 | Update synthesis prompt with tool catalog | Agent |
| 6 | Add `/admin/tools` page + skill help text | Agent |
| 7 | Update docs (README, ARCHITECTURE, BOOK, ROADMAP, memory) | Agent |
| 8 | Deploy & verify Tavily with a test target | Both |
| 9 | Add Tailwind CDN + config to `shell()` template | Agent |
| 10 | Migrate inline styles in `dashboard.ts` to Tailwind classes | Agent |
| 11 | Visual verify + deploy Tailwind | Both |
| 12 | Cleanup Brave subscription + secret + optional Tailwind production build (later) | User + Agent |

---

## 9. User preferences to honour throughout

From the project memory file:
- **Keep designs SIMPLE.** One agent. Don't over-engineer with per-step roles, per-target overrides, etc. — until explicitly asked.
- **Stay on Cloudflare** as long as possible. No new platforms.
- **Workers Paid not yet bought.** Don't require it.
- **Testing mode.** Data can be wiped freely.
- **Daylila design language** is the visual reference (DM Sans, warm off-white `#FAF8F4`, forest-teal `#1A6B62`). Don't break it.
- **Ask before architectural changes.** The user has confirmed this Tavily-only direction explicitly — but if mid-execution you spot a fork that meaningfully changes the shape, stop and ask.

---

## 10. How to start (fresh session)

```
1. cd into the worktree (current working dir if `wrangler` already works).
2. Read this whole file.
3. Read ~/.claude/projects/-Users-zi-pro-WatchOMacho/memory/MEMORY.md
   and the project_v4 memory file it indexes. Note any drift.
4. Run:  npx wrangler deployments list | head -5
   → confirm last deploy matches what the memory file says.
   → if not, ask the user before proceeding.
5. Ask the user: "Have you set TAVILY_API_KEY as a secret yet?"
   → if no, walk them through Phase 0.
   → if yes, begin Phase 1.
6. Plough through Phase 1 → 8 sequentially (Tavily refactor). Don't skip.
7. Pause. Confirm with the user that Tavily reports look right after a couple of cron ticks.
8. Then Phase 9 → 11 (Tailwind migration). Same drill: sequential, no skipping.
9. Phase 12 happens later, separate session.
```

---

## 11. Definition of done

**Tavily part (Phases 0–8):**
- `npx tsc --noEmit` is clean.
- `npx wrangler deploy` succeeded.
- A test target produces a report whose content is visibly richer than current Brave-snippet-only reports.
- Tavily dashboard confirms credit consumption.
- All docs (README, ARCHITECTURE, BOOK, ROADMAP, memory) describe Tavily as the toolbox.
- No reference to `braveSearch`, `wikipediaSummary`, `geocodeQuery` anywhere in `src/`.
- No reference to `BRAVE_API_KEY` in code (it may still be set as a secret until Phase 12).

**Tailwind part (Phases 9–11):**
- Tailwind CDN script + `tailwind.config` block present in `shell()`.
- `dashboard.ts` is visibly less repetitive — most common spacing/layout/color patterns use Tailwind utility classes instead of inline `style=""`.
- Every page renders pixel-equivalent to the pre-Tailwind state (no visible regressions on `/`, `/admin`, `/admin/skills`, `/admin/tools`, `/admin/login`).
- Custom CSS in the `<style>` block in `shell()` is smaller than before (most rules either moved to Tailwind classes or stayed because they're genuinely better as cascade CSS).
- Memory file's "current state" line records the Tailwind addition.
