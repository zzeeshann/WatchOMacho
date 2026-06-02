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

import { DurableObject } from "cloudflare:workers";
import {
  tavilyExtract,
  tavilySearch,
  TOOLS,
  type TavilySearchOptions,
} from "./apis";
import { VOICE_CONTRACT, LESSON_CONTRACT, LAB_CONTRACT } from "./contracts";
import { validateLab } from "./lab-validator";

export interface Env {
  AI: Ai;
  DB: D1Database;
  REPORTS: R2Bucket;
  MEMORY: VectorizeIndex;
  ADMIN_SECRET: string;
  /** Read-only API key for /api/reports/* endpoints. Set via:
   *    wrangler secret put WATCHOMACHO_API_KEY
   *  Callers send it in the `X-API-Key` header. If unset, all /api/*
   *  endpoints return 401 — read-only access stays explicitly gated. */
  WATCHOMACHO_API_KEY?: string;
  TAVILY_API_KEY?: string;
  CH_API_KEY?: string;                 // Companies House developer API key (optional)
  // ─── AI Gateway (optional; enables `anthropic/...` chat models) ──────────
  AI_GATEWAY_ACCOUNT_ID?: string;      // Cloudflare account ID (visible in any dashboard URL)
  AI_GATEWAY_NAME?: string;            // The gateway name you created in CF dashboard
  // Auth: pick ONE of the two below.
  // Preferred: CF_AIG_TOKEN  — Cloudflare API token, billed via Cloudflare
  //                            (Unified Billing — single invoice, no Anthropic account)
  // Fallback: ANTHROPIC_API_KEY — your own Anthropic console key, billed by Anthropic
  CF_AIG_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  // ─── Durable Object: longer-budget background work for Run Now ─────────────
  // Manual runs schedule themselves into this DO's alarm handler (15-min wall
  // budget) instead of the HTTP context's 30-second `waitUntil` cap.
  RESEARCH_RUNNER: DurableObjectNamespace<ResearchRunner>;
}

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

// ─── chat model registry ──────────────────────────────────────────────────
//
// The agent reads the active chat model from the `chat_model` setting at run
// time (editable live from the admin panel). Every value must be in this
// allow-list — anything else falls back to the default so a typo can't break
// production.

export const ALLOWED_CHAT_MODELS = [
  // ─── Cloudflare Workers AI (free 10k neurons/day, shared across all models) ─
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/qwen/qwq-32b",
  // ─── AI Gateway → Anthropic (pay-per-token, bypasses Workers AI quota) ─────
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001",
] as const;

export const CHAT_MODEL_LABELS: Record<string, string> = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B (fast) — ~28 reports/day on free pool",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small 3.1 (24B) — ~43 reports/day on free pool",
  "@cf/qwen/qwen2.5-coder-32b-instruct": "Qwen 2.5 Coder (32B) — best for structured output",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout (17B MoE) — ~47 reports/day on free pool",
  "@cf/google/gemma-3-12b-it": "Gemma 3 (12B) — ~44 reports/day on free pool",
  "@cf/meta/llama-3.1-8b-instruct-fast": "Llama 3.1 8B (fast) — ~100 reports/day on free pool",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": "DeepSeek R1 Distill (32B) — reasoning",
  "@cf/qwen/qwq-32b": "Qwen QwQ (32B) — reasoning",
  "anthropic/claude-sonnet-4-6": "Claude Sonnet 4.6 (AI Gateway) — paid, ~$0.05/report, best quality",
  "anthropic/claude-haiku-4-5-20251001": "Claude Haiku 4.5 (AI Gateway) — paid, ~$0.01/report, no Workers AI quota",
};

export const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-4-6";

export function isAllowedChatModel(m: string): boolean {
  return (ALLOWED_CHAT_MODELS as readonly string[]).includes(m);
}

/** Read the currently-selected chat model from settings, falling back to the
 *  default if the setting is unset or contains an unknown value. */
export async function getChatModel(env: Env): Promise<string> {
  const val = await getSetting(env, "chat_model", DEFAULT_CHAT_MODEL);
  return isAllowedChatModel(val) ? val : DEFAULT_CHAT_MODEL;
}

/** Read the global day-map default (`day_map_enabled` setting, ships 'off').
 *  Per-target overrides live on targets.day_map_enabled; resolve the effective
 *  value with dayMapEnabledForTarget() below. */
export async function getDayMapEnabledDefault(env: Env): Promise<boolean> {
  return (await getSetting(env, "day_map_enabled", "off")) === "on";
}

/** Effective day-map switch for a target: the per-target column wins (1 on /
 *  0 off), NULL falls back to the global `day_map_enabled` default. */
export async function dayMapEnabledForTarget(env: Env, target: Target): Promise<boolean> {
  if (target.day_map_enabled === 1) return true;
  if (target.day_map_enabled === 0) return false;
  return getDayMapEnabledDefault(env);
}

// ─── chat dispatcher ──────────────────────────────────────────────────────
//
// Single chat entry point. Routes by model prefix:
//   "@cf/..."         → Cloudflare Workers AI via env.AI.run
//   "anthropic/..."   → Anthropic Messages API via Cloudflare AI Gateway
//
// Returns a uniform { response: string } so call sites stay identical
// regardless of provider. Embedding calls (EMBED_MODEL) keep using
// env.AI.run directly — they're not chat.

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface RunChatInput {
  messages: ChatMessage[];
  max_tokens?: number;
}

interface RunChatOutput {
  response: string;
}

async function runChat(env: Env, model: string, input: RunChatInput, signal?: AbortSignal): Promise<RunChatOutput> {
  if (model.startsWith("@cf/")) {
    // Workers AI binding doesn't accept an AbortSignal; we can't cancel
    // it mid-call. In practice these calls are fast (<2s for embeddings).
    const res: any = await env.AI.run(model, {
      messages: input.messages,
      max_tokens: input.max_tokens,
    });
    return { response: String(res.response ?? "") };
  }

  if (model.startsWith("anthropic/")) {
    return runAnthropicChat(env, model.slice("anthropic/".length), input, signal);
  }

  throw new Error(`Unknown chat model prefix: ${model}`);
}

async function runAnthropicChat(
  env: Env,
  anthropicModel: string,
  input: RunChatInput,
  signal?: AbortSignal,
): Promise<RunChatOutput> {
  if (!env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME) {
    throw new Error(
      "AI_GATEWAY_ACCOUNT_ID + AI_GATEWAY_NAME secrets required for anthropic/... models",
    );
  }
  if (!env.CF_AIG_TOKEN && !env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Set either CF_AIG_TOKEN (Unified Billing, recommended) or ANTHROPIC_API_KEY",
    );
  }

  // Anthropic puts system messages in a separate `system` field, not in
  // messages. Combine all system messages into one string.
  const systemParts: string[] = [];
  const otherMsgs: ChatMessage[] = [];
  for (const m of input.messages) {
    if (m.role === "system") systemParts.push(m.content);
    else otherMsgs.push(m);
  }

  const url = `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/anthropic/v1/messages`;

  // Auth: Unified Billing if CF_AIG_TOKEN is set (Cloudflare bills via your
  // CF account credits); otherwise BYOK with your Anthropic console key.
  // With Unified Billing, the `x-api-key` header must be omitted entirely —
  // an empty value triggers Anthropic's pre-validation 401.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (env.CF_AIG_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  } else {
    headers["x-api-key"] = env.ANTHROPIC_API_KEY!;
  }

  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: anthropicModel,
      max_tokens: input.max_tokens ?? 1024,
      system: systemParts.length ? systemParts.join("\n\n") : undefined,
      messages: otherMsgs.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal,
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${body.slice(0, 400)}`);
  }

  const data: any = await r.json();
  // Anthropic returns content as an array of typed blocks; we expect one text block.
  const text = (data.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join("");
  return { response: text };
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
  // Per-target Tavily knobs (v11). NULL = use the global default. The
  // planner reads queries_per_run to decide how many queries to ask for;
  // gather reads the two scoring/cap knobs.
  queries_per_run: number | null;
  tavily_min_score: number | null;
  tavily_max_final_sources: number | null;
  // Fixed daily anchor for scheduling (v12). 0-23, UTC. NULL = inherit
  // DEFAULT_ANCHOR_HOUR_UTC below. See computeNextRunAt() for the slot
  // formula and migration-v12.sql for the rationale.
  anchor_hour_utc: number | null;
  // Per-target day-map switch (v14). 1 = on, 0 = off, NULL = inherit the global
  // `day_map_enabled` setting. See dayMapEnabledForTarget() / makeDayMap().
  day_map_enabled: number | null;
  created_at: number;
  updated_at: number;
}

/** Default anchor hour (UTC) when a target has anchor_hour_utc = NULL.
 *  02:00 UTC = 03:00 BST / 21:00 EST — overnight in most populated time
 *  zones, so cron tick noise doesn't compete with daytime traffic. */
export const DEFAULT_ANCHOR_HOUR_UTC = 2;

/** Compute the next scheduled run timestamp for a target.
 *
 *  Slots fire at `anchor + k * cadence_hours` (mod day) in UTC. We pick the
 *  first slot strictly after `nowMs`. "Strictly after" prevents the just-
 *  completed run from re-firing on the same tick.
 *
 *  Edge cases:
 *  - cadence_hours not a divisor of 24 (e.g. 7, 72): slots still walk
 *    forward by cadence each step. With cadence=72 anchor=2 the slot
 *    cycles through 02:00 UTC every three days.
 *  - cadence_hours = 1: slots are hourly, anchor effectively pins the
 *    minute (always :00). Same as the old behaviour.
 *  - cadence_hours >= 24*K: slots are still spaced by exactly cadence,
 *    so e.g. cadence=168 anchor=2 is "weekly at 02:00 UTC starting from
 *    the most recent past 02:00 UTC plus the cadence multiple".
 *
 *  Returned timestamp is in milliseconds (matches the rest of the schema).
 */
export function computeNextRunAt(
  nowMs: number,
  cadenceHours: number,
  anchorHourUtc: number,
): number {
  const cad = Math.max(1, Math.min(720, Math.floor(cadenceHours)));
  const anchor = Math.max(0, Math.min(23, Math.floor(anchorHourUtc)));
  const cadMs = cad * 3600 * 1000;
  const now = new Date(nowMs);
  // Today's anchor wall-clock in UTC. May be in the past (most cases) or
  // future (if `now` is between 00:00 and anchor:00 UTC).
  let slot = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    anchor,
    0,
    0,
    0,
  );
  // If today's anchor is itself in the future, that's the next slot —
  // unless cadence < 24, in which case there may be an earlier same-day
  // slot already past. Walk forward from a safe lower bound instead.
  if (cad < 24) {
    // Step back to the most recent slot <= nowMs, then step forward to
    // the first slot > nowMs.
    while (slot > nowMs) slot -= cadMs;
  }
  while (slot <= nowMs) slot += cadMs;
  return slot;
}

/** Re-read a target and snap its next_run_at to the next anchored slot.
 *  Called from the admin update handler whenever cadence or anchor
 *  changes, so the new schedule takes effect immediately rather than
 *  after the next completed run. */
export async function rescheduleTarget(env: Env, id: string): Promise<void> {
  const t = await getTargetById(env, id);
  if (!t) return;
  const anchor = t.anchor_hour_utc ?? DEFAULT_ANCHOR_HOUR_UTC;
  const next = computeNextRunAt(Date.now(), t.cadence_hours, anchor);
  await env.DB.prepare(
    `UPDATE targets SET next_run_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(next, Date.now(), id)
    .run();
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
  input: {
    name: string;
    kind?: string;
    description?: string;
    cadence_hours?: number;
    primary_skill_id?: string;
    /** 0-23 UTC, or null/undefined to inherit DEFAULT_ANCHOR_HOUR_UTC. */
    anchor_hour_utc?: number | null;
  },
): Promise<Target> {
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  if (name.length > 200) throw new Error("name must be <= 200 chars");
  const slug = await uniqueSlug(env, name);
  const id = uid();
  const now = Date.now();
  const cadence = Math.max(1, Math.min(720, Math.floor(input.cadence_hours ?? 24)));
  // Anchor: clamp to 0-23 if provided, otherwise NULL (inherits default).
  const anchor =
    input.anchor_hour_utc === undefined || input.anchor_hour_utc === null
      ? null
      : Math.max(0, Math.min(23, Math.floor(input.anchor_hour_utc)));
  await env.DB.prepare(
    `INSERT INTO targets
       (id, slug, name, kind, description, status, cadence_hours, primary_skill_id, last_run_at, next_run_at, anchor_hour_utc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      name,
      input.kind ?? null,
      input.description ?? null,
      cadence,
      input.primary_skill_id ?? null,
      now, // next_run_at = immediately (next cron tick will pick it up)
      anchor,
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
  patch: Partial<
    Pick<
      Target,
      | "kind"
      | "description"
      | "status"
      | "cadence_hours"
      | "primary_skill_id"
      | "queries_per_run"
      | "tavily_min_score"
      | "tavily_max_final_sources"
      | "anchor_hour_utc"
      | "day_map_enabled"
    >
  >,
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
  // The three Tavily knobs accept NULL ("use the global default") explicitly.
  if (patch.queries_per_run !== undefined) {
    sets.push("queries_per_run = ?");
    args.push(patch.queries_per_run === null
      ? null
      : Math.max(1, Math.min(20, Math.floor(patch.queries_per_run))));
  }
  if (patch.tavily_min_score !== undefined) {
    sets.push("tavily_min_score = ?");
    args.push(patch.tavily_min_score === null
      ? null
      : Math.max(0, Math.min(1, Math.round(patch.tavily_min_score * 100) / 100)));
  }
  if (patch.tavily_max_final_sources !== undefined) {
    sets.push("tavily_max_final_sources = ?");
    args.push(patch.tavily_max_final_sources === null
      ? null
      : Math.max(1, Math.min(200, Math.floor(patch.tavily_max_final_sources))));
  }
  // Anchor hour (v12). NULL = inherit DEFAULT_ANCHOR_HOUR_UTC. Clamp 0-23.
  // The caller (admin update handler) is responsible for calling
  // rescheduleTarget() after this UPDATE if cadence or anchor changed —
  // otherwise the next_run_at row stays on the old schedule until the
  // next completed run rewrites it.
  if (patch.anchor_hour_utc !== undefined) {
    sets.push("anchor_hour_utc = ?");
    args.push(patch.anchor_hour_utc === null
      ? null
      : Math.max(0, Math.min(23, Math.floor(patch.anchor_hour_utc))));
  }
  // Day-map switch (v14). NULL = inherit the global default; 1 = on; 0 = off.
  if (patch.day_map_enabled !== undefined) {
    sets.push("day_map_enabled = ?");
    args.push(patch.day_map_enabled === null ? null : (patch.day_map_enabled ? 1 : 0));
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  await env.DB.prepare(`UPDATE targets SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args)
    .run();
}

