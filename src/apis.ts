// Public API clients for the World Explorer agent.
// Everything here is free and key-less.

const UA = "WatchOMacho/1.0 (https://github.com/yourname/watchomacho - curious AI agent on Cloudflare Workers)";

export interface PlaceSummary {
  title: string;
  extract: string;
  url: string;
  lat?: number;
  lon?: number;
}

/** Random Wikipedia article summary — the agent's main serendipity engine. */
export async function randomWikipedia(): Promise<PlaceSummary> {
  const r = await fetch(
    "https://en.wikipedia.org/api/rest_v1/page/random/summary",
    { headers: { "User-Agent": UA, "Accept": "application/json" } }
  );
  if (!r.ok) throw new Error(`Wikipedia random failed: ${r.status}`);
  const data: any = await r.json();
  return {
    title: data.title,
    extract: data.extract ?? "",
    url: data.content_urls?.desktop?.page ?? "",
    lat: data.coordinates?.lat,
    lon: data.coordinates?.lon,
  };
}

/** Look up a specific Wikipedia article by title (used for user prompts). */
export async function wikipediaSummary(title: string): Promise<PlaceSummary | null> {
  const r = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { "User-Agent": UA, "Accept": "application/json" } }
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

export interface CountryData {
  name: string;
  official: string;
  capital?: string;
  region?: string;
  subregion?: string;
  population?: number;
  languages: string[];
  currencies: string[];
  flag?: string;
  lat?: number;
  lon?: number;
  cca2?: string;
}

/** Pull a random country profile from REST Countries — always geographic content. */
export async function randomCountry(): Promise<CountryData> {
  const r = await fetch(
    "https://restcountries.com/v3.1/all?fields=name,capital,region,subregion,population,languages,currencies,flag,latlng,cca2",
    { headers: { "User-Agent": UA } }
  );
  if (!r.ok) throw new Error(`REST Countries failed: ${r.status}`);
  const all: any[] = await r.json();
  const pick = all[Math.floor(Math.random() * all.length)];
  return {
    name: pick.name?.common ?? "Unknown",
    official: pick.name?.official ?? "",
    capital: pick.capital?.[0],
    region: pick.region,
    subregion: pick.subregion,
    population: pick.population,
    languages: Object.values(pick.languages ?? {}) as string[],
    currencies: Object.keys(pick.currencies ?? {}),
    flag: pick.flag,
    lat: pick.latlng?.[0],
    lon: pick.latlng?.[1],
    cca2: pick.cca2,
  };
}

export interface GeoPlace {
  display: string;
  country?: string;
  countryCode?: string;
  state?: string;
  city?: string;
}

/** Reverse-geocode a coordinate to a country/city via OpenStreetMap Nominatim. */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoPlace | null> {
  const r = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`,
    { headers: { "User-Agent": UA, "Accept": "application/json" } }
  );
  if (!r.ok) return null;
  const data: any = await r.json();
  return {
    display: data.display_name,
    country: data.address?.country,
    countryCode: data.address?.country_code?.toUpperCase(),
    state: data.address?.state,
    city: data.address?.city ?? data.address?.town ?? data.address?.village,
  };
}

export interface GeoHit {
  display: string;
  lat: number;
  lon: number;
  country?: string;
  city?: string;
}

/** Forward-geocode a free-text query (a place name, an article title) into
 *  lat/lon via OpenStreetMap Nominatim. Returns null on no match.
 *  Useful for Wikipedia articles that lack coordinates of their own. */
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

/** Current weather at a coordinate. Open-Meteo, no key required. */
export async function currentWeather(lat: number, lon: number): Promise<any | null> {
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m`,
    { headers: { "Accept": "application/json" } }
  );
  if (!r.ok) return null;
  const data: any = await r.json();
  return data.current;
}

// ─── live feeds (for digest / interest-monitor mode) ───────────────────────

