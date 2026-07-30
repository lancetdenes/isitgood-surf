import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bboxFor, parseBbox, clampSinceHours } from '../query.mjs';

test('bbox spans ~2x radius and widens with latitude', () => {
  const b = bboxFor(40, -74, 25);
  assert.ok(Math.abs((b.maxLat - b.minLat) - 0.4496) < 0.01);
  const bHigh = bboxFor(60, -74, 25);
  assert.ok((bHigh.maxLng - bHigh.minLng) > (b.maxLng - b.minLng));
});

test('parseBbox accepts w,s,e,n and returns numbers', () => {
  assert.deepEqual(parseBbox('-75.5,38,-70,42.25'), { w: -75.5, s: 38, e: -70, n: 42.25 });
});

test('parseBbox rejects malformed input', () => {
  for (const bad of [
    undefined, '', '1,2,3', '1,2,3,4,5', 'a,b,c,d',
    '-70,42,-75,38',        // inverted (w>e, s>n)
    '-75,-95,-70,40',       // s out of range
    '170,10,-170,20',       // antimeridian crossing
    '-200,10,-100,20',      // w out of range
  ]) {
    assert.throws(() => parseBbox(bad), /bad_bbox/, `should reject ${JSON.stringify(bad)}`);
  }
});

test('clampSinceHours defaults to a week and caps at 30 days', () => {
  assert.equal(clampSinceHours(undefined), 168);
  assert.equal(clampSinceHours('nope'), 168);
  assert.equal(clampSinceHours(-5), 168);
  assert.equal(clampSinceHours(48), 48);
  assert.equal(clampSinceHours(99999), 720);
});
