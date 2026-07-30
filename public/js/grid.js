/**
 * grid.js — Binary grid loader and bilinear interpolation
 *
 * Binary format (.bin, magic "SRF2"):
 *   Header (32 bytes):
 *     [0-3]   magic "SRF2"
 *     [4-7]   nx      uint32 LE
 *     [8-11]  ny      uint32 LE
 *     [12-15] lo1     float32 LE
 *     [16-19] la1     float32 LE (north edge, N→S scan)
 *     [20-23] dx      float32 LE
 *     [24-27] dy      float32 LE
 *     [28-31] nParams uint32 LE
 *   Scale table (nParams × 8 bytes): scale (f32), offset (f32)
 *   Data: nParams × (nx × ny) int16 LE arrays
 *
 *   Decode: value = int16 * scale + offset
 *
 * Wind files have 2 params: [u10, v10]
 * Swell files have 3 params: [height, direction, period]
 * Swellpart files have 12 params: 3 swell partitions × [height, direction,
 *   period] followed by windsea [height, direction, period] — see
 *   process-grib.py's process_gfs_swellpart for the writer side.
 *
 * Renderers and callers still see Float32Arrays via `grid.arrays`; the int16
 * layer is an on-the-wire optimization and is fully decoded at parse time.
 */

export class Grid {
  constructor(header, arrays) {
    this.nx = header.nx;
    this.ny = header.ny;
    this.lo1 = header.lo1;
    this.la1 = header.la1;
    this.dx = header.dx;
    this.dy = header.dy;
    this.arrays = arrays; // array of Float32Array
  }

