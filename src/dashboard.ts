// All HTML rendering. Server-rendered, no client framework. Styled to match
// daylila.com — DM Sans, warm off-white paper, forest-teal primary, restrained
// editorial layout.
//
// Public pages:    /  /target/:slug  /skill/:slug  /report/:id
// Admin pages:     /admin  /admin/skills  /admin/targets/:slug  /admin/login

import {
  ALLOWED_CHAT_MODELS,
  CHAT_MODEL_LABELS,
  DEFAULT_CHAT_MODEL,
  findOrphanedR2,
  getChatModel,
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
import { TOOLS } from "./apis";

/** Short pretty label for a chat model id ("Llama 3.3 70B"). Strips the descriptor
 *  after the em-dash so it fits in compact UI spots. */
function chatModelShortLabel(id: string | null | undefined): string {
  if (!id) return "—";
  const full = CHAT_MODEL_LABELS[id] ?? id;
  const dashIdx = full.indexOf("—");
  return (dashIdx === -1 ? full : full.slice(0, dashIdx)).trim();
}

/** Human-readable duration. 18041 → "18.0s", 73210 → "1m 13s". */
function fmtDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

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
.btn:disabled, .btn:disabled:hover {
  opacity: 0.4;
  cursor: not-allowed;
  background: white;
  color: var(--zee-muted);
  border: 1px solid var(--zee-border);
}
.btn-secondary {
  background: white;
  color: var(--zee-text);
  border: 1px solid var(--zee-border);
}
.btn-secondary:hover { border-color: var(--zee-primary); color: var(--zee-primary); }
.btn-danger { background: white; color: rgb(180, 60, 60); border: 1px solid rgb(220, 180, 180); }
.btn-danger:hover { background: rgb(180, 60, 60); color: white; }
.btn-sm { padding: 4px 10px; font-size: 11px; font-weight: 500; }
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

/* collapsible cards: <details class="card"> with a summary that renders
 * the same h3-row layout plus a chevron that rotates on open. The summary
 * IS the clickable header; everything after it is the collapsible body. */
details.card > summary {
  list-style: none;
  cursor: pointer;
  margin-bottom: 0;
}
details.card > summary::-webkit-details-marker { display: none; }
details.card > summary .h3-row { margin-bottom: 0; }
details.card[open] > summary .h3-row { margin-bottom: 12px; }
details.card .chev {
  display: inline-block;
  font-size: 10px;
  color: var(--zee-muted);
  margin-left: 10px;
  transition: transform 0.15s ease;
  transform: rotate(-90deg);
}
details.card[open] > summary .chev { transform: rotate(0deg); }
details.card > summary:hover .chev { color: var(--zee-primary); }

/* activity feed status dot: small circle with a ✓ or ✕ glyph */
.activity-dot {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  margin-top: 1px;
  line-height: 1;
}
.activity-dot--ok {
  background: rgba(26, 107, 98, 0.12);
  color: var(--zee-primary);
}
.activity-dot--err {
  background: rgba(180, 60, 60, 0.12);
  color: rgb(180, 60, 60);
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
.prose .cite {
  font-size: 11px;
  color: var(--zee-muted);
  font-weight: 500;
  vertical-align: super;
  line-height: 0;
  margin: 0 1px;
  letter-spacing: 0;
}
.prose .cite a {
  color: inherit;
  border-bottom: none;
  text-decoration: none;
}
.prose .cite a:hover { color: var(--zee-primary); }
.prose hr {
  border: 0;
  border-top: 1px solid var(--zee-border);
  margin: 28px 0;
}

/* Editorial section cards used on the report page. Each ## heading +
 * its body becomes a card with a left teal accent stripe + sharp title
 * rule. Cards sit on the warm page background, white inside, so the
 * eye groups each section as its own "story". */
.report-card {
  background: white;
  border: 1px solid var(--zee-border);
  border-left: 3px solid var(--zee-primary);
  border-radius: 4px;
  padding: 28px 32px;
  margin: 0 0 20px;
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}
.report-card:hover {
  box-shadow: 0 2px 10px rgba(26, 26, 26, 0.04);
}
.report-card:first-child { margin-top: 0; }
.prose .report-card > h2:first-child {
  margin: 0 0 18px;
  padding-bottom: 12px;
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.01em;
  border-bottom: 1px solid var(--zee-border);
  color: var(--zee-text);
}
.prose .report-card > p {
  margin: 14px 0;
  line-height: 1.7;
}
.prose .report-card > p:last-child { margin-bottom: 0; }
.prose .report-card > p:first-of-type { margin-top: 0; }
/* Story lead-in: the bold first sentence of each paragraph (e.g.
 * "**Tensions escalate in the Middle East.**") gets a slight tone shift
 * so it functions as a mini-headline within the section card. */
.prose .report-card > p > strong:first-child {
  color: var(--zee-text);
  font-weight: 700;
  letter-spacing: -0.005em;
}

/* Sources card mirrors the report card style — white surface, same
 * border treatment, no teal stripe (it's reference, not editorial). */
.sources-card {
  background: white;
  border: 1px solid var(--zee-border);
  border-radius: 4px;
  padding: 24px 32px 28px;
  margin-top: 32px;
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
/** Collapse markdown source into plain text for snippets / list previews. */
function stripMarkdown(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, "")                     // heading hashes
    .replace(/\*\*([^*]+)\*\*/g, "$1")               // bold
    .replace(/__([^_]+)__/g, "$1")                   // alt bold
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")       // italic
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")         // alt italic
    .replace(/`([^`]+)`/g, "$1")                     // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")         // markdown links → text
    .replace(/\[\d+(?:[,\-–]\d+)*\]/g, "")           // citation markers [n] / [n,m] / [n-m]
    .replace(/^[-*]\s+/gm, "")                       // list bullets
    .replace(/^>\s?/gm, "")                          // blockquote
    .replace(/^[-=]{3,}\s*$/gm, "")                  // horizontal rules
    .replace(/\s+/g, " ")
    .trim();
}

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
    // Numeric citation markers like [1], [2], [8,10], [3-5] — render as
    // small superscripts that link to the corresponding source in the
    // canonical Sources footer (id="source-N"). aria-hidden makes screen
    // readers and TTS skip them entirely.
    r = r.replace(/\[(\d+(?:[,\-–]\d+)*)\]/g, (_m, group) => {
      const first = String(group).split(/[,\-–]/)[0];
      return `<sup class="cite" aria-hidden="true"><a href="#source-${first}">[${group}]</a></sup>`;
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
<link rel="stylesheet" href="/static/tailwind.v1.css">
</head>
<body>
<header class="site-header">
  <div class="wrap site-header-inner">
    <a href="/" class="brand">WatchOMacho</a>
    <nav class="nav">
      ${navLink("/", "Targets", "home")}
      ${isAdmin ? `${navLink("/admin", "Admin", "admin")} ${navLink("/admin/skills", "Skills", "skills")} ${navLink("/admin/tools", "Tools", "tools")} <form method="post" action="/admin/logout" class="inline ml-2"><button class="btn btn-secondary px-2.5 py-1 text-[11px]">Logout</button></form>` : navLink("/admin/login", "Admin", "admin")}
    </nav>
  </div>
</header>
<main class="wrap flex-1 px-6 pt-2 pb-4">
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
      <section class="py-14">
        <p class="label">Empty — for now</p>
        <h1 class="headline mt-2">No targets yet.</h1>
        <p class="subhead">Give the agent something to research. <a href="/admin/login" class="text-zee-primary border-b border-current">Open the admin</a>, add a target like <em>Bhutan</em> or <em>OpenAI</em>, attach a skill, and the agent will keep that target's page fresh.</p>
      </section>
    `;
  } else {
    const top = enriched[0];
    if (top.latest) {
      hero = `
        <section class="pt-8 pb-14">
          <p class="label">Latest <span class="ml-1.5 font-normal normal-case tracking-normal text-[rgba(107,107,107,0.6)]">· ${escapeHtml(timeAgo(top.latest.created_at))}</span></p>
          <a href="/target/${escapeHtml(top.target.slug)}" class="block mt-3.5">
            <h1 class="headline">${escapeHtml(top.target.name)}</h1>
            <p class="subhead">${escapeHtml(stripMarkdown(top.latest.snippet))}</p>
            <p class="mt-5 text-sm font-medium text-zee-primary">Open the target page <span aria-hidden="true">→</span></p>
          </a>
        </section>
      `;
    } else {
      hero = `
        <section class="pt-8 pb-14">
          <p class="label">Newest target</p>
          <a href="/target/${escapeHtml(top.target.slug)}" class="block mt-3.5">
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
        <div class="flex-1 min-w-0">
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
    <section class="pt-8">
      <div class="flex justify-between items-baseline mb-2">
        <h2 class="label-muted">All targets</h2>
        <a href="/admin/login" class="text-[13px] text-zee-primary">Add target →</a>
      </div>
      <div class="divider"></div>
      ${list || `<div class="empty mt-4">No other targets.</div>`}
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
      <section class="py-20 text-center">
        <p class="label">404</p>
        <h1 class="headline mt-3">No such target.</h1>
        <p class="subhead mx-auto">It may have been renamed or archived. <a href="/" class="text-zee-primary border-b border-current">Back to the list</a>.</p>
      </section>
    `);
  }
  const reports = await listReportsForTarget(env, target.id, 30);
  const skill = target.primary_skill_id
    ? await env.DB.prepare("SELECT * FROM skills WHERE id = ?").bind(target.primary_skill_id).first<Skill>()
    : null;

  const meta = `
    <div class="flex flex-wrap items-center gap-3 mt-3">
      <span class="badge badge-${target.status}">${target.status}</span>
      ${target.kind ? `<span class="label-muted">${escapeHtml(target.kind)}</span>` : ""}
      ${skill ? `<span class="label-muted">skill: <a href="/skill/${escapeHtml(skill.slug)}" class="text-zee-primary">${escapeHtml(skill.name)}</a></span>` : `<span class="label-muted">no skill attached</span>`}
      <span class="label-muted">every ${target.cadence_hours}h</span>
      ${target.next_run_at ? `<span class="label-muted">next ${escapeHtml(timeUntil(target.next_run_at))}</span>` : ""}
    </div>
  `;

  let body = `
    <section class="pt-8 pb-7">
      <p class="label">Target</p>
      <h1 class="headline mt-2">${escapeHtml(target.name)}</h1>
      ${target.description ? `<p class="subhead">${escapeHtml(target.description)}</p>` : ""}
      ${meta}
    </section>
    <div class="divider"></div>
  `;

  if (reports.length === 0) {
    body += `
      <section class="py-12">
        <div class="empty">No reports yet. ${target.primary_skill_id ? "The agent will write the first one on the next cron tick (or hit \"Run now\" in the admin)." : "Attach a skill from the admin to start producing reports."}</div>
      </section>
    `;
  } else {
    body += `<section class="py-2">`;
    for (const r of reports) {
      body += `
        <a class="piece" href="/report/${escapeHtml(r.id)}">
          <div class="piece-row">
            <div class="flex-1 min-w-0">
              <p class="piece-title">${escapeHtml(r.title)} <span class="piece-arrow" aria-hidden="true">→</span></p>
              <p class="piece-meta">${escapeHtml(stripMarkdown(r.snippet))}</p>
              ${r.chat_model ? `<p class="piece-meta mt-1.5 text-[11px]">model: <span class="text-zee-text">${escapeHtml(chatModelShortLabel(r.chat_model))}</span></p>` : ""}
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
      <section class="py-20 text-center">
        <p class="label">404</p>
        <h1 class="headline mt-3">No such skill.</h1>
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
    <section class="pt-8 pb-4">
      <p class="label">Skill <span class="ml-2"><span class="badge badge-${skill.author}">${skill.author}-written</span></span></p>
      <h1 class="headline mt-2">${escapeHtml(skill.name)}</h1>
      ${skill.description ? `<p class="subhead">${escapeHtml(skill.description)}</p>` : ""}
      <div class="mt-3.5"><span class="label-muted">used ${skill.used_count} time${skill.used_count === 1 ? "" : "s"}</span></div>
    </section>
    <div class="divider"></div>
    <section class="prose py-8">
      ${renderMarkdown(skill.procedure_md)}
    </section>
    <div class="divider"></div>
    <section class="py-6">
      <h2 class="label-muted">Used by</h2>
      ${usedBy.length === 0
        ? `<div class="empty mt-3">No targets are using this skill yet.</div>`
        : `<ul class="list-none mt-3">${usedBy.map((t) => `
            <li class="py-2 border-b border-[rgba(232,228,222,0.6)]">
              <a href="/target/${escapeHtml(t.slug)}" class="text-zee-text">
                <strong class="font-medium">${escapeHtml(t.name)}</strong>
                <span class="badge badge-${t.status} ml-2">${t.status}</span>
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
      <section class="py-20 text-center">
        <p class="label">404</p>
        <h1 class="headline mt-3">Report missing.</h1>
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

  // Strip everything that would visually duplicate the page header:
  //  - leading H1 (title sits in our own header above)
  //  - italic "Target / Generated" frontmatter lines (now redundant with
  //    the page header's date / skill / model row)
  //  - trailing "Sources" / "References" section the LLM may have written
  //    (we render the canonical numbered list ourselves)
  const bodyMd = stripTrailingSourcesSection(
    md
      .replace(/^# .+\n+/, "")
      .replace(/^(?:\*(?:Target|Generated):[^\n]*\*\s*\n+)+/g, "")
      .trimStart(),
  );
  const html = wrapSectionsInCards(renderMarkdown(bodyMd));
  const sourcesHtml = renderSourcesSection(report.sources_json);

  const body = `
    <section class="pt-8 pb-4">
      <p class="label">${target ? `<a href="/target/${escapeHtml(target.slug)}" class="text-inherit">${escapeHtml(target.name)}</a>` : "Report"}</p>
      <h1 class="headline mt-2">${escapeHtml(report.title)}</h1>
      <div class="flex flex-wrap gap-3 mt-3.5">
        <span class="label-muted">${escapeHtml(formatDate(report.created_at))}</span>
        ${skill ? `<span class="label-muted">skill: <a href="/skill/${escapeHtml(skill.slug)}" class="text-zee-primary">${escapeHtml(skill.name)}</a></span>` : ""}
        <span class="label-muted">${report.word_count ?? 0} words</span>
        ${report.chat_model ? `<span class="label-muted" title="${escapeHtml(report.chat_model)}">written by <strong class="text-zee-text font-medium">${escapeHtml(chatModelShortLabel(report.chat_model))}</strong></span>` : ""}
      </div>
    </section>
    <article class="prose pt-6 pb-2">${html}</article>
    ${sourcesHtml}
    <div class="pb-12"></div>
  `;
  return shell(`${report.title} — WatchOMacho`, body);
}

/** Strip a trailing Sources / References / Citations section from the report
 *  markdown. The canonical list is rendered from sources_json instead, so
 *  anything the writer wrote is duplicate. Conservative — only matches a
 *  Sources-style heading near the end of the document. */
function stripTrailingSourcesSection(md: string): string {
  return md
    .replace(
      /\n\s*(?:#{1,4}\s+|\*\*)?(?:Sources?|References|Citations)\s*:?\s*(?:\*\*)?\s*\n[\s\S]*$/i,
      "",
    )
    .replace(/\n\s*-{3,}\s*$/, "")     // strip a trailing horizontal rule too
    .trimEnd();
}

/** Wrap each ## section's worth of rendered HTML in its own card so the
 *  page reads as a stack of editorial blocks instead of one long column.
 *  Operates on the post-render HTML (vs. inside renderMarkdown) so the
 *  markdown parser stays single-purpose. Any content before the first
 *  ## stays outside cards (intro / target-skill line). */
function wrapSectionsInCards(html: string): string {
  const parts = html.split(/(?=<h2[\s>])/);
  return parts
    .map((part, i) => {
      if (i === 0 && !part.startsWith("<h2")) return part;
      return `<section class="report-card">${part}</section>`;
    })
    .join("");
}

/** Render the gathered source list as a numbered, clickable footer.
 *  Citation `[N]` in the body always maps to source `N` here, regardless of
 *  whether the writer LLM ran out of tokens. Archive entries (prior reports
 *  pulled in by the recall layer) get a 📚 marker and link to /report/:id
 *  instead of an external URL — making the archive a navigable graph. */
function renderSourcesSection(sourcesJson: string | null): string {
  if (!sourcesJson) return "";
  type Source = { title: string; url: string; kind: "web" | "archive" };
  let sources: Source[] = [];
  try {
    const parsed = JSON.parse(sourcesJson);
    if (Array.isArray(parsed)) {
      sources = parsed
        .filter(
          (s): s is { title: string; url: string; kind?: string } =>
            s && typeof s.url === "string" && s.url.length > 0,
        )
        .map((s) => ({
          title: String(s.title ?? ""),
          url: s.url,
          // Old rows without `kind` are treated as web (back-compat with
          // reports written before the unified citation work).
          kind: s.kind === "archive" ? "archive" : "web",
        }));
    }
  } catch {
    return "";
  }
  if (sources.length === 0) return "";

  // Citation numbering preserves global position (the LLM cited [N] referring
  // to that exact index), so we render in original order but visually mark
  // each item by kind. We do NOT sort or split into two ordered lists —
  // that would break [N] → list-position mapping.
  const items = sources
    .map((s, i) => {
      const n = i + 1;
      const title = s.title.trim() || s.url;
      const isArchive = s.kind === "archive";
      let host = "";
      if (!isArchive) {
        try {
          host = new URL(s.url).hostname.replace(/^www\./, "");
        } catch {
          // Bad URL — skip hostname; the title link still works.
        }
      }
      const linkAttrs = isArchive
        ? ``
        : ` target="_blank" rel="noopener noreferrer"`;
      const marker = isArchive
        ? `<span class="text-zee-muted mr-1.5" title="From your archive" aria-label="archive source">📚</span>`
        : ``;
      const subtle = isArchive
        ? `<span class="text-zee-muted text-[12px] ml-2">archive</span>`
        : host
          ? `<span class="text-zee-muted text-[12px] ml-2">${escapeHtml(host)}</span>`
          : ``;
      return `<li id="source-${n}" class="mb-3 leading-snug scroll-mt-20">
        <span class="font-mono text-zee-muted mr-2 text-[13px]">[${n}]</span>
        ${marker}<a href="${escapeHtml(s.url)}"${linkAttrs} class="text-zee-primary hover:underline">${escapeHtml(title)}</a>
        ${subtle}
      </li>`;
    })
    .join("");

  const archiveCount = sources.filter((s) => s.kind === "archive").length;
  const subhead = archiveCount > 0
    ? `<p class="text-[12px] text-zee-muted mb-4">${sources.length - archiveCount} web · ${archiveCount} from archive (📚)</p>`
    : "";

  return `
    <section class="sources-card">
      <h2 class="text-[13px] uppercase tracking-wider text-zee-muted mb-2 font-semibold">Sources</h2>
      ${subhead}
      <ol class="list-none p-0 m-0">${items}</ol>
    </section>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: login
// ─────────────────────────────────────────────────────────────────────────────

export function renderAdminLogin(error?: string): string {
  const body = `
    <section class="max-w-[380px] mx-auto my-12 py-8">
      <p class="label">Admin</p>
      <h1 class="headline mt-2 text-[32px]">Unlock the agent.</h1>
      <form method="post" action="/admin/login" class="mt-7">
        <div class="field">
          <label for="secret">Secret</label>
          <input id="secret" type="password" name="secret" autofocus autocomplete="off" required>
        </div>
        <button class="btn w-full" type="submit">Unlock</button>
        ${error ? `<p class="mt-3 text-[13px] text-[rgb(180,60,60)]">${escapeHtml(error)}</p>` : ""}
      </form>
      <p class="mt-6 text-center"><a href="/" class="text-xs text-zee-muted">← back</a></p>
    </section>
  `;
  return shell("Admin · WatchOMacho", body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: overview panel
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminPanel(env: Env): Promise<string> {
  const [targets, skills, usage, reportLim, searchLim, perTick, currentChatModel, r2Stats, embedLastOkStr, embedLastErrorRaw, totalReportsRow, lastCronRunStr, lastRunAttemptRaw, lastCompletedRun, tavilyMinScoreStr] = await Promise.all([
    listTargets(env),
    listSkills(env),
    getDailyUsage(env),
    getSetting(env, "daily_report_limit", "20"),
    getSetting(env, "daily_search_limit", "500"),
    getSetting(env, "cron_max_per_tick", "2"),
    getChatModel(env),
    findOrphanedR2(env).catch((e) => {
      console.error("renderAdminPanel: findOrphanedR2 failed", e);
      return null;
    }),
    getSetting(env, "embed_last_ok_at", "0"),
    getSetting(env, "embed_last_error", ""),
    env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>(),
    getSetting(env, "last_cron_run", "0"),
    getSetting(env, "last_run_attempt", ""),
    env.DB.prepare("SELECT status, error, duration_ms, created_at FROM runs ORDER BY created_at DESC LIMIT 1").first<{ status: string; error: string | null; duration_ms: number | null; created_at: number }>(),
    getSetting(env, "tavily_min_score", "0.4"),
  ]);
  const tavilyMinScore = (() => {
    const f = parseFloat(tavilyMinScoreStr);
    return Number.isFinite(f) && f >= 0 && f <= 1 ? f : 0.4;
  })();
  const embedLastOkAt = parseInt(embedLastOkStr, 10) || 0;
  const embedLastError: { message: string; at: number; report_id?: string } | null =
    embedLastErrorRaw ? (() => { try { return JSON.parse(embedLastErrorRaw); } catch { return null; } })() : null;
  const totalReports = totalReportsRow?.n ?? 0;
  const lastCronRun = parseInt(lastCronRunStr, 10) || 0;
  type GatherStats = { tavily_queries: number; tavily_raw: number; after_score_filter: number; after_url_dedupe: number; after_title_dedupe: number; final_kept: number };
  type LastRunAttempt = { run_id: string; target_slug: string; triggered_by: "cron" | "manual"; started_at: number; last_step: string; completed_at: number | null; outcome: "in_flight" | "success" | "error"; error?: string; gather_stats?: GatherStats };
  const lastRunAttempt: LastRunAttempt | null = lastRunAttemptRaw
    ? (() => { try { return JSON.parse(lastRunAttemptRaw); } catch { return null; } })()
    : null;

  const modelOptions = ALLOWED_CHAT_MODELS.map((m) =>
    `<option value="${escapeHtml(m)}"${m === currentChatModel ? " selected" : ""}>${escapeHtml(CHAT_MODEL_LABELS[m] ?? m)}</option>`,
  ).join("");

  const runRows = await env.DB.prepare(
    "SELECT * FROM runs ORDER BY created_at DESC LIMIT 12",
  ).all<any>();

  const skillOptions = skills.length === 0
    ? `<option value="">(no skills yet — use "Manage skills →" to create one)</option>`
    : `<option value="">(none — attach later)</option>` + skills.map((s) =>
        `<option value="${escapeHtml(s.slug)}">${escapeHtml(s.name)}</option>`,
      ).join("");

  const active = targets.filter((t) => t.status === "active");
  const dueNow = active.filter((t) => t.next_run_at && t.next_run_at <= Date.now() && t.primary_skill_id);

  const targetRows = active.length === 0
    ? `<div class="empty">No targets yet. Add one above.</div>`
    : `<ul class="list-none">${active.map((t) => `
        <li class="py-2.5 border-b border-[rgba(232,228,222,0.6)]">
          <div class="flex flex-wrap justify-between items-baseline gap-3">
            <a href="/admin/targets/${escapeHtml(t.slug)}" class="font-medium text-zee-text">
              ${escapeHtml(t.name)}
              ${t.kind ? `<span class="label-muted ml-2">${escapeHtml(t.kind)}</span>` : ""}
            </a>
            <span class="tt text-xs text-zee-muted">
              ${t.next_run_at ? (t.next_run_at <= Date.now() ? `<span class="text-zee-primary">due now</span>` : escapeHtml(timeUntil(t.next_run_at))) : "—"}
              · every ${t.cadence_hours}h
            </span>
          </div>
        </li>`).join("")}</ul>`;

  const targetById = new Map(targets.map((t) => [t.id, t]));
  const runsHtml = (runRows.results ?? []).map((r: any) => {
    const t = targetById.get(r.target_id);
    const targetCell = t
      ? `<a href="/admin/targets/${escapeHtml(t.slug)}" class="text-zee-primary">${escapeHtml(t.name)}</a>`
      : `<span class="label-muted">(deleted)</span>`;
    const reportCell = r.report_id && r.status === "success"
      ? `<a href="/report/${escapeHtml(r.report_id)}" class="text-zee-primary">view →</a>`
      : `<span class="label-muted">—</span>`;
    const errFull = r.error ?? "";
    const errShort = errFull.length > 60 ? errFull.slice(0, 60) + "…" : errFull;
    return `
    <tr>
      <td class="tt">${escapeHtml(timeAgo(r.created_at))}</td>
      <td>${targetCell}</td>
      <td>${escapeHtml(r.triggered_by)}</td>
      <td>${r.status === "success"
            ? `<span class="badge badge-active">success</span>`
            : `<span class="badge badge-error" title="${escapeHtml(errFull)}">${escapeHtml(errShort || "error")}</span>`}</td>
      <td>${reportCell}</td>
      <td class="tt">${escapeHtml(fmtDuration(r.duration_ms))}</td>
    </tr>
  `;
  }).join("");

  const body = `
    <section class="pt-6 pb-3">
      <p class="label">Admin</p>
      <h1 class="headline mt-2 text-[32px]">Console.</h1>
      <p class="subhead"><strong class="text-zee-text">${active.length}</strong> ${active.length === 1 ? "target" : "targets"}${dueNow.length ? ` · <strong class="text-zee-primary">${dueNow.length}</strong> due now` : ""} · <strong class="text-zee-text">${skills.length}</strong> ${skills.length === 1 ? "skill" : "skills"}.</p>
    </section>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Add a target</h3>
          <span class="text-xs">
            <a href="/admin/skills" class="text-zee-primary" onclick="event.stopPropagation()">Manage skills →</a>
            <span class="chev">▾</span>
          </span>
        </div>
      </summary>
      <form method="post" action="/admin/targets">
        <div class="field">
          <label>Name</label>
          <input name="name" placeholder="SW1A 1AA, Bhutan, OpenAI, etc." required maxlength="200">
        </div>
        <div class="field">
          <label>Kind <span class="font-normal normal-case tracking-normal">(optional)</span></label>
          <input name="kind" placeholder="postcode / place / topic / person / company">
        </div>
        <div class="field">
          <label>Description <span class="font-normal normal-case tracking-normal">(optional — context for the agent)</span></label>
          <input name="description" maxlength="400">
        </div>
        <div class="row gap-4 mb-4">
          <div class="field flex-1 mb-0">
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
          <div class="field flex-[2] mb-0">
            <label>Skill to apply</label>
            <select name="skill_slug">${skillOptions}</select>
          </div>
        </div>
        <label class="flex items-center gap-2 mb-3.5 text-[13px] text-zee-muted">
          <input type="checkbox" name="run_now" value="1"> Run once now
        </label>
        <button class="btn" type="submit">Add target</button>
      </form>
    </details>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Active targets</h3>
          <span class="label-muted">${active.length} total<span class="chev">▾</span></span>
        </div>
      </summary>
      ${targetRows}
    </details>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Budgets &amp; settings</h3>
          <span class="chev">▾</span>
        </div>
      </summary>
      <form id="settings-form">
        <div class="field mb-4">
          <label>Chat model</label>
          <select name="chat_model">${modelOptions}</select>
          <div class="field-help">Used for planning and writing. Switch to a smaller model if you hit rate limits.</div>
        </div>
        <div class="row gap-4">
          <div class="field flex-1 mb-0">
            <label>Reports / day</label>
            <input type="number" name="daily_report_limit" min="0" max="10000" value="${escapeHtml(reportLim)}">
            <div class="field-help">${usage.reports} used today</div>
          </div>
          <div class="field flex-1 mb-0">
            <label>Tavily credits / day</label>
            <input type="number" name="daily_search_limit" min="0" max="100000" value="${escapeHtml(searchLim)}">
            <div class="field-help">${usage.searches} used today</div>
          </div>
          <div class="field flex-1 mb-0">
            <label>Runs / hour</label>
            <input type="number" name="cron_max_per_tick" min="1" max="20" value="${escapeHtml(perTick)}">
            <div class="field-help">Cap per hourly cron firing</div>
          </div>
        </div>
        <div class="row mt-3.5">
          <button class="btn" type="submit">Save</button>
          <button id="cron-now-btn" type="button" class="btn btn-secondary">Run cron now</button>
          <span id="cron-result" class="text-xs text-zee-muted"></span>
        </div>
      </form>
    </details>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Search tuning</h3>
          <span class="label-muted">min score ${tavilyMinScore.toFixed(2)}<span class="chev">▾</span></span>
        </div>
      </summary>
      <form id="search-tuning-form">
        <div class="field mb-3.5">
          <label>Tavily minimum score</label>
          <input type="number" name="tavily_min_score" min="0" max="1" step="0.05" value="${tavilyMinScore.toFixed(2)}" style="max-width: 140px;">
          <div class="field-help mt-1.5" style="max-width: 64ch;">
            Drops Tavily hits below this score. 0 = keep everything (noisy). 1 = only perfect matches (very few). Tavily-recommended sweet spot: <strong>0.4</strong>. Lower = more candidates reach the writer (richer + noisier). Higher = stricter (cleaner but sparser). Watch the gather funnel in Maintenance after each run to see the effect.
          </div>
        </div>
        <div class="row">
          <button class="btn" type="submit">Save</button>
          <span id="search-tuning-result" class="text-xs text-zee-muted"></span>
        </div>
      </form>
    </details>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Recent runs</h3>
          <span class="label-muted">${(runRows.results ?? []).length} shown<span class="chev">▾</span></span>
        </div>
      </summary>
      ${runsHtml
        ? `<table class="runs"><thead><tr><th>When</th><th>Target</th><th>Trigger</th><th>Status</th><th>Report</th><th>Duration</th></tr></thead><tbody>${runsHtml}</tbody></table>`
        : `<div class="empty">No runs yet.</div>`}
    </details>

    <details class="card">
      <summary>
        <div class="h3-row">
          <h3>Maintenance</h3>
          <span class="label-muted">
            ${r2Stats
              ? `${r2Stats.scanned} R2 file${r2Stats.scanned === 1 ? "" : "s"} · `
                + (r2Stats.orphans.length === 0
                    ? `<span class="text-zee-primary">no orphans</span>`
                    : `<strong class="font-medium">${r2Stats.orphans.length} unaccounted</strong>`)
              : `storage &amp; cleanup`}
            <span class="chev">▾</span>
          </span>
        </div>
      </summary>
      <div class="field-help mt-3.5" style="max-width: 64ch;">
        Each report is a markdown file in Cloudflare R2 (object storage, separate from the D1 database). Deleting a target should remove its R2 files too — if that fails the row disappears but the file lingers, an <em>orphan</em>. This panel shows the live count and lets you sweep by hand. Sweeps also run automatically after every target deletion and once an hour from cron, so you shouldn't normally need to touch it.
      </div>
      <div class="label-muted mt-5 mb-2">Stored report files (R2)</div>
      <div class="row items-baseline">
        <div class="flex-1 text-sm">
          ${r2Stats
            ? `<strong class="font-medium">${r2Stats.scanned}</strong> file${r2Stats.scanned === 1 ? "" : "s"} · `
              + (r2Stats.orphans.length === 0
                  ? `<span class="text-zee-primary">no orphans</span>`
                  : `<strong class="font-medium">${r2Stats.orphans.length}</strong> unaccounted`)
            : `<span class="text-zee-muted">count unavailable</span>`}
        </div>
        <div>
          <button id="gc-r2-btn" type="button" class="btn btn-danger"${r2Stats && r2Stats.orphans.length === 0 ? " disabled" : ""}>Sweep orphans now</button>
          <div id="gc-r2-result" class="field-help mt-1"></div>
        </div>
      </div>

      <div style="margin: 28px 0; border-top: 1px solid #D6CFC4;"></div>

      <div class="label-muted mb-2">Activity heartbeat</div>
      <div class="field-help" style="max-width: 64ch;">
        Three timestamps that tell you whether the agent is actually running. <em>Cron last ran</em> should be under an hour. <em>Last attempt</em> is the most-recent <code>Run now</code> or cron-triggered run (overwritten on each new run, even if the run later crashes — so a click always leaves a fingerprint). <em>Last completed run</em> is the most recent row in the runs table that finished (success or error).
      </div>
      <div class="row mt-4 items-baseline">
        <div class="flex-1 text-sm">
          ${(() => {
            const now = Date.now();
            const cronAgeMin = lastCronRun > 0 ? Math.floor((now - lastCronRun) / 60_000) : null;
            const cronColor = cronAgeMin == null
              ? "text-zee-muted"
              : cronAgeMin < 75 ? "text-zee-primary"
              : cronAgeMin < 120 ? "text-[rgb(196,154,26)]"
              : "text-[rgb(180,60,60)]";
            const cronLine = cronAgeMin == null
              ? `<span class="text-zee-muted">no cron tick recorded yet</span>`
              : `<span class="${cronColor}">${cronAgeMin} min ago</span>`;

            let attemptLine = `<span class="text-zee-muted">no attempts recorded yet</span>`;
            if (lastRunAttempt) {
              const startedAgo = Math.floor((now - lastRunAttempt.started_at) / 1000);
              const startedLabel = startedAgo < 60 ? `${startedAgo}s ago` : `${Math.floor(startedAgo / 60)} min ago`;
              if (lastRunAttempt.outcome === "in_flight") {
                const stalled = startedAgo > 180; // 3 min — runs normally finish in 12-25s
                const tone = stalled ? "text-[rgb(180,60,60)]" : "text-zee-primary";
                const label = stalled ? "stalled" : "in flight";
                attemptLine = `<span class="${tone}">${label}</span> at <code class="tt">${escapeHtml(lastRunAttempt.last_step)}</code> · <a href="/admin/targets/${escapeHtml(lastRunAttempt.target_slug)}" class="text-zee-primary">${escapeHtml(lastRunAttempt.target_slug)}</a> · <span class="label-muted">${startedLabel} · ${escapeHtml(lastRunAttempt.triggered_by)}</span>`;
              } else if (lastRunAttempt.outcome === "success") {
                attemptLine = `<span class="text-zee-primary">success</span> · <a href="/admin/targets/${escapeHtml(lastRunAttempt.target_slug)}" class="text-zee-primary">${escapeHtml(lastRunAttempt.target_slug)}</a> · <span class="label-muted">${startedLabel} · ${escapeHtml(lastRunAttempt.triggered_by)}</span>`;
              } else {
                attemptLine = `<span class="text-[rgb(180,60,60)]">failed @ ${escapeHtml(lastRunAttempt.last_step)}</span> · <a href="/admin/targets/${escapeHtml(lastRunAttempt.target_slug)}" class="text-zee-primary">${escapeHtml(lastRunAttempt.target_slug)}</a> · <span class="label-muted">${startedLabel}</span>`;
              }
            }

            let completedLine = `<span class="text-zee-muted">no completed runs yet</span>`;
            if (lastCompletedRun) {
              const ago = Math.floor((now - lastCompletedRun.created_at) / 60_000);
              const agoLabel = ago < 1 ? "just now" : `${ago} min ago`;
              const dur = lastCompletedRun.duration_ms ? fmtDuration(lastCompletedRun.duration_ms) : "";
              const status = lastCompletedRun.status === "success"
                ? `<span class="text-zee-primary">success</span>`
                : `<span class="text-[rgb(180,60,60)]">error: ${escapeHtml((lastCompletedRun.error ?? "unknown").slice(0, 60))}</span>`;
              completedLine = `${status} · <span class="label-muted">${agoLabel}${dur ? ` · ${dur}` : ""}</span>`;
            }

            // Tavily gather funnel from the most recent run. Shows the
            // shape of "what we asked for → what survived each filter →
            // what reached the writer", so a thin section in a report is
            // diagnosable at a glance.
            let gatherLine = `<span class="text-zee-muted">no gather data yet</span>`;
            if (lastRunAttempt?.gather_stats) {
              const g = lastRunAttempt.gather_stats;
              if (g.tavily_queries > 0) {
                gatherLine = `Tavily <strong class="font-medium">${g.tavily_queries}q</strong> · <span class="tt">${g.tavily_raw}</span> raw → <span class="tt">${g.after_score_filter}</span> (score) → <span class="tt">${g.after_url_dedupe}</span> (URL) → <span class="tt">${g.after_title_dedupe}</span> (story) → <strong class="font-medium tt">${g.final_kept}</strong> final`;
              } else if (g.final_kept > 0) {
                gatherLine = `<span class="text-zee-muted">no Tavily this run · ${g.final_kept} sources from typed tools</span>`;
              }
            }

            return `
              <div class="grid gap-y-3" style="grid-template-columns: 170px 1fr;">
                <div class="label-muted">Cron last ran</div>
                <div>${cronLine}</div>
                <div class="label-muted">Last attempt</div>
                <div>${attemptLine}</div>
                <div class="label-muted">Last completed run</div>
                <div>${completedLine}</div>
                <div class="label-muted">Last run gather</div>
                <div class="text-sm">${gatherLine}</div>
              </div>`;
          })()}
        </div>
      </div>

      <div style="margin: 28px 0; border-top: 1px solid #D6CFC4;"></div>

      <div class="label-muted mb-2">Recall memory (Vectorize)</div>
      <div class="field-help" style="max-width: 64ch;">
        Each report is turned into a 768-number "fingerprint" by an embedding model and stored in a Vectorize index. When the agent writes a new report it asks Vectorize <em>"what past reports are most similar?"</em> and uses the answer as "you've already covered…" context, so future reports build on past ones instead of repeating them. Embedding is best-effort — a failure here never blocks a report from being written, it just means that report won't be recall-able. The recalled reports also become inline [N] citations in the new report's body, marked with 📚 in the Sources footer.
      </div>
      <div class="field-help mt-2" style="max-width: 64ch;">
        <span class="label-muted">Guardrails:</span>
        layer last 2 same-target reports for continuity · query top 10 semantic hits ·
        keep only similarity ≥ 0.65 · same-target first, cross-target as fallback ·
        cap at 5 recalled per run.
      </div>
      <div class="label-muted mt-5 mb-2">Embedding status</div>
      <div class="row items-baseline">
        <div class="flex-1">
          <div class="text-sm">
            ${embedLastError
              ? `<span class="text-[rgb(180,60,60)]">Last error: ${escapeHtml(embedLastError.message.slice(0, 90))}${embedLastError.message.length > 90 ? "…" : ""}</span>
                 <span class="label-muted ml-2">${escapeHtml(timeAgo(embedLastError.at))}</span>`
              : embedLastOkAt > 0
                ? `<span class="text-zee-primary">Last successful embed</span> <span class="label-muted">${escapeHtml(timeAgo(embedLastOkAt))}</span>`
                : `<span class="text-zee-muted">No embed attempted yet on this version.</span>`}
          </div>
          <div class="field-help mt-1">
            ${totalReports} report${totalReports === 1 ? "" : "s"} in D1. Backfill re-embeds every report (idempotent) — safe to click anytime.
          </div>
        </div>
        <div>
          <button id="backfill-memory-btn" type="button" class="btn btn-secondary"${totalReports === 0 ? " disabled" : ""}>Backfill memory</button>
          <div id="backfill-memory-result" class="field-help mt-1"></div>
        </div>
      </div>
    </details>

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

      $('search-tuning-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type=submit]');
        const result = $('search-tuning-result');
        const orig = btn.textContent;
        btn.disabled = true;
        result.textContent = '';
        try {
          const res = await fetch('/admin/settings', { method: 'POST', body: new FormData(e.target) });
          const d = await res.json().catch(() => ({}));
          if (!res.ok) {
            btn.textContent = 'Error';
            result.textContent = d.error || ('HTTP ' + res.status);
            return;
          }
          btn.textContent = 'Saved ✓';
          result.textContent = 'tavily_min_score = ' + (d.updated?.tavily_min_score ?? '?');
          setTimeout(() => location.reload(), 800);
        } catch (err) {
          btn.textContent = 'Error';
          result.textContent = String(err && err.message || err);
        } finally {
          setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
        }
      });

      $('backfill-memory-btn')?.addEventListener('click', async () => {
        const btn = $('backfill-memory-btn');
        const result = $('backfill-memory-result');
        btn.disabled = true;
        result.textContent = 'Embedding…';
        try {
          const res = await fetch('/admin/memory/backfill', { method: 'POST' });
          const d = await res.json();
          if (!res.ok) {
            result.textContent = d.error || ('HTTP ' + res.status);
            return;
          }
          const failTail = d.failed ? ' · ' + d.failed + ' failed' : '';
          result.textContent = 'Scanned ' + d.scanned + ' · embedded ' + d.embedded + failTail;
          setTimeout(() => location.reload(), 1500);
        } catch (err) {
          result.textContent = 'Failed: ' + (err && err.message || err);
        } finally {
          btn.disabled = false;
        }
      });

      $('gc-r2-btn').addEventListener('click', async () => {
        const btn = $('gc-r2-btn');
        const result = $('gc-r2-result');
        btn.disabled = true;
        result.textContent = 'Sweeping…';
        try {
          const res = await fetch('/admin/storage/gc', { method: 'POST' });
          const d = await res.json();
          if (!res.ok) {
            result.textContent = d.error || ('HTTP ' + res.status);
            return;
          }
          const fails = d.failures && d.failures.length ? ' · ' + d.failures.length + ' failed' : '';
          result.textContent = 'Scanned ' + d.scanned + ' · ' + d.orphans + ' orphans · deleted ' + d.deleted + fails;
          if (d.deleted > 0 || (d.failures && d.failures.length)) setTimeout(() => location.reload(), 1200);
        } catch (err) {
          result.textContent = 'Failed: ' + (err && err.message || err);
        } finally {
          btn.disabled = false;
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
        <details class="card px-5 py-4" ${s.slug ? "" : "open"}>
          <summary class="cursor-pointer list-none flex flex-wrap justify-between items-baseline gap-3">
            <span>
              <strong class="font-medium">${escapeHtml(s.name)}</strong>
              <span class="badge badge-${s.author} ml-2">${s.author}</span>
              <a href="/skill/${escapeHtml(s.slug)}" class="ml-2 text-xs text-zee-primary">public →</a>
            </span>
            <span class="label-muted">used ${s.used_count}× · ${escapeHtml(timeAgo(s.updated_at))}</span>
          </summary>
          <form method="post" action="/admin/skills/${escapeHtml(s.slug)}/update" class="mt-4">
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
              <textarea name="procedure_md" class="min-h-[280px] font-mono text-[13px]">${escapeHtml(s.procedure_md)}</textarea>
            </div>
            <div class="row">
              <button class="btn" type="submit">Save changes</button>
              <button type="button" class="btn btn-danger" onclick="if(confirm('Delete this skill?')){fetch('/admin/skills/${escapeHtml(s.slug)}/delete',{method:'POST'}).then(()=>location.reload())}">Delete skill</button>
            </div>
          </form>
        </details>
      `).join("");

  const body = `
    <section class="pt-6 pb-2">
      <p class="label">Admin</p>
      <h1 class="headline mt-2 text-[32px]">Skills.</h1>
      <p class="subhead">The agent's library of reusable research procedures. Each skill is a markdown document — write it yourself or let the agent synthesise one from a brief.</p>
    </section>

    <div class="card">
      <div class="h3-row"><h3>Synthesise a skill</h3></div>
      <p class="field-help mb-3">Describe what the skill should do in one paragraph. The agent will write the procedure document for you and pick which <a href="/admin/tools" class="text-zee-primary">tools</a> to use (Tavily web search, HM Land Registry sold prices, ONS postcode context, data.police.uk crime stats, Companies House) based on what the brief implies.</p>
      <form method="post" action="/admin/skills">
        <input type="hidden" name="mode" value="synthesize">
        <div class="field">
          <label>Name <span class="font-normal normal-case tracking-normal">(optional)</span></label>
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
      <p class="field-help mb-3">Optional tool headers you can declare in the markdown (all defaults are sensible). A skill may declare one or more tools (one of each): <code>**Tavily op:** search|extract</code>, <code>**Land Registry op:** sold-prices</code>, <code>**ONS op:** context</code>, <code>**Police op:** crimes</code>, <code>**Companies House op:** search|by-postcode</code>. Per-tool params (e.g. <code>**Months:** 6</code>, <code>**Search topic:** news</code>) live underneath. Full catalog with every header: <a href="/admin/tools" class="text-zee-primary">/admin/tools</a>.</p>
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
          <textarea name="procedure_md" required class="min-h-[240px] font-mono text-[13px]" placeholder="# Skill name

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

export async function renderAdminTargetEdit(env: Env, slug: string, queued = false): Promise<string> {
  const target = await getTargetBySlug(env, slug);
  if (!target) {
    return shell("Not found", `<section class="py-20 text-center"><h1 class="headline">No such target.</h1></section>`, { adminFooter: true });
  }
  const skills = await listSkills(env);
  const activityRows = await env.DB.prepare(
    `SELECT runs.*,
            reports.title         AS report_title,
            reports.word_count    AS report_word_count,
            reports.chat_model    AS report_chat_model,
            reports.sources_json  AS report_sources_json,
            skills.name           AS skill_name,
            skills.slug           AS skill_slug
       FROM runs
       LEFT JOIN reports ON runs.report_id = reports.id
       LEFT JOIN skills  ON runs.skill_id  = skills.id
       WHERE runs.target_id = ?
       ORDER BY runs.created_at DESC
       LIMIT 20`,
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

  /** Wraps a meta item as a proper flex child so gap-x spacing applies.
   *  Each entry becomes a <span>; the joiner is a faint "·" with its own
   *  margin so adjacent items don't visually glue together. */
  const metaSep = `<span class="text-zee-border" aria-hidden="true">·</span>`;
  const wrapMeta = (inner: string, extraClass = "") =>
    `<span class="${extraClass}">${inner}</span>`;

  const activityList = (activityRows.results ?? []).length === 0
    ? `<div class="empty">No activity yet.</div>`
    : `<ul class="list-none divide-y divide-[rgba(232,228,222,0.6)]">${(activityRows.results ?? []).map((r: any) => {
        const isSuccess = r.status === "success" && r.report_id;
        const skillLabel = r.skill_name
          ? `<a href="/skill/${escapeHtml(r.skill_slug)}" class="text-zee-primary hover:underline" onclick="event.stopPropagation()">${escapeHtml(r.skill_name)}</a>`
          : `<span class="label-muted">(deleted skill)</span>`;

        const metaParts: string[] = [
          wrapMeta(escapeHtml(timeAgo(r.created_at)), "tt"),
          wrapMeta(skillLabel),
          wrapMeta(escapeHtml(r.triggered_by)),
        ];
        if (isSuccess) {
          if (r.report_word_count != null) {
            metaParts.push(wrapMeta(`${r.report_word_count.toLocaleString()} words`));
          }
          if (r.report_chat_model) {
            metaParts.push(wrapMeta(escapeHtml(chatModelShortLabel(r.report_chat_model))));
          }
          // Visibility into what context the writer had: count web sources
          // vs archive (prior-report) sources from the persisted citations.
          if (r.report_sources_json) {
            try {
              const cites = JSON.parse(r.report_sources_json) as Array<{ kind?: string }>;
              if (Array.isArray(cites) && cites.length > 0) {
                const archive = cites.filter((c) => c?.kind === "archive").length;
                const web = cites.length - archive;
                const parts: string[] = [];
                if (web > 0) parts.push(`${web} web`);
                if (archive > 0) parts.push(`${archive} 📚`);
                if (parts.length) metaParts.push(wrapMeta(parts.join(" + ") + " sources"));
              }
            } catch { /* malformed JSON — just skip */ }
          }
        }
        if (r.duration_ms) metaParts.push(wrapMeta(escapeHtml(fmtDuration(r.duration_ms)), "tt"));
        if (isSuccess) {
          metaParts.push(
            `<a href="/report/${escapeHtml(r.report_id)}" class="text-zee-primary hover:underline">view report →</a>`,
          );
        }

        const metaLine = `
          <div class="field-help mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            ${metaParts.join(metaSep)}
          </div>`;

        if (isSuccess) {
          return `
            <li class="py-4 flex items-start gap-3.5">
              <span class="activity-dot activity-dot--ok" aria-hidden="true">✓</span>
              <div class="flex-1 min-w-0">
                <a href="/report/${escapeHtml(r.report_id)}" class="text-sm font-medium text-zee-text hover:text-zee-primary block leading-snug">
                  ${escapeHtml(r.report_title ?? "Untitled report")}
                </a>
                ${metaLine}
              </div>
              <form method="post" action="/admin/reports/${escapeHtml(r.report_id)}/delete" class="inline shrink-0" onsubmit="return confirm('Delete this report? R2 file, recall vector, and this activity entry all go too.')">
                <button class="btn btn-danger btn-sm" type="submit">Delete</button>
              </form>
            </li>`;
        }
        // Failure path: no report, no view, no delete. The error message is
        // tagged with the step it failed at (e.g. "gather: Tavily timeout"),
        // so we split that off and render it as a small badge.
        const errFull = r.error ?? "Unknown error";
        const stepMatch = errFull.match(/^(init|plan|gather|recall|write|persist|done):\s*(.*)$/s);
        const failedStep = stepMatch?.[1];
        const errBody = stepMatch ? stepMatch[2] : errFull;
        const errShort = errBody.length > 120 ? errBody.slice(0, 120) + "…" : errBody;
        const titleLine = failedStep
          ? `Run failed at <code class="tt font-mono text-[rgb(180,60,60)]">${failedStep}</code>`
          : `Run failed`;
        return `
          <li class="py-4 flex items-start gap-3.5">
            <span class="activity-dot activity-dot--err" aria-hidden="true">✕</span>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-zee-text leading-snug">${titleLine}</div>
              ${metaLine}
              <div class="field-help mt-2 text-[rgb(180,60,60)] break-words leading-relaxed" title="${escapeHtml(errFull)}">
                ${escapeHtml(errShort)}
              </div>
            </div>
          </li>`;
      }).join("")}</ul>`;

  const body = `
    <section class="pt-6 pb-2">
      <p class="label"><a href="/admin" class="text-inherit">← Admin</a></p>
      <h1 class="headline mt-2">${escapeHtml(target.name)}</h1>
      <p class="subhead">${target.description ? escapeHtml(target.description) : `<em class="text-zee-muted">No description</em>`}</p>
      <div class="flex flex-wrap items-center gap-3 mt-3.5">
        <span class="badge badge-${target.status}">${target.status}</span>
        ${target.kind ? `<span class="label-muted">${escapeHtml(target.kind)}</span>` : ""}
        <span class="label-muted">${target.last_run_at ? `last run ${escapeHtml(timeAgo(target.last_run_at))}` : "never run"}</span>
        ${target.next_run_at && target.status === "active" ? `<span class="label-muted">next ${escapeHtml(timeUntil(target.next_run_at))}</span>` : ""}
        <a href="/target/${escapeHtml(target.slug)}" class="ml-auto text-[13px] text-zee-primary">View public page →</a>
      </div>
    </section>

    ${queued ? `
    <div class="card" style="border-color:#1A6B62;background:rgba(26,107,98,0.06);">
      <p class="text-zee-primary text-sm m-0">
        <strong>Run queued.</strong> Reports take ~20–30 seconds to complete. Refresh this page in 30 seconds to see the new entry in <em>Reports</em> and <em>Run history</em>. If nothing appears after a minute, check the Worker logs or the AI Gateway dashboard for errors.
      </p>
    </div>
    ` : ""}

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Configure</h3>
          <span class="chev">▾</span>
        </div>
      </summary>
      <form id="update-target-form" method="post" action="/admin/targets/${escapeHtml(target.slug)}/update">
        <div class="field">
          <label>Kind</label>
          <input name="kind" value="${escapeHtml(target.kind ?? "")}">
        </div>
        <div class="field">
          <label>Description</label>
          <input name="description" value="${escapeHtml(target.description ?? "")}" maxlength="400">
        </div>
        <div class="row gap-4">
          <div class="field flex-1 mb-0">
            <label>Status</label>
            <select name="status">
              <option value="active"${target.status === "active" ? " selected" : ""}>active</option>
              <option value="paused"${target.status === "paused" ? " selected" : ""}>paused</option>
              <option value="archived"${target.status === "archived" ? " selected" : ""}>archived</option>
            </select>
          </div>
          <div class="field flex-1 mb-0">
            <label>Cadence</label>
            <select name="cadence_hours">${cadenceOptions}</select>
          </div>
          <div class="field flex-[2] mb-0">
            <label>Primary skill</label>
            <select name="skill_slug">${skillOptions}</select>
          </div>
        </div>
      </form>

      <div class="row gap-3 mt-4 items-center">
        <button class="btn" type="submit" form="update-target-form">Save</button>
        <form method="post" action="/admin/targets/${escapeHtml(target.slug)}/run" class="inline">
          <button class="btn btn-secondary" type="submit"${target.primary_skill_id ? "" : " disabled"}>Run now</button>
        </form>
        <form method="post" action="/admin/targets/${escapeHtml(target.slug)}/delete" class="inline ml-auto" onsubmit="return confirm('Delete this target and all its reports?')">
          <button class="btn btn-danger" type="submit">Delete target</button>
        </form>
      </div>
    </details>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Activity</h3>
          <span class="text-xs">
            <a href="/target/${escapeHtml(target.slug)}" class="text-zee-primary" onclick="event.stopPropagation()">all reports →</a>
            <span class="label-muted ml-2">${(activityRows.results ?? []).length} shown</span>
            <span class="chev">▾</span>
          </span>
        </div>
      </summary>
      ${activityList}
    </details>
  `;
  return shell(`${target.name} · Admin`, body, { activeNav: "admin", adminFooter: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: tools catalog — read-only registry of what skills can call
// ─────────────────────────────────────────────────────────────────────────────

export function renderAdminTools(): string {
  const cards = Object.values(TOOLS).map((tool) => {
    const opRows = Object.entries(tool.operations).map(([opName, op]) => `
      <tr>
        <td class="whitespace-nowrap align-top pr-3 py-2 font-mono text-[13px] text-zee-primary">${escapeHtml(tool.slug)} (${escapeHtml(opName)})</td>
        <td class="align-top py-2 text-sm text-zee-text">
          <div>${escapeHtml(op.description)}</div>
          <div class="field-help mt-1"><em>When to use:</em> ${escapeHtml(op.when_to_use)}</div>
        </td>
      </tr>
    `).join("");

    const headerRows = tool.headers.map((h) => `
      <tr>
        <td class="whitespace-nowrap align-top pr-3 py-1 font-mono text-[13px] text-zee-primary">**${escapeHtml(h.key)}:**</td>
        <td class="align-top py-1 text-sm text-zee-text">${escapeHtml(h.values)}</td>
      </tr>
    `).join("");

    return `
      <div class="card">
        <div class="h3-row"><h3>${escapeHtml(tool.display)}</h3></div>
        <p class="field-help mb-3">${escapeHtml(tool.summary)}</p>
        <h4 class="text-[13px] uppercase tracking-wider text-zee-muted mt-2 mb-1">Operations</h4>
        <table class="w-full border-collapse"><tbody>${opRows}</tbody></table>
        <h4 class="text-[13px] uppercase tracking-wider text-zee-muted mt-4 mb-1">Skill markdown headers</h4>
        <table class="w-full border-collapse"><tbody>${headerRows}</tbody></table>
      </div>
    `;
  }).join("");

  const body = `
    <section class="pt-6 pb-2">
      <p class="label">Admin</p>
      <h1 class="headline mt-2 text-[32px]">Tools.</h1>
      <p class="subhead">What skills can call. The agent uses this registry when synthesising new skills. A skill may declare one or more tools (one of each) via headers in its procedure markdown. To add a tool, edit <code>TOOLS</code> in <code>src/apis.ts</code> — code + metadata live together so they can't drift apart.</p>
    </section>

    ${cards}
  `;
  return shell("Tools · WatchOMacho", body, { activeNav: "tools", adminFooter: true });
}
