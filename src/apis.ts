// External data sources for the research agent.
//
// Five tools, registered below in TOOLS:
//   tavily              — keyword web search + URL extraction
//   land_registry       — UK property sold-price history by postcode
//   ons                 — UK postcode geographic + demographic context (via postcodes.io)
//   police              — UK street-level crime by postcode (via data.police.uk)
//   companies_house     — UK company search by name or registered-office postcode
//
// All five are free. Companies House requires a free API key (set as
// CH_API_KEY secret). Everything else is keyless.
//
// Each `*X*()` function below returns `[]` (never throws) when the upstream
// API errors, the key is missing, or the input is unusable. Callers don't
// need try/catch — they just get fewer sources in the report.

const UA = "WatchOMacho/4 (research agent on Cloudflare Workers)";

// ─── Generalised TOOLS registry shape ─────────────────────────────────────

export interface ToolHeader {
  key: string;            // e.g. "Tavily op", "Months", "Postcode"
  values: string;         // human-readable description of accepted values
}

export interface ToolOperation {
  description: string;
  when_to_use: string;
}

export interface ToolEntry {
  slug: string;
  display: string;
  summary: string;        // one-line tool intro
  operations: Record<string, ToolOperation>;
  headers: ToolHeader[];  // skill markdown headers this tool reads
}

// ─── Tavily ───────────────────────────────────────────────────────────────

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

/** One Tavily search. Returns up to `max_results` results, each with the
 *  page's extracted content. Returns [] if no key is configured or the API
 *  errored — calling skill will write a thinner report. */
export async function tavilySearch(
  apiKey: string | undefined,
  query: string,
  options: TavilySearchOptions = {},
  signal?: AbortSignal,
): Promise<TavilySearchResult[]> {
  if (!apiKey) {
    console.warn("tavilySearch: TAVILY_API_KEY not set, skipping query:", query);
    return [];
  }
  const q = query.slice(0, 400).trim();
  if (!q) return [];
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      api_key: apiKey,
      query: q,
      search_depth: options.search_depth ?? "basic",
      topic: options.topic ?? "general",
      time_range: options.time_range,
      max_results: options.max_results ?? 5,
      include_raw_content: true,        // we want the page text
    }),
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.warn(`tavilySearch ${r.status} for "${q}": ${body.slice(0, 200)}`);
    return [];
  }
  const data: any = await r.json();
  return (data.results ?? []).map((h: any) => ({
    title: String(h.title ?? "").trim(),
    url: String(h.url ?? "").trim(),
    content: String(h.raw_content ?? h.content ?? ""),
    score: Number(h.score ?? 0),
    published_date: h.published_date,
  }));
}

export interface TavilyExtractResult {
  url: string;
  raw_content: string;
}

/** Read a list of URLs in full via Tavily's /extract endpoint. Up to 20 URLs
 *  per call. Returns [] on no key, empty input, or API error. */
export async function tavilyExtract(
  apiKey: string | undefined,
  urls: string[],
  extract_depth: "basic" | "advanced" = "basic",
  signal?: AbortSignal,
): Promise<TavilyExtractResult[]> {
  if (!apiKey || urls.length === 0) return [];
  const r = await fetch("https://api.tavily.com/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({
      api_key: apiKey,
      urls: urls.slice(0, 20),
      extract_depth,
    }),
    signal,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.warn(`tavilyExtract ${r.status}: ${body.slice(0, 200)}`);
    return [];
  }
  const data: any = await r.json();
  return (data.results ?? []).map((res: any) => ({
    url: String(res.url ?? ""),
    raw_content: String(res.raw_content ?? ""),
  }));
}

// ─── Postcode helper (shared by ons + police) ─────────────────────────────

interface PostcodeLookup {
  postcode: string;
  lat: number;
  lng: number;
  country: string;
  region: string | null;
  admin_district: string | null;
  admin_ward: string | null;
  parliamentary_constituency: string | null;
  lsoa: string | null;
  msoa: string | null;
  parish: string | null;
}

/** Look up a UK postcode via postcodes.io. Returns null if not found / on
 *  error. Used by tools that need lat/lng or area-code context. */
