#!/usr/bin/env node

/**
 * generate-demo.js — Creates realistic demo wind + swell binary grid files
 * so the app works out of the box without downloading real GRIB data.
 *
 * Run: node data/scripts/generate-demo.js
 * Output: data/demo/wind_f000.bin ... wind_f336.bin
 *         data/demo/swell_f000.bin ... swell_f336.bin
 *         data/demo/points.bin (SCUB cube over all 85 hours)
 *
 * Hours follow the shared layout (0-168 @3h, 174-336 @6h) so the extended
 * timeline is testable locally end-to-end.
 */

const fs = require('fs');
const path = require('path');
const { FORECAST_HOURS, BASE_END } = require('./lib/forecast-hours');

const DEMO_DIR = path.join(__dirname, '..', 'demo');

// Grid dimensions. Default is a 1° global grid (fast to generate). Set
// DEMO_RES=hi for a 0.25° grid matching real GFS output (1440×721) — useful
// for performance testing where decode/render cost depends on grid size.
const HI_RES = process.env.DEMO_RES === 'hi';
const NX = HI_RES ? 1440 : 360;
const NY = HI_RES ? 721 : 181;
const LO1 = 0;     // first lon
const LA1 = 90;    // first lat (north to south)
const DX = HI_RES ? 0.25 : 1.0;
const DY = HI_RES ? 0.25 : 1.0;

/** Pick an int16 scale that preserves the array's range with headroom. */
function deriveScale(arr) {
  let maxAbs = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = Math.abs(arr[i]);
    if (v > maxAbs) maxAbs = v;
  }
  if (maxAbs === 0) return { scale: 1.0, offset: 0 };
  return { scale: maxAbs / 32000, offset: 0 };
}

function writeBinary(filePath, nParams, ...arrays) {
  const gridSize = NX * NY;
  const headerSize = 32 + nParams * 8;
  const bufSize = headerSize + nParams * gridSize * 2;
  const buf = Buffer.alloc(bufSize);

  // Header
  buf.write('SRF2', 0, 4, 'ascii');
  buf.writeUInt32LE(NX, 4);
  buf.writeUInt32LE(NY, 8);
  buf.writeFloatLE(LO1, 12);
  buf.writeFloatLE(LA1, 16);
  buf.writeFloatLE(DX, 20);
  buf.writeFloatLE(DY, 24);
  buf.writeUInt32LE(nParams, 28);

  // Scale table
  const scales = arrays.map(deriveScale);
  for (let p = 0; p < nParams; p++) {
    const o = 32 + p * 8;
    buf.writeFloatLE(scales[p].scale, o);
    buf.writeFloatLE(scales[p].offset, o + 4);
  }

  // Int16 data arrays
  for (let p = 0; p < nParams; p++) {
    const { scale, offset } = scales[p];
    const base = headerSize + p * gridSize * 2;
    for (let i = 0; i < gridSize; i++) {
      let q = Math.round((arrays[p][i] - offset) / scale);
      if (q < -32768) q = -32768;
      else if (q > 32767) q = 32767;
      buf.writeInt16LE(q, base + i * 2);
    }
  }

  fs.writeFileSync(filePath, buf);
}

// Simple pseudo-random (seeded for reproducibility)
let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

// Simple land mask approximation (returns true if likely ocean)
function isOcean(lat, lon) {
  // Very rough continental outlines
  // North America
  if (lat > 25 && lat < 50 && lon > 235 && lon < 300) return false;
  // South America
  if (lat > -55 && lat < 12 && lon > 280 && lon < 325) return false;
  // Europe
  if (lat > 36 && lat < 70 && lon > 350 || (lat > 36 && lat < 70 && lon < 40)) return false;
  // Africa
  if (lat > -35 && lat < 37 && lon > 342 || (lat > -35 && lat < 37 && lon > 0 && lon < 52)) return false;
  // Asia
  if (lat > 10 && lat < 75 && lon > 40 && lon < 145) return false;
  // Australia
  if (lat > -40 && lat < -10 && lon > 112 && lon < 155) return false;

  return true;
}

