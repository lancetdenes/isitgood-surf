# where it's pumping — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "top 100 surf spots worldwide" ranking feature for `surf_app_V3` with three modes — right now / score this week / score next week — using local grid data for zero-latency ranking of ~20k–25k spots.

**Architecture:** A one-time Node build script produces `public/data/coast-points.json` (auto-discovered coastline points every 10km, country + town tagged via Natural Earth + GeoNames) plus `public/data/named-spots.json` (expanded from V1's curated list to 500+). At runtime, a new `public/js/pumping.js` module loads both, iterates spots, interpolates wind/swell from already-loaded grids, scores via existing `ratings.js`, and renders a slideout panel. GFS download pipeline is extended to fetch days 7–14 at 6-hourly resolution.

**Tech Stack:**
- Runtime: vanilla ES modules (matches existing V3 code)
- Build script: Node 18+ with `node:test` built-in runner
- Dependencies (build-time only): `kdbush` (KD-tree), `@turf/boolean-point-in-polygon`, `@turf/helpers`
- Reference data (not committed): Natural Earth 10m coastline + admin-0, GeoNames `cities1000.txt`
- UI: existing CSS conventions (`.ctrl-btn`, slideout pattern from `panel.js`)

---

## Spec reference

This plan implements `docs/superpowers/specs/2026-04-19-where-its-pumping-design.md`. Read that spec before starting — this plan assumes you know what's being built.

## File structure

**Create:**
- `surf_app_V3/data/scripts/build-coast-points.js` — Node build script (main entry point)
- `surf_app_V3/data/scripts/lib/coastline-walker.js` — geodesic 10km walker over LineStrings
- `surf_app_V3/data/scripts/lib/geo.js` — haversine distance, bearing math, point-in-polygon wrapper
- `surf_app_V3/data/scripts/lib/reference-data.js` — loaders for Natural Earth + GeoNames
- `surf_app_V3/data/scripts/lib/offshore.js` — `offshoreDeg` computation (Node port of `detectCoastFromGrid`)
- `surf_app_V3/data/scripts/lib/grid-loader.js` — Node-side `.bin` grid reader
- `surf_app_V3/data/scripts/download-reference-data.sh` — fetches Natural Earth + GeoNames
- `surf_app_V3/data/scripts/test/coastline-walker.test.js`
- `surf_app_V3/data/scripts/test/geo.test.js`
- `surf_app_V3/data/scripts/test/offshore.test.js`
- `surf_app_V3/data/reference/.gitkeep` — directory for reference data (contents gitignored)
- `surf_app_V3/public/data/named-spots.json` — curated spot list (500+)
- `surf_app_V3/public/data/coast-points.json` — build script output (committed)
- `surf_app_V3/public/js/pumping.js` — runtime ranking + panel module
- `surf_app_V3/public/js/test/pumping.test.js` — ranking logic tests

**Modify:**
- `surf_app_V3/package.json` — add devDeps + `build:coast-points` script
- `surf_app_V3/.gitignore` — exclude `data/reference/*` (except `.gitkeep`)
- `surf_app_V3/public/index.html` — add button + panel root
- `surf_app_V3/public/css/style.css` — add panel styles
- `surf_app_V3/public/js/app.js` — wire button click, expose App instance for pumping.js
- `surf_app_V3/data/scripts/download-gfs.sh` — extend to fetch f171–f336 at 6-hourly

---

## Phase 1 — build-time foundation

### Task 1: Install build-time dependencies

**Files:**
- Modify: `surf_app_V3/package.json`

- [ ] **Step 1: Add devDependencies**

```bash
cd surf_app_V3
npm install --save-dev kdbush @turf/boolean-point-in-polygon @turf/helpers
```

- [ ] **Step 2: Verify installs**

Run: `node -e "import('kdbush').then(m => console.log(typeof m.default))"`
Expected output: `function`

- [ ] **Step 3: Add build script to `scripts`**

Edit `surf_app_V3/package.json`, add to the `"scripts"` object:

```json
"build:coast-points": "node data/scripts/build-coast-points.js",
"test:build": "node --test data/scripts/test/"
```

- [ ] **Step 4: Commit**

```bash
git add surf_app_V3/package.json surf_app_V3/package-lock.json
git commit -m "feat(pumping): add build-script dependencies"
```

---

### Task 2: Gitignore reference data and add directory

**Files:**
- Modify: `surf_app_V3/.gitignore` (create at V3 level if missing)
- Create: `surf_app_V3/data/reference/.gitkeep`

- [ ] **Step 1: Create V3-level `.gitignore`**

File: `surf_app_V3/.gitignore`

```
node_modules/
data/grib/
data/gfs/
data/ecmwf/
data/reference/*
!data/reference/.gitkeep
```

- [ ] **Step 2: Create placeholder**

```bash
mkdir -p surf_app_V3/data/reference
touch surf_app_V3/data/reference/.gitkeep
```

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/.gitignore surf_app_V3/data/reference/.gitkeep
git commit -m "feat(pumping): add data/reference dir and gitignore"
```

---

### Task 3: Reference-data download script

**Files:**
- Create: `surf_app_V3/data/scripts/download-reference-data.sh`

- [ ] **Step 1: Write the script**

File contents:

```bash
#!/bin/bash
# download-reference-data.sh — Fetches Natural Earth + GeoNames datasets
# used by build-coast-points.js. Run once; outputs are gitignored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REF_DIR="$(dirname "$SCRIPT_DIR")/reference"
mkdir -p "$REF_DIR"

echo "━━━ Downloading reference datasets ━━━"

# Natural Earth — 10m coastline (simplified world coast as LineStrings)
COAST_URL="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson"
COAST_OUT="${REF_DIR}/ne_10m_coastline.geojson"
if [ ! -f "$COAST_OUT" ]; then
  echo "  → coastline: $COAST_URL"
  curl -sfL -o "$COAST_OUT" "$COAST_URL"
  echo "    ✓ $(du -h "$COAST_OUT" | cut -f1)"
else
  echo "  → coastline: cached"
fi

# Natural Earth — 10m admin-0 (country polygons)
ADMIN_URL="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson"
ADMIN_OUT="${REF_DIR}/ne_10m_admin_0_countries.geojson"
if [ ! -f "$ADMIN_OUT" ]; then
  echo "  → countries: $ADMIN_URL"
  curl -sfL -o "$ADMIN_OUT" "$ADMIN_URL"
  echo "    ✓ $(du -h "$ADMIN_OUT" | cut -f1)"
else
  echo "  → countries: cached"
fi

# GeoNames — cities with pop > 1000
CITIES_ZIP="${REF_DIR}/cities1000.zip"
CITIES_OUT="${REF_DIR}/cities1000.txt"
if [ ! -f "$CITIES_OUT" ]; then
  echo "  → cities1000: https://download.geonames.org/export/dump/cities1000.zip"
  curl -sfL -o "$CITIES_ZIP" "https://download.geonames.org/export/dump/cities1000.zip"
  unzip -qo "$CITIES_ZIP" -d "$REF_DIR"
  rm "$CITIES_ZIP"
  echo "    ✓ $(du -h "$CITIES_OUT" | cut -f1)"
else
  echo "  → cities1000: cached"
fi

echo ""
echo "━━━ Done ━━━"
echo "Reference data in: $REF_DIR"
```

- [ ] **Step 2: Make executable and run it**

```bash
chmod +x surf_app_V3/data/scripts/download-reference-data.sh
cd surf_app_V3 && bash data/scripts/download-reference-data.sh
```

Expected output: three `✓` lines, totaling ~14–17MB in `data/reference/`.

- [ ] **Step 3: Verify files**

```bash
ls -lh surf_app_V3/data/reference/
```

Expected: `cities1000.txt`, `ne_10m_admin_0_countries.geojson`, `ne_10m_coastline.geojson` — each nonzero.

- [ ] **Step 4: Commit script**

```bash
git add surf_app_V3/data/scripts/download-reference-data.sh
git commit -m "feat(pumping): add reference data download script"
```

---

### Task 4: geo.js — haversine + bearing helpers (TDD)

**Files:**
- Create: `surf_app_V3/data/scripts/lib/geo.js`
- Create: `surf_app_V3/data/scripts/test/geo.test.js`

- [ ] **Step 1: Write failing tests**

File: `surf_app_V3/data/scripts/test/geo.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, destinationPoint, bearingDeg } from '../lib/geo.js';

test('haversineKm: NY to LA is ~3940km', () => {
  // JFK 40.6413, -73.7781 → LAX 33.9416, -118.4085
  const d = haversineKm(40.6413, -73.7781, 33.9416, -118.4085);
  assert.ok(d > 3930 && d < 3980, `got ${d}`);
});

test('haversineKm: same point is 0', () => {
  assert.equal(haversineKm(10, 20, 10, 20), 0);
});

test('destinationPoint: moving 10km east from equator lands ~0.0899° east', () => {
  const { lat, lon } = destinationPoint(0, 0, 90, 10);
  assert.ok(Math.abs(lat) < 1e-6, `lat drift ${lat}`);
  assert.ok(Math.abs(lon - 0.0899) < 0.005, `lon ${lon}`);
});

