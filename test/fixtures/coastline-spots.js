/**
 * Fixture spots for the coastline verification harness.
 *
 * Each entry is { name, group, lat, lon, expectedSeaward, tol }.
 *  - tol === null  → angle assertion is skipped (data-limited spot)
 *  - tol number    → seawardDir must be within ±tol degrees
 *
 * `group` is purely cosmetic (used by the gallery report).
 */
export const COASTLINE_FIXTURES = [
  // Original 6 (carried over from coastline-hires.test.js)
  { name: 'Rockaway Beach NY',     group: 'baseline',     lat: 40.585,  lon: -73.82,  expectedSeaward: 180, tol: 20 },
  { name: 'Ocean Beach SF',        group: 'baseline',     lat: 37.75,   lon: -122.51, expectedSeaward: 270, tol: 20 },
  { name: 'Hossegor FR',           group: 'baseline',     lat: 43.665,  lon: -1.44,   expectedSeaward: 270, tol: 20 },
  { name: 'J-Bay ZA',              group: 'baseline',     lat: -34.05,  lon: 24.93,   expectedSeaward: 80,  tol: 20 },
  { name: 'Pipeline HI',           group: 'baseline',     lat: 21.66,   lon: -158.05, expectedSeaward: 0,   tol: null },
  { name: 'Malibu First Point',    group: 'baseline',     lat: 34.035,  lon: -118.68, expectedSeaward: 200, tol: null },

  // Antimeridian witnesses (I3, I6)
  { name: 'Suva Fiji',             group: 'antimeridian', lat: -18.13,  lon: 178.42,  expectedSeaward: 180, tol: 30 },
  { name: 'Apia Samoa',            group: 'antimeridian', lat: -13.83,  lon: -171.77, expectedSeaward: 180, tol: 30 },
  { name: 'Adak Aleutians',        group: 'antimeridian', lat: 51.88,   lon: -176.65, expectedSeaward: 180, tol: 30 },

  // High-latitude witnesses (I2)
  { name: 'Tromso Norway',         group: 'high-lat',     lat: 69.65,   lon: 18.96,   expectedSeaward: 0,   tol: 45 },
  { name: 'Bella Coola BC',        group: 'high-lat',     lat: 52.37,   lon: -126.74, expectedSeaward: 270, tol: 45 },

  // Indented coast (NE was visibly off)
  { name: 'Pacifica CA',           group: 'indented',     lat: 37.61,   lon: -122.49, expectedSeaward: 270, tol: 30 },
  { name: 'Sydney N. Beaches',     group: 'indented',     lat: -33.74,  lon: 151.30,  expectedSeaward: 90,  tol: 30 },
  { name: 'Outer Banks NC',        group: 'indented',     lat: 35.72,   lon: -75.49,  expectedSeaward: 90,  tol: 25 },

  // Smooth coast (DP can over-simplify; witnesses for I1)
  { name: 'Mauritania',            group: 'smooth',       lat: 19.50,   lon: -16.50,  expectedSeaward: 270, tol: 25 },
  { name: 'Ninety Mile Beach AU',  group: 'smooth',       lat: -38.20,  lon: 147.50,  expectedSeaward: 180, tol: 25 },

  // Mysto-style (uncurated; exercise the C1 precompute path)
  { name: 'Cabo Pulmo MX',         group: 'mysto',        lat: 23.43,   lon: -109.43, expectedSeaward: 90,  tol: 45 },
  { name: 'Agadir MA',             group: 'mysto',        lat: 30.42,   lon: -9.65,   expectedSeaward: 270, tol: 30 },
  { name: 'Dakhla EH',             group: 'mysto',        lat: 23.69,   lon: -15.94,  expectedSeaward: 270, tol: 45 },
];
