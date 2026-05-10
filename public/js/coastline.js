/**
 * coastline.js — Coastline detection, bearing computation, reverse geocoding
 *
 * Loads a bundled Natural Earth coastline GeoJSON and provides:
 *   - findNearestCoast(lat, lon, grid) → nearest coastline point + orientation
 *   - reverseGeocode(lat, lon) → nearest place name
 */

import { computeAdaptiveBearing, validateSeaward } from './coastline-shared.js';
import { isHiresReady, findNearestCoastHires, getCoastSnippetHires } from './coastline-hires.js';

let coastData = null;
let _loadPromise = null;

/** Test hook: inject coastline data directly without going through fetch. */
export function _setCoastData(data) {
  coastData = data;
  _loadPromise = Promise.resolve();
}

/** Load the bundled coastline GeoJSON. Idempotent; concurrent callers share one fetch. */
export function loadCoastline() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = fetch('/assets/coastline.geojson')
    .then(r => r.json())
    .then(d => { coastData = d; })
    .catch(e => { _loadPromise = null; throw e; });
  return _loadPromise;
}

/** Haversine distance in meters */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Project a point onto a line segment and return the closest point on the segment.
 * Works in lon/lat space (good enough for small distances).
 */
function projectOntoSegment(pLon, pLat, aLon, aLat, bLon, bLat) {
  const dx = bLon - aLon;
  const dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { lon: aLon, lat: aLat, t: 0 };

  let t = ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { lon: aLon + t * dx, lat: aLat + t * dy, t };
}

/** Quick nearest-coast distance check (vertex-only for speed) */

/**
 * Find nearest coastline and compute orientation.
 *
 * Improvements over naive nearest-vertex:
 *   - Projects onto line segments (not just vertices)
 *   - Smooths bearing over multiple neighboring points
 *   - Determines seaward direction using coastline winding order
 */
function findNearestCoastNE(lat, lon, grid) {
  if (!coastData) throw new Error('Coastline not loaded');

  const TOP_N = 5;
  const candidates = []; // sorted ascending by dist

  function insertCandidate(c) {
    let i = 0;
    while (i < candidates.length && candidates[i].dist < c.dist) i++;
    candidates.splice(i, 0, c);
    if (candidates.length > TOP_N) candidates.pop();
  }

  // Scan every segment, tracking the top-N nearest.
  for (let f = 0; f < coastData.features.length; f++) {
    const coords = coastData.features[f].geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const [aLon, aLat] = coords[i];
      const [bLon, bLat] = coords[i + 1];

      const minLat = Math.min(aLat, bLat) - 2;
      const maxLat = Math.max(aLat, bLat) + 2;
      const minLon = Math.min(aLon, bLon) - 2;
      const maxLon = Math.max(aLon, bLon) + 2;
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      const proj = projectOntoSegment(lon, lat, aLon, aLat, bLon, bLat);
      const d = haversine(lat, lon, proj.lat, proj.lon);

      if (candidates.length < TOP_N || d < candidates[candidates.length - 1].dist) {
        insertCandidate({ dist: d, featureIdx: f, segIdx: i, pt: [proj.lat, proj.lon] });
      }
    }
  }

  if (candidates.length === 0) {
    return {
      coastLat: lat, coastLon: lon, distance: Infinity,
      coastBearing: 45, seawardDir: 135, offshoreDir: 315,
      featureIdx: -1, segIdx: -1,
      seawardFlipped: false, unreliableBearing: true,
    };
  }

  // Per-candidate processing: compute bearing with adaptive window, then validate
  // seaward against the grid (flip if needed). Returns a result object plus a
  // `bothFailed` flag when neither seawardDir nor its 180° flip pointed at ocean.
  function processCandidate(cand) {
    const getVertex = (f, i) => {
      const coords = coastData.features[f].geometry.coordinates;
      if (i < 0 || i >= coords.length) return null;
      return coords[i];
    };
    const coastBearing = computeAdaptiveBearing(getVertex, cand.featureIdx, cand.segIdx);
    const assumedSeaward = (coastBearing + 90) % 360;
    const { seawardDir, seawardFlipped, bothFailed } = validateSeaward(grid, cand.pt[0], cand.pt[1], assumedSeaward);

    return {
      coastLat: cand.pt[0], coastLon: cand.pt[1],
      distance: cand.dist,
      coastBearing,
      seawardDir,
      offshoreDir: (seawardDir + 180) % 360,
      featureIdx: cand.featureIdx,
      segIdx: cand.segIdx,
      seawardFlipped,
      unreliableBearing: false,
      bothFailed,
    };
  }

  // Try each candidate. First one whose seaward (possibly flipped) is wet wins.
  let lastResult = null;
  for (const cand of candidates) {
    const res = processCandidate(cand);
    lastResult = res;
    if (!res.bothFailed) break;
  }

  // candidates was non-empty (guarded above), so the retry loop ran at least
  // once and lastResult is guaranteed set here.
  if (lastResult.bothFailed) lastResult.unreliableBearing = true;
  delete lastResult.bothFailed;
  return lastResult;
}