test('bearingDeg: N is 0, E is 90', () => {
  assert.ok(Math.abs(bearingDeg(0, 0, 1, 0)) < 0.1);          // north
  assert.ok(Math.abs(bearingDeg(0, 0, 0, 1) - 90) < 0.1);     // east
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd surf_app_V3 && npm run test:build
```

Expected: FAIL — `Cannot find module 'lib/geo.js'`

- [ ] **Step 3: Implement geo.js**

File: `surf_app_V3/data/scripts/lib/geo.js`

```javascript
const R_EARTH_KM = 6371.0088;
const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function destinationPoint(lat, lon, bearing, distanceKm) {
  const δ = distanceKm / R_EARTH_KM;
  const θ = bearing * TO_RAD;
  const φ1 = lat * TO_RAD;
  const λ1 = lon * TO_RAD;

  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );

  return { lat: φ2 * TO_DEG, lon: ((λ2 * TO_DEG + 540) % 360) - 180 };
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * TO_RAD, φ2 = lat2 * TO_RAD;
  const Δλ = (lon2 - lon1) * TO_RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * TO_DEG) + 360) % 360;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:build
```

Expected: 4 passing tests in `geo.test.js`.

- [ ] **Step 5: Commit**

```bash
git add surf_app_V3/data/scripts/lib/geo.js surf_app_V3/data/scripts/test/geo.test.js
git commit -m "feat(pumping): geo helpers (haversine, destination, bearing)"
```

---

### Task 5: coastline-walker.js — 10km geodesic walk over LineStrings (TDD)

**Files:**
- Create: `surf_app_V3/data/scripts/lib/coastline-walker.js`
- Create: `surf_app_V3/data/scripts/test/coastline-walker.test.js`

- [ ] **Step 1: Write failing tests**

File: `surf_app_V3/data/scripts/test/coastline-walker.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkLineString } from '../lib/coastline-walker.js';
import { haversineKm } from '../lib/geo.js';

test('walkLineString: straight east-west 100km produces ~10 points at 10km spacing', () => {
  // ~100km at equator ≈ 0.899° lon
  const coords = [[0, 0], [0.899, 0]]; // [lon, lat] format per GeoJSON
  const pts = walkLineString(coords, 10);
  // Should produce a point at each ~10km step (11 including start/end within 10km)
  assert.ok(pts.length >= 9 && pts.length <= 12, `got ${pts.length}`);
  // Verify spacing between consecutive points is close to 10km
  for (let i = 1; i < pts.length; i++) {
    const d = haversineKm(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    assert.ok(d > 8 && d < 12, `spacing ${d}km between pt ${i - 1} and ${i}`);
  }
});

test('walkLineString: multi-segment line handles vertex transitions', () => {
  // Two 50km segments joined — total ~100km, should get ~10 points
  const coords = [[0, 0], [0.4495, 0], [0.4495, 0.4495]];
  const pts = walkLineString(coords, 10);
  assert.ok(pts.length >= 8 && pts.length <= 12, `got ${pts.length}`);
});

test('walkLineString: line shorter than step produces just the start point', () => {
  // 1km line
  const coords = [[0, 0], [0.00899, 0]];
  const pts = walkLineString(coords, 10);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].lat, 0);
  assert.equal(pts[0].lon, 0);
});
```

- [ ] **Step 2: Run tests — expected to fail**

```bash
npm run test:build
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the walker**

File: `surf_app_V3/data/scripts/lib/coastline-walker.js`

```javascript
import { haversineKm, bearingDeg, destinationPoint } from './geo.js';

/**
 * Walk a GeoJSON LineString with geodesic steps of stepKm.
 * @param {number[][]} coords  [[lon, lat], [lon, lat], ...]
 * @param {number} stepKm      target spacing between output points
 * @returns {{lat:number, lon:number}[]}
 */
export function walkLineString(coords, stepKm) {
  if (coords.length < 2) {
    return coords.length === 1
      ? [{ lon: coords[0][0], lat: coords[0][1] }]
      : [];
  }

  const out = [{ lon: coords[0][0], lat: coords[0][1] }];
  let curLat = coords[0][1], curLon = coords[0][0];
  let distToNextOutput = stepKm;

  for (let i = 1; i < coords.length; i++) {
    const targetLon = coords[i][0], targetLat = coords[i][1];
    let remaining = haversineKm(curLat, curLon, targetLat, targetLon);

    while (remaining >= distToNextOutput) {
      const bearing = bearingDeg(curLat, curLon, targetLat, targetLon);
      const next = destinationPoint(curLat, curLon, bearing, distToNextOutput);
      out.push(next);
      curLat = next.lat;
      curLon = next.lon;
      remaining -= distToNextOutput;
      distToNextOutput = stepKm;
    }

    // Consume the partial-segment remainder
    distToNextOutput -= remaining;
    curLat = targetLat;
    curLon = targetLon;
  }

  return out;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm run test:build
```

Expected: 3 passing in `coastline-walker.test.js` plus previous 4 from geo.

- [ ] **Step 5: Commit**

```bash
git add surf_app_V3/data/scripts/lib/coastline-walker.js surf_app_V3/data/scripts/test/coastline-walker.test.js
git commit -m "feat(pumping): coastline walker at fixed km spacing"
```

---

### Task 6: reference-data.js — loaders for Natural Earth + GeoNames

**Files:**
- Create: `surf_app_V3/data/scripts/lib/reference-data.js`

- [ ] **Step 1: Implement loaders**

File: `surf_app_V3/data/scripts/lib/reference-data.js`

```javascript
import fs from 'node:fs';
import path from 'node:path';
import KDBush from 'kdbush';

const REF_DIR = path.resolve(import.meta.dirname, '../../reference');

/** Load Natural Earth admin-0 countries as a FeatureCollection. */
export function loadCountries() {
  const file = path.join(REF_DIR, 'ne_10m_admin_0_countries.geojson');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run: bash data/scripts/download-reference-data.sh`);
  }
  const gj = JSON.parse(fs.readFileSync(file, 'utf8'));
  return gj;
}

/** Load Natural Earth coastline as a FeatureCollection of LineStrings/MultiLineStrings. */
export function loadCoastline() {
  const file = path.join(REF_DIR, 'ne_10m_coastline.geojson');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run: bash data/scripts/download-reference-data.sh`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Load GeoNames cities1000 as an array of {name, lat, lon, country}.
 * File is tab-separated; see https://download.geonames.org/export/dump/ for columns.
 */
export function loadCities() {
  const file = path.join(REF_DIR, 'cities1000.txt');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run: bash data/scripts/download-reference-data.sh`);
  }
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const cols = line.split('\t');
    // Columns: [0]geonameid [1]name [2]asciiname [3]alternatenames [4]lat [5]lon [6]fc [7]fcode [8]country ...
    const name = cols[1];
    const lat = parseFloat(cols[4]);
    const lon = parseFloat(cols[5]);
    const country = cols[8];
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    out.push({ name, lat, lon, country });
  }
  return out;
}

/** Build a KDBush index over an array of {lat, lon}. Returns {index, points}. */
export function buildCityIndex(cities) {
  const index = new KDBush(cities.length);
  for (const c of cities) index.add(c.lon, c.lat);
  index.finish();
  return { index, cities };
}

