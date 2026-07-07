import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, resolveStampSource } from '../stamp.mjs';

test('haversine sanity: NYC to Philly ~ 130 km', () => {
  const d = haversineKm(40.7128, -74.006, 39.9526, -75.1652);
  assert.ok(d > 120 && d < 140, `got ${d}`);
});

const T = '2026-07-01T12:00:00Z';

test('claimed exif + matching server exif stays exif', () => {
  const out = resolveStampSource({
    claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' },
    exif: { lat: 40.01, lng: -74.01, capturedAt: '2026-07-01T11:00:00Z' },
  });
  assert.equal(out, 'exif');
});

test('claimed exif but >25km away downgrades to manual', () => {
  const out = resolveStampSource({
    claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' },
    exif: { lat: 41, lng: -74, capturedAt: T },
  });
  assert.equal(out, 'manual');
});

test('claimed exif but >48h off downgrades to manual', () => {
  const out = resolveStampSource({
    claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' },
    exif: { lat: 40, lng: -74, capturedAt: '2026-06-25T12:00:00Z' },
  });
  assert.equal(out, 'manual');
});

test('claimed exif with no server exif downgrades to manual', () => {
  const out = resolveStampSource({ claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' }, exif: null });
  assert.equal(out, 'manual');
});

test('device and manual claims pass through', () => {
  assert.equal(resolveStampSource({ claimed: { lat: 0, lng: 0, capturedAt: T, source: 'device' }, exif: null }), 'device');
  assert.equal(resolveStampSource({ claimed: { lat: 0, lng: 0, capturedAt: T, source: 'manual' }, exif: null }), 'manual');
});
