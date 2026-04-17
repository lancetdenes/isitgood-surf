/**
 * grid.js — Binary grid loader and bilinear interpolation
 *
 * Binary format (.bin):
 *   Bytes 0-3:   magic "SURF" (4 bytes ASCII)
 *   Bytes 4-7:   nx (uint32 LE) — number of longitude points
 *   Bytes 8-11:  ny (uint32 LE) — number of latitude points
 *   Bytes 12-15: lo1 (float32 LE) — first longitude (degrees)
 *   Bytes 16-19: la1 (float32 LE) — first latitude (degrees, north → south)
 *   Bytes 20-23: dx (float32 LE) — longitude step (degrees)
 *   Bytes 24-27: dy (float32 LE) — latitude step (degrees)
 *   Bytes 28-31: nParams (uint32 LE) — number of parameter arrays
 *   Bytes 32+:   nParams arrays of float32[nx*ny] values
 *
 * Wind files have 2 params: [u10, v10]
 * Swell files have 3 params: [height, direction, period]
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

  // Verify magic
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SURF') {
    throw new Error(`Invalid binary file: expected magic "SURF", got "${magic}"`);
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

  const arrays = [];
  for (let p = 0; p < nParams; p++) {
    const offset = 32 + p * gridSize * 4;
    arrays.push(new Float32Array(buffer, offset, gridSize));
  }

  return new Grid(header, arrays);
}

/** Fetch and parse a binary grid file. */
export async function loadGrid(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return parseBinary(buffer);
}
