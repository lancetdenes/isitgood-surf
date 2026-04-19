import fs from 'node:fs';

/**
 * Load a V3 .bin grid from disk. Format matches public/js/grid.js exactly.
 * Header: "SURF" (4 bytes) + 6 uint32/float32 fields + float32 data arrays.
 */
export function loadGridFromFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.slice(0, 4).toString('ascii') !== 'SURF') {
    throw new Error(`${filePath}: bad magic`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nx = dv.getUint32(4, true);
  const ny = dv.getUint32(8, true);
  const lo1 = dv.getFloat32(12, true);
  const la1 = dv.getFloat32(16, true);
  const dx = dv.getFloat32(20, true);
  const dy = dv.getFloat32(24, true);
  const nParams = dv.getUint32(28, true);

  const arrays = [];
  const arrayBytes = nx * ny * 4;
  let offset = 32;
  for (let p = 0; p < nParams; p++) {
    arrays.push(new Float32Array(buf.buffer, buf.byteOffset + offset, nx * ny));
    offset += arrayBytes;
  }

  return {
    nx, ny, lo1, la1, dx, dy, arrays,
    interpolate(lon, lat) {
      let fi = (lon - this.lo1) / this.dx;
      const fj = (this.la1 - lat) / this.dy;
      while (fi < 0) fi += this.nx;
      while (fi >= this.nx) fi -= this.nx;
      if (fj < 0 || fj >= this.ny - 1) return null;
      const i0 = Math.floor(fi), j0 = Math.floor(fj);
      const fx = fi - i0, fy = fj - j0;
      const i1 = (i0 + 1) % this.nx;
      const j1 = Math.min(j0 + 1, this.ny - 1);
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy, w11 = fx * fy;
      const i00 = j0 * this.nx + i0, i10 = j0 * this.nx + i1;
      const i01 = j1 * this.nx + i0, i11 = j1 * this.nx + i1;
      const out = [];
      for (const a of this.arrays) {
        out.push(w00 * a[i00] + w10 * a[i10] + w01 * a[i01] + w11 * a[i11]);
      }
      return out;
    },
  };
}
