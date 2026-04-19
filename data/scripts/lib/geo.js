const R_EARTH_KM = 6371.0088;
const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destinationPoint(lat, lon, bearing, distanceKm) {
  const δ = distanceKm / R_EARTH_KM;
  const θ = bearing * TO_RAD;
  const φ1 = lat * TO_RAD;
  const λ1 = lon * TO_RAD;

  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );

  return { lat: φ2 * TO_DEG, lon: ((λ2 * TO_DEG + 540) % 360) - 180 };
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * TO_RAD, φ2 = lat2 * TO_RAD;
  const Δλ = (lon2 - lon1) * TO_RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * TO_DEG) + 360) % 360;
}
