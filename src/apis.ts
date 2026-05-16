// External data sources for the research agent.
//
// Three things only:
//   braveSearch(query)        — web search, the agent's main eyes on the world
//   wikipediaSummary(title)   — encyclopedia lookup for context / geo / facts
//   geocodeQuery(query)       — turn a place name into lat/lon (Nominatim)
//
// Everything is keyless except Brave (free tier — set BRAVE_API_KEY secret).

const UA = "WatchOMacho/4 (research agent on Cloudflare Workers)";

// ─── Brave Search ─────────────────────────────────────────────────────────

export interface BraveResult {
  title: string;
  url: string;
  description: string;
  age?: string;          // "2 days ago", "1 week ago" etc, when Brave returns it
  language?: string;
}

/** One search query against Brave Search. Returns up to `count` web results,
 *  ranked by relevance. Returns [] if no API key is configured (graceful
 *  degradation — the calling skill will write a thinner report). */
export async function braveSearch(
  apiKey: string | undefined,
  query: string,
  count = 5,
): Promise<BraveResult[]> {
  if (!apiKey) {
    console.warn("braveSearch: BRAVE_API_KEY not set, skipping query:", query);
    return [];
  }
  const q = query.slice(0, 400).trim();
  if (!q) return [];
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(20, Math.max(1, count))}`;
  const r = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
      "User-Agent": UA,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.warn(`braveSearch ${r.status} for "${q}": ${body.slice(0, 200)}`);
    return [];
  }
  const data: any = await r.json();
  const hits: any[] = data?.web?.results ?? [];
  return hits.slice(0, count).map((h: any) => ({
    title: String(h.title ?? "").trim(),
    url: String(h.url ?? "").trim(),
    description: String(h.description ?? "").replace(/<[^>]+>/g, "").trim(),
    age: h.age ?? undefined,
    language: h.language ?? undefined,
  }));
}

// ─── Wikipedia ────────────────────────────────────────────────────────────

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  lat?: number;
  lon?: number;
}

/** Look up a Wikipedia article by title. Returns null on no match. */
export async function wikipediaSummary(title: string): Promise<WikiSummary | null> {
  if (!title) return null;
  const r = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { "User-Agent": UA, "Accept": "application/json" } },
  );
  if (!r.ok) return null;
  const data: any = await r.json();
  return {
    title: data.title,
    extract: data.extract ?? "",
    url: data.content_urls?.desktop?.page ?? "",
    lat: data.coordinates?.lat,
    lon: data.coordinates?.lon,
  };
}

// ─── Nominatim (OpenStreetMap geocoder) ───────────────────────────────────

export interface GeoHit {
  display: string;
  lat: number;
  lon: number;
  country?: string;
  city?: string;
}

/** Forward-geocode a freeform query to lat/lon via Nominatim. Returns null
 *  on no match. Used to enrich targets that look like places. */
export async function geocodeQuery(q: string): Promise<GeoHit | null> {
  if (!q) return null;
  const r = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`,
    { headers: { "User-Agent": UA, "Accept": "application/json" } },
  );
  if (!r.ok) return null;
  const data: any = await r.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const hit = data[0];
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    display: hit.display_name,
    lat,
    lon,
    country: hit.address?.country,
    city: hit.address?.city ?? hit.address?.town ?? hit.address?.village,
  };
}
