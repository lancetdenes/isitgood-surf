import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../../../data/scripts/lib/coastline-binary.js';
import { findNearestCoastHires, _resetHires, _setHiresData, setKDBush } from '../coastline-hires.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
setKDBush(KDBush);

test('coast result always exposes unreliableBearing as a boolean', () => {
  _resetHires();
  const buf = readFileSync(join(__dirname, '..', '..', 'assets', 'coastline-hires.bin'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  _setHiresData(parseCoastlineBinary(ab));
  // A click in mid-Pacific (no land within search radius) → no candidates
  // → unreliable sentinel.
  const r = findNearestCoastHires(0, -150, null);
  assert.equal(typeof r.unreliableBearing, 'boolean');
  if (r.unreliableBearing) {
    assert.equal(r.featureIdx, -1);
    assert.equal(r.distance, Infinity);
  }
});
