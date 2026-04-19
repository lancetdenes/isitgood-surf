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
import { bearingDeg } from './lib/geo.js';

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
  const swellFiles = fs.readdirSync(runDir).filter(f => f.startsWith('swell_f')).sort();
  if (!swellFiles.length) throw new Error(`${runDir} has no swell_f*.bin — run process-grib.py`);
  const file = path.join(runDir, swellFiles[0]);
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

  // Walk each LineString. For closed loops (islands) precompute the centroid
  // so each sampled point can get a geometric offshoreDeg = bearing from
  // centroid outward — this gives sensible directions for small islands that
  // grid-sampling filters out.
  const candidates = [];
  for (const feat of coastline.features) {
    const geom = feat.geometry;
    const lines = geom.type === 'LineString' ? [geom.coordinates]
      : geom.type === 'MultiLineString' ? geom.coordinates : [];
    for (const line of lines) {
      const closed = line.length >= 3
        && line[0][0] === line[line.length - 1][0]
        && line[0][1] === line[line.length - 1][1];
      let centroid = null;
      if (closed) {
        let sx = 0, sy = 0;
        for (let i = 0; i < line.length - 1; i++) { sx += line[i][0]; sy += line[i][1]; }
        centroid = { lat: sy / (line.length - 1), lon: sx / (line.length - 1) };
      }
      for (const pt of walkLineString(line, STEP_KM)) {
        candidates.push({ ...pt, centroid });
      }
    }
  }
  console.log(`Walked coastline → ${candidates.length} candidates at ${STEP_KM}km spacing`);

  const results = [];
  let kept = 0, drop_noOffshore = 0;
  const t0 = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    if (i % 500 === 0) {
      const pct = ((i / candidates.length) * 100).toFixed(1);
      process.stdout.write(`\r  scoring ${i}/${candidates.length} (${pct}%) — kept ${kept}`);
    }
    const { lat, lon, centroid } = candidates[i];

    // Try grid-based detection first (accurate for mainland). If it fails
    // (small island surrounded by water) fall back to geometric bearing from
    // the island centroid outward.
    let offshore = computeOffshoreDeg(swellGrid, lat, lon);
    if (offshore === null && centroid) {
      offshore = bearingDeg(centroid.lat, centroid.lon, lat, lon);
    }
    if (offshore === null) { drop_noOffshore++; continue; }

    const near = nearestCity(index, cities, lat, lon, TOWN_MAX_KM);
    // Prefer PIP country; fall back to nearest city's country code (better
    // than "International waters" for small islands outside admin polygons).
    const country = countryAt(countries, lat, lon) || near?.country || 'unknown';

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
