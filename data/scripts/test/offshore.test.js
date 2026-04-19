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
  const runDir = path.join(dir, runs[runs.length - 1]);
  const swellFiles = fs.readdirSync(runDir).filter(f => f.startsWith('swell_f')).sort();
  if (!swellFiles.length) return null;
  return loadGridFromFile(path.join(runDir, swellFiles[0]));
}

test('computeOffshoreDeg: Ocean Beach SF (mainland coast) returns a direction', { skip: !latestSwellGrid() }, () => {
  const g = latestSwellGrid();
  const deg = computeOffshoreDeg(g, 37.76, -122.51);
  assert.ok(deg !== null, 'expected a non-null offshore direction');
  assert.ok(deg >= 0 && deg < 360, `deg out of range: ${deg}`);
});

test('computeOffshoreDeg: point in open ocean (no land nearby) returns null', { skip: !latestSwellGrid() }, () => {
  const g = latestSwellGrid();
  const deg = computeOffshoreDeg(g, 40, -40);
  assert.equal(deg, null);
});