async function lookupPostcode(postcode: string): Promise<PostcodeLookup | null> {
  const clean = postcode.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{1,2}[0-9R][0-9A-Z]?[0-9][A-Z]{2}$/.test(clean)) return null;
  const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`, {
    headers: { "User-Agent": UA },
  });
  if (!r.ok) return null;
  const data: any = await r.json();
  const p = data.result;
  if (!p) return null;
  return {
    postcode: String(p.postcode),
    lat: Number(p.latitude),
    lng: Number(p.longitude),
    country: String(p.country ?? ""),
    region: p.region ?? null,
    admin_district: p.admin_district ?? null,
    admin_ward: p.admin_ward ?? null,
    parliamentary_constituency: p.parliamentary_constituency ?? null,
    lsoa: p.lsoa ?? null,
    msoa: p.msoa ?? null,
    parish: p.parish ?? null,
  };
}

// ─── HM Land Registry — sold prices by postcode ───────────────────────────

export interface LandRegSoldPrice {
  paid_pence: number;       // pence (integer)
  paid_display: string;     // "£325,000"
  date: string;             // yyyy-mm-dd
  paon: string;             // primary addressable object name (house number)
  saon: string;             // secondary addressable object name (flat number)
  street: string;
  town: string;
  postcode: string;
  type: string;             // "detached" | "semi-detached" | "terraced" | "flat" | "other"
}

/** Query HM Land Registry's open-data SPARQL endpoint for sold-price history
 *  in a single postcode. Free, keyless. Returns [] on bad postcode, network
 *  error, or no results. */
export async function landRegSoldPrices(
  postcode: string,
  opts: { months?: number; limit?: number } = {},
): Promise<LandRegSoldPrice[]> {
  const months = Math.max(1, Math.min(120, opts.months ?? 12));
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const pc = postcode.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{1,2}[0-9R][0-9A-Z]?[0-9][A-Z]{2}$/.test(pc)) return [];
  // Land Registry stores postcodes with a single space between outward and
  // inward parts (e.g. "SW1A 1AA").
  const spaced = pc.slice(0, -3) + " " + pc.slice(-3);

  const cutoffDate = new Date(Date.now() - months * 30 * 86400 * 1000)
    .toISOString().slice(0, 10);

  const sparql = `
    PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
    PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>

    SELECT ?amount ?date ?paon ?saon ?street ?town ?type
    WHERE {
      ?addr lrcommon:postcode "${spaced}" .
      ?transx lrppi:propertyAddress ?addr ;
              lrppi:pricePaid ?amount ;
              lrppi:transactionDate ?date ;
              lrppi:propertyType ?ptype .
      OPTIONAL { ?addr lrcommon:paon ?paon }
      OPTIONAL { ?addr lrcommon:saon ?saon }
      OPTIONAL { ?addr lrcommon:street ?street }
      OPTIONAL { ?addr lrcommon:town ?town }
      BIND(STRAFTER(STR(?ptype), "common/") AS ?type)
      FILTER(?date >= "${cutoffDate}"^^xsd:date)
    }
    ORDER BY DESC(?date)
    LIMIT ${limit}
  `;

  const url = `https://landregistry.data.gov.uk/landregistry/query?query=${encodeURIComponent(sparql)}&output=json`;
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.warn(`landRegSoldPrices ${r.status} for ${pc}: ${body.slice(0, 200)}`);
    return [];
  }
  const data: any = await r.json();
  const rows: any[] = data?.results?.bindings ?? [];
  return rows.map((row): LandRegSoldPrice => {
    const pence = Math.round(Number(row.amount?.value ?? 0));
    return {
      paid_pence: pence,
      paid_display: `£${pence.toLocaleString("en-GB")}`,
      date: String(row.date?.value ?? "").slice(0, 10),
      paon: String(row.paon?.value ?? ""),
      saon: String(row.saon?.value ?? ""),
      street: String(row.street?.value ?? ""),
      town: String(row.town?.value ?? ""),
      postcode: spaced,
      type: String(row.type?.value ?? "").toLowerCase() || "other",
    };
  });
}

// ─── ONS context (via postcodes.io) ───────────────────────────────────────
//
// "ONS" here is a friendly label — under the hood we use postcodes.io, which
// is itself populated from ONS classifications (NSPL, OS Open Names, etc.).
// This gives us area codes + administrative geography per postcode without
// having to integrate the full ONS Beta API surface, which is messy.

export interface OnsContext {
  postcode: string;
  country: string;
  region: string | null;
  admin_district: string | null;
  admin_ward: string | null;
  parliamentary_constituency: string | null;
  lsoa: string | null;
  msoa: string | null;
  parish: string | null;
}