function generateWindField(hourOffset) {
  const u = new Float32Array(NX * NY);
  const v = new Float32Array(NX * NY);

  // Phase shift for temporal evolution
  const phase = hourOffset * 0.03;

  for (let j = 0; j < NY; j++) {
    const lat = LA1 - j * DY;
    const latRad = lat * Math.PI / 180;

    for (let i = 0; i < NX; i++) {
      const lon = LO1 + i * DX;
      const lonRad = lon * Math.PI / 180;
      const idx = j * NX + i;

      // Jet stream (mid-latitude westerlies)
      const jetLat = 42 + 5 * Math.sin(lonRad * 2 + phase);
      const jetWidth = 12;
      const jetStrength = 18;
      const jet = jetStrength * Math.exp(-0.5 * Math.pow((lat - jetLat) / jetWidth, 2));

      // Southern hemisphere jet
      const sJetLat = -45 + 3 * Math.sin(lonRad * 3 + phase * 0.8);
      const sJet = 15 * Math.exp(-0.5 * Math.pow((lat - sJetLat) / 10, 2));

      // Trade winds (easterlies in tropics)
      const trades = -6 * Math.exp(-0.5 * Math.pow(lat / 18, 2)) * Math.cos(latRad);

      // Rossby wave perturbation
      const wave = 4 * Math.sin(lonRad * 3 + latRad * 2 + phase) *
                   Math.exp(-0.5 * Math.pow(lat / 50, 2));

      // Cyclone features (add a few rotating systems)
      let cu = 0, cv = 0;

      // North Atlantic cyclone
      const c1Lat = 48 + 3 * Math.sin(phase * 2);
      const c1Lon = 330 + 5 * Math.cos(phase * 1.5);
      const c1dx = lon - c1Lon;
      const c1dy = lat - c1Lat;
      const c1r = Math.sqrt(c1dx * c1dx + c1dy * c1dy);
      if (c1r < 20 && c1r > 0.5) {
        const strength = 12 * Math.exp(-c1r / 8) * (1 - Math.exp(-c1r / 2));
        cu += -strength * c1dy / c1r;
        cv += strength * c1dx / c1r;
      }

      // Pacific high
      const h1Lat = 30;
      const h1Lon = 210 + 3 * Math.sin(phase);
      const h1dx = lon - h1Lon;
      const h1dy = lat - h1Lat;
      const h1r = Math.sqrt(h1dx * h1dx + h1dy * h1dy);
      if (h1r < 25 && h1r > 0.5) {
        const strength = 6 * Math.exp(-h1r / 12) * (1 - Math.exp(-h1r / 3));
        cu += strength * h1dy / h1r;
        cv += -strength * h1dx / h1r;
      }

      // Combine
      u[idx] = jet + sJet + trades + wave * 0.3 + cu + (rand() - 0.5) * 1.5;
      v[idx] = wave + cv + (rand() - 0.5) * 1.5;

      // Coriolis-like deflection
      v[idx] += -Math.sign(lat) * jet * 0.08;
    }
  }

  return { u, v };
}

/**
 * Generate partitioned swell fields plus a physically-coherent combined field.
 *
 * Four components per ocean cell:
 *   train 1 — long-period groundswell (15-18 s) radiating from a slowly
 *             drifting storm (N Pacific in the north, Southern Ocean in the
 *             south). Direction points back at the storm (meteorological
 *             "from"). Deliberately modest heights over a huge area so the
 *             "1 ft @ 18 s forerunner under a big windsea" case is testable.
 *   train 2 — mid-period (10-12 s) secondary swell from a different bearing.
 *   train 3 — small short-mid (8-9 s) residual train, present only in
 *             patches, so the panel's "up to 3 partitions" sorting and
 *             absence handling both get exercised.
 *   windsea — locally generated 5-8 s chop, biggest in the demo's windy
 *             mid-latitude bands, from a direction unrelated to train 1.
 *
 * Combined = RSS of the component heights; direction/period taken from the
 * dominant-energy (H²T) component — same convention as GFS's HTSGW/DIRPW/PERPW.
 */
