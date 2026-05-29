# Roadmap

Forward plan for WatchOMacho. Where v4 is, where it's going, and what's deliberately out of scope right now.

> **Status (2026-05-29):**
> - **Day-map v14 shipped 2026-05-29 (DEPLOYED):** replaced the v13 SVG "comic" with a *map of the day* — NOT the JSON+SVG hub-and-spoke originally drafted in [DAY_MAP_SPEC.md](DAY_MAP_SPEC.md) (now superseded). It's **lab-shaped**: one LLM pass (`planDayMap`) over the **full** briefing writes a single self-contained interactive HTML page, deliberately **concrete** (real names/dates/numbers — the inverse of daylila's abstract "labs"). Layout is a **single vertical cause→effect column** (root driver → forces → effects, all ↓ connectors) at every width — mobile-first, centered on desktop; tap any card to expand its detail **inline** (accordion, never a fixed/off-screen modal). Styled to match daylila (DM Sans + the shared palette), no footer. It auto-sizes its embedding iframe via a `postMessage({type:'day-map-height'})` contract (no inner scrollbar). Stored in R2 (`day-maps/*.html`), linked from `reports.day_map_r2_key`/`day_map_slug` (v14 migration renamed the v13 `comic_*` columns), served at `GET /day-map/:id` (`no-store`, plus a no-network CSP allowing only cdnjs scripts + Google Fonts), embedded in a **sandboxed iframe** here and on daylila, exposed on `/api/reports/:id` as `day_map {type:'html', html, slug, url}` + `/api/reports/recent` (slim `day_map {slug,url}`). No content validator — the iframe sandbox + CSP are the safety wall; the only check is "is this real HTML?". A per-report **"Remake map"** admin button regenerates just the map (one call, no re-research) via `POST /admin/reports/:id/day-map`. Toggle per-target or globally via `day_map_enabled` (default off).
> - **Daily comic shipped 2026-05-29 (v13, REPLACED by v14 day-map above)** — the original code-drawn SVG "connection comic" (a *spine* + 3–5 cause→effect panels via `planComic`/`renderComicSvg`, stored at `comics/*.svg`, served at `/comic/:id`). Replaced wholesale by the v14 day-map; the `comic_*` columns/settings/routes were renamed to `day_map_*`.
> - **Anchor-based cron + `briefing_date` API shipped 2026-05-27** — replaced the drifting `next_run_at = last + cadence` formula with `computeNextRunAt()` (anchor + k*cadence UTC slots). New `targets.anchor_hour_utc` column (v12 migration), default 02:00 UTC. Admin UI now uses plain-English "How often" + "Starting at HH:00 UTC" dropdowns and shows the schedule as e.g. "Daily at 02:00 UTC" / "2× per day at 02:00, 14:00 UTC". Both `/api/reports/recent` and `/api/reports/:id` now emit `briefing_date: "YYYY-MM-DD"` (UTC date of `created_at`) so downstream consumers like daylila have one canonical date string and don't need to do their own timezone math.
> - Level 1+2 shipped via Tavily ([PLAN.md](PLAN.md))
> - **Level 3 REVERTED 2026-05-19** — the four UK typed tools (Land Registry, ONS, data.police.uk, Companies House) shipped on 2026-05-17 but were rolled back in commit `1825402` ("Simplify: one tool, explicit skills"). `TOOLS` registry is now Tavily-only. The multi-tool refactor that supported them stayed in place; one explicit tool per skill is the current shape.
> - **Memory loop shipped** — embed every report, recall similar prior reports as `[N]` archive citations alongside web sources, navigable graph via 📚 markers
> - **Observability shipped** — step-level heartbeat + per-run Tavily gather funnel visible in admin Heartbeat card
> - **Gather tuning shipped** — Tavily max_results=20, planner cap 10, title-Jaccard dedupe, dynamic skill structure, `max_chars_per_source` admin-tunable
> - **Admin Search-tuning shipped** — `tavily_min_score` editable per-target (and globally) from `/admin`
> - **Sonnet 4.6 + lean prompts shipped 2026-05-22** — default chat model is `anthropic/claude-sonnet-4-6`; hardcoded editorial controls stripped from writer/planner so the skill is the only voice; new `writer_max_tokens` setting tunable from admin (default 2200, range 200–16000)
> - **LLM-authored title + summary shipped 2026-05-23** — writer call now emits a YAML frontmatter block (`title:` + `summary:`) parsed back into the existing `reports.title` and `reports.snippet` columns. No schema migration, no API shape change. Public `/api/reports/recent` and `/api/reports/:id` now expose a real story headline + 1–4-sentence editorial abstract automatically. Fallback to legacy templated title + truncated lead when parsing fails (logs `writeReport: frontmatter parse failed`).
> - Level 4 (true agentic tool-use loop) still deferred — current pipeline is fully sufficient