/** Find nearest city within maxKm. Returns null if none. */
export function nearestCity(index, cities, lat, lon, maxKm) {
  // Bounding-box search: 1 degree ≈ 111km at equator; use slight overshoot for high lat
  const boxDeg = (maxKm / 111) / Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const ids = index.index.range(lon - boxDeg, lat - boxDeg, lon + boxDeg, lat + boxDeg);
  if (ids.length === 0) return null;

  let best = null, bestD = Infinity;
  for (const i of ids) {
    const c = cities[i];
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxKm ? { ...best, distanceKm: bestD } : null;
}

// Inline import to avoid a dependency cycle in tests
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, TR = Math.PI / 180;
  const dLat = (lat2 - lat1) * TR, dLon = (lon2 - lon1) * TR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TR) * Math.cos(lat2 * TR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
```

- [ ] **Step 2: Smoke test manually**

Run:

```bash
cd surf_app_V3
node --input-type=module -e "
import { loadCoastline, loadCountries, loadCities, buildCityIndex, nearestCity } from './data/scripts/lib/reference-data.js';
const coast = loadCoastline();
console.log('coastline features:', coast.features.length);
const countries = loadCountries();
console.log('countries:', countries.features.length);
const cities = loadCities();
console.log('cities:', cities.length);
const { index } = buildCityIndex(cities);
const near = nearestCity(index, cities, 21.3, -157.8, 50); // Honolulu-ish
console.log('near Honolulu:', near?.name, near?.country, near?.distanceKm.toFixed(1) + 'km');
"
```

Expected output: `coastline features: ~4000`, `countries: ~250`, `cities: ~150000`, `near Honolulu: Honolulu US <small>km`.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/data/scripts/lib/reference-data.js
git commit -m "feat(pumping): reference-data loaders (NE + GeoNames)"
```

---

### Task 7: grid-loader.js — Node-side `.bin` reader (port of `grid.js`)

**Files:**
- Create: `surf_app_V3/data/scripts/lib/grid-loader.js`

- [ ] **Step 1: Implement the loader**

File: `surf_app_V3/data/scripts/lib/grid-loader.js`

```javascript
import fs from 'node:fs';

/**
 * Load a V3 .bin grid from disk. Format matches public/js/grid.js exactly.
 * Header: "SURF" (4 bytes) + 6 uint32/float32 fields + float32 data arrays.
 */
export function loadGridFromFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.slice(0, 4).toString('ascii') !== 'SURF') {
    throw new Error(`${filePath}: bad magic`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nx = dv.getUint32(4, true);
  const ny = dv.getUint32(8, true);
  const lo1 = dv.getFloat32(12, true);
  const la1 = dv.getFloat32(16, true);
  const dx = dv.getFloat32(20, true);
  const dy = dv.getFloat32(24, true);
  const nParams = dv.getUint32(28, true);

  const arrays = [];
  const arrayBytes = nx * ny * 4;
  let offset = 32;
  for (let p = 0; p < nParams; p++) {
    arrays.push(new Float32Array(buf.buffer, buf.byteOffset + offset, nx * ny));
    offset += arrayBytes;
  }

  return {
    nx, ny, lo1, la1, dx, dy, arrays,
    interpolate(lon, lat) {
      let fi = (lon - this.lo1) / this.dx;
      const fj = (this.la1 - lat) / this.dy;
      while (fi < 0) fi += this.nx;
      while (fi >= this.nx) fi -= this.nx;
      if (fj < 0 || fj >= this.ny - 1) return null;
      const i0 = Math.floor(fi), j0 = Math.floor(fj);
      const fx = fi - i0, fy = fj - j0;
      const i1 = (i0 + 1) % this.nx;
      const j1 = Math.min(j0 + 1, this.ny - 1);
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy, w11 = fx * fy;
      const i00 = j0 * this.nx + i0, i10 = j0 * this.nx + i1;
      const i01 = j1 * this.nx + i0, i11 = j1 * this.nx + i1;
      const out = [];
      for (const a of this.arrays) {
        out.push(w00 * a[i00] + w10 * a[i10] + w01 * a[i01] + w11 * a[i11]);
      }
      return out;
    },
  };
}
```

- [ ] **Step 2: Smoke test against a known-good local grid**

Run (assumes `data/gfs/20260409_00z/swell_f000.bin` exists from prior app usage):

```bash
node --input-type=module -e "
import { loadGridFromFile } from './data/scripts/lib/grid-loader.js';
import fs from 'node:fs';
import path from 'node:path';
const runs = fs.readdirSync('data/gfs').filter(x => !x.startsWith('.'));
const run = runs.sort().pop();
const g = loadGridFromFile(path.join('data/gfs', run, 'swell_f000.bin'));
console.log('grid', g.nx, 'x', g.ny, 'lo1', g.lo1, 'la1', g.la1);
// North Atlantic sample
console.log('at 40N,-50W:', g.interpolate(-50, 40));
"
```

Expected output: grid dimensions printed, and a 3-element array `[height, direction, period]` with height > 0 (it's open ocean).

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/data/scripts/lib/grid-loader.js
git commit -m "feat(pumping): Node-side .bin grid loader"
```

---

### Task 8: offshore.js — compute `offshoreDeg` per point (TDD)

**Files:**
- Create: `surf_app_V3/data/scripts/lib/offshore.js`
- Create: `surf_app_V3/data/scripts/test/offshore.test.js`

- [ ] **Step 1: Write failing test using a real grid**

File: `surf_app_V3/data/scripts/test/offshore.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeOffshoreDeg } from '../lib/offshore.js';
import { loadGridFromFile } from '../lib/grid-loader.js';

function latestSwellGrid() {
  const dir = 'data/gfs';
  if (!fs.existsSync(dir)) return null;
  const runs = fs.readdirSync(dir).filter(x => !x.startsWith('.')).sort();
  if (!runs.length) return null;
  const file = path.join(dir, runs[runs.length - 1], 'swell_f000.bin');
  return fs.existsSync(file) ? loadGridFromFile(file) : null;
}

test('computeOffshoreDeg: Pipeline (North Shore Oahu) faces roughly NNE', { skip: !latestSwellGrid() }, () => {
  const g = latestSwellGrid();
  const deg = computeOffshoreDeg(g, 21.66, -158.05);
  // Coast runs WNW-ESE, offshore (land-ward from sea) should be roughly SSW (~180-210)
  // Actually Pipeline faces north ocean → offshore (land→ocean is N, offshore wind blows land→sea = from S = ~180°)
  // detectCoastFromGrid returns offshoreDir = (seaward+180). For a north-facing coast seaward=0, offshore=180.
  assert.ok(deg !== null, 'expected a value');
  assert.ok(deg > 120 && deg < 240, `Pipeline offshore ~180°, got ${deg}`);
});

test('computeOffshoreDeg: point in open ocean (no land nearby) returns null', { skip: !latestSwellGrid() }, () => {
  const g = latestSwellGrid();
  // 40N, -40W is deep North Atlantic
  const deg = computeOffshoreDeg(g, 40, -40);
  assert.equal(deg, null);
});
```

- [ ] **Step 2: Run — expected to fail**

```bash
npm run test:build
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `computeOffshoreDeg`**

File: `surf_app_V3/data/scripts/lib/offshore.js`

This mirrors `detectCoastFromGrid` from `public/js/forecast.js`, but returns just `offshoreDir`.

```javascript
const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/**
 * Sample swell height in a ring around (lat, lon). Directions with swell>0
 * are ocean; the mean ocean-bearing is the "seaward" direction; offshore is
 * 180° opposite (onshore wind "from" direction).
 *
 * @param {Grid} swellGrid — result of loadGridFromFile; must have 3 params [h, d, p]
 * @returns {number|null} offshore direction in degrees [0..360), or null if no coast detected
 */
export function computeOffshoreDeg(swellGrid, lat, lon) {
  const numSamples = 24;
  const offsets = [0.15, 0.25, 0.4]; // degrees
  const oceanDirs = [];

  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * 360;
    let hasWater = false;
    for (const dist of offsets) {
      const testLat = lat + dist * Math.cos(angle * TO_RAD);
      const testLon = lon + dist * Math.sin(angle * TO_RAD);
      const vals = swellGrid.interpolate(testLon, testLat);
      if (vals && vals[0] > 0.05) { hasWater = true; break; }
    }
    if (hasWater) oceanDirs.push(angle);
  }

  if (oceanDirs.length === 0 || oceanDirs.length === numSamples) return null;

  let sinSum = 0, cosSum = 0;
  for (const d of oceanDirs) {
    sinSum += Math.sin(d * TO_RAD);
    cosSum += Math.cos(d * TO_RAD);
  }
  const seawardDir = (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
  return (seawardDir + 180) % 360;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npm run test:build
```

Expected: 2 passing (or skipped if no grid available).

- [ ] **Step 5: Commit**

```bash
git add surf_app_V3/data/scripts/lib/offshore.js surf_app_V3/data/scripts/test/offshore.test.js
git commit -m "feat(pumping): compute offshoreDeg per point"
```

---

### Task 9: build-coast-points.js — main orchestration script

**Files:**
- Create: `surf_app_V3/data/scripts/build-coast-points.js`

- [ ] **Step 1: Write the build script**

File: `surf_app_V3/data/scripts/build-coast-points.js`

```javascript
#!/usr/bin/env node
/**
 * build-coast-points.js
 *
 * Walks the Natural Earth 10m coastline at 10km spacing, tags each point with
 * country (point-in-polygon) + nearest town (GeoNames), computes offshoreDeg
 * from the latest local GFS swell grid, and writes the result to
 * public/data/coast-points.json.
 *
 * Run:  npm run build:coast-points
 */

import fs from 'node:fs';
import path from 'node:path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint } from '@turf/helpers';

import { walkLineString } from './lib/coastline-walker.js';
import { loadCoastline, loadCountries, loadCities, buildCityIndex, nearestCity } from './lib/reference-data.js';
import { loadGridFromFile } from './lib/grid-loader.js';
import { computeOffshoreDeg } from './lib/offshore.js';

const STEP_KM = 10;
const TOWN_MAX_KM = 200;
const OUTPUT = 'public/data/coast-points.json';

function findLatestSwellGrid() {
  const dir = 'data/gfs';
  if (!fs.existsSync(dir)) {
    throw new Error(`${dir} not found — download a GFS run first (npm run download:gfs && npm run process).`);
  }
  const runs = fs.readdirSync(dir).filter(x => !x.startsWith('.')).sort();
  if (!runs.length) throw new Error('No GFS runs in data/gfs/');
  const runDir = path.join(dir, runs[runs.length - 1]);
  const file = path.join(runDir, 'swell_f000.bin');
  if (!fs.existsSync(file)) throw new Error(`${file} not found — run process-grib.py`);
  console.log(`Using swell grid: ${file}`);
  return loadGridFromFile(file);
}

function countryAt(countriesGj, lat, lon) {
  const pt = turfPoint([lon, lat]);
  for (const feat of countriesGj.features) {
    if (booleanPointInPolygon(pt, feat)) {
      return feat.properties.NAME || feat.properties.ADMIN || null;
    }
  }
  return null;
}

async function main() {
  console.log('━━━ build-coast-points ━━━\n');
  console.log('Loading reference data...');
  const coastline = loadCoastline();
  const countries = loadCountries();
  const cities = loadCities();
  const { index } = buildCityIndex(cities);
  const swellGrid = findLatestSwellGrid();
  console.log(`  coastline: ${coastline.features.length} features`);
  console.log(`  countries: ${countries.features.length} features`);
  console.log(`  cities:    ${cities.length}\n`);

  const candidates = [];
  for (const feat of coastline.features) {
    const geom = feat.geometry;
    if (geom.type === 'LineString') {
      for (const pt of walkLineString(geom.coordinates, STEP_KM)) candidates.push(pt);
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        for (const pt of walkLineString(line, STEP_KM)) candidates.push(pt);
      }
    }
  }
  console.log(`Walked coastline → ${candidates.length} candidates at ${STEP_KM}km spacing`);

  const results = [];
  let kept = 0, drop_noOcean = 0, drop_noOffshore = 0;
  const t0 = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    if (i % 1000 === 0) {
      const pct = ((i / candidates.length) * 100).toFixed(1);
      process.stdout.write(`\r  scoring ${i}/${candidates.length} (${pct}%) — kept ${kept}`);
    }
    const { lat, lon } = candidates[i];

    // Ocean filter: must have at least one swell sample nearby
    const offshore = computeOffshoreDeg(swellGrid, lat, lon);
    if (offshore === null) { drop_noOffshore++; continue; }

    const country = countryAt(countries, lat, lon) || 'International waters';
    const near = nearestCity(index, cities, lat, lon, TOWN_MAX_KM);

    const hemiNS = lat >= 0 ? 'N' : 'S';
    const hemiEW = lon >= 0 ? 'E' : 'W';
    const name = near
      ? `near ${near.name}, ${country}`
      : `coast ${Math.abs(lat).toFixed(1)}°${hemiNS} ${Math.abs(lon).toFixed(1)}°${hemiEW}, ${country}`;

    results.push({
      la: +lat.toFixed(3),
      ln: +lon.toFixed(3),
      n: name,
      c: country,
      o: Math.round(offshore),
    });
    kept++;
  }
  process.stdout.write('\n');

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${dt}s`);
  console.log(`  kept:            ${kept}`);
  console.log(`  dropped (ocean): ${drop_noOffshore}`);

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(results));
  const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
  console.log(`\n  wrote ${OUTPUT} (${kb} KB, ${results.length} points)`);
}

