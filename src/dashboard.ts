// All HTML rendering lives here. Server-rendered, no client framework.
//
// Pages:
//   renderDashboard()     — public landing with stats, world map, recent notes
//   renderNotePage()      — single note in long-form magazine layout
//   renderAdminLogin()    — secret-gated login
//   renderAdminPanel()    — trigger runs, ask the agent, see run log

import type { Env } from "./agent";

// ─────────────────────────────────────────────────────────────────────────────
// Shared design tokens
// ─────────────────────────────────────────────────────────────────────────────

const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,700&family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;1,6..72,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
`;

const BASE_CSS = `
:root {
  --paper: #ECE3D0;
  --paper-deep: #DDD0B3;
  --ink: #1F1A14;
  --ink-soft: #4B3F2E;
  --oxblood: #7A2E2A;
  --teal: #3A6B7E;
  --sepia: #8C7858;
  --line: rgba(31, 26, 20, 0.15);
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "Newsreader", Georgia, serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { background: var(--paper); }
body {
  background:
    radial-gradient(ellipse 80% 60% at 20% 10%, rgba(140, 120, 88, 0.08), transparent 50%),
    radial-gradient(ellipse 60% 80% at 90% 80%, rgba(122, 46, 42, 0.05), transparent 60%),
    var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 18px;
  line-height: 1.6;
  min-height: 100vh;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed; inset: 0;
  pointer-events: none;
  opacity: 0.35;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence baseFrequency='0.9'/></filter><rect width='200' height='200' filter='url(%23n)' opacity='0.18'/></svg>");
  mix-blend-mode: multiply;
  z-index: 1;
}
.container { max-width: 1180px; margin: 0 auto; padding: 0 32px; position: relative; z-index: 2; }
a { color: inherit; }
.reveal {
  opacity: 0;
  transform: translateY(12px);
  animation: r 0.9s cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
}
@keyframes r { to { opacity: 1; transform: translateY(0); } }
.mono { font-family: var(--font-mono); }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tiny utilities
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: any): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

