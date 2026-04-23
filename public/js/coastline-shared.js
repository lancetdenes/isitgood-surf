/**
 * Shared algorithms used by both the Natural Earth and GSHHG-h coastline paths.
 * Accessor-based so the underlying data shape doesn't matter.
 */

/** Bearing from point 1 to point 2 in degrees (0-360). */
export function bearing(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
  const dLon = (lon2 - lon1) * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
            Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) * toDeg + 360) % 360;
}

/** Walk `distKm` from (lat, lon) along bearing `brgDeg`; return [lat, lon]. */
export function stepAlongBearing(lat, lon, brgDeg, distKm) {
  const rad = brgDeg * Math.PI / 180;
  const dLat = (distKm / 111) * Math.cos(rad);
  const dLon = (distKm / (111 * Math.cos(lat * Math.PI / 180))) * Math.sin(rad);
  return [lat + dLat, lon + dLon];
}

/** Sample swell grid outward to check if the direction faces ocean. */
export function isOcean(grid, coastLat, coastLon, brgDeg) {
  if (!grid || typeof grid.isWet !== 'function') return true;
  const cellKmLat = grid.dy * 111;
  const cellKmLon = grid.dx * 111 * Math.cos(coastLat * Math.PI / 180);
  const distKm = Math.max(30, Math.min(cellKmLat, cellKmLon) * 2);
  const [lat, lon] = stepAlongBearing(coastLat, coastLon, brgDeg, distKm);
  return grid.isWet(lon, lat);
}

/**
 * Compute the adaptive-window coastBearing for a candidate.
 *
 * @param {(featureIdx: number, vertexIdx: number) => [number, number] | null} getVertex
 *   Returns the [lon, lat] of vertex `vertexIdx` in feature `featureIdx`, or null if out of range.
 * @param {number} featureIdx
 * @param {number} segIdx - index of the winning segment (between vertex[segIdx] and vertex[segIdx+1])
 */
export function computeAdaptiveBearing(getVertex, featureIdx, segIdx) {
  const MAX_STEPS = 3;
  const CORNER_THRESHOLD_DEG = 25;

  function segBearing(idx) {
    const a = getVertex(featureIdx, idx);
    const b = getVertex(featureIdx, idx + 1);
    if (!a || !b) return null;
    return bearing(a[1], a[0], b[1], b[0]);
  }

  const centerBearing = segBearing(segIdx);
  if (centerBearing == null) return 0;
  const accepted = [centerBearing];

  function walk(step) {
    let localSin = Math.sin(centerBearing * Math.PI / 180);
    let localCos = Math.cos(centerBearing * Math.PI / 180);
    let localMean = centerBearing;
    for (let k = 1; k <= MAX_STEPS; k++) {
      const b = segBearing(segIdx + step * k);
      if (b == null) break;
      const diff = Math.abs(((b - localMean + 540) % 360) - 180);
      if (diff > CORNER_THRESHOLD_DEG) break;
      accepted.push(b);
      localSin += Math.sin(b * Math.PI / 180);
      localCos += Math.cos(b * Math.PI / 180);
      localMean = (Math.atan2(localSin, localCos) * 180 / Math.PI + 360) % 360;
    }
  }
  walk(-1); walk(1);

  let finalSin = 0, finalCos = 0;
  for (const b of accepted) {
    finalSin += Math.sin(b * Math.PI / 180);
    finalCos += Math.cos(b * Math.PI / 180);
  }
  return (Math.atan2(finalSin, finalCos) * 180 / Math.PI + 360) % 360;
}

/**
 * Validate + possibly flip seaward direction against a grid.
 * @returns {{ seawardDir: number, seawardFlipped: boolean, bothFailed: boolean }}
 */
export function validateSeaward(grid, coastLat, coastLon, assumedSeaward) {
  let seawardDir = assumedSeaward;
  let seawardFlipped = false;
  let bothFailed = false;

  if (grid) {
    if (!isOcean(grid, coastLat, coastLon, seawardDir)) {
      const flipped = (seawardDir + 180) % 360;
      if (isOcean(grid, coastLat, coastLon, flipped)) {
        seawardDir = flipped;
        seawardFlipped = true;
      } else {
        bothFailed = true;
      }
    }
  }
  return { seawardDir, seawardFlipped, bothFailed };
}
