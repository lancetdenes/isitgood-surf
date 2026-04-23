/**
 * Douglas-Peucker line simplification.
 *
 * @param {Array<[number, number]>} points - [lon, lat] pairs in degrees
 * @param {number} toleranceM - maximum perpendicular distance in meters
 * @returns {Array<[number, number]>} simplified points (subset, endpoints preserved)
 */
export function simplifyDP(points, toleranceM) {
  if (points.length < 3) return points.slice();

  // Convert tolerance to degrees using mean latitude (equirectangular scale).
  const meanLat = points.reduce((s, p) => s + p[1], 0) / points.length;
  const cosLat = Math.cos(meanLat * Math.PI / 180);
  const tolDegLat = toleranceM / 111000;
  const tolDegLon = toleranceM / (111000 * cosLat);
  // Use the smaller of the two as a conservative scalar threshold.
  const tolDeg = Math.min(tolDegLat, tolDegLon);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let maxD = 0, maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolDeg && maxI !== -1) {
      keep[maxI] = 1;
      stack.push([lo, maxI]);
      stack.push([maxI, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/** Perpendicular distance from point p to segment (a, b), in degrees. */
function perpDist(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
