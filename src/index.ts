// WatchOMacho — Worker entry point.
// Two responsibilities: handle HTTP requests, run the agent on cron.

import {
  learnOnce,
  ask,
  startExploration,
  advanceExploration,
  getSetting,
  setSetting,
  getDailyUsage,
  scanLiveFeeds,
  addSubscription,
  listSubscriptions,
  deleteSubscription,
  setSubscriptionActive,
  BudgetExceeded,
  type Env,
} from "./agent";
import {
  renderDashboard,
  renderNotePage,
  renderAdminLogin,
  renderAdminPanel,
} from "./dashboard";

// ─── helpers ────────────────────────────────────────────────────────────────

// Security headers added to every response. CSP is permissive enough to allow
// Leaflet from unpkg + OpenStreetMap tiles + Google Fonts (the only externals
// the dashboard pulls), but blocks everything else. Inline scripts/styles are
// allowed because the dashboard is server-rendered HTML with inline CSS/JS.
const SECURITY_HEADERS: Record<string, string> = {
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), camera=(), microphone=()",
  "content-security-policy": [
    "default-src 'self'",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
    "font-src 'self' https://fonts.gstatic.com",
    "script-src 'self' 'unsafe-inline' https://unpkg.com",
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

/** Accept either form-encoded or JSON bodies, gracefully. */
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

const ALLOWED_FREQUENCY_HOURS = new Set([1, 2, 3, 6, 12, 24]);

// Login throttle: max LOGIN_MAX failed attempts per IP in the rolling window,
// otherwise the endpoint refuses the secret-check entirely. Successful logins
// still bypass nothing — but the secret is 256 random bits so a 10/10m cap is
// generous yet kills typo-storm and credential-stuffing patterns.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILED = 10;

function clientIp(req: Request): string {
  // Cloudflare populates this header on every request that touches the edge.
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

async function pruneLogins(env: Env): Promise<void> {
  const cutoff = Date.now() - LOGIN_WINDOW_MS * 6; // keep ~1 hour of history
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

// ─── Worker ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ─── Public ──────────────────────────────────────────────────────────
      if (path === "/" && req.method === "GET") {
        return html(await renderDashboard(env));
      }

      if (path.startsWith("/note/") && req.method === "GET") {
        const id = path.slice("/note/".length);
        return html(await renderNotePage(env, id));
      }

      if (path === "/api/journey" && req.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 200);
        const rows = await env.DB.prepare(
          "SELECT id, title, place, country, lat, lon, snippet, source, source_url, created_at FROM notes ORDER BY created_at DESC LIMIT ?",
        )
          .bind(limit)
          .all();
        return json({ notes: rows.results ?? [] });
      }

      if (path === "/api/stats" && req.method === "GET") {
        const stats = await env.DB.prepare(
          "SELECT COUNT(*) as notes, COUNT(DISTINCT country) as countries, MAX(created_at) as last_visit, COALESCE(SUM(word_count), 0) as words FROM notes",
        ).first<any>();
        return json(stats ?? {});
      }

      if (path === "/api/connections" && req.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);
        const rows = await env.DB.prepare(
          "SELECT from_note_id, to_note_id, kind, score FROM connections ORDER BY created_at DESC LIMIT ?",
        )
          .bind(limit)
          .all();
        return json({ edges: rows.results ?? [] });
      }

      // ─── Admin: auth ─────────────────────────────────────────────────────
      if (path === "/admin/login" && req.method === "GET") {
        return html(renderAdminLogin());
      }

      if (path === "/admin/login" && req.method === "POST") {
        const ip = clientIp(req);
        if (await loginTooManyFailures(env, ip)) {
          // Hold the line — don't even check the secret.
          return html(
            renderAdminLogin("Too many failed attempts. Wait ten minutes."),
            { status: 429 },
          );
        }
        const form = await readForm(req);
        const secret = form.secret ?? "";
        const okSecret = !!env.ADMIN_SECRET && timingSafeEqual(secret, env.ADMIN_SECRET);
        await recordLogin(env, ip, okSecret);
        if (!okSecret) {
          // Opportunistically prune ancient rows so the table doesn't grow.
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
        // Opportunistically pump any in-flight mission forward. The cron also
        // does this hourly, but admin pageloads should make progress feel
        // immediate rather than ticking once an hour.
        ctx.waitUntil(
          (async () => {
            const stuck = await env.DB.prepare(
              "SELECT id FROM explorations WHERE status IN ('in_progress', 'synthesizing') ORDER BY created_at ASC LIMIT 1",
            ).first<{ id: string }>();
            if (stuck?.id) {
              for (let i = 0; i < 3; i++) {
                const more = await advanceExploration(env, stuck.id).catch(() => false);
                if (!more) break;
              }
            }
          })(),
        );
        return html(await renderAdminPanel(env));
      }

      if (path === "/admin/run" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const prompt = (form.prompt ?? "").trim();
        const result = await learnOnce(env, prompt ? "prompt" : "manual", prompt || undefined);
        return redirect(`/note/${result.noteId}`);
      }

      if (path === "/admin/ask" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const q = (form.question ?? "").trim();
        if (!q) return json({ error: "no question" }, { status: 400 });
        const result = await ask(env, q);
        return json(result);
      }

      // Explorations — multi-step research missions.
      if (path === "/admin/explore" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const brief = (form.brief ?? "").trim();
        const steps = parseInt(form.steps ?? "4", 10) || 4;
        if (!brief) return json({ error: "no brief" }, { status: 400 });

        const planned = await startExploration(env, brief, steps);
        ctx.waitUntil(
          (async () => {
            for (let i = 0; i < planned.plan.length + 1; i++) {
              const more = await advanceExploration(env, planned.id).catch((e) => {
                console.error("explore step failed", e);
                return false;
              });
              if (!more) break;
            }
          })(),
        );
        return json({ id: planned.id, plan: planned.plan, total_steps: planned.plan.length });
      }

      if (path === "/admin/explorations" && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const rows = await env.DB.prepare(
          "SELECT id, brief, status, current_step, total_steps, synthesis_note_id, error, created_at, updated_at, completed_at FROM explorations ORDER BY created_at DESC LIMIT 25",
        ).all<any>();
        return json({ explorations: rows.results ?? [] });
      }

      // Frequency + strategy settings.
      if (path === "/admin/settings" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const updated: Record<string, string> = {};

        if (form.frequency_hours) {
          const n = parseInt(form.frequency_hours, 10);
          if (!ALLOWED_FREQUENCY_HOURS.has(n)) {
            return json({ error: "frequency must be 1, 2, 3, 6, 12, or 24" }, { status: 400 });
          }
          await setSetting(env, "frequency_hours", String(n));
          updated.frequency_hours = String(n);
        }
        if (form.topic_strategy) {
          const s = form.topic_strategy;
          if (!["mixed", "random", "bridge", "gap", "digest"].includes(s)) {
            return json({ error: "invalid strategy" }, { status: 400 });
          }
          await setSetting(env, "topic_strategy", s);
          updated.topic_strategy = s;
        }
        if (form.digest_match_threshold !== undefined && form.digest_match_threshold !== "") {
          const n = parseFloat(form.digest_match_threshold);
          if (!Number.isFinite(n) || n < 0 || n > 1) {
            return json({ error: "digest_match_threshold must be 0–1" }, { status: 400 });
          }
          await setSetting(env, "digest_match_threshold", String(n));
          updated.digest_match_threshold = String(n);
        }
        // Budget limits. 0 disables the gate for that kind; we clamp at 10000
        // to avoid a runaway typo (e.g. 999999) draining neurons.
        const budgetKeys: Record<string, string> = {
          daily_note_limit: "daily_note_limit",
          daily_ask_limit: "daily_ask_limit",
          daily_mission_limit: "daily_mission_limit",
        };
        for (const [field, key] of Object.entries(budgetKeys)) {
          if (form[field] !== undefined && form[field] !== "") {
            const n = parseInt(form[field], 10);
            if (!Number.isFinite(n) || n < 0 || n > 10000) {
              return json({ error: `${field} must be 0–10000` }, { status: 400 });
            }
            await setSetting(env, key, String(n));
            updated[field] = String(n);
          }
        }
        return json({ ok: true, updated });
      }

      if (path === "/admin/settings" && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const [freq, strat, last, noteLim, askLim, missLim, threshold] = await Promise.all([
          getSetting(env, "frequency_hours", "6"),
          getSetting(env, "topic_strategy", "mixed"),
          getSetting(env, "last_cron_run", "0"),
          getSetting(env, "daily_note_limit", "30"),
          getSetting(env, "daily_ask_limit", "100"),
          getSetting(env, "daily_mission_limit", "5"),
          getSetting(env, "digest_match_threshold", "0.45"),
        ]);
        return json({
          frequency_hours: freq,
          topic_strategy: strat,
          last_cron_run: Number(last) || 0,
          next_cron_run: (Number(last) || 0) + Number(freq) * 3600 * 1000,
          daily_note_limit: Number(noteLim),
          daily_ask_limit: Number(askLim),
          daily_mission_limit: Number(missLim),
          digest_match_threshold: Number(threshold),
        });
      }

      // Subscriptions (interest topics) for digest mode.
      if (path === "/admin/subscriptions" && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const subs = await listSubscriptions(env);
        return json({ subscriptions: subs });
      }

      if (path === "/admin/subscriptions" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await readForm(req);
        const topic = (form.topic ?? "").trim();
        if (!topic) return json({ error: "topic required" }, { status: 400 });
        if (topic.length > 200) return json({ error: "topic must be <= 200 chars" }, { status: 400 });
        try {
          const sub = await addSubscription(env, topic);
          return json({ ok: true, subscription: sub });
        } catch (e: any) {
          return json({ error: String(e?.message ?? e) }, { status: 400 });
        }
      }

      if (path.startsWith("/admin/subscriptions/") && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const rest = path.slice("/admin/subscriptions/".length);
        const [id, action] = rest.split("/");
        if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
          return json({ error: "invalid id" }, { status: 400 });
        }
        if (action === "delete") {
          await deleteSubscription(env, id);
          return json({ ok: true });
        }
        if (action === "toggle") {
          const form = await readForm(req);
          const active = form.active === "1" || form.active === "true";
          await setSubscriptionActive(env, id, active);
          return json({ ok: true, active });
        }
        return json({ error: "unknown action" }, { status: 400 });
      }

      // Trigger one digest scan on-demand (useful for testing without waiting
      // for the next cron tick). Budget gates still apply per-write.
      if (path === "/admin/digest/scan" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const res = await scanLiveFeeds(env);
        return json({ ok: true, ...res });
      }

      if (path === "/admin/usage" && req.method === "GET") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const usage = await getDailyUsage(env);
        const [noteLim, askLim, missLim] = await Promise.all([
          getSetting(env, "daily_note_limit", "30"),
          getSetting(env, "daily_ask_limit", "100"),
          getSetting(env, "daily_mission_limit", "5"),
        ]);
        return json({
          ...usage,
          limits: {
            notes: Number(noteLim),
            asks: Number(askLim),
            missions: Number(missLim),
          },
        });
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
          // 1. Pump any in-progress explorations forward by one step each.
          const stuck = await env.DB.prepare(
            "SELECT id FROM explorations WHERE status IN ('in_progress', 'synthesizing') ORDER BY created_at ASC LIMIT 3",
          ).all<{ id: string }>();
          for (const row of stuck.results ?? []) {
            await advanceExploration(env, row.id).catch((e) =>
              console.error("cron exploration pump failed", row.id, e),
            );
          }

          // 2. Decide whether to run learnOnce based on the configured frequency.
          const strategy = await getSetting(env, "topic_strategy", "mixed");
          const freqHours = parseInt(await getSetting(env, "frequency_hours", "6"), 10) || 6;
          const last = parseInt(await getSetting(env, "last_cron_run", "0"), 10) || 0;
          const now = Date.now();
          if (now - last < freqHours * 3600 * 1000) return;

          if (strategy === "digest") {
            // Interest-monitor mode: scan live feeds, write only when something
            // matches an active subscription. Daily-notes budget still applies
            // inside runStep, so a quiet day costs nothing.
            const res = await scanLiveFeeds(env).catch((e) => {
              console.error("digest scan failed", e);
              return { scanned: 0, matched: 0, written: 0, skipped_seen: 0 };
            });
            console.log("digest tick", res);
          } else {
            await learnOnce(env, "cron");
          }
          await setSetting(env, "last_cron_run", String(now));
        } catch (e) {
          console.error("scheduled run failed:", e);
        }
      })(),
    );
  },
};
