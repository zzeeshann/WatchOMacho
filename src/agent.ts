// The agent's brain.
//
// Two concepts:
//   Target   — a thing being researched (SW1A 1AA, Bhutan, "AI agents")
//   Skill    — a named procedure the agent owns (housing-research, etc.)
//
// One artefact:
//   Report   — markdown writeup produced by running a Skill on a Target.
//              Accumulates on the Target's page over time as the cron
//              re-runs the Skill on its configured cadence.

import { braveSearch, wikipediaSummary, geocodeQuery, type BraveResult } from "./apis";

export interface Env {
  AI: Ai;
  DB: D1Database;
  REPORTS: R2Bucket;
  MEMORY: VectorizeIndex;
  ADMIN_SECRET: string;
  BRAVE_API_KEY?: string;
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

// ─── chat model registry ──────────────────────────────────────────────────
//
// The agent reads the active chat model from the `chat_model` setting at run
// time (editable live from the admin panel). Every value must be in this
// allow-list — anything else falls back to the default so a typo can't break
// production.

export const ALLOWED_CHAT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/qwen/qwq-32b",
] as const;

export const CHAT_MODEL_LABELS: Record<string, string> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B (fast) — strongest, tightest free cap",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small 3.1 (24B) — strong, looser cap",
  "@cf/qwen/qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder (32B) — best for structured output",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout (17B MoE) — newest, fast",
  "@cf/google/gemma-3-12b-it": "Gemma 3 (12B) — Google's reliable mid-size",
  "@cf/meta/llama-3.1-8b-instruct-fast": "Llama 3.1 8B (fast) — cheapest, most generous cap",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": "DeepSeek R1 Distill (32B) — reasoning",
  "@cf/qwen/qwq-32b": "Qwen QwQ (32B) — reasoning",
};

export const DEFAULT_CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function isAllowedChatModel(m: string): boolean {
  return (ALLOWED_CHAT_MODELS as readonly string[]).includes(m);
}

/** Read the currently-selected chat model from settings, falling back to the
 *  default if the setting is unset or contains an unknown value. */
export async function getChatModel(env: Env): Promise<string> {
  const val = await getSetting(env, "chat_model", DEFAULT_CHAT_MODEL);
  return isAllowedChatModel(val) ? val : DEFAULT_CHAT_MODEL;
}

// ─── basics ────────────────────────────────────────────────────────────────

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "x";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── budgets ───────────────────────────────────────────────────────────────

export class BudgetExceeded extends Error {
  constructor(public kind: "reports" | "searches", public limit: number, public used: number) {
    super(`daily ${kind} budget exhausted (${used}/${limit})`);
    this.name = "BudgetExceeded";
  }
}

export async function getDailyUsage(env: Env) {
  const date = todayUtc();
  const row = await env.DB.prepare(
    "SELECT date, reports, searches FROM daily_usage WHERE date = ?",
  )
    .bind(date)
    .first<{ date: string; reports: number; searches: number }>();
  return row ?? { date, reports: 0, searches: 0 };
}

async function bumpUsage(env: Env, kind: "reports" | "searches", by = 1) {
  const date = todayUtc();
  await env.DB.prepare(
    `INSERT INTO daily_usage (date, ${kind}, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET ${kind} = ${kind} + excluded.${kind}, updated_at = excluded.updated_at`,
  )
    .bind(date, by, Date.now())
    .run();
}

async function checkBudget(env: Env, kind: "reports" | "searches") {
  const key = kind === "reports" ? "daily_report_limit" : "daily_search_limit";
  const fallback = kind === "reports" ? "20" : "500";
  const limit = parseInt(await getSetting(env, key, fallback), 10);
  if (!Number.isFinite(limit) || limit <= 0) return; // 0 = disabled
  const usage = await getDailyUsage(env);
  const used = (usage as any)[kind] as number;
  if (used >= limit) throw new BudgetExceeded(kind, limit, used);
}

// ─── settings ──────────────────────────────────────────────────────────────

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

// ─── targets ───────────────────────────────────────────────────────────────