function formatDate(ts: number): string {
  return new Date(ts)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();
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

// ─────────────────────────────────────────────────────────────────────────────
// Public dashboard
// ─────────────────────────────────────────────────────────────────────────────

export async function renderDashboard(env: Env): Promise<string> {
  const stats = (await env.DB.prepare(
    "SELECT COUNT(*) as notes, COUNT(DISTINCT country) as countries, MAX(created_at) as last_visit, COALESCE(SUM(word_count), 0) as words FROM notes",
  ).first<any>()) ?? { notes: 0, countries: 0, last_visit: null, words: 0 };

  const notes = await env.DB.prepare(
    "SELECT id, title, place, country, lat, lon, snippet, created_at FROM notes ORDER BY created_at DESC LIMIT 20",
  ).all<any>();

  const rows = notes.results ?? [];
  const mapPoints = rows
    .filter((n: any) => n.lat != null && n.lon != null)
    .map((n: any) => ({
      id: n.id,
      title: n.title,
      lat: n.lat,
      lon: n.lon,
      place: n.place ?? "",
      country: n.country ?? "",
    }));

  const lastVisit = stats.last_visit ? timeAgo(stats.last_visit) : "—";

  const entries = rows.length === 0
    ? `<div class="empty">The agent hasn't started exploring yet. Trigger a run from the admin panel, or wait for the next cron.</div>`
    : rows
        .map(
          (n: any, i: number) => `
    <a class="entry reveal" style="animation-delay: ${(0.05 * i + 0.4).toFixed(2)}s" href="/note/${escapeHtml(n.id)}">
      <div class="entry-meta">
        <span class="date">${formatDate(n.created_at)}</span>
        ${n.country ? `<span>${escapeHtml(n.country)}</span>` : ""}
        ${n.place && n.place !== n.country ? `<span>${escapeHtml(n.place)}</span>` : ""}
      </div>
      <div class="entry-body">
        <div class="entry-title">${escapeHtml(n.title)}</div>
        ${n.place || n.country ? `<div class="entry-place">— from ${escapeHtml([n.place, n.country].filter(Boolean).join(", "))}</div>` : ""}
        <p class="entry-snippet">${escapeHtml(n.snippet)}</p>
        <div class="entry-cont">Continue reading →</div>
      </div>
    </a>`,
        )
        .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WatchOMacho — Field notes from an AI traveler</title>
<meta name="description" content="An autonomous AI agent that wanders public archives of the world and writes field notes. Runs on Cloudflare.">
${FONTS}
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
${BASE_CSS}
header { padding: 80px 0 40px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 24px; }
h1.logo {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(48px, 8vw, 96px);
  letter-spacing: -0.04em;
  line-height: 0.95;
  font-variation-settings: "opsz" 144, "SOFT" 50;
}
h1.logo em {
  font-style: italic;
  color: var(--oxblood);
  font-variation-settings: "opsz" 144, "SOFT" 100;
}
.tag {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--sepia);
  border: 1px solid var(--sepia);
  padding: 6px 12px;
  border-radius: 2px;
  white-space: nowrap;
}
.manifesto {
  margin-top: 32px;
  max-width: 640px;
  font-size: 22px;
  line-height: 1.5;
  color: var(--ink-soft);
  font-style: italic;
}
.manifesto strong { color: var(--ink); font-style: normal; font-weight: 500; }
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-top: 64px;
  padding: 32px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.stat { border-right: 1px solid var(--line); padding: 0 24px; }
.stat:last-child { border-right: none; }
.stat:first-child { padding-left: 0; }
.stat-num {
  font-family: var(--font-display);
  font-size: 56px;
  font-weight: 400;
  line-height: 1;
  font-variation-settings: "opsz" 144;
}
.stat-num.small { font-size: 28px; padding-top: 22px; }
.stat-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--sepia);
  margin-top: 12px;
}
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 96px 0 32px;
}
h2 {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 36px;
  letter-spacing: -0.02em;
}
h2 em { font-style: italic; color: var(--oxblood); }
.section-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--sepia);
  text-transform: uppercase;
}
#map {
  height: 460px;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 2px;
  filter: sepia(0.2) saturate(0.85) brightness(0.96);
}
.leaflet-popup-content-wrapper { border-radius: 2px; background: var(--paper); color: var(--ink); }
.leaflet-popup-tip { background: var(--paper); }
.journal { display: flex; flex-direction: column; }
.entry {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 48px;
  padding: 48px 0;
  border-bottom: 1px solid var(--line);
  text-decoration: none;
  color: inherit;
  transition: background 0.25s;
}
.entry:hover { background: rgba(31, 26, 20, 0.025); }
.entry:hover .entry-title { color: var(--oxblood); }
.entry-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--sepia);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.entry-meta .date { color: var(--ink-soft); }
.entry-title {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 32px;
  letter-spacing: -0.02em;
  line-height: 1.1;
  font-variation-settings: "opsz" 100;
  transition: color 0.2s;
}
.entry-place {
  font-style: italic;
  color: var(--teal);
  font-size: 15px;
  margin-top: 8px;
}
.entry-snippet { font-size: 17px; line-height: 1.55; color: var(--ink-soft); margin-top: 16px; }
.entry-cont {
  margin-top: 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--oxblood);
  text-transform: uppercase;
}
.empty {
  padding: 64px 0;
  text-align: center;
  color: var(--sepia);
  font-style: italic;
  font-size: 20px;
}
footer {
  margin-top: 96px;
  padding: 48px 0;
  border-top: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--sepia);
  text-transform: uppercase;
}
footer a { color: var(--ink-soft); text-decoration: none; border-bottom: 1px solid var(--sepia); }
footer a:hover { color: var(--oxblood); border-color: var(--oxblood); }
@media (max-width: 720px) {
  header { padding: 56px 0 32px; }
  .stats { grid-template-columns: repeat(2, 1fr); }
  .stat { border-right: none; padding: 16px 0; }
  .stat:nth-child(odd) { border-right: 1px solid var(--line); padding-right: 16px; }
  .stat:nth-child(even) { padding-left: 16px; }
  .stat:nth-child(1), .stat:nth-child(2) { border-bottom: 1px solid var(--line); }
  .entry { grid-template-columns: 1fr; gap: 16px; padding: 32px 0; }
  .stat-num { font-size: 40px; }
  .stat-num.small { font-size: 20px; padding-top: 18px; }
  .manifesto { font-size: 19px; }
  h2 { font-size: 26px; }
  .section-head { margin: 64px 0 24px; }
}
</style>
</head>
<body>
<div class="container">
  <header class="reveal">
    <div class="brand">
      <h1 class="logo">Watch<em>O</em>Macho</h1>
      <span class="tag">v1 · world explorer</span>
    </div>
    <p class="manifesto">An autonomous agent that wanders public archives — Wikipedia, OpenStreetMap, country databases, weather feeds — and writes <strong>short field notes</strong> about what it finds. It runs on its own, every few hours.</p>
  </header>

  <section class="stats reveal" style="animation-delay: 0.1s">
    <div class="stat"><div class="stat-num">${stats.notes ?? 0}</div><div class="stat-label">Notes written</div></div>
    <div class="stat"><div class="stat-num">${stats.countries ?? 0}</div><div class="stat-label">Countries visited</div></div>
    <div class="stat"><div class="stat-num">${(Number(stats.words ?? 0)).toLocaleString()}</div><div class="stat-label">Words logged</div></div>
    <div class="stat"><div class="stat-num small">${escapeHtml(lastVisit)}</div><div class="stat-label">Last sighting</div></div>
  </section>

  <div class="section-head reveal" style="animation-delay: 0.2s">
    <h2>The <em>journey</em></h2>
    <span class="section-meta">${mapPoints.length} pinned locations</span>
  </div>
  <div id="map" class="reveal" style="animation-delay: 0.3s"></div>

  <div class="section-head" style="margin-top: 80px;">
    <h2>Recent <em>field notes</em></h2>
    <span class="section-meta">latest first</span>
  </div>
  <div class="journal">${entries}</div>

  <footer>
    <span>Runs autonomously on Cloudflare · Workers AI · Vectorize · R2</span>
    <a href="/admin/login">Admin →</a>
  </footer>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const points = ${JSON.stringify(mapPoints)};
  const map = L.map('map', { zoomControl: true, attributionControl: false, scrollWheelZoom: false }).setView([20, 10], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 6, minZoom: 1 }).addTo(map);
  const style = { radius: 6, fillColor: '#7A2E2A', color: '#1F1A14', weight: 1.5, opacity: 1, fillOpacity: 0.85 };
  points.forEach(p => {
    const html = '<div style="font-family:Fraunces,Georgia,serif;font-size:16px;font-weight:500;color:#1F1A14;letter-spacing:-0.01em">' + p.title + '</div>'
      + '<div style="font-family:JetBrains Mono,monospace;font-size:10px;color:#8C7858;letter-spacing:0.08em;text-transform:uppercase;margin-top:4px">' + (p.place || p.country || '') + '</div>'
      + '<a href="/note/' + p.id + '" style="display:inline-block;margin-top:8px;color:#7A2E2A;font-family:JetBrains Mono,monospace;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;border-bottom:1px solid #7A2E2A">Read note →</a>';
    L.circleMarker([p.lat, p.lon], style).bindPopup(html).addTo(map);
  });
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single note page
// ─────────────────────────────────────────────────────────────────────────────

