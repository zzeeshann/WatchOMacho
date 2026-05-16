# Roadmap

Forward plan for WatchOMacho. Where v4 is, where it's going, and what's deliberately out of scope right now.

> **⚠️ Active plan = [PLAN.md](PLAN.md).** This roadmap describes the original 4-level ladder. After discussion on 2026-05-16, the immediate next step is captured in `PLAN.md` (Tavily-only toolbox + Tailwind CSS), which collapses what was previously "Level 2 + Level 3" into a single simpler refactor. **Read `PLAN.md` first if you're continuing the project.** The "Considered and rejected" / cost trajectory / decision rationale below still apply; the level numbering does not — Tavily ships what Levels 2 and 3 were going to ship.

## Where we are — v4 (current)

**One research agent. Targets get reports via reusable Skills, on a cadence.**

Architecture: Cloudflare Workers + Workers AI (Llama 3.3 70B / Mistral 24B / etc. via admin dropdown) + Vectorize for memory + D1 for structure + R2 for report bodies + Brave Search for web access + Wikipedia + Nominatim. Single platform, single bill.

The research loop is:
1. **Plan** (LLM) — what to search for
2. **Gather** (our code → Brave Search) — get 20 snippets back
3. **Recall** (Vectorize) — past reports
4. **Write** (LLM) — produce report from snippets

**Known shortcomings of v4:**
- LLM only sees Brave's ~150-char snippets per result, not full page content. Reports are constrained by what's in the snippet.
- Brave free tier = 2000 queries/month. At 5 queries/report × 20 reports/day = 3000/month → blows the free tier in ~20 days.
- No specialised tools — every research question is approached the same way.
- No reflection / self-improvement loop. Every report is fresh from search; old reports don't shape new strategy.

These are expected at v4. Each is addressed in a later level below.

---

## The four-level improvement ladder

### Level 1 — Where we are
Plan → Brave snippets → Write. Cheap, fast, shallow.

### Level 2 — Fetch full page content (highest-impact next step)
After Brave returns URLs, our code fetches the top 3–5 pages and extracts text. The LLM writes from real content, not snippets.

- **Code change**: new `fetchPage(url)` in `apis.ts`. Honest text extraction (strip HTML, deduplicate whitespace, cap length). Optionally use **Cloudflare Browser Rendering** for JS-heavy sites (~$0.09/session).
- **Cost impact**: ~5× more bytes piped through LLM → maybe 2–3× neurons per report. Still well under Workers Paid limit.
- **Quality impact**: universal across all skills. This is the single biggest knob.
- **Risk**: some pages block bots, some are massive (need a length cap), some are paywalled (Brave snippet still helps).
- **When to do**: when you're tired of seeing "Not enough source material" in reports.

### Level 3 — Typed tools (specialist depth)
Wire specific public APIs the agent can call when relevant. Each skill can prefer certain tools.

UK-focused candidates (all free, all keyless except Companies House):
- **Land Registry Open Data** — sold-price history per postcode
- **ONS API** — census, demographics, deprivation indices
- **data.police.uk** — crime stats per area
- **Companies House** — businesses at an address
- **EPC Open Data** — energy performance certificates
- **TfL Unified API** — London transport stops, departures
- **OpenStreetMap Overpass** — amenities (shops, parks, schools)
- **data.gov.uk** — schools, hospitals, flood zones

Global candidates:
- **OpenAlex** / arXiv — academic papers
- **Wikidata SPARQL** — structured facts
- **Open-Meteo** — weather + history
- **GitHub API** — for company/person targets
- **HackerNews API** — for topic targets
- **GDELT** — global events

**Implementation pattern**: each tool gets a function in `apis.ts` returning typed data. A skill's `procedure_md` references tools by name. `runResearch` collects all tool outputs and feeds them to the LLM alongside Brave snippets.

**Risk of overreach**: don't wire everything. Pick 2–3 tools that match your actual research targets. More tools = more context for the LLM = more cost + cognitive load on the model.

### Level 4 — True agentic tool-use loop
The LLM iteratively calls tools, sees results, decides next steps, calls more tools, then writes. Requires real function-calling support — Claude and GPT do this cleanly; Workers AI Llama is more limited.

Only do this when (a) skills are too rigid to express what you need, or (b) you've moved chat to Anthropic via AI Gateway and want to use Sonnet/Opus's tool-use directly.

---

## Cost trajectory

| Phase | Brave/mo | Workers AI | Anthropic | Approx total |
|---|---|---|---|---|
| v4 (now) | 2k free | 10k/day free | 0 | £0 |
| v4 + Workers Paid | 2k free | 10M/mo included | 0 | $5/mo |
| Level 2 + Workers Paid | 2k free + ~$3 | ~+1M neurons | 0 | $8/mo |
| Level 3 (typed tools) + Paid | 2k free + ~$3 | similar | 0 | $8/mo |
| Level 4 (Anthropic) | + Brave | embeddings only | $10–30 | $15–35/mo |

Hobby usage stays under $10/mo through Level 3. Anthropic gets serious only at Level 4.

---

## Decisions made + not made

### Made
- **Single platform** = Cloudflare. Unified billing, one dashboard.
- **Skills as markdown procedures** (not code adapters). User-editable, agent-synthesisable.
- **One agent**, not multiple specialised agents. Skills do the specialisation.
- **Three layers**: Target / Skill / Report. Nothing else needed for v1.
- **Workers AI chat models** as default. Anthropic deferred until specific need.
- **Brave Search** for web access. Free tier covers initial use.

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
- **Browser-rendering Google SERPs**: ToS issues, brittle, expensive vs Brave.
- **Pre-built personas**: too rigid; let skills define personality.
- **Tool-call loop in v4**: complexity not warranted yet at current quality bar.

---

## "What to do next" — practical answer for future sessions

If quality of v4 reports is the bottleneck → **start Level 2** (fetch full page content).

If specific repeated research patterns emerge → **Level 3 tools** for those patterns.

If Workers AI is too thin/dry for the kind of writing the user wants → wire Anthropic via AI Gateway Unified Billing, keep everything else.

If hitting Brave's monthly cap → upgrade Brave plan ($3–9/mo for more queries) before considering alternatives. Brave is the cheapest fit for AI agents currently.

---

## What's not on this roadmap

This is a *research-report agent*. Things that would change what it is:
- Conversational chat interface
- Real-time streaming responses
- Multi-user accounts
- Marketplace for skills

None of those are wrong, but they'd reshape the project. If any becomes interesting, the conversation is "should this still be WatchOMacho or a new project?"