export async function onsContext(postcode: string): Promise<OnsContext | null> {
  const p = await lookupPostcode(postcode);
  if (!p) return null;
  return {
    postcode: p.postcode,
    country: p.country,
    region: p.region,
    admin_district: p.admin_district,
    admin_ward: p.admin_ward,
    parliamentary_constituency: p.parliamentary_constituency,
    lsoa: p.lsoa,
    msoa: p.msoa,
    parish: p.parish,
  };
}

// ─── data.police.uk — street-level crime ──────────────────────────────────

export interface PoliceCrime {
  category: string;         // "anti-social-behaviour", "violent-crime", etc.
  month: string;            // "yyyy-mm"
  street: string;
  outcome: string | null;
}

export interface PoliceCrimeSummary {
  months_requested: number;
  months_returned: string[];        // months we actually got data for
  total: number;
  by_category: Array<{ category: string; count: number }>;
  sample: PoliceCrime[];            // first 10 incidents for colour
}

/** Crime stats for the area around a postcode. data.police.uk returns one
 *  month at a time; we loop back from `months` ago. Returns null on bad
 *  postcode or total fetch failure. */
export async function policeCrimes(
  postcode: string,
  opts: { months?: number } = {},
): Promise<PoliceCrimeSummary | null> {
  const months = Math.max(1, Math.min(12, opts.months ?? 3));
  const loc = await lookupPostcode(postcode);
  if (!loc) return null;

  // data.police.uk lags ~2 months behind, so start the window at "two months
  // ago" not "this month".
  const now = new Date();
  const fetched: PoliceCrime[] = [];
  const monthsReturned: string[] = [];

  for (let i = 2; i < 2 + months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const url = `https://data.police.uk/api/crimes-street/all-crime?lat=${loc.lat}&lng=${loc.lng}&date=${monthStr}`;
    const r = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
    if (!r || !r.ok) continue;
    const data: any = await r.json().catch(() => null);
    if (!Array.isArray(data)) continue;
    monthsReturned.push(monthStr);
    for (const c of data) {
      fetched.push({
        category: String(c.category ?? "unknown"),
        month: String(c.month ?? monthStr),
        street: String(c.location?.street?.name ?? ""),
        outcome: c.outcome_status?.category ?? null,
      });
    }
  }

  if (monthsReturned.length === 0) return null;

  // Aggregate by category.
  const counts = new Map<string, number>();
  for (const c of fetched) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  const by_category = Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  return {
    months_requested: months,
    months_returned: monthsReturned,
    total: fetched.length,
    by_category,
    sample: fetched.slice(0, 10),
  };
}

// ─── Companies House ──────────────────────────────────────────────────────

export interface CompaniesHouseHit {
  name: string;
  number: string;           // company number
  status: string;           // "active" | "dissolved" | "liquidation" | ...
  address: string;          // full snapshot string
  type: string;             // "ltd" | "llp" | "plc" | ...
  incorporated: string | null; // yyyy-mm-dd
}

/** Search Companies House by free-text query. If `opts.postcode` is set,
 *  results are post-filtered to only those whose registered office address
 *  contains that postcode (Companies House's own postcode filter requires
 *  the advanced-search endpoint with paid features).
 *
 *  Returns [] if `apiKey` is missing — Companies House requires a free
 *  developer key (`wrangler secret put CH_API_KEY`). */
