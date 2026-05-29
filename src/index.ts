// WatchOMacho — Worker entry point.
// HTTP routes + cron handler. Business logic lives in agent.ts.

import {
  ALLOWED_CHAT_MODELS,
  BudgetExceeded,
  DEFAULT_CHAT_MODEL,
  cronTick,
  createSkillFromMarkdown,
  createTarget,
  backfillMemory,
  countSkillUsage,
  deleteReport,
  deleteSkill,
  deleteTarget,
  gcOrphanedR2,
  getChatModel,
  getDailyUsage,
  getReportById,
  getSetting,
  getSkillById,
  getSkillBySlug,
  getTargetById,
  getTargetBySlug,
  isAllowedChatModel,
  listReportsForTarget,
  listSkills,
  listTargets,
  ResearchRunner,
  rescheduleTarget,
  runResearch,
  setSetting,
  updateSkill,
  updateTarget,
  type Env,
  type Skill,
  type Target,
} from "./agent";

// Re-export the Durable Object class so Cloudflare's runtime can find it.
// Wrangler's `class_name = "ResearchRunner"` binding looks it up on the
// main entry module.
export { ResearchRunner };
import {
  renderAdminLogin,
  renderAdminPanel,
  renderAdminSkills,
  renderAdminTargetEdit,
  renderAdminTargetsList,
  renderAdminTools,
  renderHome,
  renderReportPage,
  renderSkillPage,
  renderTargetPage,
} from "./dashboard";

const SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), camera=(), microphone=()",
  "content-security-policy": [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

function withSecurityHeaders(init: ResponseInit): ResponseInit {
  return {
    ...init,
    headers: { ...SECURITY_HEADERS, ...(init.headers ?? {}) },
  };
}

/** Pull the per-skill tool params from a form. Returns a flat object of
 *  whatever was set; blank values are dropped so they fall back to the
 *  tool's defaults at run time. Domain lists are normalised to comma-
 *  separated lowercase tokens; gatherTavily re-splits them. */
function collectSkillToolParams(form: Record<string, string>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const k of ["topic", "time_range", "depth", "country"]) {
    const v = (form[k] ?? "").trim();
    if (v) params[k] = v;
  }
  for (const k of ["include_domains", "exclude_domains"]) {
    const cleaned = (form[k] ?? "")
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d && /^[a-z0-9.-]+$/.test(d));
    if (cleaned.length) params[k] = cleaned.join(", ");
  }
  return params;
}

/** Parse a textarea of URLs (one per line, # comments OK) into a clean
 *  list. Returns [] when empty. */
function parseSourceUrls(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .filter((l) => /^https?:\/\//i.test(l));
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, withSecurityHeaders({
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  }));
}

function json(data: any, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), withSecurityHeaders({
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  }));
}

/** Gate /api/* endpoints behind the X-API-Key header (timing-safe compare
 *  against the WATCHOMACHO_API_KEY secret). Returns null when the request
 *  is authorised, or a 401 Response to short-circuit otherwise. If the
 *  secret isn't configured at all the API is locked down entirely — that's
 *  intentional (fail closed, not open). */
function requireApiKey(req: Request, env: Env): Response | null {
  if (!env.WATCHOMACHO_API_KEY) {
    return json(
      { error: "API not configured", hint: "Set WATCHOMACHO_API_KEY via `wrangler secret put`." },
      { status: 503 },
    );
  }
  const sent = req.headers.get("x-api-key") ?? "";
  if (!sent || !timingSafeEqual(sent, env.WATCHOMACHO_API_KEY)) {
    return json({ error: "unauthorised" }, { status: 401 });
  }
  return null;
}

/** Format a millisecond timestamp as "YYYY-MM-DD" in UTC. Used by the
 *  public report API so downstream consumers (daylila) have a single
 *  canonical "day this briefing belongs to" string. Picking UTC keeps it
 *  consistent regardless of where the consumer renders it — no more
 *  homepage-vs-detail-page mismatches caused by independent timezone
 *  formatting on each surface. */
function formatBriefingDateUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extraHeaders } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAdmin(req: Request, env: Env): boolean {
  if (!env.ADMIN_SECRET) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)watchomacho_admin=([^;]+)/);
  if (!m) return false;
  try {
    return timingSafeEqual(decodeURIComponent(m[1]), env.ADMIN_SECRET);
  } catch {
    return false;
  }
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const j: any = await req.json();
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(j ?? {})) out[k] = String(v ?? "");
      return out;
    } catch {
      return {};
    }
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    const out: Record<string, string> = {};
    fd.forEach((v, k) => {
      out[k] = String(v ?? "");
    });
    return out;
  }
  const text = await req.text();
  if (!text) return {};
  try {
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    params.forEach((v, k) => (out[k] = v));
    return out;
  } catch {
    return {};
  }
}

// Login throttle: 10 failed attempts per IP per rolling 10m window.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILED = 10;

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

async function pruneLogins(env: Env): Promise<void> {
  const cutoff = Date.now() - LOGIN_WINDOW_MS * 6;
  await env.DB.prepare("DELETE FROM login_attempts WHERE ts < ?")
    .bind(cutoff)
    .run()
    .catch(() => {});
}

async function loginTooManyFailures(env: Env, ip: string): Promise<boolean> {
  const since = Date.now() - LOGIN_WINDOW_MS;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM login_attempts WHERE ip = ? AND ok = 0 AND ts >= ?",
  )
    .bind(ip, since)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= LOGIN_MAX_FAILED;
}

async function recordLogin(env: Env, ip: string, ok: boolean): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO login_attempts (ip, ts, ok) VALUES (?, ?, ?)",
  )
    .bind(ip, Date.now(), ok ? 1 : 0)
    .run()
    .catch(() => {});
}

function validSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(s);
}