main().catch(err => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
cd surf_app_V3 && npm run build:coast-points
```

Expected output: `walked coastline → ~30000 candidates`, final `wrote public/data/coast-points.json (~500-900 KB, ~20000-25000 points)`.

- [ ] **Step 3: Spot-check output**

```bash
node --input-type=module -e "
const p = JSON.parse(require('fs').readFileSync('public/data/coast-points.json'));
console.log('total:', p.length);
console.log('Hawaii sample:', p.filter(x => Math.abs(x.la-21.5)<1 && Math.abs(x.ln+158)<1).slice(0,5));
console.log('Iceland sample:', p.filter(x => x.la>63 && x.la<66 && x.ln>-25 && x.ln<-13).length);
console.log('Maldives sample:', p.filter(x => x.la>-1 && x.la<8 && x.ln>72 && x.ln<74).length);
"
```

Expected: Hawaii shows named towns; Iceland count > 20; Maldives count > 5.

- [ ] **Step 4: Commit (output + script)**

```bash
git add surf_app_V3/data/scripts/build-coast-points.js surf_app_V3/public/data/coast-points.json
git commit -m "feat(pumping): build-coast-points script + initial output"
```

---

## Phase 2 — named spots

### Task 10: Assemble expanded named-spots.json

**Files:**
- Create: `surf_app_V3/public/data/named-spots.json`

This is a content task. Start from V1's `G` array (copy verbatim) and add spots covering the gaps listed in the spec. Each entry needs `offshoreDeg` left as `null` — Task 11 populates it.

- [ ] **Step 1: Extract V1 spots as the seed**

```bash
node --input-type=module -e "
import fs from 'node:fs';
const src = fs.readFileSync('../surf_app_V1/public/js/spots.js', 'utf8');
// Extract the G=[...] array
const m = src.match(/const G=(\[[\s\S]*?^\]);/m);
const arr = eval(m[1]);
const out = arr.map(s => ({ n: s.n, r: s.r, la: s.la, ln: s.ln, o: null }));
fs.writeFileSync('public/data/named-spots.json', JSON.stringify(out, null, 2));
console.log('seeded', out.length, 'spots');
"
```

Expected: `seeded ~130 spots`.

- [ ] **Step 2: Append additional spots (hand-curated)**

Append entries to the JSON array. Aim for 500+ total. Fill gaps from the spec: PNW/AK, Nicaragua, UK south/Wales, Iceland/Faroes, West Africa, Mozambique/Madagascar, Philippines/Taiwan/Korea, Kamchatka, Polynesia outer islands (Samoa, Tonga, Vanuatu, New Caledonia, Cook Islands), Uruguay/Ecuador, Sumba/Flores, more Maldives/Mentawai.

Work through the file in sections (edit `public/data/named-spots.json`). Each new entry follows the same shape:

```json
{"n": "Rockaway Point", "r": "New York, US", "la": 40.55, "ln": -73.89, "o": null}
```

Target breakdown:
- North America: add ~40 (Alaska coast, Oregon dunes, Nicaragua, Panama breaks)
- Europe: add ~30 (UK south coast, Wales, Iceland Reykjanes, Faroe Islands)
- Africa: add ~20 (Liberia, Ghana, Angola, Mozambique, Madagascar, Seychelles)
- Asia/Pacific: add ~50 (Taiwan, Korea, Kamchatka, Philippines spots, Samoa, Tonga, Vanuatu, New Caledonia, Cook Islands)
- Oceania: add ~20 (more of Margaret River coast, Eyre Peninsula, NZ west coast south)
- South America: add ~15 (Uruguay, Ecuador, more Brazil)
- Additional Indonesia: add ~20 (Sumba, Flores, Timor, more Mentawai/Maldives atolls)

Resource check against a cross-reference (magicseaweed, stormrider guide, Wikipedia's "list of surfing destinations") before committing. Goal: known surf breaks, not random beaches.

- [ ] **Step 3: Sanity checks**

```bash
node --input-type=module -e "
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync('public/data/named-spots.json'));
console.log('total:', s.length);
console.log('missing la/ln:', s.filter(x => x.la == null || x.ln == null).length);
console.log('duplicate names:', s.length - new Set(s.map(x => x.n)).size);
// Check lat/lon bounds
const bad = s.filter(x => x.la < -90 || x.la > 90 || x.ln < -180 || x.ln > 180);
console.log('bad coords:', bad.length);
"
```

Expected: total ≥ 500, 0 missing, 0 bad coords, duplicate count near 0 (a few name collisions like "Pipeline" vs "Banzai Pipeline" are OK).

- [ ] **Step 4: Commit**

```bash
git add surf_app_V3/public/data/named-spots.json
git commit -m "feat(pumping): expanded named-spots.json (500+ curated)"
```

---

### Task 11: Populate `offshoreDeg` for named spots

**Files:**
- Create: `surf_app_V3/data/scripts/fill-named-offshore.js`
- Modify: `surf_app_V3/public/data/named-spots.json` (output overwrite)
- Modify: `surf_app_V3/package.json`

- [ ] **Step 1: Write the fill script**

File: `surf_app_V3/data/scripts/fill-named-offshore.js`

```javascript
#!/usr/bin/env node
/**
 * fill-named-offshore.js — Computes offshoreDeg for each named spot using the
 * latest local GFS swell grid, and rewrites public/data/named-spots.json in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadGridFromFile } from './lib/grid-loader.js';
import { computeOffshoreDeg } from './lib/offshore.js';

function latestSwellGrid() {
  const dir = 'data/gfs';
  const runs = fs.readdirSync(dir).filter(x => !x.startsWith('.')).sort();
  const file = path.join(dir, runs[runs.length - 1], 'swell_f000.bin');
  return loadGridFromFile(file);
}

const grid = latestSwellGrid();
const file = 'public/data/named-spots.json';
const spots = JSON.parse(fs.readFileSync(file, 'utf8'));

let filled = 0, skipped = 0;
for (const s of spots) {
  const o = computeOffshoreDeg(grid, s.la, s.ln);
  if (o === null) skipped++;
  else { s.o = Math.round(o); filled++; }
}

fs.writeFileSync(file, JSON.stringify(spots, null, 2));
console.log(`filled ${filled}, skipped ${skipped}, of ${spots.length}`);
```

- [ ] **Step 2: Add npm script**

Modify `surf_app_V3/package.json` `"scripts"`:

```json
"fill:named-offshore": "node data/scripts/fill-named-offshore.js",
```

- [ ] **Step 3: Run it**

```bash
cd surf_app_V3 && npm run fill:named-offshore
```

Expected: `filled ~500, skipped <20, of 500+`. Spots inland of narrow peninsulas (rare) may skip — that's OK.

- [ ] **Step 4: Inspect a few filled values**

```bash
node --input-type=module -e "
const s = JSON.parse(require('fs').readFileSync('public/data/named-spots.json'));
console.log('Pipeline:', s.find(x => x.n === 'Pipeline'));
console.log('Rincon:', s.find(x => x.n === 'Rincon'));
console.log('J-Bay:', s.find(x => x.n.includes('Jeffreys')));
"
```

Expected: `o` fields populated with integers in [0,360). Pipeline ~180, Rincon ~0-30.

- [ ] **Step 5: Commit**

```bash
git add surf_app_V3/data/scripts/fill-named-offshore.js surf_app_V3/package.json surf_app_V3/public/data/named-spots.json
git commit -m "feat(pumping): populate offshoreDeg for named spots"
```

---

## Phase 3 — runtime ranking module

### Task 12: pumping.js — data loader + core ranker (TDD)

**Files:**
- Create: `surf_app_V3/public/js/pumping.js`
- Create: `surf_app_V3/public/js/test/pumping.test.js`

- [ ] **Step 1: Write failing tests**

File: `surf_app_V3/public/js/test/pumping.test.js`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankNow } from '../pumping.js';

// Minimal fakes matching the shape of Grid + ratings
function fakeWindGrid(u, v) {
  return { interpolate: () => [u, v] };
}
function fakeSwellGrid(h, d, p) {
  return { interpolate: () => [h, d, p], arrays: [[h], [d], [p]] };
}

const SPOTS = [
  { n: 'Epic', la: 0, ln: 0, o: 180 },
  { n: 'Flat', la: 1, ln: 1, o: 180 },
];

test('rankNow returns results sorted descending by overall score', () => {
  // Mock interpolate per-spot by inspecting la
  const wind = {
    interpolate: (lon, lat) => lat < 0.5 ? [0, 2] : [5, 5], // Epic: light; Flat: gale
  };
  const swell = {
    interpolate: (lon, lat) => lat < 0.5 ? [3, 180, 14] : [0.2, 180, 4],
  };
  // Mock interpolateAngle via passing swellDir via the grid array
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
```

- [ ] **Step 2: Run — expected to fail**

```bash
cd surf_app_V3 && node --test public/js/test/pumping.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement loader + ranker (no UI yet)**

File: `surf_app_V3/public/js/pumping.js`

```javascript
/**
 * pumping.js — "Where it's pumping" top-100 ranking + panel.
 *
 * Entry points used by other modules:
 *   initPumping(app)           — called once from app.js, wires the button
 *   openPumpingPanel()         — slides panel in
 *   rankNow(spots, wind, swell) — pure fn, exported for tests
 *   rankPeak(spots, loadHour, hoursRange) — pure fn, exported
 */

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/** Angular bilinear interpolation of a direction field via sin/cos sums. */
function interpolateSwellDir(grid, lon, lat) {
  let fi = (lon - grid.lo1) / grid.dx;
  const fj = (grid.la1 - lat) / grid.dy;
  while (fi < 0) fi += grid.nx;
  while (fi >= grid.nx) fi -= grid.nx;
  if (fj < 0 || fj >= grid.ny - 1) return 0;
  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const fx = fi - i0, fy = fj - j0;
  const i1 = (i0 + 1) % grid.nx;
  const j1 = Math.min(j0 + 1, grid.ny - 1);
  const a = grid.arrays[1];
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;
  const i00 = j0 * grid.nx + i0, i10 = j0 * grid.nx + i1;
  const i01 = j1 * grid.nx + i0, i11 = j1 * grid.nx + i1;
  const sinSum = w00 * Math.sin(a[i00] * TO_RAD) + w10 * Math.sin(a[i10] * TO_RAD)
               + w01 * Math.sin(a[i01] * TO_RAD) + w11 * Math.sin(a[i11] * TO_RAD);
  const cosSum = w00 * Math.cos(a[i00] * TO_RAD) + w10 * Math.cos(a[i10] * TO_RAD)
               + w01 * Math.cos(a[i01] * TO_RAD) + w11 * Math.cos(a[i11] * TO_RAD);
  return (Math.atan2(sinSum, cosSum) * TO_DEG + 360) % 360;
}

