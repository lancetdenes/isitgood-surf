const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/**
 * Sample swell height in a ring around (lat, lon). Directions with swell>0
 * are ocean; the mean ocean-bearing is the "seaward" direction; offshore is
 * 180° opposite (onshore wind "from" direction).
 *
 * @param {Grid} swellGrid — from loadGridFromFile; must have 3 params [h, d, p]
 * @returns {number|null} offshore direction in degrees [0..360), or null if no coast detected
 */
export function computeOffshoreDeg(swellGrid, lat, lon) {
  const numSamples = 24;
  const offsets = [0.15, 0.25, 0.4];
  const oceanDirs = [];

  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * 360;
    let hasWater = false;
    for (const dist of offsets) {
      const testLat = lat + dist * Math.cos(angle * TO_RAD);
      const testLon = lon + dist * Math.sin(angle * TO_RAD);
      const vals = swellGrid.interpolate(testLon, testLat);
      if (vals && vals[0] > 0.05) { hasWater = true; break; }
    }
    if (hasWater) oceanDirs.push(angle);
  }

  if (oceanDirs.length === 0 || oceanDirs.length === numSamples) return null;

  let sinSum = 0, cosSum = 0;
  for (const d of oceanDirs) {
    sinSum += Math.sin(d * TO_RAD);
    cosSum += Math.cos(d * TO_RAD);
  }
  const seawardDir = (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
  return (seawardDir + 180) % 360;
}
