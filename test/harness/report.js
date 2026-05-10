/**
 * Usage: node test/harness/report.js
 *
 * Reads every test/snapshots/<phase>/summary.json and emits a single
 * test/snapshots/report.html showing each fixture as a row with one
 * thumbnail per phase.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAP = join(ROOT, 'test', 'snapshots');

const PHASE_ORDER = ['baseline', 'after-c2', 'after-i3-i6', 'after-i2', 'after-i1', 'after-c1', 'final'];

const phaseDirs = readdirSync(SNAP, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

// Sort by canonical phase order; unknown phases come last alphabetically.
const phases = phaseDirs.sort((a, b) => {
  const ai = PHASE_ORDER.indexOf(a), bi = PHASE_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
});

const phaseData = {};
const allFixtures = new Map();
for (const p of phases) {
  const f = join(SNAP, p, 'summary.json');
  if (!existsSync(f)) continue;
  const s = JSON.parse(readFileSync(f, 'utf8'));
  phaseData[p] = s;
  for (const r of s.results) {
    if (!allFixtures.has(r.name)) {
      allFixtures.set(r.name, { group: r.group, lat: r.lat, lon: r.lon, slug: r.slug });
    }
  }
}

const groups = {};
for (const [name, meta] of allFixtures) {
  (groups[meta.group] ||= []).push({ name, ...meta });
}

const groupOrder = ['baseline', 'antimeridian', 'high-lat', 'indented', 'smooth', 'mysto'];
const orderedGroupNames = Object.keys(groups).sort((a, b) => {
  const ai = groupOrder.indexOf(a), bi = groupOrder.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
});

const phaseCols = phases.length;
const rows = [];
for (const groupName of orderedGroupNames) {
  rows.push(`<tr class="group-header"><td colspan="${phaseCols + 1}">${groupName}</td></tr>`);
  for (const fx of groups[groupName]) {
    const cells = phases.map(p => {
      const r = phaseData[p]?.results.find(x => x.name === fx.name);
      if (!r) return '<td class="empty">—</td>';
      const dot = r.ok ? '🟢' : '🔴';
      const label = r.ok ? 'pass' : (r.failures || []).join('; ');
      const img = `<img src="${p}/${fx.slug}.png" width="180" height="180" loading="lazy" alt="${fx.name} ${p}">`;
      const meta = r.coast || r.seawardDir != null
        ? `${r.seawardDir != null ? r.seawardDir.toFixed(1) + '°' : '?'} / ${r.distanceKm != null ? r.distanceKm.toFixed(2) + 'km' : '?'}`
        : 'no candidate';
      return `<td><div class="snap">${img}</div><div class="dot">${dot} ${meta}</div><div class="fail">${label}</div></td>`;
    }).join('');
    rows.push(`<tr><td class="name">${fx.name}<br><small>${fx.lat}, ${fx.lon}</small></td>${cells}</tr>`);
  }
}

const summaryHeader = phases.map(p => {
  const s = phaseData[p];
  return `<th>${p}<br><small>${s?.pass || 0}/${s?.results?.length || 0}</small></th>`;
}).join('');

const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Coastline Snapshot Report</title>
<style>
body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0f172a; color: #e2e8f0; margin: 0; padding: 1rem; }
h1 { font-size: 1.2rem; margin: 0 0 0.5rem; }
table { border-collapse: collapse; }
th, td { padding: 4px 8px; vertical-align: top; border: 1px solid #334155; }
th { background: #1e293b; position: sticky; top: 0; z-index: 1; }
.group-header td { background: #312e81; font-weight: bold; padding: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
.name { font-weight: bold; min-width: 11rem; }
.snap img { display: block; background: #0f172a; }
.dot { font-size: 0.8em; color: #94a3b8; padding-top: 2px; }
.fail { font-size: 0.75em; color: #f87171; max-width: 180px; padding-top: 2px; }
.empty { color: #475569; text-align: center; }
small { color: #64748b; font-weight: normal; }
.summary { margin-bottom: 1rem; padding: 0.5rem 0.75rem; background: #1e293b; border: 1px solid #334155; display: inline-block; }
</style>
</head><body>
<h1>Coastline Snapshot Report</h1>
<div class="summary">${phases.map(p => {
  const s = phaseData[p];
  const tot = s?.results?.length || 0;
  return `${p}: <b>${s?.pass || 0}/${tot}</b>`;
}).join(' · ')}</div>
<table>
<thead><tr><th>Fixture</th>${summaryHeader}</tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table>
</body></html>`;

writeFileSync(join(SNAP, 'report.html'), html);
console.log(`Report written to ${join(SNAP, 'report.html')} (${phases.length} phases, ${allFixtures.size} fixtures)`);