export interface LiveEvent {
  source: "usgs" | "wiki-top";
  event_id: string;          // stable id used for dedup: (source, event_id) unique
  title: string;             // human-readable, used both for matching and as note title
  context: string;           // extra text used when computing the matching embedding
  url?: string;
  place?: string;
  country?: string;
  lat?: number;
  lon?: number;
  occurred_at: number;       // unix ms — when the event happened (not when we saw it)
  extra?: Record<string, unknown>; // for source-specific note bodies (magnitude, rank, etc.)
}

/** USGS earthquakes feed. Magnitude 4.5+ in the past 24h — typically 30–60
 *  events worldwide. Free, no key, stable event ids. */
export async function recentEarthquakes(): Promise<LiveEvent[]> {
  const r = await fetch(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
    { headers: { "User-Agent": UA, "Accept": "application/json" } },
  );
  if (!r.ok) throw new Error(`USGS feed failed: ${r.status}`);
  const data: any = await r.json();
  const features: any[] = Array.isArray(data?.features) ? data.features : [];
  return features
    .map((f): LiveEvent | null => {
      const id = String(f.id ?? "");
      const props = f.properties ?? {};
      const coords = f.geometry?.coordinates ?? [];
      const lon = typeof coords[0] === "number" ? coords[0] : undefined;
      const lat = typeof coords[1] === "number" ? coords[1] : undefined;
      const depth = typeof coords[2] === "number" ? coords[2] : undefined;
      const mag = typeof props.mag === "number" ? props.mag : null;
      const place = String(props.place ?? "");
      const time = typeof props.time === "number" ? props.time : Date.now();
      if (!id || mag == null || !place) return null;
      const title = `Magnitude ${mag.toFixed(1)} earthquake — ${place}`;
      const context = `USGS-reported earthquake. Magnitude ${mag.toFixed(1)} at ${place}. Depth ${depth ?? "?"}km. Tectonic / seismic / geology / region.`;
      return {
        source: "usgs",
        event_id: id,
        title,
        context,
        url: typeof props.url === "string" ? props.url : undefined,
        place,
        lat,
        lon,
        occurred_at: time,
        extra: { magnitude: mag, depth_km: depth, status: props.status, tsunami: props.tsunami },
      };
    })
    .filter((e): e is LiveEvent => e !== null);
}

/** Top Wikipedia articles by pageviews. Returns yesterday's top-N (the API
 *  has a ~1 day delay). Each entry is a real-world article that's surging
 *  in attention right now — usually a current event, a death, a release. */
export async function topWikipediaPages(topN = 25): Promise<LiveEvent[]> {
  // Pageviews API is 1–2 days behind. Query 2 days ago to be safe.
  const d = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const r = await fetch(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${yyyy}/${mm}/${dd}`,
    { headers: { "User-Agent": UA, "Accept": "application/json" } },
  );
  if (!r.ok) throw new Error(`Wikipedia pageviews failed: ${r.status}`);
  const data: any = await r.json();
  const items: any[] = data?.items?.[0]?.articles ?? [];
  // Filter the Wikipedia-meta articles that always dominate ("Main_Page",
  // "Special:Search", "Wikipedia:…") — they're not real-world events.
  const filtered = items.filter((a: any) => {
    const t = String(a?.article ?? "");
    return t && !t.startsWith("Special:") && !t.startsWith("Wikipedia:")
      && !t.startsWith("Portal:") && t !== "Main_Page" && t !== "-"
      && !/^[0-9]+_in_/.test(t);
  });
  const dateLabel = `${yyyy}-${mm}-${dd}`;
  return filtered.slice(0, topN).map((a: any): LiveEvent => {
    const article = String(a.article);
    const views = Number(a.views) || 0;
    const rank = Number(a.rank) || 0;
    const niceTitle = article.replace(/_/g, " ");
    return {
      source: "wiki-top",
      event_id: `wiki-top:${dateLabel}:${article}`,
      title: niceTitle,
      context: `Surging Wikipedia article on ${dateLabel}. Rank ${rank}, ${views.toLocaleString()} views in a day. Topic: ${niceTitle}.`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`,
      occurred_at: d.getTime(),
      extra: { rank, views, article, date: dateLabel },
    };
  });
}
