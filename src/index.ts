// WatchOMacho — Worker entry point.
// Two responsibilities: handle HTTP requests, run the agent on cron.

import { learnOnce, ask, type Env } from "./agent";
import {
  renderDashboard,
  renderNotePage,
  renderAdminLogin,
  renderAdminPanel,
} from "./dashboard";

// ─── helpers ────────────────────────────────────────────────────────────────

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) },
  });
}

function json(data: any, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
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

// ─── Worker ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // Public
      if (path === "/" && req.method === "GET") {
        return html(await renderDashboard(env));
      }

      if (path.startsWith("/note/") && req.method === "GET") {
        const id = path.slice("/note/".length);
        return html(await renderNotePage(env, id));
      }

      if (path === "/api/journey" && req.method === "GET") {
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 100);
        const rows = await env.DB.prepare(
          "SELECT id, title, place, country, lat, lon, snippet, source_url, created_at FROM notes ORDER BY created_at DESC LIMIT ?",
        ).bind(limit).all();
        return json({ notes: rows.results ?? [] });
      }

      if (path === "/api/stats" && req.method === "GET") {
        const stats = await env.DB.prepare(
          "SELECT COUNT(*) as notes, COUNT(DISTINCT country) as countries, MAX(created_at) as last_visit, COALESCE(SUM(word_count), 0) as words FROM notes",
        ).first<any>();
        return json(stats ?? {});
      }

      // Admin
      if (path === "/admin/login" && req.method === "GET") {
        return html(renderAdminLogin());
      }

      if (path === "/admin/login" && req.method === "POST") {
        const form = await req.formData();
        const secret = String(form.get("secret") ?? "");
        if (!env.ADMIN_SECRET || !timingSafeEqual(secret, env.ADMIN_SECRET)) {
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

      if (path === "/admin" && req.method === "GET") {
        if (!isAdmin(req, env)) return redirect("/admin/login");
        return html(await renderAdminPanel(env));
      }

      if (path === "/admin/run" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await req.formData();
        const prompt = String(form.get("prompt") ?? "").trim();
        const result = await learnOnce(env, prompt ? "prompt" : "manual", prompt || undefined);
        return redirect(`/note/${result.noteId}`);
      }

      if (path === "/admin/ask" && req.method === "POST") {
        if (!isAdmin(req, env)) return json({ error: "unauthorized" }, { status: 401 });
        const form = await req.formData();
        const q = String(form.get("question") ?? "").trim();
        if (!q) return json({ error: "no question" }, { status: 400 });
        const result = await ask(env, q);
        return json(result);
      }

      return new Response("Not found", { status: 404 });
    } catch (e: any) {
      console.error("fetch error:", e);
      return new Response("Server error: " + (e?.message ?? "unknown"), { status: 500 });
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      learnOnce(env, "cron").catch((e) => {
        console.error("cron run failed:", e);
      }),
    );
  },
};
