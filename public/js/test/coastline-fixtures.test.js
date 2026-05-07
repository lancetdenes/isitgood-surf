import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../../../data/scripts/lib/coastline-binary.js';
import { _resetHires, _setHiresData, setKDBush, findNearestCoastHires, getCoastSnippetHires } from '../coastline-hires.js';
import { COASTLINE_FIXTURES } from '../../../test/fixtures/coastline-spots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, '..', '..', 'assets', 'coastline-hires.bin');

setKDBush(KDBush);

function loadBin() {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  _setHiresData(parseCoastlineBinary(ab));
}

function snippetSpread(snip) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sub of snip.subpaths) {
    for (const p of sub) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { dx: maxX - minX, dy: maxY - minY, span: Math.hypot(maxX - minX, maxY - minY) };
}

function vertexCount(snip) {
  return snip.subpaths.reduce((s, sp) => s + sp.length, 0);
}

test('findNearestCoastHires: every fixture finds a coast within 5 km', () => {
  loadBin();
  const failures = [];
  for (const f of COASTLINE_FIXTURES) {
    const r = findNearestCoastHires(f.lat, f.lon, null);
    if (!r || !Number.isFinite(r.distance)) {
      failures.push(`${f.name}: no candidate found at all`);
      continue;
    }
    if (r.unreliableBearing) {
      failures.push(`${f.name}: unreliableBearing flag is set`);
      continue;
    }
    const km = r.distance / 1000;
    if (km > 5) failures.push(`${f.name}: nearest coast ${km.toFixed(2)} km > 5 km tolerance`);
  }
  assert.equal(failures.length, 0, '\n  ' + failures.join('\n  '));
});

test('getCoastSnippetHires: snippet has at least 6 vertices and 6km spread', () => {
  loadBin();
  const failures = [];
  for (const f of COASTLINE_FIXTURES) {
    const r = findNearestCoastHires(f.lat, f.lon, null);
    if (!r || r.unreliableBearing) continue; // covered by previous test
    const snip = getCoastSnippetHires(r.featureIdx, r.segIdx, r.coastLat, r.coastLon, 10);
    const n = vertexCount(snip);
    const { span } = snippetSpread(snip);
    if (n < 6) failures.push(`${f.name}: snippet has only ${n} vertices`);
    if (span < 6) failures.push(`${f.name}: snippet span ${span.toFixed(2)} km < 6 km`);
  }
  assert.equal(failures.length, 0, '\n  ' + failures.join('\n  '));
});

test('getCoastSnippetHires: at most two subpaths per fixture', () => {
  loadBin();
  const failures = [];
  for (const f of COASTLINE_FIXTURES) {
    const r = findNearestCoastHires(f.lat, f.lon, null);
    if (!r || r.unreliableBearing) continue;
    const snip = getCoastSnippetHires(r.featureIdx, r.segIdx, r.coastLat, r.coastLon, 10);
    if (snip.subpaths.length > 2) {
      failures.push(`${f.name}: ${snip.subpaths.length} subpaths (expected ≤ 2)`);
    }
  }
  assert.equal(failures.length, 0, '\n  ' + failures.join('\n  '));
});

test('seawardDir matches expected within fixture tolerance', () => {
  loadBin();
  const failures = [];
  const skipped = [];
  for (const f of COASTLINE_FIXTURES) {
    if (f.tol === null) { skipped.push(f.name); continue; }
    const r = findNearestCoastHires(f.lat, f.lon, null);
    const diff = Math.abs(((r.seawardDir - f.expectedSeaward + 540) % 360) - 180);
    if (diff > f.tol) {
      failures.push(`${f.name}: seaward ${r.seawardDir.toFixed(1)}° vs expected ${f.expectedSeaward}° (diff ${diff.toFixed(1)}° > ±${f.tol}°)`);
    }
  }
  if (skipped.length) console.log('  Skipped (tol=null):', skipped.join(', '));
  assert.equal(failures.length, 0, '\n  ' + failures.join('\n  '));
});
