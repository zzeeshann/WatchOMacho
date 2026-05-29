# Day-Map v2 — implementation spec

> ⚠️ **SUPERSEDED (2026-05-29).** This spec proposed a *JSON graph + code-drawn
> hub-and-spoke SVG*. The feature that was actually built (v14) took a different
> shape after discussion: a **lab-style self-contained interactive HTML** page,
> written free-form by one LLM call, embedded in a sandboxed iframe and served
> under a no-network CSP — concrete/news-specific, overview + beats, no JSON
> schema and no SVG renderer. WatchOMacho ships the finished HTML; daylila is
> just the presenter. See README / ARCHITECTURE / ROADMAP for the real design.
> Kept below as historical context only.

Status: **designed, not built.** This is the handoff for the next session. The
current shipped feature is the v13 "comic" (a linear panel SVG). This spec
**replaces** it with a richer "map of the day". Nothing is live on daylila yet,
so we can swap freely.

---

## 1. What it is

After a briefing is written, one LLM pass turns it into a **structured graph of
the day** — the single connecting thread (*spine*), the major forces (*nodes*),
and the cause→effect links between them (*edges*). That structure is:

1. **stored as JSON** and returned on the reports API → daylila renders it
   natively (its own design system, responsive, can link nodes to the briefing
   beats), and
2. **rendered to an SVG** stored in R2 and served at its own URL → a drop-in
   image / OG / fallback shown *before* the story starts.

The edges (relationships) are the whole point — they make it a *map* of how the
day connects, not a list of headlines.

## 2. Decisions locked (do not relitigate)

- **JSON + a rendered URL** — expose both. JSON is the real deliverable for
  daylila; the URL is the portable image.
- **One overview map** per briefing — NOT a separate graphic per section. But
  tag each node with its `section` index so daylila can decorate the existing
  beats from the same data later (free, no second pipeline).
- **SVG** for the rendered artifact (crisp, tiny, real text, restyleable). No
  raster, no OG-raster for now.
- **Single LLM call.** No second pass, no critique, no fact-check — the briefing
  is already verified. Finding the spine and the graph is one piece of
  reasoning; splitting it would only cost tokens.
- **No Cloudflare AI / Workers AI / image-gen (Flux etc.).** Stay on the
  existing Anthropic path via AI Gateway (`getChatModel()` default
  `anthropic/claude-sonnet-4-6`). The only Workers-AI use in the app stays the
  embedding model for recall — do not add more.
- **Feed the FULL briefing body** to the call. The v13 comic sliced to 6000
  chars (~first half of a ~1,800-word briefing) — that was the "doesn't cover
  the whole briefing" bug. Send all of it.

## 3. The structured object (`day_map`)

```jsonc
{
  "headline": "string ≤60 chars — punchy title of the day",
  "spine":    "string ≤200 chars — the ONE connecting thread, single sentence",
  "hub":      "node id everything runs through (optional; null if no clear hub)",
  "nodes": [                       // 3–7
    {
      "id":      "hormuz",          // short slug, unique within this map
      "label":   "≤24 chars",       // e.g. "Hormuz closed"
      "summary": "≤110 chars, one line — what it is / what happened",
      "section": 1,                 // 1-based briefing section index (optional)
      "category":"energy"           // → icon; see enum below
    }
  ],
  "edges": [                       // 0–8 — the cause→effect arrows
    { "from": "hormuz", "to": "inflation", "label": "≤24 chars (optional)" }
  ]
}
```

`category` enum (each maps to an icon in the renderer; extend the existing
`comicIcon` set): `conflict, market-up, market-down, economy, energy,
diplomacy, alert, tech, climate, default`. Unknown → `default`.

## 4. The single LLM call

Reuse the `runChat(env, await getChatModel(env), {...}, signal)` pattern and the
"grab the `{…}` and `JSON.parse`" approach already used by `planResearch`
(src/agent.ts).

**System prompt (verbatim intent):**

> You turn a finished, fact-checked daily news briefing into a structured "map
> of the day" — a small graph showing the one thread that connects the day's
> stories. Output ONLY a JSON object: `{headline, spine, hub, nodes, edges}`,
> no prose.
>
> Rules:
> - Read ALL sections first, then pick the SINGLE hub/thread the day runs
>   through.
> - 3–7 nodes, one per major force/story. Tag each with its `section` number
>   (1-based, in briefing order) and a `category` from: conflict, market-up,
>   market-down, economy, energy, diplomacy, alert, tech, climate, default.
> - `edges` express cause→effect (`from` → `to`) with a 2–4 word `label`. Prefer
>   edges that fan out from the hub.
> - Lengths: headline ≤60, spine ≤200 (one sentence), label ≤24, summary ≤110.
>   Single-line plain text, no markdown, no quotes, no emoji.
> - Invent no new facts — only reshape what the briefing already states. The
>   spine is the EDITORIAL point (what the day was really about), not a summary.

**User message:**
```
BRIEFING TITLE
<title>

EDITORIAL SUMMARY
<report.snippet / summary>

SECTIONS (in order)
1. <## heading 1>
2. <## heading 2>
...

BRIEFING BODY
<full body — NO truncation>

Return the JSON now.
```
(`max_tokens` ~1200. Extract section headings by matching `^##\s+(.+)$` lines in
the body.)

