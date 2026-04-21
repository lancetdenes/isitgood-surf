/**
 * forecast.js — Point forecast reads from the run's SCUB cube via HTTP range
 * requests.
 *
 * The cube is one big file per run (~600 MB) laid out cell-major: every grid
 * cell's full 57-hour × 5-param int16 time series is contiguous. For a panel
 * click we fetch ~1 KB per bilinear neighbor row instead of the ~1 GB the old
 * "load all 114 grids" path required.
 *
 * See process-grib.py (build_cube) for the writer side and the SCUB format
 * layout it produces.
 */
import { loadGrid } from './grid.js';

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

// Cube param indices (must match the writer in process-grib.py)
const P_U = 0, P_V = 1, P_H = 2, P_DIR = 3, P_PERIOD = 4;
const N_PARAMS = 5;

/**
 * Detect the local coast geometry by sampling swell height in a ring.
 * Directions with non-zero swell = ocean; directions with zero = land.
 * Mean ocean bearing → seaward direction; its perpendicular → coast bearing.
 *
 * Kept on the per-hour swell grid (not the cube) because swell_f000.bin is
 * already in the app's grid cache from initial page load — one "free" read.
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
 * Lazily resolves the cube's header + hour/scale tables (one-time per run).
 * Reused across panel clicks so we don't re-fetch metadata every time.
 *
 * Cached on the URL because app.js swaps runPath when the model changes or
 * a new run rolls over — a new URL correctly invalidates the cached meta.
 */
const _metaCache = new Map();

async function fetchRange(url, offset, length) {
  const end = offset + length - 1;
  const resp = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
  if (!resp.ok) throw new Error(`Range fetch ${url} ${offset}-${end} failed: ${resp.status}`);
  return resp.arrayBuffer();
}

async function loadCubeMeta(cubeUrl) {
  const cached = _metaCache.get(cubeUrl);
  if (cached) return cached;

  const promise = (async () => {
    // Fixed 64-byte header first — gives us the table sizes.
    const headerBuf = await fetchRange(cubeUrl, 0, 64);
    const hv = new DataView(headerBuf);
    const magic = String.fromCharCode(hv.getUint8(0), hv.getUint8(1), hv.getUint8(2), hv.getUint8(3));
    if (magic !== 'SCUB') throw new Error(`Bad cube magic: "${magic}"`);

    const nx = hv.getUint32(4, true);
    const ny = hv.getUint32(8, true);
    const lo1 = hv.getFloat32(12, true);
    const la1 = hv.getFloat32(16, true);
    const dx = hv.getFloat32(20, true);
    const dy = hv.getFloat32(24, true);
    const nHours = hv.getUint32(28, true);
    const nParams = hv.getUint32(32, true);
    // version at 36-39, reserved 40-63

    if (nParams !== N_PARAMS) {
      throw new Error(`Cube nParams=${nParams}, expected ${N_PARAMS}`);
    }

    const tableSize = nHours * 4 + nParams * 8;
    const tableBuf = await fetchRange(cubeUrl, 64, tableSize);
    const tv = new DataView(tableBuf);

    const hours = new Array(nHours);
    for (let i = 0; i < nHours; i++) hours[i] = tv.getUint32(i * 4, true);

    const scales = new Array(nParams);
    for (let p = 0; p < nParams; p++) {
      const o = nHours * 4 + p * 8;
      scales[p] = { scale: tv.getFloat32(o, true), offset: tv.getFloat32(o + 4, true) };
    }

    return {
      nx, ny, lo1, la1, dx, dy, nHours, nParams,
      hours, scales,
      dataOffset: 64 + tableSize,
      cellBytes: nHours * nParams * 2,
    };
  })().catch(err => {
    _metaCache.delete(cubeUrl);
    throw err;
  });

  _metaCache.set(cubeUrl, promise);
  return promise;
}