export interface Target {
  id: string;
  slug: string;
  name: string;
  kind: string | null;
  description: string | null;
  status: "active" | "paused" | "archived";
  cadence_hours: number;
  primary_skill_id: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

async function uniqueSlug(env: Env, base: string): Promise<string> {
  let s = slugify(base);
  let suffix = 0;
  while (true) {
    const probe = suffix === 0 ? s : `${s}-${suffix}`;
    const exists = await env.DB.prepare("SELECT 1 FROM targets WHERE slug = ?")
      .bind(probe)
      .first();
    if (!exists) return probe;
    suffix++;
    if (suffix > 50) return `${s}-${uid().slice(0, 6)}`;
  }
}

export async function createTarget(
  env: Env,
  input: { name: string; kind?: string; description?: string; cadence_hours?: number; primary_skill_id?: string },
): Promise<Target> {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  if (name.length > 200) throw new Error("name must be <= 200 chars");
  const slug = await uniqueSlug(env, name);
  const id = uid();
  const now = Date.now();
  const cadence = Math.max(1, Math.min(720, Math.floor(input.cadence_hours ?? 24)));
  await env.DB.prepare(
    `INSERT INTO targets
       (id, slug, name, kind, description, status, cadence_hours, primary_skill_id, last_run_at, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      name,
      input.kind ?? null,
      input.description ?? null,
      cadence,
      input.primary_skill_id ?? null,
      now, // next_run_at = immediately
      now,
      now,
    )
    .run();
  return (await getTargetById(env, id))!;
}

export async function getTargetById(env: Env, id: string): Promise<Target | null> {
  return env.DB.prepare("SELECT * FROM targets WHERE id = ?")
    .bind(id)
    .first<Target>();
}

export async function getTargetBySlug(env: Env, slug: string): Promise<Target | null> {
  return env.DB.prepare("SELECT * FROM targets WHERE slug = ?")
    .bind(slug)
    .first<Target>();
}

export async function listTargets(env: Env, status?: string): Promise<Target[]> {
  if (status) {
    const rows = await env.DB.prepare(
      "SELECT * FROM targets WHERE status = ? ORDER BY updated_at DESC",
    )
      .bind(status)
      .all<Target>();
    return rows.results ?? [];
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM targets ORDER BY updated_at DESC",
  ).all<Target>();
  return rows.results ?? [];
}

export async function updateTarget(
  env: Env,
  id: string,
  patch: Partial<Pick<Target, "kind" | "description" | "status" | "cadence_hours" | "primary_skill_id">>,
): Promise<void> {
  const sets: string[] = [];
  const args: any[] = [];
  if (patch.kind !== undefined) {
    sets.push("kind = ?");
    args.push(patch.kind);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    args.push(patch.description);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.cadence_hours !== undefined) {
    sets.push("cadence_hours = ?");
    args.push(Math.max(1, Math.min(720, Math.floor(patch.cadence_hours))));
  }
  if (patch.primary_skill_id !== undefined) {
    sets.push("primary_skill_id = ?");
    args.push(patch.primary_skill_id);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  await env.DB.prepare(`UPDATE targets SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args)
    .run();
}

export async function deleteTarget(env: Env, id: string): Promise<void> {
  // Best-effort cleanup of associated reports' R2 blobs first.
  const rows = await env.DB.prepare("SELECT r2_key FROM reports WHERE target_id = ?")
    .bind(id)
    .all<{ r2_key: string }>();
  for (const r of rows.results ?? []) {
    await env.REPORTS.delete(r.r2_key).catch(() => {});
  }
  // Pull any report ids so we can drop their Vectorize entries.
  const rps = await env.DB.prepare("SELECT id FROM reports WHERE target_id = ?")
    .bind(id)
    .all<{ id: string }>();
  const ids = (rps.results ?? []).map((r) => r.id);
  if (ids.length > 0) {
    await env.MEMORY.deleteByIds(ids).catch(() => {});
  }
  await env.DB.prepare("DELETE FROM reports WHERE target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM runs WHERE target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(id).run();
}

// ─── skills ────────────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  procedure_md: string;
  author: "user" | "agent";
  used_count: number;
  created_at: number;
  updated_at: number;
}

const SKILL_TEMPLATE = `You are designing a reusable research skill for an AI agent that produces markdown reports.

Given the skill brief below, write a procedure document with these sections, in plain markdown:

# {Skill Name}

**Purpose:** one sentence describing what this skill researches.

**When to use:** the kind of target this works on (postcodes, companies, people, topics, places).

**Approach:** 3–6 sentences of approach. What kinds of sources to lean on, what to look for, what to avoid (hype, marketing, paywalls).

**Search queries:** 4–8 web search queries to run, each using the placeholder \`{target}\` for the target name. Each query goes on its own bulleted line.

**Output structure:** the headings the final report should use, with one sentence each describing what goes under each heading. End with a "Sources" section.

Be specific. The agent will execute this procedure literally. Do not include any preamble or commentary outside the document.
`;

export async function listSkills(env: Env): Promise<Skill[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM skills ORDER BY used_count DESC, updated_at DESC",
  ).all<Skill>();
  return rows.results ?? [];
}

