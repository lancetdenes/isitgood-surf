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