// Mirrors ratings.js sD/wD/oD. Kept inline so this module has no circular imports
// with ratings.js (which is currently non-module). When ratings.js is converted
// to ESM this can be replaced with imports.
function scoreSwell(h_ft, p, swDir, optimalDir) {
  let s = 0;
  if (h_ft >= 8) s += 4; else if (h_ft >= 5) s += 3; else if (h_ft >= 3) s += 2.2;
  else if (h_ft >= 2) s += 1.5; else if (h_ft >= 1) s += 0.7;
  if (p >= 14) s += 3; else if (p >= 11) s += 2.2; else if (p >= 9) s += 1.5;
  else if (p >= 7) s += 0.8; else s += 0.3;
  const diff = Math.abs(((swDir - optimalDir + 540) % 360) - 180);
  if (diff <= 20) s += 3; else if (diff <= 40) s += 2.2; else if (diff <= 60) s += 1.5;
  else if (diff <= 90) s += 0.8; else s += 0.2;
  return s;
}

function scoreWind(mph, windDir, offshoreDir) {
  const d = Math.abs(((windDir - offshoreDir + 540) % 360) - 180);
  const off = d <= 45, side = d > 45 && d < 135;
  if (mph < 3) return 10;
  if (off) return mph <= 10 ? 9 : mph <= 15 ? 7 : 5;
  if (side) return mph <= 6 ? 7 : mph <= 12 ? 4.5 : 3;
  return mph <= 5 ? 4 : mph <= 10 ? 2.5 : mph <= 18 ? 1.5 : 0.5;
}

function scoreSpot(spot, windGrid, swellGrid) {
  if (spot.o == null) return null;
  const w = windGrid?.interpolate?.(spot.ln, spot.la);
  const s = swellGrid?.interpolate?.(spot.ln, spot.la);
  if (!w || !s) return null;

  const u = w[0], v = w[1];
  const windMs = Math.sqrt(u * u + v * v);
  const windMph = windMs * 2.23694;
  const windDir = (Math.atan2(-u, -v) * TO_DEG + 360) % 360;

  const swHeightM = s[0];
  const swHeightFt = swHeightM * 3.28084;
  const swPeriod = s[2];
  const swDir = swellGrid.arrays ? interpolateSwellDir(swellGrid, spot.ln, spot.la) : s[1];

  // Optimal swell direction ≈ 180° opposite of offshore (waves come from sea)
  const optimalSwell = (spot.o + 180) % 360;
  const sw = scoreSwell(swHeightFt, swPeriod, swDir, optimalSwell);
  const wi = scoreWind(windMph, windDir, spot.o);
  const overall = sw * 0.6 + wi * 0.4;
  return { overall, swHeightFt, swPeriod, swDir, windMph, windDir };
}

export function rankNow(spots, windGrid, swellGrid) {
  const scored = [];
  for (const spot of spots) {
    const m = scoreSpot(spot, windGrid, swellGrid);
    if (m) scored.push({ spot, score: m.overall, metrics: m });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 100);
}

/**
 * Rank by peak score over a forecast-hour range.
 * @param {Array} spots
 * @param {(h:number)=>Promise<{wind:Grid, swell:Grid}>} loadHour
 * @param {number[]} hoursRange — e.g. [0,3,6,...,168] for "this week"
 * @returns {Promise<Array<{spot, score, peakHour, metrics}>>} top 100
 */
export async function rankPeak(spots, loadHour, hoursRange) {
  const peaks = new Map();

  for (const h of hoursRange) {
    const { wind, swell } = await loadHour(h);
    if (!wind || !swell) continue;
    for (const spot of spots) {
      const m = scoreSpot(spot, wind, swell);
      if (!m) continue;
      const prev = peaks.get(spot);
      if (!prev || m.overall > prev.score) {
        peaks.set(spot, { spot, score: m.overall, peakHour: h, metrics: m });
      }
    }
  }

  return Array.from(peaks.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --test public/js/test/pumping.test.js
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add surf_app_V3/public/js/pumping.js surf_app_V3/public/js/test/pumping.test.js
git commit -m "feat(pumping): core ranker (rankNow + rankPeak)"
```

---

### Task 13: pumping.js — data loader + cache

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Append loader + cache to pumping.js**

Add at the top of `public/js/pumping.js` (after imports):

```javascript
let _spotsPromise = null;
let _appRef = null;

/** Called once at app boot. */
export function initPumping(app) {
  _appRef = app;
  const btn = document.getElementById('pumping-btn');
  if (btn) btn.addEventListener('click', () => openPumpingPanel());
}

function loadSpotsOnce() {
  if (_spotsPromise) return _spotsPromise;
  _spotsPromise = Promise.all([
    fetch('data/named-spots.json').then(r => r.json()),
    fetch('data/coast-points.json').then(r => r.json()),
  ]).then(([named, coast]) => {
    // Named spots already have n,r,la,ln,o. Coast points have la,ln,n,c,o.
    // Normalize shape: every spot has {n, r?, la, ln, o}.
    const normalizedCoast = coast.map(c => ({ n: c.n, r: c.c, la: c.la, ln: c.ln, o: c.o }));
    return [...named, ...normalizedCoast];
  });
  return _spotsPromise;
}

// Invalidate peak caches when model / run changes.
const _peakCache = new Map(); // key: `${model}|${run}|${rangeKey}` → results
export function invalidatePumpingCache() { _peakCache.clear(); }
```

- [ ] **Step 2: Smoke test in browser**

Start dev server: `cd surf_app_V3 && npm start`, open `http://localhost:3000`, open devtools console.

Run:

```javascript
const mod = await import('./js/pumping.js');
const spots = await mod['default']?.loadSpotsOnce?.() || (await fetch('data/named-spots.json').then(r=>r.json()));
console.log('named:', spots.length);
```

Note: `loadSpotsOnce` is not exported — this is a smoke check of data fetchability only. Expected: both JSON files return arrays.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): data loader + peak cache"
```

---

## Phase 4 — UI

### Task 14: Add top-bar button + panel root

**Files:**
- Modify: `surf_app_V3/public/index.html`

- [ ] **Step 1: Add button to controls**

Open `public/index.html`. Find the `.controls-group` div. Add after the layer selector `</div>`:

```html
      <div class="divider"></div>

      <button class="ctrl-btn" id="pumping-btn" title="Global top 100">where it's pumping</button>
```

- [ ] **Step 2: Add panel root (before closing `</body>`)**

```html
  <!-- Where it's pumping panel -->
  <div id="pumping-panel" class="pumping-panel" aria-hidden="true">
    <div class="pumping-header">
      <h2 class="pumping-title">where it's pumping</h2>
      <button class="pumping-close" id="pumping-close" aria-label="Close">×</button>
    </div>
    <div class="pumping-tabs" role="tablist">
      <button class="pumping-tab active" data-mode="now">right now</button>
      <button class="pumping-tab" data-mode="week">score this week</button>
      <button class="pumping-tab" data-mode="next">score next week</button>
    </div>
    <div class="pumping-status" id="pumping-status">Loading...</div>
    <div class="pumping-list" id="pumping-list"></div>
  </div>
  <div id="pumping-backdrop" class="pumping-backdrop" aria-hidden="true"></div>
```

- [ ] **Step 3: Manually verify**

Reload the page. A new "where it's pumping" button appears in the top bar. The panel root exists in DOM but is hidden by default (until CSS added).

- [ ] **Step 4: Commit**

```bash
git add surf_app_V3/public/index.html
git commit -m "feat(pumping): add top-bar button + panel root"
```

---

### Task 15: Panel CSS — slideout + tabs + row layout

**Files:**
- Modify: `surf_app_V3/public/css/style.css`

- [ ] **Step 1: Append panel styles**

At the end of `public/css/style.css`:

```css
/* ── Where it's pumping ── */
.pumping-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35);
  opacity: 0; pointer-events: none; transition: opacity 180ms ease;
  z-index: 50;
}
.pumping-backdrop.visible { opacity: 1; pointer-events: auto; }