export async function getSkillById(env: Env, id: string): Promise<Skill | null> {
  return env.DB.prepare("SELECT * FROM skills WHERE id = ?")
    .bind(id)
    .first<Skill>();
}

export async function getSkillBySlug(env: Env, slug: string): Promise<Skill | null> {
  return env.DB.prepare("SELECT * FROM skills WHERE slug = ?")
    .bind(slug)
    .first<Skill>();
}

async function uniqueSkillSlug(env: Env, base: string): Promise<string> {
  let s = slugify(base);
  let suffix = 0;
  while (true) {
    const probe = suffix === 0 ? s : `${s}-${suffix}`;
    const exists = await env.DB.prepare("SELECT 1 FROM skills WHERE slug = ?")
      .bind(probe)
      .first();
    if (!exists) return probe;
    suffix++;
    if (suffix > 50) return `${s}-${uid().slice(0, 6)}`;
  }
}

/** Save a skill the user wrote by hand. The full procedure_md is supplied. */
export async function createSkillFromMarkdown(
  env: Env,
  input: { name: string; description?: string; procedure_md: string },
): Promise<Skill> {
  const name = input.name.trim();
  if (!name) throw new Error("name required");
  const procedure_md = input.procedure_md.trim();
  if (procedure_md.length < 30) throw new Error("procedure_md too short");
  const slug = await uniqueSkillSlug(env, name);
  const id = uid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO skills (id, slug, name, description, procedure_md, author, used_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'user', 0, ?, ?)`,
  )
    .bind(id, slug, name, input.description ?? null, procedure_md, now, now)
    .run();
  return (await getSkillById(env, id))!;
}

/** Ask the LLM to write a fresh skill from a one-line brief. */
export async function synthesizeSkill(
  env: Env,
  input: { name?: string; brief: string },
): Promise<Skill> {
  const brief = input.brief.trim();
  if (!brief) throw new Error("brief required");
  const model = await getChatModel(env);
  const res: any = await env.AI.run(model, {
    messages: [
      { role: "system", content: SKILL_TEMPLATE },
      { role: "user", content: `Skill brief: "${brief}"\n\nWrite the procedure document now.` },
    ],
    max_tokens: 900,
  });
  const procedure_md = String(res.response ?? "").trim();
  if (procedure_md.length < 60) throw new Error("LLM returned an empty / too-short skill document");

  // Pull a name out of the first H1 if the brief didn't supply one.
  const heading = procedure_md.match(/^#\s+(.+?)\s*$/m);
  const inferredName = (input.name ?? heading?.[1] ?? brief).trim().slice(0, 80) || "Untitled skill";
  const slug = await uniqueSkillSlug(env, inferredName);
  const id = uid();
  const now = Date.now();

  // One-line description: first non-empty line that isn't the H1.
  const description = procedure_md
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"))
    ?.replace(/\*\*Purpose:\*\*\s*/i, "")
    .slice(0, 200) ?? null;

  await env.DB.prepare(
    `INSERT INTO skills (id, slug, name, description, procedure_md, author, used_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'agent', 0, ?, ?)`,
  )
    .bind(id, slug, inferredName, description, procedure_md, now, now)
    .run();
  return (await getSkillById(env, id))!;
}

export async function updateSkill(
  env: Env,
  id: string,
  patch: Partial<Pick<Skill, "name" | "description" | "procedure_md">>,
): Promise<void> {
  const sets: string[] = [];
  const args: any[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    args.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    args.push(patch.description);
  }
  if (patch.procedure_md !== undefined) {
    sets.push("procedure_md = ?");
    args.push(patch.procedure_md);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  await env.DB.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args)
    .run();
}

export async function deleteSkill(env: Env, id: string): Promise<void> {
  // Detach from any targets first.
  await env.DB.prepare("UPDATE targets SET primary_skill_id = NULL WHERE primary_skill_id = ?")
    .bind(id)
    .run();
  await env.DB.prepare("DELETE FROM skills WHERE id = ?").bind(id).run();
}

// ─── reports ───────────────────────────────────────────────────────────────

export interface Report {
  id: string;
  target_id: string;
  skill_id: string | null;
  title: string;
  snippet: string;
  r2_key: string;
  word_count: number | null;
  sources_json: string | null;
  run_id: string | null;
  chat_model: string | null;
  created_at: number;
}

export async function listReportsForTarget(env: Env, targetId: string, limit = 50): Promise<Report[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM reports WHERE target_id = ? ORDER BY created_at DESC LIMIT ?",
  )
    .bind(targetId, limit)
    .all<Report>();
  return rows.results ?? [];
}

export async function getReportById(env: Env, id: string): Promise<Report | null> {
  return env.DB.prepare("SELECT * FROM reports WHERE id = ?").bind(id).first<Report>();
}

// ─── the research loop ─────────────────────────────────────────────────────

interface ResearchPlan {
  queries: string[];
}

interface SourceCitation {
  title: string;
  url: string;
}

/** Step 1: ask the LLM what to search for. Returns an array of queries with
 *  {target} placeholders already expanded. */
async function planResearch(env: Env, skill: Skill, target: Target, model: string): Promise<ResearchPlan> {
  const res: any = await env.AI.run(model, {
    messages: [
      {
        role: "system",
        content:
          `You are the planning step of a research agent.
You are given a SKILL (a procedure document) and a TARGET (the thing being researched).
Return ONLY a JSON object: { "queries": [string, ...] }
with 3–6 concrete web search queries that, executed and synthesised, will produce a good report.
Replace any "{target}" placeholder in the skill with the target's name. Use specific, narrow queries — not "everything about X". No extra text outside the JSON.`,
      },
      {
        role: "user",
        content: `SKILL\n=====\n${skill.procedure_md}\n\nTARGET\n======\nName: ${target.name}\nKind: ${target.kind ?? "(unspecified)"}\nDescription: ${target.description ?? "(none)"}\n\nReturn the JSON plan now.`,
      },
    ],
    max_tokens: 400,
  });
  const raw = String(res.response ?? "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed.queries)) {
        const queries = parsed.queries
          .map((q: any) => String(q).trim())
          .filter((q: string) => q && q.length <= 250)
          .slice(0, 6);
        if (queries.length > 0) return { queries };
      }
    } catch {
      // fall through
    }
  }
  // Fallback: a generic query so the run doesn't die.
  return { queries: [`${target.name}`, `${target.name} ${skill.name}`] };
}

