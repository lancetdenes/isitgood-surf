/**
 * forecast.js — Client-side point forecast computation.
 *
 * Replaces the server's /api/forecast endpoint so the app can run without a
 * backend. Given a lat/lon and a run path, reads all 57 wind + swell grids
 * (via a provided cached-load function), interpolates at the point, and
 * returns the same JSON shape the old endpoint produced.
 */
import { loadGrid } from './grid.js';

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/** Angular (sin/cos) bilinear interpolation of a direction field in degrees. */
function interpolateAngle(grid, paramIdx, lon, lat) {
  let fi = (lon - grid.lo1) / grid.dx;
  const fj = (grid.la1 - lat) / grid.dy;
  while (fi < 0) fi += grid.nx;
  while (fi >= grid.nx) fi -= grid.nx;
  if (fj < 0 || fj >= grid.ny - 1) return 0;

  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const fx = fi - i0, fy = fj - j0;
  const i1 = (i0 + 1) % grid.nx;
  const j1 = Math.min(j0 + 1, grid.ny - 1);
  const a = grid.arrays[paramIdx];

  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;

  const i00 = j0 * grid.nx + i0, i10 = j0 * grid.nx + i1;
  const i01 = j1 * grid.nx + i0, i11 = j1 * grid.nx + i1;

  const sinSum = w00 * Math.sin(a[i00] * TO_RAD) + w10 * Math.sin(a[i10] * TO_RAD)
               + w01 * Math.sin(a[i01] * TO_RAD) + w11 * Math.sin(a[i11] * TO_RAD);
  const cosSum = w00 * Math.cos(a[i00] * TO_RAD) + w10 * Math.cos(a[i10] * TO_RAD)
               + w01 * Math.cos(a[i01] * TO_RAD) + w11 * Math.cos(a[i11] * TO_RAD);
  return (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
}

/**
 * Detect the local coast geometry by sampling swell height in a ring.
 * Directions with non-zero swell = ocean; directions with zero = land.
 * Mean ocean bearing → seaward direction; its perpendicular → coast bearing.
 */
export function detectCoastFromGrid(grid, lon, lat) {
  const numSamples = 24;
  const offsets = [0.15, 0.25, 0.4];
  const oceanDirs = [];

  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * 360;
    let hasWater = false;
    for (const dist of offsets) {
      const testLat = lat + dist * Math.cos(angle * TO_RAD);
      const testLon = lon + dist * Math.sin(angle * TO_RAD);
      const vals = grid.interpolate(testLon, testLat);
      if (vals && vals[0] > 0.05) { hasWater = true; break; }
    }
    if (hasWater) oceanDirs.push(angle);
  }

  if (oceanDirs.length === 0 || oceanDirs.length === numSamples) return null;

  let sinSum = 0, cosSum = 0;
  for (const d of oceanDirs) {
    sinSum += Math.sin(d * TO_RAD);
    cosSum += Math.cos(d * TO_RAD);
  }
  const seawardDir = (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
  return {
    coastBearing: (seawardDir + 90) % 360,
    seawardDir,
    offshoreDir: (seawardDir + 180) % 360,
  };
}

/**
 * Compute the 7-day point forecast for a lat/lon.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} runPath      base URL for the run's grids (e.g. "https://.../gfs/20260417_12z")
 * @param {(url:string)=>Promise<Grid|null>} cachedLoad  reuses the app's grid cache so we don't re-download
 * @returns {Promise<{lat, lon, hours, coast}>}  same shape the old /api/forecast returned
 */
export async function computeForecast(lat, lon, runPath, cachedLoad) {
  const load = cachedLoad || (async (url) => {
    try { return await loadGrid(url); } catch { return null; }
  });

  // Start all 114 grid loads in parallel. If the timeline preload has already
  // populated the cache these resolve instantly; otherwise the browser fans
  // them out (up to 6 concurrent per origin) instead of serializing.
  const pending = [];
  for (let h = 0; h <= 168; h += 3) {
    const fhr = String(h).padStart(3, '0');
    pending.push({
      h,
      wind: load(`${runPath}/wind_f${fhr}.bin`),
      swell: load(`${runPath}/swell_f${fhr}.bin`),
    });
  }

  const hours = [];
  let lastSwellValues = null;

  for (const { h, wind, swell } of pending) {
    const [windGrid, swellGrid] = await Promise.all([wind, swell]);
    const entry = {
      hour: h, windSpeedMs: 0, windDir: 0,
      swellHeightM: 0, swellDir: 0, swellPeriod: 0,
    };

    if (windGrid) {
      const w = windGrid.interpolate(lon, lat);
      if (w) {
        entry.windSpeedMs = Math.sqrt(w[0] * w[0] + w[1] * w[1]);
        entry.windDir = (Math.atan2(-w[0], -w[1]) * TO_DEG + 360) % 360;
      }
    }

    if (swellGrid) {
      const s = swellGrid.interpolate(lon, lat);
      if (s) {
        entry.swellHeightM = s[0];
        entry.swellDir = interpolateAngle(swellGrid, 1, lon, lat);
        entry.swellPeriod = s[2];
        lastSwellValues = [s[0], entry.swellDir, s[2]];
      }
    } else if (lastSwellValues) {
      entry.swellHeightM = lastSwellValues[0];
      entry.swellDir = lastSwellValues[1];
      entry.swellPeriod = lastSwellValues[2];
    }

    hours.push(entry);
  }

  let coast = null;
  const swellGrid0 = await load(`${runPath}/swell_f000.bin`);
  if (swellGrid0) coast = detectCoastFromGrid(swellGrid0, lon, lat);

  return { lat, lon, hours, coast };
}