/** Return Int16Array views at (i, j) and (i+1, j). i wraps around nx. */
async function fetchRowPair(cubeUrl, meta, i0, j) {
  const { nx, cellBytes, dataOffset, nHours, nParams } = meta;
  const i1 = (i0 + 1) % nx;
  // Common case: i0 and i1 are adjacent in storage → one range request.
  if (i1 === i0 + 1) {
    const buf = await fetchRange(cubeUrl, dataOffset + (j * nx + i0) * cellBytes, cellBytes * 2);
    return [
      new Int16Array(buf, 0, nHours * nParams),
      new Int16Array(buf, cellBytes, nHours * nParams),
    ];
  }
  // Longitude-wrap edge (i0 = nx - 1): fetch separately.
  const [b0, b1] = await Promise.all([
    fetchRange(cubeUrl, dataOffset + (j * nx + i0) * cellBytes, cellBytes),
    fetchRange(cubeUrl, dataOffset + (j * nx + i1) * cellBytes, cellBytes),
  ]);
  return [new Int16Array(b0), new Int16Array(b1)];
}

/**
 * Read the four bilinear neighbors for (lon, lat) from the cube and return
 * decoded 57-hour forecast entries.
 */
async function readPointForecast(cubeUrl, lon, lat) {
  const meta = await loadCubeMeta(cubeUrl);
  const { nx, ny, lo1, la1, dx, dy, nHours, scales, hours } = meta;

  let fi = (lon - lo1) / dx;
  const fj = (la1 - lat) / dy;
  while (fi < 0) fi += nx;
  while (fi >= nx) fi -= nx;
  if (fj < 0 || fj >= ny - 1) throw new Error('Point is out of grid latitude range');

  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const fx = fi - i0, fy = fj - j0;
  const j1 = Math.min(j0 + 1, ny - 1);

  // Two range requests total (one per row) in the common non-wrap case.
  const [rowJ0, rowJ1] = await Promise.all([
    fetchRowPair(cubeUrl, meta, i0, j0),
    fetchRowPair(cubeUrl, meta, i0, j1),
  ]);
  const [c00, c10] = rowJ0;
  const [c01, c11] = rowJ1;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  // Pre-compute per-param decode terms so the inner loop is just MACs.
  const sU = scales[P_U], sV = scales[P_V], sH = scales[P_H];
  const sD = scales[P_DIR], sP = scales[P_PERIOD];

  // Swell land-mask threshold. Cells with height below this are treated as
  // land: the direction is a fake 0° and would poison a linear average if
  // we let them contribute. See grid.js's interpolateSwell for background.
  const OCEAN_MIN_H = 0.05;

  const out = new Array(nHours);
  for (let h = 0; h < nHours; h++) {
    const base = h * N_PARAMS;

    // Wind — valid everywhere, including over land, so use the standard
    // 4-corner bilinear without any mask.
    const u00 = c00[base + P_U] * sU.scale + sU.offset;
    const u10 = c10[base + P_U] * sU.scale + sU.offset;
    const u01 = c01[base + P_U] * sU.scale + sU.offset;
    const u11 = c11[base + P_U] * sU.scale + sU.offset;
    const u = w00 * u00 + w10 * u10 + w01 * u01 + w11 * u11;

    const v00 = c00[base + P_V] * sV.scale + sV.offset;
    const v10 = c10[base + P_V] * sV.scale + sV.offset;
    const v01 = c01[base + P_V] * sV.scale + sV.offset;
    const v11 = c11[base + P_V] * sV.scale + sV.offset;
    const v = w00 * v00 + w10 * v10 + w01 * v01 + w11 * v11;

    // Swell — drop land corners entirely and renormalize weights over the
    // ocean corners. A panel click at a beach hits a cell that mixes ocean
    // and land; excluding land keeps the direction faithful to the incoming
    // swell instead of being pulled toward land's stored 0° heading. If
    // there's no ocean corner the point is inland → emit zero swell.
    const h00 = c00[base + P_H] * sH.scale + sH.offset;
    const h10 = c10[base + P_H] * sH.scale + sH.offset;
    const h01 = c01[base + P_H] * sH.scale + sH.offset;
    const h11 = c11[base + P_H] * sH.scale + sH.offset;

    const o00 = h00 >= OCEAN_MIN_H ? 1 : 0;
    const o10 = h10 >= OCEAN_MIN_H ? 1 : 0;
    const o01 = h01 >= OCEAN_MIN_H ? 1 : 0;
    const o11 = h11 >= OCEAN_MIN_H ? 1 : 0;
    const oceanW = o00 * w00 + o10 * w10 + o01 * w01 + o11 * w11;

    let swH = 0, swP = 0, swellDir = 0;
    if (oceanW > 0) {
      const inv = 1 / oceanW;
      const rw00 = o00 * w00 * inv;
      const rw10 = o10 * w10 * inv;
      const rw01 = o01 * w01 * inv;
      const rw11 = o11 * w11 * inv;

      swH = rw00 * h00 + rw10 * h10 + rw01 * h01 + rw11 * h11;

      const p00 = c00[base + P_PERIOD] * sP.scale + sP.offset;
      const p10 = c10[base + P_PERIOD] * sP.scale + sP.offset;
      const p01 = c01[base + P_PERIOD] * sP.scale + sP.offset;
      const p11 = c11[base + P_PERIOD] * sP.scale + sP.offset;
      swP = rw00 * p00 + rw10 * p10 + rw01 * p01 + rw11 * p11;

      const d00 = c00[base + P_DIR] * sD.scale + sD.offset;
      const d10 = c10[base + P_DIR] * sD.scale + sD.offset;
      const d01 = c01[base + P_DIR] * sD.scale + sD.offset;
      const d11 = c11[base + P_DIR] * sD.scale + sD.offset;
      const sinSum = rw00 * Math.sin(d00 * TO_RAD) + rw10 * Math.sin(d10 * TO_RAD)
                   + rw01 * Math.sin(d01 * TO_RAD) + rw11 * Math.sin(d11 * TO_RAD);
      const cosSum = rw00 * Math.cos(d00 * TO_RAD) + rw10 * Math.cos(d10 * TO_RAD)
                   + rw01 * Math.cos(d01 * TO_RAD) + rw11 * Math.cos(d11 * TO_RAD);
      swellDir = (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
    }

    const windSpeedMs = Math.sqrt(u * u + v * v);
    // Meteorological convention: windDir is the direction the wind blows FROM.
    // u is eastward, v is northward, so FROM is opposite (−u, −v).
    const windDir = (Math.atan2(-u, -v) * TO_DEG + 360) % 360;

    out[h] = {
      hour: hours[h],
      windSpeedMs, windDir,
      swellHeightM: swH,
      swellDir,
      swellPeriod: swP,
    };
  }
  return out;
}

/**
 * Compute the 7-day point forecast for a lat/lon.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} runPath  base URL for the run (e.g. "https://.../gfs/20260417_12z")
 * @param {(url:string)=>Promise<Grid|null>} cachedLoad  optional; used to reach swell_f000.bin
 *                                                       for grid-based coast detection (already
 *                                                       cached from initial page load)
 * @returns {Promise<{lat, lon, hours, coast}>}
 */
export async function computeForecast(lat, lon, runPath, cachedLoad) {
  const cubeUrl = `${runPath}/points.bin`;
  const hoursPromise = readPointForecast(cubeUrl, lon, lat);

  // Coast detection uses the f000 swell grid in parallel — it's almost always
  // already in the app's grid cache, so this adds no extra network work.
  const coastPromise = (async () => {
    if (!cachedLoad) return null;
    const load = cachedLoad || (async (url) => {
      try { return await loadGrid(url); } catch { return null; }
    });
    const grid = await load(`${runPath}/swell_f000.bin`).catch(() => null);
    return grid ? detectCoastFromGrid(grid, lon, lat) : null;
  })();

  const [hours, coast] = await Promise.all([hoursPromise, coastPromise]);
  return { lat, lon, hours, coast };
}