/** Step 2: run all queries against Brave Search in parallel. */
async function gatherSources(env: Env, queries: string[]): Promise<BraveResult[]> {
  await checkBudget(env, "searches");
  const results = await Promise.all(
    queries.map((q) => braveSearch(env.BRAVE_API_KEY, q, 5).catch(() => [])),
  );
  await bumpUsage(env, "searches", queries.length);

  // Flatten + dedup by URL, keep first-seen order.
  const seen = new Set<string>();
  const out: BraveResult[] = [];
  for (const list of results) {
    for (const r of list) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
  }
  return out.slice(0, 20);
}

/** Step 3: optionally enrich the target with Wikipedia context once (only
 *  on the first run for a target, to keep cost down). */
async function maybeWikipediaContext(target: Target, hasPriorReports: boolean): Promise<string> {
  if (hasPriorReports) return "";
  const summary = await wikipediaSummary(target.name).catch(() => null);
  if (!summary || !summary.extract) return "";
  return `\n\nWIKIPEDIA OVERVIEW\n${summary.extract}\n(source: ${summary.url})`;
}

/** Step 4: recall similar past reports across the whole memory. Same-target
 *  history is also surfaced separately so the new report doesn't repeat. */
async function recallMemory(
  env: Env,
  target: Target,
  skill: Skill,
): Promise<{ priorOnTarget: Report[]; relatedAcrossTargets: string[] }> {
  const priorOnTarget = await listReportsForTarget(env, target.id, 4);

  let related: string[] = [];
  try {
    const emb: any = await env.AI.run(EMBED_MODEL, {
      text: [`${target.name}. ${skill.name}. ${target.description ?? ""}`.slice(0, 1000)],
    });
    const vec = emb.data?.[0];
    if (vec) {
      const hits = await env.MEMORY.query(vec, { topK: 4, returnMetadata: "all" });
      related = (hits.matches ?? [])
        .filter((m: any) => m.score > 0.4)
        .filter((m: any) => m.metadata?.target_id !== target.id)
        .map((m: any) =>
          `- ${m.metadata?.target_name ?? "?"}: ${String(m.metadata?.snippet ?? "").slice(0, 220)}`,
        );
    }
  } catch (e) {
    console.error("recall failed", e);
  }
  return { priorOnTarget, relatedAcrossTargets: related };
}

