/**
 * forecast-hours.test.js — Asserts the forecast-hour layout and that all
 * mirrors of it agree:
 *   - data/scripts/lib/forecast-hours.js (CommonJS, pipeline + server)
 *   - public/js/hours.js                 (browser ESM)
 *   - data/scripts/process-grib.py       (forecast_hours())
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const cjs = require('../lib/forecast-hours');

const ROOT = path.join(__dirname, '..', '..', '..');

test('hour layout: 0-168 @3h then 174-336 @6h, 85 steps', () => {
  const hours = cjs.FORECAST_HOURS;
  assert.equal(hours.length, 85);
  assert.equal(hours[0], 0);
  assert.equal(hours[hours.length - 1], 336);

  // Strictly ascending, correct step on each side of the boundary
  for (let i = 1; i < hours.length; i++) {
    const step = hours[i] - hours[i - 1];
    if (hours[i] <= 168) assert.equal(step, 3, `step into h=${hours[i]}`);
    else if (hours[i - 1] >= 174) assert.equal(step, 6, `step into h=${hours[i]}`);
    else assert.equal(step, 6, 'boundary 168→174');
  }

  assert.deepEqual(cjs.baseHours().slice(-2), [165, 168]);
  assert.deepEqual(cjs.extendedHours().slice(0, 2), [174, 180]);
  assert.equal(cjs.baseHours().length, 57);
  assert.equal(cjs.extendedHours().length, 28);
  assert.equal(cjs.N_STEPS, 85);
  assert.equal(cjs.MAX_HOUR, 336);
});

test('browser ESM module (public/js/hours.js) matches the CJS mirror', async () => {
  const esm = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'hours.js')).href);
  assert.deepEqual([...esm.FORECAST_HOURS], [...cjs.FORECAST_HOURS]);
  assert.equal(esm.BASE_END, cjs.BASE_END);
  assert.equal(esm.EXT_START, cjs.EXT_START);
  assert.equal(esm.EXT_END, cjs.EXT_END);

  // index/hour mapping behaves across the non-uniform boundary
  assert.equal(esm.hourToIndex(0), 0);
  assert.equal(esm.hourToIndex(168), 56);
  assert.equal(esm.hourToIndex(174), 57);
  assert.equal(esm.hourToIndex(336), 84);
  assert.equal(esm.indexToHour(56), 168);
  assert.equal(esm.indexToHour(57), 174);
  assert.equal(esm.indexToHour(999), 336);
  // 170 is closer to 168 (diff 2) than 174 (diff 4)
  assert.equal(esm.indexToHour(esm.hourToIndex(170)), 168);
  assert.ok(!esm.isExtended(168));
  assert.ok(esm.isExtended(174));

  // Round-trip every step
  esm.FORECAST_HOURS.forEach((h, i) => {
    assert.equal(esm.hourToIndex(h), i);
    assert.equal(esm.indexToHour(i), h);
  });
});

test('process-grib.py forecast_hours() matches the CJS mirror', (t) => {
  const probe = [
    'import importlib.util, json, os, sys',
    `spec = importlib.util.spec_from_file_location('pg', ${JSON.stringify(path.join(ROOT, 'data', 'scripts', 'process-grib.py'))})`,
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'print(json.dumps(mod.forecast_hours()))',
  ].join('\n');
  const res = spawnSync('python3', ['-c', probe], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    t.skip(`python3 probe unavailable: ${res.error?.message || res.stderr?.slice(0, 200)}`);
    return;
  }
  const pyHours = JSON.parse(res.stdout.trim());
  assert.deepEqual(pyHours, [...cjs.FORECAST_HOURS]);
});
