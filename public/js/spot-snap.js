/**
 * spot-snap.js — pure spot-snapping logic shared by the browser and the
 * serverless functions (imported from api/_lib/spots.mjs).
 *
 * Given the named-spots list (entries: {n: name, r: region, la: lat, ln: lng}),
 * classify a coordinate against the nearest named spot:
 *
 *   tier 'at'   — within SNAP_KM:  treat the photo as taken AT the spot
 *   tier 'near' — within NEAR_KM:  label "near <spot>", keep exact coords
 *   tier 'far'  — beyond NEAR_KM:  no spot association (coords only)
 *
 * No external deps, no I/O — callers supply the spots array.
 */

export const SNAP_KM = 2;
export const NEAR_KM = 10;

const R = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Nearest spot by great-circle distance. Returns {spot, km} or null. */
export function nearestSpot(spots, lat, lng) {
  if (!Array.isArray(spots) || !spots.length) return null;
  // Cheap pre-filter: skip spots more than ~2 degrees away in either axis
  // (>10 km snap threshold is well inside 2 degrees everywhere on Earth).
  let best = null, bestKm = Infinity;
  for (const s of spots) {
    const dLat = Math.abs(s.la - lat);
    if (dLat > 2) continue;
    const km = haversineKm(lat, lng, s.la, s.ln);
    if (km < bestKm) { bestKm = km; best = s; }
  }
  return best ? { spot: best, km: bestKm } : null;
}

/**
 * Snap a coordinate to the named-spots list.
 * Returns { tier, spot, km, label }:
 *   tier 'at'   → label = spot name        (e.g. "Higgins Beach")
 *   tier 'near' → label = "near <name>"    (exact coords preserved by caller)
 *   tier 'far'  → spot/label = null
 */
export function snapToSpot(spots, lat, lng) {
  const hit = nearestSpot(spots, lat, lng);
  if (!hit || hit.km > NEAR_KM) return { tier: 'far', spot: null, km: hit ? hit.km : null, label: null };
  if (hit.km <= SNAP_KM) return { tier: 'at', spot: hit.spot, km: hit.km, label: hit.spot.n };
  return { tier: 'near', spot: hit.spot, km: hit.km, label: `near ${hit.spot.n}` };
}