/** Step 5: ask the LLM to write the report, given everything we gathered. */
async function writeReport(
  env: Env,
  skill: Skill,
  target: Target,
  sources: BraveResult[],
  priorOnTarget: Report[],
  relatedAcrossTargets: string[],
  wikiContext: string,
  model: string,
): Promise<{ title: string; body: string }> {
  const sourceBlock = sources.length
    ? sources
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title}\n${s.url}${s.age ? ` · ${s.age}` : ""}\n${s.description}`,
        )
        .join("\n\n")
    : "(No web search results — write from general knowledge but explicitly say so.)";

  const priorBlock = priorOnTarget.length
    ? `\n\nPRIOR REPORTS ON THIS TARGET (do not repeat — build on them, surface what's changed):\n${priorOnTarget
        .map((r) => `- ${new Date(r.created_at).toISOString().slice(0, 10)} — ${r.title}: ${r.snippet}`)
        .join("\n")}`
    : "";

  const relatedBlock = relatedAcrossTargets.length
    ? `\n\nRELATED CONTEXT FROM OTHER TARGETS (use sparingly — only if genuinely connecting):\n${relatedAcrossTargets.join("\n")}`
    : "";

  const userMsg = `SKILL TO APPLY
=====
${skill.procedure_md}

TARGET
======
Name: ${target.name}
Kind: ${target.kind ?? "(unspecified)"}
Description: ${target.description ?? "(none)"}
${wikiContext}

WEB SEARCH RESULTS
==================
${sourceBlock}
${priorBlock}
${relatedBlock}

Now write the report. Follow the output structure defined in the skill. End with a "Sources" section listing the URLs you actually used (cite by [n] in the body where you draw from a source). Be concrete, not generic. If sources contradict, say so. If you don't have enough information for a section, say "Not enough source material yet" rather than padding.`;

  const res: any = await env.AI.run(model, {
    messages: [
      {
        role: "system",
        content: `You are a research agent that writes precise, scannable markdown reports. Tone: editorial, calm, intellectually honest. No hype, no filler phrases ("rich history", "fascinating place", "in conclusion"). Cite sources by [number]. Sentence case headings. Aim for ~500 words.`,
      },
      { role: "user", content: userMsg },
    ],
    max_tokens: 1200,
  });

  const body = String(res.response ?? "").trim();
  if (!body || body.length < 80) throw new Error("LLM returned empty or too-short report");

  // The title is the target name + skill name, dated. We don't ask the LLM
  // to pick it — keeps reports comparable across the same target.
  const dateLabel = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const title = `${target.name} — ${skill.name} (${dateLabel})`;

  return { title, body };
}