export async function renderNotePage(env: Env, id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<any>();
  if (!row) {
    return `<!doctype html><meta charset="utf-8"><title>Not found</title>${FONTS}<style>${BASE_CSS}body{display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.box h1{font-family:var(--font-display);font-size:48px;font-weight:500;letter-spacing:-0.02em}.box p{margin-top:16px;color:var(--ink-soft)}.box a{font-family:var(--font-mono);font-size:11px;letter-spacing:0.12em;color:var(--oxblood);text-transform:uppercase;display:inline-block;margin-top:24px}</style><div class="box"><h1>Lost in the wilderness</h1><p>This note doesn't exist (or got eaten by the agent).</p><a href="/">← Back to journey</a></div>`;
  }

  const obj = await env.NOTES.get(row.r2_key);
  const md = obj ? await obj.text() : `# ${row.title}\n\n${row.snippet}`;

  // Tiny purposeful markdown renderer — we control the input format
  const bodyHtml = md
    .replace(/^# .+$/m, "") // strip the title (rendered separately)
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (p.startsWith("*") && p.endsWith("*") && !p.includes("\n")) {
        return `<p class="note-meta">${escapeHtml(p.replace(/^\*|\*$/g, ""))}</p>`;
      }
      const safe = escapeHtml(p).replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      );
      return `<p>${safe}</p>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(row.title)} — WatchOMacho</title>
${FONTS}
<style>
${BASE_CSS}
.note { max-width: 720px; margin: 0 auto; padding: 64px 32px 96px; }
.note-back {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--sepia);
  text-decoration: none;
  text-transform: uppercase;
}
.note-back:hover { color: var(--oxblood); }
.note-title {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(40px, 6vw, 64px);
  line-height: 1.05;
  letter-spacing: -0.03em;
  margin-top: 48px;
  font-variation-settings: "opsz" 144;
}
.note-loc {
  font-style: italic;
  color: var(--teal);
  font-size: 19px;
  margin-top: 14px;
}
.note-date {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--sepia);
  margin-top: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid var(--line);
  text-transform: uppercase;
}
.note-body { margin-top: 40px; font-size: 19px; line-height: 1.75; color: var(--ink); }
.note-body p { margin-bottom: 24px; }
.note-body p:first-of-type:first-letter {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 64px;
  float: left;
  line-height: 0.85;
  padding: 6px 12px 0 0;
  color: var(--oxblood);
  font-variation-settings: "opsz" 144;
}
.note-body p.note-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--sepia);
  letter-spacing: 0.08em;
}
.note-body p.note-meta:first-of-type:first-letter { all: unset; }
.note-body a { color: var(--oxblood); border-bottom: 1px solid var(--oxblood); text-decoration: none; }
.note-source {
  margin-top: 64px;
  padding-top: 32px;
  border-top: 1px solid var(--line);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--sepia);
}
.note-source a { color: var(--ink-soft); text-decoration: none; border-bottom: 1px solid var(--sepia); }
.note-source a:hover { color: var(--oxblood); border-color: var(--oxblood); }
</style>
</head>
<body>
<div class="note reveal">
  <a class="note-back" href="/">← Back to journey</a>
  <h1 class="note-title">${escapeHtml(row.title)}</h1>
  ${row.place || row.country ? `<p class="note-loc">${escapeHtml([row.place, row.country].filter(Boolean).join(", "))}</p>` : ""}
  <p class="note-date">Logged ${formatDate(row.created_at)} · ${row.word_count ?? 0} words · via ${escapeHtml(row.source)}</p>
  <div class="note-body">${bodyHtml}</div>
  ${row.source_url ? `<p class="note-source">Source: <a href="${escapeHtml(row.source_url)}" target="_blank" rel="noopener">${escapeHtml(row.source_url)}</a></p>` : ""}
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin login
// ─────────────────────────────────────────────────────────────────────────────

export function renderAdminLogin(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · WatchOMacho</title>
${FONTS}
<style>
${BASE_CSS}
body { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
.login {
  background: var(--paper-deep);
  border: 1px solid var(--line);
  padding: 48px;
  max-width: 420px;
  width: calc(100% - 32px);
  position: relative;
  z-index: 2;
}
.login h1 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 36px;
  letter-spacing: -0.02em;
  font-variation-settings: "opsz" 144;
}
.login h1 em { font-style: italic; color: var(--oxblood); }
.login p { color: var(--ink-soft); font-size: 15px; margin-top: 8px; }
.login input {
  width: 100%;
  margin-top: 28px;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 14px;
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 2px;
  color: var(--ink);
}
.login input:focus { outline: none; border-color: var(--oxblood); }
.login button {
  width: 100%;
  margin-top: 16px;
  padding: 14px;
  background: var(--ink);
  color: var(--paper);
  border: none;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 2px;
}
.login button:hover { background: var(--oxblood); }
.login .back {
  display: block;
  margin-top: 24px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--sepia);
  text-decoration: none;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.err {
  color: var(--oxblood);
  font-family: var(--font-mono);
  font-size: 12px;
  margin-top: 16px;
  letter-spacing: 0.05em;
}
</style>
</head>
<body>
<div class="login reveal">
  <h1>Admin <em>gate</em></h1>
  <p>Enter the agent's secret to unlock.</p>
  <form method="post" action="/admin/login">
    <input type="password" name="secret" placeholder="secret" autofocus autocomplete="off">
    <button type="submit">Unlock</button>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  </form>
  <a class="back" href="/">← Back to journey</a>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin panel
// ─────────────────────────────────────────────────────────────────────────────

export async function renderAdminPanel(env: Env): Promise<string> {
  const runs = await env.DB.prepare(
    "SELECT * FROM runs ORDER BY created_at DESC LIMIT 20",
  ).all<any>();

  const recentNote = await env.DB.prepare(
    "SELECT id, title, created_at FROM notes ORDER BY created_at DESC LIMIT 1",
  ).first<any>();

  const runsHtml = (runs.results ?? [])
    .map(
      (r: any) => `
    <tr>
      <td class="mono">${formatDate(r.created_at)} · ${new Date(r.created_at).toTimeString().slice(0, 5)}</td>
      <td class="mono">${escapeHtml(r.triggered_by)}</td>
      <td>${r.status === "success" ? escapeHtml(r.topic_chosen ?? "") : `<span style="color: var(--oxblood)">${escapeHtml(r.error ?? "")}</span>`}</td>
      <td class="mono">${r.duration_ms}ms</td>
      <td><span class="badge badge-${r.status}">${r.status}</span></td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin · WatchOMacho</title>
${FONTS}
<style>
${BASE_CSS}
.admin { padding: 56px 0 96px; }
.toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.back-link {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--sepia);
  text-decoration: none;
  text-transform: uppercase;
}
.back-link:hover { color: var(--oxblood); }
.logout button {
  background: transparent;
  border: 1px solid var(--sepia);
  color: var(--sepia);
  cursor: pointer;
  padding: 8px 14px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.logout button:hover { color: var(--oxblood); border-color: var(--oxblood); }
.admin h1 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(40px, 6vw, 56px);
  letter-spacing: -0.03em;
  margin-top: 32px;
  font-variation-settings: "opsz" 144;
}
.admin h1 em { font-style: italic; color: var(--oxblood); }
.last-entry {
  color: var(--ink-soft);
  margin-top: 8px;
  font-style: italic;
}
.last-entry strong { font-style: normal; color: var(--ink); font-weight: 500; }
.admin-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 32px;
  margin-top: 48px;
}
.panel {
  background: rgba(221, 208, 179, 0.4);
  border: 1px solid var(--line);
  padding: 32px;
  border-radius: 2px;
}
.panel h3 {
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 500;
  letter-spacing: -0.01em;
}
.panel .desc { color: var(--ink-soft); font-size: 14px; margin-top: 6px; font-style: italic; }
.panel form { margin-top: 20px; display: flex; flex-direction: column; gap: 12px; }
.panel input, .panel textarea {
  background: var(--paper);
  border: 1px solid var(--line);
  padding: 12px;
  font-family: var(--font-body);
  font-size: 15px;
  border-radius: 2px;
  color: var(--ink);
}
.panel textarea { min-height: 80px; resize: vertical; }
.panel input:focus, .panel textarea:focus { outline: none; border-color: var(--oxblood); }
.panel button {
  background: var(--ink);
  color: var(--paper);
  border: none;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 2px;
}
.panel button:hover { background: var(--oxblood); }
#ask-result {
  margin-top: 20px;
  padding: 16px 20px;
  background: var(--paper);
  border-left: 3px solid var(--teal);
  font-size: 16px;
  line-height: 1.65;
  display: none;
}
#ask-result.show { display: block; }
#ask-result .sources {
  margin-top: 16px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--sepia);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
