// The agent's brain. One file. Plain functions.
//
//   learnOnce()           — picks a topic, writes a ~300-word field note, stores it.
//   ask()                 — RAG over past notes to answer a question.
//   startExploration()    — admin sends a brief; LLM plans 3-5 sub-topics; first step kicks off.
//   advanceExploration()  — write the next step's note, or synthesise if all steps done.
//   getSetting/setSetting — live runtime config (frequency, strategy).

import {
  randomWikipedia,
  randomCountry,
  reverseGeocode,
  currentWeather,
  wikipediaSummary,
  geocodeQuery,
} from "./apis";

export interface Env {
  AI: Ai;
  DB: D1Database;
  NOTES: R2Bucket;
  MEMORY: VectorizeIndex;
  ADMIN_SECRET: string;
}

const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dimensions

const CONTRACT = `# WatchOMacho — World Explorer

You are a curious AI traveler. You wander the world through public archives
and write thoughtful, ~300-word field notes about what you find.

## Personality
- Genuinely curious, never dry or encyclopedic
- Like a well-read travel writer keeping a private journal
- If something surprises you, say so out loud
- Find connections between places (climate, language families, history, food)

## How you write a note
- Open with a hook — a vivid detail or surprising fact
- Middle: the substance — geography, culture, history, people
- End: ONE connection to something you learned before (if you have memory)
- ~300 words, flowing prose, no headers or bullet points
- Sentence case throughout, no shouting, no clichés

## What you avoid
- Generic Wikipedia-tone summaries
- Lists of statistics with no narrative
- Repeating things you have already written about
- Phrases like "in conclusion", "this fascinating place", "rich history"
`;

