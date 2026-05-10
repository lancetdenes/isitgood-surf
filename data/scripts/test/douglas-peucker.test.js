import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyDP } from '../lib/douglas-peucker.js';

test('simplifyDP removes co-linear points', () => {
  // 5 collinear points along a line. DP should keep only endpoints.
  const pts = [[0, 0], [0.001, 0], [0.002, 0], [0.003, 0], [0.004, 0]];
  const out = simplifyDP(pts, 50); // 50m tolerance
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [0.004, 0]);
});

test('simplifyDP preserves sharp corners', () => {
  // Right angle: should keep all 3 points.
  const pts = [[0, 0], [0.01, 0], [0.01, 0.01]];
  const out = simplifyDP(pts, 50);
  assert.equal(out.length, 3);
});

test('simplifyDP handles degenerate input', () => {
  assert.deepEqual(simplifyDP([], 100), []);
  assert.deepEqual(simplifyDP([[0, 0]], 100), [[0, 0]]);
  assert.deepEqual(simplifyDP([[0, 0], [1, 1]], 100), [[0, 0], [1, 1]]);
});
