import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../../../data/scripts/lib/coastline-binary.js';
import { _setHiresData, isHiresReady, _resetHires, setKDBush } from '../coastline-hires.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(__dirname, '..', '..', '..', 'public', 'assets', 'coastline-hires.bin');

// Tests use Node's kdbush package; in the browser this is injected from /vendor/kdbush/.
setKDBush(KDBush);

test('isHiresReady is false before _setHiresData', () => {
  _resetHires();
  assert.equal(isHiresReady(), false);
});

test('parses real coastline-hires.bin and flips ready flag', () => {
  _resetHires();
  const buf = readFileSync(BIN_PATH);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = parseCoastlineBinary(ab);
  _setHiresData(data);
  assert.equal(isHiresReady(), true);
});
