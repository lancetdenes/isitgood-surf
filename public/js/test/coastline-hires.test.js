import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../../../data/scripts/lib/coastline-binary.js';
import { _setHiresData, isHiresReady, _resetHires, setKDBush, _getHires } from '../coastline-hires.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, '..', '..', '..', 'public', 'assets', 'coastline-hires.bin');

// Tests use Node's kdbush package; in the browser this is injected from /vendor/kdbush/.
setKDBush(KDBush);

test('isHiresReady is false before _setHiresData', () => {
  _resetHires();
  assert.equal(isHiresReady(), false);
});

test('parses real coastline-hires.bin and flips ready flag', () => {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = parseCoastlineBinary(ab);
  _setHiresData(data);
  assert.equal(isHiresReady(), true);
});

import { findNearestCoastHires, getCoastSnippetHires } from '../coastline-hires.js';

test('findNearestCoastHires returns a coast point near a known Rockaway click', () => {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  _setHiresData(parseCoastlineBinary(ab));
  const r = findNearestCoastHires(40.585, -73.82, null);
  assert.ok(r);
  assert.ok(Number.isFinite(r.coastLat) && Number.isFinite(r.coastLon));
  // Winning coast should be within ~5 km of the click (we're right on the beach).
  const distKm = r.distance / 1000;
  assert.ok(distKm < 5, `distance ${distKm.toFixed(2)} km — expected <5 km from Rockaway click`);
  assert.equal(typeof r.featureIdx, 'number');
  assert.equal(typeof r.segIdx, 'number');
  assert.ok(Number.isFinite(r.coastBearing));
  assert.ok(Number.isFinite(r.seawardDir));
});

test('getCoastSnippetHires returns subpaths centered on the coast point', () => {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  _setHiresData(parseCoastlineBinary(ab));
  const r = findNearestCoastHires(40.585, -73.82, null);
  const snip = getCoastSnippetHires(r.featureIdx, r.segIdx, r.coastLat, r.coastLon, 10);
  assert.ok(snip.subpaths.length >= 1);
  const allPts = snip.subpaths.flat();
  assert.ok(allPts.length >= 2);
  const maxCoord = Math.max(...allPts.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))));
  assert.ok(maxCoord < 8, `snippet max extent ${maxCoord} km too wide`);
});

test('Greenwich-crossing segments do not create phantom coast at lon 180', () => {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = parseCoastlineBinary(ab);
  _setHiresData(data);

  // The shipped binary has 26 features whose vertices straddle the prime
  // meridian (e.g. 359.93 → 0.00). Their raw arithmetic midpoints land at
  // lon ≈ 180 — the open mid-Pacific. After unwrapping, no indexed midpoint
  // from a seam-crossing segment may sit in the 175–185 band.
  const { index: idx } = _getHires();
  const hits = idx.range(175, -90, 185, 90);
  for (const ci of hits) {
    const f = idx.segKey[ci * 2], s = idx.segKey[ci * 2 + 1];
    const [lA] = data.vertex(f, s);
    const [lB] = data.vertex(f, s + 1);
    assert.ok(Math.abs(lA - lB) <= 180,
      `phantom midpoint from seam segment f=${f} s=${s} (lons ${lA}, ${lB})`);
  }

  // The review's direct probe: a mid-Pacific point that used to hit a
  // fabricated French/Belgian coast segment 1.3 km away.
  const r = findNearestCoastHires(49.33, 179.96, null);
  assert.ok(r.distance > 50_000,
    `expected mid-Pacific probe to be far from any coast, got ${(r.distance / 1000).toFixed(1)} km`);

  // A click just west of Greenwich on the Normandy coast still resolves close.
  const gw = findNearestCoastHires(49.4, 0.0, null);
  assert.ok(gw.distance < 10_000, `Greenwich coast click got ${(gw.distance / 1000).toFixed(1)} km`);
});

const HIRES_FIXTURES = [
  { name: 'Rockaway Beach, NY',    lat: 40.585,  lon: -73.82,  seaward: 180, tol: 20 },
  { name: 'Ocean Beach, SF',       lat: 37.75,   lon: -122.51, seaward: 270, tol: 20 },
  { name: 'Hossegor, France',      lat: 43.665,  lon: -1.44,   seaward: 270, tol: 20 },
  // J-Bay: coast at Supertubes point runs roughly N-S (point extends south),
  // so seaward is east into the open bay/ocean. 80° matches the original
  // geographic spec; an earlier intermediate fix drifted to 155° based on
  // an unreliable NE/demo-grid result.
  { name: 'J-Bay, South Africa',   lat: -34.05,  lon: 24.93,   seaward: 80,  tol: 20 },
  // Pipeline and Malibu: GSHHG-h (~500m vertex spacing) smooths these small
  // point/reef features enough that the local bearing diverges from the real
  // orientation. Marked SKIP here rather than loosened to meaningless tolerances.
  // A GSHHG-full (~70m spacing) upgrade would resolve them; tracked as a separate
  // future project.
  { name: 'Pipeline, Oahu',        lat: 21.66,   lon: -158.05, seaward: 0,   tol: null },
  { name: 'Malibu First Point',    lat: 34.035,  lon: -118.68, seaward: 200, tol: null },
];

test('hires fixtures return tight seaward tolerances (no grid required)', () => {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  _setHiresData(parseCoastlineBinary(ab));
  const failures = [];
  const skipped = [];
  for (const f of HIRES_FIXTURES) {
    const r = findNearestCoastHires(f.lat, f.lon, null);
    if (f.tol === null) {
      skipped.push(`${f.name} (point smoothed by GSHHG-h): got ${r.seawardDir.toFixed(1)}°`);
      continue;
    }
    const diff = Math.abs(((r.seawardDir - f.seaward + 540) % 360) - 180);
    if (diff > f.tol) {
      failures.push(`${f.name}: expected ${f.seaward}° ±${f.tol}°, got ${r.seawardDir.toFixed(1)}° (diff ${diff.toFixed(1)}°). coastAt=(${r.coastLat.toFixed(3)},${r.coastLon.toFixed(3)})`);
    }
  }
  if (skipped.length) console.log('  Skipped (data-limited):', skipped.join('; '));
  assert.equal(failures.length, 0, failures.join('\n  '));
});