/** R2 keys that aren't reports and must never be considered orphans. Bump
 *  this set when adding new static assets. */
const R2_STATIC_KEEP: ReadonlySet<string> = new Set([
  "static/tailwind.v1.css",   // legacy, kept for any still-cached pages
  "static/tailwind.v2.css",   // legacy, kept for any still-cached pages
  "static/tailwind.v3.css",   // legacy, kept for any still-cached pages
  "static/tailwind.v4.css",   // legacy, kept for any still-cached pages
  "static/tailwind.v5.css",   // current
]);

/** Scan R2 once, returning total object count and the keys not referenced by
 *  any `reports.r2_key`. Shared by the count-only admin display and the
 *  delete-and-sweep `gcOrphanedR2`. */
export async function findOrphanedR2(
  env: Env,
): Promise<{ scanned: number; orphans: string[] }> {
  const known = new Set<string>(R2_STATIC_KEEP);
  const rows = await env.DB.prepare(
    "SELECT r2_key, day_map_r2_key FROM reports",
  ).all<{ r2_key: string; day_map_r2_key: string | null }>();
  for (const r of rows.results ?? []) {
    known.add(r.r2_key);
    // Day-map HTML lives under its own column (v14) — keep it too, or the
    // sweep would delete every day-map on the next tick.
    if (r.day_map_r2_key) known.add(r.day_map_r2_key);
  }
  // Edition pieces (lesson + lab, 2026-06-01) store their body/html in R2 as
  // well, keyed in `edition_pieces.r2_key` — NOT in `reports`. They MUST be in
  // the keep-set or the sweep deletes every lesson + lab blob as a false
  // orphan (the day-map survives only because it sits in `reports`). This
  // omission silently wiped all lesson/lab bodies → the lesson-404.
  const pieceRows = await env.DB.prepare(
    "SELECT r2_key FROM edition_pieces WHERE r2_key IS NOT NULL",
  ).all<{ r2_key: string }>();
  for (const p of pieceRows.results ?? []) {
    if (p.r2_key) known.add(p.r2_key);
  }

  let scanned = 0;
  const orphans: string[] = [];
  let cursor: string | undefined;
  do {
    const page: R2Objects = await env.REPORTS.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      scanned++;
      if (!known.has(o.key)) orphans.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { scanned, orphans };
}

/** Sweep R2 for blobs not referenced by any `reports.r2_key`. Used as the
 *  self-heal step at the end of `deleteTarget`, the cron-tick periodic
 *  sweeper, and the manual admin one-shot via `/admin/storage/gc`. Failures
 *  are logged, not swallowed. */
export async function gcOrphanedR2(
  env: Env,
): Promise<{ scanned: number; orphans: number; deleted: number; failures: string[] }> {
  const { scanned, orphans } = await findOrphanedR2(env);

  let deleted = 0;
  const failures: string[] = [];
  for (const key of orphans) {
    try {
      await env.REPORTS.delete(key);
      deleted++;
    } catch (e) {
      console.error("gcOrphanedR2: delete failed", key, e);
      failures.push(key);
    }
  }
  return { scanned, orphans: orphans.length, deleted, failures };
}

// ─── recall memory (Vectorize) ─────────────────────────────────────────────

/** Shape required by `embedReport`. Keeps the helper agnostic to whether
 *  the report was just written (runResearch) or backfilled (from D1+R2). */
export interface ReportForEmbed {
  id: string;
  target_id: string;
  target_name: string;
  target_slug: string;
  skill_id: string | null;
  skill_slug: string;
  skill_name: string;
  title: string;
  snippet: string;
  body: string;
  created_at: number;
}

/** Embed a report and upsert it into Vectorize. Outcome is recorded to the
 *  settings table (`embed_last_ok_at` / `embed_last_error`) so the admin
 *  page can surface failures without anyone reading wrangler logs. Never
 *  throws — by design embedding is best-effort, so the caller can ignore
 *  the return value if it wants to. */
export async function embedReport(
  env: Env,
  r: ReportForEmbed,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const text = `${r.target_name}. ${r.skill_name}. ${r.body}`.slice(0, 2000);
    const emb: any = await env.AI.run(EMBED_MODEL, { text: [text] });
    const vec = emb?.data?.[0];
    if (!vec || !Array.isArray(vec)) {
      throw new Error("embedding model returned no vector");
    }
    await env.MEMORY.upsert([
      {
        id: r.id,
        values: vec,
        metadata: {
          target_id: r.target_id,
          target_name: r.target_name,
          target_slug: r.target_slug,
          skill_slug: r.skill_slug,
          title: r.title,
          snippet: r.snippet,
          created_at: r.created_at,
        },
      },
    ]);
    await setSetting(env, "embed_last_ok_at", String(Date.now()));
    await setSetting(env, "embed_last_error", "");
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    console.error("embedReport failed", r.id, msg);
    await setSetting(
      env,
      "embed_last_error",
      JSON.stringify({ message: msg, at: Date.now(), report_id: r.id }),
    ).catch(() => {});
    return { ok: false, error: msg };
  }
}

/** Walk every report in D1, fetch the markdown from R2, and re-embed via
 *  `embedReport`. Idempotent — Vectorize upsert overwrites by id, so
 *  running this twice is harmless. Reports whose R2 blob is missing are
 *  counted as failures (the body is the embed input, so without it we
 *  can't produce a meaningful vector). */
export async function backfillMemory(
  env: Env,
): Promise<{ scanned: number; embedded: number; failed: number; errors: string[] }> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.target_id, r.skill_id, r.title, r.snippet, r.r2_key, r.created_at,
            t.name AS target_name, t.slug AS target_slug,
            s.slug AS skill_slug, s.name AS skill_name
       FROM reports r
       LEFT JOIN targets t ON r.target_id = t.id
       LEFT JOIN skills  s ON r.skill_id  = s.id
       ORDER BY r.created_at DESC`,
  ).all<any>();

  let embedded = 0;
  let failed = 0;
  const errors: string[] = [];
  const scanned = rows.results?.length ?? 0;

  for (const r of rows.results ?? []) {
    const obj = await env.REPORTS.get(r.r2_key);
    if (!obj) {
      failed++;
      errors.push(`${r.id}: R2 blob missing`);
      continue;
    }
    const body = await obj.text();
    const res = await embedReport(env, {
      id: r.id,
      target_id: r.target_id,
      target_name: r.target_name ?? "",
      target_slug: r.target_slug ?? "",
      skill_id: r.skill_id,
      skill_slug: r.skill_slug ?? "",
      skill_name: r.skill_name ?? "",
      title: r.title,
      snippet: r.snippet,
      body,
      created_at: r.created_at,
    });
    if (res.ok) embedded++;
    else {
      failed++;
      errors.push(`${r.id}: ${res.error.slice(0, 120)}`);
    }
  }

  return { scanned, embedded, failed, errors };
}

/** Delete a single report and everything attached to it: R2 blob, Vectorize
 *  entry, the reports row, and the matching runs row. The run row goes too
 *  because once the report is gone the run is just an unmoored "something
 *  ran" record with no payload to link to. */
export async function deleteReport(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare("SELECT r2_key, day_map_r2_key FROM reports WHERE id = ?")
    .bind(id)
    .first<{ r2_key: string; day_map_r2_key: string | null }>();
  if (!row) return;
  try {
    await env.REPORTS.delete(row.r2_key);
  } catch (e) {
    console.error("deleteReport: R2 delete failed", row.r2_key, e);
  }
  // Also drop the paired day-map HTML (v14) so it doesn't leak as an orphan.
  if (row.day_map_r2_key) {
    try {
      await env.REPORTS.delete(row.day_map_r2_key);
    } catch (e) {
      console.error("deleteReport: day-map R2 delete failed", row.day_map_r2_key, e);
    }
  }
  try {
    await env.MEMORY.deleteByIds([id]);
  } catch (e) {
    console.error("deleteReport: Vectorize deleteByIds failed", e);
  }
  // Edition pieces (lesson + lab): R2 bodies AND D1 rows. Without this they leak
  // permanently — gcOrphanedR2 keeps any edition_pieces.r2_key in its keep-set,
  // so an orphaned row pins its orphaned blob forever (the GC can never reclaim
  // it). Delete the blobs first, then the rows.
  const pieces = await env.DB.prepare(
    "SELECT r2_key FROM edition_pieces WHERE report_id = ? AND r2_key IS NOT NULL",
  )
    .bind(id)
    .all<{ r2_key: string }>();
  for (const p of pieces.results ?? []) {
    try {
      await env.REPORTS.delete(p.r2_key);
    } catch (e) {
      console.error("deleteReport: edition_piece R2 delete failed", p.r2_key, e);
    }
  }
  await env.DB.prepare("DELETE FROM edition_pieces WHERE report_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM runs WHERE report_id = ?").bind(id).run();
}

export async function deleteTarget(env: Env, id: string): Promise<void> {
  const rows = await env.DB.prepare("SELECT id, r2_key FROM reports WHERE target_id = ?")
    .bind(id)
    .all<{ id: string; r2_key: string }>();
  const reportRows = rows.results ?? [];
  const ids: string[] = [];
  for (const r of reportRows) {
    ids.push(r.id);
    try {
      await env.REPORTS.delete(r.r2_key);
    } catch (e) {
      // Don't abort — gcOrphanedR2 below will retry the leak and surface it
      // in the log. Aborting would leave D1 rows pointing at a half-deleted
      // bucket, which is worse than a transient orphan.
      console.error("deleteTarget: R2 delete failed", r.r2_key, e);
    }
  }
  if (ids.length > 0) {
    try {
      await env.MEMORY.deleteByIds(ids);
    } catch (e) {
      console.error("deleteTarget: Vectorize deleteByIds failed", e);
    }
    // Edition pieces (lesson + lab) for every report of this target: R2 bodies
    // AND D1 rows. Same leak as deleteReport — orphaned edition_pieces rows pin
    // their R2 blobs in gcOrphanedR2's keep-set forever. Sweep by the report ids
    // collected above.
    const placeholders = ids.map(() => "?").join(",");
    const pieces = await env.DB.prepare(
      `SELECT r2_key FROM edition_pieces WHERE r2_key IS NOT NULL AND report_id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ r2_key: string }>();
    for (const p of pieces.results ?? []) {
      try {
        await env.REPORTS.delete(p.r2_key);
      } catch (e) {
        console.error("deleteTarget: edition_piece R2 delete failed", p.r2_key, e);
      }
    }
    await env.DB.prepare(`DELETE FROM edition_pieces WHERE report_id IN (${placeholders})`)
      .bind(...ids)
      .run();
  }
  await env.DB.prepare("DELETE FROM reports WHERE target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM runs WHERE target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(id).run();

  const gc = await gcOrphanedR2(env);
  if (gc.orphans > 0 || gc.failures.length > 0) {
    console.log("deleteTarget: gcOrphanedR2", gc);
  }
}

// ─── skills ────────────────────────────────────────────────────────────────

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** The writer instructions, free-text markdown. Goes verbatim into the
   *  planner + writer system prompts. NO magic header parsing — tool
   *  selection lives in tool_slug/tool_op/tool_params_json. */
  procedure_md: string;
  /** Tool selection (v10). NULL = writer-only skill, no data gathering. */
  tool_slug: string | null;
  tool_op: string | null;
  tool_params_json: string | null;
  tool_sources_json: string | null;
  author: "user" | "agent";
  used_count: number;
  created_at: number;
  updated_at: number;
}

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

/** Sensible defaults for a brand-new Tavily/search skill. Centralised so the
 *  hand-write path, synth path, and migration backfill all stay aligned. */
const DEFAULT_TOOL_SLUG = "tavily";
const DEFAULT_TOOL_OP = "search";

/** Validate a tool/op pair against the live TOOLS registry. Returns the
 *  normalised pair, or throws. NULL tool_slug = writer-only skill (no
 *  gather step). */
function normaliseToolConfig(input: { tool_slug?: string | null; tool_op?: string | null }):
  { tool_slug: string | null; tool_op: string | null }
{
  if (!input.tool_slug) return { tool_slug: null, tool_op: null };
  const tool = TOOLS[input.tool_slug];
  if (!tool) throw new Error(`unknown tool slug: ${input.tool_slug}`);
  const op = (input.tool_op ?? "").toLowerCase();
  if (!op || !(op in tool.operations)) {
    throw new Error(`unknown op "${op}" for tool ${input.tool_slug}`);
  }
  return { tool_slug: input.tool_slug, tool_op: op };
}