**Parse + validate:**
- Match `/\{[\s\S]*\}/`, `JSON.parse`. On failure → return null (skip, like v13).
- Require 2–7 nodes with unique ids; drop edges whose `from`/`to` don't match a
  node id; clamp all string lengths; map unknown `category`→`default`; coerce
  `hub` to null if it isn't a node id.
- If <2 nodes survive → skip (best-effort; never fail the briefing).

## 5. SVG render (`renderDayMapSvg`)

Replace the linear-panel layout with a **hub-and-spoke map**:
- Header band: `headline` (bold) + `spine` (wrapped) in brand palette.
- Hub node centered; satellite nodes placed on a ring around it (angle =
  `360/N`). Cap N at ~6 so labels don't collide (fixed canvas ~900×600).
- Each edge = a connector line hub→node (or node→node) with its `label` at the
  midpoint.
- Each node = a small rounded card: `label` (bold) + category icon + optional
  `section` badge.
- Footer: `WatchOMacho` · target · UTC date.
- Reuse `escapeXml`, `wrapText` (already hardened against unbroken tokens),
  brand `COMIC`/rename to `DAYMAP` color consts.
- Keep it bulletproof: deterministic geometry, height/positions derived from N,
  all text escaped. daylila renders the JSON fancier; the SVG only needs to be
  clean + correct.

A standalone render harness (copy the pure functions into a `.mjs`, feed a
sample spec, eyeball the SVG) is the fastest way to iterate — that's how the v13
SVG was verified.

## 6. Storage / API / routes / functions

All of this maps onto the existing v13 surface — mostly rename comic→day_map and
reshape the payload.

**D1 (new `migration-v14.sql` + `schema.sql`):**
- Add `reports.day_map_json TEXT` (the structured object).
- Rename (or repurpose) `reports.comic_r2_key` → `day_map_r2_key`,
  `reports.comic_slug` → `day_map_slug`. SQLite has no easy column rename mid-
  history; simplest is to ADD `day_map_*` columns and leave the comic ones
  unused, OR (cleaner, since nothing's live) just keep the `comic_*` names and
  store the new SVG there. Pick one; document it.
- `targets.comic_enabled` and the `comics_enabled` setting can stay as-is
  (rename to `day_map_*` only if you want tidy naming).

**src/agent.ts:**
- `planComic` → `planDayMap` — returns the graph object (section 4).
- `renderComicSvg` → `renderDayMapSvg` — hub-and-spoke (section 5).
- `makeComic` → `makeDayMap` — write `day_map_json` to D1, SVG to R2, link it;
  keep best-effort try/catch + `*_last_ok_at`/`*_last_error` heartbeat.
- The `runResearch` hook (after persist, gated by `comicEnabledForTarget`) —
  unchanged except the function name. **Feed it the full `body`.**
- `Report` interface: add `day_map_json`; keep/rename the r2/slug fields.
- `findOrphanedR2` + `deleteReport`/`deleteTarget`: keep the rendered-SVG key in
  the "known/keep" set and delete it on report delete — same guard as v13, just
  the renamed column.

**src/index.ts:**
- `GET /comic/:id` → `GET /day-map/:id` — serves the SVG from R2 (unchanged
  otherwise; public, HEAD-safe).
- `GET /api/reports/:id` → return `day_map` (parsed `day_map_json`) +
  `day_map_url`. Drop the inline-SVG field (daylila renders the JSON; the URL
  covers the image case).
- `GET /api/reports/recent` → return `day_map_url` + `headline` (slim).
- Settings + target-update handlers: only touched if you rename the
  enable flag.

**src/dashboard.ts:**
- Report page embed + admin activity link: point at `/day-map/:id`.
- Admin toggles (global + per-target): rename labels if you renamed the flag.

## 7. Cost

One Anthropic call: full briefing (~3–4k tokens) in, ~1k out. Same order as the
current comic, no extra calls, no Cloudflare AI.

## 8. Implementation checklist

1. `migration-v14.sql` + `schema.sql` (day_map_json + r2/slug naming decision).
2. `planDayMap` (full briefing in → graph JSON, validated).
3. `renderDayMapSvg` (hub-and-spoke; verify with a standalone harness).
4. `makeDayMap` (D1 JSON + R2 SVG; best-effort) + rename the `runResearch` hook.
5. API: `day_map` + `day_map_url` on `/api/reports/:id`; slim on `/recent`;
   rename route to `/day-map/:id`.
6. dashboard embeds/links/labels.
7. Docs: README API table, ARCHITECTURE (pipeline step + data model + R2 layout
   + routes), ROADMAP shipped entry.
8. `npx tsc --noEmit` clean; render harness eyeball; then user runs
   `wrangler d1 execute … migration-v14.sql` + `wrangler deploy`.

## 9. What "good" looks like

Someone lands on the briefing, sees the day-map first, and in ~3 seconds gets
*the shape of the day* — the one thread and how the big stories hang off it —
then reads on. Accurate (extracted from verified prose), on-brand, fast, cheap,
never tone-deaf.
