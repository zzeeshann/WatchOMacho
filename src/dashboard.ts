// All HTML rendering. Server-rendered, no client framework. Styled to match
// daylila.com — DM Sans, warm off-white paper, forest-teal primary, restrained
// editorial layout.
//
// Public pages:    /  /target/:slug  /skill/:slug  /report/:id
// Admin pages:     /admin  /admin/skills  /admin/targets/:slug  /admin/login

import {
  getDailyUsage,
  getReportById,
  getSetting,
  getSkillBySlug,
  getTargetBySlug,
  listReportsForTarget,
  listSkills,
  listTargets,
  type Env,
  type Report,
  type Skill,
  type Target,
} from "./agent";

// ─────────────────────────────────────────────────────────────────────────────
// Design tokens — matches daylila.com
// ─────────────────────────────────────────────────────────────────────────────

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
`;

const BASE_CSS = `
:root {
  --zee-bg: rgb(250, 248, 244);
  --zee-text: rgb(26, 26, 26);
  --zee-primary: rgb(26, 107, 98);
  --zee-muted: rgb(107, 107, 107);
  --zee-gold: rgb(196, 154, 26);
  --zee-border: rgb(232, 228, 222);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: var(--zee-bg);
  color: var(--zee-text);
  font-family: 'DM Sans', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
body {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.wrap {
  width: 100%;
  max-width: 768px;
  margin: 0 auto;
  padding: 0 24px;
}
a { color: inherit; text-decoration: none; }
.tt { font-variant-numeric: tabular-nums; }

/* shared header */
.site-header {
  padding: 32px 0 16px;
}
.site-header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--zee-primary);
}
.brand:hover { opacity: 0.8; }
.nav {
  display: flex;
  align-items: center;
  gap: 16px;
}
.nav a {
  font-size: 13px;
  color: var(--zee-muted);
  transition: color 0.15s;
}
.nav a:hover { color: var(--zee-primary); }
.nav a.active { color: var(--zee-text); }

/* category labels (the daylila "TODAY" pill) */
.label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--zee-gold);
}
.label-muted {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--zee-muted);
}

/* large editorial headlines */
.headline {
  font-size: clamp(28px, 5vw, 44px);
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1.08;
}
.subhead {
  font-size: 18px;
  color: var(--zee-muted);
  margin-top: 16px;
  line-height: 1.5;
  max-width: 60ch;
}

/* the recent-pieces list, daylila style */
.divider { border-top: 1px solid var(--zee-border); }
.piece {
  display: flex;
  flex-direction: column;
  padding: 18px 0;
  border-bottom: 1px solid rgba(232, 228, 222, 0.6);
  transition: opacity 0.15s;
}
.piece-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
@media (min-width: 640px) {
  .piece-row {
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    gap: 24px;
  }
}
.piece-title {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.35;
}
.piece:hover .piece-title { color: var(--zee-primary); }
.piece-arrow { color: var(--zee-primary); font-weight: 400; margin-left: 4px; }
.piece-meta {
  font-size: 12px;
  color: var(--zee-muted);
  margin-top: 4px;
}
.piece-date {
  font-size: 12px;
  color: var(--zee-muted);
  white-space: nowrap;
}

/* footer */
footer {
  width: 100%;
  max-width: 768px;
  margin: 64px auto 32px;
  padding: 32px 24px 0;
  border-top: 1px solid rgba(232, 228, 222, 0.5);
  text-align: center;
}
footer p { font-size: 13px; color: var(--zee-muted); font-style: italic; }
footer p.tiny { font-size: 11px; color: rgba(107,107,107,0.7); margin-top: 6px; font-style: normal; }

/* forms (admin) */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}
.field label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--zee-muted);
}
.field input, .field select, .field textarea {
  font-family: inherit;
  font-size: 15px;
  padding: 10px 12px;
  background: white;
  border: 1px solid var(--zee-border);
  color: var(--zee-text);
  border-radius: 4px;
}
.field textarea { min-height: 140px; resize: vertical; line-height: 1.5; }
.field input:focus, .field select:focus, .field textarea:focus {
  outline: none; border-color: var(--zee-primary);
}
.field-help { font-size: 12px; color: var(--zee-muted); }
.btn {
  display: inline-block;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  padding: 10px 18px;
  background: var(--zee-primary);
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.btn:hover { opacity: 0.9; }
.btn-secondary {
  background: white;
  color: var(--zee-text);
  border: 1px solid var(--zee-border);
}
.btn-secondary:hover { border-color: var(--zee-primary); color: var(--zee-primary); }
.btn-danger { background: white; color: rgb(180, 60, 60); border: 1px solid rgb(220, 180, 180); }
.btn-danger:hover { background: rgb(180, 60, 60); color: white; }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }

/* cards (admin overview tiles) */
.card {
  background: white;
  border: 1px solid var(--zee-border);
  border-radius: 4px;
  padding: 20px 24px;
  margin-bottom: 16px;
}
.card h3 {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 12px;
}
.card .h3-row {
  display: flex; justify-content: space-between; align-items: baseline;
  margin-bottom: 12px;
}

/* stats strip */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin: 24px 0 8px;
}
.stat .n {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--zee-text);
}
.stat .l {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--zee-muted);
  margin-top: 4px;
}
@media (max-width: 600px) {
  .stats { grid-template-columns: repeat(2, 1fr); }
}

