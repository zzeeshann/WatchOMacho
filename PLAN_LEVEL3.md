# WatchOMacho Level 3 — multi-tool refactor + four UK typed tools + Tailwind R2

> **Goals for this session:**
> 1. Phase A — finish Phase 12 of `PLAN.md`: replace Tailwind CDN with a built CSS bundle served from R2.
> 2. Phases B–F — Level 3 from `ROADMAP.md`: make the agent multi-tool aware, then wire four UK public-data tools (Land Registry, ONS, data.police.uk, Companies House) alongside Tavily.
>
> Working assumption confirmed with the user: a skill can declare multiple tools. So `parseSkillTools` returns a *list* of tool calls, `gatherSources` dispatches over the list, and the TOOLS registry stops being Tavily-shaped.

---

## 0. Pre-flight state (2026-05-17)

- Tavily + Tailwind shipped per `PLAN.md` Phases 0–11. Worker version `7a022dd5-...` live at watchomacho.daylila.com.
- `src/` is clean of Brave/Wikipedia/Nominatim references — verified.
- Brave secret deleted on 2026-05-17. Brave subscription cancellation is on the user's side, any time.
- Memory file `project_v4_state_and_roadmap.md` is current. Will be updated again at end of this session.

---

## 1. Why this shape (decision log for this session)

| Decision | Rationale |
|---|---|
| **Skills can declare multiple tools** | A "postcode deep-dive" skill naturally wants Tavily news + Land Registry prices + (later) data.police.uk crime. Single-tool-per-skill would force one-of-each-question skills, multiplying skills proportional to facets. |
| **All four UK tools in one push** | User asked for all of them. They share the same `gatherSources` dispatch + parser plumbing, so cost is amortised. Marginal cost per tool after the first is ~40 lines (function + TOOLS entry + parser case + markdown header doc). |
| **Land Registry / ONS / data.police.uk are keyless; Companies House needs free key** | All four are free. Three need no setup. Companies House requires a one-off registration at `developer.company-information.service.gov.uk` and a `CH_API_KEY` secret. Tool short-circuits to `[]` if the secret is missing — same pattern as Tavily today. |
| **Flatten structured tool output to markdown tables for the LLM** | The writer LLM today reads `GatheredSource[]` with `{title, url, content}` strings. Land Registry returns rows; ONS returns numbers; data.police.uk returns crime objects. Simplest path: render each tool's result to a markdown snippet (`content`), set `url` to the source API endpoint, set `title` to the human-readable label. Writer prompt unchanged. |
| **TOOLS registry generalises shape** | Today it has Tavily-only `when_to_use_search` and `when_to_use_extract` fields. Refactored to per-operation `{ description, when_to_use }` so any tool plugs in. Also adds `summary` (one-line tool intro) and `headers` (the markdown header keys a skill uses to invoke this tool). |
| **`SKILL_TEMPLATE` becomes dynamic** | Today the catalog is hard-coded prose. Reformed to `buildSkillTemplate(TOOLS)` so any new tool surfaces in synthesis automatically. The static `SKILL_TEMPLATE` string is replaced by a function. |
| **Tailwind built CSS in same R2 bucket** | `watchomacho-reports` under `static/` prefix. No new wrangler binding. Versioned filename (`tailwind.v1.css`) with `immutable` cache so cache busting = filename bump. |
| **`tailwindcss` v3 + CLI as devDeps only** | Tailwind v4 is alpha-ish; v3 is stable and the daylila site is on it. Dev-deps only — never bundled into the Worker. Build is a local `npm run build:css` step run before deploy. |
| **Don't add a `build:css` precondition to `wrangler deploy`** | Keep them independent. If you only changed `agent.ts`, you don't need to re-build CSS. If you only added a class to dashboard.ts, you need to re-build CSS but don't need to bump filename version. Versioning is opt-in for cache busting. |
| **No new D1 schema** | Same principle as PLAN.md: skill markdown headers carry all per-tool config. No new tables, no new columns. |
| **Per-tool config in skill markdown** | Each tool reads its own headers (e.g. `**Land Registry op:** sold-prices`, `**Months:** 6`). The parser returns a `SkillToolCall[]`; each entry knows its tool slug and op-specific params. |

