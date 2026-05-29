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
  getSkillTargetCounts,
  getTargetBySlug,
  listReportsForTarget,
  listSkills,
  listTargets,
  reportUrlParts,
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

/** Compact "14:23 · 19 May" used in dense lists where you want both the
 *  relative time AND the absolute clock. The full ISO timestamp is
 *  available on hover via the parent element's `title` attribute. */
function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const hhmm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${hhmm} · ${day}`;
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

/** Render a target's schedule in plain English from its cadence + anchor.
 *  Used on the configure card header and the targets list row so the
 *  user doesn't have to combine "every 12 hours" + "anchor 2" in their
 *  head. Examples:
 *    cadence=24, anchor=2   → "Daily at 02:00 UTC"
 *    cadence=12, anchor=2   → "2× per day at 02:00 and 14:00 UTC"
 *    cadence=6,  anchor=2   → "4× per day at 02:00, 08:00, 14:00, 20:00 UTC"
 *    cadence=1,  anchor=*   → "Every hour"
 *    cadence=72, anchor=2   → "Every 3 days at 02:00 UTC"
 *    cadence=168, anchor=2  → "Weekly at 02:00 UTC"
 *  `anchor === null` falls back to the worker default (02:00 UTC). */
function describeSchedule(cadenceHours: number, anchorHourUtc: number | null): string {
  const pad = (h: number) => String(h).padStart(2, "0") + ":00";
  const anchor = anchorHourUtc ?? 2; // matches DEFAULT_ANCHOR_HOUR_UTC in agent.ts
  if (cadenceHours === 1) return "Every hour";
  if (cadenceHours === 168) return `Weekly at ${pad(anchor)} UTC`;
  if (cadenceHours === 72) return `Every 3 days at ${pad(anchor)} UTC`;
  if (24 % cadenceHours === 0) {
    const runsPerDay = 24 / cadenceHours;
    if (runsPerDay === 1) return `Daily at ${pad(anchor)} UTC`;
    // Walk the slot pattern from anchor, wrap mod 24, then sort
    // ascending so the rendered list reads in clock order.
    const slots: number[] = [];
    let h = anchor;
    for (let i = 0; i < runsPerDay; i++) {
      slots.push(h);
      h = (h + cadenceHours) % 24;
    }
    slots.sort((a, b) => a - b);
    const formatted = slots.map(pad).join(", ");
    return `${runsPerDay}× per day at ${formatted} UTC`;
  }
  // Cadence that doesn't divide 24 evenly: fall back to a literal description.
  return `Every ${cadenceHours}h from ${pad(anchor)} UTC`;
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
<link rel="stylesheet" href="/static/tailwind.v4.css">
</head>
<body>
<header class="site-header">
  <div class="wrap site-header-inner">
    <a href="/" class="brand">WatchOMacho</a>
    <nav class="nav">
      ${isAdmin
        ? `${navLink("/admin", "Admin", "admin")} ${navLink("/admin/targets", "Targets", "targets")} ${navLink("/admin/skills", "Skills", "skills")} ${navLink("/admin/tools", "Tools", "tools")} <form method="post" action="/admin/logout" class="inline ml-2"><button class="btn btn-secondary px-2.5 py-1 text-[11px]">Logout</button></form>`
        : `${navLink("/", "Targets", "home")} ${navLink("/admin/login", "Admin", "admin")}`}
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

  // Public target page meta is intentionally minimal: only what a reader of
  // the reports cares about. Internal scheduling (cadence, next run, status,
  // attached skill slug) is admin information and stays on /admin/targets/:slug.
  const meta = `
    <div class="flex flex-wrap items-center gap-3 mt-3">
      ${target.kind ? `<span class="label-muted">${escapeHtml(target.kind)}</span>` : ""}
      ${reports[0]
        ? `<span class="label-muted">last update ${escapeHtml(timeAgo(reports[0].created_at))}</span>`
        : ""}
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
      const rp = reportUrlParts(r);
      body += `
        <a class="piece" href="/report/${rp.date}/${escapeHtml(rp.slug)}">
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

  return shell(`${target.name} — WatchOMacho`, body, { activeNav: "home" });
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

  // Strip everything that would visually duplicate the page header:
  //  - leading H1 (title sits in our own header above)
  //  - italic "Target / Generated" frontmatter lines (now redundant with
  //    the page header's date row)
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

  // Paired day-map (v14). The day-map is LLM-authored interactive HTML, so it
  // is embedded inside a SANDBOXED iframe (allow-scripts only — no
  // allow-same-origin) so its script is caged away from this page's origin.
  // The /day-map route additionally serves it under a no-network CSP.
  // Omitted entirely when the run produced no day-map. Pretty URL (date/slug)
  // so the embed loads directly without a redirect hop.
  const dmParts = reportUrlParts(report);
  const dayMapUrl = `/day-map/${dmParts.date}/${escapeHtml(dmParts.slug)}`;
  const dayMapHtml = report.day_map_r2_key
    ? `
    <figure class="mt-8 mb-2">
      <figcaption class="label mb-2 flex items-center gap-3">
        <span>Map of the day</span>
        <a href="${dayMapUrl}" class="text-zee-primary normal-case tracking-normal font-normal" target="_blank" rel="noopener">open day-map ↗</a>
      </figcaption>
      <iframe id="day-map-frame" src="${dayMapUrl}" title="Map of the day"
              sandbox="allow-scripts"
              class="w-full rounded-xl border border-zee-border bg-white"
              style="height:600px;border-width:1px" loading="lazy"></iframe>
    </figure>
    <script>
      (function(){
        var f=document.getElementById('day-map-frame');
        if(!f)return;
        // The day-map posts its content height (it's a sandboxed cross-origin
        // frame, so we can't read it directly). Grow the frame to fit so there
        // is no inner scrollbar.
        addEventListener('message',function(e){
          if(e.source!==f.contentWindow)return;
          var d=e.data;
          if(d&&d.type==='day-map-height'){
            var h=Math.max(300,Math.min(15000,parseInt(d.height,10)||0));
            f.style.height=h+'px';
          }
        });
      })();
    </script>`
    : "";

  // Public report page meta is intentionally minimal — date + word count.
  // Skill, model, runtime, and the Tavily gather funnel are admin-only
  // diagnostics and live on /admin instead.
  const body = `
    <section class="pt-8 pb-4">
      <p class="label">${target ? `<a href="/target/${escapeHtml(target.slug)}" class="text-inherit">${escapeHtml(target.name)}</a>` : "Report"}</p>
      <h1 class="headline mt-2">${escapeHtml(report.title)}</h1>
      <div class="flex flex-wrap gap-3 mt-3.5">
        <span class="label-muted">${escapeHtml(formatDate(report.created_at))}</span>
        <span class="label-muted">${report.word_count ?? 0} words</span>
      </div>
    </section>
    <article class="prose pt-6 pb-2">${html}</article>
    ${dayMapHtml}
    ${sourcesHtml}
    <div class="pb-12"></div>
  `;
  return shell(`${report.title} — WatchOMacho`, body);
}

/** Render the Tavily gather funnel ("200 raw → 122 score → 111 url → 111
 *  story → 100 final") as compact inline HTML. Returns empty string if the
 *  input is null / missing / malformed / shows no Tavily activity, so the
 *  caller can include it unconditionally without spurious blank rows. */
function renderGatherFunnel(json: string | null | undefined): string {
  if (!json) return "";
  try {
    const g = JSON.parse(json) as {
      tavily_queries?: number; tavily_raw?: number; after_score_filter?: number;
      after_url_dedupe?: number; after_title_dedupe?: number; final_kept?: number;
      tavily_credits?: number;
    };
    if (!g.tavily_queries || g.tavily_queries === 0) {
      if (g.final_kept && g.final_kept > 0) {
        return `<span class="text-zee-muted">no Tavily · ${g.final_kept} sources from typed tools</span>`;
      }
      return "";
    }
    // Each chunk wrapped in its own span so neighboring text + arrows keep
    // visible whitespace even when the parent flex/wrap rules kick in.
    const sep = `<span class="mx-1.5 text-zee-border" aria-hidden="true">·</span>`;
    const arrow = `<span class="mx-1.5 text-zee-border" aria-hidden="true">→</span>`;
    const creditsTag = g.tavily_credits && g.tavily_credits > 0
      ? `${sep}<span class="tt text-zee-muted">${g.tavily_credits} credits</span>`
      : "";
    return `<span>Tavily <strong class="font-medium text-zee-text">${g.tavily_queries}q</strong></span>${creditsTag}${sep}`
      + `<span class="tt">${g.tavily_raw} raw</span>${arrow}`
      + `<span class="tt">${g.after_score_filter} (score)</span>${arrow}`
      + `<span class="tt">${g.after_url_dedupe} (URL)</span>${arrow}`
      + `<span class="tt">${g.after_title_dedupe} (story)</span>${arrow}`
      + `<strong class="font-medium tt text-zee-text">${g.final_kept} final</strong>`;
  } catch {
    return "";
  }
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
// Admin: system heartbeat — 24h digest + recent run mini-list. Replaces the
// older "last attempt + last completed" two-row view (those duplicated each
// other anyway). The in-flight banner is rendered separately at the top so
// you can see active work even before it finishes.
// ─────────────────────────────────────────────────────────────────────────────

interface HeartbeatInput {
  lastCronRun: number;
  lastRunAttempt: {
    run_id: string;
    target_slug: string;
    triggered_by: "cron" | "manual";
    started_at: number;
    last_step: string;
    completed_at: number | null;
    outcome: "in_flight" | "success" | "error";
    error?: string;
  } | null;
  last24hStats: { total: number; ok: number; err: number; avg_ms: number | null } | null;
  recentRuns: Array<{
    id: string;
    status: string;
    error: string | null;
    duration_ms: number | null;
    created_at: number;
    report_id: string | null;
    target_slug: string | null;
    target_name: string | null;
  }>;
  /** Slugs of targets that currently exist. Deleted-target slugs persist in
   *  last_run_attempt; we render those as "(deleted)" rather than dead links. */
  knownTargetSlugs: Set<string>;
}

function renderHeartbeatCard({ lastCronRun, lastRunAttempt, last24hStats, recentRuns, knownTargetSlugs }: HeartbeatInput): string {
  const now = Date.now();

  // ─── Cron status (still the first thing — tells you the scheduler's alive) ─
  const cronAgeMin = lastCronRun > 0 ? Math.floor((now - lastCronRun) / 60_000) : null;
  const cronColor = cronAgeMin == null
    ? "text-zee-muted"
    : cronAgeMin < 75 ? "text-zee-primary"
    : cronAgeMin < 120 ? "text-[rgb(196,154,26)]"
    : "text-[rgb(180,60,60)]";
  // Cron fires at minute 0 of every hour (cron expression "0 * * * *").
  // Compute the next fire clock-time AND minutes-until so the line reads
  // "48m ago · next at 18:00 (in 12m)" — both anchored to the wall clock
  // (so "12m" makes sense at a glance) and to the elapsed window.
  const nextCronD = new Date(now);
  nextCronD.setMinutes(0, 0, 0);
  nextCronD.setHours(nextCronD.getHours() + 1);
  const minsToNextCron = Math.max(1, Math.round((nextCronD.getTime() - now) / 60_000));
  const nextCronClock = nextCronD.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const cronLine = cronAgeMin == null
    ? `<span class="text-zee-muted">no cron tick recorded yet</span>`
    : `<span class="${cronColor} font-medium">${timeAgo(lastCronRun)}</span> <span class="text-zee-muted">· next at <span class="tt text-zee-text">${nextCronClock}</span> (in ${minsToNextCron}m)</span>`;

  // ─── In-flight banner (only when a run is currently running). The runs
  //     table only has completed rows, so this is the only signal that work
  //     is happening RIGHT NOW. ────────────────────────────────────────────
  let inFlightBanner = "";
  if (lastRunAttempt && lastRunAttempt.outcome === "in_flight") {
    const startedAgo = Math.floor((now - lastRunAttempt.started_at) / 1000);
    const startedLabel = startedAgo < 60 ? `${startedAgo}s ago` : timeAgo(lastRunAttempt.started_at);
    const slug = lastRunAttempt.target_slug;
    const targetExists = knownTargetSlugs.has(slug);
    const stalled = startedAgo > 180;
    const tone = stalled ? "text-[rgb(180,60,60)]" : "text-zee-primary";
    const label = stalled ? "stalled" : "in flight";
    const targetRef = targetExists
      ? `<a href="/admin/targets/${escapeHtml(slug)}" class="text-zee-primary hover:underline">${escapeHtml(slug)}</a>`
      : `<span class="text-zee-muted">${escapeHtml(slug)} <em>(deleted)</em></span>`;
    inFlightBanner = `
      <div class="mt-3 rounded border border-zee-primary/40 bg-zee-primary/5 px-3 py-2 text-sm">
        <span class="${tone} font-medium">${label}</span>
        at <code class="tt">${escapeHtml(lastRunAttempt.last_step)}</code> ·
        ${targetRef} ·
        <span class="text-zee-muted">${startedLabel} · ${escapeHtml(lastRunAttempt.triggered_by)}</span>
      </div>`;
  }

  // ─── Last 24h digest ──────────────────────────────────────────────────────
  const s = last24hStats ?? { total: 0, ok: 0, err: 0, avg_ms: null };
  const avg = s.avg_ms ? fmtDuration(Math.round(s.avg_ms)) : null;
  const digestBits: string[] = [
    `<strong class="font-medium text-zee-text">${s.total}</strong> ${s.total === 1 ? "run" : "runs"}`,
  ];
  if (s.ok > 0) digestBits.push(`<span class="text-zee-primary"><strong class="font-medium">${s.ok}</strong> ✓</span>`);
  if (s.err > 0) digestBits.push(`<span class="text-[rgb(180,60,60)]"><strong class="font-medium">${s.err}</strong> ✕</span>`);
  if (avg) digestBits.push(`<span class="text-zee-muted">avg ${avg}</span>`);
  const digestLine = digestBits.join(`<span class="mx-2.5 text-zee-border" aria-hidden="true">·</span>`);

  // ─── Recent runs mini-list (last 6). Clickable rows → target page. ───────
  const recentList = recentRuns.length === 0
    ? `<div class="text-sm text-zee-muted">No runs yet.</div>`
    : `<ul class="list-none mt-2 divide-y divide-zee-border">${recentRuns.map((r) => {
        const slug = r.target_slug;
        const targetExists = !!slug && knownTargetSlugs.has(slug);
        const targetLabel = r.target_name ?? slug ?? "(deleted target)";
        const targetRef = targetExists
          ? `<a href="/admin/targets/${escapeHtml(slug!)}" class="text-zee-text font-medium hover:text-zee-primary transition-colors">${escapeHtml(targetLabel)}</a>`
          : `<span class="text-zee-muted italic">${escapeHtml(targetLabel)} (deleted)</span>`;
        const dot = r.status === "success"
          ? `<span class="text-zee-primary">✓</span>`
          : `<span class="text-[rgb(180,60,60)]">✕</span>`;
        const dur = r.duration_ms ? fmtDuration(r.duration_ms) : "";
        const errSnippet = r.status !== "success" && r.error
          ? ` · <span class="text-[rgb(180,60,60)]">${escapeHtml(r.error.replace(/^(init|plan|gather|recall|write|persist|done):\s*/, "").slice(0, 50))}</span>`
          : "";
        const fullIso = new Date(r.created_at).toISOString();
        return `
          <li class="py-2.5 flex items-center gap-3">
            ${dot}
            <div class="flex-1 min-w-0">
              ${targetRef}
              <span class="text-zee-muted text-sm ml-2" title="${escapeHtml(fullIso)}">
                <span class="tt">${timeAgo(r.created_at)}</span>
                <span class="mx-1.5 text-zee-border">·</span>
                <span class="tt">${formatDateTime(r.created_at)}</span>${dur ? ` <span class="mx-1.5 text-zee-border">·</span> <span class="tt">${dur}</span>` : ""}${errSnippet}
              </span>
            </div>
          </li>`;
      }).join("")}</ul>`;

  return `
    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>System heartbeat</h3>
          <span class="label-muted">${cronAgeMin == null ? "no cron yet" : `cron ${timeAgo(lastCronRun)}`}<span class="chev">▾</span></span>
        </div>
      </summary>
      <div class="field-help mt-3" style="max-width: 70ch;">
        Cron health, a digest of the last 24 hours, and the most recent runs across all targets. Click any row to jump to that target's activity.
      </div>
      ${inFlightBanner}
      <div class="mt-4 grid gap-y-3" style="grid-template-columns: 140px 1fr;">
        <div class="label-muted">Cron</div>
        <div class="text-sm">${cronLine}</div>
        <div class="label-muted">Last 24h</div>
        <div class="text-sm">${digestLine}</div>
      </div>
      <div class="mt-4 label-muted">Recent runs</div>
      ${recentList}
    </details>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: overview panel
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminPanel(env: Env): Promise<string> {
  const cutoff24h = Date.now() - 24 * 3600 * 1000;
  const [targets, skills, usage, reportLim, searchLim, perTick, currentChatModel, r2Stats, embedLastOkStr, embedLastErrorRaw, totalReportsRow, lastCronRunStr, lastRunAttemptRaw, last24hStats, recentRuns, maxCharsPerSourceStr, maxRunSecondsStr, writerMaxTokensStr, dayMapEnabledStr, dayMapLastOkStr, dayMapLastErrorRaw] = await Promise.all([
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
    env.DB.prepare(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS ok,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS err,
          AVG(duration_ms) AS avg_ms
        FROM runs WHERE created_at > ?`,
    ).bind(cutoff24h).first<{ total: number; ok: number; err: number; avg_ms: number | null }>(),
    env.DB.prepare(
      `SELECT runs.id, runs.status, runs.error, runs.duration_ms, runs.created_at, runs.report_id,
              targets.slug AS target_slug, targets.name AS target_name
         FROM runs
         LEFT JOIN targets ON targets.id = runs.target_id
         ORDER BY runs.created_at DESC LIMIT 6`,
    ).all<{ id: string; status: string; error: string | null; duration_ms: number | null; created_at: number; report_id: string | null; target_slug: string | null; target_name: string | null }>(),
    getSetting(env, "max_chars_per_source", "4000"),
    getSetting(env, "max_run_seconds", "90"),
    getSetting(env, "writer_max_tokens", "2200"),
    getSetting(env, "day_map_enabled", "off"),
    getSetting(env, "day_map_last_ok_at", "0"),
    getSetting(env, "day_map_last_error", ""),
  ]);
  const dayMapEnabled = dayMapEnabledStr === "on";
  const maxCharsPerSource = (() => {
    const n = parseInt(maxCharsPerSourceStr, 10);
    return Number.isFinite(n) && n >= 200 && n <= 8000 ? n : 4000;
  })();
  const maxRunSeconds = (() => {
    const n = parseInt(maxRunSecondsStr, 10);
    return Number.isFinite(n) && n >= 5 && n <= 600 ? n : 90;
  })();
  const writerMaxTokens = (() => {
    const n = parseInt(writerMaxTokensStr, 10);
    return Number.isFinite(n) && n >= 200 && n <= 16000 ? n : 2200;
  })();
  const embedLastOkAt = parseInt(embedLastOkStr, 10) || 0;
  const embedLastError: { message: string; at: number; report_id?: string } | null =
    embedLastErrorRaw ? (() => { try { return JSON.parse(embedLastErrorRaw); } catch { return null; } })() : null;
  const dayMapLastOkAt = parseInt(dayMapLastOkStr, 10) || 0;
  const dayMapLastError: { message: string; at: number; report_id?: string } | null =
    dayMapLastErrorRaw ? (() => { try { return JSON.parse(dayMapLastErrorRaw); } catch { return null; } })() : null;
  const totalReports = totalReportsRow?.n ?? 0;
  const lastCronRun = parseInt(lastCronRunStr, 10) || 0;
  type GatherStats = { tavily_queries: number; tavily_raw: number; after_score_filter: number; after_url_dedupe: number; after_title_dedupe: number; final_kept: number; tavily_credits: number };
  type LastRunAttempt = { run_id: string; target_slug: string; triggered_by: "cron" | "manual"; started_at: number; last_step: string; completed_at: number | null; outcome: "in_flight" | "success" | "error"; error?: string; gather_stats?: GatherStats };
  const lastRunAttempt: LastRunAttempt | null = lastRunAttemptRaw
    ? (() => { try { return JSON.parse(lastRunAttemptRaw); } catch { return null; } })()
    : null;

  const modelOptions = ALLOWED_CHAT_MODELS.map((m) =>
    `<option value="${escapeHtml(m)}"${m === currentChatModel ? " selected" : ""}>${escapeHtml(CHAT_MODEL_LABELS[m] ?? m)}</option>`,
  ).join("");

  const active = targets.filter((t) => t.status === "active");
  const otherCount = targets.length - active.length;
  const dueNow = active.filter((t) => t.next_run_at && t.next_run_at <= Date.now() && t.primary_skill_id);

  const body = `
    <section class="pt-6 pb-3">
      <p class="label">Admin</p>
      <h1 class="headline mt-2 text-[32px]">Console.</h1>
      <p class="subhead">
        <a href="/admin/targets" class="text-zee-text hover:text-zee-primary transition-colors"><strong>${active.length}</strong> active</a>${otherCount > 0 ? ` · <a href="/admin/targets" class="text-zee-muted hover:text-zee-primary transition-colors"><strong>${otherCount}</strong> paused/archived</a>` : ""}${dueNow.length ? ` · <strong class="text-zee-primary">${dueNow.length}</strong> due now` : ""} · <a href="/admin/skills" class="text-zee-text hover:text-zee-primary transition-colors"><strong>${skills.length}</strong> ${skills.length === 1 ? "skill" : "skills"}</a>.
      </p>
    </section>

    ${renderHeartbeatCard({ lastCronRun, lastRunAttempt, last24hStats, recentRuns: recentRuns.results ?? [], knownTargetSlugs: new Set(targets.map((t) => t.slug)) })}

    <details class="card">
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
        <div class="field mb-4">
          <label>Daily day-map (default)</label>
          <select name="day_map_enabled">
            <option value="off"${dayMapEnabled ? "" : " selected"}>Off</option>
            <option value="on"${dayMapEnabled ? " selected" : ""}>On</option>
          </select>
          <div class="field-help">Global default. After each briefing, generate an interactive "map of the day" (self-contained HTML) with one extra LLM call. Per-target switches on the target page override this.</div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-4 mb-4">
          <div class="field mb-0">
            <label>Reports / day</label>
            <input type="number" name="daily_report_limit" min="0" max="10000" value="${escapeHtml(reportLim)}">
            <div class="field-help">${usage.reports} used today</div>
          </div>
          <div class="field mb-0">
            <label>Tavily credits / day</label>
            <input type="number" name="daily_search_limit" min="0" max="100000" value="${escapeHtml(searchLim)}">
            <div class="field-help">${usage.searches} used today</div>
          </div>
          <div class="field mb-0">
            <label>Max parallel runs</label>
            <input type="number" name="cron_max_per_tick" min="1" max="20" value="${escapeHtml(perTick)}">
            <div class="field-help">If several targets come due in the same hour, run at most this many at once. The rest wait for next hour. Leave at 2 unless you add lots of targets.</div>
          </div>
        </div>

        <div class="label-muted mt-2 mb-2">Run guardrails <span class="font-normal normal-case tracking-normal text-zee-muted">(worker-wide CPU + kill switches)</span></div>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-4 mb-2">
          <div class="field mb-0">
            <label>Max chars per source</label>
            <input type="number" name="max_chars_per_source" min="200" max="8000" step="100" value="${maxCharsPerSource}">
            <div class="field-help mt-1.5">How much of each source's text is sent to the writer. Default <strong>4000</strong>. Sonnet's 200k context can take <strong>8000</strong> easily.</div>
          </div>
          <div class="field mb-0">
            <label>Writer max tokens</label>
            <input type="number" name="writer_max_tokens" min="200" max="16000" step="100" value="${writerMaxTokens}">
            <div class="field-help mt-1.5">How long the report can be. Default <strong>2200</strong> (~1500 words). Raise for deeper reports — Sonnet 4.6 supports up to 16000 (~12000 words). Output tokens are the expensive half.</div>
          </div>
          <div class="field mb-0">
            <label>Max run seconds <span class="font-normal normal-case tracking-normal">(kill switch)</span></label>
            <input type="number" name="max_run_seconds" min="5" max="600" step="5" value="${maxRunSeconds}">
            <div class="field-help mt-1.5">Soft ceiling on a single run's wall-clock. Aborts hung fetches. Default <strong>90&nbsp;s</strong>. Hard ceiling is the 15-min DO alarm limit.</div>
          </div>
        </div>

        <div class="row mt-3.5">
          <button class="btn" type="submit">Save</button>
          <button id="cron-now-btn" type="button" class="btn btn-secondary">Run cron now</button>
          <span id="cron-result" class="text-xs text-zee-muted"></span>
        </div>
      </form>
    </details>

    <details class="card">
      <summary>
        <div class="h3-row">
          <h3>Memory &amp; cleanup</h3>
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

      <div class="label-muted mt-5 mb-2">Day-map status</div>
      <div class="text-sm">
        ${dayMapLastError
          ? `<span class="text-[rgb(180,60,60)]">Last error: ${escapeHtml(dayMapLastError.message.slice(0, 90))}${dayMapLastError.message.length > 90 ? "…" : ""}</span>
             <span class="label-muted ml-2">${escapeHtml(timeAgo(dayMapLastError.at))}</span>${dayMapLastError.report_id ? `<span class="label-muted ml-2">(${escapeHtml(dayMapLastError.report_id)})</span>` : ""}`
          : dayMapLastOkAt > 0
            ? `<span class="text-zee-primary">Last successful day-map</span> <span class="label-muted">${escapeHtml(timeAgo(dayMapLastOkAt))}</span>`
            : `<span class="text-zee-muted">No day-map generated yet on this version.</span>`}
      </div>
      <div class="field-help mt-1" style="max-width: 64ch;">
        Best-effort: a failed day-map (e.g. a transient <code>Anthropic 5xx</code>) never blocks the briefing — it just leaves the previous map in place. Use "Remake map" on a report's Activity row to retry.
      </div>

    </details>

    <details class="card">
      <summary>
        <div class="h3-row">
          <h3>Diagnostics</h3>
          <span class="label-muted">Workers Logs · 7 day retention<span class="chev">▾</span></span>
        </div>
      </summary>
      <div class="field-help mt-3.5" style="max-width: 72ch;">
        Console output + uncaught errors from this worker are kept for 7 days in the Cloudflare dashboard (enabled via <code>[observability]</code> in <code>wrangler.toml</code>). Use this <strong>after</strong> a stalled run — <code>wrangler tail</code> only catches live logs going forward, so it can't replay a run that died before you started tailing. Filter by <code>runResearch[…]</code> to follow a specific run through each <code>markStep</code>; if a CPU-cap kill happens mid-run, the last <code>markStep</code> line tells you which step you can't afford.
      </div>
      <div class="row mt-3 items-baseline">
        <a href="https://dash.cloudflare.com/379ac7a184fcd14c809eb0aa2a0b2233/workers/services/view/watchomacho/production/observability" target="_blank" rel="noopener" class="text-zee-primary underline text-sm">Open Workers Observability ↗</a>
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
  const [skills, targetCounts] = await Promise.all([
    listSkills(env),
    getSkillTargetCounts(env),
  ]);

  // Centralised dropdown helpers — used by both the create form and every
  // edit form below. Same option lists, same semantics.
  const toolOptions = (selected: string | null | undefined) => {
    const opts = Object.values(TOOLS).map((t) =>
      `<option value="${escapeHtml(t.slug)}"${t.slug === selected ? " selected" : ""}>${escapeHtml(t.display)}</option>`,
    ).join("");
    return `<option value=""${!selected ? " selected" : ""}>(none — writer only, no gathering)</option>${opts}`;
  };
  const opOptionsFor = (toolSlug: string | null | undefined, selectedOp: string | null | undefined) => {
    if (!toolSlug || !TOOLS[toolSlug]) return `<option value="">(pick a tool first)</option>`;
    return Object.keys(TOOLS[toolSlug].operations).map((op) =>
      `<option value="${escapeHtml(op)}"${op === selectedOp ? " selected" : ""}>${escapeHtml(op)}</option>`,
    ).join("");
  };
  const topicOptions = (selected: string) =>
    ["general", "news", "finance"].map((t) =>
      `<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`,
    ).join("");
  const timeRangeOptions = (selected: string) =>
    ["", "day", "week", "month", "year"].map((t) =>
      `<option value="${t}"${t === selected ? " selected" : ""}>${t === "" ? "(any time)" : t}</option>`,
    ).join("");
  const depthOptions = (selected: string) =>
    ["basic", "advanced"].map((t) =>
      `<option value="${t}"${t === selected ? " selected" : ""}>${t}</option>`,
    ).join("");
  // Country boost (general topic only — Tavily ignores it for news/finance).
  // Short curated list of the boosts most likely to be useful here; "" = no
  // boost. Add to the list if you need more — Tavily accepts any of the
  // ~100 names from its docs.
  const COUNTRY_CHOICES = [
    "", "United Kingdom", "United States", "Ireland", "France", "Germany",
    "Spain", "Italy", "Netherlands", "Canada", "Australia", "India",
    "Japan", "Brazil", "South Africa",
  ];
  const countryOptions = (selected: string) =>
    COUNTRY_CHOICES.map((c) =>
      `<option value="${escapeHtml(c)}"${c === selected ? " selected" : ""}>${c === "" ? "(no boost)" : escapeHtml(c)}</option>`,
    ).join("");

  // Shared renderer for the Tavily-search settings block — used by both the
  // create-by-hand form and every per-skill edit form. Groups the 4 dropdowns
  // in a responsive 2-column grid (wraps to 1 on narrow screens) and gives
  // the domain lists their own full-width textareas. params/{sourcesText}
  // hold the saved values; defaults apply when blank.
  const tavilySettings = (
    params: Record<string, string>,
    sourcesText: string,
    isTavilyExtract: boolean,
  ) => `
    <div class="mt-6 pt-5 border-t border-zee-border">
      <p class="text-xs uppercase tracking-[0.12em] text-zee-muted mb-3">Tavily search settings</p>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4 mb-5">
        <div class="field mb-0">
          <label>Search topic</label>
          <select name="topic">${topicOptions(params.topic ?? "general")}</select>
        </div>
        <div class="field mb-0">
          <label>Time range</label>
          <select name="time_range">${timeRangeOptions(params.time_range ?? "")}</select>
        </div>
        <div class="field mb-0">
          <label>Depth</label>
          <select name="depth">${depthOptions(params.depth ?? "basic")}</select>
        </div>
        <div class="field mb-0">
          <label>Country boost <span class="font-normal normal-case tracking-normal text-zee-muted">(general topic only)</span></label>
          <select name="country">${countryOptions(params.country ?? "")}</select>
        </div>
      </div>

      <div class="field">
        <label>Trusted domains <span class="font-normal normal-case tracking-normal text-zee-muted">(one per line — leave empty for the open web)</span></label>
        <textarea name="include_domains" class="font-mono text-[13px] min-h-[72px]" placeholder="bbc.co.uk&#10;reuters.com&#10;apnews.com&#10;theguardian.com">${escapeHtml(params.include_domains ?? "")}</textarea>
        <p class="field-help mt-1">Tavily returns results ONLY from these domains.</p>
      </div>

      <div class="field">
        <label>Blocked domains <span class="font-normal normal-case tracking-normal text-zee-muted">(one per line)</span></label>
        <textarea name="exclude_domains" class="font-mono text-[13px] min-h-[56px]" placeholder="pinterest.com&#10;quora.com">${escapeHtml(params.exclude_domains ?? "")}</textarea>
        <p class="field-help mt-1">Always skipped, even if relevant.</p>
      </div>

      <div class="field mb-0"${isTavilyExtract ? "" : ' style="display:none"'} data-extract-only>
        <label>Source URLs <span class="font-normal normal-case tracking-normal text-zee-muted">(only used with <code>tavily / extract</code>)</span></label>
        <textarea name="tool_sources" class="font-mono text-[13px] min-h-[100px]" placeholder="One URL per line. Lines starting with # are ignored.">${escapeHtml(sourcesText)}</textarea>
      </div>
    </div>
  `;

  const list = skills.length === 0
    ? `<div class="empty">No skills yet. Add one below.</div>`
    : skills.map((s) => {
      const params: Record<string, string> = s.tool_params_json
        ? (() => { try { return JSON.parse(s.tool_params_json!); } catch { return {}; } })()
        : {};
      const sourcesText = s.tool_sources_json
        ? (() => { try { return (JSON.parse(s.tool_sources_json!) as string[]).join("\n"); } catch { return ""; } })()
        : "";
      const isTavilyExtract = s.tool_slug === "tavily" && s.tool_op === "extract";
      const liveTargets = targetCounts[s.id] ?? 0;
      const liveBadge = liveTargets > 0
        ? `<span class="ml-2 text-xs text-zee-primary">in use on ${liveTargets} target${liveTargets === 1 ? "" : "s"}</span>`
        : `<span class="ml-2 text-xs text-zee-muted">unassigned</span>`;
      return `
        <details class="card px-5 py-4">
          <summary class="cursor-pointer list-none flex flex-wrap justify-between items-baseline gap-3">
            <span>
              <strong class="font-medium">${escapeHtml(s.name)}</strong>
              <span class="badge badge-${s.author} ml-2">${s.author}</span>
              ${s.tool_slug ? `<span class="label-muted ml-2">${escapeHtml(s.tool_slug)} / ${escapeHtml(s.tool_op ?? "")}</span>` : `<span class="label-muted ml-2">writer only</span>`}
              ${liveBadge}
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

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4 mb-1">
              <div class="field mb-0">
                <label>Tool</label>
                <select name="tool_slug">${toolOptions(s.tool_slug)}</select>
              </div>
              <div class="field mb-0">
                <label>Operation</label>
                <select name="tool_op">${opOptionsFor(s.tool_slug, s.tool_op)}</select>
              </div>
            </div>

            ${tavilySettings(params, sourcesText, isTavilyExtract)}

            <div class="field mt-6">
              <label>Writer instructions <span class="font-normal normal-case tracking-normal">(markdown — goes verbatim to the planner + writer)</span></label>
              <textarea name="procedure_md" class="min-h-[280px] font-mono text-[13px]">${escapeHtml(s.procedure_md)}</textarea>
            </div>
            <div class="row">
              <button class="btn" type="submit">Save changes</button>
              <button type="button" class="btn btn-danger" data-delete-skill data-slug="${escapeHtml(s.slug)}" data-name="${escapeHtml(s.name)}">Delete skill</button>
            </div>
          </form>
        </details>
      `;
    }).join("");

  const body = `
    <section class="pt-6 pb-2">
      <p class="text-xs uppercase tracking-[0.12em] text-zee-muted"><a href="/admin" class="text-zee-primary hover:underline">Admin</a><span class="mx-2 text-zee-border" aria-hidden="true">·</span>Skills</p>
      <h1 class="headline mt-2 text-[32px]">Skills.</h1>
      <p class="subhead">The agent's library of reusable research procedures. Each skill picks a tool, configures it, and writes the instructions the LLM uses to plan + author the report. WYSIWYG — no hidden parsing.</p>
    </section>

    <div class="card">
      <div class="h3-row"><h3>New skill</h3></div>
      <p class="field-help mb-3">Pick a tool + op, set its params, then write the instructions. The agent feeds the instructions verbatim into the planner (to generate queries) and the writer (to author the report).</p>
      <form method="post" action="/admin/skills">
        <div class="field">
          <label>Name</label>
          <input name="name" required maxlength="120">
        </div>
        <div class="field">
          <label>Description</label>
          <input name="description" maxlength="200">
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4 mb-1">
          <div class="field mb-0">
            <label>Tool</label>
            <select name="tool_slug">${toolOptions("tavily")}</select>
          </div>
          <div class="field mb-0">
            <label>Operation</label>
            <select name="tool_op">${opOptionsFor("tavily", "search")}</select>
          </div>
        </div>

        ${tavilySettings({}, "", false)}

        <div class="field mt-6">
          <label>Writer instructions <span class="font-normal normal-case tracking-normal">(markdown — goes verbatim to the planner + writer)</span></label>
          <textarea name="procedure_md" required class="min-h-[240px] font-mono text-[13px]" placeholder="**Purpose:** ...

**When to use:** ...

**Approach:** ...

**Output structure:**
- Heading: ...
"></textarea>
        </div>
        <button class="btn" type="submit">Save skill</button>
      </form>
    </div>

    ${list}

    <script>
      // Delete-skill safety check. Before firing the destructive POST we
      // call GET /admin/skills/:slug/usage and show the user what's still
      // referencing the skill. Server-side deleteSkill also blocks if any
      // target points at it, so this is belt-and-braces — the inline check
      // just gives a better message than a 409 response would.
      document.querySelectorAll('[data-delete-skill]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const slug = btn.getAttribute('data-slug');
          const name = btn.getAttribute('data-name') || slug;
          btn.disabled = true;
          try {
            const r = await fetch('/admin/skills/' + encodeURIComponent(slug) + '/usage');
            if (!r.ok) {
              alert('Could not check skill usage. Try again.');
              return;
            }
            const usage = await r.json();
            const tList = (usage.targets || []).map((t) => '"' + t.name + '"').join(', ');
            if ((usage.targets || []).length > 0) {
              alert(
                'Cannot delete "' + name + '" — it is still the primary skill for ' +
                usage.targets.length + ' target' + (usage.targets.length === 1 ? '' : 's') + ': ' + tList +
                '.\\n\\nReassign ' + (usage.targets.length === 1 ? 'that target' : 'those targets') +
                ' to a different skill first, then come back.',
              );
              return;
            }
            const reportsNote = usage.reports > 0
              ? '\\n\\nNote: ' + usage.reports + ' past report' + (usage.reports === 1 ? '' : 's') +
                ' produced by this skill will stay in the archive but lose their skill link.'
              : '';
            if (!confirm('Delete skill "' + name + '"?' + reportsNote)) return;
            const del = await fetch('/admin/skills/' + encodeURIComponent(slug) + '/delete', { method: 'POST' });
            if (del.ok || del.redirected) {
              location.reload();
            } else {
              const body = await del.json().catch(() => null);
              alert(body?.error || ('Delete failed (HTTP ' + del.status + ')'));
            }
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Reveal the "Source URLs" textarea only when the operation dropdown
      // is set to "extract". Saves the user from staring at a field that
      // does nothing for the search op (which is 95%+ of skills).
      function syncExtractFields(form) {
        const op = form.querySelector('select[name="tool_op"]');
        const tool = form.querySelector('select[name="tool_slug"]');
        const extractField = form.querySelector('[data-extract-only]');
        if (!op || !tool || !extractField) return;
        const isExtract = tool.value === 'tavily' && op.value === 'extract';
        extractField.style.display = isExtract ? '' : 'none';
      }
      document.querySelectorAll('form').forEach((form) => {
        if (!form.querySelector('[data-extract-only]')) return;
        syncExtractFields(form);
        form.addEventListener('change', (e) => {
          if (e.target.matches('select[name="tool_op"]') || e.target.matches('select[name="tool_slug"]')) {
            syncExtractFields(form);
          }
        });
      });
    </script>
  `;
  return shell("Skills · WatchOMacho", body, { activeNav: "skills", adminFooter: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: dedicated /admin/targets page — list + add form (lifted off the
// main admin console so /admin is just status + settings).
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminTargetsList(env: Env): Promise<string> {
  const [targets, skills] = await Promise.all([listTargets(env), listSkills(env)]);
  const active = targets.filter((t) => t.status === "active");
  const dueNow = active.filter((t) => t.next_run_at && t.next_run_at <= Date.now() && t.primary_skill_id);
  const statusRank: Record<string, number> = { active: 0, paused: 1, archived: 2 };
  const sortedTargets = [...targets].sort((a, b) => {
    const sa = statusRank[a.status] ?? 3;
    const sb = statusRank[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return (a.next_run_at ?? Infinity) - (b.next_run_at ?? Infinity);
  });
  const skillOptions = skills.length === 0
    ? `<option value="">(no skills yet — use Skills tab to create one)</option>`
    : `<option value="">(none — attach later)</option>` + skills.map((s) =>
        `<option value="${escapeHtml(s.slug)}">${escapeHtml(s.name)}</option>`,
      ).join("");

  const targetRows = sortedTargets.length === 0
    ? `<div class="empty">No targets yet. Add one above.</div>`
    : `<ul class="list-none">${sortedTargets.map((t) => {
        const isActive = t.status === "active";
        const meta = isActive
          ? `${t.next_run_at ? (t.next_run_at <= Date.now() ? `<span class="text-zee-primary">due now</span>` : escapeHtml(timeUntil(t.next_run_at))) : "—"} · ${escapeHtml(describeSchedule(t.cadence_hours, t.anchor_hour_utc))}`
          : escapeHtml(describeSchedule(t.cadence_hours, t.anchor_hour_utc));
        return `
        <li class="py-2.5 border-b border-[rgba(232,228,222,0.6)]">
          <div class="flex flex-wrap justify-between items-baseline gap-3">
            <a href="/admin/targets/${escapeHtml(t.slug)}" class="font-medium ${isActive ? "text-zee-text" : "text-zee-muted"}">
              ${escapeHtml(t.name)}
              ${t.kind ? `<span class="label-muted ml-2">${escapeHtml(t.kind)}</span>` : ""}
              <span class="badge badge-${escapeHtml(t.status)} ml-2">${escapeHtml(t.status)}</span>
            </a>
            <span class="tt text-xs text-zee-muted">${meta}</span>
          </div>
        </li>`;
      }).join("")}</ul>`;

  const body = `
    <section class="pt-6 pb-3">
      <p class="text-xs uppercase tracking-[0.12em] text-zee-muted"><a href="/admin" class="text-zee-primary hover:underline">Admin</a><span class="mx-2 text-zee-border" aria-hidden="true">·</span>Targets</p>
      <h1 class="headline mt-2 text-[32px]">Targets.</h1>
      <p class="subhead"><strong class="text-zee-text">${active.length}</strong> active${sortedTargets.length > active.length ? ` · <strong class="text-zee-muted">${sortedTargets.length - active.length}</strong> paused/archived` : ""}${dueNow.length ? ` · <strong class="text-zee-primary">${dueNow.length}</strong> due now` : ""}.</p>
    </section>

    <details class="card" open>
      <summary>
        <div class="h3-row">
          <h3>Targets</h3>
          <span class="label-muted">${sortedTargets.length} total<span class="chev">▾</span></span>
        </div>
      </summary>
      ${targetRows}
    </details>

    <details class="card">
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
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-4 mb-1">
          <div class="field mb-0">
            <label>How often</label>
            <select name="cadence_hours">
              <option value="1">Every hour</option>
              <option value="6">4× per day</option>
              <option value="12">2× per day</option>
              <option value="24" selected>1× per day (daily)</option>
              <option value="72">Every 3 days</option>
              <option value="168">Once a week</option>
            </select>
          </div>
          <div class="field mb-0">
            <label>Starting at</label>
            <select name="anchor_hour_utc">
              ${Array.from({ length: 24 }, (_, h) =>
                `<option value="${h}"${h === 2 ? " selected" : ""}>${String(h).padStart(2, "0")}:00 UTC</option>`,
              ).join("")}
            </select>
          </div>
          <div class="field mb-0">
            <label>Skill to apply</label>
            <select name="skill_slug">${skillOptions}</select>
          </div>
        </div>
        <div class="field-help mb-4">First run lands at the "Starting at" hour; subsequent runs are evenly spaced. All times UTC (BST = UTC+1 in summer).</div>
        <label class="flex items-center gap-2 mb-3.5 text-[13px] text-zee-muted">
          <input type="checkbox" name="run_now" value="1"> Run once now
        </label>
        <button class="btn" type="submit">Add target</button>
      </form>
    </details>
  `;
  return shell("Targets · Admin · WatchOMacho", body, { activeNav: "targets", adminFooter: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: target edit page
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminTargetEdit(env: Env, slug: string, queued = false, dayMapQueued = false): Promise<string> {
  const target = await getTargetBySlug(env, slug);
  if (!target) {
    return shell("Not found", `<section class="py-20 text-center"><h1 class="headline">No such target.</h1></section>`, { activeNav: "targets", adminFooter: true });
  }
  const skills = await listSkills(env);
  const activityRows = await env.DB.prepare(
    `SELECT runs.*,
            reports.title         AS report_title,
            reports.word_count    AS report_word_count,
            reports.chat_model    AS report_chat_model,
            reports.sources_json  AS report_sources_json,
            reports.day_map_r2_key AS report_day_map_r2_key,
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

  // "How often" dropdown — labels phrased as "X× per day" / "every hour" /
  // "every 3 days" / "weekly" so the user picks frequency, not internal hours.
  // The form field is still `cadence_hours` (value = hours) so the backend is
  // unchanged.
  const cadenceOptions = [1, 6, 12, 24, 72, 168].map((h) => {
    const label =
      h === 1   ? "Every hour"
    : h === 6   ? "4× per day"
    : h === 12  ? "2× per day"
    : h === 24  ? "1× per day (daily)"
    : h === 72  ? "Every 3 days"
    :             "Once a week";
    return `<option value="${h}"${target.cadence_hours === h ? " selected" : ""}>${label}</option>`;
  }).join("");

  // "Starting at" dropdown — 24 entries, one per UTC hour. Replaces the
  // raw number input so the user doesn't have to type "2" and remember it
  // means 02:00 UTC. Field name `anchor_hour_utc` is unchanged.
  const selectedAnchor = target.anchor_hour_utc; // null = inherit default 2
  const anchorOptions = Array.from({ length: 24 }, (_, h) => {
    const selected = h === (selectedAnchor ?? 2) ? " selected" : "";
    return `<option value="${h}"${selected}>${String(h).padStart(2, "0")}:00 UTC</option>`;
  }).join("");

  // Plain-English schedule line for the configure-card header.
  const scheduleLabel = describeSchedule(target.cadence_hours, target.anchor_hour_utc);

  /** Middot separator between meta items on the same line. */
  const metaSep = `<span class="mx-2.5 text-zee-border" aria-hidden="true">·</span>`;

  const activityList = (activityRows.results ?? []).length === 0
    ? `<div class="empty">No activity yet.</div>`
    : `<ul class="list-none">${(activityRows.results ?? []).map((r: any) => {
        const isSuccess = r.status === "success" && r.report_id;

        // ─── Line 1 — when/how: time, trigger, duration. The title above is
        //     already the report link, so no redundant "view report →" here.
        const lineRunParts: string[] = [
          `<span class="tt">${escapeHtml(timeAgo(r.created_at))}</span>`,
          escapeHtml(r.triggered_by),
        ];
        if (r.duration_ms) lineRunParts.push(`<span class="tt">${escapeHtml(fmtDuration(r.duration_ms))}</span>`);

        // ─── Line 2 — what was produced: words, model, sources. Skill name
        //     is in the title ("World News — World news briefing") already;
        //     no need to repeat it here.
        const lineReportParts: string[] = [];
        if (isSuccess && r.report_word_count != null) {
          lineReportParts.push(`<strong class="font-medium text-zee-text">${r.report_word_count.toLocaleString()}</strong> words`);
        }
        if (isSuccess && r.report_chat_model) {
          lineReportParts.push(escapeHtml(chatModelShortLabel(r.report_chat_model)));
        }
        if (isSuccess && r.report_sources_json) {
          try {
            const cites = JSON.parse(r.report_sources_json) as Array<{ kind?: string }>;
            if (Array.isArray(cites) && cites.length > 0) {
              const archive = cites.filter((c) => c?.kind === "archive").length;
              const web = cites.length - archive;
              const bits: string[] = [];
              if (web > 0) bits.push(`${web} web`);
              if (archive > 0) bits.push(`${archive} 📚`);
              if (bits.length) lineReportParts.push(bits.join(" + ") + " sources");
            }
          } catch { /* malformed JSON — skip */ }
        }
        // Day-map link (v14) — only when this run produced one. whitespace-nowrap
        // so "day-map ↗" wraps as one unit instead of breaking after the hyphen.
        if (isSuccess && r.report_day_map_r2_key) {
          lineReportParts.push(`<a href="/day-map/${escapeHtml(r.report_id)}" class="text-zee-primary whitespace-nowrap" target="_blank" rel="noopener">day-map ↗</a>`);
        }

        // ─── Line 3 — gather funnel (only when populated) ───
        const funnelHtml = renderGatherFunnel(r.gather_stats_json);

        // No flex on the sub-lines — natural inline-text flow keeps the
        // whitespace around middots/arrows visible (flex can collapse it).
        const metaBlock = `
          <div class="mt-2 text-sm text-zee-muted">${lineRunParts.join(metaSep)}</div>
          ${lineReportParts.length ? `<div class="mt-1.5 text-sm text-zee-muted">${lineReportParts.join(metaSep)}</div>` : ""}
          ${funnelHtml ? `<div class="mt-1.5 text-sm text-zee-muted">${funnelHtml}</div>` : ""}
        `;

        if (isSuccess) {
          return `
            <li class="py-5 px-1 flex items-start gap-3.5 border-b border-zee-border last:border-b-0">
              <span class="activity-dot activity-dot--ok" aria-hidden="true">✓</span>
              <div class="flex-1 min-w-0">
                <a href="/report/${escapeHtml(r.report_id)}" class="text-sm font-medium text-zee-text block leading-snug">
                  ${escapeHtml(r.report_title ?? "Untitled report")}
                </a>
                ${metaBlock}
              </div>
              <div class="shrink-0 flex flex-col items-end gap-2">
                <form method="post" action="/admin/reports/${escapeHtml(r.report_id)}/day-map" class="inline" onsubmit="return confirm('Rebuild the map of the day for this story? One AI call (~1 min), no re-research.')">
                  <button class="btn btn-sm" type="submit">${r.report_day_map_r2_key ? "Remake map" : "Make map"}</button>
                </form>
                <form method="post" action="/admin/reports/${escapeHtml(r.report_id)}/delete" class="inline" onsubmit="return confirm('Delete this report? R2 file, recall vector, and this activity entry all go too.')">
                  <button class="btn btn-danger btn-sm" type="submit">Delete</button>
                </form>
              </div>
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
          <li class="py-5 px-1 flex items-start gap-3.5 border-b border-zee-border last:border-b-0">
            <span class="activity-dot activity-dot--err" aria-hidden="true">✕</span>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium text-zee-text leading-snug">${titleLine}</div>
              ${metaBlock}
              <div class="field-help mt-2 text-[rgb(180,60,60)] break-words leading-relaxed" title="${escapeHtml(errFull)}">
                ${escapeHtml(errShort)}
              </div>
            </div>
          </li>`;
      }).join("")}</ul>`;

  const body = `
    <section class="pt-6 pb-2">
      <p class="text-xs uppercase tracking-[0.12em] text-zee-muted"><a href="/admin" class="text-zee-primary hover:underline">Admin</a><span class="mx-2 text-zee-border" aria-hidden="true">·</span><a href="/admin/targets" class="text-zee-primary hover:underline">Targets</a><span class="mx-2 text-zee-border" aria-hidden="true">·</span>${escapeHtml(target.name)}</p>
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

    ${dayMapQueued ? `
    <div class="card" style="border-color:#C49A1A;background:rgba(196,154,26,0.08);">
      <p class="text-sm m-0" style="color:#8a6d12;">
        <strong>Map rebuilding.</strong> Regenerating the map of the day from the existing story — one AI call, no re-research, ~1 minute. Refresh this page shortly to see the new map.
      </p>
    </div>
    ` : ""}

    <details class="card">
      <summary>
        <div class="h3-row">
          <h3>Configure</h3>
          <span class="label-muted">${escapeHtml(scheduleLabel)}${target.primary_skill_id ? "" : " · no skill"}<span class="chev">▾</span></span>
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
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-4 mb-1">
          <div class="field mb-0">
            <label>Status</label>
            <select name="status">
              <option value="active"${target.status === "active" ? " selected" : ""}>active</option>
              <option value="paused"${target.status === "paused" ? " selected" : ""}>paused</option>
              <option value="archived"${target.status === "archived" ? " selected" : ""}>archived</option>
            </select>
          </div>
          <div class="field mb-0">
            <label>How often</label>
            <select name="cadence_hours">${cadenceOptions}</select>
          </div>
          <div class="field mb-0">
            <label>Starting at</label>
            <select name="anchor_hour_utc">${anchorOptions}</select>
          </div>
          <div class="field mb-0">
            <label>Primary skill</label>
            <select name="skill_slug">${skillOptions}</select>
          </div>
        </div>
        <div class="field-help mb-4">→ <strong>${escapeHtml(scheduleLabel)}</strong>. All times in UTC (BST = UTC+1 in summer, GMT = UTC in winter). Changing the schedule snaps the next run to the new slot.</div>

        <div class="label-muted mt-2 mb-2">Tavily knobs <span class="font-normal normal-case tracking-normal text-zee-muted">(blank = use the global default)</span></div>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-4">
          <div class="field mb-0">
            <label>Queries per run</label>
            <input type="number" name="queries_per_run" min="1" max="20" step="1"
                   value="${target.queries_per_run ?? ""}"
                   placeholder="10 (default)">
            <div class="field-help mt-1.5">How many distinct search queries the planner produces. World-news-style skills want 10; a focused postcode dossier wants 2–3.</div>
          </div>
          <div class="field mb-0">
            <label>Tavily min score</label>
            <input type="number" name="tavily_min_score" min="0" max="1" step="0.05"
                   value="${target.tavily_min_score != null ? target.tavily_min_score.toFixed(2) : ""}"
                   placeholder="0.40 (default)">
            <div class="field-help mt-1.5">Drops Tavily hits below this relevance score. 0 = keep everything (noisy). 1 = strict.</div>
          </div>
          <div class="field mb-0">
            <label>Max final sources</label>
            <input type="number" name="tavily_max_final_sources" min="1" max="200" step="1"
                   value="${target.tavily_max_final_sources ?? ""}"
                   placeholder="100 (default)">
            <div class="field-help mt-1.5">Hard cap on how many sources reach the writer after dedupe.</div>
          </div>
        </div>

        <div class="label-muted mt-4 mb-2">Day-map</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-4">
          <div class="field mb-0">
            <label>Daily day-map</label>
            <select name="day_map_enabled">
              <option value=""${target.day_map_enabled == null ? " selected" : ""}>Use default</option>
              <option value="on"${target.day_map_enabled === 1 ? " selected" : ""}>On</option>
              <option value="off"${target.day_map_enabled === 0 ? " selected" : ""}>Off</option>
            </select>
            <div class="field-help mt-1.5">After each briefing for this target, generate an interactive "map of the day" (self-contained HTML, one extra LLM call). "Use default" follows the global setting on the admin console.</div>
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
  return shell(`${target.name} · Admin`, body, { activeNav: "targets", adminFooter: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: tools catalog — read-only registry of what skills can call
// ─────────────────────────────────────────────────────────────────────────────

export function renderAdminTools(): string {
  const cards = Object.values(TOOLS).map((tool) => {
    const opRows = Object.entries(tool.operations).map(([opName, op]) => `
      <tr>
        <td class="whitespace-nowrap align-top pr-3 py-2 font-mono text-[13px] text-zee-primary">${escapeHtml(tool.slug)} / ${escapeHtml(opName)}</td>
        <td class="align-top py-2 text-sm text-zee-text">
          <div>${escapeHtml(op.description)}</div>
          <div class="field-help mt-1"><em>When to use:</em> ${escapeHtml(op.when_to_use)}</div>
        </td>
      </tr>
    `).join("");

    return `
      <div class="card">
        <div class="h3-row"><h3>${escapeHtml(tool.display)}</h3></div>
        <p class="field-help mb-3">${escapeHtml(tool.summary)}</p>
        <h4 class="text-[13px] uppercase tracking-wider text-zee-muted mt-2 mb-1">Operations</h4>
        <table class="w-full border-collapse"><tbody>${opRows}</tbody></table>
      </div>
    `;
  }).join("");

  const body = `
    <section class="pt-6 pb-2">
      <p class="text-xs uppercase tracking-[0.12em] text-zee-muted"><a href="/admin" class="text-zee-primary hover:underline">Admin</a><span class="mx-2 text-zee-border" aria-hidden="true">·</span>Tools</p>
      <h1 class="headline mt-2 text-[32px]">Tools.</h1>
      <p class="subhead">What skills can call. Today: Tavily only. Each skill picks one tool + one operation on its edit page. To add another tool, edit <code>TOOLS</code> in <code>src/apis.ts</code> — code + metadata live together.</p>
    </section>

    ${cards}
  `;
  return shell("Tools · WatchOMacho", body, { activeNav: "tools", adminFooter: true });
}
