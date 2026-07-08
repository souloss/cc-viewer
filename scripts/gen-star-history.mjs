#!/usr/bin/env node
// Generate a self-hosted "Star History" SVG for the repo.
//
// GitHub restricts the star *timeline* (starred_at) to authenticated tokens with
// access to the repo, so star-history.com can no longer render it for third parties.
// This script uses the repo's own GITHUB_TOKEN (in Actions) to read its stargazers
// with dates and draws a dependency-free SVG line chart committed into the repo, so the
// README can display it to everyone without anyone needing a token.
//
// Env: GITHUB_TOKEN (required), STAR_REPO="owner/name" (default weiesky/cc-viewer),
//      OUT (default docs/star-history.svg)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REPO = process.env.STAR_REPO || 'weiesky/cc-viewer';
const OUT = process.env.OUT || 'docs/star-history.svg';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN is required'); process.exit(1); }

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github.star+json',
  'User-Agent': 'ccv-star-history',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function fetchStarDates() {
  const dates = [];
  for (let page = 1; page <= 400; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/stargazers?per_page=100&page=${page}`, { headers: H });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const s of arr) if (s && s.starred_at) dates.push(new Date(s.starred_at).getTime());
    if (arr.length < 100) break;
  }
  return dates.sort((a, b) => a - b);
}

// ---------- palette (matches the cc-viewer brand) ----------
const C = { bg: '#0d1117', grid: '#21262d', line: '#30363d', axis: '#8b949e', dim: '#6e7681', text: '#e6edf3', accent: '#d97757' };
const W = 820, Hgt = 420, PL = 64, PR = 24, PT = 54, PB = 46;
const IW = W - PL - PR, IH = Hgt - PT - PB;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (t) => { const d = new Date(t); return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const niceMax = (n) => { if (n <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(n))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p; return 10 * p; };

function buildSvg(dates) {
  const total = dates.length;
  const now = Date.now();
  const header = `<text x="${PL}" y="30" font-size="16" font-weight="700" fill="${C.text}">Star History</text>` +
    `<text x="${PL}" y="30" font-size="16" font-weight="700" fill="${C.accent}" opacity="0"><tspan> </tspan></text>` +
    `<text x="${W - PR}" y="30" text-anchor="end" font-size="13" fill="${C.axis}">${esc(REPO)} · ${total} ★</text>` +
    `<text x="${PL}" y="47" font-size="11" fill="${C.dim}">cumulative stars over time · self-hosted, refreshed weekly</text>`;

  if (total === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hgt}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">` +
      `<rect width="${W}" height="${Hgt}" rx="12" fill="${C.bg}"/>${header}` +
      `<text x="${W / 2}" y="${Hgt / 2}" text-anchor="middle" font-size="13" fill="${C.dim}">No stars yet — be the first ★</text></svg>`;
  }

  const t0 = dates[0], t1 = Math.max(dates[total - 1], t0 + 1);
  const spanEnd = Math.max(t1, now);
  const yMax = niceMax(total);
  const x = (t) => PL + ((t - t0) / (spanEnd - t0)) * IW;
  const y = (v) => PT + IH - (v / yMax) * IH;

  // cumulative points, downsampled to keep the SVG small
  const pts = [];
  const step = Math.max(1, Math.floor(total / 240));
  for (let i = 0; i < total; i += step) pts.push([x(dates[i]), y(i + 1)]);
  pts.push([x(dates[total - 1]), y(total)]);
  pts.push([x(spanEnd), y(total)]); // flat to "now"

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${x(spanEnd).toFixed(1)} ${(PT + IH).toFixed(1)} L${PL.toFixed(1)} ${(PT + IH).toFixed(1)} Z`;

  // y gridlines/labels
  let grid = '';
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = (yMax / yTicks) * i, yy = y(v).toFixed(1);
    grid += `<line x1="${PL}" y1="${yy}" x2="${W - PR}" y2="${yy}" stroke="${C.grid}"/>`;
    grid += `<text x="${PL - 10}" y="${(+yy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${C.dim}">${Math.round(v)}</text>`;
  }
  // x labels (start / mid / end)
  let xlab = '';
  for (const t of [t0, (t0 + t1) / 2, t1]) {
    const xx = x(t);
    xlab += `<text x="${xx.toFixed(1)}" y="${Hgt - PB + 22}" text-anchor="middle" font-size="10" fill="${C.dim}">${fmtDate(t)}</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hgt}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
  <defs><linearGradient id="ar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.accent}" stop-opacity="0.28"/>
    <stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></linearGradient></defs>
  <rect width="${W}" height="${Hgt}" rx="12" fill="${C.bg}"/>
  ${header}
  ${grid}
  <path d="${area}" fill="url(#ar)"/>
  <path d="${line}" fill="none" stroke="${C.accent}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${x(dates[total - 1]).toFixed(1)}" cy="${y(total).toFixed(1)}" r="4" fill="${C.accent}"/>
  <line x1="${PL}" y1="${PT + IH}" x2="${W - PR}" y2="${PT + IH}" stroke="${C.line}"/>
  ${xlab}
  <text x="${W - PR}" y="${Hgt - 8}" text-anchor="end" font-size="9" fill="${C.dim}">updated ${fmtDate(now)}</text>
</svg>`;
}

const dates = await fetchStarDates();
const svg = buildSvg(dates);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`Wrote ${OUT} (${dates.length} stars)`);