/** The full research loop. Plan → gather → recall → write → persist. */
export async function runResearch(
  env: Env,
  target: Target,
  skill: Skill,
  triggeredBy: "cron" | "manual",
): Promise<Report> {
  await checkBudget(env, "reports");

  const runId = uid();
  const t0 = Date.now();

  // Resolve the chat model ONCE at the start so every step of this run uses
  // the same model and the persisted report records exactly that model.
  const chatModel = await getChatModel(env);

  try {
    const plan = await planResearch(env, skill, target, chatModel);
    const sources = await gatherSources(env, plan.queries);
    const { priorOnTarget, relatedAcrossTargets } = await recallMemory(env, target, skill);
    const wikiContext = await maybeWikipediaContext(target, priorOnTarget.length > 0);

    const { title, body } = await writeReport(
      env,
      skill,
      target,
      sources,
      priorOnTarget,
      relatedAcrossTargets,
      wikiContext,
      chatModel,
    );

    const reportId = uid();
    const created = Date.now();
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    const snippet = body.replace(/\s+/g, " ").slice(0, 240).trim() + "…";

    const md = [
      `# ${title}`,
      ``,
      `*Target: [${target.name}](/target/${target.slug}) · Skill: ${skill.name}*`,
      `*Generated: ${new Date(created).toISOString()}*`,
      ``,
      body,
    ].join("\n");

    const r2Key = `reports/${created}-${reportId}.md`;
    await env.REPORTS.put(r2Key, md, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });

    const sourcesJson = JSON.stringify(
      sources.map((s) => ({ title: s.title, url: s.url })).slice(0, 20),
    );

    await env.DB.prepare(
      `INSERT INTO reports (id, target_id, skill_id, title, snippet, r2_key, word_count, sources_json, run_id, chat_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(reportId, target.id, skill.id, title, snippet, r2Key, wordCount, sourcesJson, runId, chatModel, created)
      .run();

    // Embed for cross-target recall.
    try {
      const emb: any = await env.AI.run(EMBED_MODEL, {
        text: [`${target.name}. ${skill.name}. ${body}`.slice(0, 2000)],
      });
      const vec = emb.data?.[0];
      if (vec) {
        await env.MEMORY.upsert([
          {
            id: reportId,
            values: vec,
            metadata: {
              target_id: target.id,
              target_name: target.name,
              target_slug: target.slug,
              skill_slug: skill.slug,
              title,
              snippet,
              created_at: created,
            },
          },
        ]);
      }
    } catch (e) {
      console.error("embed failed", e);
    }

    await env.DB.prepare("UPDATE skills SET used_count = used_count + 1, updated_at = ? WHERE id = ?")
      .bind(Date.now(), skill.id)
      .run();

    await env.DB.prepare(
      `UPDATE targets SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(created, created + target.cadence_hours * 3600 * 1000, created, target.id)
      .run();

    await env.DB.prepare(
      `INSERT INTO runs (id, target_id, skill_id, triggered_by, status, report_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, 'success', ?, ?, ?)`,
    )
      .bind(runId, target.id, skill.id, triggeredBy, reportId, Date.now() - t0, Date.now())
      .run();

    await bumpUsage(env, "reports");

    return (await getReportById(env, reportId))!;
  } catch (err: any) {
    await env.DB.prepare(
      `INSERT INTO runs (id, target_id, skill_id, triggered_by, status, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, 'error', ?, ?, ?)`,
    )
      .bind(
        runId,
        target.id,
        skill.id,
        triggeredBy,
        String(err?.message ?? err),
        Date.now() - t0,
        Date.now(),
      )
      .run()
      .catch(() => {});
    throw err;
  }
}

// ─── cron tick: pick due targets, re-run their skill ───────────────────────

/** Called from the scheduled handler. Walks active targets whose
 *  next_run_at has passed and runs their primary skill against them.
 *  Caps how many it does per tick (default 2) so we stay within the
 *  waitUntil window comfortably. */
export async function cronTick(env: Env): Promise<{ processed: number; skipped: number; errors: number }> {
  const now = Date.now();
  const maxPerTick = parseInt(await getSetting(env, "cron_max_per_tick", "2"), 10) || 2;

  const due = await env.DB.prepare(
    `SELECT * FROM targets
     WHERE status = 'active'
       AND primary_skill_id IS NOT NULL
       AND (next_run_at IS NULL OR next_run_at <= ?)
     ORDER BY COALESCE(next_run_at, 0) ASC
     LIMIT ?`,
  )
    .bind(now, maxPerTick)
    .all<Target>();

  let processed = 0, skipped = 0, errors = 0;

  for (const target of due.results ?? []) {
    if (!target.primary_skill_id) {
      skipped++;
      continue;
    }
    const skill = await getSkillById(env, target.primary_skill_id);
    if (!skill) {
      skipped++;
      continue;
    }
    try {
      await runResearch(env, target, skill, "cron");
      processed++;
    } catch (e: any) {
      if (e instanceof BudgetExceeded) {
        console.warn("cronTick: daily budget exhausted, stopping");
        break;
      }
      errors++;
      console.error("cron run failed", target.slug, e);
    }
  }

  await setSetting(env, "last_cron_run", String(now));
  return { processed, skipped, errors };
}
