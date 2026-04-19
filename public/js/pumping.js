/**
 * pumping.js — "Where it's pumping" top-100 ranking + panel.
 *
 * Core pure functions (tested):
 *   rankNow(spots, windGrid, swellGrid) → top-100 entries for current hour
 *   rankPeak(spots, loadHour, hours)    → top-100 entries by peak score over hour range
 *
 * UI entry points (called from app.js):
 *   initPumping(app), openPumpingPanel, closePumpingPanel, onHourChanged,
 *   invalidatePumpingCache
 */

const TO_RAD = Math.PI / 180;
const TO_DEG = 180 / Math.PI;

/** Angular bilinear interpolation of a direction field (sin/cos weighted sums). */
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

// Mirrors ratings.js sD/wD/oD. Kept inline so this ESM module has no dependency
// on the global-scoped ratings.js functions.
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

  // Optimal swell approaches from opposite of offshore (waves from sea).
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
 * @param {(h:number)=>Promise<{wind, swell}>} loadHour
 * @param {number[]} hoursRange
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

// ─────────────────────────────────────────────────────────────────────────
// Runtime: loader + cache + app wiring
// ─────────────────────────────────────────────────────────────────────────

let _spotsPromise = null;
let _appRef = null;
const _peakCache = new Map(); // key: `${model}|${run}|${mode}` → top-100 results

function loadSpotsOnce() {
  if (_spotsPromise) return _spotsPromise;
  _spotsPromise = Promise.all([
    fetch('data/named-spots.json').then(r => { if (!r.ok) throw new Error('named-spots ' + r.status); return r.json(); }),
    fetch('data/coast-points.json').then(r => { if (!r.ok) throw new Error('coast-points ' + r.status); return r.json(); }),
  ]).then(([named, coast]) => {
    const normalizedCoast = coast.map(c => ({ n: c.n, r: c.c, la: c.la, ln: c.ln, o: c.o }));
    return [...named, ...normalizedCoast];
  }).catch(err => {
    _spotsPromise = null;
    throw err;
  });
  return _spotsPromise;
}

let _gfsPathPromise = null;

export function invalidatePumpingCache() {
  _peakCache.clear();
  _gfsPathPromise = null;
}

export function initPumping(app) {
  _appRef = app;
  document.getElementById('pumping-btn')?.addEventListener('click', openPumpingPanel);
  document.getElementById('pumping-close')?.addEventListener('click', closePumpingPanel);
  document.getElementById('pumping-backdrop')?.addEventListener('click', closePumpingPanel);
  document.querySelectorAll('.pumping-tab').forEach(t => {
    t.addEventListener('click', () => setMode(t.dataset.mode));
  });
}

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

const RATING_COLORS = {
  flat:     '#64748b',
  poor:     '#f59e0b',
  marginal: '#eab308',
  fair:     '#14b8a6',
  good:     '#38bdf8',
  epic:     '#a855f7',
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

async function onRowClick(la, ln, peakHour) {
  // Full integration wired in Task 19. For now: close panel and fly the map.
  closePumpingPanel();
  if (_appRef?.map) _appRef.map.flyTo({ center: [ln, la], zoom: 10, speed: 1.5 });
  if (peakHour != null && _appRef?.setHour) _appRef.setHour(peakHour);
}

function spinnerHtml(text) {
  return `<span class="pumping-spinner"></span>${text}`;
}

async function renderCurrentMode() {
  const status = document.getElementById('pumping-status');
  const list = document.getElementById('pumping-list');
  if (!status || !list) return;

  try {
    status.innerHTML = spinnerHtml('Loading spots...');
    list.innerHTML = '';

    const spots = await loadSpotsOnce();

    if (_currentMode === 'now') {
      const { windGrid, swellGrid } = _appRef;
      if (!windGrid || !swellGrid) {
        status.textContent = 'Forecast data not yet loaded';
        return;
      }
      const ranked = rankNow(spots, windGrid, swellGrid);
      status.textContent = `Top ${ranked.length} — right now`;
      list.innerHTML = ranked.map((e, i) => rowHtml(e, i + 1)).join('');
      wireRowClicks(list);
    } else {
      // Week / next-week rendered in Task 20+
      status.textContent = `(${_currentMode} mode — loading in Task 20)`;
    }
  } catch (err) {
    console.error('pumping render error', err);
    status.innerHTML = `Unable to load spot list. <button id="pumping-retry" style="background:none;border:1px solid var(--border);color:var(--accent);padding:4px 10px;border-radius:4px;cursor:pointer;margin-left:8px;">Retry</button>`;
    document.getElementById('pumping-retry')?.addEventListener('click', renderCurrentMode);
    list.innerHTML = '';
  }
}

let _rerankTimer = null;
export function onHourChanged() {
  if (_currentMode !== 'now') return;
  const panel = document.getElementById('pumping-panel');
  if (!panel?.classList.contains('visible')) return;
  clearTimeout(_rerankTimer);
  _rerankTimer = setTimeout(renderCurrentMode, 150);
}