/** Save a skill the user wrote by hand. */
export async function createSkillFromMarkdown(
  env: Env,
  input: {
    name: string;
    description?: string;
    procedure_md: string;
    tool_slug?: string | null;
    tool_op?: string | null;
    tool_params?: Record<string, string>;
    tool_sources?: string[];
  },
): Promise<Skill> {
  const name = input.name.trim();
  if (!name) throw new Error("name required");
  const procedure_md = input.procedure_md.trim();
  if (procedure_md.length < 30) throw new Error("procedure_md too short");

  const { tool_slug, tool_op } = normaliseToolConfig({
    tool_slug: input.tool_slug === undefined ? DEFAULT_TOOL_SLUG : input.tool_slug,
    tool_op: input.tool_op === undefined ? DEFAULT_TOOL_OP : input.tool_op,
  });
  const tool_params_json = input.tool_params ? JSON.stringify(input.tool_params) : null;
  const tool_sources_json = input.tool_sources?.length
    ? JSON.stringify(input.tool_sources)
    : null;

  const slug = await uniqueSkillSlug(env, name);
  const id = uid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO skills (id, slug, name, description, procedure_md, tool_slug, tool_op, tool_params_json, tool_sources_json, author, used_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', 0, ?, ?)`,
  )
    .bind(id, slug, name, input.description ?? null, procedure_md, tool_slug, tool_op, tool_params_json, tool_sources_json, now, now)
    .run();
  return (await getSkillById(env, id))!;
}

export async function updateSkill(
  env: Env,
  id: string,
  patch: Partial<
    Pick<Skill, "name" | "description" | "procedure_md" | "tool_slug" | "tool_op">
  > & {
    tool_params?: Record<string, string> | null;
    tool_sources?: string[] | null;
  },
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
  if (patch.tool_slug !== undefined || patch.tool_op !== undefined) {
    const { tool_slug, tool_op } = normaliseToolConfig({
      tool_slug: patch.tool_slug,
      tool_op: patch.tool_op,
    });
    sets.push("tool_slug = ?", "tool_op = ?");
    args.push(tool_slug, tool_op);
  }
  if (patch.tool_params !== undefined) {
    sets.push("tool_params_json = ?");
    args.push(patch.tool_params ? JSON.stringify(patch.tool_params) : null);
  }
  if (patch.tool_sources !== undefined) {
    sets.push("tool_sources_json = ?");
    args.push(patch.tool_sources?.length ? JSON.stringify(patch.tool_sources) : null);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  await env.DB.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...args)
    .run();
}

/** What's still pointing at this skill? `targets` is the live list (a target
 *  whose primary_skill_id matches), `reports` is historical (the archive
 *  records which skill produced each report — these don't block delete but
 *  the caller can warn about them). Used by the delete-skill safety check
 *  and surfaced as "used by N targets" on the skill list. */
export interface SkillUsage {
  targets: Array<{ id: string; slug: string; name: string }>;
  reports: number;
}

export async function countSkillUsage(env: Env, skillId: string): Promise<SkillUsage> {
  const [targetsRes, reportsRes] = await Promise.all([
    env.DB.prepare(
      "SELECT id, slug, name FROM targets WHERE primary_skill_id = ? ORDER BY name",
    ).bind(skillId).all<{ id: string; slug: string; name: string }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE skill_id = ?",
    ).bind(skillId).first<{ n: number }>(),
  ]);
  return {
    targets: targetsRes.results ?? [],
    reports: Number(reportsRes?.n ?? 0),
  };
}

/** How many targets currently treat each skill as their primary? Used to
 *  render an inline "used by N targets" hint on the skill list without
 *  an N+1 query. Skills with 0 are omitted from the map. */
export async function getSkillTargetCounts(env: Env): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    "SELECT primary_skill_id AS sid, COUNT(*) AS n FROM targets WHERE primary_skill_id IS NOT NULL GROUP BY primary_skill_id",
  ).all<{ sid: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results ?? []) out[r.sid] = Number(r.n);
  return out;
}

/** Delete a skill, but ONLY if no live target still references it. Throws
 *  a descriptive error otherwise — the caller must reassign the target(s)
 *  first. Historical reports (reports.skill_id) keep their link; nothing
 *  cascades into them. */
export async function deleteSkill(env: Env, id: string): Promise<void> {
  const usage = await countSkillUsage(env, id);
  if (usage.targets.length > 0) {
    const names = usage.targets.map((t) => `"${t.name}"`).join(", ");
    throw new Error(
      `Skill is still the primary skill for ${usage.targets.length} target${usage.targets.length === 1 ? "" : "s"}: ${names}. Reassign ${usage.targets.length === 1 ? "that target" : "those targets"} to a different skill first.`,
    );
  }
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
  // Paired day-map (v14). NULL when the run made no day-map (feature off, or a
  // pre-v14 report). day_map_r2_key points at the interactive HTML in R2;
  // day_map_slug is the short descriptive slug for its own page.
  day_map_r2_key: string | null;
  day_map_slug: string | null;
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

/** Pretty-URL parts for a report: the UTC date + a title slug (id as fallback).
 *  Drives the public `/report/<date>/<slug>` and `/day-map/<date>/<slug>` URLs
 *  (daylila-style). Deterministic from created_at + title, so it's stable. */
export function reportUrlParts(report: { id: string; created_at: number; title: string }): { date: string; slug: string } {
  return {
    date: new Date(report.created_at).toISOString().slice(0, 10),
    slug: slugify(report.title) || report.id,
  };
}

/** Resolve a report from a pretty-URL (date, slug) pair. Scans the reports
 *  created on that UTC day — 1–2 rows in practice — and matches the title slug.
 *  Returns null on a malformed date or no match. The legacy `/report/:id` and
 *  `/day-map/:id` routes still work (they redirect here), so this is additive. */
export async function getReportByDateSlug(env: Env, date: string, slug: string): Promise<Report | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const rows = await env.DB.prepare(
    "SELECT * FROM reports WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC",
  ).bind(start, start + 86400000).all<Report>();
  for (const r of rows.results ?? []) {
    if ((slugify(r.title) || r.id) === slug) return r;
  }
  return null;
}

// ─── the research loop ─────────────────────────────────────────────────────

interface ResearchPlan {
  queries: string[];
}

interface SourceCitation {
  title: string;
  url: string;
}

/** Build the planner's system prompt for a target asking for N queries.
 *  Scales: N=1 says "the single most important query"; N=2-3 says "EXACTLY
 *  N focused queries"; N≥5 also coaches angles + outlet diversity. If
 *  domain filters are active at the Tavily layer, the planner is told so
 *  it doesn't waste tokens emitting site: operators. */
function plannerSystemPrompt(
  n: number,
  filterHints: { include?: string[]; exclude?: string[]; country?: string } = {},
): string {
  const intro =
    `You are the planning step of a research agent.\n` +
    `You are given a SKILL (the writer instructions) and a TARGET (the thing being researched).\n` +
    `Return ONLY a JSON object: { "queries": [string, ...] }.`;
  const placeholder =
    `Replace any "{target}" placeholder in the skill with the target's name. Use specific, narrow queries — not "everything about X". No extra text outside the JSON.`;
  const filterLines: string[] = [];
  if (filterHints.include?.length) {
    filterLines.push(
      `The search engine is already restricted to these domains: ${filterHints.include.join(", ")}. Do NOT add "site:" operators — the filter is API-side. Focus your queries on the topic, not the source.`,
    );
  }
  if (filterHints.exclude?.length) {
    filterLines.push(
      `These domains are already blocked: ${filterHints.exclude.join(", ")}. Do not add exclude operators for them.`,
    );
  }
  if (filterHints.country) {
    filterLines.push(
      `Results are already boosted for ${filterHints.country}. You don't need to add the country name to every query.`,
    );
  }
  const filters = filterLines.length ? `\n\n${filterLines.join("\n")}` : "";

  if (n <= 1) {
    return `${intro}\nReturn exactly ONE query — the single most important angle for this target + skill combination.\n${placeholder}${filters}`;
  }
  if (n <= 4) {
    return `${intro}\nReturn EXACTLY ${n} focused web search queries — distinct angles, no duplicates.\n${placeholder}${filters}`;
  }
  return `${intro}
Return EXACTLY ${n} concrete web search queries — always ${n}, never fewer.
If you can't think of ${n} obviously distinct angles, broaden the net across regions, outlets, and sectors. It is far better to produce ${n} queries of varying angle than to under-plan.
${placeholder}${filters}`;
}

/** Step 1: ask the LLM what to search for. Returns up to N queries with
 *  {target} placeholders already expanded. N comes from the target.
 *  Filter hints come from the skill's Tavily params (include/exclude
 *  domains, country) so the planner doesn't duplicate them in queries. */
async function planResearch(
  env: Env,
  skill: Skill,
  target: Target,
  n: number,
  model: string,
  filterHints: { include?: string[]; exclude?: string[]; country?: string },
  signal?: AbortSignal,
): Promise<ResearchPlan> {
  const res = await runChat(env, model, {
    messages: [
      { role: "system", content: plannerSystemPrompt(n, filterHints) },
      {
        role: "user",
        content: `SKILL\n=====\n${skill.procedure_md}\n\nTARGET\n======\nName: ${target.name}\nKind: ${target.kind ?? "(unspecified)"}\nDescription: ${target.description ?? "(none)"}\n\nReturn the JSON plan now.`,
      },
    ],
    max_tokens: 600,
  }, signal);
  const raw = res.response;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed.queries)) {
        const queries = parsed.queries
          .map((q: any) => String(q).trim())
          .filter((q: string) => q && q.length <= 250)
          .slice(0, n);
        if (queries.length > 0) return { queries };
      }
    } catch {
      // fall through
    }
  }
  // Fallback: a generic query so the run doesn't die.
  return { queries: [`${target.name}`, `${target.name} ${skill.name}`].slice(0, Math.max(1, n)) };
}

// One row of gathered evidence — same shape regardless of whether it came
// from a Tavily search or a Tavily extract. score + published_date are
// optional (extract op doesn't return them) and get surfaced to the writer
// so it can weight recency and confidence per source.
interface GatheredSource {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
}

// Cap each source's text so the writer prompt stays bounded. With 20 sources
// at 4000 chars each, worst-case input is ~80kB — comfortably within every
// chat model in ALLOWED_CHAT_MODELS.
// Per-source content cap (chars). Multiplied by the kept-source count this
// is the dominant slice of the writer's prompt. 4000 chars ≈ 1000 tokens
// per source. At ~30 sources, ~30k tokens of source content fits easily
// in Haiku 4.5's 200k context window. Note: if you switch the chat model
// back to Workers AI Llama 3.3 70B (24k context), runs may fail at ~15+
// sources — drop this to 2000 in that case (or add model-aware scaling).
// Default; can be overridden per-run via the `writer_max_tokens` setting.
// Sonnet 4.6 supports up to 64k output; we cap at 16k for safety / wall-clock.
const DEFAULT_WRITER_MAX_TOKENS = 2200;

// Default; can be overridden per-run via the `max_chars_per_source` setting
// (Search tuning admin card).
const DEFAULT_MAX_CHARS_PER_SOURCE = 4000;
// Default soft ceiling on a single run's wall-clock. Hard ceiling is the
// 15-min Durable Object alarm limit; this default catches runaway runs
// (hung Tavily / hung Anthropic) within reasonable bounds. Editable via the
// `max_run_seconds` setting in the Run guardrails admin card.
const DEFAULT_MAX_RUN_SECONDS = 90;
// Defensive ceiling on how many sources reach the writer. Larger source
// count = larger prompt string to encode = more CPU. On Workers Free
// (10ms CPU per invocation) the writer payload is the main CPU spend, so
// this knob is the most direct lever for staying under the cap.
// Default; can be overridden per-run via the `max_final_sources` setting.
const DEFAULT_MAX_FINAL_SOURCES = 100;

// A skill declares one tool call (or none, for writer-only skills). Built
// from the skill's explicit columns (v10+) rather than parsed from markdown.
export interface SkillToolCall {
  tool: string;                       // TOOLS slug, e.g. "tavily"
  op: string;                         // op name, e.g. "search" | "extract"
  params: Record<string, string>;     // op-specific knobs (topic, time_range…)
  sources?: string[];                 // Tavily extract URL list
}

/** Build the run-time tool-call list from a skill's explicit columns.
 *  Returns [] if the skill is writer-only (no tool_slug set). */
export function skillToolCalls(skill: Skill): SkillToolCall[] {
  if (!skill.tool_slug || !skill.tool_op) return [];
  const tool = TOOLS[skill.tool_slug];
  if (!tool || !(skill.tool_op in tool.operations)) {
    console.warn(`skillToolCalls: skill "${skill.slug}" references unknown ${skill.tool_slug}/${skill.tool_op}`);
    return [];
  }
  let params: Record<string, string> = {};
  if (skill.tool_params_json) {
    try {
      const parsed = JSON.parse(skill.tool_params_json);
      if (parsed && typeof parsed === "object") {
        params = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v ?? "")]),
        );
      }
    } catch (e) {
      console.warn(`skillToolCalls: bad tool_params_json for skill ${skill.slug}:`, e);
    }
  }
  let sources: string[] | undefined;
  if (skill.tool_sources_json) {
    try {
      const parsed = JSON.parse(skill.tool_sources_json);
      if (Array.isArray(parsed)) sources = parsed.map((s) => String(s));
    } catch (e) {
      console.warn(`skillToolCalls: bad tool_sources_json for skill ${skill.slug}:`, e);
    }
  }
  return [{ tool: skill.tool_slug, op: skill.tool_op, params, sources }];
}

/** Funnel stats from a single Tavily search batch, surfaced to the admin
 *  Maintenance heartbeat so you can see whether the gather pipeline is
 *  healthy or where it's choking. `final_kept` is the count of sources
 *  passed onward (after all tools, after the final cap), not just Tavily's.
 *  `tavily_credits` is the real credit cost returned by Tavily (sum across
 *  every search + extract call in this run). */
export interface GatherStats {
  tavily_queries: number;
  tavily_raw: number;
  after_score_filter: number;
  after_url_dedupe: number;
  after_title_dedupe: number;
  final_kept: number;
  tavily_credits: number;
}

/** Normalise a headline for word-set comparison. Lowercase, strip
 *  punctuation, collapse whitespace. */
function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Tokenise a title into a set of "content" words (length ≥ 3, not a
 *  function word). Used as the input to Jaccard similarity for
 *  "same story, different outlet" detection. */
