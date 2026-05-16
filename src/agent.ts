// The agent's brain. One file. Plain functions.
//
//   learnOnce()  — picks a topic, writes a ~300-word field note, stores it.
//   ask()        — RAG over past notes to answer a question.

import {
  randomWikipedia,
  randomCountry,
  reverseGeocode,
  currentWeather,
  wikipediaSummary,
} from "./apis";

export interface Env {
  AI: Ai;
  DB: D1Database;
  NOTES: R2Bucket;
  MEMORY: VectorizeIndex;
  ADMIN_SECRET: string;
}

// Model choices. If your account doesn't have access to llama-3.3, swap to
// "@cf/meta/llama-3.1-8b-instruct-fast" — same API, smaller and faster.
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dimensions

// The agent's contract — its personality and rules. Edit this to change its soul.
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

/** Choose what to explore next. Rotates strategies so the agent feels curious. */
async function pickTopic(env: Env): Promise<PickedTopic> {
  // 50/50 split: random Wikipedia (serendipity) vs random country (geography)
  if (Math.random() < 0.5) {
    const w = await randomWikipedia();
    let geo: any = null;
    if (w.lat != null && w.lon != null) {
      geo = await reverseGeocode(w.lat, w.lon).catch(() => null);
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
  } else {
    const c = await randomCountry();
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
}

/** Pull related past notes from Vectorize so the agent can connect dots. */
async function recall(env: Env, topic: PickedTopic): Promise<string[]> {
  try {
    const queryText =
      `${topic.title} ${topic.country ?? ""} ${topic.place ?? ""}`.trim();
    const emb: any = await env.AI.run(EMBED_MODEL, { text: [queryText] });
    const vec = emb.data?.[0];
    if (!vec) return [];
    const results = await env.MEMORY.query(vec, {
      topK: 3,
      returnMetadata: "all",
    });
    return (results.matches ?? [])
      .filter((m: any) => m.score > 0.3)
      .map(
        (m: any) =>
          `- ${m.metadata?.title}: ${String(m.metadata?.snippet ?? "").slice(0, 200)}`
      );
  } catch {
    return [];
  }
}

/** Ask Workers AI to write the field note. */
async function writeNote(
  env: Env,
  topic: PickedTopic,
  memory: string[],
): Promise<string> {
  const memoryBlock = memory.length
    ? `\n\n## Things you've already learned about related places:\n${memory.join("\n")}`
    : "";

  const userPrompt = `Write a ~300 word field note about: ${topic.title}

Raw context from the source:
${topic.raw}
${memoryBlock}

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

/** Run one full learning cycle. Returns the new note's id. */
export async function learnOnce(
  env: Env,
  triggeredBy: "cron" | "manual" | "prompt",
  prompt?: string,
) {
  const runId = uid();
  const t0 = Date.now();

  try {
    // 1. Pick what to learn
    let topic: PickedTopic;
    if (prompt) {
      const w = await wikipediaSummary(prompt);
      if (w && w.extract) {
        let geo: any = null;
        if (w.lat != null && w.lon != null) {
          geo = await reverseGeocode(w.lat, w.lon).catch(() => null);
        }
        topic = {
          title: w.title,
          source: "user-prompt",
          source_url: w.url,
          raw: `User asked: "${prompt}"\nWikipedia: ${w.extract}`,
          place: geo?.city ?? w.title,
          country: geo?.country,
          lat: w.lat,
          lon: w.lon,
        };
      } else {
        topic = {
          title: prompt.slice(0, 80),
          source: "user-prompt",
          source_url: "",
          raw: `User asked you to think about: "${prompt}". Use what you know — no Wikipedia summary was found.`,
        };
      }
    } else {
      topic = await pickTopic(env);
    }

    // 2. Recall related memories
    const memory = await recall(env, topic);

    // 3. Write the note
    const body = await writeNote(env, topic, memory);
    if (!body || body.length < 50) {
      throw new Error("LLM returned empty or too-short response");
    }

    // 4. Persist
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

    const snippet = body
      .replace(/\s+/g, " ")
      .slice(0, 240)
      .trim() + "…";
    const r2Key = `notes/${created}-${noteId}.md`;
    const wordCount = body.split(/\s+/).filter(Boolean).length;

    await env.NOTES.put(r2Key, md, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });

    await env.DB.prepare(
      `INSERT INTO notes
         (id, title, topic, place, country, lat, lon, snippet, source, source_url, r2_key, word_count, created_at, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();

    // 5. Embed for memory (best-effort — note is already saved if this fails)
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

    // 6. Log the run
    await env.DB.prepare(
      `INSERT INTO runs (id, triggered_by, status, topic_chosen, note_id, duration_ms, created_at)
       VALUES (?, ?, 'success', ?, ?, ?, ?)`,
    )
      .bind(runId, triggeredBy, topic.title, noteId, Date.now() - t0, created)
      .run();

    return { ok: true, noteId, title: topic.title, snippet };
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

/** Answer a question using past notes (simple RAG). */
export async function ask(env: Env, question: string) {
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

  return {
    answer: String(res.response ?? "").trim(),
    sources: notes.map((n: any) => n.title),
  };
}
