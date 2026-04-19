import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankNow } from '../pumping.js';

const SPOTS = [
  { n: 'Epic', la: 0, ln: 0, o: 180 },
  { n: 'Flat', la: 1, ln: 1, o: 180 },
];

test('rankNow returns results sorted descending by overall score', () => {
  const wind = {
    interpolate: (lon, lat) => lat < 0.5 ? [0, 2] : [5, 5],
  };
  const swell = {
    interpolate: (lon, lat) => lat < 0.5 ? [3, 180, 14] : [0.2, 180, 4],
  };
  const result = rankNow(SPOTS, wind, swell);
  assert.ok(result.length > 0);
  assert.equal(result[0].spot.n, 'Epic');
  assert.ok(result[0].score > result[1].score);
});

test('rankNow skips spots where grids return null', () => {
  const wind = { interpolate: (lon, lat) => lat === 0 ? [1, 1] : null };
  const swell = { interpolate: (lon, lat) => lat === 0 ? [2, 180, 10] : null };
  const result = rankNow(SPOTS, wind, swell);
  assert.equal(result.length, 1);
  assert.equal(result[0].spot.n, 'Epic');
});

test('rankNow returns at most 100 entries', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ n: `s${i}`, la: 0, ln: 0, o: 180 }));
  const wind = { interpolate: () => [Math.random(), Math.random()] };
  const swell = { interpolate: () => [Math.random() * 3, 180, 10] };
  const result = rankNow(many, wind, swell);
  assert.equal(result.length, 100);
});

test('rankNow skips spots with null offshoreDeg (o)', () => {
  const spots = [
    { n: 'Good', la: 0, ln: 0, o: 180 },
    { n: 'Unknown', la: 0, ln: 0, o: null },
  ];
  const wind = { interpolate: () => [1, 1] };
  const swell = { interpolate: () => [2, 180, 10] };
  const result = rankNow(spots, wind, swell);
  assert.equal(result.length, 1);
  assert.equal(result[0].spot.n, 'Good');
});
