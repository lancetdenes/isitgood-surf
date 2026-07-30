import fs from 'node:fs';
import { parseBinary } from '../../../public/js/grid.js';

/**
 * Load a V3 .bin grid from disk. Delegates to public/js/grid.js's parseBinary
 * (SRF2 int16 format — the format the pipeline has written since the int16
 * migration), so Node-side tooling decodes grids exactly like the browser.
 * Returns a Grid instance: { nx, ny, lo1, la1, dx, dy, arrays, interpolate,
 * interpolateSwell, isWet, ... }.
 */
export function loadGridFromFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return parseBinary(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
