import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseStdmet, latestStdmetObs, parseSpec, latestSpecSummary,
  parseDataSpec, parseSwdir, mergeSpectrum,
  parseActiveStations, parseRealtimeIndex, buildStationList,
  normalizeStationId, fixtureNameFor,
} from '../ndbc.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ndbc');
const fix = (name) => readFileSync(path.join(FIX, name), 'utf8');

// ── stdmet ──

test('parseStdmet parses rows newest-first with MM as null', () => {
  const rows = parseStdmet(fix('46042.txt'));
  assert.ok(rows.length > 10);
  // Newest first
  assert.ok(Date.parse(rows[0].time) > Date.parse(rows[1].time));
  // Every row has a valid ISO time
  for (const r of rows.slice(0, 5)) assert.ok(!Number.isNaN(Date.parse(r.time)));
  // Known first row of the fixture: WVHT is MM, wind present
  assert.equal(rows[0].WVHT, null);
  assert.equal(typeof rows[0].WSPD, 'number');
});

test('parseStdmet handles synthetic minimal input', () => {
  const text = [
    '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
    '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
    '2026 07 30 02 00 320 10.0 12.0    MM    MM    MM  MM 1012.4  15.7  16.6  14.2   MM -1.0    MM',
    '2026 07 30 01 50 320 10.0 12.0   2.6    16   6.5 258 1012.4  15.7  16.6  14.2   MM   MM    MM',
  ].join('\n');
  const rows = parseStdmet(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].time, '2026-07-30T02:00:00.000Z');
  assert.equal(rows[0].WVHT, null);
  assert.equal(rows[1].WVHT, 2.6);
  assert.equal(rows[1].DPD, 16);
  assert.equal(rows[1].MWD, 258);
  assert.equal(rows[0].PTDY, -1.0);
});

test('latestStdmetObs merges wave data from an older row within lookback', () => {
  const text = [
    '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
    '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
    '2026 07 30 02 00 320 10.0 12.0    MM    MM    MM  MM 1012.4  15.7  16.6  14.2   MM -1.0    MM',
    '2026 07 30 01 50 315  9.0 11.0   2.6    16   6.5 258 1012.4  15.7  16.6  14.2   MM   MM    MM',
  ].join('\n');
  const obs = latestStdmetObs(parseStdmet(text));
  assert.equal(obs.time, '2026-07-30T02:00:00.000Z');
  assert.equal(obs.wind.speedMs, 10.0);       // newest row has wind
  assert.equal(obs.waves.heightM, 2.6);       // wave data pulled from older row
  assert.equal(obs.waves.dominantPeriodS, 16);
  assert.equal(obs.waves.time, '2026-07-30T01:50:00.000Z');
  assert.equal(obs.waterTempC, 16.6);
  assert.equal(obs.pressureTendencyHpa, -1.0);
});

test('latestStdmetObs ignores wave rows older than the 3h lookback', () => {
  const text = [
    '#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE',
    '#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft',
    '2026 07 30 12 00 320 10.0 12.0    MM    MM    MM  MM 1012.4  15.7  16.6  14.2   MM   MM    MM',
    '2026 07 30 01 00 315  9.0 11.0   2.6    16   6.5 258 1012.4  15.7  16.6  14.2   MM   MM    MM',
  ].join('\n');
  const obs = latestStdmetObs(parseStdmet(text));
  assert.equal(obs.waves, null);
});

test('latestStdmetObs works on the real fixture', () => {
  const obs = latestStdmetObs(parseStdmet(fix('46042.txt')));
  assert.ok(obs.wind);
  assert.ok(obs.waves);
  assert.ok(obs.waves.heightM > 0 && obs.waves.heightM < 20);
  assert.ok(obs.waterTempC > 0 && obs.waterTempC < 40);
});

// ── spec summary ──

