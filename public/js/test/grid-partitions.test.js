import { test } from 'node:test';
import assert from 'node:assert';
import { buildGroundViewArrays, SWELLPART_BASES, parseBinary } from '../grid.js';
import { GridStore } from '../grid-store.js';

// ── buildGroundViewArrays ────────────────────────────────────────────────

function partArrays(n, fill) {
  // 12 params: partitions at bases 0/3/6 (H,D,P each), windsea at 9.
  const a = Array.from({ length: 12 }, () => new Float32Array(n));
  fill(a);
  return a;
}

test('ground view picks the longest-period partition with height >= minH', () => {
  const a = partArrays(2, (a) => {
    // cell 0: p1 = 2m/12s, p2 = 0.5m/17s -> p2 wins (longer period)
    a[0][0] = 2.0; a[1][0] = 270; a[2][0] = 12;
    a[3][0] = 0.5; a[4][0] = 200; a[5][0] = 17;
    // cell 1: p2 has the longest period but is under minH -> p1 wins
    a[0][1] = 1.0; a[1][1] = 90; a[2][1] = 10;
    a[3][1] = 0.05; a[4][1] = 180; a[5][1] = 18;
  });
  const [h, d, p] = buildGroundViewArrays(a, 2, 0.1);
  assert.equal(h[0], 0.5);
  assert.equal(d[0], 200);
  assert.equal(p[0], 17);
  assert.equal(h[1], 1.0);
  assert.equal(p[1], 10);
});

test('ground view zeroes cells where no partition qualifies', () => {
  const a = partArrays(1, (a) => {
    a[0][0] = 0.05; a[2][0] = 20; // under minH
    a[9][0] = 3.0; a[11][0] = 6;  // windsea is never a groundswell candidate
  });
  const [h, , p] = buildGroundViewArrays(a, 1, 0.1);
  assert.equal(h[0], 0);
  assert.equal(p[0], 0);
});

test('SWELLPART_BASES stays in sync with the 12-param layout', () => {
  assert.deepEqual(SWELLPART_BASES.partitions, [0, 3, 6]);
  assert.equal(SWELLPART_BASES.windsea, 9);
});

// ── GridStore sync-decode threshold ──────────────────────────────────────

/** Minimal valid SRF2 buffer with the given plane size. */
function srf2Buffer(nx, ny, nParams) {
  const headerBytes = 32 + nParams * 8;
  const buf = new ArrayBuffer(headerBytes + nParams * nx * ny * 2);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x53524632, false); // 'SRF2'
  dv.setUint32(4, nx, true);
  dv.setUint32(8, ny, true);
  dv.setFloat32(12, 0, true);   // lo1
  dv.setFloat32(16, 90, true);  // la1
  dv.setFloat32(20, 0.25, true);
  dv.setFloat32(24, 0.25, true);
  dv.setUint32(28, nParams, true);
  for (let p = 0; p < nParams; p++) {
    dv.setFloat32(32 + p * 8, 1, true);     // scale
    dv.setFloat32(32 + p * 8 + 4, 0, true); // offset
  }
  return buf;
}

test('peek sync-decodes small raw entries but refuses heavy ones', () => {
  const store = new GridStore({ workerUrl: null });
  const small = srf2Buffer(100, 50, 2);              // ~20 KB
  const heavy = srf2Buffer(1440, 721, 12);           // ~24.9 MB, like swellpart
  store._storeRaw('small.bin', small);
  store._storeRaw('heavy.bin', heavy);

  const smallGrid = store.peek('small.bin');
  assert.ok(smallGrid, 'small raw entry decodes synchronously');
  assert.equal(smallGrid.nx, 100);

  assert.equal(store.peek('heavy.bin'), null, 'heavy raw entry must not sync-decode');
  assert.ok(store.rawCache.has('heavy.bin'), 'heavy raw entry stays in the raw tier');
});

test('parseBinary of the synthetic heavy buffer is a real 12-param grid', () => {
  // Sanity: the refusal above is about size, not because the buffer is junk.
  const grid = parseBinary(srf2Buffer(1440, 721, 12));
  assert.equal(grid.arrays.length, 12);
  assert.equal(grid.nx, 1440);
});
