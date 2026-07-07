const R = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const MAX_KM = 25;
const MAX_MS = 48 * 3600 * 1000;

/**
 * Resolve the trust tier for an upload. 'exif' survives only when the claim
 * says exif AND the server-side EXIF re-read agrees within 25 km / 48 h.
 * Mismatch or missing EXIF downgrades to 'manual' — never a hard reject.
 */
export function resolveStampSource({ claimed, exif }) {
  if (claimed.source !== 'exif') return claimed.source === 'device' ? 'device' : 'manual';
  if (!exif || exif.lat == null || exif.capturedAt == null) return 'manual';
  const km = haversineKm(claimed.lat, claimed.lng, exif.lat, exif.lng);
  const ms = Math.abs(new Date(claimed.capturedAt) - new Date(exif.capturedAt));
  return km <= MAX_KM && ms <= MAX_MS ? 'exif' : 'manual';
}
