import { HttpError } from './http.mjs';

/** Bounding box around a point, for cheap pre-filtering before haversine. */
export function bboxFor(lat, lng, radiusKm) {
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/**
 * Parse a "?bbox=w,s,e,n" query value (map-viewport mode of the media list).
 * Returns {w, s, e, n} or throws HttpError(400, 'bad_bbox').
 * Antimeridian-crossing boxes (w > e) are rejected — the app's coverage
 * doesn't need them and it keeps the SQL a simple BETWEEN.
 */
export function parseBbox(str) {
  const parts = String(str || '').split(',').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) throw new HttpError(400, 'bad_bbox');
  const [w, s, e, n] = parts;
  if (s < -90 || n > 90 || s >= n || w >= e || w < -180 || e > 180) throw new HttpError(400, 'bad_bbox');
  return { w, s, e, n };
}

/** Clamp ?sinceHours to a sane window (default one week, max 30 days). */
export function clampSinceHours(v, def = 168, max = 720) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}