function generateSwellField(hourOffset) {
  const mk = () => new Float32Array(NX * NY);
  const out = {
    height: mk(), direction: mk(), period: mk(),
    parts: [
      { h: mk(), d: mk(), p: mk() },
      { h: mk(), d: mk(), p: mk() },
      { h: mk(), d: mk(), p: mk() },
    ],
    windsea: { h: mk(), d: mk(), p: mk() },
  };

  const phase = hourOffset * 0.02;
  const TO_DEG = 180 / Math.PI;

  // Distant storm centers (drift slowly over the week)
  const storms = [
    { lat: 42, lon: 185 + hourOffset * 0.05, size: 45, hMax: 2.2 },  // N Pacific
    { lat: -52, lon: 210 + hourOffset * 0.04, size: 55, hMax: 2.6 }, // Southern Ocean
  ];

  for (let j = 0; j < NY; j++) {
    const lat = LA1 - j * DY;
    const latRad = lat * Math.PI / 180;

    for (let i = 0; i < NX; i++) {
      const lon = LO1 + i * DX;
      const lonRad = lon * Math.PI / 180;
      const idx = j * NX + i;

      if (!isOcean(lat, lon)) continue; // all fields stay 0 (land convention)

      // ── Train 1: groundswell from the nearest storm ──
      let h1 = 0, d1 = 0, p1 = 0;
      for (const s of storms) {
        let dLon = lon - s.lon;
        if (dLon > 180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        const dLat = lat - s.lat;
        const dist = Math.sqrt(dLat * dLat + dLon * dLon * Math.cos(latRad) ** 2);
        const h = s.hMax * Math.exp(-0.5 * Math.pow(dist / s.size, 2));
        if (h > h1) {
          h1 = h;
          // Direction FROM = bearing from cell back toward the storm center
          d1 = (Math.atan2(-dLon * Math.cos(latRad), -dLat) * TO_DEG + 360) % 360;
          // Forerunner physics-flavored: longer period further from the source
          p1 = 14 + Math.min(4, dist / 25) + Math.sin(phase) * 0.5;
        }
      }
      if (h1 < 0.15) { h1 = 0; d1 = 0; p1 = 0; }

      // ── Train 2: mid-period secondary swell ──
      const southSwath = Math.exp(-0.5 * Math.pow((lat + 10) / 35, 2));
      let h2 = 0.9 * southSwath * (0.7 + 0.3 * Math.sin(lonRad * 2 + phase));
      let d2 = (195 + 25 * Math.sin(lonRad * 3 + phase)) % 360;
      let p2 = 10.5 + Math.sin(lonRad + phase) * 1.2;
      if (h2 < 0.15) { h2 = 0; d2 = 0; p2 = 0; }

      // ── Train 3: small residual train, patchy ──
      const patch = Math.sin(lonRad * 4 + latRad * 5 + phase * 1.3);
      let h3 = patch > 0.45 ? 0.5 * (patch - 0.45) / 0.55 : 0;
      let d3 = h3 > 0 ? (80 + 30 * Math.sin(latRad * 4 + phase)) % 360 : 0;
      let p3 = h3 > 0 ? 8.5 + Math.sin(lonRad * 2) * 0.7 : 0;
      if (h3 < 0.15) { h3 = 0; d3 = 0; p3 = 0; }

      // ── Windsea: local chop in windy bands ──
      const windyBand = Math.exp(-0.5 * Math.pow((Math.abs(lat) - 45) / 14, 2));
      let hw = Math.max(0, 0.4 + 1.6 * windyBand * (0.6 + 0.4 * Math.sin(lonRad * 5 + latRad * 3 + phase))
                            + (rand() - 0.5) * 0.2);
      let dw = lat > 0
        ? (250 + 35 * Math.sin(lonRad * 2 + phase)) % 360   // westerly chop
        : (235 + 30 * Math.sin(lonRad * 3 + phase)) % 360;
      let pw = Math.max(4, 4.5 + hw * 1.8);
      if (hw < 0.15) { hw = 0; dw = 0; pw = 0; }

      // ── Combined field ──
      const hc = Math.sqrt(h1 * h1 + h2 * h2 + h3 * h3 + hw * hw);
      const comps = [
        { h: h1, d: d1, p: p1 },
        { h: h2, d: d2, p: p2 },
        { h: h3, d: d3, p: p3 },
        { h: hw, d: dw, p: pw },
      ];
      let dom = comps[0];
      for (const c of comps) {
        if (c.h * c.h * c.p > dom.h * dom.h * dom.p) dom = c;
      }

      out.height[idx] = hc;
      out.direction[idx] = hc > 0 ? dom.d : 0;
      out.period[idx] = hc > 0 ? dom.p : 0;
      out.parts[0].h[idx] = h1; out.parts[0].d[idx] = d1; out.parts[0].p[idx] = p1;
      out.parts[1].h[idx] = h2; out.parts[1].d[idx] = d2; out.parts[1].p[idx] = p2;
      out.parts[2].h[idx] = h3; out.parts[2].d[idx] = d3; out.parts[2].p[idx] = p3;
      out.windsea.h[idx] = hw; out.windsea.d[idx] = dw; out.windsea.p[idx] = pw;
    }
  }

  return out;
}

/** Parse an SRF2 file we just wrote, returning decoded float32 arrays. */
function readSrf2(filePath) {
  const buf = fs.readFileSync(filePath);
  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== 'SRF2') throw new Error(`${filePath}: not SRF2 (magic=${magic})`);
  const nx = buf.readUInt32LE(4);
  const ny = buf.readUInt32LE(8);
  const nParams = buf.readUInt32LE(28);
  const scales = [];
  for (let p = 0; p < nParams; p++) {
    scales.push({ scale: buf.readFloatLE(32 + p * 8), offset: buf.readFloatLE(36 + p * 8) });
  }
  const dataOffset = 32 + nParams * 8;
  const gridSize = nx * ny;
  const arrays = [];
  for (let p = 0; p < nParams; p++) {
    const src = new Int16Array(buf.buffer, buf.byteOffset + dataOffset + p * gridSize * 2, gridSize);
    const dst = new Float32Array(gridSize);
    const { scale, offset } = scales[p];
    for (let i = 0; i < gridSize; i++) dst[i] = src[i] * scale + offset;
    arrays.push(dst);
  }
  return { nx, ny, nParams, arrays };
}