.empty {
  padding: 40px 24px;
  text-align: center;
  color: var(--zee-muted);
  font-style: italic;
  border: 1px dashed var(--zee-border);
  border-radius: 4px;
}

/* report body — DM Sans editorial reading */
.prose {
  font-size: 17px;
  line-height: 1.65;
  color: var(--zee-text);
}
.prose h1, .prose h2, .prose h3 {
  font-weight: 700;
  letter-spacing: -0.015em;
  margin: 32px 0 12px;
  line-height: 1.2;
}
.prose h1 { font-size: 28px; }
.prose h2 { font-size: 22px; }
.prose h3 { font-size: 18px; }
.prose p { margin: 14px 0; }
.prose a { color: var(--zee-primary); border-bottom: 1px solid rgba(26,107,98,0.3); }
.prose a:hover { border-bottom-color: var(--zee-primary); }
.prose ul, .prose ol { margin: 14px 0 14px 22px; }
.prose li { margin: 6px 0; }
.prose code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  background: var(--zee-border);
  padding: 1px 6px;
  border-radius: 3px;
}
.prose blockquote {
  border-left: 3px solid var(--zee-primary);
  padding-left: 16px;
  color: var(--zee-muted);
  margin: 16px 0;
  font-style: italic;
}

/* badge */
.badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  padding: 2px 8px;
  border-radius: 3px;
}
.badge-active { background: rgba(26,107,98,0.1); color: var(--zee-primary); }
.badge-paused { background: rgba(196,154,26,0.15); color: var(--zee-gold); }
.badge-archived { background: var(--zee-border); color: var(--zee-muted); }
.badge-agent { background: rgba(26,107,98,0.08); color: var(--zee-primary); }
.badge-user { background: rgba(196,154,26,0.12); color: var(--zee-gold); }
.badge-error { background: rgba(180,60,60,0.1); color: rgb(180,60,60); }

table.runs { width: 100%; border-collapse: collapse; }
table.runs th, table.runs td {
  padding: 10px 8px;
  text-align: left;
  font-size: 13px;
  border-bottom: 1px solid rgba(232,228,222,0.6);
}
table.runs th { font-weight: 600; color: var(--zee-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(ts);
}

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

/** Minimal, safe markdown → HTML. Supports h1/h2/h3, paragraphs, links,
 *  bold, italic, inline code, lists. No HTML injection. */
function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let inUl = false;
  let inOl = false;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const joined = para.join(" ").trim();
    if (joined) html += `<p>${inline(joined)}</p>\n`;
    para = [];
  };
  const flushList = () => {
    if (inUl) { html += "</ul>\n"; inUl = false; }
    if (inOl) { html += "</ol>\n"; inOl = false; }
  };

  const inline = (s: string): string => {
    let r = escapeHtml(s);
    r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
    r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/(^|[^\*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    // markdown links [text](url) — only allow http(s) and relative
    r = r.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
      const safe = /^(https?:\/\/|\/)/.test(url) ? url : "#";
      const ext = safe.startsWith("http") ? ' target="_blank" rel="noopener"' : "";
      return `<a href="${escapeHtml(safe)}"${ext}>${text}</a>`;
    });
    return r;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    const h1 = line.match(/^#\s+(.*)$/);
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h1 || h2 || h3) {
      flushPara(); flushList();
      const tag = h1 ? "h1" : h2 ? "h2" : "h3";
      const text = (h1?.[1] ?? h2?.[1] ?? h3?.[1] ?? "").trim();
      html += `<${tag}>${inline(text)}</${tag}>\n`;
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!inUl) { flushList(); html += "<ul>\n"; inUl = true; }
      html += `<li>${inline(ul[1])}</li>\n`;
      continue;
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!inOl) { flushList(); html += "<ol>\n"; inOl = true; }
      html += `<li>${inline(ol[1])}</li>\n`;
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page shells
// ─────────────────────────────────────────────────────────────────────────────