export async function companiesHouseSearch(
  apiKey: string | undefined,
  query: string,
  opts: { limit?: number; postcode?: string } = {},
): Promise<CompaniesHouseHit[]> {
  if (!apiKey) {
    console.warn("companiesHouseSearch: CH_API_KEY not set, skipping query:", query);
    return [];
  }
  const q = query.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

  // HTTP Basic with key as username, empty password.
  const basic = btoa(`${apiKey}:`);
  const url = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(q)}&items_per_page=${limit}`;
  const r = await fetch(url, {
    headers: { Authorization: `Basic ${basic}`, "User-Agent": UA },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.warn(`companiesHouseSearch ${r.status} for "${q}": ${body.slice(0, 200)}`);
    return [];
  }
  const data: any = await r.json();
  let hits: CompaniesHouseHit[] = (data.items ?? []).map((c: any): CompaniesHouseHit => ({
    name: String(c.title ?? ""),
    number: String(c.company_number ?? ""),
    status: String(c.company_status ?? ""),
    address: String(c.address_snippet ?? ""),
    type: String(c.company_type ?? ""),
    incorporated: c.date_of_creation ?? null,
  }));

  if (opts.postcode) {
    const pc = opts.postcode.replace(/\s+/g, "").toUpperCase();
    hits = hits.filter((h) => h.address.replace(/\s+/g, "").toUpperCase().includes(pc));
  }
  return hits;
}

// ─── TOOLS registry ───────────────────────────────────────────────────────
//
// Single source of truth for what tools exist and how skills invoke them.
// Used by:
//   - buildSkillTemplate (agent.ts) — feeds the catalog into the synthesis
//     prompt so the LLM picks the right tool config when authoring a skill.
//   - parseSkillTools (agent.ts) — scans each tool's headers in a skill's
//     procedure_md to build the per-run dispatch list.
//   - renderAdminTools (dashboard.ts) — renders the catalog at /admin/tools.
//
// To add a tool: write its fetch function above, then add an entry here.
// Code + metadata live together so they can't drift apart.

export const TOOLS: Record<string, ToolEntry> = {
  tavily: {
    slug: "tavily",
    display: "Tavily",
    summary: "Web search and full-page extraction. Two operations.",
    operations: {
      search: {
        description:
          "Search the web by keyword. Returns top results WITH extracted full-page content. 1 credit/call (basic) or 2 credits (advanced).",
        when_to_use:
          "When the skill needs to discover relevant pages from the open web by keyword.",
      },
      extract: {
        description:
          "Read a list of specific URLs in full. Returns clean text per URL. 1 credit per 5 URLs (basic) or 2 credits per 5 (advanced).",
        when_to_use:
          "When the skill has specific URLs to read (RSS feeds, curated sources, etc.).",
      },
    },
    headers: [
      { key: "Tavily op", values: "search (default) | extract" },
      { key: "Sources", values: "bulleted URL list (only with extract op)" },
      { key: "Search topic", values: "general | news | finance" },
      { key: "Time range", values: "day | week | month | year" },
      { key: "Depth", values: "basic | advanced" },
    ],
  },

  land_registry: {
    slug: "land_registry",
    display: "HM Land Registry",
    summary: "UK property sold-price history by postcode. One operation.",
    operations: {
      "sold-prices": {
        description:
          "Recent sold-price transactions in a postcode. Sourced from HM Land Registry's open-data SPARQL endpoint. Free, keyless.",
        when_to_use:
          "When the target is a UK postcode or address and the skill cares about property values, market direction, or what's sold recently.",
      },
    },
    headers: [
      { key: "Land Registry op", values: "sold-prices" },
      { key: "Months", values: "1–120 (default 12)" },
      { key: "Limit", values: "1–100 (default 50)" },
    ],
  },

  ons: {
    slug: "ons",
    display: "ONS / postcodes.io",
    summary:
      "UK postcode context — administrative geography + area codes. Free, keyless. (Implementation uses postcodes.io, which is built on ONS classifications.)",
    operations: {
      context: {
        description:
          "Return country, region, district, ward, parliamentary constituency, LSOA, MSOA, and parish for a UK postcode.",
        when_to_use:
          "When the target is a UK postcode and the skill needs to ground it in administrative geography (e.g. which council, which MP, which census area).",
      },
    },
    headers: [
      { key: "ONS op", values: "context" },
    ],
  },

  police: {
    slug: "police",
    display: "data.police.uk",
    summary:
      "UK street-level crime by postcode (England, Wales, Northern Ireland — not Scotland). One operation.",
    operations: {
      crimes: {
        description:
          "Aggregated crime counts by category for the area around a postcode, plus a sample of recent incidents. Data is ~2 months behind real-time. Free, keyless.",
        when_to_use:
          "When the target is a UK postcode and the skill cares about local crime trends, safety, or area character.",
      },
    },
    headers: [
      { key: "Police op", values: "crimes" },
      { key: "Months", values: "1–12 (default 3)" },
    ],
  },

  companies_house: {
    slug: "companies_house",
    display: "Companies House",
    summary:
      "UK company search by name or by registered-office postcode. Requires a free API key (CH_API_KEY secret).",
    operations: {
      search: {
        description:
          "Free-text search across registered UK companies. Returns name, number, status, address, type, incorporation date.",
        when_to_use:
          "When the target is a company name or person and the skill needs to ground in the registered-company record.",
      },
      "by-postcode": {
        description:
          "Search companies and post-filter to those whose registered office address contains the given postcode.",
        when_to_use:
          "When the target is a UK postcode or address and the skill cares about which businesses are registered there.",
      },
    },
    headers: [
      { key: "Companies House op", values: "search | by-postcode" },
      { key: "Limit", values: "1–50 (default 10)" },
      { key: "Postcode", values: "UK postcode (only with by-postcode op; defaults to target name)" },
    ],
  },
};
