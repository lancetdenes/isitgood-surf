import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeCoastlineBinary, parseCoastlineBinary } from '../lib/coastline-binary.js';

test('coastline binary round-trips a small feature set', () => {
  const features = [
    [[0, 0], [1, 0], [1, 1], [0, 1]],      // square
    [[10, 10], [11, 10], [11, 11]],         // triangle
  ];
  const buf = writeCoastlineBinary(features);
  const parsed = parseCoastlineBinary(buf.buffer);
  assert.equal(parsed.nFeatures, 2);
  assert.equal(parsed.nVertices, 7);
  // Feature 0
  const f0 = parsed.feature(0);
  assert.equal(f0.length, 4);
  assert.ok(Math.abs(f0[0][0] - 0) < 1e-5);
  assert.ok(Math.abs(f0[2][1] - 1) < 1e-5);
  // Feature 1
  const f1 = parsed.feature(1);
  assert.equal(f1.length, 3);
  assert.ok(Math.abs(f1[0][0] - 10) < 1e-5);
});

test('coastline binary rejects invalid magic', () => {
  const bad = new ArrayBuffer(16);
  assert.throws(() => parseCoastlineBinary(bad), /magic/i);
});
