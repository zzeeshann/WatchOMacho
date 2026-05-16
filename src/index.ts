// WatchOMacho — Worker entry point.
// HTTP routes + cron handler. Business logic lives in agent.ts.

import {
  ALLOWED_CHAT_MODELS,
  BudgetExceeded,
  DEFAULT_CHAT_MODEL,
  cronTick,
  createSkillFromMarkdown,
  createTarget,
  deleteSkill,
  deleteTarget,
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
  runMission,
  runResearch,
  setSetting,
  synthesizeSkill,
  updateSkill,
  updateTarget,
  type Env,
  type Skill,
  type Target,
} from "./agent";
import {
  renderAdminLogin,
  renderAdminPanel,
  renderAdminSkills,
  renderAdminTargetEdit,
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

      // ─── Public JSON API ─────────────────────────────────────────────────
      if (path === "/api/targets" && req.method === "GET") {
        const targets = await listTargets(env, "active");
        return json({ targets });
      }

      if (path === "/api/skills" && req.method === "GET") {
        const skills = await listSkills(env);
        return json({
          skills: skills.map((s) => ({
            id: s.id, slug: s.slug, name: s.name, description: s.description,
            author: s.author, used_count: s.used_count,
            created_at: s.created_at, updated_at: s.updated_at,
          })),
        });
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

      if (path.startsWith("/admin/targets/") && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        const slug = path.slice("/admin/targets/".length);
        if (!validSlug(slug)) {
          return new Response("Bad slug", withSecurityHeaders({ status: 400 }));
        }
        return html(await renderAdminTargetEdit(env, slug));
      }

      // Targets: create / update / delete
      if (path === "/admin/targets" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const name = (form.name ?? "").trim();
        if (!name) return json({ error: "name required" }, { status: 400 });
        const cadence = parseInt(form.cadence_hours ?? "24", 10);
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
        });
        // If the form asked for an immediate run, kick one off in the background.
        if (form.run_now === "1" && skillId) {
          const sk = await getSkillById(env, skillId);
          if (sk) {
            ctx.waitUntil(
              runResearch(env, target, sk, "manual").catch((e) => console.error("first run failed", e)),
            );
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
        if (form.cadence_hours !== undefined) {
          const n = parseInt(form.cadence_hours, 10);
          if (Number.isFinite(n)) patch.cadence_hours = n;
        }
        if (form.skill_slug !== undefined) {
          if (form.skill_slug.trim()) {
            const sk = await getSkillBySlug(env, form.skill_slug.trim());
            if (sk) patch.primary_skill_id = sk.id;
          } else {
            patch.primary_skill_id = null as any;
          }
        }
        await updateTarget(env, target.id, patch);
        return redirect(`/admin/targets/${target.slug}`);
      }

      if (path.startsWith("/admin/targets/") && path.endsWith("/run") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/targets/".length, path.length - "/run".length);
        const target = await getTargetBySlug(env, slug);
        if (!target) return json({ error: "not found" }, { status: 404 });
        if (!target.primary_skill_id) return json({ error: "no skill attached" }, { status: 400 });
        const skill = await getSkillById(env, target.primary_skill_id);
        if (!skill) return json({ error: "skill missing" }, { status: 400 });
        ctx.waitUntil(
          runResearch(env, target, skill, "manual").catch((e) => console.error("manual run failed", e)),
        );
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

      // Skills: create / update / delete
      if (path === "/admin/skills" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const mode = (form.mode ?? "write").trim();
        if (mode === "synthesize") {
          const brief = (form.brief ?? "").trim();
          if (!brief) return json({ error: "brief required" }, { status: 400 });
          const skill = await synthesizeSkill(env, { brief, name: form.name?.trim() });
          return redirect(`/admin/skills?focus=${encodeURIComponent(skill.slug)}`);
        }
        const name = (form.name ?? "").trim();
        const md = (form.procedure_md ?? "").trim();
        if (!name) return json({ error: "name required" }, { status: 400 });
        if (md.length < 30) return json({ error: "procedure_md too short" }, { status: 400 });
        const skill = await createSkillFromMarkdown(env, {
          name,
          description: form.description?.trim() || undefined,
          procedure_md: md,
        });
        return redirect(`/admin/skills?focus=${encodeURIComponent(skill.slug)}`);
      }

      if (path.startsWith("/admin/skills/") && path.endsWith("/update") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/skills/".length, path.length - "/update".length);
        const skill = await getSkillBySlug(env, slug);
        if (!skill) return json({ error: "not found" }, { status: 404 });
        const form = await readForm(req);
        await updateSkill(env, skill.id, {
          name: form.name?.trim() || undefined,
          description: form.description?.trim(),
          procedure_md: form.procedure_md?.trim() || undefined,
        });
        return redirect(`/admin/skills?focus=${encodeURIComponent(skill.slug)}`);
      }

      if (path.startsWith("/admin/skills/") && path.endsWith("/delete") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const slug = path.slice("/admin/skills/".length, path.length - "/delete".length);
        const skill = await getSkillBySlug(env, slug);
        if (skill) await deleteSkill(env, skill.id);
        return redirect("/admin/skills");
      }

      // Missions: one-shot user instructions
      if (path === "/admin/mission" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const brief = (form.brief ?? "").trim();
        if (!brief) return json({ error: "brief required" }, { status: 400 });
        try {
          const result = await runMission(env, {
            brief,
            target_slug: form.target_slug?.trim() || undefined,
            skill_slug: form.skill_slug?.trim() || undefined,
            new_target_name: form.new_target_name?.trim() || undefined,
            new_skill_brief: form.new_skill_brief?.trim() || undefined,
          });
          return json({
            ok: true,
            target_slug: result.target.slug,
            skill_slug: result.skill.slug,
            report_id: result.report.id,
            report_title: result.report.title,
          });
        } catch (e: any) {
          if (e instanceof BudgetExceeded) throw e;
          return json({ error: String(e?.message ?? e) }, { status: 400 });
        }
      }

      // Settings
      if (path === "/admin/settings" && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const [reportLim, searchLim, perTick, lastCron, chatModel] = await Promise.all([
          getSetting(env, "daily_report_limit", "20"),
          getSetting(env, "daily_search_limit", "500"),
          getSetting(env, "cron_max_per_tick", "2"),
          getSetting(env, "last_cron_run", "0"),
          getChatModel(env),
        ]);
        const usage = await getDailyUsage(env);
        return json({
          daily_report_limit: Number(reportLim),
          daily_search_limit: Number(searchLim),
          cron_max_per_tick: Number(perTick),
          last_cron_run: Number(lastCron),
          chat_model: chatModel,
          allowed_chat_models: ALLOWED_CHAT_MODELS,
          usage,
          brave_api_key_set: !!env.BRAVE_API_KEY,
        });
      }

      if (path === "/admin/settings" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const numericKeys: Record<string, [number, number]> = {
          daily_report_limit: [0, 10000],
          daily_search_limit: [0, 100000],
          cron_max_per_tick: [1, 20],
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
        return json({ ok: true, updated });
      }

      // Manually trigger a cron tick (testing aid).
      if (path === "/admin/cron/tick" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const res = await cronTick(env);
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
