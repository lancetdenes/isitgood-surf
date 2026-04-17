const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const SCRIPTS_DIR = path.join(DATA_DIR, 'scripts');

// Enable gzip compression for all responses
app.use(compression());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Serve data files with caching headers (binary grids don't change within a run)
app.use('/data', express.static(DATA_DIR, {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.bin')) {
      res.set('Content-Type', 'application/octet-stream');
    }
  }
}));

// Completed-run filter: hide in-flight uploads (`*.tmp`) and rollback dirs (`*.old`).
// Guarantees clients never see a partially-written run.
const isPublishedRun = (d) => !d.endsWith('.tmp') && !d.endsWith('.old');

// --- API: list available model runs ---
app.get('/api/runs/:model', (req, res) => {
  const model = req.params.model;
  const modelDir = path.join(DATA_DIR, model);

  if (!fs.existsSync(modelDir)) {
    return res.json({ runs: [] });
  }

  const runs = fs.readdirSync(modelDir)
    .filter(d => fs.statSync(path.join(modelDir, d)).isDirectory())
    .filter(isPublishedRun)
    .sort()
    .reverse();

  res.json({ runs });
});

// --- API: metadata for a specific run ---
app.get('/api/runs/:model/:run', (req, res) => {
  const { model, run } = req.params;
  const runDir = path.join(DATA_DIR, model, run);

  if (!fs.existsSync(runDir)) {
    return res.status(404).json({ error: 'Run not found' });
  }

  const files = fs.readdirSync(runDir).filter(f => f.endsWith('.bin'));
  const windHours = files
    .filter(f => f.startsWith('wind_'))
    .map(f => parseInt(f.match(/f(\d+)/)?.[1] ?? '0'))
    .sort((a, b) => a - b);
  const swellHours = files
    .filter(f => f.startsWith('swell_'))
    .map(f => parseInt(f.match(/f(\d+)/)?.[1] ?? '0'))
    .sort((a, b) => a - b);

  res.json({ model, run, windHours, swellHours });
});

// --- API: latest run redirect ---
app.get('/api/latest/:model', (req, res) => {
  const model = req.params.model;
  const modelDir = path.join(DATA_DIR, model);

  if (!fs.existsSync(modelDir)) {
    // Fall back to demo data
    const demoDir = path.join(DATA_DIR, 'demo');
    if (fs.existsSync(demoDir)) {
      return res.json({ model: 'demo', run: 'demo', path: '/data/demo' });
    }
    return res.status(404).json({ error: 'No data available' });
  }

  const runs = fs.readdirSync(modelDir)
    .filter(d => fs.statSync(path.join(modelDir, d)).isDirectory())
    .filter(isPublishedRun)
    .sort()
    .reverse();

  if (runs.length === 0) {
    const demoDir = path.join(DATA_DIR, 'demo');
    if (fs.existsSync(demoDir)) {
      return res.json({ model: 'demo', run: 'demo', path: '/data/demo' });
    }
    return res.status(404).json({ error: 'No runs available' });
  }

  const run = runs[0];
  res.json({ model, run, path: `/data/${model}/${run}` });
});

// --- API: point forecast (server-side interpolation) ---
// Returns all forecast hours for a single lat/lon in one request.
// This avoids the client downloading 57+ binary grid files individually.

// Binary grid parser (matches public/js/grid.js)
function parseGrid(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'SURF') return null;

  const nx = view.getUint32(4, true);
  const ny = view.getUint32(8, true);
  const lo1 = view.getFloat32(12, true);
  const la1 = view.getFloat32(16, true);
  const dx = view.getFloat32(20, true);
  const dy = view.getFloat32(24, true);
  const nParams = view.getUint32(28, true);
  const gridSize = nx * ny;

  const arrays = [];
  for (let p = 0; p < nParams; p++) {
    const offset = 32 + p * gridSize * 4;
    arrays.push(new Float32Array(buffer.buffer, buffer.byteOffset + offset, gridSize));
  }
  return { nx, ny, lo1, la1, dx, dy, arrays };
}