function shell(title: string, body: string, opts: { activeNav?: string; adminFooter?: boolean } = {}): string {
  const isAdmin = opts.adminFooter === true;
  const navLink = (href: string, label: string, key: string) =>
    `<a href="${href}"${opts.activeNav === key ? ' class="active"' : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${FONTS}
<style>${BASE_CSS}</style>
</head>
<body>
<header class="site-header">
  <div class="wrap site-header-inner">
    <a href="/" class="brand">WatchOMacho</a>
    <nav class="nav">
      ${navLink("/", "Targets", "home")}
      ${isAdmin ? `${navLink("/admin", "Admin", "admin")} ${navLink("/admin/skills", "Skills", "skills")} <form method="post" action="/admin/logout" style="display:inline;margin-left:8px"><button class="btn btn-secondary" style="padding:4px 10px;font-size:11px">Logout</button></form>` : navLink("/admin/login", "Admin", "admin")}
    </nav>
  </div>
</header>
<main class="wrap" style="flex:1;padding:8px 24px 16px">
${body}
</main>
<footer>
  <p>An agent that researches what you tell it to research.</p>
  <p class="tiny">© ${new Date().getFullYear()} WatchOMacho · runs on Cloudflare</p>
</footer>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: home — list of active targets
// ─────────────────────────────────────────────────────────────────────────────

export async function renderHome(env: Env): Promise<string> {
  const active = await listTargets(env, "active");

  // For each, grab the latest report so we can show its title + date.
  const enriched = await Promise.all(
    active.slice(0, 50).map(async (t) => {
      const reports = await listReportsForTarget(env, t.id, 1);
      return { target: t, latest: reports[0] ?? null };
    }),
  );

  const totalReportsRow = await env.DB.prepare("SELECT COUNT(*) as n FROM reports").first<{ n: number }>();
  const totalSkillsRow = await env.DB.prepare("SELECT COUNT(*) as n FROM skills").first<{ n: number }>();
  const lastReportRow = await env.DB.prepare("SELECT MAX(created_at) as t FROM reports").first<{ t: number | null }>();

  const stats = `
    <section class="stats">
      <div class="stat"><div class="n tt">${active.length}</div><div class="l">Active targets</div></div>
      <div class="stat"><div class="n tt">${totalSkillsRow?.n ?? 0}</div><div class="l">Skills</div></div>
      <div class="stat"><div class="n tt">${totalReportsRow?.n ?? 0}</div><div class="l">Reports</div></div>
      <div class="stat"><div class="n tt">${lastReportRow?.t ? escapeHtml(timeAgo(lastReportRow.t)) : "—"}</div><div class="l">Last update</div></div>
    </section>
  `;

  let hero = "";
  if (enriched.length === 0) {
    hero = `
      <section style="padding:56px 0">
        <p class="label">Empty — for now</p>
        <h1 class="headline" style="margin-top:8px">No targets yet.</h1>
        <p class="subhead">Give the agent something to research. <a href="/admin/login" style="color:var(--zee-primary);border-bottom:1px solid currentColor">Open the admin</a>, add a target like <em>Bhutan</em> or <em>OpenAI</em>, attach a skill, and the agent will keep that target's page fresh.</p>
      </section>
    `;
  } else {
    const top = enriched[0];
    if (top.latest) {
      hero = `
        <section style="padding:32px 0 56px">
          <p class="label">Latest <span style="color:rgba(107,107,107,0.6);font-weight:400;text-transform:none;letter-spacing:normal;margin-left:6px">· ${escapeHtml(timeAgo(top.latest.created_at))}</span></p>
          <a href="/target/${escapeHtml(top.target.slug)}" style="display:block;margin-top:14px">
            <h1 class="headline">${escapeHtml(top.target.name)}</h1>
            <p class="subhead">${escapeHtml(top.latest.snippet)}</p>
            <p style="margin-top:20px;font-size:14px;font-weight:500;color:var(--zee-primary)">Open the target page <span aria-hidden="true">→</span></p>
          </a>
        </section>
      `;
    } else {
      hero = `
        <section style="padding:32px 0 56px">
          <p class="label">Newest target</p>
          <a href="/target/${escapeHtml(top.target.slug)}" style="display:block;margin-top:14px">
            <h1 class="headline">${escapeHtml(top.target.name)}</h1>
            <p class="subhead">No reports yet. ${top.target.primary_skill_id ? "First run is queued." : "Attach a skill to start producing reports."}</p>
          </a>
        </section>
      `;
    }
  }

  const list = enriched.slice(1).map(({ target, latest }) => `
    <a class="piece" href="/target/${escapeHtml(target.slug)}">
      <div class="piece-row">
        <div style="flex:1;min-width:0">
          <p class="piece-title">${escapeHtml(target.name)} <span class="piece-arrow" aria-hidden="true">→</span></p>
          <p class="piece-meta">${escapeHtml(latest?.title ?? target.description ?? (target.kind ?? "target"))}</p>
        </div>
        <span class="piece-date tt">${latest ? escapeHtml(timeAgo(latest.created_at)) : "no reports"}</span>
      </div>
    </a>
  `).join("");

  const body = `
    ${hero}
    ${stats}
    <section style="padding:32px 0 0">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <h2 class="label-muted">All targets</h2>
        <a href="/admin/login" style="font-size:13px;color:var(--zee-primary)">Add target →</a>
      </div>
      <div class="divider"></div>
      ${list || `<div class="empty" style="margin-top:16px">No other targets.</div>`}
    </section>
  `;

  return shell("WatchOMacho", body, { activeNav: "home" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: target page — accumulating reports
// ─────────────────────────────────────────────────────────────────────────────

export async function renderTargetPage(env: Env, slug: string): Promise<string> {
  const target = await getTargetBySlug(env, slug);
  if (!target) {
    return shell("Not found", `
      <section style="padding:80px 0;text-align:center">
        <p class="label">404</p>
        <h1 class="headline" style="margin-top:12px">No such target.</h1>
        <p class="subhead" style="margin-left:auto;margin-right:auto">It may have been renamed or archived. <a href="/" style="color:var(--zee-primary);border-bottom:1px solid currentColor">Back to the list</a>.</p>
      </section>
    `);
  }
  const reports = await listReportsForTarget(env, target.id, 30);
  const skill = target.primary_skill_id
    ? await env.DB.prepare("SELECT * FROM skills WHERE id = ?").bind(target.primary_skill_id).first<Skill>()
    : null;

  const meta = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:12px">
      <span class="badge badge-${target.status}">${target.status}</span>
      ${target.kind ? `<span class="label-muted">${escapeHtml(target.kind)}</span>` : ""}
      ${skill ? `<span class="label-muted">skill: <a href="/skill/${escapeHtml(skill.slug)}" style="color:var(--zee-primary)">${escapeHtml(skill.name)}</a></span>` : `<span class="label-muted">no skill attached</span>`}
      <span class="label-muted">every ${target.cadence_hours}h</span>
      ${target.next_run_at ? `<span class="label-muted">next ${escapeHtml(timeUntil(target.next_run_at))}</span>` : ""}
    </div>
  `;

  let body = `
    <section style="padding:32px 0 28px">
      <p class="label">Target</p>
      <h1 class="headline" style="margin-top:8px">${escapeHtml(target.name)}</h1>
      ${target.description ? `<p class="subhead">${escapeHtml(target.description)}</p>` : ""}
      ${meta}
    </section>
    <div class="divider"></div>
  `;

  if (reports.length === 0) {
    body += `
      <section style="padding:48px 0">
        <div class="empty">No reports yet. ${target.primary_skill_id ? "The agent will write the first one on the next cron tick (or hit \"Run now\" in the admin)." : "Attach a skill from the admin to start producing reports."}</div>
      </section>
    `;
  } else {
    body += `<section style="padding:8px 0">`;
    for (const r of reports) {
      body += `
        <a class="piece" href="/report/${escapeHtml(r.id)}">
          <div class="piece-row">
            <div style="flex:1;min-width:0">
              <p class="piece-title">${escapeHtml(r.title)} <span class="piece-arrow" aria-hidden="true">→</span></p>
              <p class="piece-meta">${escapeHtml(r.snippet)}</p>
            </div>
            <span class="piece-date tt">${escapeHtml(formatDate(r.created_at))}</span>
          </div>
        </a>
      `;
    }
    body += `</section>`;
  }

  return shell(`${target.name} — WatchOMacho`, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: skill page
// ─────────────────────────────────────────────────────────────────────────────

export async function renderSkillPage(env: Env, slug: string): Promise<string> {
  const skill = await getSkillBySlug(env, slug);
  if (!skill) {
    return shell("Not found", `
      <section style="padding:80px 0;text-align:center">
        <p class="label">404</p>
        <h1 class="headline" style="margin-top:12px">No such skill.</h1>
      </section>
    `);
  }
  const usedByRows = await env.DB.prepare(
    "SELECT slug, name, status FROM targets WHERE primary_skill_id = ? ORDER BY updated_at DESC",
  )
    .bind(skill.id)
    .all<{ slug: string; name: string; status: string }>();
  const usedBy = usedByRows.results ?? [];

  const body = `
    <section style="padding:32px 0 16px">
      <p class="label">Skill <span style="margin-left:8px"><span class="badge badge-${skill.author}">${skill.author}-written</span></span></p>
      <h1 class="headline" style="margin-top:8px">${escapeHtml(skill.name)}</h1>
      ${skill.description ? `<p class="subhead">${escapeHtml(skill.description)}</p>` : ""}
      <div style="margin-top:14px"><span class="label-muted">used ${skill.used_count} time${skill.used_count === 1 ? "" : "s"}</span></div>
    </section>
    <div class="divider"></div>
    <section class="prose" style="padding:32px 0">
      ${renderMarkdown(skill.procedure_md)}
    </section>
    <div class="divider"></div>
    <section style="padding:24px 0">
      <h2 class="label-muted">Used by</h2>
      ${usedBy.length === 0
        ? `<div class="empty" style="margin-top:12px">No targets are using this skill yet.</div>`
        : `<ul style="list-style:none;margin-top:12px">${usedBy.map((t) => `
            <li style="padding:8px 0;border-bottom:1px solid rgba(232,228,222,0.6)">
              <a href="/target/${escapeHtml(t.slug)}" style="color:var(--zee-text)">
                <strong style="font-weight:500">${escapeHtml(t.name)}</strong>
                <span class="badge badge-${t.status}" style="margin-left:8px">${t.status}</span>
              </a>
            </li>`).join("")}</ul>`}
    </section>
  `;
  return shell(`${skill.name} — Skill`, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: single report page
// ─────────────────────────────────────────────────────────────────────────────

export async function renderReportPage(env: Env, id: string): Promise<string> {
  const report = await getReportById(env, id);
  if (!report) {
    return shell("Not found", `
      <section style="padding:80px 0;text-align:center">
        <p class="label">404</p>
        <h1 class="headline" style="margin-top:12px">Report missing.</h1>
      </section>
    `);
  }
  const obj = await env.REPORTS.get(report.r2_key);
  const md = obj ? await obj.text() : `# ${report.title}\n\n${report.snippet}`;
  const target = await env.DB.prepare("SELECT slug, name FROM targets WHERE id = ?")
    .bind(report.target_id)
    .first<{ slug: string; name: string }>();
  const skill = report.skill_id
    ? await env.DB.prepare("SELECT slug, name FROM skills WHERE id = ?").bind(report.skill_id).first<{ slug: string; name: string }>()
    : null;

  // Strip leading H1 (we render title in our own header).
  const bodyMd = md.replace(/^# .+\n+/, "");
  const html = renderMarkdown(bodyMd);

  const body = `
    <section style="padding:32px 0 16px">
      <p class="label">${target ? `<a href="/target/${escapeHtml(target.slug)}" style="color:inherit">${escapeHtml(target.name)}</a>` : "Report"}</p>
      <h1 class="headline" style="margin-top:8px">${escapeHtml(report.title)}</h1>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:14px">
        <span class="label-muted">${escapeHtml(formatDate(report.created_at))}</span>
        ${skill ? `<span class="label-muted">skill: <a href="/skill/${escapeHtml(skill.slug)}" style="color:var(--zee-primary)">${escapeHtml(skill.name)}</a></span>` : ""}
        <span class="label-muted">${report.word_count ?? 0} words</span>
      </div>
    </section>
    <div class="divider"></div>
    <article class="prose" style="padding:32px 0">${html}</article>
  `;
  return shell(`${report.title} — WatchOMacho`, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: login
// ─────────────────────────────────────────────────────────────────────────────

export function renderAdminLogin(error?: string): string {
  const body = `
    <section style="max-width:380px;margin:48px auto;padding:32px 0">
      <p class="label">Admin</p>
      <h1 class="headline" style="margin-top:8px;font-size:32px">Unlock the agent.</h1>
      <form method="post" action="/admin/login" style="margin-top:28px">
        <div class="field">
          <label for="secret">Secret</label>
          <input id="secret" type="password" name="secret" autofocus autocomplete="off" required>
        </div>
        <button class="btn" type="submit" style="width:100%">Unlock</button>
        ${error ? `<p style="margin-top:12px;color:rgb(180,60,60);font-size:13px">${escapeHtml(error)}</p>` : ""}
      </form>
      <p style="margin-top:24px;text-align:center"><a href="/" style="font-size:12px;color:var(--zee-muted)">← back</a></p>
    </section>
  `;
  return shell("Admin · WatchOMacho", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: overview panel
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminPanel(env: Env): Promise<string> {
  const [targets, skills, usage, reportLim, searchLim, perTick] = await Promise.all([
    listTargets(env),
    listSkills(env),
    getDailyUsage(env),
    getSetting(env, "daily_report_limit", "20"),
    getSetting(env, "daily_search_limit", "500"),
    getSetting(env, "cron_max_per_tick", "2"),
  ]);

  const runRows = await env.DB.prepare(
    "SELECT * FROM runs ORDER BY created_at DESC LIMIT 12",
  ).all<any>();

  const skillOptions = skills.length === 0
    ? `<option value="">(no skills yet — create one below)</option>`
    : `<option value="">(none — attach later)</option>` + skills.map((s) =>
        `<option value="${escapeHtml(s.slug)}">${escapeHtml(s.name)}</option>`,
      ).join("");

  const targetOptions = targets.length === 0
    ? `<option value="">(no targets)</option>`
    : `<option value="">(let agent pick / create)</option>` + targets.map((t) =>
        `<option value="${escapeHtml(t.slug)}">${escapeHtml(t.name)}</option>`,
      ).join("");

  const active = targets.filter((t) => t.status === "active");
  const dueNow = active.filter((t) => t.next_run_at && t.next_run_at <= Date.now() && t.primary_skill_id);

  const targetRows = active.length === 0
    ? `<div class="empty">No targets yet. Add one above.</div>`
    : `<ul style="list-style:none">${active.map((t) => `
        <li style="padding:10px 0;border-bottom:1px solid rgba(232,228,222,0.6)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
            <a href="/admin/targets/${escapeHtml(t.slug)}" style="font-weight:500;color:var(--zee-text)">
              ${escapeHtml(t.name)}
              ${t.kind ? `<span class="label-muted" style="margin-left:8px">${escapeHtml(t.kind)}</span>` : ""}
            </a>
            <span class="tt" style="font-size:12px;color:var(--zee-muted)">
              ${t.next_run_at ? (t.next_run_at <= Date.now() ? `<span style="color:var(--zee-primary)">due now</span>` : escapeHtml(timeUntil(t.next_run_at))) : "—"}
              · every ${t.cadence_hours}h
            </span>
          </div>
        </li>`).join("")}</ul>`;

  const runsHtml = (runRows.results ?? []).map((r: any) => `
    <tr>
      <td class="tt">${escapeHtml(timeAgo(r.created_at))}</td>
      <td>${escapeHtml(r.triggered_by)}</td>
      <td>${r.status === "success"
            ? `<span class="badge badge-active">success</span>`
            : `<span class="badge badge-error">${escapeHtml(r.error ?? "error").slice(0, 80)}</span>`}</td>
      <td class="tt">${r.duration_ms ? `${r.duration_ms}ms` : ""}</td>
    </tr>
  `).join("");

  const body = `
    <section style="padding:24px 0 12px">
      <p class="label">Admin</p>
      <h1 class="headline" style="margin-top:8px;font-size:32px">Console.</h1>
      <p class="subhead">Active targets: <strong style="color:var(--zee-text)">${active.length}</strong>${dueNow.length ? ` · due now: <strong style="color:var(--zee-primary)">${dueNow.length}</strong>` : ""} · skills: <strong style="color:var(--zee-text)">${skills.length}</strong>.</p>
    </section>

    <div class="card">
      <div class="h3-row"><h3>Add a target</h3><a href="/admin/skills" style="font-size:12px;color:var(--zee-primary)">Manage skills →</a></div>
      <form method="post" action="/admin/targets">
        <div class="field">
          <label>Name</label>
          <input name="name" placeholder="SW1A 1AA, Bhutan, OpenAI, etc." required maxlength="200">
        </div>
        <div class="field">
          <label>Kind <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
          <input name="kind" placeholder="postcode / place / topic / person / company">
        </div>
        <div class="field">
          <label>Description <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional — context for the agent)</span></label>
          <input name="description" maxlength="400">
        </div>
        <div class="row" style="gap:16px;margin-bottom:16px">
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Cadence</label>
            <select name="cadence_hours">
              <option value="1">every hour</option>
              <option value="6">every 6 hours</option>
              <option value="12">every 12 hours</option>
              <option value="24" selected>every 24 hours</option>
              <option value="72">every 3 days</option>
              <option value="168">every week</option>
            </select>
          </div>
          <div class="field" style="flex:2;margin-bottom:0">
            <label>Skill to apply</label>
            <select name="skill_slug">${skillOptions}</select>
          </div>
        </div>
        <label style="font-size:13px;color:var(--zee-muted);display:flex;align-items:center;gap:8px;margin-bottom:14px">
          <input type="checkbox" name="run_now" value="1"> Run once immediately after adding
        </label>
        <button class="btn" type="submit">Add target</button>
      </form>
    </div>

    <div class="card">
      <div class="h3-row"><h3>Mission (one-shot)</h3></div>
      <p class="field-help" style="margin-bottom:12px">Type an instruction. The agent picks/creates the target and the skill, and writes a report now.</p>
      <form id="mission-form">
        <div class="field">
          <label>Brief</label>
          <textarea name="brief" placeholder="e.g. 'Research SW1A 1AA, London — present a housing report.' or 'Apply transport-analysis to NW6'" required></textarea>
        </div>
        <div class="row" style="gap:16px">
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Pin target (optional)</label>
            <select name="target_slug">${targetOptions}</select>
          </div>
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Pin skill (optional)</label>
            <select name="skill_slug">
              <option value="">(let agent pick)</option>
              ${skills.map((s) => `<option value="${escapeHtml(s.slug)}">${escapeHtml(s.name)}</option>`).join("")}
            </select>
          </div>
        </div>
        <button class="btn" type="submit" style="margin-top:14px">Send mission</button>
      </form>
      <div id="mission-result" style="margin-top:16px;display:none"></div>
    </div>

    <div class="card">
      <div class="h3-row"><h3>Active targets</h3><span class="label-muted">${active.length} total</span></div>
      ${targetRows}
    </div>

    <div class="card">
      <div class="h3-row"><h3>Budgets & settings</h3></div>
      <form id="settings-form">
        <div class="row" style="gap:16px">
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Reports / day</label>
            <input type="number" name="daily_report_limit" min="0" max="10000" value="${escapeHtml(reportLim)}">
            <div class="field-help">${usage.reports} used today</div>
          </div>
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Searches / day</label>
            <input type="number" name="daily_search_limit" min="0" max="100000" value="${escapeHtml(searchLim)}">
            <div class="field-help">${usage.searches} used today</div>
          </div>
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Cron max / tick</label>
            <input type="number" name="cron_max_per_tick" min="1" max="20" value="${escapeHtml(perTick)}">
            <div class="field-help">Max targets advanced per hour</div>
          </div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn" type="submit">Save</button>
          <button id="cron-now-btn" type="button" class="btn btn-secondary">Tick cron now</button>
          <span id="cron-result" style="font-size:12px;color:var(--zee-muted)"></span>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="h3-row"><h3>Recent runs</h3></div>
      ${runsHtml
        ? `<table class="runs"><thead><tr><th>When</th><th>Trigger</th><th>Status</th><th>Duration</th></tr></thead><tbody>${runsHtml}</tbody></table>`
        : `<div class="empty">No runs yet.</div>`}
    </div>

    <script>
      const $ = (id) => document.getElementById(id);

      $('settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        const orig = btn.textContent;
        btn.disabled = true;
        try {
          const res = await fetch('/admin/settings', { method: 'POST', body: new FormData(e.target) });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            btn.textContent = d.error || ('HTTP ' + res.status);
          } else {
            btn.textContent = 'Saved ✓';
            setTimeout(() => location.reload(), 700);
          }
        } finally {
          setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
        }
      });

      $('cron-now-btn').addEventListener('click', async () => {
        const btn = $('cron-now-btn');
        const result = $('cron-result');
        btn.disabled = true;
        result.textContent = 'Running…';
        try {
          const res = await fetch('/admin/cron/tick', { method: 'POST' });
          const d = await res.json();
          if (!res.ok) {
            result.textContent = d.error || ('HTTP ' + res.status);
            return;
          }
          result.textContent = 'Processed ' + d.processed + ' · skipped ' + d.skipped + ' · errors ' + d.errors;
          setTimeout(() => location.reload(), 1200);
        } catch (err) {
          result.textContent = 'Failed: ' + (err && err.message || err);
        } finally {
          btn.disabled = false;
        }
      });

      $('mission-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        const result = $('mission-result');
        btn.disabled = true; btn.textContent = 'Sending…';
        result.style.display = 'block';
        result.innerHTML = '<span class="field-help">The agent is planning, searching, and writing. This usually takes 15–45 seconds.</span>';
        try {
          const res = await fetch('/admin/mission', { method: 'POST', body: new FormData(e.target) });
          const d = await res.json();
          if (!res.ok) {
            result.innerHTML = '<span style="color:rgb(180,60,60)">' + (d.error || ('HTTP ' + res.status)) + '</span>';
            return;
          }
          result.innerHTML = '<strong style="font-weight:500">' + d.report_title + '</strong><br>' +
            '<a class="btn btn-secondary" style="margin-top:10px" href="/report/' + d.report_id + '">Read report →</a> ' +
            '<a class="btn btn-secondary" href="/target/' + d.target_slug + '">Target page →</a>';
        } catch (err) {
          result.innerHTML = '<span style="color:rgb(180,60,60)">Failed: ' + (err && err.message || err) + '</span>';
        } finally {
          btn.disabled = false; btn.textContent = 'Send mission';
        }
      });
    </script>
  `;
  return shell("Admin · WatchOMacho", body, { activeNav: "admin", adminFooter: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: skills page
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminSkills(env: Env): Promise<string> {
  const skills = await listSkills(env);

  const list = skills.length === 0
    ? `<div class="empty">No skills yet. Synthesise one below from a brief, or paste your own markdown.</div>`
    : skills.map((s) => `
        <details class="card" style="padding:16px 20px" ${s.slug ? "" : "open"}>
          <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
            <span>
              <strong style="font-weight:500">${escapeHtml(s.name)}</strong>
              <span class="badge badge-${s.author}" style="margin-left:8px">${s.author}</span>
              <a href="/skill/${escapeHtml(s.slug)}" style="margin-left:8px;font-size:12px;color:var(--zee-primary)">public →</a>
            </span>
            <span class="label-muted">used ${s.used_count}× · ${escapeHtml(timeAgo(s.updated_at))}</span>
          </summary>
          <form method="post" action="/admin/skills/${escapeHtml(s.slug)}/update" style="margin-top:16px">
            <div class="field">
              <label>Name</label>
              <input name="name" value="${escapeHtml(s.name)}" maxlength="120">
            </div>
            <div class="field">
              <label>Description</label>
              <input name="description" value="${escapeHtml(s.description ?? "")}" maxlength="200">
            </div>
            <div class="field">
              <label>Procedure (markdown)</label>
              <textarea name="procedure_md" style="min-height:280px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">${escapeHtml(s.procedure_md)}</textarea>
            </div>
            <div class="row">
              <button class="btn" type="submit">Save changes</button>
              <button type="button" class="btn btn-danger" onclick="if(confirm('Delete this skill?')){fetch('/admin/skills/${escapeHtml(s.slug)}/delete',{method:'POST'}).then(()=>location.reload())}">Delete skill</button>
            </div>
          </form>
        </details>
      `).join("");

  const body = `
    <section style="padding:24px 0 8px">
      <p class="label">Admin</p>
      <h1 class="headline" style="margin-top:8px;font-size:32px">Skills.</h1>
      <p class="subhead">The agent's library of reusable research procedures. Each skill is a markdown document — write it yourself or let the agent synthesise one from a brief.</p>
    </section>

    <div class="card">
      <div class="h3-row"><h3>Synthesise a skill</h3></div>
      <p class="field-help" style="margin-bottom:12px">Describe what the skill should do in one paragraph. The agent will write the procedure document for you.</p>
      <form method="post" action="/admin/skills">
        <input type="hidden" name="mode" value="synthesize">
        <div class="field">
          <label>Name <span style="font-weight:400;text-transform:none;letter-spacing:0">(optional)</span></label>
          <input name="name" placeholder="e.g. Housing research" maxlength="120">
        </div>
        <div class="field">
          <label>Brief</label>
          <textarea name="brief" placeholder="What should this skill produce? Who is it for? What sources should it lean on?" required></textarea>
        </div>
        <button class="btn" type="submit">Synthesise skill</button>
      </form>
    </div>

    <div class="card">
      <div class="h3-row"><h3>Write a skill by hand</h3></div>
      <form method="post" action="/admin/skills">
        <input type="hidden" name="mode" value="write">
        <div class="field">
          <label>Name</label>
          <input name="name" required maxlength="120">
        </div>
        <div class="field">
          <label>Description</label>
          <input name="description" maxlength="200">
        </div>
        <div class="field">
          <label>Procedure (markdown)</label>
          <textarea name="procedure_md" required style="min-height:240px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px" placeholder="# Skill name

**Purpose:** ...
**Search queries:**
- {target} ...
**Output structure:**
- Heading: ...
"></textarea>
        </div>
        <button class="btn" type="submit">Save skill</button>
      </form>
    </div>

    ${list}
  `;
  return shell("Skills · WatchOMacho", body, { activeNav: "skills", adminFooter: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: target edit page
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminTargetEdit(env: Env, slug: string): Promise<string> {
  const target = await getTargetBySlug(env, slug);
  if (!target) {
    return shell("Not found", `<section style="padding:80px 0;text-align:center"><h1 class="headline">No such target.</h1></section>`, { adminFooter: true });
  }
  const skills = await listSkills(env);
  const reports = await listReportsForTarget(env, target.id, 10);
  const runRows = await env.DB.prepare(
    "SELECT * FROM runs WHERE target_id = ? ORDER BY created_at DESC LIMIT 10",
  )
    .bind(target.id)
    .all<any>();

  const currentSkillSlug = target.primary_skill_id
    ? skills.find((s) => s.id === target.primary_skill_id)?.slug ?? ""
    : "";

  const skillOptions = `<option value="">(none)</option>` + skills.map((s) =>
    `<option value="${escapeHtml(s.slug)}"${s.slug === currentSkillSlug ? " selected" : ""}>${escapeHtml(s.name)}</option>`,
  ).join("");

  const cadenceOptions = [1, 6, 12, 24, 72, 168].map((h) =>
    `<option value="${h}"${target.cadence_hours === h ? " selected" : ""}>${h === 1 ? "every hour" : h < 24 ? `every ${h} hours` : h === 24 ? "every 24 hours" : h === 72 ? "every 3 days" : "every week"}</option>`,
  ).join("");

  const reportsList = reports.length === 0
    ? `<div class="empty">No reports yet.</div>`
    : `<ul style="list-style:none">${reports.map((r) => `
        <li style="padding:8px 0;border-bottom:1px solid rgba(232,228,222,0.6)">
          <a href="/report/${escapeHtml(r.id)}" style="font-size:14px">
            <span style="color:var(--zee-text)">${escapeHtml(r.title)}</span>
            <span class="label-muted" style="margin-left:8px">${escapeHtml(timeAgo(r.created_at))}</span>
          </a>
        </li>
      `).join("")}</ul>`;

  const runRowsHtml = (runRows.results ?? []).map((r: any) => `
    <tr>
      <td class="tt">${escapeHtml(timeAgo(r.created_at))}</td>
      <td>${escapeHtml(r.triggered_by)}</td>
      <td>${r.status === "success"
            ? `<span class="badge badge-active">success</span>`
            : `<span class="badge badge-error">${escapeHtml(r.error ?? "error").slice(0, 80)}</span>`}</td>
      <td class="tt">${r.duration_ms ? `${r.duration_ms}ms` : ""}</td>
    </tr>
  `).join("");

  const body = `
    <section style="padding:24px 0 8px">
      <p class="label"><a href="/admin" style="color:inherit">← Admin</a></p>
      <h1 class="headline" style="margin-top:8px">${escapeHtml(target.name)}</h1>
      <p class="subhead">${target.description ? escapeHtml(target.description) : `<em style="color:var(--zee-muted)">No description</em>`}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-top:14px">
        <span class="badge badge-${target.status}">${target.status}</span>
        ${target.kind ? `<span class="label-muted">${escapeHtml(target.kind)}</span>` : ""}
        <span class="label-muted">${target.last_run_at ? `last run ${escapeHtml(timeAgo(target.last_run_at))}` : "never run"}</span>
        ${target.next_run_at && target.status === "active" ? `<span class="label-muted">next ${escapeHtml(timeUntil(target.next_run_at))}</span>` : ""}
        <a href="/target/${escapeHtml(target.slug)}" style="font-size:13px;color:var(--zee-primary);margin-left:auto">View public page →</a>
      </div>
    </section>

    <div class="card">
      <div class="h3-row"><h3>Configure</h3></div>
      <form method="post" action="/admin/targets/${escapeHtml(target.slug)}/update">
        <div class="field">
          <label>Kind</label>
          <input name="kind" value="${escapeHtml(target.kind ?? "")}">
        </div>
        <div class="field">
          <label>Description</label>
          <input name="description" value="${escapeHtml(target.description ?? "")}" maxlength="400">
        </div>
        <div class="row" style="gap:16px">
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Status</label>
            <select name="status">
              <option value="active"${target.status === "active" ? " selected" : ""}>active</option>
              <option value="paused"${target.status === "paused" ? " selected" : ""}>paused</option>
              <option value="archived"${target.status === "archived" ? " selected" : ""}>archived</option>
            </select>
          </div>
          <div class="field" style="flex:1;margin-bottom:0">
            <label>Cadence</label>
            <select name="cadence_hours">${cadenceOptions}</select>
          </div>
          <div class="field" style="flex:2;margin-bottom:0">
            <label>Primary skill</label>
            <select name="skill_slug">${skillOptions}</select>
          </div>
        </div>
        <div class="row" style="margin-top:16px;gap:12px">
          <button class="btn" type="submit">Save</button>
          <form method="post" action="/admin/targets/${escapeHtml(target.slug)}/run" style="display:inline">
            <button class="btn btn-secondary" type="submit"${target.primary_skill_id ? "" : " disabled"}>Run now</button>
          </form>
          <form method="post" action="/admin/targets/${escapeHtml(target.slug)}/delete" style="display:inline;margin-left:auto" onsubmit="return confirm('Delete this target and all its reports?')">
            <button class="btn btn-danger" type="submit">Delete target</button>
          </form>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="h3-row"><h3>Reports</h3><a href="/target/${escapeHtml(target.slug)}" style="font-size:12px;color:var(--zee-primary)">all →</a></div>
      ${reportsList}
    </div>

    <div class="card">
      <div class="h3-row"><h3>Run history</h3></div>
      ${runRowsHtml
        ? `<table class="runs"><thead><tr><th>When</th><th>Trigger</th><th>Status</th><th>Duration</th></tr></thead><tbody>${runRowsHtml}</tbody></table>`
        : `<div class="empty">No runs yet.</div>`}
    </div>
  `;
  return shell(`${target.name} · Admin`, body, { activeNav: "admin", adminFooter: true });
}
