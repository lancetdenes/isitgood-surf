import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToSpot, nearestSpot, haversineKm, SNAP_KM, NEAR_KM } from '../../../public/js/spot-snap.js';
import { spotNameFor, getSpots } from '../spots.mjs';

const SPOTS = [
  { n: 'Higgins Beach', r: 'Maine, US', la: 43.56, ln: -70.23 },
  { n: 'Nantasket', r: 'Massachusetts, US', la: 42.27, ln: -70.87 },
];

test('thresholds match the spec (2 km snap, 10 km near)', () => {
  assert.equal(SNAP_KM, 2);
  assert.equal(NEAR_KM, 10);
});

test('within 2 km snaps to the spot name', () => {
  const s = snapToSpot(SPOTS, 43.565, -70.235); // ~0.7 km from Higgins
  assert.equal(s.tier, 'at');
  assert.equal(s.label, 'Higgins Beach');
  assert.ok(s.km < 2, `km=${s.km}`);
});

test('between 2 and 10 km labels "near <spot>"', () => {
  const s = snapToSpot(SPOTS, 43.60, -70.28); // ~6 km from Higgins
  assert.equal(s.tier, 'near');
  assert.equal(s.label, 'near Higgins Beach');
  assert.ok(s.km > 2 && s.km < 10, `km=${s.km}`);
});

test('beyond 10 km returns no spot association', () => {
  const s = snapToSpot(SPOTS, 44.5, -68.0); // deep in the Gulf of Maine
  assert.equal(s.tier, 'far');
  assert.equal(s.spot, null);
  assert.equal(s.label, null);
});

test('nearestSpot picks the closest of several', () => {
  const hit = nearestSpot(SPOTS, 42.3, -70.9);
  assert.equal(hit.spot.n, 'Nantasket');
});

test('empty or missing spot list is handled', () => {
  assert.equal(nearestSpot([], 43, -70), null);
  assert.deepEqual(snapToSpot([], 43, -70), { tier: 'far', spot: null, km: null, label: null });
});

test('haversine sanity: NYC to Philly ~130 km', () => {
  const d = haversineKm(40.7128, -74.006, 39.9526, -75.1652);
  assert.ok(d > 120 && d < 140, `got ${d}`);
});

test('spotNameFor uses the real shipped named-spots data', () => {
  assert.ok(getSpots().length > 500);
  assert.equal(spotNameFor(43.56, -70.23), 'Higgins Beach');   // exact coords
  assert.match(spotNameFor(43.60, -70.28) || '', /^near /);    // a few km off
  assert.equal(spotNameFor(0, 0), null);                       // open ocean
});
