# Roadmap

Forward plan for WatchOMacho. Where v4 is, where it's going, and what's deliberately out of scope right now.

> **Status (2026-05-17):**
> - Level 1+2 shipped via Tavily ([PLAN.md](PLAN.md))
> - Level 3 partially shipped — first four UK typed tools (Land Registry, ONS, data.police.uk, Companies House) + multi-tool refactor ([PLAN_LEVEL3.md](PLAN_LEVEL3.md))
> - Level 4 (true agentic tool-use loop) still deferred

## Where we are — v4 + Tavily (current)

**One research agent. Targets get reports via reusable Skills, on a cadence.**

Architecture: Cloudflare Workers + Workers AI (Llama 3.3 70B / Mistral 24B / etc. via admin dropdown) + Vectorize for memory + D1 for structure + R2 for report bodies + [Tavily](https://tavily.com) for web search **and** full-page extraction in one vendor. Single platform plus one search vendor, one bill.

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

### Level 3 — Typed tools (specialist depth) — INITIAL FOUR DELIVERED 2026-05-17

The first four UK-focused typed tools shipped on top of Tavily, alongside a multi-tool refactor that lets a skill declare any combination of tools (one of each). The agent's `gatherSources` dispatches over a `SkillToolCall[]`; each typed tool flattens its structured output to a markdown table or labelled block so the writer prompt stays uniform.

**Delivered:**
- **HM Land Registry Open Data** — sold-price history per postcode (SPARQL endpoint, keyless)
- **ONS / postcodes.io** — UK postcode administrative geography (country, region, district, ward, constituency, LSOA, MSOA, parish)
- **data.police.uk** — street-level crime aggregated by category, last N months (keyless, England/Wales/NI only — not Scotland)
- **Companies House** — search by name or filter by registered-office postcode (free API key required)

Each is in `src/apis.ts` with a typed return shape, an entry in the `TOOLS` registry, and a dispatch case in `gatherSources` (in `agent.ts`). A skill declares a tool with a header like `**Land Registry op:** sold-prices` + optional per-tool params (`**Months:** 6`, `**Limit:** 25`, etc.). The synthesis prompt and `/admin/tools` page render the catalog dynamically, so future tools surface automatically.

**Remaining UK candidates (not yet wired):**
- **EPC Open Data** — energy performance certificates
- **TfL Unified API** — London transport stops, departures
- **OpenStreetMap Overpass** — amenities (shops, parks, schools)
- **data.gov.uk** — schools, hospitals, flood zones

**Global candidates (not yet wired):**
- **OpenAlex** / arXiv — academic papers
- **Wikidata SPARQL** — structured facts
- **Open-Meteo** — weather + history
- **GitHub API** — for company/person targets
- **HackerNews API** — for topic targets
- **GDELT** — global events

**Implementation pattern** (same as the four delivered): write a fetch function in `apis.ts` returning typed data, add an entry to the `TOOLS` registry (slug, display, summary, operations, headers), and add a dispatch case in `gatherSources`. Each handler returns `GatheredSource[]` with `{ title, url, content }` — flatten structured data to a markdown table inside `content` so the writer LLM sees one shape.

**Risk of overreach**: still applies. Pick 2–3 more tools that match your actual research targets, not every UK API in existence. More tools = more context for the LLM = more cost + cognitive load on the model.

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