test('parseSpec keeps cardinal directions and steepness as strings', () => {
  const rows = parseSpec(fix('46026.spec'));
  assert.ok(rows.length > 5);
  const withSwell = rows.find(r => r.SwH != null);
  assert.ok(withSwell, 'fixture should contain a row with swell split');
  assert.match(withSwell.SwD, /^[NSEW]{1,3}$/);
  assert.equal(typeof withSwell.SwP, 'number');
});

test('latestSpecSummary prefers rows with the swell/windsea split', () => {
  const text = [
    '#YY  MM DD hh mm WVHT  SwH  SwP  WWH  WWP SwD WWD  STEEPNESS  APD MWD',
    '#yr  mo dy hr mn    m    m  sec    m  sec  -  degT     -      sec degT',
    '2026 07 30 01 40  2.6   MM   MM   MM   MM  MM  MM        N/A  6.5 258',
    '2026 07 30 01 10  2.3  1.2 16.0  2.0  7.7 SSW  NW      STEEP  6.4 307',
  ].join('\n');
  const s = latestSpecSummary(parseSpec(text));
  assert.equal(s.time, '2026-07-30T01:10:00.000Z');
  assert.equal(s.swell.heightM, 1.2);
  assert.equal(s.swell.periodS, 16.0);
  assert.equal(s.swell.dirCard, 'SSW');
  assert.equal(s.windWave.heightM, 2.0);
  assert.equal(s.windWave.dirCard, 'NW');
  assert.equal(s.steepness, 'STEEP');
  assert.equal(s.meanDirDeg, 307);
});

test('latestSpecSummary falls back to WVHT-only rows', () => {
  const text = [
    '#YY  MM DD hh mm WVHT  SwH  SwP  WWH  WWP SwD WWD  STEEPNESS  APD MWD',
    '#yr  mo dy hr mn    m    m  sec    m  sec  -  degT     -      sec degT',
    '2026 07 30 01 40  2.6   MM   MM   MM   MM  MM  MM        N/A  6.5 258',
  ].join('\n');
  const s = latestSpecSummary(parseSpec(text));
  assert.equal(s.waveHeightM, 2.6);
  assert.equal(s.swell, null);
  assert.equal(s.avgPeriodS, 6.5);
});

// ── raw spectrum ──

test('parseDataSpec extracts separation frequency and energy bins', () => {
  const line = '2026 07 30 01 50 0.120 0.000 (0.033) 1.144 (0.053) 6.333 (0.058) 0.382 (0.230)';
  const text = '#YY  MM DD hh mm Sep_Freq  < spec_1 (freq_1) ... >\n' + line;
  const d = parseDataSpec(text);
  assert.equal(d.time, '2026-07-30T01:50:00.000Z');
  assert.equal(d.sepFreq, 0.12);
  assert.equal(d.bins.length, 4);
  assert.deepEqual(d.bins[1], { freq: 0.053, energy: 1.144 });
  assert.deepEqual(d.bins[3], { freq: 0.23, energy: 0.382 });
});

test('parseDataSpec on real fixture: physical values, ascending freq', () => {
  const d = parseDataSpec(fix('46042.data_spec'));
  assert.ok(d.bins.length >= 25, `expected many bins, got ${d.bins.length}`);
  for (let i = 1; i < d.bins.length; i++) assert.ok(d.bins[i].freq > d.bins[i - 1].freq);
  for (const b of d.bins) {
    assert.ok(b.freq > 0.02 && b.freq < 1.0);
    assert.ok(b.energy >= 0 && b.energy < 1000);
  }
});

test('parseSwdir nulls the 999 sentinel', () => {
  const text = '#YY  MM DD hh mm alpha1_1 (freq_1) ...\n'
    + '2026 07 30 01 50 999.0 (0.033) 172.0 (0.053) 248.0 (0.058)';
  const d = parseSwdir(text);
  assert.equal(d.bins[0].dir, null);
  assert.equal(d.bins[1].dir, 172.0);
  assert.equal(d.bins[2].dir, 248.0);
});