// ─── Worker ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ─── Static assets (served from R2 watchomacho-reports/static/) ──────
      // Versioned filenames are immutable: bump the filename version to bust
      // the edge cache.
      if (path === "/static/tailwind.v4.css" && (req.method === "GET" || req.method === "HEAD")) {
        const obj = await env.REPORTS.get("static/tailwind.v4.css");
        if (!obj) return new Response("Not found", { status: 404 });
        const headers = {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        };
        return new Response(req.method === "HEAD" ? null : obj.body, { headers });
      }

      // ─── Public ──────────────────────────────────────────────────────────
      if (path === "/" && req.method === "GET") {
        return html(await renderHome(env));
      }

      if (path.startsWith("/target/") && req.method === "GET") {
        const slug = path.slice("/target/".length);
        if (!validSlug(slug)) {
          return new Response("Bad slug", withSecurityHeaders({ status: 400 }));
        }
        return html(await renderTargetPage(env, slug));
      }

      if (path.startsWith("/skill/") && req.method === "GET") {
        const slug = path.slice("/skill/".length);
        if (!validSlug(slug)) {
          return new Response("Bad slug", withSecurityHeaders({ status: 400 }));
        }
        return html(await renderSkillPage(env, slug));
      }

      if (path.startsWith("/report/") && req.method === "GET") {
        const id = path.slice("/report/".length);
        if (!/^[a-z0-9-]+$/.test(id)) {
          return new Response("Bad id", withSecurityHeaders({ status: 400 }));
        }
        return html(await renderReportPage(env, id));
      }

      // ─── Day-map (public; v14) ─────────────────────────────────────────────
      // Serves a briefing's paired day-map (self-contained interactive HTML) at
      // its own URL so daylila (or anyone) can embed it in a sandboxed iframe
      // or link to it. Keyed by report id; the descriptive day_map_slug is
      // exposed via the JSON API for building pretty URLs on top.
      //
      // The HTML is LLM-authored, so a direct (non-iframed) visit would run its
      // script in this origin. We serve it under a strict Content-Security-
      // Policy that blocks all network egress (`connect-src 'none'`) and allows
      // scripts only inline + from cdnjs — the same one-library allowance the
      // generator is given. That caps a prompt-injected map: it can't phone
      // home or load arbitrary code, in or out of an iframe.
      if (path.startsWith("/day-map/") && (req.method === "GET" || req.method === "HEAD")) {
        const id = path.slice("/day-map/".length);
        if (!/^[a-z0-9-]+$/.test(id)) {
          return new Response("Bad id", withSecurityHeaders({ status: 400 }));
        }
        const report = await getReportById(env, id);
        if (!report?.day_map_r2_key) {
          return new Response("Not found", withSecurityHeaders({ status: 404 }));
        }
        const obj = await env.REPORTS.get(report.day_map_r2_key);
        if (!obj) return new Response("Not found", withSecurityHeaders({ status: 404 }));
        // Honour the stored content-type so pre-v14 rows (which still point at
        // an old SVG) keep serving as SVG; new day-maps are text/html.
        const contentType = obj.httpMetadata?.contentType || "text/html; charset=utf-8";
        return new Response(req.method === "HEAD" ? null : obj.body, {
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=86400",
            "content-security-policy":
              "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; " +
              "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
              "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors *",
          },
        });
      }

      // ─── JSON API ────────────────────────────────────────────────────────
      // All /api/* endpoints are gated by the X-API-Key header. The secret
      // is WATCHOMACHO_API_KEY (set via `wrangler secret put`). Callers
      // (daylila dashboard etc.) include it on every request.
      if (path.startsWith("/api/") && req.method === "GET") {
        const denied = requireApiKey(req, env);
        if (denied) return denied;

        if (path === "/api/targets") {
          const targets = await listTargets(env, "active");
          return json({
            targets: targets.map((t) => ({
              id: t.id, slug: t.slug, name: t.name, kind: t.kind,
              description: t.description, cadence_hours: t.cadence_hours,
              created_at: t.created_at, updated_at: t.updated_at,
            })),
          });
        }

        if (path === "/api/skills") {
          const skills = await listSkills(env);
          return json({
            skills: skills.map((s) => ({
              id: s.id, slug: s.slug, name: s.name, description: s.description,
              author: s.author, used_count: s.used_count,
              created_at: s.created_at, updated_at: s.updated_at,
            })),
          });
        }

        // GET /api/reports/recent?limit=N — cross-target latest reports for
        // a "feed"-shaped consumer. Returns lightweight rows (no full body
        // markdown) — pull individual reports for the full content.
        if (path === "/api/reports/recent") {
          const limitRaw = parseInt(url.searchParams.get("limit") ?? "10", 10);
          const limit = Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(50, limitRaw))
            : 10;
          const origin = new URL(req.url).origin;
          const rows = await env.DB.prepare(
            `SELECT reports.id, reports.title, reports.snippet, reports.word_count,
                    reports.sources_json, reports.created_at,
                    reports.day_map_r2_key, reports.day_map_slug,
                    targets.slug AS target_slug, targets.name AS target_name
               FROM reports
               LEFT JOIN targets ON targets.id = reports.target_id
              ORDER BY reports.created_at DESC
              LIMIT ?`,
          ).bind(limit).all<any>();
          const items = (rows.results ?? []).map((r) => ({
            id: r.id,
            title: r.title,
            url: `${origin}/report/${r.id}`,
            // `date` is the full ISO timestamp (kept for back-compat with
            // any existing consumer); `briefing_date` is the canonical
            // UTC calendar date — use this one for date-stamping the
            // briefing in UI surfaces, so homepage/detail render the
            // same string.
            date: new Date(r.created_at).toISOString(),
            briefing_date: formatBriefingDateUtc(r.created_at),
            summary: r.snippet,
            word_count: r.word_count,
            target: r.target_slug
              ? { slug: r.target_slug, name: r.target_name }
              : null,
            source_count: r.sources_json
              ? (() => { try { return JSON.parse(r.sources_json).length; } catch { return 0; } })()
              : 0,
            // Paired day-map (v14). null when the run made no day-map. The feed
            // stays light — slug + URL only, no inline HTML (pull /api/reports/:id
            // for the HTML itself).
            day_map: r.day_map_r2_key
              ? { slug: r.day_map_slug, url: `${origin}/day-map/${r.id}` }
              : null,
          }));
          return json({ reports: items });
        }

        // GET /api/reports/:id — full content of a single report. D1 row
        // for metadata, R2 blob for the markdown body, sources_json for
        // citations.
        if (path.startsWith("/api/reports/")) {
          const id = path.slice("/api/reports/".length);
          if (!/^[a-z0-9-]+$/.test(id)) {
            return json({ error: "bad id" }, { status: 400 });
          }
          const report = await getReportById(env, id);
          if (!report) {
            return json({ error: "not found" }, { status: 404 });
          }
          const obj = await env.REPORTS.get(report.r2_key);
          const bodyMarkdown = obj ? await obj.text() : null;
          // Paired day-map (v14): inline the self-contained interactive HTML
          // (mirrors body_markdown) in daylila's "lab" shape — { type:'html',
          // html } — plus the slug + its own URL. daylila drops `html` straight
          // into a sandboxed iframe. null when the run made no day-map.
          let day_map:
            | { type: "html"; html: string | null; slug: string | null; url: string }
            | null = null;
          if (report.day_map_r2_key) {
            const dmObj = await env.REPORTS.get(report.day_map_r2_key);
            day_map = {
              type: "html",
              html: dmObj ? await dmObj.text() : null,
              slug: report.day_map_slug,
              url: `${new URL(req.url).origin}/day-map/${report.id}`,
            };
          }
          const target = await getTargetById(env, report.target_id);
          let sources: Array<{ title: string; url: string; kind: string }> = [];
          if (report.sources_json) {
            try {
              const raw = JSON.parse(report.sources_json);
              if (Array.isArray(raw)) {
                sources = raw.map((s: any) => ({
                  title: String(s?.title ?? ""),
                  url: String(s?.url ?? ""),
                  kind: String(s?.kind ?? "web"),
                }));
              }
            } catch { /* corrupted JSON — return [] */ }
          }
          const origin = new URL(req.url).origin;
          return json({
            id: report.id,
            title: report.title,
            url: `${origin}/report/${report.id}`,
            // See /api/reports/recent above for the date / briefing_date
            // split. Keep both surfaces emitting identical date semantics.
            date: new Date(report.created_at).toISOString(),
            briefing_date: formatBriefingDateUtc(report.created_at),
            summary: report.snippet,
            word_count: report.word_count,
            target: target ? { slug: target.slug, name: target.name } : null,
            body_markdown: bodyMarkdown,
            sources,
            day_map,
          });
        }

        return json({ error: "unknown endpoint" }, { status: 404 });
      }

      // ─── Admin: auth ─────────────────────────────────────────────────────
      if (path === "/admin/login" && req.method === "GET") {
        return html(renderAdminLogin());
      }

      if (path === "/admin/login" && req.method === "POST") {
        const ip = clientIp(req);
        if (await loginTooManyFailures(env, ip)) {
          return html(renderAdminLogin("Too many failed attempts. Wait ten minutes."), { status: 429 });
        }
        const form = await readForm(req);
        const secret = form.secret ?? "";
        const okSecret = !!env.ADMIN_SECRET && timingSafeEqual(secret, env.ADMIN_SECRET);
        await recordLogin(env, ip, okSecret);
        if (!okSecret) {
          ctx.waitUntil(pruneLogins(env));
          return html(renderAdminLogin("Wrong secret."), { status: 401 });
        }
        return redirect("/admin", {
          "set-cookie": `watchomacho_admin=${encodeURIComponent(secret)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
        });
      }

      if (path === "/admin/logout" && req.method === "POST") {
        return redirect("/admin/login", {
          "set-cookie": `watchomacho_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        });
      }

      // ─── Admin: gated ────────────────────────────────────────────────────
      if (path === "/admin" && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        return html(await renderAdminPanel(env));
      }

      if (path === "/admin/skills" && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        return html(await renderAdminSkills(env));
      }

      if (path === "/admin/tools" && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        return html(renderAdminTools());
      }

      if (path === "/admin/targets" && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        return html(await renderAdminTargetsList(env));
      }

      if (path.startsWith("/admin/targets/") && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        const slug = path.slice("/admin/targets/".length);
        if (!validSlug(slug)) {
          return new Response("Bad slug", withSecurityHeaders({ status: 400 }));
        }
        const queued = url.searchParams.get("queued") === "1";
        const dayMapQueued = url.searchParams.get("daymap") === "1";
        return html(await renderAdminTargetEdit(env, slug, queued, dayMapQueued));
      }

      // Targets: create / update / delete
      if (path === "/admin/targets" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const name = (form.name ?? "").trim();
        if (!name) return json({ error: "name required" }, { status: 400 });
        const cadence = parseInt(form.cadence_hours ?? "24", 10);
        // Anchor hour (v12). Blank or invalid → undefined → createTarget
        // stores NULL → row inherits DEFAULT_ANCHOR_HOUR_UTC at run time.
        const anchorRaw = (form.anchor_hour_utc ?? "").trim();
        let anchor: number | undefined | null = undefined;
        if (anchorRaw === "") {
          anchor = null; // blank = explicit "inherit default"
        } else {
          const n = parseInt(anchorRaw, 10);
          if (Number.isFinite(n) && n >= 0 && n <= 23) anchor = n;
        }
        const skillSlug = (form.skill_slug ?? "").trim();
        let skillId: string | undefined;
        if (skillSlug) {
          const sk = await getSkillBySlug(env, skillSlug);
          if (sk) skillId = sk.id;
        }
        const target = await createTarget(env, {
          name,
          kind: form.kind?.trim() || undefined,
          description: form.description?.trim() || undefined,
          cadence_hours: Number.isFinite(cadence) ? cadence : undefined,
          primary_skill_id: skillId,
          anchor_hour_utc: anchor,
        });
        // If the form asked for an immediate run, schedule one through the
        // ResearchRunner DO (15-min alarm budget) so the new target's first
        // run gets the same headroom as a regular "Run now" click.
        if (form.run_now === "1" && skillId) {
          const sk = await getSkillById(env, skillId);
          if (sk) {
            const stub = env.RESEARCH_RUNNER.get(env.RESEARCH_RUNNER.idFromName(target.slug));
            await stub.scheduleManualRun(target.slug);
          }
        }
        return redirect(`/admin/targets/${target.slug}`);
      }

      if (path.startsWith("/admin/targets/") && path.endsWith("/update") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/targets/".length, path.length - "/update".length);
        const target = await getTargetBySlug(env, slug);
        if (!target) return json({ error: "not found" }, { status: 404 });
        const form = await readForm(req);
        const patch: Parameters<typeof updateTarget>[2] = {};
        if (form.kind !== undefined) patch.kind = form.kind || null as any;
        if (form.description !== undefined) patch.description = form.description || null as any;
        if (form.status !== undefined && ["active", "paused", "archived"].includes(form.status)) {
          patch.status = form.status as Target["status"];
        }
        // Track whether scheduling inputs changed so we can call
        // rescheduleTarget() AFTER the row write — otherwise next_run_at
        // stays on the old schedule until the next completed run.
        let scheduleChanged = false;
        if (form.cadence_hours !== undefined) {
          const n = parseInt(form.cadence_hours, 10);
          if (Number.isFinite(n) && n !== target.cadence_hours) {
            patch.cadence_hours = n;
            scheduleChanged = true;
          }
        }
        // Anchor hour (v12). Blank = inherit default (NULL), 0-23 = explicit.
        if (form.anchor_hour_utc !== undefined) {
          const raw = form.anchor_hour_utc.trim();
          if (raw === "") {
            if (target.anchor_hour_utc !== null) {
              patch.anchor_hour_utc = null;
              scheduleChanged = true;
            }
          } else {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && n >= 0 && n <= 23 && n !== target.anchor_hour_utc) {
              patch.anchor_hour_utc = n;
              scheduleChanged = true;
            }
          }
        }
        if (form.skill_slug !== undefined) {
          if (form.skill_slug.trim()) {
            const sk = await getSkillBySlug(env, form.skill_slug.trim());
            if (sk) patch.primary_skill_id = sk.id;
          } else {
            patch.primary_skill_id = null as any;
          }
        }
        // Per-target Tavily knobs. Blank = "use the global default" → NULL.
        if (form.queries_per_run !== undefined) {
          const raw = form.queries_per_run.trim();
          if (raw === "") {
            patch.queries_per_run = null;
          } else {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && n >= 1 && n <= 20) patch.queries_per_run = n;
          }
        }
        if (form.tavily_min_score !== undefined) {
          const raw = form.tavily_min_score.trim();
          if (raw === "") {
            patch.tavily_min_score = null;
          } else {
            const f = parseFloat(raw);
            if (Number.isFinite(f) && f >= 0 && f <= 1) patch.tavily_min_score = f;
          }
        }
        if (form.tavily_max_final_sources !== undefined) {
          const raw = form.tavily_max_final_sources.trim();
          if (raw === "") {
            patch.tavily_max_final_sources = null;
          } else {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && n >= 1 && n <= 200) patch.tavily_max_final_sources = n;
          }
        }
        // Day-map switch (v14). "" = inherit global default (NULL), on = 1, off = 0.
        if (form.day_map_enabled !== undefined) {
          const raw = form.day_map_enabled.trim();
          patch.day_map_enabled = raw === "" ? null : (raw === "on" ? 1 : 0);
        }
        await updateTarget(env, target.id, patch);
        // Snap next_run_at to the new schedule immediately when cadence
        // or anchor changed — see rescheduleTarget() in src/agent.ts.
        if (scheduleChanged) {
          await rescheduleTarget(env, target.id);
        }
        return redirect(`/admin/targets/${target.slug}`);
      }

      if (path.startsWith("/admin/targets/") && path.endsWith("/run") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/targets/".length, path.length - "/run".length);
        const target = await getTargetBySlug(env, slug);
        if (!target) return json({ error: "not found" }, { status: 404 });
        if (!target.primary_skill_id) return json({ error: "no skill attached" }, { status: 400 });
        // We only need to verify the skill exists; the DO re-fetches both
        // target and skill inside the alarm to ensure freshness at run time.
        const skill = await getSkillById(env, target.primary_skill_id);
        if (!skill) return json({ error: "skill missing" }, { status: 400 });
        // Schedule the work into the ResearchRunner DO's alarm (15-min wall
        // budget) instead of ctx.waitUntil (30-second cap). One DO per target
        // serialises back-to-back clicks on the same target.
        const stub = env.RESEARCH_RUNNER.get(env.RESEARCH_RUNNER.idFromName(target.slug));
        await stub.scheduleManualRun(target.slug);
        return redirect(`/admin/targets/${target.slug}?queued=1`);
      }

      if (path.startsWith("/admin/targets/") && path.endsWith("/delete") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/targets/".length, path.length - "/delete".length);
        const target = await getTargetBySlug(env, slug);
        if (!target) return redirect("/admin");
        await deleteTarget(env, target.id);
        return redirect("/admin");
      }

      // Reports: delete a single report (R2 + Vectorize + D1 row; run stays).
      if (path.startsWith("/admin/reports/") && path.endsWith("/delete") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const id = path.slice("/admin/reports/".length, path.length - "/delete".length);
        if (!/^[a-z0-9-]+$/.test(id)) {
          return new Response("Bad id", withSecurityHeaders({ status: 400 }));
        }
        const report = await getReportById(env, id);
        if (!report) return redirect(req.headers.get("referer") || "/admin");
        const target = await getTargetById(env, report.target_id);
        await deleteReport(env, id);
        return redirect(target ? `/admin/targets/${target.slug}` : "/admin");
      }

      // Reports: regenerate ONLY the day-map for one report (one AI call, no
      // re-research). Powers the per-report "Remake map" button. Runs in the
      // ResearchRunner DO (15-min budget) — NOT ctx.waitUntil (30s cap) — so
      // the long day-map call can't be cut off mid-generation.
      if (path.startsWith("/admin/reports/") && path.endsWith("/day-map") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const id = path.slice("/admin/reports/".length, path.length - "/day-map".length);
        if (!/^[a-z0-9-]+$/.test(id)) {
          return new Response("Bad id", withSecurityHeaders({ status: 400 }));
        }
        const report = await getReportById(env, id);
        if (!report) return redirect(req.headers.get("referer") || "/admin");
        const target = await getTargetById(env, report.target_id);
        if (!target) return redirect("/admin");
        const stub = env.RESEARCH_RUNNER.get(env.RESEARCH_RUNNER.idFromName(target.slug));
        await stub.scheduleDayMapRun(target.slug, id);
        return redirect(`/admin/targets/${target.slug}?daymap=1`);
      }

      // Skills: create / update / delete
      if (path === "/admin/skills" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const name = (form.name ?? "").trim();
        const md = (form.procedure_md ?? "").trim();
        if (!name) return json({ error: "name required" }, { status: 400 });
        if (md.length < 30) return json({ error: "procedure_md too short" }, { status: 400 });
        try {
          const skill = await createSkillFromMarkdown(env, {
            name,
            description: form.description?.trim() || undefined,
            procedure_md: md,
            tool_slug: form.tool_slug === "" ? null : (form.tool_slug ?? undefined),
            tool_op: form.tool_op === "" ? null : (form.tool_op ?? undefined),
            tool_params: collectSkillToolParams(form),
            tool_sources: parseSourceUrls(form.tool_sources ?? ""),
          });
          return redirect(`/admin/skills?focus=${encodeURIComponent(skill.slug)}`);
        } catch (e: any) {
          return json({ error: e?.message ?? "create failed" }, { status: 400 });
        }
      }

      if (path.startsWith("/admin/skills/") && path.endsWith("/update") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/skills/".length, path.length - "/update".length);
        const skill = await getSkillBySlug(env, slug);
        if (!skill) return json({ error: "not found" }, { status: 404 });
        const form = await readForm(req);
        try {
          await updateSkill(env, skill.id, {
            name: form.name?.trim() || undefined,
            description: form.description?.trim(),
            procedure_md: form.procedure_md?.trim() || undefined,
            tool_slug: form.tool_slug === undefined
              ? undefined
              : (form.tool_slug === "" ? null : form.tool_slug),
            tool_op: form.tool_op === undefined
              ? undefined
              : (form.tool_op === "" ? null : form.tool_op),
            tool_params: form.tool_slug === undefined ? undefined : collectSkillToolParams(form),
            tool_sources: form.tool_sources === undefined
              ? undefined
              : parseSourceUrls(form.tool_sources),
          });
          return redirect(`/admin/skills?focus=${encodeURIComponent(skill.slug)}`);
        } catch (e: any) {
          return json({ error: e?.message ?? "update failed" }, { status: 400 });
        }
      }

      // Pre-flight: tell the UI where a skill is used so the delete button
      // can show a meaningful warning instead of a blind confirm.
      if (path.startsWith("/admin/skills/") && path.endsWith("/usage") && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/skills/".length, path.length - "/usage".length);
        const skill = await getSkillBySlug(env, slug);
        if (!skill) return json({ error: "not found" }, { status: 404 });
        const usage = await countSkillUsage(env, skill.id);
        return json(usage);
      }

      if (path.startsWith("/admin/skills/") && path.endsWith("/delete") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/skills/".length, path.length - "/delete".length);
        const skill = await getSkillBySlug(env, slug);
        if (!skill) return redirect("/admin/skills");
        try {
          await deleteSkill(env, skill.id);
        } catch (e: any) {
          // Most likely: target(s) still reference it. Return the usage so
          // the UI can present the names of the blockers, not a stack trace.
          const usage = await countSkillUsage(env, skill.id).catch(() => null);
          return json({ error: e?.message ?? "delete failed", usage }, { status: 409 });
        }
        return redirect("/admin/skills");
      }

      // Settings
      if (path === "/admin/settings" && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const [reportLim, searchLim, perTick, lastCron, chatModel, dayMapEnabled] = await Promise.all([
          getSetting(env, "daily_report_limit", "20"),
          getSetting(env, "daily_search_limit", "500"),
          getSetting(env, "cron_max_per_tick", "2"),
          getSetting(env, "last_cron_run", "0"),
          getChatModel(env),
          getSetting(env, "day_map_enabled", "off"),
        ]);
        const usage = await getDailyUsage(env);
        return json({
          daily_report_limit: Number(reportLim),
          daily_search_limit: Number(searchLim),
          cron_max_per_tick: Number(perTick),
          last_cron_run: Number(lastCron),
          chat_model: chatModel,
          day_map_enabled: dayMapEnabled === "on",
          allowed_chat_models: ALLOWED_CHAT_MODELS,
          usage,
          tavily_api_key_set: !!env.TAVILY_API_KEY,
          ch_api_key_set: !!env.CH_API_KEY,
          anthropic_api_key_set: !!env.ANTHROPIC_API_KEY,
          cf_aig_token_set: !!env.CF_AIG_TOKEN,
          ai_gateway_configured: !!(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_NAME),
        });
      }

      if (path === "/admin/settings" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const numericKeys: Record<string, [number, number]> = {
          daily_report_limit: [0, 10000],
          daily_search_limit: [0, 100000],
          cron_max_per_tick: [1, 20],
          // Worker-wide CPU + safety levers. Tavily knobs moved to per-
          // target columns (v11) so they're no longer here.
          max_chars_per_source: [200, 8000],
          max_run_seconds: [5, 600],
          writer_max_tokens: [200, 16000],
        };
        const updated: Record<string, string> = {};
        for (const [k, [lo, hi]] of Object.entries(numericKeys)) {
          if (form[k] !== undefined && form[k] !== "") {
            const n = parseInt(form[k], 10);
            if (!Number.isFinite(n) || n < lo || n > hi) {
              return json({ error: `${k} must be ${lo}–${hi}` }, { status: 400 });
            }
            await setSetting(env, k, String(n));
            updated[k] = String(n);
          }
        }
        if (form.chat_model !== undefined && form.chat_model !== "") {
          if (!isAllowedChatModel(form.chat_model)) {
            return json({ error: "chat_model must be one of the supported models" }, { status: 400 });
          }
          await setSetting(env, "chat_model", form.chat_model);
          updated.chat_model = form.chat_model;
        }
        // Global day-map default (v14): per-target day_map_enabled=NULL inherits
        // this. Sent as a <select> (always present, value "on"/"off") — keep it
        // a select, not a checkbox: an unchecked checkbox is absent from
        // FormData, so "off" could never be saved.
        if (form.day_map_enabled !== undefined) {
          const on = form.day_map_enabled === "on" || form.day_map_enabled === "true" || form.day_map_enabled === "1";
          await setSetting(env, "day_map_enabled", on ? "on" : "off");
          updated.day_map_enabled = on ? "on" : "off";
        }
        return json({ ok: true, updated });
      }

      // Manually trigger a cron tick (testing aid).
      if (path === "/admin/cron/tick" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const res = await cronTick(env);
        return json({ ok: true, ...res });
      }

      // Sweep R2 blobs not referenced by any reports.r2_key.
      if (path === "/admin/storage/gc" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const res = await gcOrphanedR2(env);
        return json({ ok: true, ...res });
      }

      // Re-embed every report in D1 and upsert into Vectorize. Idempotent.
      if (path === "/admin/memory/backfill" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const res = await backfillMemory(env);
        return json({ ok: true, ...res });
      }

      return new Response("Not found", withSecurityHeaders({ status: 404 }));
    } catch (e: any) {
      if (e instanceof BudgetExceeded) {
        return json(
          {
            error: "budget exhausted",
            kind: e.kind,
            limit: e.limit,
            used: e.used,
            message: `Daily ${e.kind} budget is used up (${e.used}/${e.limit}). Raise the limit from the admin panel or wait until tomorrow.`,
          },
          { status: 429 },
        );
      }
      console.error("fetch error:", e);
      return new Response(
        "Server error: " + (e?.message ?? "unknown"),
        withSecurityHeaders({ status: 500 }),
      );
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const res = await cronTick(env);
          console.log("cron tick", res);
        } catch (e) {
          console.error("scheduled run failed:", e);
        }
      })(),
    );
  },
};
