/**
 * For a given fixture spot, run findNearestCoastHires + getCoastSnippetHires
 * against the loaded GSHHG binary, then render the same compass SVG that
 * panel.js produces, plus rasterize to PNG.
 *
 * Returns { ok, snip, coast, svg, png, checks } where:
 *   ok    - boolean: heuristic checks passed for this spot
 *   svg   - SVG string
 *   png   - Buffer
 */
import { Resvg } from '@resvg/resvg-js';
import { findNearestCoastHires, getCoastSnippetHires } from '../../public/js/coastline-hires.js';
import { renderCompass } from '../../public/js/compass-render.js';

const SYNTH_HOUR = { swellHeightFt: 4, windSpeedMph: 8, swellDir: 200, windDir: 60 };

export function renderFixture(fixture) {
  // Production passes a real GFS swell grid for validateSeaward to flip the
  // bearing+90 default when it points at land. The harness has no grid, so
  // small-island and indented-coast fixtures with ambiguous coastline
  // winding will get whichever side the winding implies. Fixtures whose
  // expected seaward depends on grid validation are marked tol: null.
  const coast = findNearestCoastHires(fixture.lat, fixture.lon, null);
  const checks = checkFixture(fixture, coast);

  let snip = null;
  if (coast && coast.featureIdx >= 0) {
    snip = getCoastSnippetHires(coast.featureIdx, coast.segIdx, coast.coastLat, coast.coastLon, 10);
  }

  const safeCoast = coast || { coastBearing: 0 };
  const svg = renderCompass(300, SYNTH_HOUR, safeCoast, snip, false, null);
  const png = new Resvg(svg, { background: '#0f172a' }).render().asPng();

  return { ok: checks.failures.length === 0, coast, snip, svg, png, checks };
}

function checkFixture(f, coast) {
  const failures = [];
  const notes = [];
  if (!coast || !Number.isFinite(coast.distance)) {
    failures.push('no candidate found');
    return { failures, notes };
  }
  if (coast.unreliableBearing) failures.push('unreliableBearing set');
  const km = coast.distance / 1000;
  if (km > 5) failures.push(`distance ${km.toFixed(2)}km > 5km`);
  if (f.tol !== null && coast.seawardDir != null) {
    const diff = Math.abs(((coast.seawardDir - f.expectedSeaward + 540) % 360) - 180);
    if (diff > f.tol) failures.push(`seaward off by ${diff.toFixed(1)}° (>${f.tol}°)`);
    notes.push(`seaward ${coast.seawardDir.toFixed(1)}° / expected ${f.expectedSeaward}°`);
  }
  return { failures, notes };
}