  /**
   * Swell-aware bilinear interpolation — rejects cells that straddle land.
   *
   * The grid stores land as (height=0, direction=0°, period=0). Plain
   * bilinear interp across a half-ocean / half-land cell produces two bugs:
   *   • heights leak a fractional value onto land pixels ("swell over land"),
   *   • directions average a real ocean heading with land's fake 0° north,
   *     pulling the result toward NE/SE regardless of the real swell.
   *
   * By requiring all 4 corners to have height ≥ minH we get a clean
   * one-cell (~25 km for GFS 0.25°) transparent strip right at the coast
   * instead of smeared, wrong-direction swell. Direction uses sin/cos
   * averaging so the 350°/10° wrap resolves correctly.
   *
   * Returns { height, direction, period } or null if any corner is land /
   * the point is out of the grid's latitude range.
   *
   * `base` selects which [height, direction, period] triple to read —
   * 0 for combined swell grids; 0/3/6/9 for swellpart grids (partitions
   * 1-3 and windsea). For partitions, a corner where the train doesn't
   * exist stores height 0 and is rejected the same way land is.
   */
  interpolateSwell(lon, lat, minH = 0.05, base = 0) {
    let fi = (lon - this.lo1) / this.dx;
    const fj = (this.la1 - lat) / this.dy;
    while (fi < 0) fi += this.nx;
    while (fi >= this.nx) fi -= this.nx;
    if (fj < 0 || fj >= this.ny - 1) return null;

    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const fx = fi - i0;
    const fy = fj - j0;
    const i1 = (i0 + 1) % this.nx;
    const j1 = Math.min(j0 + 1, this.ny - 1);

    const idx00 = j0 * this.nx + i0;
    const idx10 = j0 * this.nx + i1;
    const idx01 = j1 * this.nx + i0;
    const idx11 = j1 * this.nx + i1;

    const h = this.arrays[base];
    if (h[idx00] < minH || h[idx10] < minH || h[idx01] < minH || h[idx11] < minH) {
      return null;
    }

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    const height = w00 * h[idx00] + w10 * h[idx10] + w01 * h[idx01] + w11 * h[idx11];

    const d = this.arrays[base + 1];
    const TO_RAD = Math.PI / 180, TO_DEG = 180 / Math.PI;
    const sinSum = w00 * Math.sin(d[idx00] * TO_RAD) + w10 * Math.sin(d[idx10] * TO_RAD)
                 + w01 * Math.sin(d[idx01] * TO_RAD) + w11 * Math.sin(d[idx11] * TO_RAD);
    const cosSum = w00 * Math.cos(d[idx00] * TO_RAD) + w10 * Math.cos(d[idx10] * TO_RAD)
                 + w01 * Math.cos(d[idx01] * TO_RAD) + w11 * Math.cos(d[idx11] * TO_RAD);
    const direction = (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;

    const p = this.arrays[base + 2];
    const period = w00 * p[idx00] + w10 * p[idx10] + w01 * p[idx01] + w11 * p[idx11];

    return { height, direction, period };
  }

  /**
   * Coastal variant of interpolateSwell: instead of rejecting the whole cell
   * when a corner is land (or lacks this swell train), it drops those corners
   * and renormalizes the bilinear weights over the remaining ones — the same
   * approach forecast.js uses for panel point reads. A spot click lands in a
   * half-land cell almost by definition, so the strict rule would return
   * null exactly where the answer matters.
   *
   * Returns { height, direction, period } or null when no corner qualifies
   * (fully inland / train absent) or the point is off-grid.
   */
  interpolateSwellCoastal(lon, lat, minH = 0.05, base = 0) {
    let fi = (lon - this.lo1) / this.dx;
    const fj = (this.la1 - lat) / this.dy;
    while (fi < 0) fi += this.nx;
    while (fi >= this.nx) fi -= this.nx;
    if (fj < 0 || fj >= this.ny - 1) return null;

    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const fx = fi - i0;
    const fy = fj - j0;
    const i1 = (i0 + 1) % this.nx;
    const j1 = Math.min(j0 + 1, this.ny - 1);

    const idxs = [j0 * this.nx + i0, j0 * this.nx + i1, j1 * this.nx + i0, j1 * this.nx + i1];
    const ws = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];

    const h = this.arrays[base];
    const d = this.arrays[base + 1];
    const p = this.arrays[base + 2];

    let wSum = 0;
    for (let k = 0; k < 4; k++) {
      if (h[idxs[k]] < minH) ws[k] = 0;
      wSum += ws[k];
    }
    if (wSum <= 0) return null;

    const TO_RAD = Math.PI / 180, TO_DEG = 180 / Math.PI;
    let height = 0, period = 0, sinSum = 0, cosSum = 0;
    for (let k = 0; k < 4; k++) {
      if (ws[k] === 0) continue;
      const w = ws[k] / wSum;
      const idx = idxs[k];
      height += w * h[idx];
      period += w * p[idx];
      sinSum += w * Math.sin(d[idx] * TO_RAD);
      cosSum += w * Math.cos(d[idx] * TO_RAD);
    }
    const direction = (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
    return { height, direction, period };
  }

  /**
   * Height-only variant of interpolateSwell for per-pixel rendering.
   * Skips the direction (4× sin/cos + atan2) and period math — the heatmap
   * only needs height, and this runs for every pixel of the raster.
   * Returns height (number) or null under the same land-rejection rules.
   */
  interpolateSwellHeight(lon, lat, minH = 0.05) {
    let fi = (lon - this.lo1) / this.dx;
    const fj = (this.la1 - lat) / this.dy;
    while (fi < 0) fi += this.nx;
    while (fi >= this.nx) fi -= this.nx;
    if (fj < 0 || fj >= this.ny - 1) return null;

    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const fx = fi - i0;
    const fy = fj - j0;
    const i1 = (i0 + 1) % this.nx;
    const j1 = Math.min(j0 + 1, this.ny - 1);

    const idx00 = j0 * this.nx + i0;
    const idx10 = j0 * this.nx + i1;
    const idx01 = j1 * this.nx + i0;
    const idx11 = j1 * this.nx + i1;

    const h = this.arrays[0];
    if (h[idx00] < minH || h[idx10] < minH || h[idx01] < minH || h[idx11] < minH) {
      return null;
    }

    return (1 - fx) * (1 - fy) * h[idx00] + fx * (1 - fy) * h[idx10]
         + (1 - fx) * fy * h[idx01] + fx * fy * h[idx11];
  }

  /**
   * Single-cell land/ocean check. Uses the first-parameter array (height for
   * swell grids) and checks if the cell containing (lon, lat) has a non-zero
   * value. Land cells are stored as 0; ocean cells always have some value even
   * when calm (typically 0.01–0.1m minimum).
   *
   * Returns false if the point is outside the grid's latitude range.
   */
  isWet(lon, lat) {
    let fi = (lon - this.lo1) / this.dx;
    const fj = (this.la1 - lat) / this.dy;
    while (fi < 0) fi += this.nx;
    while (fi >= this.nx) fi -= this.nx;
    if (fj < 0 || fj >= this.ny) return false;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    return this.arrays[0][j * this.nx + i] > 0;
  }

  /** Bilinear interpolation at a given lon/lat. Returns array of interpolated values (one per param). */
  interpolate(lon, lat) {
    // Normalize longitude to grid space
    let fi = (lon - this.lo1) / this.dx;
    const fj = (this.la1 - lat) / this.dy;

    // Wrap longitude
    while (fi < 0) fi += this.nx;
    while (fi >= this.nx) fi -= this.nx;

    // Out of latitude range
    if (fj < 0 || fj >= this.ny - 1) return null;

    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const fx = fi - i0;
    const fy = fj - j0;

    const i1 = (i0 + 1) % this.nx;
    const j1 = Math.min(j0 + 1, this.ny - 1);

    const idx00 = j0 * this.nx + i0;
    const idx10 = j0 * this.nx + i1;
    const idx01 = j1 * this.nx + i0;
    const idx11 = j1 * this.nx + i1;

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    const result = new Array(this.arrays.length);
    for (let p = 0; p < this.arrays.length; p++) {
      const a = this.arrays[p];
      result[p] = w00 * a[idx00] + w10 * a[idx10] + w01 * a[idx01] + w11 * a[idx11];
    }
    return result;
  }
}

/** Parse a .bin file ArrayBuffer into a Grid object. */
export function parseBinary(buffer) {
  const view = new DataView(buffer);

  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SRF2') {
    throw new Error(`Invalid binary file: expected magic "SRF2", got "${magic}"`);
  }