const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "over", "than", "that", "this", "these",
  "those", "what", "when", "where", "who", "why", "how", "are", "was", "were", "has",
  "have", "had", "but", "not", "you", "your", "they", "them", "their", "its", "his",
  "her", "she", "him", "all", "any", "out", "off", "now", "new", "old",
  "says", "said", "told", "amid", "after", "before", "during", "while", "since",
]);
function titleWords(t: string): Set<string> {
  return new Set(
    normalizeTitle(t)
      .split(" ")
      .filter((w) => w.length >= 3 && !TITLE_STOPWORDS.has(w)),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const w of a) if (b.has(w)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/** Step 2: gather evidence by dispatching the skill's tool call. Today
 *  the only tool is Tavily. Adding a new one means: write the fetcher in
 *  apis.ts, add a case here, add the registry entry. The funnel stats are
 *  surfaced to the admin Maintenance heartbeat as
 *  "Tavily 142 → 87 (score) → 71 (URL) → 34 (story) → 30 final". */
async function gatherSources(
  env: Env,
  queries: string[],
  target: Target,
  skill: Skill,
  calls: SkillToolCall[],
  signal?: AbortSignal,
): Promise<{ sources: GatheredSource[]; stats: GatherStats }> {
  await checkBudget(env, "searches");

  const stats: GatherStats = {
    tavily_queries: 0,
    tavily_raw: 0,
    after_score_filter: 0,
    after_url_dedupe: 0,
    after_title_dedupe: 0,
    final_kept: 0,
    tavily_credits: 0,
  };
  const out: GatheredSource[] = [];

  for (const c of calls) {
    try {
      switch (c.tool) {
        case "tavily": {
          const { sources, stats: tavilyStats } = await gatherTavily(env, queries, target, skill, c, signal);
          stats.tavily_queries += tavilyStats.tavily_queries;
          stats.tavily_raw += tavilyStats.tavily_raw;
          stats.after_score_filter += tavilyStats.after_score_filter;
          stats.after_url_dedupe += tavilyStats.after_url_dedupe;
          stats.after_title_dedupe += tavilyStats.after_title_dedupe;
          stats.tavily_credits += tavilyStats.tavily_credits;
          out.push(...sources);
          break;
        }
        default:
          console.warn(`gatherSources: unknown tool slug "${c.tool}"`);
      }
    } catch (e) {
      console.error(`gather ${c.tool} failed:`, e);
    }
  }

  // max_final_sources is per-target (NULL = global default). max_chars per
  // source is a global CPU lever — same prompt-size pressure across every
  // run, so it stays in settings.
  const finalSourcesCap = target.tavily_max_final_sources != null
    ? Math.max(1, Math.min(200, Math.floor(target.tavily_max_final_sources)))
    : await readIntSetting(env, "max_final_sources", DEFAULT_MAX_FINAL_SOURCES, 1, 200);
  const maxCharsPerSource = await readIntSetting(
    env, "max_chars_per_source", DEFAULT_MAX_CHARS_PER_SOURCE, 200, 8000,
  );
  const finalSources = out.slice(0, finalSourcesCap).map((s) => ({
    ...s,
    content: s.content.slice(0, maxCharsPerSource),
  }));
  stats.final_kept = finalSources.length;
  return { sources: finalSources, stats };
}

/** Reads a positive-integer setting, falling back to `def` if missing /
 *  unparseable / out of [lo, hi]. Centralised so the admin POST validator
 *  and the runtime reader can't drift on what counts as a valid value. */
async function readIntSetting(
  env: Env,
  key: string,
  def: number,
  lo: number,
  hi: number,
): Promise<number> {
  const raw = await getSetting(env, key, "");
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
}

async function gatherTavily(
  env: Env,
  queries: string[],
  target: Target,
  skill: Skill,
  c: SkillToolCall,
  signal?: AbortSignal,
): Promise<{ sources: GatheredSource[]; stats: GatherStats }> {
  const emptyStats: GatherStats = {
    tavily_queries: 0,
    tavily_raw: 0,
    after_score_filter: 0,
    after_url_dedupe: 0,
    after_title_dedupe: 0,
    final_kept: 0,
    tavily_credits: 0,
  };

  if (c.op === "extract" && c.sources?.length) {
    // Reranker query: tells Tavily what intent we're reading these pages
    // for, so it surfaces the most relevant chunks per URL instead of raw
    // page order. Made from target + skill so each extract op is
    // intent-aware without extra config.
    const rerankQuery = `${target.name} ${skill.name} ${target.description ?? ""}`.trim().slice(0, 400);
    const { results: extracted, credits } = await tavilyExtract(
      env.TAVILY_API_KEY,
      c.sources,
      { extract_depth: "basic", query: rerankQuery },
      signal,
    ).catch(() => ({ results: [], credits: 0 } as const));
    await bumpUsage(env, "searches", Math.max(1, Math.ceil(c.sources.length / 5)));
    return {
      sources: extracted.map((r) => ({ title: r.url, url: r.url, content: r.raw_content })),
      stats: { ...emptyStats, tavily_credits: credits },
    };
  }

  // Tavily op params live in tool_params_json as a flat lowercase object.
  // Recognised keys: topic, time_range, depth, country, include_domains,
  // exclude_domains. Old human-label keys ("Search topic") are still read
  // for any unbackfilled skill.
  const p = c.params;
  const pickLower = (k1: string, k2?: string) =>
    (p[k1] ?? (k2 ? p[k2] : undefined))?.toLowerCase();
  const pickList = (k: string): string[] => {
    const raw = p[k];
    if (!raw) return [];
    return raw
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d && /^[a-z0-9.-]+$/.test(d));
  };
  const includeDomains = pickList("include_domains");
  const excludeDomains = pickList("exclude_domains");
  const country = (p.country ?? "").trim();
  const opts: TavilySearchOptions = {
    topic: (pickLower("topic", "Search topic") as TavilySearchOptions["topic"]) ?? "general",
    time_range: pickLower("time_range", "Time range") as TavilySearchOptions["time_range"],
    search_depth: (pickLower("depth", "Depth") as TavilySearchOptions["search_depth"]) ?? "basic",
    max_results: 20,                  // Tavily's documented hard maximum
    include_domains: includeDomains.length ? includeDomains : undefined,
    exclude_domains: excludeDomains.length ? excludeDomains : undefined,
    country: country || undefined,
  };
  const responses = await Promise.all(
    queries.map((q) => tavilySearch(env.TAVILY_API_KEY, q, opts, signal).catch(() => ({ results: [], credits: 0 } as const))),
  );
  await bumpUsage(env, "searches", queries.length);

  type Scored = { title: string; url: string; content: string; score: number; published_date?: string };
  const allRaw: Scored[] = [];
  let creditsTotal = 0;
  for (const resp of responses) {
    creditsTotal += resp.credits;
    for (const r of resp.results) {
      if (!r.url) continue;
      allRaw.push({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        published_date: r.published_date,
      });
    }
  }

  const stats: GatherStats = {
    ...emptyStats,
    tavily_queries: queries.length,
    tavily_raw: allRaw.length,
    tavily_credits: creditsTotal,
  };

  // Per-target minimum score (NULL = use the global default). Different
  // targets want different strictness — a news brief tolerates noise,
  // a postcode dossier doesn't.
  let MIN_SCORE = target.tavily_min_score ?? null;
  if (MIN_SCORE == null) {
    const raw = await getSetting(env, "tavily_min_score", "0.4");
    MIN_SCORE = parseFloat(raw);
  }
  if (!Number.isFinite(MIN_SCORE) || MIN_SCORE < 0 || MIN_SCORE > 1) MIN_SCORE = 0.4;
  const scored = allRaw.filter((r) => r.score >= MIN_SCORE!);
  stats.after_score_filter = scored.length;

  // Sort by score desc — both dedupe passes below favour higher-scored
  // entries (URL dedupe keeps the first seen; title dedupe keeps the first
  // in each cluster, which is the highest-scored).
  scored.sort((a, b) => b.score - a.score);

  // Step 2 — URL dedupe.
  const seenUrl = new Set<string>();
  const urlDeduped: Scored[] = [];
  for (const r of scored) {
    if (seenUrl.has(r.url)) continue;
    seenUrl.add(r.url);
    urlDeduped.push(r);
  }
  stats.after_url_dedupe = urlDeduped.length;

  // Step 3 — Title Jaccard dedupe. Clusters titles by word-set overlap
  // (>= 0.7 = same story), keeps top KEEP_PER_CLUSTER from each so the
  // writer can still see ONE cross-reference per major story (catches
  // disagreements between outlets) without one story eating 5 slots.
  const JACCARD_THRESHOLD = 0.7;
  const KEEP_PER_CLUSTER = 2;
  const clusters: Array<{ words: Set<string>; members: Scored[] }> = [];
  for (const r of urlDeduped) {
    const words = titleWords(r.title);
    let placed = false;
    for (const cluster of clusters) {
      if (jaccardSimilarity(words, cluster.words) >= JACCARD_THRESHOLD) {
        cluster.members.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ words, members: [r] });
  }
  const titleDeduped: Scored[] = [];
  for (const cluster of clusters) {
    for (let i = 0; i < Math.min(KEEP_PER_CLUSTER, cluster.members.length); i++) {
      titleDeduped.push(cluster.members[i]);
    }
  }
  titleDeduped.sort((a, b) => b.score - a.score);
  stats.after_title_dedupe = titleDeduped.length;

  return {
    sources: titleDeduped.map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      published_date: r.published_date,
    })),
    stats,
  };
}

/** A past report surfaced by the recall layer. Both chronological "what
 *  did we last write on this target" hits and semantic "what topically
 *  related thing have we written anywhere" hits flow through this shape,
 *  so downstream code can treat them uniformly. */
export interface RecalledReport {
  id: string;
  title: string;
  snippet: string;
  target_id: string;
  target_name: string;
  target_slug: string;
  same_target: boolean;
  age_days: number;
  score: number; // similarity 0..1, or 1 for guaranteed-continuity recents
}

const RECALL_TOP_K = 10;
const RECALL_SCORE_THRESHOLD = 0.65;
const RECALL_MAX_KEPT = 5;
const RECALL_MAX_SAME_TARGET_RECENT = 2;

/** Step 4: build the recall context. Three sources, layered:
 *   1. Last 1-2 reports on THIS target via D1 (guaranteed continuity even
 *      if today's draft is semantically different from yesterday's).
 *   2. Vectorize top-K semantic hits filtered by similarity threshold,
 *      preferring same-target then cross-target, deduped against step 1.
 *   3. Hard cap at RECALL_MAX_KEPT total to control prompt size.
 *  Caller treats every hit identically — same source list, same citation
 *  numbering. Failures are best-effort; an empty result is fine. */
async function recallMemory(
  env: Env,
  target: Target,
  skill: Skill,
): Promise<RecalledReport[]> {
  const now = Date.now();
  const ageDays = (ts: number) => Math.max(0, Math.floor((now - ts) / 86_400_000));

  // 1. Chronological recents on this target (guaranteed continuity).
  const recents = (await listReportsForTarget(env, target.id, RECALL_MAX_SAME_TARGET_RECENT))
    .map<RecalledReport>((r) => ({
      id: r.id,
      title: r.title,
      snippet: r.snippet,
      target_id: target.id,
      target_name: target.name,
      target_slug: target.slug,
      same_target: true,
      age_days: ageDays(r.created_at),
      score: 1,
    }));
  const seen = new Set<string>(recents.map((r) => r.id));

  // 2. Semantic hits via Vectorize. Cast wide, filter by threshold, sort
  //    same-target-first, dedupe against recents, cap.
  let semantic: RecalledReport[] = [];
  try {
    const emb: any = await env.AI.run(EMBED_MODEL, {
      text: [`${target.name}. ${skill.name}. ${target.description ?? ""}`.slice(0, 1000)],
    });
    const vec = emb?.data?.[0];
    if (vec) {
      const hits = await env.MEMORY.query(vec, { topK: RECALL_TOP_K, returnMetadata: "all" });
      semantic = (hits.matches ?? [])
        .filter((m: any) => m.score >= RECALL_SCORE_THRESHOLD)
        .filter((m: any) => !seen.has(m.id))
        .map<RecalledReport>((m: any) => ({
          id: m.id,
          title: String(m.metadata?.title ?? "Untitled"),
          snippet: String(m.metadata?.snippet ?? ""),
          target_id: String(m.metadata?.target_id ?? ""),
          target_name: String(m.metadata?.target_name ?? "?"),
          target_slug: String(m.metadata?.target_slug ?? ""),
          same_target: m.metadata?.target_id === target.id,
          age_days: m.metadata?.created_at ? ageDays(Number(m.metadata.created_at)) : 0,
          score: Number(m.score),
        }))
        .sort((a, b) => {
          // Same-target first; within each bucket, higher score first.
          if (a.same_target !== b.same_target) return a.same_target ? -1 : 1;
          return b.score - a.score;
        });
    }
  } catch (e) {
    console.error("recallMemory: semantic query failed", e);
  }

  return [...recents, ...semantic].slice(0, RECALL_MAX_KEPT);
}

/** Unified citation row passed to the writer. Web hits and recalled past
 *  reports share the same shape so the LLM cites both with one [N]
 *  numbering scheme — and the rendered report's Sources footer can render
 *  them side by side. `score` and `published_date` are optional metadata
 *  the writer uses to weight recency and confidence; they don't affect
 *  the rendered footer. */
interface CitableSource {
  kind: "web" | "archive";
  title: string;
  url: string;
  content: string; // what the writer actually reads
  score?: number;
  published_date?: string;
}

/** Parse the YAML frontmatter block the writer is asked to emit at the top
 *  of every report. Returns null when the block is missing or malformed so
 *  the caller can fall back to the legacy templated title + truncated lead.
 *
 *  Deliberately minimal — no YAML lib. We only accept the exact shape we
 *  prompt for:
 *      ---
 *      title: <single line>
 *      summary: <single line, may be long>
 *      ---
 *      <body>
 *
 *  Tolerates: leading whitespace before the opening ---, optional surrounding
 *  quotes on values, and an accidental leading `# Title` line above the
 *  block (sometimes models add one against instructions). */
