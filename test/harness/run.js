/**
 * Usage: node test/harness/run.js [phase-name]
 *
 * Default phase = 'current'. Writes PNGs to test/snapshots/<phase>/<spotName>.png
 * and a per-phase summary JSON to test/snapshots/<phase>/summary.json.
 *
 * Loading the GSHHG binary up front so all fixtures share the same data.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import KDBush from 'kdbush';
import { parseCoastlineBinary } from '../../data/scripts/lib/coastline-binary.js';
import { _resetHires, _setHiresData, setKDBush } from '../../public/js/coastline-hires.js';
import { COASTLINE_FIXTURES } from '../fixtures/coastline-spots.js';
import { renderFixture } from './render-snippet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BIN_PATH = join(ROOT, 'public', 'assets', 'coastline-hires.bin');
const phase = process.argv[2] || 'current';
const OUT = join(ROOT, 'test', 'snapshots', phase);

setKDBush(KDBush);
_resetHires();
const buf = readFileSync(BIN_PATH);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
_setHiresData(parseCoastlineBinary(ab));

mkdirSync(OUT, { recursive: true });

const summary = [];
let pass = 0, fail = 0;
for (const f of COASTLINE_FIXTURES) {
  const slug = f.name.replace(/[^A-Za-z0-9]+/g, '-');
  let res;
  try {
    res = renderFixture(f);
  } catch (err) {
    summary.push({ name: f.name, group: f.group, ok: false, error: err.message, lat: f.lat, lon: f.lon, slug });
    fail++;
    continue;
  }
  writeFileSync(join(OUT, `${slug}.png`), res.png);
  summary.push({
    name: f.name, group: f.group, ok: res.ok, lat: f.lat, lon: f.lon, slug,
    seawardDir: res.coast?.seawardDir,
    coastBearing: res.coast?.coastBearing,
    distanceKm: res.coast ? res.coast.distance / 1000 : null,
    unreliableBearing: res.coast?.unreliableBearing,
    failures: res.checks.failures,
    notes: res.checks.notes,
  });
  if (res.ok) pass++; else fail++;
}

writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ phase, pass, fail, results: summary }, null, 2));
console.log(`[${phase}] ${pass} pass / ${fail} fail / ${summary.length} total → ${OUT}`);
process.exit(fail === 0 ? 0 : 1);
