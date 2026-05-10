import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../lib/coastline-binary.js';
import { findNearestCoastNode, buildIndex } from '../lib/find-nearest-coast-node.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', '..', '..', 'public', 'assets', 'coastline-hires.bin');

test('findNearestCoastNode finds Rockaway within 5 km', () => {
  const buf = readFileSync(BIN);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = parseCoastlineBinary(ab);
  const idx = buildIndex(KDBush, data);
  const r = findNearestCoastNode(data, idx, 40.585, -73.82);
  assert.equal(r.unreliableBearing, false);
  assert.ok(r.distance / 1000 < 5, `distance ${r.distance / 1000}km`);
  assert.ok(Number.isFinite(r.coastBearing));
  assert.ok(Number.isFinite(r.seawardDir));
});

test('findNearestCoastNode returns unreliable for mid-Pacific', () => {
  const buf = readFileSync(BIN);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = parseCoastlineBinary(ab);
  const idx = buildIndex(KDBush, data);
  const r = findNearestCoastNode(data, idx, 0, -150);
  assert.equal(r.unreliableBearing, true);
  assert.equal(r.featureIdx, -1);
});