function parseReportFrontmatter(
  raw: string,
): { title: string; summary: string; body: string } | null {
  let src = raw.replace(/^﻿/, "").trimStart();
  // Strip an accidental leading `# Heading` line if the model added one
  // above the frontmatter despite being told not to.
  src = src.replace(/^#[^\n]*\n+/, "");
  // Strip a stray code fence if the model wrapped its output in ```.
  src = src.replace(/^```[a-z]*\n/i, "");

  const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const [, header, rest] = m;

  const stripQuotes = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).trim();
    }
    return t;
  };

  const titleMatch = header.match(/^\s*title\s*:\s*(.+)$/m);
  const summaryMatch = header.match(/^\s*summary\s*:\s*(.+)$/m);
  if (!titleMatch || !summaryMatch) return null;

  const title = stripQuotes(titleMatch[1]);
  const summary = stripQuotes(summaryMatch[1]);
  const body = rest.trim();

  if (!title || !summary || body.length < 80) return null;

  // Clip to defensible upper bounds so a runaway model doesn't blow up the
  // D1 row or break list-page layout. Prompt asks for ≤80 chars / ≤100 words
  // — these caps are headroom, not the target.
  const safeTitle = title.length > 150 ? title.slice(0, 147).trimEnd() + "…" : title;
  const safeSummary = summary.length > 800 ? summary.slice(0, 797).trimEnd() + "…" : summary;

  return { title: safeTitle, summary: safeSummary, body };
}

/** Step 4: ask the LLM to write the report, given everything we gathered. */
async function writeReport(
  env: Env,
  skill: Skill,
  target: Target,
  webSources: GatheredSource[],
  recalled: RecalledReport[],
  model: string,
  signal?: AbortSignal,
): Promise<{ title: string; summary: string; body: string; citations: CitableSource[] }> {
  // Web sources first (fresh material the writer must rely on), archive
  // sources after (background/continuity). One unified numbering scheme.
  const citations: CitableSource[] = [
    ...webSources.map<CitableSource>((s) => ({
      kind: "web",
      title: s.title,
      url: s.url,
      content: s.content,
      score: s.score,
      published_date: s.published_date,
    })),
    ...recalled.map<CitableSource>((r) => ({
      kind: "archive",
      title: `${r.title} (${r.age_days === 0 ? "today" : r.age_days === 1 ? "yesterday" : `${r.age_days} days ago`}${r.same_target ? "" : ` · from "${r.target_name}"`})`,
      url: `/report/${r.id}`,
      content: r.snippet,
    })),
  ];

  // Format a published_date string from Tavily into a short human label
  // for the writer. Tavily returns either ISO ("2026-05-18T...") or
  // RFC-ish ("Mon, 18 May 2026 ..."). Be lenient.
  const fmtDate = (iso: string | undefined): string => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };

  const sourceBlock = citations.length
    ? citations
        .map((c, i) => {
          if (c.kind === "archive") {
            return `[${i + 1}] (PRIOR REPORT) ${c.title}\n${c.url}\n${c.content}`;
          }
          // Web source: surface score + published date as a metadata line
          // so the writer can weight recency and trust per cite.
          const metaBits: string[] = [];
          const dateLabel = fmtDate(c.published_date);
          if (dateLabel) metaBits.push(`published ${dateLabel}`);
          if (typeof c.score === "number") metaBits.push(`relevance ${c.score.toFixed(2)}`);
          const metaLine = metaBits.length ? `   ${metaBits.join(" · ")}\n` : "";
          return `[${i + 1}] ${c.title}\n${c.url}\n${metaLine}${c.content}`;
        })
        .join("\n\n")
    : "(No sources gathered — write from general knowledge but explicitly say so.)";

  const userMsg = `SKILL TO APPLY
=====
${skill.procedure_md}

TARGET
======
Name: ${target.name}
Kind: ${target.kind ?? "(unspecified)"}
Description: ${target.description ?? "(none)"}

SOURCES (cite inline with [n])
==============================
${sourceBlock}

Now write the report. Follow the skill exactly. Cite sources inline by [n] matching the sources above. Do NOT write a "Sources" section at the end — the report page renders a canonical numbered source list automatically.`;

  const writerMaxTokens = await readIntSetting(
    env, "writer_max_tokens", DEFAULT_WRITER_MAX_TOKENS, 200, 16000,
  );

  const res = await runChat(env, model, {
    messages: [
      {
        role: "system",
        content: `You are a research agent that writes precise, scannable markdown reports.

Apply the SKILL exactly — tone, structure, length, source weighting, and editorial posture all come from it. Each web source carries metadata after its title line ("published <date> · relevance <0-1>") that the skill can tell you how to use.

Output format (required — the pipeline parses this):
Begin every report with a YAML frontmatter block exactly like this, then the body:

---
title: A real headline for this specific report, single line, max 80 characters, no date, no category or source names
summary: A standalone abstract of this report in 1 to 4 sentences, single line (no newlines), max 100 words, written as if it might be read on its own
---

## First section heading

Body paragraph here…

Notes on the frontmatter:
- Both \`title\` and \`summary\` must be on a single line each. The summary may be long but must not contain line breaks.
- Do NOT wrap values in quotes unless they contain a colon.
- The title is the actual story headline (e.g. "Ukraine seizes initiative as Russia threatens retaliation") — not "World News" or "Daily briefing". Category and date are rendered separately from other metadata.

Markdown formatting rules (follow strictly — the rendering engine depends on them):
- After the closing \`---\` of the frontmatter, start directly with your first \`## Section\` heading. Do NOT write a top-level \`# Title\` line.
- Each section heading from the skill's Output structure MUST be written as a level-2 markdown heading: \`## Section name\` on its own line, sentence case, no trailing colon, no bold markers around the heading text.
- Within a section, individual stories/items can use a bold lead-in followed by the body in the same paragraph: \`**Lead-in sentence.** body sentence body sentence.\`
- Use \`---\` on its own line ONLY between major sections you want visually separated (never inside the frontmatter region, and never as the very first line of the body). Don't sprinkle them.
- Cite sources inline by [number] matching the gathered web sources. Citations like [3], [8,10], [3-5] are all fine.
- Do NOT write your own "Sources" / "References" / "Citations" section — the page renders one automatically.`,
      },
      { role: "user", content: userMsg },
    ],
    max_tokens: writerMaxTokens,
  }, signal);

  const raw = res.response.trim();
  if (!raw || raw.length < 80) throw new Error("LLM returned empty or too-short report");

  // Preferred path: writer produced the YAML frontmatter we asked for, so
  // title + summary are LLM-authored and the body is the rest.
  const parsed = parseReportFrontmatter(raw);
  if (parsed) {
    return { title: parsed.title, summary: parsed.summary, body: parsed.body, citations };
  }

  // Fallback: writer skipped or malformed the frontmatter. Don't fail the
  // run — fall back to the legacy templated title + truncated-lead snippet.
  // Surface it to worker logs so we can see how often it happens.
  console.warn(
    `writeReport: frontmatter parse failed (model=${model}, target=${target.slug}, skill=${skill.slug}); using fallback title/summary`,
  );
  const dateLabel = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const fallbackTitle = `${target.name} — ${skill.name} (${dateLabel})`;
  const fallbackSummary = raw.replace(/\s+/g, " ").slice(0, 240).trim() + "…";
  return { title: fallbackTitle, summary: fallbackSummary, body: raw, citations };
}

// ─── the day-map ─────────────────────────────────────────────────────────────
//
// After a briefing is written, optionally generate a "map of the day": ONE
// self-contained interactive HTML artifact (hand-written HTML + inline CSS +
// vanilla JS, optionally one cdnjs library) that opens with an overview of how
// the day's stories connect — the single thread, the major forces, and the
// cause→effect links between them — then lays out the beats below.
//
// It is written in ONE LLM pass over the FULL briefing (no truncation) and is
// deliberately CONCRETE: real names, dates, numbers — the actual day. (This is
// the inverse of daylila's abstract "labs", where specifics are banned; here
// the specifics ARE the point.) The artifact is always rendered inside a
// sandboxed iframe (on WatchOMacho's report page and on daylila), and the
// public /day-map route serves it under a Content-Security-Policy that blocks
// network egress — so the LLM-authored script is caged and no content
// validator is needed here. The ONLY check we do is "is this actually a usable
// HTML document?" so we never store empty/truncated junk.
//
// Gated per-target via dayMapEnabledForTarget(). Best-effort: makeDayMap never
// throws, so a day-map failure can never fail (or roll back) the briefing.

/** Output-token budget for the day-map call. The artifact is a full HTML
 *  document, so this is far larger than the planner/writer budgets. daylila's
 *  lab presenter caps INLINE bytes at ~50 KB; ~16k tokens leaves headroom. */
const DAY_MAP_MAX_TOKENS = 16000;

/** Pull the briefing's section headings ("## ...") in order, so the day-map
 *  prompt can tell the model exactly which beats to lay out below the map. */
function extractSectionHeadings(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/^##\s+(.+?)\s*$/gm)) {
    const h = m[1].replace(/\s+/g, " ").trim();
    if (h) out.push(h);
  }
  return out;
}

/** Pull the HTML document out of a model response: drop any ```html fences and
 *  surrounding prose, returning the slice from <!DOCTYPE html> through </html>.
 *  Returns null when no document is present. */
