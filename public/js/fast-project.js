/**
 * fast-project.js — per-frame cached geo↔screen transform for particle loops.
 *
 * The wind/swell renderers advect ~12k particles per animation frame; going
 * through map.project()/map.unproject() for each one costs a matrix multiply
 * plus Point/LngLat allocations per call. For the (default) top-down,
 * north-up view the transform is a simple Mercator scale+offset, so we
 * calibrate it once per frame from two map.project() calls and then run
 * pure arithmetic with zero allocations (results are written into caller-
 * provided objects).
 *
 * Falls back to real map.project/unproject when the map is rotated or
 * pitched, so behavior stays exact in those cases.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Build a projector valid for the CURRENT frame (call once per animation
 * frame, before iterating particles).
 *
 * @returns {{
 *   project(lng: number, lat: number, out: {x,y}): void,
 *   unproject(x: number, y: number, out: {lng,lat}): void,
 * }}
 */
export function makeFrameProjector(map) {
  if (map.getBearing() !== 0 || map.getPitch() !== 0) {
    return {
      project(lng, lat, out) {
        const p = map.project([lng, lat]);
        out.x = p.x;
        out.y = p.y;
      },
      unproject(x, y, out) {
        const g = map.unproject([x, y]);
        out.lng = g.lng;
        out.lat = g.lat;
      },
    };
  }

  // Calibrate the linear Mercator transform from two projected points.
  const c = map.getCenter();
  const pA = map.project([c.lng, c.lat]);
  const pB = map.project([c.lng + 0.01, c.lat]);
  const kx = (pB.x - pA.x) / 0.01;      // px per degree longitude
  const kMerc = kx * DEG;               // px per Mercator-Y unit
  const x0 = pA.x, y0 = pA.y, lng0 = c.lng;
  const mercY0 = Math.log(Math.tan(Math.PI / 4 + c.lat * RAD / 2));

  return {
    project(lng, lat, out) {
      out.x = x0 + kx * (lng - lng0);
      out.y = y0 - kMerc * (Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2)) - mercY0);
    },
    unproject(x, y, out) {
      out.lng = lng0 + (x - x0) / kx;
      out.lat = (2 * Math.atan(Math.exp(mercY0 - (y - y0) / kMerc)) - Math.PI / 2) * DEG;
    },
  };
}
