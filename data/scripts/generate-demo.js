#!/usr/bin/env node

/**
 * generate-demo.js — Creates realistic demo wind + swell binary grid files
 * so the app works out of the box without downloading real GRIB data.
 *
 * Run: node data/scripts/generate-demo.js
 * Output: data/demo/wind_f000.bin ... wind_f168.bin
 *         data/demo/swell_f000.bin ... swell_f168.bin
 */

const fs = require('fs');
const path = require('path');

const DEMO_DIR = path.join(__dirname, '..', 'demo');

// Grid dimensions (1-degree global grid)
const NX = 360;
const NY = 181;
const LO1 = 0;     // first lon
const LA1 = 90;    // first lat (north to south)
const DX = 1.0;
const DY = 1.0;

function writeBinary(filePath, nParams, ...arrays) {
  const gridSize = NX * NY;
  const bufSize = 32 + nParams * gridSize * 4;
  const buf = Buffer.alloc(bufSize);

  // Header
  buf.write('SURF', 0, 4, 'ascii');
  buf.writeUInt32LE(NX, 4);
  buf.writeUInt32LE(NY, 8);
  buf.writeFloatLE(LO1, 12);
  buf.writeFloatLE(LA1, 16);
  buf.writeFloatLE(DX, 20);
  buf.writeFloatLE(DY, 24);
  buf.writeUInt32LE(nParams, 28);

  // Data arrays
  for (let p = 0; p < nParams; p++) {
    const offset = 32 + p * gridSize * 4;
    for (let i = 0; i < gridSize; i++) {
      buf.writeFloatLE(arrays[p][i], offset + i * 4);
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

function generateSwellField(hourOffset) {
  const height = new Float32Array(NX * NY);
  const direction = new Float32Array(NX * NY);
  const period = new Float32Array(NX * NY);

  const phase = hourOffset * 0.02;

  for (let j = 0; j < NY; j++) {
    const lat = LA1 - j * DY;
    const latRad = lat * Math.PI / 180;

    for (let i = 0; i < NX; i++) {
      const lon = LO1 + i * DX;
      const lonRad = lon * Math.PI / 180;
      const idx = j * NX + i;

      if (!isOcean(lat, lon)) {
        height[idx] = 0;
        direction[idx] = 0;
        period[idx] = 0;
        continue;
      }

      // Base swell from dominant storm regions
      // North Atlantic swell
      const naSwell = 2.5 * Math.exp(-0.5 * Math.pow((lat - 50) / 15, 2)) *
                      Math.exp(-0.5 * Math.pow((lon - 330) / 30, 2));

      // South Pacific swell
      const spSwell = 2.0 * Math.exp(-0.5 * Math.pow((lat + 45) / 12, 2));

      // Wind swell (locally generated)
      const windSwell = 0.8 + 0.5 * Math.sin(lonRad * 5 + latRad * 3 + phase);

      // Total
      const h = Math.max(0, naSwell + spSwell * 0.3 + windSwell + (rand() - 0.5) * 0.4);

      // Direction — generally from dominant storm direction
      let dir;
      if (lat > 20) {
        dir = 270 + 30 * Math.sin(lonRad * 2 + phase);  // From NW
      } else if (lat < -20) {
        dir = 210 + 20 * Math.sin(lonRad * 3 + phase);  // From SW
      } else {
        dir = 240 + 40 * Math.sin(lonRad * 2 + phase);  // Variable
      }

      // Period correlates with swell height
      const p = 6 + h * 2.5 + (rand() - 0.5) * 2;

      height[idx] = h;
      direction[idx] = ((dir % 360) + 360) % 360;
      period[idx] = Math.max(4, p);
    }
  }

  return { height, direction, period };
}

// ── Main ──
console.log('Generating demo data...');

if (!fs.existsSync(DEMO_DIR)) {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
}

const hours = [];
for (let h = 0; h <= 168; h += 3) hours.push(h);

for (const h of hours) {
  const fhr = String(h).padStart(3, '0');

  // Wind
  const { u, v } = generateWindField(h);
  writeBinary(path.join(DEMO_DIR, `wind_f${fhr}.bin`), 2, u, v);

  // Swell
  const { height, direction, period } = generateSwellField(h);
  writeBinary(path.join(DEMO_DIR, `swell_f${fhr}.bin`), 3, height, direction, period);

  process.stdout.write(`  f${fhr}`);
}

console.log('\n\nDemo data written to data/demo/');
console.log(`  ${hours.length} wind files + ${hours.length} swell files`);
console.log(`  Grid: ${NX}x${NY} (1° global)`);
console.log('\nRun: npm start');