## Where we are — v4 + Tavily (current)

**One research agent. Targets get reports via reusable Skills, on a cadence.**

Architecture: Cloudflare Workers + Cloudflare AI Gateway → Anthropic Claude Sonnet 4.6 (Haiku 4.5 + ~8 Workers AI models selectable as fallbacks) + Vectorize for memory + D1 for structure + R2 for report bodies + [Tavily](https://tavily.com) for web search **and** full-page extraction in one vendor. Single platform plus one search vendor, one bill.

The research loop is:
1. **Plan** (LLM) — what to search for (skipped when the skill declares `**Tavily op:** extract` with explicit URLs)
2. **Gather** (our code → Tavily) — `/search` returns top results *with extracted full-page content*, or `/extract` reads a curated URL list in full
3. **Recall** (Vectorize) — past reports
4. **Write** (LLM) — produce report from extracted content + recall

**What Tavily fixed (vs the original v4):**
- The "LLM only sees ~150-char snippets" problem is gone. Tavily returns extracted full-page content per result, which is what the writer LLM now reads.
- The original three-vendor split (Brave for search, Wikipedia for grounding, Nominatim for geocoding) collapsed into one: Tavily.

**Remaining known shortcomings:**
- No specialised typed tools (Land Registry, ONS, Companies House, etc.) — every research question still goes through generic web search.
- No reflection / self-improvement loop. Every report is fresh from search; old reports don't shape new strategy.
- Tavily Researcher Free plan = 1000 credits/month. At ~5 basic searches/report × 20 reports/day = 3000/month → blows the free tier in ~10 days at full usage. Throttle via `daily_search_limit` or upgrade Tavily's plan.

Both shortcomings are addressed in a later level below.

---

## The four-level improvement ladder

### ~~Level 1~~ → Level 1 (current)
~~Plan → Brave snippets → Write.~~ Now: Plan → Tavily (search returns extracted content) → Recall → Write. Both wide *and* deep — see "What Tavily fixed" above.

### ~~Level 2~~ — DELIVERED by Tavily
~~After Brave returns URLs, our code fetches the top 3–5 pages and extracts text.~~ Tavily's `/search` does this in one HTTP call (no need for a separate `fetchPage()` step or Cloudflare Browser Rendering). Skip this level — the work is done.

### Level 3 — Typed tools (specialist depth) — REVERTED 2026-05-19

> The first four UK typed tools (Land Registry, ONS, data.police.uk, Companies House) shipped on 2026-05-17 then were removed on 2026-05-19 in commit `1825402` ("Simplify: one tool, explicit skills"). The multi-tool dispatch shape stayed (skills still pick a tool via `tool_slug`/`tool_op` columns), but `TOOLS` is now Tavily-only. PLAN_LEVEL3.md kept as history of the shipped-then-reverted feature.

**Why reverted:** the typed tools added registry surface area without paying off in skill authorship — Tavily's full-page extraction covered the same research questions with less per-skill plumbing.

**If specialist depth becomes needed again**, the implementation pattern still works: write a fetch function in `apis.ts` returning typed data, add an entry to the `TOOLS` registry (slug, display, summary, operations, headers), and add a dispatch case in `gatherSources`. Each handler returns `GatheredSource[]` with `{ title, url, content }` — flatten structured data to a markdown table inside `content` so the writer LLM sees one shape.

Candidates worth re-considering if the use case appears:
- **EPC Open Data**, **TfL Unified API**, **OSM Overpass**, **data.gov.uk** (UK)
- **OpenAlex / arXiv**, **Wikidata SPARQL**, **Open-Meteo**, **GitHub API**, **GDELT** (global)

**Risk of overreach** still applies. Pick 2–3 tools that match your actual research targets, not every API in existence. More tools = more context for the LLM = more cost + cognitive load on the model.

### Level 4 — True agentic tool-use loop
The LLM iteratively calls tools, sees results, decides next steps, calls more tools, then writes. Requires real function-calling support — Claude and GPT do this cleanly; Workers AI Llama is more limited.

**Partially enabled (2026-05-17)** by the AI Gateway + Anthropic Haiku 4.5 integration. The dispatcher (`runChat()`) now routes `anthropic/...` model IDs through Cloudflare AI Gateway, with Unified Billing so Cloudflare bills you for Anthropic usage on a single invoice (no separate Anthropic account needed). That's the infrastructure piece. The agentic loop itself (LLM-driven tool selection, multi-turn) is still deferred — current pipeline is rigid plan-gather-write. Switch to Claude's native tool-use API only when skills become too constraining.

---

## Cost trajectory

| Phase | Tavily/mo | Workers AI | Anthropic (via Unified Billing) | Approx total |
|---|---|---|---|---|
| v4 + Tavily, Workers AI chat (free path) | 1k free | 10k/day free | 0 | £0 (~6 reports/day cap from Tavily) |
| + Tavily paid (Bootstrap) | $30 | 10k/day free | 0 | $30/mo |
| **v4 + Haiku 4.5 chat (current default)** | 1k free | embeddings only | ~$0.01/report | **~$2/mo at 5 reports/day, ~$6/mo at 20 reports/day** |
| + Tavily paid + Haiku at 20 reports/day | $30 | embeddings only | $6 | ~$36/mo |
| Full agentic Level 4 (Sonnet tool-use loop) | + Tavily | embeddings only | $10–30 | $40–60/mo |

Hobby use on Haiku stays well under $10/month. The Workers AI free path remains available — switch the dropdown to `@cf/meta/llama-3.1-8b-instruct-fast` for ~100 free reports/day in the shared neurons pool.

---

## Decisions made + not made

### Made
- **Single platform** = Cloudflare. Unified billing, one dashboard.
- **Skills as markdown procedures** (not code adapters). User-editable, agent-synthesisable.
- **One agent**, not multiple specialised agents. Skills do the specialisation.
- **Three layers**: Target / Skill / Report. Nothing else needed for v1.
- **Workers AI chat models** as default. Anthropic deferred until specific need.
- **Tavily** for web access — one vendor for both search and full-page extraction. Free tier (1k credits/mo) covers initial use.

### Deferred (not "no" — just "not yet")
- Per-target chat-model override
- Per-skill chat-model preference
- Reflection/Curator loop that re-reads old reports and refines skills
- Multiple skills per target (currently one primary skill per target)
- Skill versioning (current edit = overwrite)
- Multi-user auth (currently single admin secret)
- Public API / RSS feeds of reports
- Email digests

### Considered and rejected
- **Cloudflare's AutoRAG / AI Search**: indexes your own data, not web — wrong tool for web research.
- **Browser-rendering Google SERPs**: ToS issues, brittle, expensive vs Tavily.
- **Brave Search + Cloudflare Browser Rendering**: the *original* plan for full-content reports. Replaced by Tavily, which returns extracted content in the same call as the search — fewer vendors, fewer HTTP hops, no Workers Paid upgrade required.
- **Pre-built personas**: too rigid; let skills define personality.
- **Tool-call loop in v4**: complexity not warranted yet at current quality bar.

---

## "What to do next" — practical answer for future sessions

If you hit "Run Now never completes for skill X" → **already solved.** Manual runs route through the `ResearchRunner` Durable Object alarm (15-min budget instead of the 30s `waitUntil` cap). Guarded by `max_run_seconds` + AbortController + watchdog cron. See the "Run Now path" section in [ARCHITECTURE.md](ARCHITECTURE.md).

If quality of reports is still the bottleneck after Tavily → check whether `MAX_CHARS_PER_SOURCE` (4000) is too aggressive a cap, or whether `**Depth:** advanced` would help (2 credits instead of 1, but more thorough extraction).

If specific repeated research patterns emerge → **Level 3 typed tools** for those patterns. Add to `TOOLS` registry + `apis.ts`.

If Workers AI is too thin/dry for the kind of writing the user wants → wire Anthropic via AI Gateway Unified Billing, keep everything else.

If hitting Tavily's monthly cap → tighten `daily_search_limit` first; if you actually need more headroom, Tavily's Bootstrap plan adds 10k credits/mo for $30. Or run skills in `**Depth:** basic` mode (which is the default).

---

## What's not on this roadmap

This is a *research-report agent*. Things that would change what it is:
- Conversational chat interface
- Real-time streaming responses
- Multi-user accounts
- Marketplace for skills

None of those are wrong, but they'd reshape the project. If any becomes interesting, the conversation is "should this still be WatchOMacho or a new project?"
