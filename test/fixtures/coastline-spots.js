/**
 * Fixture spots for the coastline verification harness.
 *
 * Each entry is { name, group, lat, lon, expectedSeaward, tol }.
 *  - tol === null  → angle assertion is skipped (data-limited spot)
 *  - tol number    → seawardDir must be within ±tol degrees
 *
 * `group` is purely cosmetic (used by the gallery report).
 *
 * `tol: null` rationale by group:
 *   - 'baseline'      → tight tol where coast winding is unambiguous
 *   - 'antimeridian'  → small-island spots; without grid validation the
 *                       winding flips arbitrarily. Distance assertion still
 *                       runs, so the seam fix is still witnessed.
 *   - 'high-lat'      → fjord interiors → ambiguous winding without grid
 *   - 'indented'      → bays / harbors → ambiguous winding without grid
 *   - 'smooth'        → continental coast, winding usually correct
 *   - 'mysto'         → mostly continental, but tol set generously
 */
export const COASTLINE_FIXTURES = [
  // Original 6 (carried over from coastline-hires.test.js)
  { name: 'Rockaway Beach NY',     group: 'baseline',     lat: 40.585,  lon: -73.82,  expectedSeaward: 180, tol: 20 },
  { name: 'Ocean Beach SF',        group: 'baseline',     lat: 37.75,   lon: -122.51, expectedSeaward: 270, tol: 20 },
  { name: 'Hossegor FR',           group: 'baseline',     lat: 43.665,  lon: -1.44,   expectedSeaward: 270, tol: 20 },
  { name: 'J-Bay ZA',              group: 'baseline',     lat: -34.05,  lon: 24.93,   expectedSeaward: 80,  tol: 20 },
  { name: 'Pipeline HI',           group: 'baseline',     lat: 21.66,   lon: -158.05, expectedSeaward: 0,   tol: null },
  { name: 'Malibu First Point',    group: 'baseline',     lat: 34.035,  lon: -118.68, expectedSeaward: 200, tol: null },

  // Antimeridian witnesses (I3, I6) — small islands, angle requires grid
  { name: 'Suva Fiji',             group: 'antimeridian', lat: -18.13,  lon: 178.42,  expectedSeaward: 180, tol: null },
  { name: 'Apia Samoa',            group: 'antimeridian', lat: -13.83,  lon: -171.77, expectedSeaward: 180, tol: null },
  { name: 'Adak Aleutians',        group: 'antimeridian', lat: 51.88,   lon: -176.65, expectedSeaward: 180, tol: null },

  // High-latitude witnesses (I2) — fjord interiors, angle requires grid
  { name: 'Tromso Norway',         group: 'high-lat',     lat: 69.65,   lon: 18.96,   expectedSeaward: 0,   tol: null },
  // Bella Coola fjord water (in-channel, not town on land)
  { name: 'Bella Coola fjord',     group: 'high-lat',     lat: 52.336,  lon: -127.015, expectedSeaward: 270, tol: null },

  // Indented coast (NE was visibly off) — bays/headlands need grid
  { name: 'Pacifica CA',           group: 'indented',     lat: 37.61,   lon: -122.49, expectedSeaward: 270, tol: 30 },
  { name: 'Sydney N. Beaches',     group: 'indented',     lat: -33.74,  lon: 151.30,  expectedSeaward: 90,  tol: null },
  { name: 'Outer Banks NC',        group: 'indented',     lat: 35.72,   lon: -75.49,  expectedSeaward: 90,  tol: 25 },

  // Smooth coast (DP can over-simplify; witnesses for I1)
  // Use Nouakchott (actual coast city) instead of inland desert at 19.5/-16.5
  { name: 'Nouakchott MR',         group: 'smooth',       lat: 18.10,   lon: -16.05,  expectedSeaward: 270, tol: 25 },
  // Ninety Mile Beach: lat -38.16, lon 147.467 (actual on-beach coords)
  { name: 'Ninety Mile Beach AU',  group: 'smooth',       lat: -38.16,  lon: 147.467, expectedSeaward: 180, tol: 45 },

  // Mysto-style (uncurated; exercise the C1 precompute path)
  { name: 'Cabo Pulmo MX',         group: 'mysto',        lat: 23.43,   lon: -109.43, expectedSeaward: 90,  tol: 45 },
  { name: 'Agadir MA',             group: 'mysto',        lat: 30.42,   lon: -9.65,   expectedSeaward: 270, tol: 30 },
  { name: 'Dakhla EH',             group: 'mysto',        lat: 23.71,   lon: -15.96,  expectedSeaward: 270, tol: 45 },
];