/** Build the SCUB cube from per-hour SRF2 files we just generated.
 *  Mirrors process-grib.py's build_cube so local dev (demo data) can test the
 *  panel's range-request code path. */
function buildDemoCube(outPath, hours) {
  const gridSize = NX * NY;
  const nHours = hours.length;
  const nParams = 5; // u, v, swell_h, swell_dir, swell_period

  // Read the per-hour grids we just wrote.
  const streams = [[], [], [], [], []]; // one stream per param
  for (const h of hours) {
    const fhr = String(h).padStart(3, '0');
    const w = readSrf2(path.join(DEMO_DIR, `wind_f${fhr}.bin`));
    const s = readSrf2(path.join(DEMO_DIR, `swell_f${fhr}.bin`));
    streams[0].push(w.arrays[0]);
    streams[1].push(w.arrays[1]);
    streams[2].push(s.arrays[0]);
    streams[3].push(s.arrays[1]);
    streams[4].push(s.arrays[2]);
  }

  // Global per-param scale across all hours (keeps decode uniform).
  const scales = streams.map(stream => {
    let maxAbs = 0;
    for (const arr of stream) {
      for (let i = 0; i < arr.length; i++) {
        const v = Math.abs(arr[i]);
        if (v > maxAbs) maxAbs = v;
      }
    }
    return { scale: maxAbs > 0 ? maxAbs / 32000 : 1.0, offset: 0 };
  });

  const headerBytes = 64 + nHours * 4 + nParams * 8;
  const totalBytes = headerBytes + gridSize * nHours * nParams * 2;
  const buf = Buffer.alloc(totalBytes);

  buf.write('SCUB', 0, 4, 'ascii');
  buf.writeUInt32LE(NX, 4);
  buf.writeUInt32LE(NY, 8);
  buf.writeFloatLE(LO1, 12);
  buf.writeFloatLE(LA1, 16);
  buf.writeFloatLE(DX, 20);
  buf.writeFloatLE(DY, 24);
  buf.writeUInt32LE(nHours, 28);
  buf.writeUInt32LE(nParams, 32);
  buf.writeUInt32LE(1, 36); // version

  for (let i = 0; i < nHours; i++) buf.writeUInt32LE(hours[i], 64 + i * 4);
  const scaleBase = 64 + nHours * 4;
  for (let p = 0; p < nParams; p++) {
    buf.writeFloatLE(scales[p].scale, scaleBase + p * 8);
    buf.writeFloatLE(scales[p].offset, scaleBase + p * 8 + 4);
  }

  // Cell-major data section. One Int16 write per (cell, hour, param) slot
  // keeps the layout explicit and portable; Buffer.from on typed arrays has
  // endianness footguns on big-endian platforms.
  let off = headerBytes;
  for (let cellIdx = 0; cellIdx < gridSize; cellIdx++) {
    for (let h = 0; h < nHours; h++) {
      for (let p = 0; p < nParams; p++) {
        const { scale, offset } = scales[p];
        let q = Math.round((streams[p][h][cellIdx] - offset) / scale);
        if (q < -32768) q = -32768;
        else if (q > 32767) q = 32767;
        buf.writeInt16LE(q, off);
        off += 2;
      }
    }
  }

  fs.writeFileSync(outPath, buf);
  const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
  console.log(`\n  Wrote ${outPath} (${sizeMB} MB cube)`);
}

