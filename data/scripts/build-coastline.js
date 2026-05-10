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

const DP_TOLERANCE_M = 200;
// After Douglas-Peucker, smooth coasts can collapse to single segments tens
// of km long. The runtime KDBush is keyed by segment midpoints with a 0.5°
// (~55 km) lookup radius, so a click near a long segment's endpoint can
// miss the candidate entirely. Bisect any output segment longer than this.
const MAX_SEGMENT_KM = 20;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, T = Math.PI / 180;
  const dLat = (lat2 - lat1) * T, dLon = (lon2 - lon1) * T;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * T) * Math.cos(lat2 * T) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bisect any segment > maxKm by inserting linearly-interpolated intermediate
 * points (lon/lat space — fine at this resolution; GSHHG vertices are
 * already dense). Endpoints preserved.
 */
function capSegmentLength(points, maxKm) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [lonA, latA] = points[i - 1];
    const [lonB, latB] = points[i];
    const dKm = haversineKm(latA, lonA, latB, lonB);
    if (dKm <= maxKm) {
      out.push(points[i]);
      continue;
    }
    const nSplits = Math.ceil(dKm / maxKm);
    for (let k = 1; k < nSplits; k++) {
      const t = k / nSplits;
      out.push([lonA + (lonB - lonA) * t, latA + (latB - latA) * t]);
    }
    out.push(points[i]);
  }
  return out;
}

// --- Ensure source data exists ---
try {
  readFileSync(GSHHG_FILE);
} catch {
  console.log('GSHHG source not found; running download script...');
  execSync(join(__dirname, 'download-gshhg.sh'), { stdio: 'inherit' });
}

// --- Read + filter + simplify + cap ---
const buf = readFileSync(GSHHG_FILE);
console.log(`Read ${buf.length.toLocaleString()} bytes from gshhs_h.b`);

let totalIn = 0, totalSimp = 0, totalOut = 0, nFeatures = 0, nDropped = 0;
const features = [];
for (const poly of readGshhg(buf)) {
  totalIn += poly.points.length;
  // Keep only L1 (continents) and L2 (ocean islands).
  if (poly.level !== 1 && poly.level !== 2) {
    nDropped++;
    continue;
  }
  const simplified = simplifyDP(poly.points, DP_TOLERANCE_M);
  if (simplified.length < 2) continue;
  totalSimp += simplified.length;
  const capped = capSegmentLength(simplified, MAX_SEGMENT_KM);
  features.push(capped);
  totalOut += capped.length;
  nFeatures++;
}

console.log(`Features kept: ${nFeatures} (dropped ${nDropped} L3+ features)`);
console.log(`Vertices: ${totalIn.toLocaleString()} → DP ${totalSimp.toLocaleString()} → capped ${totalOut.toLocaleString()} (${Math.round(100 * totalOut / totalIn)}%)`);

// Diagnostic — verify the cap actually held
let maxSeg = 0;
for (const f of features) {
  for (let i = 1; i < f.length; i++) {
    const km = haversineKm(f[i - 1][1], f[i - 1][0], f[i][1], f[i][0]);
    if (km > maxSeg) maxSeg = km;
  }
}
console.log(`Max segment length after cap: ${maxSeg.toFixed(2)} km`);

// --- Write binary ---
const out = writeCoastlineBinary(features);
writeFileSync(OUTPUT, out);
const sizeMB = out.length / (1024 * 1024);
console.log(`Wrote ${OUTPUT}: ${sizeMB.toFixed(1)} MB`);

if (sizeMB > 35) {
  console.error(`ERROR: output exceeds 35 MB budget. Crank simplification or reconsider inclusion.`);
  process.exit(1);
}
