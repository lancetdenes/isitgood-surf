/**
 * coastline.js — Coastline detection, bearing computation, reverse geocoding
 *
 * Loads a bundled Natural Earth coastline GeoJSON and provides:
 *   - findNearestCoast(lat, lon) → nearest coastline point + orientation
 *   - reverseGeocode(lat, lon) → nearest place name
 */

let coastData = null;
let _loadPromise = null;

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
export function findNearestCoast(lat, lon) {
  if (!coastData) throw new Error('Coastline not loaded');

  let bestDist = Infinity;
  let bestFeatureIdx = -1;
  let bestSegIdx = -1;
  let bestPt = null;

  // Search all features for closest point on any segment
  for (let f = 0; f < coastData.features.length; f++) {
    const coords = coastData.features[f].geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const [aLon, aLat] = coords[i];
      const [bLon, bLat] = coords[i + 1];

      // Quick bounding check
      const minLat = Math.min(aLat, bLat) - 2;
      const maxLat = Math.max(aLat, bLat) + 2;
      const minLon = Math.min(aLon, bLon) - 2;
      const maxLon = Math.max(aLon, bLon) + 2;
      if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;

      // Project click point onto segment
      const proj = projectOntoSegment(lon, lat, aLon, aLat, bLon, bLat);
      const d = haversine(lat, lon, proj.lat, proj.lon);

      if (d < bestDist) {
        bestDist = d;
        bestFeatureIdx = f;
        bestSegIdx = i;
        bestPt = [proj.lat, proj.lon];
      }
    }
  }

  if (!bestPt) {
    return {
      coastLat: lat, coastLon: lon,
      distance: Infinity,
      coastBearing: 45,
      seawardDir: 135,
      offshoreDir: 315,
    };
  }

  // Compute smoothed coast bearing using multiple neighboring segments
  const coords = coastData.features[bestFeatureIdx].geometry.coordinates;
  const SMOOTH = 3; // use 3 points on each side
  const startIdx = Math.max(0, bestSegIdx - SMOOTH);
  const endIdx = Math.min(coords.length - 1, bestSegIdx + 1 + SMOOTH);

  // Average bearing using sin/cos to handle wrap-around
  let sinSum = 0, cosSum = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const [aLon, aLat] = coords[i];
    const [bLon, bLat] = coords[i + 1];
    const b = bearing(aLat, aLon, bLat, bLon);
    const rad = b * Math.PI / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  const coastBearing = (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;

  // Seaward = right perpendicular of coast line direction.
  // Natural Earth coastlines follow the convention where water is on the right
  // side of the line direction (derived from counterclockwise land polygon boundaries).
  const seawardDir = (coastBearing + 90) % 360;
  const offshoreDir = (seawardDir + 180) % 360;

  return {
    coastLat: bestPt[0],
    coastLon: bestPt[1],
    distance: bestDist,
    coastBearing,
    seawardDir,
    offshoreDir,
  };
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
