// External data sources for the research agent.
//
// One tool only: Tavily (web search + URL extraction). HM Land Registry,
// ONS/postcodes.io, data.police.uk, and Companies House were removed in the
// "simplify" pass — they were scaffolding that no live skill called. Add them
// back (or any new tool) when there's a real skill that needs them.

const UA = "WatchOMacho/4 (research agent on Cloudflare Workers)";

// ─── Generalised TOOLS registry shape ─────────────────────────────────────
//
// One-element registry today; kept so adding the next tool stays a
// drop-in change (write the fetcher, add a TOOLS entry, add the dispatch
// case in agent.ts).

export interface ToolOperation {
  description: string;
  when_to_use: string;
}

export interface ToolEntry {
  slug: string;
  display: string;
  summary: string;          // one-line tool intro
  operations: Record<string, ToolOperation>;
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

// ─── TOOLS registry ───────────────────────────────────────────────────────
//
// Single source of truth for what tools exist. Used by the /admin/tools
// catalog page and the skill editor's tool dropdown.

export const TOOLS: Record<string, ToolEntry> = {
  tavily: {
    slug: "tavily",
    display: "Tavily",
    summary: "Web search and full-page extraction.",
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
  },
};