test('mergeSpectrum joins direction onto energy bins by frequency', () => {
  const ds = parseDataSpec('#h\n2026 07 30 01 50 0.120 2.0 (0.053) 3.0 (0.058) 1.0 (0.100)');
  const sd = parseSwdir('#h\n2026 07 30 01 50 172.0 (0.053) 999.0 (0.058) 310.0 (0.100)');
  const merged = mergeSpectrum(ds, sd);
  assert.equal(merged.bins.length, 3);
  assert.equal(merged.bins[0].dir, 172.0);
  assert.equal(merged.bins[1].dir, null);
  assert.equal(merged.bins[2].dir, 310.0);
  assert.equal(merged.bins[0].period, 18.9); // 1/0.053
  assert.equal(merged.sepFreq, 0.12);
});

test('mergeSpectrum works without swdir data', () => {
  const ds = parseDataSpec('#h\n2026 07 30 01 50 0.120 2.0 (0.053)');
  const merged = mergeSpectrum(ds, null);
  assert.equal(merged.bins[0].dir, null);
  assert.equal(merged.bins[0].energy, 2.0);
});

test('real fixture spectrum merges with mostly-valid directions', () => {
  const merged = mergeSpectrum(
    parseDataSpec(fix('46042.data_spec')),
    parseSwdir(fix('46042.swdir')),
  );
  const withDir = merged.bins.filter(b => b.dir != null);
  assert.ok(withDir.length > merged.bins.length / 2,
    `expected most bins to carry direction, got ${withDir.length}/${merged.bins.length}`);
});

// ── station list ──

test('parseActiveStations extracts id/coords/name', () => {
  const meta = parseActiveStations(fix('activestations.xml'));
  assert.ok(meta.size > 1000);
  const s = meta.get('46042');
  assert.ok(s, '46042 present');
  assert.ok(Math.abs(s.lat - 36.8) < 0.5);
  assert.ok(Math.abs(s.lng - (-122.4)) < 0.5);
  assert.match(s.name.toLowerCase(), /monterey/);
});

test('parseRealtimeIndex maps station → feed modification times', () => {
  const index = parseRealtimeIndex(fix('realtime2-index.html'));
  assert.ok(index.size > 500);
  const s = index.get('46042');
  assert.ok(s.txt > 0);
  assert.ok(s.spec > 0);
  assert.ok(s.data_spec > 0);
  assert.ok(s.swdir > 0);
});

test('buildStationList filters stale stations and flags spectral', () => {
  const index = parseRealtimeIndex(fix('realtime2-index.html'));
  const newest = Math.max(...[...index.values()].flatMap(f => Object.values(f)));
  const list = buildStationList(fix('activestations.xml'), fix('realtime2-index.html'), newest);
  assert.ok(list.length > 300, `got ${list.length}`);
  const monterey = list.find(s => s.id === '46042');
  assert.ok(monterey);
  assert.equal(monterey.hasSpectral, true);
  assert.equal(monterey.hasWave, true);
  // Every entry has coordinates and flags
  for (const s of list.slice(0, 20)) {
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lng));
    assert.equal(typeof s.hasSpectral, 'boolean');
  }
  // A "now" far in the future drops everything as stale
  const stale = buildStationList(fix('activestations.xml'), fix('realtime2-index.html'),
    newest + 365 * 24 * 3600 * 1000);
  assert.equal(stale.length, 0);
});

// ── misc ──

test('normalizeStationId validates and uppercases', () => {
  assert.equal(normalizeStationId('46042'), '46042');
  assert.equal(normalizeStationId(' 51wh0 '), '51WH0');
  assert.equal(normalizeStationId('../etc'), null);
  assert.equal(normalizeStationId(''), null);
  assert.equal(normalizeStationId('x'.repeat(20)), null);
});

test('fixtureNameFor maps NDBC paths to fixture files', () => {
  assert.equal(fixtureNameFor('/activestations.xml'), 'activestations.xml');
  assert.equal(fixtureNameFor('/data/realtime2/'), 'realtime2-index.html');
  assert.equal(fixtureNameFor('/data/realtime2/46042.data_spec'), '46042.data_spec');
  assert.equal(fixtureNameFor('/data/realtime2/../secret'), null);
});