  const header = {
    nx: view.getUint32(4, true),
    ny: view.getUint32(8, true),
    lo1: view.getFloat32(12, true),
    la1: view.getFloat32(16, true),
    dx: view.getFloat32(20, true),
    dy: view.getFloat32(24, true),
  };
  const nParams = view.getUint32(28, true);
  const gridSize = header.nx * header.ny;

  // Scale table follows the header.
  const scales = new Array(nParams);
  const scaleTableOffset = 32;
  for (let p = 0; p < nParams; p++) {
    const o = scaleTableOffset + p * 8;
    scales[p] = {
      scale: view.getFloat32(o, true),
      offset: view.getFloat32(o + 4, true),
    };
  }

  // Int16 data follows the scale table.
  const dataOffset = scaleTableOffset + nParams * 8;
  const arrays = new Array(nParams);
  for (let p = 0; p < nParams; p++) {
    const byteOffset = dataOffset + p * gridSize * 2;
    // Copy into a dedicated Float32Array so renderers that index directly
    // (heatmap, wind, swell, pumping) see decoded values without per-access
    // multiplications.
    const src = new Int16Array(buffer, byteOffset, gridSize);
    const dst = new Float32Array(gridSize);
    const { scale, offset } = scales[p];
    for (let i = 0; i < gridSize; i++) {
      dst[i] = src[i] * scale + offset;
    }
    arrays[p] = dst;
  }

  return new Grid(header, arrays);
}

// ── Swellpart derived views ──────────────────────────────────────────────
//
// A swellpart grid carries 12 params (3 partitions + windsea, H/D/P each).
// The heatmap and particle renderers only understand the 3-param
// [height, direction, period] shape, so we derive standard swell Grids from
// the partition data. Views are computed once and cached on the source grid.

/** Param base offsets in a swellpart grid. */
export const SWELLPART_BASES = { partitions: [0, 3, 6], windsea: 9 };

function _headerOf(grid) {
  return { nx: grid.nx, ny: grid.ny, lo1: grid.lo1, la1: grid.la1, dx: grid.dx, dy: grid.dy };
}

/**
 * Groundswell view: per cell, the longest-period partition that carries
 * meaningful energy (height ≥ minH). Cells where no partition qualifies get
 * 0s, which the renderers already treat as "nothing here" — so the layer is
 * transparent where no groundswell exists, exactly the semantics we want.
 */
export function deriveGroundswellGrid(partGrid, minH = 0.1) {
  if (partGrid._groundView) return partGrid._groundView;
  const [h, d, p] = buildGroundViewArrays(partGrid.arrays, partGrid.nx * partGrid.ny, minH);
  partGrid._groundView = new Grid(_headerOf(partGrid), [h, d, p]);
  return partGrid._groundView;
}

/**
 * Pure core of the groundswell view — also run inside the decode worker so
 * the 1M-cell pass never lands on the main thread for full-size grids.
 */
export function buildGroundViewArrays(a, n, minH = 0.1) {
  const h = new Float32Array(n);
  const d = new Float32Array(n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let bestP = 0, bestBase = -1;
    for (const base of SWELLPART_BASES.partitions) {
      if (a[base][i] >= minH && a[base + 2][i] > bestP) {
        bestP = a[base + 2][i];
        bestBase = base;
      }
    }
    if (bestBase >= 0) {
      h[i] = a[bestBase][i];
      d[i] = a[bestBase + 1][i];
      p[i] = a[bestBase + 2][i];
    }
  }
  return [h, d, p];
}

/** Windsea view: zero-copy — just re-points at the windsea param triple. */
export function deriveWindseaGrid(partGrid) {
  if (partGrid._windseaView) return partGrid._windseaView;
  const b = SWELLPART_BASES.windsea;
  partGrid._windseaView = new Grid(_headerOf(partGrid),
    [partGrid.arrays[b], partGrid.arrays[b + 1], partGrid.arrays[b + 2]]);
  return partGrid._windseaView;
}

/** Fetch and parse a binary grid file. */
export async function loadGrid(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = new Error(`Failed to load ${url}: ${resp.status}`);
    err.status = resp.status; // callers use this to distinguish 404 from transient failures
    throw err;
  }
  const buffer = await resp.arrayBuffer();
  return parseBinary(buffer);
}