interface PickedTopic {
  title: string;
  source: string;
  source_url: string;
  raw: string;
  place?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

interface RecalledNote {
  id: string;
  title: string;
  snippet: string;
  score: number;
}

// ─── budget gates ──────────────────────────────────────────────────────────

export class BudgetExceeded extends Error {
  constructor(public kind: "notes" | "asks" | "missions", public limit: number, public used: number) {
    super(`daily ${kind} budget exhausted (${used}/${limit})`);
    this.name = "BudgetExceeded";
  }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getDailyUsage(env: Env): Promise<{
  date: string;
  notes: number;
  asks: number;
  missions: number;
}> {
  const date = todayUtc();
  const row = await env.DB.prepare(
    "SELECT date, notes, asks, missions FROM daily_usage WHERE date = ?",
  )
    .bind(date)
    .first<{ date: string; notes: number; asks: number; missions: number }>();
  return row ?? { date, notes: 0, asks: 0, missions: 0 };
}

async function bumpUsage(
  env: Env,
  kind: "notes" | "asks" | "missions",
  by = 1,
): Promise<void> {
  const date = todayUtc();
  const col = kind; // safe — fixed enum
  await env.DB.prepare(
    `INSERT INTO daily_usage (date, ${col}, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET ${col} = ${col} + excluded.${col}, updated_at = excluded.updated_at`,
  )
    .bind(date, by, Date.now())
    .run();
}

async function checkBudget(
  env: Env,
  kind: "notes" | "asks" | "missions",
): Promise<void> {
  const settingKey =
    kind === "notes" ? "daily_note_limit" : kind === "asks" ? "daily_ask_limit" : "daily_mission_limit";
  const limit = parseInt(await getSetting(env, settingKey, kind === "notes" ? "30" : kind === "asks" ? "100" : "5"), 10);
  if (!Number.isFinite(limit) || limit <= 0) return; // 0 or invalid = disabled
  const usage = await getDailyUsage(env);
  const used = (usage as any)[kind] as number;
  if (used >= limit) throw new BudgetExceeded(kind, limit, used);
}

// ─── settings helpers ──────────────────────────────────────────────────────

export async function getSetting(env: Env, key: string, fallback = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(key, value, Date.now())
    .run();
}

// ─── topic selection ───────────────────────────────────────────────────────

/** Pick a country we haven't covered yet (or rarely), with serendipity fallback. */
async function pickUnvisitedCountry(env: Env): Promise<PickedTopic | null> {
  for (let i = 0; i < 5; i++) {
    const c = await randomCountry();
    const existing = await env.DB.prepare(
      "SELECT 1 FROM notes WHERE country = ? LIMIT 1",
    )
      .bind(c.name)
      .first();
    if (existing && i < 4) continue;

    let weather: any = null;
    if (c.lat != null && c.lon != null) {
      weather = await currentWeather(c.lat, c.lon).catch(() => null);
    }
    const lines = [
      `Country: ${c.name} (official: ${c.official})`,
      `Capital: ${c.capital ?? "—"}`,
      `Region: ${c.region ?? "—"} / ${c.subregion ?? ""}`,
      `Population: ${c.population?.toLocaleString() ?? "—"}`,
      `Languages: ${c.languages.join(", ") || "—"}`,
      `Currency codes: ${c.currencies.join(", ") || "—"}`,
      weather
        ? `Right now there: ${weather.temperature_2m}°C, wind ${weather.wind_speed_10m} km/h`
        : "",
    ].filter(Boolean);
    return {
      title: c.name,
      source: "restcountries",
      source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(c.name)}`,
      raw: lines.join("\n"),
      place: c.capital,
      country: c.name,
      lat: c.lat,
      lon: c.lon,
    };
  }
  return null;
}

/** Take a random Wikipedia article and geo-enrich it. */
async function pickRandomWiki(): Promise<PickedTopic> {
  const w = await randomWikipedia();
  let geo: any = null;
  if (w.lat != null && w.lon != null) {
    geo = await reverseGeocode(w.lat, w.lon).catch(() => null);
  } else {
    const hit = await geocodeQuery(w.title).catch(() => null);
    if (hit) {
      return {
        title: w.title,
        source: "wikipedia",
        source_url: w.url,
        raw: `Title: ${w.title}\nSummary: ${w.extract}\nLocation (geocoded from title): ${hit.display}`,
        place: hit.city ?? hit.country ?? undefined,
        country: hit.country,
        lat: hit.lat,
        lon: hit.lon,
      };
    }
  }
  return {
    title: w.title,
    source: "wikipedia",
    source_url: w.url,
    raw: `Title: ${w.title}\nSummary: ${w.extract}\nLocation: ${geo?.display ?? "unknown"}`,
    place: geo?.city ?? (geo?.country ? w.title : undefined),
    country: geo?.country,
    lat: w.lat,
    lon: w.lon,
  };
}

/** Bridge mode: ask the LLM for a topic that links two random past notes. */
async function pickBridge(env: Env): Promise<PickedTopic | null> {
  const rows = await env.DB.prepare(
    "SELECT id, title, country, snippet FROM notes WHERE source != 'synthesis' ORDER BY RANDOM() LIMIT 2",
  ).all<any>();
  const picks = rows.results ?? [];
  if (picks.length < 2) return null;

  const [a, b] = picks;
  const res: any = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          "You suggest a single real-world topic (a place, person, food, language, river, treaty, plant, anything) whose Wikipedia article would meaningfully connect two existing field notes. Return ONLY the topic name — one short line, nothing else.",
      },
      {
        role: "user",
        content: `Note A — ${a.title}${a.country ? ` (${a.country})` : ""}: ${a.snippet}\n\nNote B — ${b.title}${b.country ? ` (${b.country})` : ""}: ${b.snippet}\n\nWhat one Wikipedia-searchable topic would bridge these two?`,
      },
    ],
    max_tokens: 60,
  });
  const candidate = String(res.response ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .split("\n")[0];
  if (!candidate || candidate.length > 100) return null;

  const w = await wikipediaSummary(candidate).catch(() => null);
  if (!w || !w.extract) return null;

  let geo: any = null;
  if (w.lat != null && w.lon != null) {
    geo = await reverseGeocode(w.lat, w.lon).catch(() => null);
  } else {
    geo = await geocodeQuery(w.title).catch(() => null);
  }
  return {
    title: w.title,
    source: "wikipedia",
    source_url: w.url,
    raw: `Bridge candidate (between "${a.title}" and "${b.title}").\nTitle: ${w.title}\nSummary: ${w.extract}\nLocation: ${geo?.display ?? "unknown"}`,
    place: geo?.city ?? geo?.country ?? undefined,
    country: geo?.country,
    lat: geo?.lat ?? w.lat,
    lon: geo?.lon ?? w.lon,
  };
}

/** Choose what to explore next. Rotates strategies so the agent feels curious. */
async function pickTopic(env: Env): Promise<PickedTopic> {
  const strategy = await getSetting(env, "topic_strategy", "mixed");
  const noteCount = await env.DB.prepare("SELECT COUNT(*) as n FROM notes").first<{ n: number }>();
  const haveMemory = (noteCount?.n ?? 0) >= 4;

  let mode: "wiki" | "country" | "bridge";
  if (strategy === "random") mode = Math.random() < 0.5 ? "wiki" : "country";
  else if (strategy === "bridge" && haveMemory) mode = "bridge";
  else if (strategy === "gap") mode = "country";
  else {
    const r = Math.random();
    if (haveMemory && r < 0.25) mode = "bridge";
    else if (r < 0.65) mode = "country";
    else mode = "wiki";
  }

  if (mode === "bridge") {
    const t = await pickBridge(env);
    if (t) return t;
  }
  if (mode === "country") {
    const t = await pickUnvisitedCountry(env);
    if (t) return t;
  }
  return pickRandomWiki();
}

// ─── memory ────────────────────────────────────────────────────────────────

async function recall(env: Env, queryText: string): Promise<RecalledNote[]> {
  try {
    const emb: any = await env.AI.run(EMBED_MODEL, { text: [queryText] });
    const vec = emb.data?.[0];
    if (!vec) return [];
    const results = await env.MEMORY.query(vec, {
      topK: 4,
      returnMetadata: "all",
    });
    return (results.matches ?? [])
      .filter((m: any) => m.score > 0.3)
      .map((m: any) => ({
        id: String(m.id),
        title: String(m.metadata?.title ?? ""),
        snippet: String(m.metadata?.snippet ?? "").slice(0, 220),
        score: Number(m.score),
      }));
  } catch (e) {
    console.error("recall failed", e);
    return [];
  }
}

async function persistConnections(
  env: Env,
  fromId: string,
  recalled: RecalledNote[],
): Promise<void> {
  const edges = recalled.filter((r) => r.id && r.id !== fromId);
  if (edges.length === 0) return;
  const now = Date.now();
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO connections (from_note_id, to_note_id, kind, score, created_at) VALUES (?, ?, 'recall', ?, ?)",
  );
  await env.DB
    .batch(edges.map((r) => stmt.bind(fromId, r.id, r.score, now)))
    .catch((e) => console.error("connections batch failed", e));
}

// ─── writing & persistence ─────────────────────────────────────────────────

async function writeNote(
  env: Env,
  topic: PickedTopic,
  memory: RecalledNote[],
  extra = "",
): Promise<string> {
  const memoryBlock = memory.length
    ? `\n\n## Things you've already learned about related places:\n${memory.map((m) => `- ${m.title}: ${m.snippet}`).join("\n")}`
    : "";

  const userPrompt = `Write a ~300 word field note about: ${topic.title}

Raw context from the source:
${topic.raw}
${memoryBlock}
${extra ? "\n" + extra : ""}

Reminder: flowing prose, no headers, one explicit connection at the end if memory exists.`;

  const res: any = await env.AI.run(CHAT_MODEL, {
    messages: [
      { role: "system", content: CONTRACT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 700,
  });

  return String(res.response ?? "").trim();
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface PersistedNote {
  noteId: string;
  title: string;
  snippet: string;
  body: string;
}

async function runStep(
  env: Env,
  topic: PickedTopic,
  triggeredBy: string,
  extraInstructions = "",
  explorationId?: string,
  stepIndex?: number,
): Promise<PersistedNote> {
  // Each runStep writes one note. Budget guards apply to every path that
  // reaches here: cron, manual run, prompt, mission step, mission synthesis.
  await checkBudget(env, "notes");

  const recallQuery = `${topic.title} ${topic.country ?? ""} ${topic.place ?? ""}`.trim();
  const memory = await recall(env, recallQuery);

  const body = await writeNote(env, topic, memory, extraInstructions);
  if (!body || body.length < 50) {
    throw new Error("LLM returned empty or too-short response");
  }

  const noteId = uid();
  const created = Date.now();
  const md = [
    `# ${topic.title}`,
    ``,
    `*Source: ${topic.source}${topic.source_url ? ` · [link](${topic.source_url})` : ""}*`,
    `*Written: ${new Date(created).toISOString()}*`,
    topic.country
      ? `*Place: ${topic.place ? topic.place + ", " : ""}${topic.country}*`
      : "",
    ``,
    body,
  ]
    .filter(Boolean)
    .join("\n");

  const snippet = body.replace(/\s+/g, " ").slice(0, 240).trim() + "…";
  const r2Key = `notes/${created}-${noteId}.md`;
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  await env.NOTES.put(r2Key, md, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  await env.DB.prepare(
    `INSERT INTO notes
       (id, title, topic, place, country, lat, lon, snippet, source, source_url, r2_key, word_count, created_at, triggered_by, exploration_id, step_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      noteId,
      topic.title,
      "world-explorer",
      topic.place ?? null,
      topic.country ?? null,
      topic.lat ?? null,
      topic.lon ?? null,
      snippet,
      topic.source,
      topic.source_url || null,
      r2Key,
      wordCount,
      created,
      triggeredBy,
      explorationId ?? null,
      stepIndex ?? null,
    )
    .run();

  try {
    const emb: any = await env.AI.run(EMBED_MODEL, {
      text: [`${topic.title}. ${body}`.slice(0, 2000)],
    });
    const vec = emb.data?.[0];
    if (vec) {
      await env.MEMORY.upsert([
        {
          id: noteId,
          values: vec,
          metadata: {
            title: topic.title,
            snippet,
            country: topic.country ?? "",
            created_at: created,
          },
        },
      ]);
    }
  } catch (e) {
    console.error("embed failed", e);
  }

  await persistConnections(env, noteId, memory);
  await bumpUsage(env, "notes");

  return { noteId, title: topic.title, snippet, body };
}

// ─── public entry: single-shot learning ───────────────────────────────────

export async function learnOnce(
  env: Env,
  triggeredBy: "cron" | "manual" | "prompt" | "exploration",
  prompt?: string,
) {
  const runId = uid();
  const t0 = Date.now();

  try {
    let topic: PickedTopic;
    if (prompt) {
      const w = await wikipediaSummary(prompt);
      if (w && w.extract) {
        let geo: any = null;
        if (w.lat != null && w.lon != null) {
          geo = await reverseGeocode(w.lat, w.lon).catch(() => null);
        } else {
          geo = await geocodeQuery(w.title).catch(() => null);
        }
        topic = {
          title: w.title,
          source: "user-prompt",
          source_url: w.url,
          raw: `User asked: "${prompt}"\nWikipedia: ${w.extract}`,
          place: geo?.city ?? geo?.country ?? undefined,
          country: geo?.country,
          lat: geo?.lat ?? w.lat,
          lon: geo?.lon ?? w.lon,
        };
      } else {
        const geo = await geocodeQuery(prompt).catch(() => null);
        topic = {
          title: prompt.slice(0, 80),
          source: "user-prompt",
          source_url: "",
          raw: `User asked you to think about: "${prompt}". Use what you know — no Wikipedia summary was found.`,
          place: geo?.city ?? geo?.country ?? undefined,
          country: geo?.country,
          lat: geo?.lat,
          lon: geo?.lon,
        };
      }
    } else {
      topic = await pickTopic(env);
    }

    const persisted = await runStep(env, topic, triggeredBy);

    await env.DB.prepare(
      `INSERT INTO runs (id, triggered_by, status, topic_chosen, note_id, duration_ms, created_at)
       VALUES (?, ?, 'success', ?, ?, ?, ?)`,
    )
      .bind(runId, triggeredBy, topic.title, persisted.noteId, Date.now() - t0, Date.now())
      .run();

    return {
      ok: true,
      noteId: persisted.noteId,
      title: persisted.title,
      snippet: persisted.snippet,
    };
  } catch (err: any) {
    await env.DB.prepare(
      `INSERT INTO runs (id, triggered_by, status, error, duration_ms, created_at)
       VALUES (?, ?, 'error', ?, ?, ?)`,
    )
      .bind(runId, triggeredBy, String(err?.message ?? err), Date.now() - t0, Date.now())
      .run()
      .catch(() => {});
    throw err;
  }
}

// ─── explorations: multi-step research missions ────────────────────────────

function parsePlan(text: string): string[] | null {
  const cleanItem = (s: string) =>
    s
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^["']|["']$|,$/g, "")
      .trim();

  // 1. Strict JSON array.
  const m = text.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) {
        const cleaned = arr.map((x) => String(x).trim()).filter(Boolean);
        if (cleaned.length) return cleaned;
      }
    } catch {
      // fall through
    }
  }
  // 2. Bulleted / numbered list, one per line.
  const lines = text
    .split("\n")
    .map(cleanItem)
    .filter((l) => l && !/^(here|sure|okay|ok|json|```|note)/i.test(l) && l.length < 160);
  if (lines.length >= 2) return lines;

  // 3. Comma-separated single line.
  if (text.includes(",")) {
    const parts = text
      .replace(/^[^A-Za-z]*/, "")
      .split(",")
      .map(cleanItem)
      .filter((p) => p && p.length < 160);
    if (parts.length >= 2) return parts;
  }
  return null;
}

export async function startExploration(
  env: Env,
  brief: string,
  desiredSteps: number,
): Promise<{ id: string; plan: string[] }> {
  await checkBudget(env, "missions");
  const steps = Math.max(2, Math.min(7, Math.floor(desiredSteps || 4)));
  const id = uid();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO explorations (id, brief, status, current_step, total_steps, created_at, updated_at)
     VALUES (?, ?, 'planning', 0, ?, ?, ?)`,
  )
    .bind(id, brief, steps, now, now)
    .run();

  const res: any = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: "system",
        content: `You are a research planner for a curious AI traveler. Given a brief, return a JSON array of ${steps} concrete sub-topics (real Wikipedia-searchable titles — places, people, treaties, dishes, languages, anything) that together explore the brief from different angles. Be specific. Each item must be a string. Return ONLY the JSON array.`,
      },
      { role: "user", content: `Brief: "${brief}"\n\nReturn the JSON array of ${steps} sub-topics.` },
    ],
    max_tokens: 400,
  });

  const rawPlan = String(res.response ?? "");
  const plan = parsePlan(rawPlan);
  if (!plan || plan.length === 0) {
    console.error("plan parse failed. raw response:", rawPlan);
    await env.DB.prepare(
      "UPDATE explorations SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind("plan parse failed: " + rawPlan.slice(0, 400), Date.now(), id)
      .run();
    throw new Error("Could not generate a plan for: " + brief);
  }

  const finalPlan = plan.slice(0, steps);
  await env.DB.prepare(
    "UPDATE explorations SET status = 'in_progress', plan_json = ?, total_steps = ?, updated_at = ? WHERE id = ?",
  )
    .bind(JSON.stringify(finalPlan), finalPlan.length, Date.now(), id)
    .run();
  await bumpUsage(env, "missions");

  return { id, plan: finalPlan };
}

/** Advance one step of an exploration. Returns true if more work remains.
 *  Single-writer guarded: takes a 60-second stale-tolerant claim on the row.
 *  If another caller already holds the claim we return false immediately so
 *  the cron + dispatcher's-waitUntil + admin pump can all race safely. */
export async function advanceExploration(env: Env, expId: string): Promise<boolean> {
  const claimTs = Date.now();
  const staleBefore = claimTs - 60_000;
  const claim = await env.DB.prepare(
    `UPDATE explorations
       SET advancing_at = ?
     WHERE id = ?
       AND status IN ('in_progress', 'synthesizing')
       AND (advancing_at IS NULL OR advancing_at < ?)`,
  )
    .bind(claimTs, expId, staleBefore)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return false;

  try {
    return await advanceExplorationLocked(env, expId);
  } finally {
    await env.DB.prepare(
      "UPDATE explorations SET advancing_at = NULL WHERE id = ? AND advancing_at = ?",
    )
      .bind(expId, claimTs)
      .run()
      .catch(() => {});
  }
}

async function advanceExplorationLocked(env: Env, expId: string): Promise<boolean> {
  const exp = await env.DB.prepare("SELECT * FROM explorations WHERE id = ?")
    .bind(expId)
    .first<any>();
  if (!exp) return false;
  if (exp.status !== "in_progress" && exp.status !== "synthesizing") return false;

  const plan: string[] = JSON.parse(exp.plan_json || "[]");
  const step = exp.current_step ?? 0;

  if (step >= plan.length) {
    if (exp.status !== "synthesizing") {
      await env.DB.prepare(
        "UPDATE explorations SET status = 'synthesizing', updated_at = ? WHERE id = ?",
      )
        .bind(Date.now(), expId)
        .run();
    }
    try {
      const synthesisId = await synthesiseExploration(env, expId, exp.brief);
      await env.DB.prepare(
        "UPDATE explorations SET status = 'complete', synthesis_note_id = ?, completed_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(synthesisId, Date.now(), Date.now(), expId)
        .run();
    } catch (e: any) {
      await env.DB.prepare(
        "UPDATE explorations SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
      )
        .bind(String(e?.message ?? e), Date.now(), expId)
        .run();
    }
    return false;
  }

  const subtopic = plan[step];
  try {
    const w = await wikipediaSummary(subtopic).catch(() => null);
    let topic: PickedTopic;
    if (w && w.extract) {
      let geo: any = null;
      if (w.lat != null && w.lon != null) {
        geo = await reverseGeocode(w.lat, w.lon).catch(() => null);
      } else {
        geo = await geocodeQuery(w.title).catch(() => null);
      }
      topic = {
        title: w.title,
        source: "exploration",
        source_url: w.url,
        raw: `Exploration step ${step + 1}/${plan.length} of mission: "${exp.brief}"\nSub-topic: ${subtopic}\nWikipedia: ${w.extract}`,
        place: geo?.city ?? geo?.country ?? undefined,
        country: geo?.country,
        lat: geo?.lat ?? w.lat,
        lon: geo?.lon ?? w.lon,
      };
    } else {
      const geo = await geocodeQuery(subtopic).catch(() => null);
      topic = {
        title: subtopic.slice(0, 80),
        source: "exploration",
        source_url: "",
        raw: `Exploration step ${step + 1}/${plan.length} of mission: "${exp.brief}"\nSub-topic: ${subtopic}\nNo Wikipedia summary found — reason from general knowledge.`,
        place: geo?.city ?? geo?.country ?? undefined,
        country: geo?.country,
        lat: geo?.lat,
        lon: geo?.lon,
      };
    }
    const extra = `This note is step ${step + 1} of ${plan.length} in a research mission. The mission brief is: "${exp.brief}". Keep the brief in mind as the angle, even while writing about ${topic.title} specifically.`;
    await runStep(env, topic, "exploration", extra, expId, step);
    await env.DB.prepare(
      "UPDATE explorations SET current_step = current_step + 1, updated_at = ? WHERE id = ?",
    )
      .bind(Date.now(), expId)
      .run();
    return true;
  } catch (e: any) {
    await env.DB.prepare(
      "UPDATE explorations SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(String(e?.message ?? e), Date.now(), expId)
      .run();
    return false;
  }
}

async function synthesiseExploration(
  env: Env,
  expId: string,
  brief: string,
): Promise<string> {
  await checkBudget(env, "notes");
  const rows = await env.DB.prepare(
    "SELECT id, title, snippet, country FROM notes WHERE exploration_id = ? AND source != 'synthesis' ORDER BY step_index ASC",
  )
    .bind(expId)
    .all<any>();
  const steps = rows.results ?? [];
  if (steps.length === 0) throw new Error("no sub-step notes found for synthesis");

  const stepsBlock = steps
    .map(
      (n: any, i: number) =>
        `Step ${i + 1} — ${n.title}${n.country ? ` (${n.country})` : ""}: ${n.snippet}`,
    )
    .join("\n\n");

  const res: any = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          CONTRACT +
          "\n\nNow you are writing the closing synthesis of a multi-step research mission you just completed. Tie the steps together. Surface a real insight, not a summary. ~350 words.",
      },
      {
        role: "user",
        content: `Mission brief: "${brief}"\n\nYour own step notes (snippets):\n\n${stepsBlock}\n\nWrite the closing synthesis. Reference the steps by name. End with what surprised you or what you'd explore next.`,
      },
    ],
    max_tokens: 800,
  });
  const body = String(res.response ?? "").trim();
  if (!body || body.length < 80) throw new Error("synthesis came back empty");

  const noteId = uid();
  const created = Date.now();
  const title = `Mission: ${brief.slice(0, 80)}`;
  const md = [
    `# ${title}`,
    ``,
    `*Source: synthesis · ${steps.length} step mission*`,
    `*Written: ${new Date(created).toISOString()}*`,
    ``,
    body,
  ].join("\n");

  const snippet = body.replace(/\s+/g, " ").slice(0, 240).trim() + "…";
  const r2Key = `notes/${created}-${noteId}.md`;
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  await env.NOTES.put(r2Key, md, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });

