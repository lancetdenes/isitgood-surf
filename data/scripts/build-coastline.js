import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGshhg } from './lib/gshhg-reader.js';
import { simplifyDP } from './lib/douglas-peucker.js';
import { writeCoastlineBinary } from './lib/coastline-binary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const REF_DIR = join(PROJECT_ROOT, 'data', 'reference');
const GSHHG_FILE = join(REF_DIR, 'gshhs_h.b');
const OUTPUT = join(PROJECT_ROOT, 'public', 'assets', 'coastline-hires.bin');

// --- Ensure source data exists ---
try {
  readFileSync(GSHHG_FILE);
} catch {
  console.log('GSHHG source not found; running download script...');
  execSync(join(__dirname, 'download-gshhg.sh'), { stdio: 'inherit' });
}

// --- Read + filter + simplify ---
const buf = readFileSync(GSHHG_FILE);
console.log(`Read ${buf.length.toLocaleString()} bytes from gshhs_h.b`);

let totalIn = 0, totalOut = 0, nFeatures = 0, nDropped = 0;
const features = [];
for (const poly of readGshhg(buf)) {
  totalIn += poly.points.length;
  // Keep only L1 (continents) and L2 (ocean islands).
  if (poly.level !== 1 && poly.level !== 2) {
    nDropped++;
    continue;
  }
  const simplified = simplifyDP(poly.points, 200); // 200m tolerance
  if (simplified.length < 2) continue;
  features.push(simplified);
  totalOut += simplified.length;
  nFeatures++;
}

console.log(`Features kept: ${nFeatures} (dropped ${nDropped} L3+ features)`);
console.log(`Vertices: ${totalIn.toLocaleString()} → ${totalOut.toLocaleString()} (${Math.round(100 * totalOut / totalIn)}%)`);

// --- Write binary ---
const out = writeCoastlineBinary(features);
writeFileSync(OUTPUT, out);
const sizeMB = out.length / (1024 * 1024);
console.log(`Wrote ${OUTPUT}: ${sizeMB.toFixed(1)} MB`);

if (sizeMB > 35) {
  console.error(`ERROR: output exceeds 35 MB budget. Crank simplification or reconsider inclusion.`);
  process.exit(1);
}