function interpolateGrid(grid, lon, lat) {
  let fi = (lon - grid.lo1) / grid.dx;
  const fj = (grid.la1 - lat) / grid.dy;
  while (fi < 0) fi += grid.nx;
  while (fi >= grid.nx) fi -= grid.nx;
  if (fj < 0 || fj >= grid.ny - 1) return null;

  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const fx = fi - i0, fy = fj - j0;
  const i1 = (i0 + 1) % grid.nx;
  const j1 = Math.min(j0 + 1, grid.ny - 1);
  const idx00 = j0 * grid.nx + i0, idx10 = j0 * grid.nx + i1;
  const idx01 = j1 * grid.nx + i0, idx11 = j1 * grid.nx + i1;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;

  return grid.arrays.map(a => w00 * a[idx00] + w10 * a[idx10] + w01 * a[idx01] + w11 * a[idx11]);
}

/** Angular interpolation for direction values (handles 350°↔10° wrapping) */
function interpolateAngle(grid, paramIdx, lon, lat) {
  let fi = (lon - grid.lo1) / grid.dx;
  const fj = (grid.la1 - lat) / grid.dy;
  while (fi < 0) fi += grid.nx;
  while (fi >= grid.nx) fi -= grid.nx;
  if (fj < 0 || fj >= grid.ny - 1) return 0;

  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const fx = fi - i0, fy = fj - j0;
  const i1 = (i0 + 1) % grid.nx;
  const j1 = Math.min(j0 + 1, grid.ny - 1);
  const a = grid.arrays[paramIdx];
  const idx00 = j0 * grid.nx + i0, idx10 = j0 * grid.nx + i1;
  const idx01 = j1 * grid.nx + i0, idx11 = j1 * grid.nx + i1;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy, w11 = fx * fy;

  // Convert to unit vectors, interpolate, convert back
  const toRad = Math.PI / 180;
  const sinSum = w00 * Math.sin(a[idx00] * toRad) + w10 * Math.sin(a[idx10] * toRad)
               + w01 * Math.sin(a[idx01] * toRad) + w11 * Math.sin(a[idx11] * toRad);
  const cosSum = w00 * Math.cos(a[idx00] * toRad) + w10 * Math.cos(a[idx10] * toRad)
               + w01 * Math.cos(a[idx01] * toRad) + w11 * Math.cos(a[idx11] * toRad);
  return (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;
}

// Cache parsed grids in memory (key = file path)
const gridCache = new Map();
// Sized to hold a full run in memory (57 wind × 8 MB + 57 swell × 1.3 MB ≈ 530 MB)
// plus headroom for a partial incoming run during atomic swap. Too-low values
// (< 114) cause catastrophic cache thrashing on /api/forecast (one request
// touches every file in the run).
const CACHE_MAX = 150;
const fsPromises = require('fs').promises;

async function loadGridAsync(filePath) {
  if (gridCache.has(filePath)) return gridCache.get(filePath);
  try {
    await fsPromises.access(filePath);
  } catch { return null; }
  const buf = await fsPromises.readFile(filePath);
  const grid = parseGrid(buf);
  if (grid) {
    if (gridCache.size >= CACHE_MAX) {
      const firstKey = gridCache.keys().next().value;
      gridCache.delete(firstKey);
    }
    gridCache.set(filePath, grid);
  }
  return grid;
}

// Read a grid, interpolate a single point, return the values (no caching for large files)
async function interpolatePoint(filePath, lon, lat) {
  // Check cache first (wind grids are small enough to cache)
  if (gridCache.has(filePath)) {
    return interpolateGrid(gridCache.get(filePath), lon, lat);
  }
  try {
    await fsPromises.access(filePath);
  } catch { return null; }
  const buf = await fsPromises.readFile(filePath);
  const grid = parseGrid(buf);
  if (!grid) return null;

  // Cache all grids now that swell is downsampled to ~1.2MB
  if (gridCache.size >= CACHE_MAX) {
    const firstKey = gridCache.keys().next().value;
    gridCache.delete(firstKey);
  }
  gridCache.set(filePath, grid);

  return interpolateGrid(grid, lon, lat);
}

app.get('/api/forecast', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const dataPath = req.query.path;

  if (isNaN(lat) || isNaN(lon) || !dataPath) {
    return res.status(400).json({ error: 'Missing lat, lon, or path' });
  }

  const runDir = path.join(__dirname, dataPath.replace(/^\//, ''));
  try { await fsPromises.access(runDir); } catch {
    return res.status(404).json({ error: 'Run not found' });
  }

  const hours = [];
  let lastSwellValues = null; // Fallback for missing hours

  // Process sequentially to avoid memory spikes (swell files are ~30MB each)
  for (let h = 0; h <= 168; h += 3) {
    const fhr = String(h).padStart(3, '0');
    const entry = {
      hour: h,
      windSpeedMs: 0, windDir: 0,
      swellHeightM: 0, swellDir: 0, swellPeriod: 0,
    };

    // Wind (cached, small files)
    const w = await interpolatePoint(path.join(runDir, `wind_f${fhr}.bin`), lon, lat);
    if (w) {
      entry.windSpeedMs = Math.sqrt(w[0] * w[0] + w[1] * w[1]);
      entry.windDir = (Math.atan2(-w[0], -w[1]) * 180 / Math.PI + 360) % 360;
    }

    // Swell — use angular interpolation for direction
    const swellGrid = await loadGridAsync(path.join(runDir, `swell_f${fhr}.bin`));
    if (swellGrid) {
      const s = interpolateGrid(swellGrid, lon, lat);
      if (s) {
        entry.swellHeightM = s[0];
        entry.swellDir = interpolateAngle(swellGrid, 1, lon, lat);
        entry.swellPeriod = s[2];
        lastSwellValues = [s[0], entry.swellDir, s[2]];
      }
    } else if (lastSwellValues) {
      entry.swellHeightM = lastSwellValues[0];
      entry.swellDir = lastSwellValues[1];
      entry.swellPeriod = lastSwellValues[2];
    }

    hours.push(entry);
  }

  // Detect coast angle from swell grid data
  // Sample swell height in a ring around the click point. Directions with
  // non-zero swell = ocean; zero swell = land. The boundary = coastline.
  let coastInfo = null;
  const swellGrid0 = await loadGridAsync(path.join(runDir, 'swell_f000.bin'));
  if (swellGrid0) {
    coastInfo = detectCoastFromGrid(swellGrid0, lon, lat);
  }

  res.json({ lat, lon, hours, coast: coastInfo });
});

/**
 * Detect coast angle by sampling swell height in a circle around a point.
 * Ocean has swell > 0, land has swell = 0. The boundary is the coastline.
 */
function detectCoastFromGrid(grid, lon, lat) {
  const numSamples = 24; // every 15 degrees
  const offsets = [0.15, 0.25, 0.4]; // sample at multiple distances (~17km, 28km, 45km)
  const toRad = Math.PI / 180;
  const oceanDirs = []; // directions that have swell (ocean)

  for (let i = 0; i < numSamples; i++) {
    const angle = (i / numSamples) * 360;
    let hasWater = false;

    for (const dist of offsets) {
      const testLat = lat + dist * Math.cos(angle * toRad);
      const testLon = lon + dist * Math.sin(angle * toRad);
      const vals = interpolateGrid(grid, testLon, testLat);
      if (vals && vals[0] > 0.05) { // swell height > 5cm = water
        hasWater = true;
        break;
      }
    }

    if (hasWater) {
      oceanDirs.push(angle);
    }
  }

  if (oceanDirs.length === 0 || oceanDirs.length === numSamples) {
    return null; // All ocean or all land — can't determine coast
  }

  // Seaward direction: average of ocean directions (angular mean)
  let sinSum = 0, cosSum = 0;
  for (const dir of oceanDirs) {
    sinSum += Math.sin(dir * toRad);
    cosSum += Math.cos(dir * toRad);
  }
  const seawardDir = (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;

  // Coast bearing: perpendicular to seaward direction
  const coastBearing = (seawardDir + 90) % 360;

  // Offshore direction: opposite of seaward
  const offshoreDir = (seawardDir + 180) % 360;

  return { coastBearing, seawardDir, offshoreDir };
}

// --- Scheduled data updates ---

let updateRunning = false;

function runUpdate(model) {
  if (updateRunning) {
    console.log(`  [scheduler] Skipping ${model} update — previous update still running`);
    return;
  }
  updateRunning = true;
  const startTime = Date.now();
  console.log(`  [scheduler] Starting ${model} update...`);

  execFile('nice', ['-n', '19', 'bash', path.join(SCRIPTS_DIR, 'update.sh'), model], {
    timeout: 45 * 60 * 1000, // 45 min timeout (downloads are large)
    env: { ...process.env, PATH: `/app/.venv/bin:${process.env.PATH}` },
  }, (err, stdout, stderr) => {
    updateRunning = false;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    if (err) {
      console.error(`  [scheduler] ${model} update failed after ${elapsed}s:`, err.message);
      if (stderr) console.error(stderr);
    } else {
      console.log(`  [scheduler] ${model} update complete (${elapsed}s)`);
    }
    if (stdout) console.log(stdout);
  });
}

function startScheduler() {
  // GFS runs at 00, 06, 12, 18 UTC — data available ~5h later
  const GFS_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // every 6 hours

  // Delay initial update to let server stabilize and cache warm up
  setTimeout(() => runUpdate('gfs'), 10 * 60 * 1000);    // 10 min after boot

  // Schedule recurring updates
  setInterval(() => runUpdate('gfs'), GFS_CHECK_INTERVAL);

  console.log('  [scheduler] Auto-update enabled: GFS every 6h');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Is It Good? running at http://0.0.0.0:${PORT}\n`);

  // Check for data
  const hasGfs = fs.existsSync(path.join(DATA_DIR, 'gfs')) &&
    fs.readdirSync(path.join(DATA_DIR, 'gfs')).length > 0;
  const hasDemo = fs.existsSync(path.join(DATA_DIR, 'demo')) &&
    fs.readdirSync(path.join(DATA_DIR, 'demo')).length > 0;

  if (!hasGfs && !hasDemo) {
    console.log('  No weather data found. Run: npm run demo');
    console.log('  (generates demo data so you can test the app)\n');
  }

  // Warm up grid cache on startup so first forecast click is fast
  warmupCache();

  // Updates are handled externally by GitHub Actions, which processes GRIBs
  // on a free runner and uploads the finished .bin files via SSH. To re-enable
  // in-process scheduling, set ENABLE_SCHEDULER=1.
  if (process.env.ENABLE_SCHEDULER === '1') {
    startScheduler();
  }
});

function warmupCache() {
  // Find the latest run directory and load grids in background
  // Uses setImmediate between files to avoid blocking the event loop
  for (const model of ['gfs']) {
    const modelDir = path.join(DATA_DIR, model);
    if (!fs.existsSync(modelDir)) continue;
    const runs = fs.readdirSync(modelDir).filter(d => {
      try { return fs.statSync(path.join(modelDir, d)).isDirectory(); } catch { return false; }
    }).sort().reverse();
    if (runs.length === 0) continue;

    const runDir = path.join(modelDir, runs[0]);
    console.log(`  [cache] Warming up ${model}/${runs[0]}...`);

    const files = [];
    for (let h = 0; h <= 168; h += 3) {
      const fhr = String(h).padStart(3, '0');
      files.push(path.join(runDir, `wind_f${fhr}.bin`));
      files.push(path.join(runDir, `swell_f${fhr}.bin`));
    }

    let idx = 0;
    function loadNext() {
      if (idx >= files.length) {
        console.log(`  [cache] Cached ${files.length} files for ${model}/${runs[0]}`);
        return;
      }
      loadGridAsync(files[idx]).then(() => {
        idx++;
        setImmediate(loadNext); // yield to event loop between files
      });
    }
    loadNext();
    break;
  }
}