/**
 * Return ~maxKm of local coastline centered on a segment, projected into local
 * kilometers relative to (centerLat, centerLon). Used by the compass renderer.
 *
 * Breaks the output into subpaths whenever consecutive Natural Earth vertices
 * are more than `BREAK_KM` apart — otherwise MultiLineString features that
 * got flattened into one array (Long Island, Hawaiian islands, etc.) render
 * as zigzags jumping across land.
 *
 * @returns {{ subpaths: Array<Array<{x: number, y: number}>>, landSide: 'left'|'right' }}
 */
function getCoastSnippetNE(featureIdx, segIdx, centerLat, centerLon, maxKm = 10) {
  if (!coastData || featureIdx < 0) return { subpaths: [], landSide: 'right' };
  const coords = coastData.features[featureIdx].geometry.coordinates;
  const halfKm = maxKm / 2;
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const BREAK_KM = 5;

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

  // Walk outward in each direction, accumulating arc length until halfKm.
  // Record each accepted vertex's local coord and the km gap to the previous.
  const LEFT_KM = (gapBefore, coord) => ({ gapBefore, coord });

  const left = []; // ordered deepest→center; each entry has gapBefore = gap to the NEXT (more central) vertex
  {
    let accum = 0;
    let prevLon = coords[segIdx][0], prevLat = coords[segIdx][1];
    left.push(LEFT_KM(0, toLocal(prevLon, prevLat))); // segIdx itself, no gap to self
    for (let i = segIdx - 1; i >= 0; i--) {
      const [lonA, latA] = coords[i];
      const gap = segKm(prevLon, prevLat, lonA, latA);
      left.push(LEFT_KM(gap, toLocal(lonA, latA)));
      accum += gap;
      prevLon = lonA; prevLat = latA;
      if (accum >= halfKm) break;
    }
    left.reverse(); // now ordered leftmost → segIdx
  }

  const right = []; // ordered center→right; each entry gapBefore = gap to the PREVIOUS vertex
  {
    let accum = 0;
    let prevLon = coords[segIdx][0], prevLat = coords[segIdx][1];
    for (let i = segIdx + 1; i < coords.length; i++) {
      const [lonA, latA] = coords[i];
      const gap = segKm(prevLon, prevLat, lonA, latA);
      right.push({ gapBefore: gap, coord: toLocal(lonA, latA) });
      accum += gap;
      prevLon = lonA; prevLat = latA;
      if (accum >= halfKm) break;
    }
  }

  // Combine in polyline order, breaking into subpaths at gaps > BREAK_KM.
  // Note: `left` includes segIdx as its last item with gapBefore=0, and `right`
  // starts with the vertex after segIdx with gapBefore = segKm(segIdx, segIdx+1).
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

  return { subpaths, landSide: 'right' };
}

/** Public: find nearest coast. Delegates to hires when available. */
export function findNearestCoast(lat, lon, grid) {
  if (isHiresReady()) return findNearestCoastHires(lat, lon, grid);
  return findNearestCoastNE(lat, lon, grid);
}

/** Public: get coast snippet. Delegates to hires when available. */
export function getCoastSnippet(featureIdx, segIdx, centerLat, centerLon, maxKm) {
  if (isHiresReady()) return getCoastSnippetHires(featureIdx, segIdx, centerLat, centerLon, maxKm);
  return getCoastSnippetNE(featureIdx, segIdx, centerLat, centerLon, maxKm);
}

/**
 * Reverse geocode a lat/lon to the nearest place name.
 * Uses OpenStreetMap Nominatim (free, no API key needed).
 */
const _geocodeCache = new Map();

export async function reverseGeocode(lat, lon) {
  // Round to 2 decimals to improve cache hits
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);

  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`,
      { headers: { 'User-Agent': 'IsItGoodSurf/1.0' } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();

    // Extract useful name: city, town, or county
    const addr = data.address || {};
    const name = addr.city || addr.town || addr.village || addr.hamlet
              || addr.county || addr.state || data.display_name?.split(',')[0] || null;

    _geocodeCache.set(key, name);
    return name;
  } catch {
    return null;
  }
}