.pumping-panel {
  position: fixed; top: 0; right: 0; height: 100vh; width: 380px;
  max-width: 95vw; background: var(--surface-solid);
  border-left: 1px solid var(--border);
  display: flex; flex-direction: column;
  transform: translateX(100%); transition: transform 220ms ease;
  z-index: 60; box-shadow: -12px 0 32px rgba(0, 0, 0, 0.5);
}
.pumping-panel.visible { transform: translateX(0); }

.pumping-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--border);
}
.pumping-title { font-size: 14px; font-weight: 600; color: var(--text); }
.pumping-close {
  background: none; border: none; color: var(--text-muted);
  font-size: 22px; cursor: pointer; line-height: 1; padding: 4px 8px;
}
.pumping-close:hover { color: var(--text); }

.pumping-tabs {
  display: flex; padding: 8px; gap: 4px; border-bottom: 1px solid var(--border);
}
.pumping-tab {
  flex: 1; padding: 6px 8px; font-size: 11px; font-weight: 500;
  background: transparent; color: var(--text-muted);
  border: 1px solid var(--border); border-radius: var(--radius);
  cursor: pointer; transition: all 120ms ease;
}
.pumping-tab:hover { color: var(--text); }
.pumping-tab.active {
  background: var(--accent-dim); color: var(--accent);
  border-color: var(--accent);
}

.pumping-status {
  padding: 12px 16px; font-size: 12px; color: var(--text-muted);
  text-align: center;
}

.pumping-list { flex: 1; overflow-y: auto; }
.pumping-row {
  display: grid;
  grid-template-columns: 28px 12px 1fr auto auto;
  column-gap: 10px; row-gap: 2px;
  align-items: center; padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  cursor: pointer; transition: background 120ms ease;
  font-size: 12px;
}
.pumping-row:hover { background: rgba(56, 189, 248, 0.08); }

.pumping-rank {
  font-size: 11px; font-weight: 700; color: var(--text-muted);
  text-align: center;
}
.pumping-rank.gold { color: #fbbf24; }

.pumping-dot {
  width: 10px; height: 10px; border-radius: 50%;
}

.pumping-spot {
  font-weight: 500; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pumping-region {
  grid-column: 3 / 4; font-size: 10px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pumping-swell, .pumping-wind {
  font-size: 11px; color: var(--text-muted); text-align: right;
  white-space: nowrap;
}
.pumping-when {
  grid-column: 4 / 6; text-align: right; margin-top: 2px;
  font-size: 10px; color: var(--accent);
}
```

- [ ] **Step 2: Manually verify**

Reload the page. Click the button — nothing happens yet (no JS wire-up). Manually toggle via devtools:

```javascript
document.getElementById('pumping-panel').classList.add('visible');
document.getElementById('pumping-backdrop').classList.add('visible');
```

Expect: panel slides in from the right, backdrop dims the map, tabs render correctly.

Remove the classes to hide again.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/css/style.css
git commit -m "feat(pumping): panel styles"
```

---

### Task 16: Wire open/close + tab switching

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Add panel control functions**

Append to `public/js/pumping.js`:

```javascript
let _currentMode = 'now';

export function openPumpingPanel() {
  const panel = document.getElementById('pumping-panel');
  const backdrop = document.getElementById('pumping-backdrop');
  if (!panel) return;
  panel.classList.add('visible');
  backdrop.classList.add('visible');
  panel.setAttribute('aria-hidden', 'false');
  renderCurrentMode();
}

export function closePumpingPanel() {
  const panel = document.getElementById('pumping-panel');
  const backdrop = document.getElementById('pumping-backdrop');
  if (!panel) return;
  panel.classList.remove('visible');
  backdrop.classList.remove('visible');
  panel.setAttribute('aria-hidden', 'true');
}

function setMode(mode) {
  _currentMode = mode;
  document.querySelectorAll('.pumping-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  renderCurrentMode();
}

function renderCurrentMode() {
  // placeholder — filled in Task 17
  const status = document.getElementById('pumping-status');
  if (status) status.textContent = `mode: ${_currentMode} (not yet rendering)`;
}

// Wire listeners in initPumping — replace the existing function:
export function initPumping(app) {
  _appRef = app;
  document.getElementById('pumping-btn')?.addEventListener('click', openPumpingPanel);
  document.getElementById('pumping-close')?.addEventListener('click', closePumpingPanel);
  document.getElementById('pumping-backdrop')?.addEventListener('click', closePumpingPanel);
  document.querySelectorAll('.pumping-tab').forEach(t => {
    t.addEventListener('click', () => setMode(t.dataset.mode));
  });
}
```

Note: remove the earlier stub `initPumping` definition from Task 13 and keep only this one.

- [ ] **Step 2: Wire into app.js**

Edit `surf_app_V3/public/js/app.js`. Add to imports:

```javascript
import { initPumping } from './pumping.js';
```

Inside the `this.map.on('load', async () => { ... })` block, after `initPanel();`:

```javascript
      initPumping(this);
```

- [ ] **Step 3: Manually verify**

Reload, click the button. Panel slides in. Click each tab → status text updates. Click × / backdrop → panel closes.

- [ ] **Step 4: Commit**

```bash
git add surf_app_V3/public/js/pumping.js surf_app_V3/public/js/app.js
git commit -m "feat(pumping): wire open/close + tab switching"
```

---

### Task 17: Render "right now" rows

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Replace `renderCurrentMode` with real rendering**

Replace the stub in `public/js/pumping.js`:

```javascript
// Rating palette (matches project colorblind palette: gray/amber/gold/teal/blue/purple)
const RATING_COLORS = {
  flat:     '#64748b', // gray
  poor:     '#f59e0b', // amber
  marginal: '#eab308', // gold
  fair:     '#14b8a6', // teal
  good:     '#38bdf8', // blue
  epic:     '#a855f7', // purple
};

function ratingColor(score) {
  if (score >= 8) return RATING_COLORS.epic;
  if (score >= 6.5) return RATING_COLORS.good;
  if (score >= 4.5) return RATING_COLORS.fair;
  if (score >= 2.5) return RATING_COLORS.marginal;
  if (score >= 1) return RATING_COLORS.poor;
  return RATING_COLORS.flat;
}

function compassLabel(deg) {
  const labels = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return labels[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function rowHtml(entry, rank) {
  const { spot, score, metrics, peakHour } = entry;
  const goldClass = rank <= 3 ? 'gold' : '';
  const color = ratingColor(score);
  const whenHtml = peakHour != null ? `<div class="pumping-when">${formatHourLabel(peakHour)}</div>` : '';
  const region = spot.r ? spot.r : '';

  return `
    <div class="pumping-row" data-la="${spot.la}" data-ln="${spot.ln}" data-peak="${peakHour ?? ''}">
      <div class="pumping-rank ${goldClass}">#${rank}</div>
      <div class="pumping-dot" style="background:${color}"></div>
      <div>
        <div class="pumping-spot">${escapeHtml(spot.n)}</div>
        <div class="pumping-region">${escapeHtml(region)}</div>
      </div>
      <div class="pumping-swell">↑ ${metrics.swHeightFt.toFixed(1)}ft @ ${metrics.swPeriod.toFixed(0)}s</div>
      <div class="pumping-wind">← ${metrics.windMph.toFixed(0)}mph ${compassLabel(metrics.windDir)}</div>
      ${whenHtml}
    </div>`;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function formatHourLabel(fhr) {
  if (!_appRef?.runTime) return `+${fhr}h`;
  const d = new Date(_appRef.runTime.getTime() + fhr * 3600 * 1000);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const hr = d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase();
  return `${day} ${hr}`;
}

async function renderCurrentMode() {
  const status = document.getElementById('pumping-status');
  const list = document.getElementById('pumping-list');
  if (!status || !list) return;

  status.textContent = 'Loading spots...';
  list.innerHTML = '';

  const spots = await loadSpotsOnce();
  status.textContent = `${spots.length} spots — computing...`;

  if (_currentMode === 'now') {
    const { windGrid, swellGrid } = _appRef;
    if (!windGrid || !swellGrid) {
      status.textContent = 'Forecast data not yet loaded';
      return;
    }
    // rankNow is defined at module top-level (Task 12) — call it directly.
    const ranked = rankNow(spots, windGrid, swellGrid);
    status.textContent = `Top ${ranked.length} — right now`;
    list.innerHTML = ranked.map((e, i) => rowHtml(e, i + 1)).join('');
    wireRowClicks(list);
  } else {
    status.textContent = `(${_currentMode} mode not yet implemented)`;
  }
}

function wireRowClicks(list) {
  list.querySelectorAll('.pumping-row').forEach(row => {
    row.addEventListener('click', () => {
      const la = parseFloat(row.dataset.la);
      const ln = parseFloat(row.dataset.ln);
      const peak = row.dataset.peak ? parseInt(row.dataset.peak, 10) : null;
      onRowClick(la, ln, peak);
    });
  });
}

function onRowClick(la, ln, peakHour) {
  closePumpingPanel();
  if (_appRef?.map) _appRef.map.flyTo({ center: [ln, la], zoom: 10, speed: 1.5 });
  if (peakHour != null && _appRef?.setHour) _appRef.setHour(peakHour);
  // Open surf-rating panel (existing)
  if (typeof window.openPanel === 'function') {
    // openPanel signature in panel.js — adapt as needed when wiring
    window.openPanel(la, ln, null, _appRef.dataPath, _appRef.runTime, peakHour ?? _appRef.hour, null);
  }
}
```

Remove the stub `renderCurrentMode` that was in Task 16. (Replace the whole function body with the one above.)

- [ ] **Step 2: Manually verify**

Reload. Click "where it's pumping" — button flies map around, panel slides in, ranked list appears showing 100 rows with numbers, dots, names, swell/wind readouts.

Click one row — panel closes, map flies to that spot, surf-rating panel opens.

If the rating panel integration throws, replace the `window.openPanel(...)` call with a simple `console.log('row clicked', la, ln)` and proceed; wire rating-panel integration in Task 19.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): render 'right now' ranked list"
```

---

### Task 18: Timeline-scrub live re-rank for "right now"

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`
- Modify: `surf_app_V3/public/js/app.js`

- [ ] **Step 1: Add debounce + re-render hook**

Append to `public/js/pumping.js`:

```javascript
let _rerankTimer = null;

export function onHourChanged() {
  if (_currentMode !== 'now') return;
  const panel = document.getElementById('pumping-panel');
  if (!panel?.classList.contains('visible')) return;
  clearTimeout(_rerankTimer);
  _rerankTimer = setTimeout(renderCurrentMode, 150);
}
```

- [ ] **Step 2: Call it when the hour changes**

Edit `public/js/app.js` — modify `setHour` and `setHourAsync`:

Add `import { onHourChanged } from './pumping.js';` to the imports.

In `setHour`:

```javascript
  setHour(hour) {
    this.hour = hour;
    this._loadHour(hour);
    if (isPanelOpen()) syncPanelHour(hour);
    onHourChanged();
  }
```

Same addition in `setHourAsync`.

- [ ] **Step 3: Manually verify**

Reload, open panel, scrub the timeline. Rankings update smoothly within ~150ms of scrub stopping. No flicker while dragging.

- [ ] **Step 4: Commit**

```bash
git add surf_app_V3/public/js/pumping.js surf_app_V3/public/js/app.js
git commit -m "feat(pumping): live re-rank on timeline scrub"
```

---

### Task 19: Row-click → fly + open surf-rating panel

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Replace the placeholder `onRowClick`**

Read the existing `panel.js` signature to get the correct call. From `app.js:258-260`:

```javascript
await openPanel(lat, lng, coast, this.dataPath, this.runTime, this.hour, geocodePromise);
```

Update `onRowClick` in `public/js/pumping.js` to match. Import `openPanel`, `findNearestCoast`, `reverseGeocode` at the top:

```javascript
import { openPanel } from './panel.js';
import { findNearestCoast, reverseGeocode } from './coastline.js';
```

Replace `onRowClick`:

```javascript
async function onRowClick(la, ln, peakHour) {
  closePumpingPanel();
  if (_appRef?.map) _appRef.map.flyTo({ center: [ln, la], zoom: 10, speed: 1.5 });

  // For peak modes, jump the timeline first so the opened panel reflects that hour
  if (peakHour != null && _appRef?.setHourAsync) {
    await _appRef.setHourAsync(peakHour);
  }

  const coast = findNearestCoast(la, ln);
  const geocodePromise = reverseGeocode(la, ln);
  await openPanel(la, ln, coast, _appRef.dataPath, _appRef.runTime, _appRef.hour, geocodePromise);
}
```

- [ ] **Step 2: Manually verify**

Open panel, click any row: map flies, surf rating panel opens with correct spot data. In "peak" modes (once built) the timeline should jump to that hour first.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): row click integrates with rating panel"
```

---

### Task 20: Implement "score this week" mode (peak over days 0-7)

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Add loadHour helper + wire "week" mode**

In `renderCurrentMode`, replace the `else` branch:

```javascript
  } else if (_currentMode === 'week') {
    await renderPeakMode('week');
  } else if (_currentMode === 'next') {
    await renderPeakMode('next');
  }