---

## 2. Non-goals

- ❌ Tailwind v4 (stable v3 is fine; one upgrade at a time)
- ❌ A new R2 bucket for static assets (same bucket is enough)
- ❌ Per-tool budget gates (today's `daily_search_limit` covers Tavily; new tools are free and rate-limited only by the upstream APIs)
- ❌ Caching of typed-tool responses in D1/R2 (each run fetches fresh; revisit only if upstream rate limits bite)
- ❌ Sub-tool selection by LLM at gather time (the skill declares which tools; the LLM doesn't decide mid-run — that's Level 4)
- ❌ Schema changes
- ❌ Astro / MDX / a build pipeline for code (TypeScript stays as-is; only Tailwind gets a build step)
- ❌ Per-target chat-model overrides (still deferred)
- ❌ Removing Tavily — it stays as the primary tool

---

## 3. Phases (in execution order)

### Phase A — Tailwind R2 production bundle

A1. `npm i -D tailwindcss@^3` (CLI ships with this package; no extra `@tailwindcss/cli` needed for v3).

A2. New files at repo root:
   - `tailwind.config.js` — mirror the inline `tailwind.config` block from `shell()`. `content: ["./src/**/*.ts"]`.
   - `tailwind.input.css` — three `@tailwind` directives.

A3. Add to `package.json` scripts:
   ```json
   "build:css": "tailwindcss -i tailwind.input.css -o tailwind.css --minify"
   ```

A4. Run `npm run build:css`. Produces `tailwind.css` (~10–15 KB minified).

A5. Upload:
   ```
   npx wrangler r2 object put watchomacho-reports/static/tailwind.v1.css \
     --file tailwind.css \
     --content-type "text/css" \
     --cache-control "public, max-age=31536000, immutable"
   ```

A6. New route in `src/index.ts`:
   ```ts
   if (path === "/static/tailwind.v1.css" && req.method === "GET") {
     const obj = await env.REPORTS.get("static/tailwind.v1.css");
     if (!obj) return new Response("Not found", { status: 404 });
     return new Response(obj.body, {
       headers: {
         "content-type": "text/css; charset=utf-8",
         "cache-control": "public, max-age=31536000, immutable",
       },
     });
   }
   ```
   (Outside `withSecurityHeaders` — static assets don't need the CSP for themselves.)

A7. In `src/dashboard.ts` `shell()`:
   - Remove `<script src="https://cdn.tailwindcss.com"></script>` and the entire `<script>tailwind.config = {...}</script>` block.
   - Add `<link rel="stylesheet" href="/static/tailwind.v1.css">`.

A8. Tighten CSP in `src/index.ts`: drop `https://cdn.tailwindcss.com` from `script-src`. `style-src` already includes `'self'`. Final CSP: `script-src 'self' 'unsafe-inline'`.

A9. `.gitignore` — add `tailwind.css` (built artifact, lives in R2, not in repo).

A10. `npx tsc --noEmit` → `npx wrangler deploy` → pixel-parity check on `/`, `/admin`, `/admin/skills`, `/admin/tools`, `/admin/login`. Console clean (no "not for production" warning, no 404 on the CSS asset).

**Bump procedure if a class is added later:** rebuild → `tailwind.v2.css` → re-upload → bump filename in route + `<link>`.

---

### Phase B — Multi-tool refactor

B1. **Generalise `TOOLS` registry shape** in `src/apis.ts`:
   ```ts
   export interface ToolHeader {
     key: string;            // e.g. "Tavily op", "Months"
     values: string;         // human-readable values column
   }
   export interface ToolOperation {
     description: string;
     when_to_use: string;
   }
   export interface ToolEntry {
     slug: string;
     display: string;
     summary: string;
     operations: Record<string, ToolOperation>;
     headers: ToolHeader[];
   }
   export const TOOLS: Record<string, ToolEntry> = { ... };
   ```
   Migrate the current Tavily entry to this shape. No behaviour change yet.

B2. **Rewrite `parseSkillTools`** in `src/agent.ts`:
   ```ts
   export interface SkillToolCall {
     tool: string;                       // slug, e.g. "tavily" | "land_registry"
     op: string;                         // e.g. "search" | "sold-prices"
     params: Record<string, string>;     // header → value
     sources?: string[];                 // only Tavily extract uses this
   }
   export function parseSkillTools(md: string): SkillToolCall[];
   ```
   Logic: scan each tool entry in TOOLS, look for its `**{Tool display} op:**` header in `md`. If found, build a `SkillToolCall`; collect every per-tool header listed in `tool.headers` (except the op header itself) into `params`. If no tool is declared, default to a single Tavily-search call (backwards compat with existing skills).

B3. **Rewrite `gatherSources`** in `src/agent.ts`:
   ```ts
   async function gatherSources(env, queries, calls: SkillToolCall[]): Promise<GatheredSource[]> {
     const out: GatheredSource[] = [];
     for (const c of calls) {
       switch (c.tool) {
         case "tavily":         out.push(...await gatherTavily(env, queries, c)); break;
         case "land_registry":  out.push(...await gatherLandReg(env, c, target)); break;
         case "ons":            out.push(...await gatherOns(env, c, target)); break;
         case "police":         out.push(...await gatherPolice(env, c, target)); break;
         case "companies_house":out.push(...await gatherCompaniesHouse(env, c, target)); break;
       }
     }
     // existing per-source content cap + total-source cap, unchanged
     return out;
   }
   ```
   Each `gatherX` is a thin wrapper that calls the typed function in `apis.ts`, then flattens to `{ title, url, content }` markdown.
   **Note:** `gatherSources` will need `target` (it gets `target.name` and possibly `target.kind`). Today it doesn't — refactor signature to accept it.

B4. **`SKILL_TEMPLATE` → `buildSkillTemplate(tools)`** in `src/agent.ts`. Generates the catalog prose dynamically from the TOOLS registry. Each tool gets:
   ```
   {display} ({summary})
     Operations:
       - {op_name}: {op.description}
                    When to use: {op.when_to_use}
     Headers:
       - **{key}:** {values}
   ```
   Called once per `synthesizeSkill` invocation, passed in place of the static `SKILL_TEMPLATE`.

B5. **Wire `parseSkillTools` to return list** — update `runResearch` to call `parseSkillTools` → `SkillToolCall[]`, pass into `gatherSources`. The "no queries planned" short-circuit only applies if every call is non-search (e.g. only Land Registry + Police = no LLM planning needed).

B6. `SKILL_TEMPLATE`'s "Search queries" section becomes optional: only generated if at least one tool call is `tavily search`.

---

### Phase C — Four typed UK tools in `apis.ts`

#### C1. Land Registry sold-prices

```ts
export interface LandRegSoldPrice {
  paid_pence: number;       // pence (raw)
  paid_display: string;     // "£325,000"
  date: string;             // ISO yyyy-mm-dd
  address: string;
  type: string;             // detached | semi-detached | terraced | flat | other
}

export async function landRegSoldPrices(
  postcode: string,
  opts: { months?: number; limit?: number } = {},
): Promise<LandRegSoldPrice[]>;
```

Uses HM Land Registry Open Data SPARQL endpoint (`landregistry.data.gov.uk/landregistry/query`). POST with a SPARQL query filtering by postcode + date >= cutoff. No key.

Skill markdown headers (per `TOOLS.land_registry.headers`):
- `**Land Registry op:** sold-prices` (required)
- `**Months:** 6` (optional, default 12)
- `**Limit:** 25` (optional, default 50)

#### C2. ONS API

```ts
export interface OnsStat {
  label: string;            // "Population (2021 census)"
  value: string;            // "12,450"
  source: string;           // ONS dataset slug
}

export async function onsStats(
  area: string,             // postcode or place name; we'll resolve to LSOA/MSOA internally
  topics: ("population" | "deprivation" | "demographics")[],
): Promise<OnsStat[]>;
```

Uses ONS Beta API (`api.beta.ons.gov.uk`). No key. We'll start with a small fixed set of "interesting numbers per postcode" rather than exposing the full API — keeps the LLM input tight.

Skill headers:
- `**ONS op:** stats` (required)
- `**Topics:** population, deprivation, demographics` (optional, comma-separated; default all three)

#### C3. data.police.uk

```ts
export interface PoliceCrime {
  category: string;         // "anti-social-behaviour" | "violent-crime" | ...
  month: string;            // "2026-03"
  street: string;
  outcome?: string;
}

export async function policeCrimes(
  postcode: string,
  opts: { months?: number } = {},
): Promise<PoliceCrime[]>;
```

Two-step: (a) postcode → lat/lng via postcodes.io (free, no key), (b) crimes-street/all-crime endpoint on data.police.uk. No key. We aggregate by category before flattening to markdown (raw list would be hundreds of rows).

Skill headers:
- `**Police op:** crimes` (required)
- `**Months:** 3` (optional, default 3 — data.police.uk only goes back ~36 months and one-month-at-a-time)

#### C4. Companies House

```ts
export interface CompaniesHouseHit {
  name: string;
  number: string;           // company number
  status: string;           // active | dissolved | liquidation
  address: string;
  type: string;             // ltd | llp | plc | ...
  incorporated?: string;    // yyyy-mm-dd
}

export async function companiesHouseSearch(
  apiKey: string | undefined,
  query: string,
  opts: { limit?: number; postcode?: string } = {},
): Promise<CompaniesHouseHit[]>;
```

Uses Companies House API (`api.company-information.service.gov.uk`). HTTP Basic auth with the API key as the username (no password). If `opts.postcode` is set, post-filter the search hits by registered office postcode.

Skill headers:
- `**Companies House op:** search | by-address` (required)
- `**Limit:** 10` (optional, default 10)
- `**Postcode:** {target}` (optional, used by by-address op)

#### C5. Per-tool `TOOLS` entries

One entry per tool slug above. Each entry follows the new `ToolEntry` shape. Tavily entry stays but migrates to the new shape too. `summary` per tool:

- Tavily: "Web search and full-page extraction. Two operations."
- Land Registry: "UK property sold-price history by postcode. One operation."
- ONS: "UK population, deprivation, and demographic stats by area. One operation."
- Police: "UK crime stats by postcode for the last 3–36 months. One operation."
- Companies House: "UK company search by name or by registered-office address. Two operations."

---

### Phase D — `/admin/tools` generalisation

`renderAdminTools` currently assumes Tavily-shaped tool entries (`when_to_use_search`, `when_to_use_extract`). Refactor to iterate the new shape:
- Tool card title = `display`
- Subhead = `summary`
- Operations table: op name, description, when_to_use
- Headers section: list of `{ key, values }`

`renderAdminSkills` synthesis help text: stays high-level — "the agent has multiple tools; see /admin/tools for the catalog." No per-tool snippets there; that lives on `/admin/tools`.

---

### Phase E — Docs

E1. `README.md` — toolbox section: list all 5 tools with one-liners. Update concepts to mention multi-tool skills.
E2. `ARCHITECTURE.md` — research-loop diagram: `gather` step now dispatches over a list of tool calls, not a single Tavily op. File responsibilities table: note `apis.ts` has 5 tools.
E3. `BOOK.md` — `apis.ts` walkthrough chapter: walk through each tool function. Research-loop chapter: explain `SkillToolCall[]` shape.
E4. `ROADMAP.md` — mark Level 3 as *in progress* / *initial four tools delivered*. Move Land Registry / ONS / Police / Companies House out of "candidates" into "delivered".
E5. Memory file `project_v4_state_and_roadmap.md`:
   - Update current deployed version
   - Add Level 3 status
   - Note CH_API_KEY secret added (if user set it)
   - Note Tailwind R2 bundle replaces CDN

---

### Phase F — Deploy & verify

F1. `npx tsc --noEmit`
F2. `npx wrangler deploy`
F3. Test each tool with a purpose-built skill:
   - **Land Registry test skill**: name "Postcode property pulse", brief "Recent sold prices for a UK postcode, last 6 months." Test target: "SW1A 1AA" or similar.
   - **ONS test skill**: "Area census stats." Same target.
   - **Police test skill**: "Local crime pulse." Same target.
   - **Companies House test skill** (only if CH_API_KEY is set): "Businesses registered at this address." Same target.
   - **Multi-tool skill**: "Full postcode dossier" — combines Tavily + Land Registry + ONS + Police in one skill. Verify the report ingests all four sources cleanly.
F4. Tavily-only skills still work (backwards compat).
F5. Console clean; no CSP violations; no 404s.

---

## 4. User actions required

| Action | When | Why |
|---|---|---|
| Register for free Companies House API key at `developer.company-information.service.gov.uk` | Before Phase F multi-tool verify | Companies House tool is gated on `CH_API_KEY`; without it the tool returns `[]` (other tools unaffected) |
| `wrangler secret put CH_API_KEY` (paste the key) | After registration | Worker reads the secret |
| Cancel Brave $5/mo subscription at api-dashboard.search.brave.com | Whenever | Code already off Brave entirely |
| Confirm whether to clean up stale local worktrees `charming-williams-8e6609` and `quizzical-goodall-d1a6c3` | End of session | I'll surface this — don't touch without your nod |

---

## 5. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Land Registry SPARQL query timeout on big postcodes | Low | Cap by `months` + `limit`; on error return `[]` (tool short-circuits cleanly) |
| ONS Beta API returns inconsistent area codes | Medium | Hard-code a small set of "interesting numbers" rather than dynamic resolution; if no match, skip silently |
| data.police.uk only covers England/Wales/NI (no Scotland) | Inherent | Document in tool `when_to_use`; skill author picks the tool appropriately |
| postcodes.io rate-limit | Low | Free for reasonable use; one call per Police lookup; cache in-memory per request only |
| Companies House requires key → user forgets to set it | Medium | Tool short-circuits to `[]` with a console.warn; other tools keep working; multi-tool skills degrade gracefully |
| Multi-tool skill blows past LLM context window | Medium | Existing `MAX_CHARS_PER_SOURCE` (4000) + total-source cap of 20 still applies. Per-tool flattened content kept short. |
| Tailwind R2 asset 404 on first load after deploy | Low | Upload happens *before* deploy. CDN is dropped *after* the deploy succeeds with the link tag working. |
| Tailwind class added later but build step skipped | Medium | Document in `BOOK.md`; consider adding a hook later. Out of scope this session. |

---

## 6. What this preserves (zero migrations)

- D1 schema — unchanged
- R2 bucket — unchanged (new `static/` prefix only)
- Vectorize — unchanged
- Existing skills — work without edit (Tavily defaults still kick in when no other tool declared)
- Admin UI — same structure; `/admin/tools` shows 5 tools instead of 1
- Cron behaviour — unchanged
- Tavily as primary tool — unchanged

---

## 7. Definition of done

- `npx tsc --noEmit` is clean
- `npx wrangler deploy` succeeded
- `/static/tailwind.v1.css` returns 200 with `text/css`; pages render pixel-equivalent to current; console clean (no Tailwind CDN warning)
- `/admin/tools` shows 5 tool cards
- `parseSkillTools()` returns `SkillToolCall[]`; default is single-Tavily-search for headerless skills
- Each new tool has been exercised by a test skill at least once (Companies House gated on user setting `CH_API_KEY`)
- A multi-tool skill ("Full postcode dossier") produces a report combining at least 3 sources
- README / ARCHITECTURE / BOOK / ROADMAP / memory file updated
- No new dependencies in the *runtime* bundle (Tailwind is dev-deps only; typed-tool functions use plain `fetch`)

---

## 8. Out of scope (deferred — write down so we don't drift)

- Per-tool budget gates beyond `daily_search_limit`
- Caching typed-tool responses
- More tools (EPC Open Data, TfL, OpenStreetMap, OpenAlex, etc.)
- LLM-decided tool selection at gather time (Level 4)
- Anthropic via AI Gateway (Level 4)
- Per-target chat-model overrides
- Skill versioning / history
- Tailwind v4 migration
- Splitting the Worker into multiple files
