import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, destinationPoint, bearingDeg } from '../lib/geo.js';

test('haversineKm: NY to LA is ~3940km', () => {
  // JFK 40.6413, -73.7781 → LAX 33.9416, -118.4085
  const d = haversineKm(40.6413, -73.7781, 33.9416, -118.4085);
  assert.ok(d > 3930 && d < 3980, `got ${d}`);
});

test('haversineKm: same point is 0', () => {
  assert.equal(haversineKm(10, 20, 10, 20), 0);
});

test('destinationPoint: moving 10km east from equator lands ~0.0899° east', () => {
  const { lat, lon } = destinationPoint(0, 0, 90, 10);
  assert.ok(Math.abs(lat) < 1e-6, `lat drift ${lat}`);
  assert.ok(Math.abs(lon - 0.0899) < 0.005, `lon ${lon}`);
});

test('bearingDeg: N is 0, E is 90', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0)) < 0.1);          // north
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.1);     // east
});
