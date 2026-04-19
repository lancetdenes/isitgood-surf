import { haversineKm, bearingDeg, destinationPoint } from './geo.js';

/**
 * Walk a GeoJSON LineString with geodesic steps of stepKm.
 * @param {number[][]} coords  [[lon, lat], [lon, lat], ...]
 * @param {number} stepKm      target spacing between output points
 * @returns {{lat:number, lon:number}[]}
 */
export function walkLineString(coords, stepKm) {
  if (coords.length < 2) {
    return coords.length === 1
      ? [{ lon: coords[0][0], lat: coords[0][1] }]
      : [];
  }

  const out = [{ lon: coords[0][0], lat: coords[0][1] }];
  let curLat = coords[0][1], curLon = coords[0][0];
  let distToNextOutput = stepKm;

  for (let i = 1; i < coords.length; i++) {
    const targetLon = coords[i][0], targetLat = coords[i][1];
    let remaining = haversineKm(curLat, curLon, targetLat, targetLon);

    while (remaining >= distToNextOutput) {
      const bearing = bearingDeg(curLat, curLon, targetLat, targetLon);
      const next = destinationPoint(curLat, curLon, bearing, distToNextOutput);
      out.push(next);
      curLat = next.lat;
      curLon = next.lon;
      remaining -= distToNextOutput;
      distToNextOutput = stepKm;
    }

    distToNextOutput -= remaining;
    curLat = targetLat;
    curLon = targetLon;
  }

  return out;
}
