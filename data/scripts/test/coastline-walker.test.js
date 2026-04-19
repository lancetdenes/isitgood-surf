import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkLineString } from '../lib/coastline-walker.js';
import { haversineKm } from '../lib/geo.js';

test('walkLineString: straight east-west 100km produces ~10 points at 10km spacing', () => {
  const coords = [[0, 0], [0.899, 0]];
  const pts = walkLineString(coords, 10);
  assert.ok(pts.length >= 9 && pts.length <= 12, `got ${pts.length}`);
  for (let i = 1; i < pts.length; i++) {
    const d = haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    assert.ok(d > 8 && d < 12, `spacing ${d}km between pt ${i - 1} and ${i}`);
  }
});

test('walkLineString: multi-segment line handles vertex transitions', () => {
  const coords = [[0, 0], [0.4495, 0], [0.4495, 0.4495]];
  const pts = walkLineString(coords, 10);
  assert.ok(pts.length >= 8 && pts.length <= 12, `got ${pts.length}`);
});

test('walkLineString: line shorter than step produces just the start point', () => {
  const coords = [[0, 0], [0.00899, 0]];
  const pts = walkLineString(coords, 10);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].lat, 0);
  assert.equal(pts[0].lon, 0);
});
