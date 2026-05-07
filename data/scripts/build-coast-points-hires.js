#!/usr/bin/env node
/**
 * build-coast-points-hires.js
 *
 * GSHHG-h variant of build-coast-points.js. Walks the hires binary at
 * STEP_KM spacing, computes (offshoreDir, coastBearing, seawardDir) via
 * the Node-side findNearestCoastNode helper, tags country/town, and
 * writes public/data/coast-points.json with the legacy `o` field plus
 * new `cb` (coastBearing) and `sw` (seawardDir).
 *
 * pumping.js prefers `sw` when present and falls back to (o + 180) % 360
 * for the legacy NE-built file. The browser-side click-into-spot path
 * sees the same fields and can prefer the precomputed values when
 * present so rank-time and click-time agree.
 *
 * Run:  npm run build:coast-points:hires
 */
import fs from 'node:fs';
import path from 'node:path';
import KDBush from 'kdbush';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint } from '@turf/helpers';

import { walkLineString } from './lib/coastline-walker.js';
import { loadCountries, loadCities, buildCityIndex, nearestCity } from './lib/reference-data.js';
import { parseCoastlineBinary } from './lib/coastline-binary.js';
import { findNearestCoastNode, buildIndex } from './lib/find-nearest-coast-node.js';

// pumping.js dedupes the ranking at 25km radius, so finer than ~25km spacing
// just adds JSON bytes without surfacing more spots. The previous NE build
// used 10km but had ~3k features; GSHHG-h's 6k+ kept features make any step
// finer than 25km exceed the budget.
const STEP_KM = 25;
const TOWN_MAX_KM = 200;
const OUTPUT = 'public/data/coast-points.json';
const BIN = 'public/assets/coastline-hires.bin';

// GSHHG-h has ~151k features (continents + tiny islets). Tiny islets
// rarely host surfable breaks and would balloon the JSON budget. Only
// keep features whose total perimeter is at least this; covers all
// continental mainlands plus medium+ islands (Tahiti, Maui, Ibiza, etc.).
const MIN_FEATURE_PERIMETER_KM = 30;
// Existing NE-built coast-points.json carries ~80k points / 6.2MB.
// Cap at 100k to leave headroom and surface oversized output as an error.
const MAX_OUTPUT_POINTS = 100_000;
const MIN_OUTPUT_POINTS = 1_000;
// Drop walked points whose nearest coast came back > 2km away (something's
// off, e.g. the walk produced a point on the wrong side of an island).
const MAX_NEAREST_KM = 2;

function featurePerimeterKm(line) {
  // line: [[lon, lat], ...]; haversine sum.
  const R = 6371, T = Math.PI / 180;
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const [lonA, latA] = line[i - 1];
    const [lonB, latB] = line[i];
    const dLat = (latB - latA) * T, dLon = (lonB - lonA) * T;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(latA * T) * Math.cos(latB * T) * Math.sin(dLon / 2) ** 2;
    total += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
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
  console.log('━━━ build-coast-points-hires ━━━\n');
  console.log('Loading hires binary...');
  const buf = fs.readFileSync(BIN);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = parseCoastlineBinary(ab);
  console.log(`  ${data.nFeatures} features, ${data.nVertices.toLocaleString()} vertices`);

  console.log('Building KDBush over segment midpoints...');
  const idx = buildIndex(KDBush, data);

  console.log('Loading countries + cities...');
  const countries = loadCountries();
  const cities = loadCities();
  const { index: cityIdx } = buildCityIndex(cities);
  console.log(`  countries: ${countries.features.length}`);
  console.log(`  cities:    ${cities.length}\n`);

  console.log(`Walking GSHHG features at ${STEP_KM}km spacing (perimeter ≥ ${MIN_FEATURE_PERIMETER_KM}km only)...`);
  const candidates = [];
  let nFeaturesKept = 0, nFeaturesSkipped = 0;
  for (let f = 0; f < data.nFeatures; f++) {
    const len = data.featureLength(f);
    if (len < 2) continue;
    const line = new Array(len);
    for (let i = 0; i < len; i++) {
      const [lon, lat] = data.vertex(f, i);
      // walkLineString uses haversine which expects -180/180 lon space.
      line[i] = [lon > 180 ? lon - 360 : lon, lat];
    }
    if (featurePerimeterKm(line) < MIN_FEATURE_PERIMETER_KM) {
      nFeaturesSkipped++;
      continue;
    }
    nFeaturesKept++;
    for (const pt of walkLineString(line, STEP_KM)) {
      candidates.push(pt);
    }
  }
  console.log(`  Features kept: ${nFeaturesKept} (skipped ${nFeaturesSkipped} tiny islets)`);
  console.log(`  → ${candidates.length.toLocaleString()} candidate points`);

  if (candidates.length > MAX_OUTPUT_POINTS) {
    console.error(`HALT: ${candidates.length} > ${MAX_OUTPUT_POINTS} cap. Increase STEP_KM or revisit budget.`);
    process.exit(1);
  }

  const results = [];
  let kept = 0, dropFar = 0, dropUnreliable = 0;
  const t0 = Date.now();
  for (let i = 0; i < candidates.length; i++) {
    if (i % 500 === 0) {
      const pct = ((i / candidates.length) * 100).toFixed(1);
      process.stdout.write(`\r  scoring ${i}/${candidates.length} (${pct}%) — kept ${kept}`);
    }
    const { lat, lon } = candidates[i];
    const r = findNearestCoastNode(data, idx, lat, lon);
    if (r.unreliableBearing) { dropUnreliable++; continue; }
    if (r.distance / 1000 > MAX_NEAREST_KM) { dropFar++; continue; }
    const near = nearestCity(cityIdx, cities, lat, lon, TOWN_MAX_KM);
    const country = countryAt(countries, lat, lon) || near?.country || 'unknown';
    const hemiNS = lat >= 0 ? 'N' : 'S', hemiEW = lon >= 0 ? 'E' : 'W';
    const name = near
      ? `near ${near.name}, ${country}`
      : `coast ${Math.abs(lat).toFixed(1)}°${hemiNS} ${Math.abs(lon).toFixed(1)}°${hemiEW}, ${country}`;
    results.push({
      la: +lat.toFixed(3),
      ln: +lon.toFixed(3),
      n: name,
      c: country,
      o: Math.round(r.offshoreDir),
      cb: Math.round(r.coastBearing),
      sw: Math.round(r.seawardDir),
    });
    kept++;
  }
  process.stdout.write('\n');

  if (kept < MIN_OUTPUT_POINTS) {
    console.error(`HALT: only ${kept} kept (< ${MIN_OUTPUT_POINTS}). Pipeline misconfigured.`);
    process.exit(1);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${dt}s`);
  console.log(`  kept:                ${kept}`);
  console.log(`  dropped (>${MAX_NEAREST_KM}km from coast):  ${dropFar}`);
  console.log(`  dropped (unreliable):${dropUnreliable}`);

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(results));
  const kb = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
  console.log(`\n  wrote ${OUTPUT} (${kb} KB, ${results.length} points)`);
}

main().catch(err => {
  console.error('\nERROR:', err);
  process.exit(1);
});