function extractHtmlDoc(raw: string): string | null {
  const fenced = raw.replace(/```(?:html)?/gi, "");
  const lower = fenced.toLowerCase();
  const start = lower.indexOf("<!doctype html");
  const end = lower.lastIndexOf("</html>");
  if (start === -1 || end === -1 || end <= start) return null;
  return fenced.slice(start, end + "</html>".length).trim();
}

/** The ONLY validation we do on our side — a featherweight "is this a usable
 *  HTML document?" check (the iframe sandbox + CSP are the real safety wall;
 *  see the section comment above). Guards against empty / truncated /
 *  prose-only model output that would otherwise render as a broken box. */
function looksLikeHtmlDoc(s: string): boolean {
  const t = s.toLowerCase();
  return s.length >= 200 && t.includes("<!doctype html") && t.includes("</html>") && t.includes("<body");
}

/** Step D1: ask the LLM to turn the finished briefing into a self-contained
 *  interactive HTML "map of the day". Returns the HTML document, or null if
 *  the model didn't return a usable one (caller skips — never fails the run). */
async function planDayMap(
  env: Env,
  title: string,
  summary: string | null,
  body: string,
  dateLabel: string,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const headings = extractSectionHeadings(body);
  const sectionList = headings.length
    ? headings.map((h, i) => `${i + 1}. ${h}`).join("\n")
    : "(no explicit section headings — infer the beats from the body)";

  const system = `You turn a finished, fact-checked daily news briefing into a "map of the day": a single self-contained interactive HTML page. At the top is a clear MAP of how the day's stories connect — the one thread, the central driver, and the cause→effect links. Below it is a short, skimmable rundown of each story.

This is NOT abstract. Use the REAL names, places, dates and numbers from the briefing — the specifics are the whole point. Invent no new facts; only reshape what the briefing already states.

HEADER (top of the page)
- Show the briefing TITLE, the single connecting-thread sentence, AND the date — this briefing is for **${dateLabel}**. The date MUST be visible in the header so the reader knows exactly which day this map covers (e.g. an eyebrow line like "Map of the day · ${dateLabel}").

OUTPUT
- Output ONLY a complete HTML document. No prose, no markdown, no code fences. Start with <!DOCTYPE html> and end with </html>.
- Inline <style> and inline <script>. The ONLY external resources allowed: (1) the DM Sans brand font from Google Fonts (see STYLE — always load it), and (2) optionally ONE cdnjs library (https://cdnjs.cloudflare.com/...) if it truly helps — but the layout below is plain HTML/CSS and needs no library, so prefer none.
- Runs inside a sandboxed iframe with NO other network access: no fetch(), no localStorage/cookies, no forms, no other external requests. Inline everything else.
- Keep hand-written markup under ~45 KB.

THE MAP — layout (ONE layout for every screen size — mobile-first, just centered on desktop)
- Use a SINGLE VERTICAL COLUMN at EVERY width: a reading column of max-width ~680px, centered on the page. Do NOT switch to side-by-side columns on desktop and do NOT reflow between two layouts — one column everywhere is simpler and bug-free. Do NOT hand-place nodes at fixed pixel coordinates and do NOT build a free-floating "web".
- Assign every node a tier and lay them out TOP→DOWN in this order:
  • Tier 1 = the root driver — the single thread, the one thing the day traces back to.
  • Tier 2 = the major forces it sets in motion.
  • Tier 3 = the downstream effects/consequences.
  (If there's no clean 3-level chain, use 2 tiers: the driver, then everything it connects to.)
- Within a tier, stack its cards vertically. Between tiers, put ONE DOWNWARD (↓) connector with a short label ("sets in motion", "downstream effects"). ALL connectors point DOWN — never sideways — because the flow is always vertical. Cards MUST NEVER overlap and nothing may overflow the viewport down to 320px.
- Each node is a BIG, full-width, tappable CARD: a short bold label + a one-line hint, with a small tier badge (ROOT DRIVER / FORCE / EFFECT). Leave clear space before the +/− expand control so it never touches the title text.
- Tapping any card expands its FULL detail INLINE, in normal document flow, directly under the card (accordion-style, with a +/− affordance). Do NOT use a position:fixed / position:absolute / full-screen-overlay modal — this map is embedded in a tall auto-sized iframe, so a "fixed" popup lands off-screen. Keep on-card text short and in WHOLE words — never cut a word mid-way with "…"; the long version lives in the inline expansion.

BELOW THE MAP — the day in short
- A skimmable rundown: each story's HEADING followed by a tight 1–3 sentence take with the real specifics. Do NOT label these "beats" and do NOT number them ("Beat 1", etc.) — just the heading and the short take, cleanly.

AUTO-HEIGHT (required — so the embedding page can size the frame and there is NO inner scrollbar, even when a card is expanded)
- Include this exact script verbatim:
  <script>
  function postH(){parent.postMessage({type:'day-map-height',height:Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)},'*');}
  addEventListener('load',postH);addEventListener('resize',postH);
  new ResizeObserver(postH).observe(document.body);
  addEventListener('click',function(){setTimeout(postH,60);setTimeout(postH,400);});
  </script>

STYLE (brand — match daylila exactly)
- Load the brand font in <head> and use it everywhere: <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap"> then font-family: 'DM Sans', system-ui, sans-serif.
- Palette: warm paper background #FAF8F4, near-black text #1A1A1A, teal #1A6B62 (primary/accent; use #155951 for hover), gold #C49A1A, muted text #6B6B6B, hairline borders #E8E4DE.
- Calm, editorial, professional — this is news, not a toy. No footer/branding line at the bottom.`;

  const userMsg = `BRIEFING TITLE
${title}

EDITORIAL SUMMARY
${summary ?? "(none)"}

SECTIONS (in order)
${sectionList}

BRIEFING BODY
${body}

Return the complete HTML document now.`;

  const res = await runChat(env, model, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    max_tokens: DAY_MAP_MAX_TOKENS,
  }, signal);

  const doc = extractHtmlDoc(res.response);
  if (!doc || !looksLikeHtmlDoc(doc)) return null;
  return doc;
}

/** Generate + persist the day-map for a just-written briefing. Best-effort:
 *  catches everything, records the failure to settings for the admin page,
 *  and never throws — the briefing is already saved before this runs. Stores
 *  the interactive HTML in R2 (mirroring report markdown) and links it from
 *  the reports row via day_map_r2_key + day_map_slug. */
export async function makeDayMap(
  env: Env,
  report: { id: string; created_at: number; title: string; snippet?: string | null },
  body: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const d = new Date(report.created_at);
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dateLabel = `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const html = await planDayMap(
      env,
      report.title,
      report.snippet ?? null,
      body,
      dateLabel,
      model,
      signal,
    );
    if (!html) {
      console.warn(`makeDayMap: no usable day-map for report ${report.id}; skipping`);
      return;
    }
    const r2Key = `day-maps/${report.created_at}-${report.id}.html`;
    await env.REPORTS.put(r2Key, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    await env.DB.prepare(
      "UPDATE reports SET day_map_r2_key = ?, day_map_slug = ? WHERE id = ?",
    )
      .bind(r2Key, slugify(report.title) || "day-map", report.id)
      .run();
    await setSetting(env, "day_map_last_ok_at", String(Date.now())).catch(() => {});
    await setSetting(env, "day_map_last_error", "").catch(() => {});
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    console.error("makeDayMap failed", report.id, msg);
    await setSetting(
      env,
      "day_map_last_error",
      JSON.stringify({ message: msg, at: Date.now(), report_id: report.id }),
    ).catch(() => {});
  }
}

/** Regenerate ONLY the day-map for an existing report — no research, no
 *  re-write of the briefing, just the day-map LLM call over the already-stored
 *  body. Powers the admin "Remake map" button, so a story can get a fresh map
 *  (e.g. after a generator change) for one cheap call instead of a whole run.
 *  Best-effort via makeDayMap; returns false if the report/body/target can't
 *  be loaded (caller logs it). */
export async function regenerateDayMap(
  env: Env,
  reportId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const report = await getReportById(env, reportId);
  if (!report) return false;
  const obj = await env.REPORTS.get(report.r2_key);
  if (!obj) return false;
  const body = await obj.text();
  const model = await getChatModel(env);
  await makeDayMap(
    env,
    { id: report.id, created_at: report.created_at, title: report.title, snippet: report.snippet },
    body,
    model,
    signal,
  );
  return true;
}

// ─── Edition pieces: lesson + lab (the briefing's companions) ──────────────
//
// WatchOMacho creates the WHOLE edition now (2026-06-01): briefing + day-map
// (above) + lesson + lab. Lesson + lab live in the generic `edition_pieces`
// table keyed by (report_id, kind) — a new piece-type is a new `kind`, never a
// migration. Body in R2 (like reports.r2_key + day-maps), metadata + status
// here. Each generator is best-effort + independently re-runnable (mirrors
// makeDayMap / regenerateDayMap) so one failed piece never blocks the rest.

export interface EditionPiece {
  id: string;
  report_id: string;
  target_id: string | null;
  kind: string;
  title: string | null;
  summary: string | null;
  slug: string | null;
  r2_key: string | null;
  word_count: number | null;
  meta_json: string | null;
  status: string;
  error: string | null;
  chat_model: string | null;
  created_at: number;
  updated_at: number;
}

/** All edition pieces for a report (lesson, lab, future kinds). */
export async function getEditionPieces(env: Env, reportId: string): Promise<EditionPiece[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM edition_pieces WHERE report_id = ?",
  )
    .bind(reportId)
    .all<EditionPiece>();
  return rows.results ?? [];
}

/** One edition piece by (report, kind), or null. */
export async function getEditionPiece(
  env: Env,
  reportId: string,
  kind: string,
): Promise<EditionPiece | null> {
  return env.DB.prepare(
    "SELECT * FROM edition_pieces WHERE report_id = ? AND kind = ?",
  )
    .bind(reportId, kind)
    .first<EditionPiece>();
}

/** Write a successful piece. UPSERT on (report_id, kind) — regeneration
 *  overwrites the same row, clearing any prior failure. */
async function upsertEditionPiece(
  env: Env,
  p: {
    reportId: string;
    targetId: string | null;
    kind: string;
    title: string;
    summary: string | null;
    slug: string;
    r2Key: string;
    wordCount?: number | null;
    metaJson?: string | null;
    chatModel: string;
  },
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO edition_pieces
       (id, report_id, target_id, kind, title, summary, slug, r2_key, word_count, meta_json, status, error, chat_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?)
     ON CONFLICT(report_id, kind) DO UPDATE SET
       title = excluded.title, summary = excluded.summary, slug = excluded.slug,
       r2_key = excluded.r2_key, word_count = excluded.word_count, meta_json = excluded.meta_json,
       status = 'ok', error = NULL, chat_model = excluded.chat_model, updated_at = excluded.updated_at`,
  )
    .bind(
      uid(), p.reportId, p.targetId, p.kind, p.title, p.summary, p.slug,
      p.r2Key, p.wordCount ?? null, p.metaJson ?? null, p.chatModel, now, now,
    )
    .run();
}

/** Mark a piece failed. If a good row (with r2_key) already exists, keep its
 *  body + 'ok' status but record the latest error — a regen that fails leaves
 *  the previously-working piece serving. Only a piece that never produced a
 *  body shows status='failed'. */
async function recordEditionPieceFailure(
  env: Env,
  reportId: string,
  targetId: string | null,
  kind: string,
  msg: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO edition_pieces (id, report_id, target_id, kind, status, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'failed', ?, ?, ?)
     ON CONFLICT(report_id, kind) DO UPDATE SET
       error = excluded.error,
       updated_at = excluded.updated_at,
       status = CASE WHEN edition_pieces.r2_key IS NULL THEN 'failed' ELSE edition_pieces.status END`,
  )
    .bind(uid(), reportId, targetId, kind, msg.slice(0, 500), now, now)
    .run();
}

// ── Lesson ─────────────────────────────────────────────────────────────────

/** Split the lesson's own `# headline` + `> lede` off the model output; the
 *  rest is the markdown body (starting at the first `## ` beat). Mirrors
 *  Daylila's splitHeadlineAndSummary — single-`#` headline only (so `## `
 *  beats aren't matched), optional `> ` lede line right after. Either part
 *  may be absent (→ null), in which case the caller falls back to the
 *  briefing title / summary. */
