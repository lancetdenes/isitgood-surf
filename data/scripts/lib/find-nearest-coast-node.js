/**
 * Node-side mirror of findNearestCoastHires from public/js/coastline-hires.js.
 *
 * Differences:
 *   - No fetch — caller passes a parsed binary + a pre-built kdbush
 *   - No grid validation (build-time has no swell grid); seaward defaults to
 *     (coastBearing + 90) % 360 — production runtime that loads coast-points.json
 *     can recompute via findNearestCoastHires with a grid if higher accuracy
 *     is needed for a specific spot.
 *
 * Used by build-coast-points-hires.js and downstream tooling that needs to
 * compute coast bearings against the GSHHG hires binary in Node.
 */
import { computeAdaptiveBearing } from '../../../public/js/coastline-shared.js';

const SEARCH_RADIUS_DEG = 0.5;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, T = Math.PI / 180;
  const dLat = (lat2 - lat1) * T, dLon = (lon2 - lon1) * T;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * T) * Math.cos(lat2 * T) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function projectOntoSegment(pLon, pLat, aLon, aLat, bLon, bLat) {
  const dx = bLon - aLon, dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { lon: aLon, lat: aLat, t: 0 };
  let t = ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { lon: aLon + t * dx, lat: aLat + t * dy, t };
}

const to360 = (l) => l < 0 ? l + 360 : l;
const to180 = (l) => l > 180 ? l - 360 : l;

/**
 * Build a KDBush over GSHHG segment midpoints. Mirrors buildIndex() in
 * coastline-hires.js but returns the index for the caller to retain (the
 * runtime keeps it module-scoped; we don't here).
 */
export function buildIndex(KDBush, data) {
  let n = 0;
  for (let f = 0; f < data.nFeatures; f++) {
    const len = data.featureLength(f);
    if (len >= 2) n += len - 1;
  }
  const idx = new KDBush(n);
  const segKey = new Uint32Array(n * 2);
  let k = 0;
  for (let f = 0; f < data.nFeatures; f++) {
    const len = data.featureLength(f);
    for (let s = 0; s < len - 1; s++) {
      const [lA, laA] = data.vertex(f, s);
      const [lB, laB] = data.vertex(f, s + 1);
      idx.add((lA + lB) / 2, (laA + laB) / 2);
      segKey[k * 2] = f;
      segKey[k * 2 + 1] = s;
      k++;
    }
  }
  idx.finish();
  idx.segKey = segKey;
  return idx;
}

/**
 * @param {object} data    parseCoastlineBinary result
 * @param {KDBush} idx     KDBush built via buildIndex above
 * @param {number} lat
 * @param {number} lon
 * @returns {{coastBearing,seawardDir,offshoreDir,distance,coastLat,coastLon,featureIdx,segIdx,unreliableBearing}}
 */
export function findNearestCoastNode(data, idx, lat, lon) {
  const lon360 = to360(lon);
  const cosLat = Math.max(0.1, Math.cos(lat * Math.PI / 180));
  const lonR = Math.min(5, SEARCH_RADIUS_DEG / cosLat);
  const latR = SEARCH_RADIUS_DEG;

  const rangeFor = (lc) => idx.range(lc - lonR, lat - latR, lc + lonR, lat + latR);
  let candIdx = rangeFor(lon360);
  if (lon360 < lonR) candIdx = Array.from(new Set([...candIdx, ...rangeFor(lon360 + 360)]));
  else if (lon360 > 360 - lonR) candIdx = Array.from(new Set([...candIdx, ...rangeFor(lon360 - 360)]));

  if (!candIdx.length) {
    return {
      coastBearing: 45, seawardDir: 135, offshoreDir: 315, distance: Infinity,
      coastLat: lat, coastLon: lon, featureIdx: -1, segIdx: -1, unreliableBearing: true,
    };
  }

  const cands = [];
  for (const ci of candIdx) {
    const f = idx.segKey[ci * 2], s = idx.segKey[ci * 2 + 1];
    const [lonA, latA] = data.vertex(f, s);
    const [lonB, latB] = data.vertex(f, s + 1);
    const proj = projectOntoSegment(lon360, lat, lonA, latA, lonB, latB);
    const projLon = to180(proj.lon);
    const dKm = haversineKm(lat, lon, proj.lat, projLon);
    cands.push({ d: dKm * 1000, f, s, pt: [proj.lat, projLon] });
  }
  cands.sort((a, b) => a.d - b.d);

  const c = cands[0];
  const getVertex = (f, i) => {
    if (i < 0 || i >= data.featureLength(f)) return null;
    const [vL, vLa] = data.vertex(f, i);
    return [to180(vL), vLa];
  };
  const coastBearing = computeAdaptiveBearing(getVertex, c.f, c.s);
  const seawardDir = (coastBearing + 90) % 360;
  return {
    coastBearing, seawardDir, offshoreDir: (seawardDir + 180) % 360,
    distance: c.d, coastLat: c.pt[0], coastLon: c.pt[1],
    featureIdx: c.f, segIdx: c.s, unreliableBearing: false,
  };
}