  await env.DB.prepare(
    `INSERT INTO notes
       (id, title, topic, place, country, lat, lon, snippet, source, source_url, r2_key, word_count, created_at, triggered_by, exploration_id, step_index)
     VALUES (?, ?, 'world-explorer', NULL, NULL, NULL, NULL, ?, 'synthesis', NULL, ?, ?, ?, 'exploration', ?, NULL)`,
  )
    .bind(noteId, title, snippet, r2Key, wordCount, created, expId)
    .run();

  try {
    const emb: any = await env.AI.run(EMBED_MODEL, {
      text: [`${title}. ${body}`.slice(0, 2000)],
    });
    const vec = emb.data?.[0];
    if (vec) {
      await env.MEMORY.upsert([
        {
          id: noteId,
          values: vec,
          metadata: { title, snippet, country: "", created_at: created },
        },
      ]);
    }
  } catch (e) {
    console.error("synthesis embed failed", e);
  }

  const now = Date.now();
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO connections (from_note_id, to_note_id, kind, score, created_at) VALUES (?, ?, 'exploration', 1.0, ?)",
  );
  await env.DB
    .batch(steps.map((s: any) => stmt.bind(noteId, s.id, now)))
    .catch((e) => console.error("synthesis edges failed", e));

  await bumpUsage(env, "notes");
  return noteId;
}