h2.runs-title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 400;
  letter-spacing: -0.02em;
  margin-top: 80px;
}
h2.runs-title em { font-style: italic; color: var(--oxblood); }
table.runs { width: 100%; margin-top: 24px; border-collapse: collapse; }
table.runs th {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--sepia);
  text-align: left;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
table.runs td { padding: 14px 16px; border-bottom: 1px solid var(--line); font-size: 15px; }
table.runs td.mono { font-family: var(--font-mono); font-size: 12px; color: var(--ink-soft); }
.badge {
  display: inline-block;
  padding: 3px 9px;
  border-radius: 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.badge-success { background: rgba(58, 107, 126, 0.15); color: var(--teal); }
.badge-error { background: rgba(122, 46, 42, 0.12); color: var(--oxblood); }
.empty-runs { text-align: center; padding: 48px; color: var(--sepia); font-style: italic; }
@media (max-width: 720px) {
  .admin-grid { grid-template-columns: 1fr; gap: 20px; }
  .panel { padding: 24px; }
  table.runs th, table.runs td { padding: 10px 8px; font-size: 13px; }
}
</style>
</head>
<body>
<div class="container admin">
  <div class="toolbar">
    <a class="back-link" href="/">← Back to journey</a>
    <form class="logout" method="post" action="/admin/logout"><button type="submit">Logout</button></form>
  </div>
  <h1>Admin <em>console</em></h1>
  ${recentNote ? `<p class="last-entry">Last entry: <strong>${escapeHtml(recentNote.title)}</strong> — ${escapeHtml(timeAgo(recentNote.created_at))}</p>` : `<p class="last-entry">No entries yet. Trigger the first run below.</p>`}

  <div class="admin-grid">
    <div class="panel">
      <h3>Trigger a run</h3>
      <p class="desc">Run the agent now. Leave the prompt empty for autonomous exploration, or steer it.</p>
      <form method="post" action="/admin/run">
        <textarea name="prompt" placeholder="Optional: 'Tell me about Bhutan' or 'Find me an unusual island'"></textarea>
        <button type="submit">Run agent now</button>
      </form>
    </div>

    <div class="panel">
      <h3>Ask the agent</h3>
      <p class="desc">Query its memory. It pulls from every field note it has written.</p>
      <form id="ask-form">
        <textarea name="question" placeholder="What have you learned about island nations?" required></textarea>
        <button type="submit">Ask</button>
      </form>
      <div id="ask-result"></div>
    </div>
  </div>

  <h2 class="runs-title">Recent <em>runs</em></h2>
  <table class="runs">
    <thead><tr><th>When</th><th>Trigger</th><th>Topic / error</th><th>Duration</th><th>Status</th></tr></thead>
    <tbody>${runsHtml || `<tr><td colspan="5" class="empty-runs">No runs yet.</td></tr>`}</tbody>
  </table>
</div>

<script>
  document.getElementById('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    const result = document.getElementById('ask-result');
    result.classList.add('show');
    result.innerHTML = 'Thinking…';
    btn.disabled = true;
    try {
      const fd = new FormData(form);
      const res = await fetch('/admin/ask', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const escaped = data.answer.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
      const sources = (data.sources && data.sources.length)
        ? '<div class="sources">Sources · ' + data.sources.map(s => s.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))).join(' · ') + '</div>'
        : '';
      result.innerHTML = escaped.replace(/\\n/g, '<br>') + sources;
    } catch (err) {
      result.textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