```

Add new functions:

```javascript
function hourRangeFor(mode) {
  if (mode === 'week') return Array.from({ length: 57 }, (_, i) => i * 3); // 0..168 step 3
  if (mode === 'next') {
    const arr = [];
    for (let h = 174; h <= 336; h += 6) arr.push(h); // 174..336 step 6
    return arr;
  }
  return [];
}

function cacheKey(mode) {
  const model = _appRef?.model || 'gfs';
  const run = _appRef?.runTime?.toISOString() || 'unknown';
  return `${model}|${run}|${mode}`;
}

async function renderPeakMode(mode) {
  const status = document.getElementById('pumping-status');
  const list = document.getElementById('pumping-list');

  const key = cacheKey(mode);
  if (_peakCache.has(key)) {
    const cached = _peakCache.get(key);
    list.innerHTML = cached.map((e, i) => rowHtml(e, i + 1)).join('');
    status.textContent = `Top ${cached.length} — peak in ${mode === 'week' ? 'next 7 days' : 'days 7-14 (GFS only)'}`;
    wireRowClicks(list);
    return;
  }

  const spots = await loadSpotsOnce();
  const hours = hourRangeFor(mode);

  const loadHour = async (h) => {
    const fhr = String(h).padStart(3, '0');
    const base = _appRef.dataPath;
    const [wind, swell] = await Promise.all([
      _appRef._cachedLoadGrid(`${base}/wind_f${fhr}.bin`),
      _appRef._cachedLoadGrid(`${base}/swell_f${fhr}.bin`),
    ]);
    return { wind, swell };
  };

  let done = 0;
  status.textContent = `Computing peak (${mode === 'week' ? '7-day' : '7-14 day'})... 0/${hours.length} hours`;
  const results = await rankPeakProgress(spots, loadHour, hours, (n) => {
    done = n;
    status.textContent = `Computing peak... ${done}/${hours.length} hours`;
  });
  _peakCache.set(key, results);

  list.innerHTML = results.map((e, i) => rowHtml(e, i + 1)).join('');
  status.textContent = `Top ${results.length} — peak in ${mode === 'week' ? 'next 7 days' : 'days 7-14 (GFS only)'}`;
  wireRowClicks(list);
}

// Wraps rankPeak with progress callbacks. Re-implements to allow per-hour progress.
async function rankPeakProgress(spots, loadHour, hours, onProgress) {
  const peaks = new Map();
  for (let i = 0; i < hours.length; i++) {
    const { wind, swell } = await loadHour(hours[i]);
    if (wind && swell) {
      for (const spot of spots) {
        const m = scoreSpot(spot, wind, swell);
        if (!m) continue;
        const prev = peaks.get(spot);
        if (!prev || m.overall > prev.score) {
          peaks.set(spot, { spot, score: m.overall, peakHour: hours[i], metrics: m });
        }
      }
    }
    onProgress(i + 1);
  }
  return Array.from(peaks.values()).sort((a, b) => b.score - a.score).slice(0, 100);
}
```

Note: `scoreSpot` is `const`/`function`-scoped in the module; ensure it's declared at the top level so `rankPeakProgress` can reach it. (It should already be, from Task 12.)

- [ ] **Step 2: Manually verify**

Reload. Click panel → "score this week" tab. Status text shows "Computing peak... N/57 hours", counting up. After ~1-2s list populates with top 100 + "when" badges (e.g. "Sat 9am"). Click a row → timeline jumps to peak hour, rating panel opens.

Switch to "right now" tab and back to "week" — second time is instant (cached).

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): score this week mode with peak computation"
```

---

### Task 21: "Score next week" mode + graceful handling of missing extended data

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Add missing-data handling**

The `loadHour` function already returns `{wind: null, swell: null}` for missing grids (the cached loader catches errors). `rankPeakProgress` already skips when grids are null.

Add an explicit "not available" state at the end of `renderPeakMode` — after the final results assignment:

```javascript
  if (results.length === 0) {
    status.textContent = mode === 'next'
      ? 'Extended forecast not available for this run. Refreshed daily.'
      : 'No data available for this range.';
    list.innerHTML = '';
    return;
  }
```

Also, when in `next` mode, force model to GFS regardless of user selection. Since the app caches `dataPath` per active model, we need a separate GFS path. Add at module scope:

```javascript
let _gfsPathPromise = null;
async function resolveGfsPath() {
  if (_gfsPathPromise) return _gfsPathPromise;
  _gfsPathPromise = (async () => {
    if (_appRef.model === 'gfs') return _appRef.dataPath;
    const cfg = window.SURF_CONFIG || {};
    const manifestUrl = cfg.MANIFEST_URL?.replace('manifest-ecmwf.json', 'manifest-gfs.json')
      || '/api/latest/gfs';
    const resp = await fetch(manifestUrl);
    if (!resp.ok) return null;
    const info = await resp.json();
    return (cfg.DATA_BASE || '') + info.path;
  })();
  return _gfsPathPromise;
}
```

Inside `renderPeakMode`, before defining `loadHour`:

```javascript
  const dataBase = mode === 'next' ? await resolveGfsPath() : _appRef.dataPath;
  if (!dataBase) {
    status.textContent = 'Extended forecast not available — GFS manifest not reachable.';
    list.innerHTML = '';
    return;
  }
```

And change `loadHour` to use `dataBase` instead of `_appRef.dataPath`.

- [ ] **Step 2: Manually verify**

