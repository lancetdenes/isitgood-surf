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
let _loadPromise = null;

/** Inject the KDBush constructor. Must be called before _setHiresData / loadHiresCoastline. */
export function setKDBush(ctor) {
  KDBushCtor = ctor;
}

// --- Test hooks ---
export function _resetHires() {
  _data = null; _index = null; _ready = false;
  _loadPromise = null;
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

/** Load the hires binary and flip ready. Idempotent — concurrent callers share one fetch. */
export async function loadHiresCoastline(url = '/assets/coastline-hires.bin') {
  if (_ready) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const resp = await fetch(url);
    if (!resp.ok) {
      _loadPromise = null; // allow retry after failure
      throw new Error(`Failed to load ${url}: ${resp.status}`);
    }
    const ab = await resp.arrayBuffer();
    const data = parseCoastlineBinary(ab);
    _setHiresData(data);
  })();
  return _loadPromise;
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
 * Axis-aligned-box query that scales the lon radius by 1/cos(lat) so high-
 * latitude clicks get the same E-W km coverage as N-S. Caps lon radius at
 * 5° to avoid degeneracy near the poles. Also handles antimeridian
 * wraparound when the box straddles 0°/360° in the binary's lon space.
 *
 * @returns {number[]} deduplicated kdbush point indices
 */
function queryBox(idx, lon360, lat, baseRadius) {
  const cosLat = Math.max(0.1, Math.cos(lat * Math.PI / 180));
  const lonR = Math.min(5, baseRadius / cosLat);
  const latR = baseRadius;

  const rangeFor = (lonCenter) => idx.range(lonCenter - lonR, lat - latR, lonCenter + lonR, lat + latR);

  const main = rangeFor(lon360);
  if (lon360 < lonR) {
    return Array.from(new Set([...main, ...rangeFor(lon360 + 360)]));
  }
  if (lon360 > 360 - lonR) {
    return Array.from(new Set([...main, ...rangeFor(lon360 - 360)]));
  }
  return main;
}

/**
 * Return ~maxKm of local coastline centered on the projected coast point,
 * projected into local kilometers. Same shape as getCoastSnippet (NE path):
 * `{ subpaths: Array<Array<{x, y}>>, landSide }`.
 *
 * Breaks subpaths at vertex gaps > 5 km (defensive — rare with GSHHG).
 *
 * Vertex lons from the binary are in [0, 360); the caller's centerLon is in
 * [-180, 180]. Normalize each fetched lon to the caller's convention before
 * projecting into local km-space.
 */
export function getCoastSnippetHires(featureIdx, segIdx, centerLat, centerLon, maxKm = 10) {
  if (!_ready || featureIdx < 0) return { subpaths: [], landSide: 'right' };
  const data = _data;
  // Guard against stale indices (e.g. NE-derived indices passed in before hires loaded).
  if (featureIdx >= data.nFeatures || segIdx >= data.featureLength(featureIdx)) {
    return { subpaths: [], landSide: 'right' };
  }

  const halfKm = maxKm / 2;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const BREAK_KM = 20;

  /**
   * Fetch vertex [lon, lat], normalize to [-180, 180], then unwrap relative
   * to centerLon so antimeridian-spanning snippets project to a contiguous
   * local-km region instead of wrapping ~40,000 km across the world.
   */
  function v(i) {
    let [lon, lat] = data.vertex(featureIdx, i);
    if (lon > 180) lon -= 360;
    if (lon - centerLon > 180) lon -= 360;
    else if (lon - centerLon < -180) lon += 360;
    return [lon, lat];
  }

  function toLocal(lon, lat) {
    return {
      x: (lon - centerLon) * 111 * cosLat,
      y: (lat - centerLat) * 111,
    };
  }
  function segKm(lonA, latA, lonB, latB) {
    const dx = (lonA - lonB) * 111 * cosLat;
    const dy = (latA - latB) * 111;
    return Math.hypot(dx, dy);
  }

  const nVerts = data.featureLength(featureIdx);

  const left = [];
  {
    let accum = 0;
    let [prevLon, prevLat] = v(segIdx);
    left.push({ gapBefore: 0, coord: toLocal(prevLon, prevLat) });
    for (let i = segIdx - 1; i >= 0; i--) {
      const [lonA, latA] = v(i);
      const gap = segKm(prevLon, prevLat, lonA, latA);
      left.push({ gapBefore: gap, coord: toLocal(lonA, latA) });
      accum += gap;
      prevLon = lonA; prevLat = latA;
      if (accum >= halfKm) break;
    }
    left.reverse();
  }

  const right = [];
  {
    let accum = 0;
    let [prevLon, prevLat] = v(segIdx);
    for (let i = segIdx + 1; i < nVerts; i++) {
      const [lonA, latA] = v(i);
      const gap = segKm(prevLon, prevLat, lonA, latA);
      right.push({ gapBefore: gap, coord: toLocal(lonA, latA) });
      accum += gap;
      prevLon = lonA; prevLat = latA;
      if (accum >= halfKm) break;
    }
  }

  const sequence = [...left, ...right];
  const subpaths = [];
  let current = [];
  for (const entry of sequence) {
    if (entry.gapBefore > BREAK_KM && current.length) {
      subpaths.push(current);
      current = [];
    }
    current.push(entry.coord);
  }
  if (current.length) subpaths.push(current);

  const filtered = subpaths.filter(sp => sp.length >= 2);
  return { subpaths: filtered, landSide: 'right' };
}

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

  // Query kdbush via a lat-aware axis-aligned box. queryBox scales lon
  // radius by 1/cos(lat) so high-latitude clicks get the same km coverage
  // E-W as N-S, and handles antimeridian wraparound when the box straddles
  // 0°/360° in the binary's lon space.
  const candIndices = queryBox(idx, lon360, lat, SEARCH_RADIUS_DEG);
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
