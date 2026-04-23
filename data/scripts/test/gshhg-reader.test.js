import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readGshhg } from '../lib/gshhg-reader.js';

// Build a synthetic GSHHG buffer with 2 polygons:
//   P1: id=1, level=1 (continent), 3 points at (0,0), (1,0), (1,1)
//   P2: id=2, level=3 (pond in island), 2 points at (10,10), (11,11)
function buildFixture() {
  const enc = (ints) => {
    const buf = Buffer.alloc(ints.length * 4);
    for (let i = 0; i < ints.length; i++) buf.writeInt32BE(ints[i], i * 4);
    return buf;
  };
  const p1Header = enc([1, 3, 1, 0, 1000000, 0, 1000000, 100, 1000, -1, -1]);
  const p1Points = enc([0, 0, 1000000, 0, 1000000, 1000000]);
  const p2Header = enc([2, 2, 3, 10000000, 11000000, 10000000, 11000000, 50, 500, 1, 1]);
  const p2Points = enc([10000000, 10000000, 11000000, 11000000]);
  return Buffer.concat([p1Header, p1Points, p2Header, p2Points]);
}

test('readGshhg yields polygons with level, id, and lon/lat point arrays', () => {
  const buf = buildFixture();
  const polys = [...readGshhg(buf)];
  assert.equal(polys.length, 2);
  assert.equal(polys[0].id, 1);
  assert.equal(polys[0].level, 1);
  assert.equal(polys[0].points.length, 3);
  assert.deepEqual(polys[0].points[0], [0, 0]);
  assert.deepEqual(polys[0].points[1], [1, 0]);
  assert.deepEqual(polys[0].points[2], [1, 1]);
  assert.equal(polys[1].level, 3);
});
