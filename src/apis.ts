// External data sources for the research agent.
//
// One tool, two operations:
//   tavilySearch(query)   — keyword search; returns top results WITH extracted
//                           full-page content. Default 1 credit / call.
//   tavilyExtract(urls)   — read specific URLs in full (RSS feeds, curated
//                           sources, etc). 1 credit per 5 URLs.
//
// Both require the TAVILY_API_KEY secret.

const UA = "WatchOMacho/4 (research agent on Cloudflare Workers)";

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

// ─── TOOLS registry ───────────────────────────────────────────────────────
//
// Single source of truth for what tools exist and how skills can invoke them.
// Used by:
//   - synthesizeSkill (agent.ts) — gives the catalog to the LLM so it can
//     pick the right tool config when authoring a skill from a brief.
//   - /admin/tools (dashboard.ts) — renders the catalog as a read-only page.

export const TOOLS = {
  tavily: {
    slug: "tavily",
    display: "Tavily",
    operations: {
      search:
        "Search the web by keyword. Returns top results WITH extracted full-page content. 1 credit/call (basic) or 2 credits (advanced).",
      extract:
        "Read a list of specific URLs in full. Returns clean text per URL. 1 credit per 5 URLs (basic) or 2 credits per 5 (advanced).",
    },
    when_to_use_search:
      "When the skill needs to discover relevant pages from the open web by keyword.",
    when_to_use_extract:
      "When the skill has specific URLs to read (RSS feeds, curated sources, etc.).",
  },
} as const;