function splitLessonHeadlineLede(text: string): {
  headline: string | null;
  lede: string | null;
  body: string;
} {
  const lines = text.trim().split("\n");
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  const first = (lines[i] ?? "").trim();
  const hm = first.match(/^#\s+(.+)$/);
  if (!hm) return { headline: null, lede: null, body: text.trim() };
  const headline = hm[1].trim();
  let j = i + 1;
  while (j < lines.length && lines[j].trim().length === 0) j++;
  const lm = (lines[j] ?? "").trim().match(/^>\s+(.+)$/);
  if (lm) {
    return { headline, lede: lm[1].trim(), body: lines.slice(j + 1).join("\n").trim() };
  }
  return { headline, lede: null, body: lines.slice(i + 1).join("\n").trim() };
}

function buildLessonUserPrompt(targetName: string, title: string, briefingBody: string): string {
  // Name the actual target ("World News", "Finance", …) so the lesson is framed
  // for the right beat — not hardcoded to world-news. Empty name → generic.
  const label = targetName.trim() ? `${targetName.trim()} ` : "";
  return `Today's ${label}briefing. Re-explain it as a Daylila lesson — the human / system / psychological "why" behind these events, the pattern the reader can carry forward. Ground everything in the briefing below; invent nothing.

BRIEFING TITLE: ${title}

--- BRIEFING BODY ---
${briefingBody}
--- END BRIEFING BODY ---`;
}

/** Generate + persist the lesson for a just-written briefing. Best-effort:
 *  never throws — the briefing is already saved. Stores the lesson markdown
 *  in R2 and the metadata in edition_pieces (kind='lesson'). */
export async function makeLesson(
  env: Env,
  report: { id: string; target_id: string | null; created_at: number; title: string },
  briefingBody: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    // Resolve the target's display name so the prompt frames the lesson for the
    // right target (World News / Finance / …). target_id can be null on old rows.
    let targetName = "";
    if (report.target_id) {
      const t = await env.DB.prepare("SELECT name FROM targets WHERE id = ?")
        .bind(report.target_id)
        .first<{ name: string }>();
      targetName = t?.name ?? "";
    }
    const res = await runChat(
      env,
      model,
      {
        messages: [
          { role: "system", content: `${LESSON_CONTRACT}\n\n---\n\n# Voice (non-negotiable, applies to every word)\n\n${VOICE_CONTRACT}` },
          { role: "user", content: buildLessonUserPrompt(targetName, report.title, briefingBody) },
        ],
        max_tokens: 8000,
      },
      signal,
    );
    const { headline, lede, body } = splitLessonHeadlineLede(res.response);
    if (body.trim().length < 200) {
      throw new Error("lesson output empty or too short");
    }
    const finalHeadline = headline ?? report.title;
    const r2Key = `lessons/${report.created_at}-${report.id}.md`;
    await env.REPORTS.put(r2Key, body, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    await upsertEditionPiece(env, {
      reportId: report.id,
      targetId: report.target_id,
      kind: "lesson",
      title: finalHeadline,
      summary: lede,
      slug: slugify(finalHeadline) || "lesson",
      r2Key,
      wordCount,
      chatModel: model,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error("makeLesson failed", report.id, msg);
    await recordEditionPieceFailure(env, report.id, report.target_id, "lesson", msg).catch(() => {});
  }
}

/** Regenerate ONLY the lesson for an existing report — no research, no
 *  re-write of the briefing. Re-reads the stored briefing body from R2 and
 *  reruns the lesson LLM call. Powers the admin "Remake lesson" button +
 *  modular regen. Returns false if the report/body can't be loaded. */
export async function regenerateLesson(
  env: Env,
  reportId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const report = await getReportById(env, reportId);
  if (!report) return false;
  const obj = await env.REPORTS.get(report.r2_key);
  if (!obj) return false;
  // The stored .md is `# {title}\n\n{body}` — strip the leading H1 so the
  // lesson prompt gets the briefing prose, the same shape runResearch passes.
  const raw = await obj.text();
  const briefingBody = raw.replace(/^#\s+.*\n+/, "").trim();
  const model = await getChatModel(env);
  await makeLesson(
    env,
    { id: report.id, target_id: report.target_id, created_at: report.created_at, title: report.title },
    briefingBody,
    model,
    signal,
  );
  return true;
}

// ── Lab ──────────────────────────────────────────────────────────────────

/** Parse the trailing `<!-- LAB ... -->` comment the lab contract requires.
 *  Returns 'decline' for `<!-- LAB DECLINE -->`, {title, concept} for a
 *  populated comment, or null when absent (caller falls back to <title>). */
function parseLabMeta(raw: string): "decline" | { title: string; concept: string } | null {
  if (/<!--\s*LAB\s+DECLINE\s*-->/i.test(raw)) return "decline";
  const m = raw.match(/<!--\s*LAB\s+title=([^|]+?)\s*\|\s*concept=([\s\S]+?)\s*-->/i);
  if (!m) return null;
  const title = m[1].trim();
  const concept = m[2].trim();
  if (!title || !concept) return null;
  return { title, concept };
}

/** Fallback title from a <title> tag when the LAB comment is missing. */
function titleFromHtml(html: string): string {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "Today's lab";
}

function buildLabUserPrompt(lessonHeadline: string, lessonBody: string): string {
  return `## Today's lesson — build the lab's rehearsal from the pattern it teaches
Lesson headline: "${lessonHeadline}"

### Lesson body
${lessonBody}

Build the lab now: a single self-contained HTML document where the reader rehearses the decision this lesson's pattern is about. Output ONLY the HTML document, then the trailing <!-- LAB title=... | concept=... --> line.`;
}

/** Generate + persist the lab for a report whose lesson already exists. Reads
 *  the stored lesson from edition_pieces → R2, runs one LLM call for a
 *  self-contained HTML doc (raw HTML, like the day-map — NOT a JSON envelope,
 *  so no missing-quote parse-fail class), validates sandbox-safety, and
 *  stores it. Best-effort: never throws. A clean decline (no decision to
 *  rehearse) records status='failed' with a 'declined' note — no lab that day. */
export async function makeLab(
  env: Env,
  report: { id: string; target_id: string | null; created_at: number },
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const lesson = await getEditionPiece(env, report.id, "lesson");
    if (!lesson || !lesson.r2_key) {
      throw new Error("no lesson body to build the lab from");
    }
    const lessonObj = await env.REPORTS.get(lesson.r2_key);
    if (!lessonObj) throw new Error("lesson R2 object missing");
    const lessonBody = await lessonObj.text();

    const res = await runChat(
      env,
      model,
      {
        messages: [
          { role: "system", content: `${LAB_CONTRACT}\n\n---\n\n# Voice (non-negotiable, every text surface inside the iframe)\n\n${VOICE_CONTRACT}` },
          { role: "user", content: buildLabUserPrompt(lesson.title ?? "Today's lesson", lessonBody) },
        ],
        max_tokens: 16000,
      },
      signal,
    );

    const meta = parseLabMeta(res.response);
    if (meta === "decline") {
      await recordEditionPieceFailure(env, report.id, report.target_id, "lab", "declined: no decision to rehearse");
      return;
    }

    const doc = extractHtmlDoc(res.response);
    if (!doc || !looksLikeHtmlDoc(doc)) {
      throw new Error("lab output not a usable HTML document");
    }
    const validation = validateLab(doc);
    if (!validation.passed) {
      throw new Error(
        "lab validator failed: " +
          validation.violations.map((v) => `[${v.rule}] ${v.message}`).join(" | "),
      );
    }

    const title = meta?.title ?? titleFromHtml(doc);
    const concept = meta?.concept ?? null;
    const r2Key = `labs/${report.created_at}-${report.id}.html`;
    await env.REPORTS.put(r2Key, doc, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    await upsertEditionPiece(env, {
      reportId: report.id,
      targetId: report.target_id,
      kind: "lab",
      title,
      summary: concept,
      slug: slugify(title) || "lab",
      r2Key,
      chatModel: model,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error("makeLab failed", report.id, msg);
    await recordEditionPieceFailure(env, report.id, report.target_id, "lab", msg).catch(() => {});
  }
}

/** Regenerate ONLY the lab for an existing report (its lesson must already
 *  exist). Powers the admin "Remake lab" button + modular regen. Returns
 *  false if the report can't be loaded. */
export async function regenerateLab(
  env: Env,
  reportId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const report = await getReportById(env, reportId);
  if (!report) return false;
  const model = await getChatModel(env);
  await makeLab(
    env,
    { id: report.id, target_id: report.target_id, created_at: report.created_at },
    model,
    signal,
  );
  return true;
}

/** Pipeline step labels used by runResearch's step-boundary breadcrumb.
 *  These flow into both the live `last_run_attempt` setting (so admin can
 *  see "in-flight at step X") and the `runs.error` text (so completed
 *  failures are tagged "gather: Tavily timeout" rather than just "Tavily
 *  timeout"). Order matters — it's the actual pipeline sequence. */
export type RunStep = "init" | "plan" | "gather" | "recall" | "write" | "persist" | "done";

/** Live "what's happening right now" breadcrumb. Overwritten by each new
 *  runResearch invocation (we only care about the most-recent attempt for
 *  the live heartbeat — historical failures are recorded in `runs`).
 *  Stored as JSON in settings so the admin can read it without a schema
 *  change. `completed_at` is null while in-flight, set on success or error. */
interface LastRunAttempt {
  run_id: string;
  target_slug: string;
  triggered_by: "cron" | "manual";
  started_at: number;
  last_step: RunStep;
  completed_at: number | null;
  outcome: "in_flight" | "success" | "error";
  error?: string;
  gather_stats?: GatherStats;
}

async function markStep(
  env: Env,
  attempt: LastRunAttempt,
  step: RunStep,
): Promise<void> {
  attempt.last_step = step;
  console.log(`runResearch[${attempt.run_id}] ${attempt.target_slug} ${attempt.triggered_by} → ${step}`);
  await setSetting(env, "last_run_attempt", JSON.stringify(attempt)).catch((e) =>
    console.error("markStep: setSetting failed", e),
  );
}

/** Watchdog: if the live heartbeat has been `in_flight` past max_run_seconds
 *  plus a grace window, the DO alarm must have been killed before its catch
 *  block could record the failure. Mark the run as errored so the Activity
 *  card and runs table reflect reality, and rescue the heartbeat so the
 *  Maintenance panel doesn't show a phantom "stalled" forever.
 *
 *  Called from cronTick once per hour. Idempotent: if heartbeat is already
 *  resolved or doesn't exist, this is a no-op. We compare target_id by slug
 *  because the heartbeat only stores slug, not id. */
async function reapStalledRun(env: Env, now: number): Promise<void> {
  const raw = await getSetting(env, "last_run_attempt", "");
  if (!raw) return;
  let attempt: LastRunAttempt;
  try {
    attempt = JSON.parse(raw);
  } catch {
    return;
  }
  if (attempt.outcome !== "in_flight" || attempt.completed_at !== null) return;

  const maxRunSeconds = await readIntSetting(env, "max_run_seconds", DEFAULT_MAX_RUN_SECONDS, 5, 600);
  // Grace: alarm could legitimately use the full budget. Add 30s before
  // declaring the heartbeat zombie, so we don't race a still-running alarm.
  const ageMs = now - attempt.started_at;
  const reapAfterMs = (maxRunSeconds + 30) * 1000;
  if (ageMs < reapAfterMs) return;

  console.warn(`reapStalledRun: heartbeat ${attempt.run_id} stalled at ${attempt.last_step} for ${Math.floor(ageMs/1000)}s — reaping`);

  // Resolve target_id from slug so we can record a proper runs row. If the
  // target has since been deleted, skip the runs row but still clear the
  // heartbeat so the admin panel isn't stuck on a phantom.
  const target = await getTargetBySlug(env, attempt.target_slug);
  const errorMsg = `${attempt.last_step}: watchdog reaped after ${Math.floor(ageMs/1000)}s (alarm likely killed by runtime before catch could run)`;

  if (target) {
    try {
      // skill_id may be unknown if the target's skill was reassigned mid-run.
      // We use the current primary_skill_id as best-effort; the runs.error
      // text carries the actual diagnosis.
      const skillId = target.primary_skill_id ?? "";
      const gatherStatsJson = attempt.gather_stats ? JSON.stringify(attempt.gather_stats) : null;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO runs (id, target_id, skill_id, triggered_by, status, error, duration_ms, gather_stats_json, created_at)
         VALUES (?, ?, ?, ?, 'error', ?, ?, ?, ?)`,
      )
        .bind(attempt.run_id, target.id, skillId, attempt.triggered_by, errorMsg, ageMs, gatherStatsJson, now)
        .run();
    } catch (e) {
      console.error("reapStalledRun: failed to write error runs row", e);
    }
  }

  attempt.completed_at = now;
  attempt.outcome = "error";
  attempt.error = errorMsg;
  await setSetting(env, "last_run_attempt", JSON.stringify(attempt)).catch((e) =>
    console.error("reapStalledRun: failed to update heartbeat", e),
  );
}

/** The full research loop. Plan → gather → recall → write → persist.
 *  `signal` (optional) is forwarded to Tavily/Anthropic fetches so the
 *  ResearchRunner DO alarm can enforce a max_run_seconds ceiling — when the
 *  signal fires, in-flight fetches throw `AbortError` and the catch block
 *  records the run as errored with the originating step tagged. */
export async function runResearch(
  env: Env,
  target: Target,
  skill: Skill,
  triggeredBy: "cron" | "manual",
  signal?: AbortSignal,
): Promise<Report> {
  // Generate runId BEFORE the try block so the catch can always write a row,
  // even if pre-flight checks (budget / model resolution) throw.
  const runId = uid();
  const t0 = Date.now();
  let chatModel = "";

  const attempt: LastRunAttempt = {
    run_id: runId,
    target_slug: target.slug,
    triggered_by: triggeredBy,
    started_at: t0,
    last_step: "init",
    completed_at: null,
    outcome: "in_flight",
  };
  await markStep(env, attempt, "init");

  try {
    await checkBudget(env, "reports");

    // Resolve the chat model ONCE at the start so every step of this run uses
    // the same model and the persisted report records exactly that model.
    chatModel = await getChatModel(env);

    const calls = skillToolCalls(skill);
    // Only Tavily search needs LLM-planned queries — extract uses an
    // explicit URL list, and a writer-only skill has no calls at all.
    const needsQueries = calls.some(
      (c) => c.tool === "tavily" && c.op === "search",
    );
    // Per-target query count (NULL = global default 10). Plumbs through
    // to plannerSystemPrompt(n) so the prompt scales with N rather than
    // shouting "EXACTLY 10".
    const n = target.queries_per_run != null
      ? Math.max(1, Math.min(20, Math.floor(target.queries_per_run)))
      : await readIntSetting(env, "default_queries_per_run", 10, 1, 20);
    await markStep(env, attempt, "plan");
    // Build filter hints from the Tavily search call's params so the
    // planner knows what's already filtered API-side.
    const tavilySearchCall = calls.find((c) => c.tool === "tavily" && c.op === "search");
    const filterHints: { include?: string[]; exclude?: string[]; country?: string } = {};
    if (tavilySearchCall) {
      const splitDomains = (v: string | undefined): string[] =>
        (v ?? "")
          .split(/[\s,]+/)
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d && /^[a-z0-9.-]+$/.test(d));
      const inc = splitDomains(tavilySearchCall.params.include_domains);
      const exc = splitDomains(tavilySearchCall.params.exclude_domains);
      const country = (tavilySearchCall.params.country ?? "").trim();
      if (inc.length) filterHints.include = inc;
      if (exc.length) filterHints.exclude = exc;
      if (country) filterHints.country = country;
    }
    const queries = needsQueries
      ? (await planResearch(env, skill, target, n, chatModel, filterHints, signal)).queries
      : [];

    await markStep(env, attempt, "gather");
    const { sources, stats: gatherStats } = await gatherSources(env, queries, target, skill, calls, signal);
    attempt.gather_stats = gatherStats;

    await markStep(env, attempt, "recall");
    const recalled = await recallMemory(env, target, skill);

    await markStep(env, attempt, "write");
    const { title, summary, body, citations } = await writeReport(
      env,
      skill,
      target,
      sources,
      recalled,
      chatModel,
      signal,
    );

    await markStep(env, attempt, "persist");

    const reportId = uid();
    const created = Date.now();
    const wordCount = body.split(/\s+/).filter(Boolean).length;
    // `snippet` is now the LLM-authored editorial summary (~1–4 sentences,
    // ≤100 words) from the writer's frontmatter block — or the fallback
    // truncated lead if the model fumbled the format. Same column, better
    // content. Surfaced as `summary` in the public JSON API.
    const snippet = summary;

    // R2 stores just title + body. Target / skill / generated-at metadata
    // is rendered from the D1 row in the page header, no need to duplicate
    // it inline in the markdown.
    const md = `# ${title}\n\n${body}\n`;

    const r2Key = `reports/${created}-${reportId}.md`;
    await env.REPORTS.put(r2Key, md, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });

    // Persist the unified citation list (web + archive) so the rendered
    // report footer can group them and link archive entries to /report/:id.
    // Schema: [{ title, url, kind: "web" | "archive" }]. Old rows without
    // `kind` are treated as web in the renderer (backwards-compatible).
    // We store ALL citations the writer received — not a truncated subset —
    // so every [N] marker in the body resolves to a real URL in the footer
    // (the previous `.slice(0, 20)` left [21]..[N] as dead links whenever
    // max_final_sources was set above 20). Row size is fine: at the new
    // max_final_sources ceiling of 200, a citation entry is ~200 bytes →
    // ~40KB JSON, well under D1's per-row capacity.
    const sourcesJson = JSON.stringify(
      citations.map((c) => ({ title: c.title, url: c.url, kind: c.kind })),
    );

    await env.DB.prepare(
      `INSERT INTO reports (id, target_id, skill_id, title, snippet, r2_key, word_count, sources_json, run_id, chat_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(reportId, target.id, skill.id, title, snippet, r2Key, wordCount, sourcesJson, runId, chatModel, created)
      .run();

    // Embed for cross-target recall. Best-effort: failures are surfaced
    // to the admin Maintenance card via settings; they never abort the
    // report write.
    await embedReport(env, {
      id: reportId,
      target_id: target.id,
      target_name: target.name,
      target_slug: target.slug,
      skill_id: skill.id,
      skill_slug: skill.slug,
      skill_name: skill.name,
      title,
      snippet,
      body,
      created_at: created,
    });

    await env.DB.prepare("UPDATE skills SET used_count = used_count + 1, updated_at = ? WHERE id = ?")
      .bind(Date.now(), skill.id)
      .run();

    // next_run_at uses anchor-based slots (v12): the next wall-clock slot
    // at `anchor + k*cadence` UTC strictly after the run just completed.
    // No more 1-hour-per-day drift — the schedule stays pinned to a fixed
    // UTC time regardless of how long any individual run took. NULL
    // anchor falls back to DEFAULT_ANCHOR_HOUR_UTC (= 2 → 02:00 UTC).
    const anchorHour = target.anchor_hour_utc ?? DEFAULT_ANCHOR_HOUR_UTC;
    const nextRunAt = computeNextRunAt(created, target.cadence_hours, anchorHour);
    await env.DB.prepare(
      `UPDATE targets SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(created, nextRunAt, created, target.id)
      .run();

    // Persist the gather funnel onto the run row so historical Activity
    // entries can show the same breakdown the heartbeat does for the
    // most-recent run. Empty when no gather happened (skill with no
    // queries-needing tools — won't be the common case).
    const gatherStatsJson = attempt.gather_stats ? JSON.stringify(attempt.gather_stats) : null;

    await env.DB.prepare(
      `INSERT INTO runs (id, target_id, skill_id, triggered_by, status, report_id, duration_ms, gather_stats_json, created_at)
       VALUES (?, ?, ?, ?, 'success', ?, ?, ?, ?)`,
    )
      .bind(runId, target.id, skill.id, triggeredBy, reportId, Date.now() - t0, gatherStatsJson, Date.now())
      .run();

    await bumpUsage(env, "reports");

    attempt.completed_at = Date.now();
    attempt.outcome = "success";
    await markStep(env, attempt, "done");

    // Paired day-map (v14). Runs AFTER the briefing is fully persisted, gated
    // per-target. Lives here (not only in the DO alarm) so BOTH the cron and
    // the manual "Run Now" path get a day-map. makeDayMap is best-effort and
    // never throws, so it can't fail or roll back the briefing above. We do
    // it before the final getReportById so the returned Report carries the
    // freshly-linked day_map_r2_key / day_map_slug.
    try {
      if (await dayMapEnabledForTarget(env, target)) {
        await makeDayMap(
          env,
          { id: reportId, created_at: created, title, snippet },
          body,
          chatModel,
          signal,
        );
      }
    } catch (dayMapErr) {
      console.error(`runResearch[${runId}] day-map step failed (non-fatal):`, dayMapErr);
    }

    // The rest of the edition: lesson (the "why") + lab (rehearse the decision).
    // WatchOMacho creates the WHOLE edition now (2026-06-01) — Daylila reads +
    // renders, generates nothing. Both best-effort + never throw, so they can't
    // roll back the briefing. The lab depends on the lesson (it rehearses the
    // lesson's pattern), so lesson runs first. Each is independently
    // re-runnable from admin if it fails (regenerateLesson / regenerateLab).
    try {
      await makeLesson(
        env,
        { id: reportId, target_id: target.id, created_at: created, title },
        body,
        chatModel,
        signal,
      );
    } catch (lessonErr) {
      console.error(`runResearch[${runId}] lesson step failed (non-fatal):`, lessonErr);
    }
    try {
      await makeLab(
        env,
        { id: reportId, target_id: target.id, created_at: created },
        chatModel,
        signal,
      );
    } catch (labErr) {
      console.error(`runResearch[${runId}] lab step failed (non-fatal):`, labErr);
    }

    // Daylila reads the whole edition (briefing + map + lesson + lab) from
    // /api/reports/:id on demand and renders it — there is nothing to notify.
    // The old fireDaylilaWebhook ping was removed 2026-06-01: it kicked
    // Daylila's legacy agents worker into RE-generating the lesson + lab, so
    // leaving it fired caused a double-generation once WatchOMacho took over
    // edition creation. WatchOMacho is now the sole creator.
    return (await getReportById(env, reportId))!;
  } catch (err: any) {
    // Tag the error with the step we failed at, so Activity can render
    // "failed @ gather" instead of just "error", and so you can grep
    // wrangler tail for which boundary actually broke.
    const failedStep = attempt.last_step;
    const errMessage = `${failedStep}: ${String(err?.message ?? err)}`;
    console.error(`runResearch[${runId}] failed at ${failedStep}:`, err);

    attempt.completed_at = Date.now();
    attempt.outcome = "error";
    attempt.error = errMessage;
    await markStep(env, attempt, failedStep);

    // Persist gather funnel onto the error row too, so a "failed at write"
    // run still tells you which sources made it through gather (often the
    // funnel is the smoking gun for *why* write blew up).
    const gatherStatsJson = attempt.gather_stats ? JSON.stringify(attempt.gather_stats) : null;

    try {
      await env.DB.prepare(
        `INSERT INTO runs (id, target_id, skill_id, triggered_by, status, error, duration_ms, gather_stats_json, created_at)
         VALUES (?, ?, ?, ?, 'error', ?, ?, ?, ?)`,
      )
        .bind(
          runId,
          target.id,
          skill.id,
          triggeredBy,
          errMessage,
          Date.now() - t0,
          gatherStatsJson,
          Date.now(),
        )
        .run();
    } catch (insertErr) {
      // If even the error-row INSERT failed, the live `last_run_attempt`
      // setting we just wrote above is now the only fingerprint of this
      // failure. Log loudly so wrangler tail still surfaces it.
      console.error(`runResearch[${runId}] could not record error run row:`, insertErr);
    }
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

  // Watchdog: clear any `in_flight` heartbeat that's been stalled past the
  // configured ceiling + a small grace window. Catches the case where the
  // Durable Object alarm was killed by the runtime before its catch block
  // could write a runs row — without this, the heartbeat would say
  // "stalled at write" forever and the Activity card would mislead.
  try {
    await reapStalledRun(env, now);
  } catch (e) {
    console.error("cronTick: watchdog reapStalledRun failed", e);
  }

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

  // Route each due target through its ResearchRunner DO (keyed by slug)
  // rather than running runResearch inline here. The edition is now FOUR
  // serial LLM calls (writer + day-map + lesson + lab), ~3–4 min — well past
  // the 30s scheduled() waitUntil cap. The DO alarm gives a 15-min budget AND
  // wraps the run in the max_run_seconds AbortController, so a hung call
  // auto-aborts instead of burning the whole budget. Enqueue + return; the
  // alarm advances the target's next_run_at on success (same as "Run Now").
  // Per-target budget is still checked inside each runResearch (throws
  // BudgetExceeded → recorded on the run row), so we don't pre-check here.
  for (const target of due.results ?? []) {
    if (!target.primary_skill_id) {
      skipped++;
      continue;
    }
    try {
      const stub = env.RESEARCH_RUNNER.get(env.RESEARCH_RUNNER.idFromName(target.slug));
      await stub.scheduleManualRun(target.slug, "cron");
      processed++;
    } catch (e: any) {
      errors++;
      console.error("cron enqueue failed", target.slug, e);
    }
  }

  await setSetting(env, "last_cron_run", String(now));

  // Periodic R2 sweep. Cheap on small buckets and keeps any drift from
  // failed deletes from accumulating beyond an hour without admin attention.
  try {
    const gc = await gcOrphanedR2(env);
    if (gc.orphans > 0 || gc.failures.length > 0) {
      console.log("cronTick: gcOrphanedR2", gc);
    }
  } catch (e) {
    console.error("cronTick: gcOrphanedR2 failed", e);
  }

  return { processed, skipped, errors };
}

// ─── ResearchRunner Durable Object ────────────────────────────────────────
//
// Per-target DO that wraps `runResearch` in an alarm handler so manual
// "Run Now" gets a 15-minute wall-clock budget instead of the 30-second
// `ctx.waitUntil()` cap on HTTP requests.
//
// Why it exists:
//   The HTTP handler returns a redirect immediately. Any code we attach to
//   `ctx.waitUntil` only gets 30 more seconds of wall-clock before Cloudflare
//   silently kills the isolate (no exception, no error row written). For
//   skills whose pipeline takes >30s end-to-end (slow Tavily gather or
//   bloated writer), Run Now stalls every time.
//
// What it does:
//   Route calls `stub.scheduleManualRun(targetSlug)` → DO stores the slug in
//   its own SQLite + sets an alarm for now+1s → returns immediately. The
//   alarm fires inside the scheduled-handler context, which has the
//   15-minute budget. Same `runResearch()` runs, persistence into D1/R2/
//   Vectorize is unchanged.
//
// Cost: per-run compute is ~70s × 0.128 GB = ~9 GB-seconds. The Workers
// Free DO quota is 13,000 GB-seconds/day, so we can do ~1,400 manual runs
// per day before hitting the cap (we average ~10/day).
//
// Naming: `idFromName(targetSlug)` so each target gets exactly one DO
// instance — natural serialisation for back-to-back Run Now clicks on the
// same target.
//
// On Workers Free, this DO MUST use the SQLite backend (declared in
// wrangler.toml via `new_sqlite_classes`). Storage is tiny (one row per
// pending job, deleted on completion).
export class ResearchRunner extends DurableObject<Env> {
  /** Called from the HTTP route (manual "Run Now") AND from cronTick. Records
   *  the pending job and sets a 1s alarm; returns immediately. `triggeredBy`
   *  defaults to "manual" so the existing call sites are unchanged; cronTick
   *  passes "cron" so the whole edition (briefing + map + lesson + lab) runs
   *  inside the DO's 15-min budget + max_run_seconds AbortController ceiling
   *  rather than inline under the 30s scheduled() waitUntil cap. */
  async scheduleManualRun(targetSlug: string, triggeredBy: "manual" | "cron" = "manual"): Promise<void> {
    await this.ctx.storage.put("job", {
      kind: "full" as const,
      targetSlug,
      triggeredBy,
      scheduledAt: Date.now(),
    });
    // Fire effectively now. The 1s offset lets the DO settle before alarm.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /** Regenerate ONE edition piece (lesson or lab) for an existing report —
   *  no research, no briefing re-write. Mirrors scheduleDayMapRun; runs inside
   *  the 15-min budget so the long generation can't be cut by the 30s cap.
   *  Keyed by the caller as `lesson:<id>` / `lab:<id>` so a piece regen never
   *  clobbers a target's full-run job slot. */
  async schedulePieceRun(piece: "lesson" | "lab", reportId: string): Promise<void> {
    await this.ctx.storage.put("job", {
      kind: piece,
      reportId,
      scheduledAt: Date.now(),
    });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /** Like scheduleManualRun, but regenerates ONLY the day-map for one existing
   *  report (no research, no re-write). Runs inside the alarm's 15-min budget
   *  so the long day-map call can't be cut off by the 30s ctx.waitUntil cap.
   *  The caller keys this DO by report id (`day-map:<id>`), separate from the
   *  target's full-run DO, so a regen never clobbers a "Run Now" job slot.
   *  `targetSlug` is kept only for log context. */
  async scheduleDayMapRun(targetSlug: string, reportId: string): Promise<void> {
    await this.ctx.storage.put("job", {
      kind: "day-map" as const,
      targetSlug,
      reportId,
      scheduledAt: Date.now(),
    });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /** Cloudflare invokes this when our setAlarm time arrives. Runs in the
   *  scheduled-handler context (15-min wall budget). We enforce a tighter
   *  `max_run_seconds` ceiling via an AbortController so a hung Tavily /
   *  Anthropic fetch can't burn the full 15 minutes (~115 GB-seconds). */
  async alarm(): Promise<void> {
    type Job =
      | { kind: "full"; targetSlug: string; triggeredBy: "manual" | "cron"; scheduledAt: number }
      | { kind: "day-map"; targetSlug: string; reportId: string; scheduledAt: number }
      | { kind: "lesson" | "lab"; reportId: string; scheduledAt: number };
    const rawJob = await this.ctx.storage.get<Record<string, unknown>>("job");
    if (!rawJob) {
      console.warn("ResearchRunner alarm: no pending job; nothing to do");
      return;
    }
    // Legacy jobs (pre-2026-06-01) were written without `kind`; treat a missing
    // discriminant as a full run so an in-flight upgrade can't strand one.
    if (!rawJob.kind) rawJob.kind = "full";
    const job = rawJob as unknown as Job;

    // Read the configurable per-run ceiling (Run guardrails admin card).
    // 30–600s window: anything outside falls back to DEFAULT_MAX_RUN_SECONDS.
    const maxRunSeconds = await readIntSetting(
      this.env,
      "max_run_seconds",
      DEFAULT_MAX_RUN_SECONDS,
      5,
      600,
    );

    // AbortController feeds the signal down to every fetch (Tavily,
    // Anthropic). When the timer fires, in-flight fetches throw
    // `AbortError`; runResearch's catch records "<step>: AbortError" into
    // the runs table and surfaces it on the Activity card.
    const jobLabel = job.kind === "full" ? job.targetSlug : `${job.kind}:${job.reportId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      console.warn(`ResearchRunner alarm: max_run_seconds (${maxRunSeconds}s) exceeded for ${jobLabel}, aborting`);
      controller.abort(new Error(`max_run_seconds (${maxRunSeconds}s) exceeded`));
    }, maxRunSeconds * 1000);

    try {
      if (job.kind === "day-map") {
        // Day-map-only regen: no research, just rebuild the map from the
        // already-stored briefing body. Best-effort, like the post-run hook.
        console.log(`ResearchRunner alarm: regenerating day-map for report ${job.reportId} (max ${maxRunSeconds}s)`);
        const ok = await regenerateDayMap(this.env, job.reportId, controller.signal);
        if (!ok) console.error(`ResearchRunner alarm: could not load report ${job.reportId} for day-map regen`);
      } else if (job.kind === "lesson") {
        // Lesson-only regen — modular: re-runs ONE piece, not the edition.
        console.log(`ResearchRunner alarm: regenerating lesson for report ${job.reportId} (max ${maxRunSeconds}s)`);
        const ok = await regenerateLesson(this.env, job.reportId, controller.signal);
        if (!ok) console.error(`ResearchRunner alarm: could not load report ${job.reportId} for lesson regen`);
      } else if (job.kind === "lab") {
        // Lab-only regen — modular: re-runs ONE piece. Needs the lesson to
        // already exist (it rehearses the lesson's pattern).
        console.log(`ResearchRunner alarm: regenerating lab for report ${job.reportId} (max ${maxRunSeconds}s)`);
        const ok = await regenerateLab(this.env, job.reportId, controller.signal);
        if (!ok) console.error(`ResearchRunner alarm: could not load report ${job.reportId} for lab regen`);
      } else if (job.kind === "full") {
        const target = await getTargetBySlug(this.env, job.targetSlug);
        if (!target) {
          console.error(`ResearchRunner alarm: target not found: ${job.targetSlug}`);
          return;
        }
        if (!target.primary_skill_id) {
          console.error(`ResearchRunner alarm: target has no skill: ${job.targetSlug}`);
          return;
        }
        const skill = await getSkillById(this.env, target.primary_skill_id);
        if (!skill) {
          console.error(`ResearchRunner alarm: skill not found for target: ${job.targetSlug}`);
          return;
        }
        console.log(`ResearchRunner alarm: running ${job.targetSlug} (${job.triggeredBy}, max ${maxRunSeconds}s)`);
        await runResearch(this.env, target, skill, job.triggeredBy, controller.signal);
      }
    } catch (e) {
      console.error(`ResearchRunner alarm failed:`, e);
    } finally {
      clearTimeout(timer);
      // Always clear the pending job so the DO can hibernate cleanly.
      await this.ctx.storage.delete("job");
    }
  }
}
