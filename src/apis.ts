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
