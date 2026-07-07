import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bboxFor } from '../query.mjs';

test('bbox spans ~2x radius and widens with latitude', () => {
  const b = bboxFor(40, -74, 25);
  assert.ok(Math.abs((b.maxLat - b.minLat) - 0.4496) < 0.01);
  const bHigh = bboxFor(60, -74, 25);
  assert.ok((bHigh.maxLng - bHigh.minLng) > (b.maxLng - b.minLng));
});
