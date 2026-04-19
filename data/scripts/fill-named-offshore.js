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
  const runDir = path.join(dir, runs[runs.length - 1]);
  const swellFiles = fs.readdirSync(runDir).filter(f => f.startsWith('swell_f')).sort();
  return loadGridFromFile(path.join(runDir, swellFiles[0]));
}

const grid = latestSwellGrid();
const file = 'public/data/named-spots.json';
const spots = JSON.parse(fs.readFileSync(file, 'utf8'));

// Load coast-points for fallback lookup (built points include centroid-based
// offshoreDeg for small islands where grid sampling fails).
const coastPoints = JSON.parse(fs.readFileSync('public/data/coast-points.json', 'utf8'));

function kmBetween(aLa, aLn, bLa, bLn) {
  const R = 6371.0088, TR = Math.PI / 180;
  const dLat = (bLa - aLa) * TR, dLon = (bLn - aLn) * TR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLa * TR) * Math.cos(bLa * TR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearestCoastOffshore(la, ln, maxKm) {
  let best = null, bestD = Infinity;
  for (const cp of coastPoints) {
    if (Math.abs(cp.la - la) > 1 || Math.abs(cp.ln - ln) > 1) continue;
    const d = kmBetween(la, ln, cp.la, cp.ln);
    if (d < bestD) { bestD = d; best = cp; }
  }
  return best && bestD <= maxKm ? best.o : null;
}

let filled = 0, fallback = 0, skipped = 0;
for (const s of spots) {
  const o = computeOffshoreDeg(grid, s.la, s.ln);
  if (o !== null) { s.o = Math.round(o); filled++; continue; }

  const fb = nearestCoastOffshore(s.la, s.ln, 30);
  if (fb !== null) { s.o = fb; fallback++; continue; }

  skipped++;
}

fs.writeFileSync(file, JSON.stringify(spots, null, 2));
console.log(`filled ${filled}, fallback ${fallback}, skipped ${skipped}, of ${spots.length}`);