// ─── ask (RAG) ─────────────────────────────────────────────────────────────

export async function ask(env: Env, question: string) {
  await checkBudget(env, "asks");
  const emb: any = await env.AI.run(EMBED_MODEL, { text: [question] });
  const vec = emb.data?.[0];
  if (!vec) return { answer: "Could not embed the question.", sources: [] };

  const hits = await env.MEMORY.query(vec, { topK: 5, returnMetadata: "all" });
  const ids = (hits.matches ?? []).slice(0, 3).map((m: any) => m.id);

  if (ids.length === 0) {
    return {
      answer:
        "I haven't wandered far enough yet to know about that. Trigger a few more runs and ask me again.",
      sources: [],
    };
  }

  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, title, r2_key, snippet FROM notes WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<any>();

  const notes = await Promise.all(
    (rows.results ?? []).map(async (row: any) => {
      const obj = await env.NOTES.get(row.r2_key);
      const md = obj ? await obj.text() : row.snippet;
      return { title: row.title, body: md };
    }),
  );

  const context = notes
    .map((n: any) => `## ${n.title}\n${n.body}`)
    .join("\n\n---\n\n");

  const res: any = await env.AI.run(CHAT_MODEL, {
    messages: [
      {
        role: "system",
        content:
          CONTRACT +
          `\n\nYou are now answering a user question using your own past field notes. Quote and connect them. If they don't cover the question, say so honestly — don't make things up.`,
      },
      {
        role: "user",
        content: `Question: ${question}\n\nYour relevant field notes:\n\n${context}`,
      },
    ],
    max_tokens: 700,
  });

  await bumpUsage(env, "asks");

  return {
    answer: String(res.response ?? "").trim(),
    sources: notes.map((n: any) => n.title),
  };
}
