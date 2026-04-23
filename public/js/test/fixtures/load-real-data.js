import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBinary } from '../../grid.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Four levels up from `test/fixtures/` to `surf_app_V3/`.
const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..');

export function loadRealCoastline() {
  const p = join(PROJECT_ROOT, 'public', 'assets', 'coastline.geojson');
  return JSON.parse(readFileSync(p, 'utf-8'));
}

/**
 * Load a cached swell grid. `relPath` is relative to `surf_app_V3/`,
 * e.g. 'data/demo/swell_f000.bin'.
 * Returns a Grid instance with its native `interpolateSwell` method intact.
 */
export function loadRealSwellGrid(relPath) {
  const p = join(PROJECT_ROOT, relPath);
  const buf = readFileSync(p);
  // Buffer → ArrayBuffer slice. Important: Buffer may be a view on a pool.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return parseBinary(ab);
}