// ── Main ──
console.log('Generating demo data...');

if (!fs.existsSync(DEMO_DIR)) {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
}

const hours = [...FORECAST_HOURS]; // 0-168 @3h + 174-336 @6h (85 steps)

for (const h of hours) {
  const fhr = String(h).padStart(3, '0');

  // Wind
  const { u, v } = generateWindField(h);
  writeBinary(path.join(DEMO_DIR, `wind_f${fhr}.bin`), 2, u, v);

  // Swell (combined) + partitioned swell (3 trains + windsea, 12 params —
  // same layout process-grib.py writes for real GFS-Wave data). Partition
  // files mirror the real pipeline: core range (0–168h) only, so the demo
  // exercises the UI's extended-hour fallback to the combined field.
  const sw = generateSwellField(h);
  writeBinary(path.join(DEMO_DIR, `swell_f${fhr}.bin`), 3, sw.height, sw.direction, sw.period);
  if (h <= BASE_END) {
    writeBinary(path.join(DEMO_DIR, `swellpart_f${fhr}.bin`), 12,
      sw.parts[0].h, sw.parts[0].d, sw.parts[0].p,
      sw.parts[1].h, sw.parts[1].d, sw.parts[1].p,
      sw.parts[2].h, sw.parts[2].d, sw.parts[2].p,
      sw.windsea.h, sw.windsea.d, sw.windsea.p);
  }

  process.stdout.write(`  f${fhr}`);
}

console.log('\n\nDemo data written to data/demo/');
const nPart = hours.filter(h => h <= BASE_END).length;
console.log(`  ${hours.length} wind files + ${hours.length} swell files + ${nPart} swellpart files (0-${BASE_END}h)`);
console.log(`  Grid: ${NX}x${NY} (${DX}° global)`);

buildDemoCube(path.join(DEMO_DIR, 'points.bin'), hours);

console.log('\nRun: npm start');
