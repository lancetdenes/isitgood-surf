/**
 * High-resolution GSHHG coastline runtime loader + KD-tree-backed lookups.
 *
 * Loaded in the background after the app's synchronous Natural Earth load.
 * Once ready, `coastline.js`'s public API delegates here.
 *
 * The KDBush constructor is injected via `setKDBush` so this module works in
 * both the browser (where kdbush is served from `/vendor/kdbush/`) and Node
 * tests (where it imports via the `'kdbush'` package name).
 */

import { parseCoastlineBinary } from '../../data/scripts/lib/coastline-binary.js';

let KDBushCtor = null;
let _data = null;      // parsed binary (see parseCoastlineBinary)
let _index = null;     // KDBush over segment midpoints
let _ready = false;

/** Inject the KDBush constructor. Must be called before _setHiresData / loadHiresCoastline. */
export function setKDBush(ctor) {
  KDBushCtor = ctor;
}

// --- Test hooks ---
export function _resetHires() {
  _data = null; _index = null; _ready = false;
}
export function _setHiresData(data) {
  if (!KDBushCtor) throw new Error('setKDBush must be called before loading hires data');
  _data = data;
  _index = buildIndex(data);
  _ready = true;
}

/** @returns {boolean} */
export function isHiresReady() {
  return _ready;
}

/** Build kdbush over segment midpoints. Each entry is one segment. */
function buildIndex(data) {
  // Total segment count = (featureLength - 1) summed over all features.
  let nSegments = 0;
  for (let f = 0; f < data.nFeatures; f++) {
    const len = data.featureLength(f);
    if (len >= 2) nSegments += len - 1;
  }
  const idx = new KDBushCtor(nSegments);
  // Parallel arrays mapping kdbush-internal point index -> (featureIdx, segIdx).
  const segKey = new Uint32Array(nSegments * 2);
  let k = 0;
  for (let f = 0; f < data.nFeatures; f++) {
    const len = data.featureLength(f);
    for (let s = 0; s < len - 1; s++) {
      const [lonA, latA] = data.vertex(f, s);
      const [lonB, latB] = data.vertex(f, s + 1);
      idx.add((lonA + lonB) / 2, (latA + latB) / 2);
      segKey[k * 2] = f;
      segKey[k * 2 + 1] = s;
      k++;
    }
  }
  idx.finish();
  idx.segKey = segKey;
  return idx;
}

/** Load the hires binary and flip ready. Returns a promise. */
export async function loadHiresCoastline(url = '/assets/coastline-hires.bin') {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`);
  const ab = await resp.arrayBuffer();
  const data = parseCoastlineBinary(ab);
  _setHiresData(data);
}

/** Internal accessor for downstream lookup modules (Tasks 8+). */
export function _getHires() {
  return { data: _data, index: _index };
}
