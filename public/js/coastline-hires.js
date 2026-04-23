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
import { computeAdaptiveBearing, validateSeaward } from './coastline-shared.js';

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

/** Haversine distance in meters. */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1*toRad) * Math.cos(lat2*toRad) *
            Math.sin(dLon/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/** Project a point onto a lon/lat segment; return {lon, lat, t}. */
function projectOntoSegment(pLon, pLat, aLon, aLat, bLon, bLat) {
  const dx = bLon - aLon, dy = bLat - aLat;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return { lon: aLon, lat: aLat, t: 0 };
  let t = ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { lon: aLon + t*dx, lat: aLat + t*dy, t };
}

/** Convert a -180/180 longitude to 0-360 (the convention used in the binary). */
function to360(lon) { return lon < 0 ? lon + 360 : lon; }
/** Convert a 0-360 longitude back to -180/180. */
function to180(lon) { return lon > 180 ? lon - 360 : lon; }

/**
 * KD-tree-backed findNearestCoast on the hires dataset.
 * Same return shape as the NE path.
 */
export function findNearestCoastHires(lat, lon, grid) {
  if (!_ready) throw new Error('Hires coastline not loaded');
  const data = _data, idx = _index;
  const TOP_N = 5;
  const SEARCH_RADIUS_DEG = 0.5; // ~55 km

  // The binary stores longitudes in 0-360; convert the query lon accordingly.
  const lon360 = to360(lon);

  // Query kdbush for candidate segment indices within the search radius.
  const candIndices = idx.within(lon360, lat, SEARCH_RADIUS_DEG);
  if (candIndices.length === 0) {
    return {
      coastLat: lat, coastLon: lon, distance: Infinity,
      coastBearing: 45, seawardDir: 135, offshoreDir: 315,
      featureIdx: -1, segIdx: -1,
      seawardFlipped: false, unreliableBearing: true,
    };
  }

  // Score each candidate, keep top-5.
  // Vertices are in 0-360 lon; project in that space then convert result.
  const candidates = [];
  for (const ci of candIndices) {
    const f = idx.segKey[ci * 2];
    const s = idx.segKey[ci * 2 + 1];
    const [lonA, latA] = data.vertex(f, s);
    const [lonB, latB] = data.vertex(f, s + 1);
    const proj = projectOntoSegment(lon360, lat, lonA, latA, lonB, latB);
    const projLon180 = to180(proj.lon);
    const d = haversine(lat, lon, proj.lat, projLon180);
    candidates.push({ dist: d, featureIdx: f, segIdx: s, pt: [proj.lat, projLon180] });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  candidates.length = Math.min(TOP_N, candidates.length);

  // Accessor for shared adaptive-window / seaward logic.
  // Convert lon from 0-360 back to -180/180 so bearing() works correctly.
  const getVertex = (f, i) => {
    if (i < 0 || i >= data.featureLength(f)) return null;
    const [vLon, vLat] = data.vertex(f, i);
    return [to180(vLon), vLat];
  };

  function processCandidate(cand) {
    const coastBearing = computeAdaptiveBearing(getVertex, cand.featureIdx, cand.segIdx);
    const assumedSeaward = (coastBearing + 90) % 360;
    const { seawardDir, seawardFlipped, bothFailed } = validateSeaward(
      grid, cand.pt[0], cand.pt[1], assumedSeaward
    );
    return {
      coastLat: cand.pt[0], coastLon: cand.pt[1],
      distance: cand.dist, coastBearing, seawardDir,
      offshoreDir: (seawardDir + 180) % 360,
      featureIdx: cand.featureIdx, segIdx: cand.segIdx,
      seawardFlipped, unreliableBearing: false, bothFailed,
    };
  }

  // candidates is non-empty (guarded above), so at least one iteration runs
  // and lastResult is guaranteed set.
  let lastResult = null;
  for (const cand of candidates) {
    const res = processCandidate(cand);
    lastResult = res;
    if (!res.bothFailed) break;
  }
  if (lastResult.bothFailed) lastResult.unreliableBearing = true;
  delete lastResult.bothFailed;
  return lastResult;
}