This task depends on Task 22 (pipeline extension) for there to be any f171-f336 data. If Task 22 hasn't run yet, "score next week" will show "Extended forecast not available" — that's the correct graceful state. After Task 22, re-test.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): score next week + missing-data handling"
```

---

## Phase 5 — GFS pipeline extension

### Task 22: Extend download-gfs.sh to fetch f171–f336

**Files:**
- Modify: `surf_app_V3/data/scripts/download-gfs.sh`

- [ ] **Step 1: Add second loop**

Edit `data/scripts/download-gfs.sh`. Find the block after the existing `for FHR in $HOURS; do ... done`. Insert before the final "Download complete" echo:

```bash
# ── Extended-range forecast: f171-f336 at 6-hourly steps (days 7-14) ──
EXT_HOURS=$(seq 174 6 336)
EXT_TOTAL=$(echo "$EXT_HOURS" | wc -w | tr -d ' ')
EXT_COUNT=0

echo ""
echo "━━━ Extended range (days 7-14, 6-hourly) ━━━"
for FHR in $EXT_HOURS; do
  FHRP=$(printf "%03d" "$FHR")
  EXT_COUNT=$((EXT_COUNT + 1))
  echo -n "  [${EXT_COUNT}/${EXT_TOTAL}] f${FHRP}: "

  WIND_FILE="${GRIB_DIR}/gfs_wind_f${FHRP}.grib2"
  if [ ! -f "$WIND_FILE" ]; then
    WIND_URL="${NOMADS_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fatmos&file=gfs.t${CYCLE}z.pgrb2.0p25.f${FHRP}&var_UGRD=on&var_VGRD=on&lev_10_m_above_ground=on"
    curl -sf -o "$WIND_FILE" "$WIND_URL" && echo -n "wind ✓  " || echo -n "wind ✗  "
  else
    echo -n "wind (cached)  "
  fi

  WAVE_FILE="${GRIB_DIR}/gfs_wave_f${FHRP}.grib2"
  if [ ! -f "$WAVE_FILE" ]; then
    WAVE_URL="${WAVE_BASE}?dir=%2Fgfs.${DATE}%2F${CYCLE}%2Fwave%2Fgridded&file=gfswave.t${CYCLE}z.global.0p25.f${FHRP}.grib2&var_HTSGW=on&var_DIRPW=on&var_PERPW=on"
    curl -sf -o "$WAVE_FILE" "$WAVE_URL" && echo "wave ✓" || echo "wave ✗"
  else
    echo "wave (cached)"
  fi
done
```

- [ ] **Step 2: Run updated download**

```bash
cd surf_app_V3 && npm run download:gfs
```

Expected: original 0-168 loop completes, then "Extended range" header and ~28 additional files download.

- [ ] **Step 3: Process**

```bash
python3 data/scripts/process-grib.py gfs <latest-run-id>
```

Verify new `.bin` files appear:

```bash
ls data/gfs/<latest-run>/ | grep -E 'f17[4-9]|f2[0-9]{2}|f3[0-2][0-9]|f336'
```

Expected: wind and swell .bin files at f174, f180, f186, …, f336 (28 each).

- [ ] **Step 4: Re-test "score next week" in the app**

Start dev server, open panel, click "score next week" tab. Should now populate with rankings and "when" badges showing Mon-Sun of week 2.

- [ ] **Step 5: Commit**

```bash
git add surf_app_V3/data/scripts/download-gfs.sh
git commit -m "feat(pumping): extend GFS download to day 14 (6-hourly)"
```

---

## Phase 6 — polish

### Task 23: Loading spinner + first-open responsiveness

**Files:**
- Modify: `surf_app_V3/public/css/style.css`
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Add spinner CSS**

Append to `public/css/style.css`:

```css
.pumping-spinner {
  display: inline-block; width: 14px; height: 14px; margin-right: 8px;
  border: 2px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: pumping-spin 0.7s linear infinite;
  vertical-align: middle;
}
@keyframes pumping-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 2: Use it in status messages**

In `public/js/pumping.js`, update status messages to prepend the spinner while computing:

```javascript
function spinnerHtml(text) {
  return `<span class="pumping-spinner"></span>${text}`;
}
```

Replace `status.textContent = ...` with `status.innerHTML = spinnerHtml(...)` wherever a computation is running. Use plain `textContent` when computation is done.

- [ ] **Step 3: Manually verify**

Reload, open each tab for the first time — spinner shows during load. Disappears once results render.

- [ ] **Step 4: Commit**

```bash
git add surf_app_V3/public/css/style.css surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): loading spinner during computation"
```

---

### Task 24: Error states

**Files:**
- Modify: `surf_app_V3/public/js/pumping.js`

- [ ] **Step 1: Wrap fetch in try/catch with retry**

Replace `loadSpotsOnce` implementation:

```javascript
function loadSpotsOnce() {
  if (_spotsPromise) return _spotsPromise;
  _spotsPromise = Promise.all([
    fetch('data/named-spots.json').then(r => { if (!r.ok) throw new Error('named-spots ' + r.status); return r.json(); }),
    fetch('data/coast-points.json').then(r => { if (!r.ok) throw new Error('coast-points ' + r.status); return r.json(); }),
  ]).then(([named, coast]) => {
    const normalizedCoast = coast.map(c => ({ n: c.n, r: c.c, la: c.la, ln: c.ln, o: c.o }));
    return [...named, ...normalizedCoast];
  }).catch(err => {
    _spotsPromise = null; // allow retry
    throw err;
  });
  return _spotsPromise;
}
```

Wrap the call in `renderCurrentMode` in try/catch:

```javascript
  try {
    const spots = await loadSpotsOnce();
    // ... existing body ...
  } catch (err) {
    status.innerHTML = `Unable to load spot list. <button id="pumping-retry" style="background:none;border:1px solid var(--border);color:var(--accent);padding:4px 10px;border-radius:4px;cursor:pointer;">Retry</button>`;
    document.getElementById('pumping-retry')?.addEventListener('click', renderCurrentMode);
    list.innerHTML = '';
  }
```

- [ ] **Step 2: Manually verify**

Temporarily rename `public/data/named-spots.json` → `.bak`, reload, open panel. Status shows "Unable to load spot list. Retry". Restore the file, click Retry — list loads.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/pumping.js
git commit -m "feat(pumping): error handling + retry for spot list load"
```

---

### Task 25: Invalidate cache on model/run change

**Files:**
- Modify: `surf_app_V3/public/js/app.js`

- [ ] **Step 1: Call invalidatePumpingCache from app.js**

Add import: `import { initPumping, onHourChanged, invalidatePumpingCache } from './pumping.js';`

Modify `_loadLatestRun` — at the top of the function (right after `setStatus('Finding latest data...');`):

```javascript
    invalidatePumpingCache();
```

Modify `setModel`:

```javascript
  setModel(model) {
    if (model === this.model) return;
    this.model = model;
    invalidatePumpingCache();
    this._loadLatestRun();
  }
```

- [ ] **Step 2: Manually verify**

Open panel, click "score this week", wait for compute. Switch model (GFS→ECMWF). Re-open panel → "score this week" recomputes instead of showing stale ECMWF-labeled results.

- [ ] **Step 3: Commit**

```bash
git add surf_app_V3/public/js/app.js
git commit -m "feat(pumping): invalidate cache on model/run change"
```

---

### Task 26: End-to-end browser verification

- [ ] **Step 1: Full walkthrough**

```bash
cd surf_app_V3 && npm start
```

Open `http://localhost:3000`.

Go through this checklist in the browser. Every item must pass:

- [ ] Button "where it's pumping" visible in top bar, lowercase, no emoji
- [ ] Click button → panel slides in from right, map still visible (dimmed)
- [ ] Three tabs render: `right now`, `score this week`, `score next week`
- [ ] "Right now" renders 100 rows with rank, dot, name, swell, wind
- [ ] Top-3 rank numbers are gold-colored
- [ ] Scrub timeline → rankings update within ~150ms after drag stops
- [ ] Click "score this week" → spinner, then 100 rows with "when" badges
- [ ] Second click on "score this week" returns instantly (cached)
- [ ] Click "score next week" → either loads (if Task 22 data exists) or shows "Extended forecast not available"
- [ ] Click any row → panel closes, map flies to spot, surf-rating panel opens
- [ ] For "week"/"next" clicks, timeline also jumps to peak hour
- [ ] Click × or backdrop → panel closes
- [ ] Switch model (GFS↔ECMWF) → reopening the panel recomputes cleanly
- [ ] Islands appear (search visually: Hawaii, Tahiti, Maldives)
- [ ] No console errors during any of the above

- [ ] **Step 2: Fix any issues found**

For each failed check, add a small fix commit. If multiple small fixes, bundle into one "polish: ..." commit.

- [ ] **Step 3: Final commit (if needed)**

```bash
git add -A
git commit -m "feat(pumping): end-to-end verification fixes"
```

---

## Self-review checklist

Run through this after all tasks are done to confirm nothing was missed.

- [ ] Every spec section maps to at least one task:
  - "right now" mode → Task 17, 18
  - "score this week" → Task 20
  - "score next week" → Task 21, 22
  - Named-spots expansion → Task 10, 11
  - Coast-point discovery → Tasks 3-9
  - Button/panel UI → Task 14, 15, 16
  - Row interactions → Task 19
  - Performance (caching) → Task 13, 20, 25
  - Error handling → Task 24
- [ ] No placeholder text (TBD, TODO, etc.) in any task
- [ ] Every code step shows complete code, not pseudocode
- [ ] Every shell command shows expected output
- [ ] File paths are absolute from `surf_app_V3/` root
- [ ] Method signatures consistent across tasks (e.g. `rankNow` shape, `_cachedLoadGrid` name)
