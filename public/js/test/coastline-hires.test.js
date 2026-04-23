import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../../../data/scripts/lib/coastline-binary.js';
import { _setHiresData, isHiresReady, _resetHires, setKDBush } from '../coastline-hires.js';

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
