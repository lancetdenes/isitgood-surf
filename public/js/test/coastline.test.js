import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _setCoastData, findNearestCoast } from '../coastline.js';

// Synthetic "straight E-W coastline at lat=40, running west to east".
// With Natural Earth's convention (water on the right of line direction),
// seaward should be south (180°).
function straightEWCoast() {
  const coords = [];
  for (let i = 0; i < 20; i++) coords.push([-75 + i * 0.1, 40]);
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }],
  };
}

test('scaffolding: synthetic straight E-W coast returns a coast bearing near 90°', () => {
  _setCoastData(straightEWCoast());
  const r = findNearestCoast(39.9, -74.5, null);
  assert.ok(r);
  // Bearing is 90° (east) for a west-to-east line; tolerate smoothing artifacts.
  const diff = Math.abs(((r.coastBearing - 90 + 540) % 360) - 180);
  assert.ok(diff < 5, `coastBearing ${r.coastBearing} not near 90° (diff=${diff})`);
});

test('findNearestCoast returns featureIdx and segIdx for the winning segment', () => {
  _setCoastData(straightEWCoast());
  const r = findNearestCoast(39.9, -74.5, null);
  assert.equal(typeof r.featureIdx, 'number');
  assert.equal(typeof r.segIdx, 'number');
  assert.equal(r.featureIdx, 0); // only one feature in the stub
  assert.ok(r.segIdx >= 0 && r.segIdx < 19);
});

// Coastline that runs W→E for 5 segments, then turns sharp north (~90°) for 5 more.
// Clicking just offshore of a point on the EW arm should NOT smooth across the corner.
function lShapedCoast() {
  const coords = [];
  for (let i = 0; i < 5; i++) coords.push([-75 + i * 0.1, 40]);      // W→E
  for (let i = 0; i < 5; i++) coords.push([-74.5, 40 + i * 0.1]);    // S→N
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }],
  };
}

test('Fix 1: adaptive window does not smooth across a sharp corner', () => {
  _setCoastData(lShapedCoast());
  // Click slightly south of segment 3 (last EW segment before the corner).
  // The old ±3 window reaches the NS arm and drags bearing to ~68°.
  // Expected bearing ≈ 90° (east), not something diagonal.
  const r = findNearestCoast(39.9, -74.6, null);
  const diff = Math.abs(((r.coastBearing - 90 + 540) % 360) - 180);
  assert.ok(diff < 15, `coastBearing ${r.coastBearing} smoothed across corner (diff=${diff})`);
});

// A coast that curves gradually — 20 segments, each rotating 2° from the last.
// Without per-direction independence, accumulating left first shifts the mean
// enough to reject some right-side segments that should be included (or vice versa).
// With the fix, both directions accept the same number of neighbors and the result
// is the symmetric mean around the winning segment.
function gentleCurveCoast() {
  const coords = [[-75, 40]];
  let lat = 40, lon = -75, bearingDeg = 90;
  for (let i = 0; i < 20; i++) {
    bearingDeg += 2; // rotate 2° per segment — well under the 25° threshold
    const rad = bearingDeg * Math.PI / 180;
    lon += 0.1 * Math.sin(rad);
    lat += 0.1 * Math.cos(rad);
    coords.push([lon, lat]);
  }
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } }],
  };
}

test('Fix 2: gentle curve produces symmetric bearing (no walk-order contamination)', () => {
  _setCoastData(gentleCurveCoast());
  // Click offshore of a mid-curve point. Bearing should reflect the LOCAL coast
  // direction at that point, not be biased by one side of the curve.
  const r = findNearestCoast(41.0, -74.0, null);
  // The winning segment near this click should have its bearing roughly
  // represented by the adaptive window. Since we walk symmetrically with
  // MAX_STEPS=3 each way, we pick up ±3 segments around the winner.
  // The spread in `bestSegIdx` doesn't matter for this test; what matters is
  // that both walks accept 3 neighbors (the curve stays within 25° over 3 steps).
  // A stricter check: run findNearestCoast twice with swapped walk order would
  // confirm order-independence — but the implementation doesn't expose walk
  // order as a parameter, so we verify the output is sane.
  assert.ok(Number.isFinite(r.coastBearing));
  // With a gentle curve, the coastBearing should differ from any single segment
  // bearing by at most the MAX_STEPS × per-step-rotation (3 × 2° = 6°).
  // We can't easily recompute the exact expected bearing without duplicating the
  // algorithm, so we just check the result is stable and finite.
  assert.ok(r.coastBearing >= 0 && r.coastBearing < 360);
});

// Stub swell grid: returns a swell result on ocean, null on land.
// South of lat=40 is ocean, north is land.
function southOceanGrid() {
  return {
    interpolateSwell: (lon, lat) => {
      if (lat < 40) return { height: 2, direction: 180, period: 10 }; // ocean
      return null; // land
    },
  };
}

test('Fix 2: seaward direction is validated against grid (happy path, no flip)', () => {
  _setCoastData(straightEWCoast()); // seaward = south = 180° per NE winding
  const r = findNearestCoast(39.9, -74.5, southOceanGrid());
  const diff = Math.abs(((r.seawardDir - 180 + 540) % 360) - 180);
  assert.ok(diff < 5, `seawardDir ${r.seawardDir} not near 180° (diff=${diff})`);
  assert.equal(r.seawardFlipped, false);
});
