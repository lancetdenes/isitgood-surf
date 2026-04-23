/**
 * coastline.js — Coastline detection, bearing computation, reverse geocoding
 *
 * Loads a bundled Natural Earth coastline GeoJSON and provides:
 *   - findNearestCoast(lat, lon, grid) → nearest coastline point + orientation
 *   - reverseGeocode(lat, lon) → nearest place name
 */

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

/** Bearing from point 1 to point 2 in degrees (0-360) */
function bearing(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * toDeg + 360) % 360;
}

/**
 * Walk `distKm` from (lat, lon) along bearing `brgDeg` and return the target lat/lon.
 * Flat-earth approximation — fine for 10 km moves at any non-polar latitude.
 */
function stepAlongBearing(lat, lon, brgDeg, distKm) {
  const rad = brgDeg * Math.PI / 180;
  const dLat = (distKm / 111) * Math.cos(rad);
  const dLon = (distKm / (111 * Math.cos(lat * Math.PI / 180))) * Math.sin(rad);
  return [lat + dLat, lon + dLon];
}

/**
 * Sample the grid at least 2 grid cells along `brgDeg` from (coastLat, coastLon).
 * Returns true if the sample is over ocean, true if no grid is provided.
 *
 * Probe distance scales with the grid's cell size (max(30 km, 2 × cell)) so
 * we reliably cross into a neighboring cell. At 0.25° GFS that's ~45 km; at
 * the 1° demo grid that's ~175 km. A fixed 10 km probe was less than one
 * cell width and effectively tested the same cell the coast point is in.
 */
function isOcean(grid, coastLat, coastLon, brgDeg) {
  if (!grid || typeof grid.isWet !== 'function') return true;
  const cellKmLat = grid.dy * 111;
  const cellKmLon = grid.dx * 111 * Math.cos(coastLat * Math.PI / 180);
  const distKm = Math.max(30, Math.min(cellKmLat, cellKmLon) * 2);
  const [lat, lon] = stepAlongBearing(coastLat, coastLon, brgDeg, distKm);
  return grid.isWet(lon, lat);
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
export function findNearestCoast(lat, lon, grid) {
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
    const coords = coastData.features[cand.featureIdx].geometry.coordinates;
    const MAX_STEPS = 3;
    const CORNER_THRESHOLD_DEG = 25;

    function segBearing(idx) {
      if (idx < 0 || idx >= coords.length - 1) return null;
      const [aLon, aLat] = coords[idx];
      const [bLon, bLat] = coords[idx + 1];
      return bearing(aLat, aLon, bLat, bLon);
    }

    const centerBearing = segBearing(cand.segIdx);
    const accepted = [centerBearing];

    function walk(step) {
      let localSin = Math.sin(centerBearing * Math.PI / 180);
      let localCos = Math.cos(centerBearing * Math.PI / 180);
      let localMean = centerBearing;
      for (let k = 1; k <= MAX_STEPS; k++) {
        const b = segBearing(cand.segIdx + step * k);
        if (b == null) break;
        const diff = Math.abs(((b - localMean + 540) % 360) - 180);
        if (diff > CORNER_THRESHOLD_DEG) break;
        accepted.push(b);
        localSin += Math.sin(b * Math.PI / 180);
        localCos += Math.cos(b * Math.PI / 180);
        localMean = (Math.atan2(localSin, localCos) * 180 / Math.PI + 360) % 360;
      }
    }

    walk(-1);
    walk(1);

    let finalSin = 0, finalCos = 0;
    for (const b of accepted) {
      finalSin += Math.sin(b * Math.PI / 180);
      finalCos += Math.cos(b * Math.PI / 180);
    }
    const coastBearing = (Math.atan2(finalSin, finalCos) * 180 / Math.PI + 360) % 360;

    let seawardDir = (coastBearing + 90) % 360;
    let seawardFlipped = false;
    let bothFailed = false;

    if (grid) {
      if (!isOcean(grid, cand.pt[0], cand.pt[1], seawardDir)) {
        const flipped = (seawardDir + 180) % 360;
        if (isOcean(grid, cand.pt[0], cand.pt[1], flipped)) {
          seawardDir = flipped;
          seawardFlipped = true;
        } else {
          bothFailed = true;
        }
      }
    }

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
 * @returns {{ points: Array<{x: number, y: number}>, landSide: 'left'|'right' }}
 */
export function getCoastSnippet(featureIdx, segIdx, centerLat, centerLon, maxKm = 30) {
  if (!coastData || featureIdx < 0) return { points: [], landSide: 'right' };
  const coords = coastData.features[featureIdx].geometry.coordinates;
  const halfKm = maxKm / 2;
  const cosLat = Math.cos(centerLat * Math.PI / 180);

  function toLocal(lon, lat) {
    return {
      x: (lon - centerLon) * 111 * cosLat,
      y: (lat - centerLat) * 111,
    };
  }

  // Walk outward from segIdx, accumulating arc length in km until halfKm in each direction.
  // Left walk (segIdx → 0)
  const left = [];
  let accum = 0;
  for (let i = segIdx; i >= 0; i--) {
    const [lonA, latA] = coords[i];
    left.unshift(toLocal(lonA, latA));
    if (i > 0) {
      const [lonB, latB] = coords[i - 1];
      const dx = (lonA - lonB) * 111 * cosLat;
      const dy = (latA - latB) * 111;
      accum += Math.hypot(dx, dy);
      if (accum >= halfKm) break;
    }
  }
  // Right walk (segIdx+1 → end)
  const right = [];
  accum = 0;
  for (let i = segIdx + 1; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    right.push(toLocal(lon, lat));
    if (i + 1 < coords.length) {
      const [lonN, latN] = coords[i + 1];
      const dx = (lon - lonN) * 111 * cosLat;
      const dy = (lat - latN) * 111;
      accum += Math.hypot(dx, dy);
      if (accum >= halfKm) break;
    }
  }

  const points = [...left, ...right];

  // Natural Earth coastlines conventionally have water on the right of the line
  // direction. The compass renderer can override with seawardDir if needed.
  return { points, landSide: 'right' };
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
