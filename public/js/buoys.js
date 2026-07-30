/**
 * buoys.js — NDBC buoy layer + observation panel with swell spectrum.
 *
 * Stations render as small instrument-style hollow circles via a MapLibre
 * geojson source (no DOM markers — there are ~900 stations), zoom-gated to
 * z >= 4. Clicking one opens a panel with the latest observation, a swell
 * partition table from the .spec summary and, for spectral stations, a
 * Surfline-style energy-by-period plot with a direction ribbon.
 *
 * Station list is only fetched the first time the layer is enabled; the
 * toggle state persists in localStorage.
 */

import { compassDir, msToMph, mToFt } from './ratings.js';
import { closePanel as closeRatingPanel } from './panel.js';

const LS_KEY = 'buoysEnabled';
const SRC = 'buoy-stations';
const LAYER = 'buoy-circles';
const LAYER_DOT = 'buoy-spectral-dots';

let map = null;
let btnEl = null;
let panelEl = null;
let bodyEl = null;
let enabled = false;
let stationsPromise = null;
let openSeq = 0; // guards against out-of-order panel loads

// ── Init / toggle ──

export function initBuoys(app) {
  map = app.map;
  panelEl = document.getElementById('buoy-panel');
  bodyEl = panelEl.querySelector('.buoy-body');
  document.getElementById('buoy-close').addEventListener('click', closeBuoyPanel);

  btnEl = document.getElementById('buoys-btn');
  btnEl.addEventListener('click', () => setEnabled(!enabled));

  if (localStorage.getItem(LS_KEY) === '1') setEnabled(true);
}

async function setEnabled(on) {
  enabled = on;
  btnEl.classList.toggle('active', on);
  localStorage.setItem(LS_KEY, on ? '1' : '0');
  if (!on) {
    closeBuoyPanel();
    if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', 'none');
    if (map.getLayer(LAYER_DOT)) map.setLayoutProperty(LAYER_DOT, 'visibility', 'none');
    return;
  }
  try {
    await ensureLayer();
    if (!enabled) return; // toggled off while loading
    map.setLayoutProperty(LAYER, 'visibility', 'visible');
    map.setLayoutProperty(LAYER_DOT, 'visibility', 'visible');
  } catch (err) {
    console.error('Buoy layer failed:', err);
    btnEl.classList.remove('active');
    enabled = false;
  }
}

function loadStations() {
  if (!stationsPromise) {
    stationsPromise = fetch('/api/buoys/stations')
      .then(r => { if (!r.ok) throw new Error(`stations ${r.status}`); return r.json(); })
      .catch(err => { stationsPromise = null; throw err; });
  }
  return stationsPromise;
}

async function ensureLayer() {
  if (map.getLayer(LAYER)) return;
  const { stations } = await loadStations();
  if (map.getLayer(LAYER)) return;

  const geojson = {
    type: 'FeatureCollection',
    features: stations.map(s => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      properties: {
        id: s.id, name: s.name,
        hasWave: s.hasWave ? 1 : 0,
        hasSpectral: s.hasSpectral ? 1 : 0,
      },
    })),
  };

  if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: geojson });

  // Hollow instrument circles: dark translucent fill + colored ring.
  // Spectral buoys read brightest, wave buoys mid, met-only stations dim.
  map.addLayer({
    id: LAYER,
    type: 'circle',
    source: SRC,
    minzoom: 4,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3, 7, 5, 10, 7],
      'circle-color': 'rgba(15, 23, 42, 0.55)',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 1.1, 8, 1.6],
      'circle-stroke-color': [
        'case',
        ['==', ['get', 'hasSpectral'], 1], '#38bdf8',
        ['==', ['get', 'hasWave'], 1], '#7ba6c9',
        '#556b83',
      ],
      'circle-stroke-opacity': 0.95,
    },
  });

  // Inner dot marks stations with raw spectral data (the interesting ones).
  map.addLayer({
    id: LAYER_DOT,
    type: 'circle',
    source: SRC,
    minzoom: 4,
    filter: ['==', ['get', 'hasSpectral'], 1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.1, 10, 2.2],
      'circle-color': '#38bdf8',
    },
  });

  map.on('click', LAYER, (e) => {
    const f = e.features && e.features[0];
    if (f) openBuoyPanel(f.properties);
  });
  map.on('mouseenter', LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', LAYER, () => { map.getCanvas().style.cursor = ''; });
}

/** True when a buoy sits under this map click (app.js skips the rating panel). */
export function buoyFeatureAt(e) {
  if (!map || !map.getLayer(LAYER)) return false;
  const feats = map.queryRenderedFeatures(e.point, { layers: [LAYER] });
  return feats.length > 0;
}

// ── Panel ──

export function closeBuoyPanel() {
  openSeq++;
  panelEl.classList.remove('open');
}

async function openBuoyPanel(props) {
  const seq = ++openSeq;
  closeRatingPanel(); // only one right-hand panel at a time
  panelEl.classList.add('open');
  bodyEl.innerHTML = `
    ${headerHTML(props)}
    <div class="bp-loading">Fetching latest observation…</div>`;

  let data = null;
  try {
    const r = await fetch(`/api/buoys/obs?station=${encodeURIComponent(props.id)}`);
    if (r.ok) data = await r.json();
  } catch { /* rendered below as unavailable */ }
  if (seq !== openSeq) return;

  bodyEl.innerHTML = headerHTML(props, data) + obsHTML(data) + partitionHTML(data);

  if (Number(props.hasSpectral)) {
    const slot = document.createElement('div');
    slot.className = 'bp-section';
    slot.innerHTML = `<div class="rp-sec-title">Swell spectrum</div>
      <div class="bp-loading">Loading spectrum…</div>`;
    bodyEl.appendChild(slot);
    try {
      const r = await fetch(`/api/buoys/spectrum?station=${encodeURIComponent(props.id)}`);
      if (seq !== openSeq) return;
      if (!r.ok) throw new Error(`spectrum ${r.status}`);
      const spectrum = await r.json();
      slot.innerHTML = `<div class="rp-sec-title">Swell spectrum
          <span class="bp-age">${ageText(spectrum.time)}</span></div>`
        + spectrumSVG(spectrum)
        + `<div class="bp-spec-note">Wave energy by period · arrows show where each band is heading</div>`;
    } catch (err) {
      if (seq !== openSeq) return;
      slot.innerHTML = `<div class="rp-sec-title">Swell spectrum</div>
        <div class="bp-loading">No spectral data right now.</div>`;
    }
  }
}

// ── Panel sections ──

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ageText(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 90) return `${mins} min ago`;
  const hrs = Math.round(mins / 6) / 10;
  return `${hrs} hr ago`;
}

const cToF = (c) => c * 9 / 5 + 32;
const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d));

function headerHTML(props, data) {
  const age = data?.obs?.time || data?.spec?.time;
  return `
    <div class="rp-header bp-header">
      <div class="rp-spot-name">${esc(props.name) || `Buoy ${esc(props.id)}`}</div>
      <div class="rp-coords">NDBC ${esc(props.id)}
        ${age ? `<span class="bp-age">· updated ${ageText(age)}</span>` : ''}</div>
    </div>`;
}

function obsHTML(data) {
  if (!data || (!data.obs && !data.spec)) {
    return `<div class="bp-loading">No recent observation from this station.</div>`;
  }
  const waves = data.obs?.waves;
  const wvht = waves?.heightM ?? data.spec?.waveHeightM ?? null;
  const dpd = waves?.dominantPeriodS ?? data.spec?.swell?.periodS ?? null;
  const mwd = waves?.dirDeg ?? data.spec?.meanDirDeg ?? null;
  const wind = data.obs?.wind;

  const hero = `
    <div class="bp-hero">
      <div class="bp-hero-cell">
        <div class="bp-hero-val">${wvht != null ? mToFt(wvht).toFixed(1) : '—'}<span class="bp-hero-unit">ft</span></div>
        <div class="bp-hero-label">Wave height</div>
      </div>
      <div class="bp-hero-cell">
        <div class="bp-hero-val">${dpd != null ? Math.round(dpd) : '—'}<span class="bp-hero-unit">s</span></div>
        <div class="bp-hero-label">Dominant period</div>
      </div>
      <div class="bp-hero-cell">
        <div class="bp-hero-val">${mwd != null
          ? `${dirArrowSVG(mwd)}${compassDir(mwd)}` : '—'}</div>
        <div class="bp-hero-label">${mwd != null ? `from ${Math.round(mwd)}°` : 'Direction'}</div>
      </div>
    </div>`;

  const rows = [];
  if (wind && wind.speedMs != null) {
    const gust = wind.gustMs != null ? ` <span class="bp-sub">g ${Math.round(msToMph(wind.gustMs))}</span>` : '';
    const dir = wind.dirDeg != null ? `${compassDir(wind.dirDeg)} ` : '';
    rows.push(['Wind', `${dir}${Math.round(msToMph(wind.speedMs))}<span class="bp-unit">mph</span>${gust}`]);
  }
  if (data.obs?.waterTempC != null) {
    rows.push(['Water', `${fmt(cToF(data.obs.waterTempC), 0)}<span class="bp-unit">°F</span>`]);
  }
  if (data.obs?.airTempC != null) {
    rows.push(['Air', `${fmt(cToF(data.obs.airTempC), 0)}<span class="bp-unit">°F</span>`]);
  }
  if (data.obs?.pressureHpa != null) {
    const tend = data.obs.pressureTendencyHpa;
    const arrow = tend == null ? '' : tend > 0.3 ? ' ↑' : tend < -0.3 ? ' ↓' : ' →';
    rows.push(['Pressure', `${fmt(data.obs.pressureHpa, 1)}<span class="bp-unit">hPa</span><span class="bp-sub">${arrow}</span>`]);
  }
  if (waves?.avgPeriodS != null) {
    rows.push(['Avg period', `${fmt(waves.avgPeriodS, 1)}<span class="bp-unit">s</span>`]);
  }

  const meta = rows.length ? `
    <div class="bp-meta">
      ${rows.map(([k, v]) => `
        <div class="bp-meta-row">
          <span class="bp-meta-label">${k}</span>
          <span class="bp-meta-val">${v}</span>
        </div>`).join('')}
    </div>` : '';

  return hero + meta;
}

function partitionHTML(data) {
  const spec = data?.spec;
  if (!spec || (!spec.swell && !spec.windWave)) return '';
  const row = (label, p, cls) => p ? `
    <div class="bp-part-row">
      <span class="bp-part-dot ${cls}"></span>
      <span class="bp-part-label">${label}</span>
      <span class="bp-part-val">${p.heightM != null ? mToFt(p.heightM).toFixed(1) : '—'}<span class="bp-unit">ft</span></span>
      <span class="bp-part-val">${p.periodS != null ? p.periodS.toFixed(1) : '—'}<span class="bp-unit">s</span></span>
      <span class="bp-part-val">${esc(p.dirCard) || '—'}</span>
    </div>` : '';
  const steep = spec.steepness && spec.steepness !== 'N/A'
    ? `<span class="bp-steep">${esc(spec.steepness.toLowerCase().replace(/_/g, ' '))}</span>` : '';
  return `
    <div class="bp-section">
      <div class="rp-sec-title">Swell partitions ${steep}</div>
      <div class="bp-part-head">
        <span></span><span></span><span>height</span><span>period</span><span>dir</span>
      </div>
      ${row('Swell', spec.swell, 'bp-dot-swell')}
      ${row('Wind sea', spec.windWave, 'bp-dot-sea')}
    </div>`;
}

/** Small inline arrow showing where the swell is going (dir = coming FROM). */
function dirArrowSVG(fromDeg, size = 14) {
  const rot = (fromDeg + 180) % 360; // travel direction
  return `<svg class="bp-dir-arrow" width="${size}" height="${size}" viewBox="0 0 16 16"
      style="transform: rotate(${rot}deg)">
    <path d="M8 1.5 L11.5 12 L8 9.5 L4.5 12 Z" fill="currentColor"/>
  </svg>`;
}

// ── Spectrum plot (inline SVG, no libraries) ──

function spectrumSVG(spectrum) {
  const all = (spectrum.bins || []).filter(b => b.freq > 0 && b.energy != null);
  if (all.length < 4) return `<div class="bp-loading">Not enough spectral bins.</div>`;

  // Drop the flat high-frequency tail beyond 3.3s — surf-irrelevant chop.
  const bins = all.filter(b => b.freq <= 0.305);

  const W = 354, H = 210;
  const M = { l: 36, r: 10, t: 34, b: 26 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;

  const lf0 = Math.log(bins[0].freq);
  const lf1 = Math.log(bins[bins.length - 1].freq);
  const X = (f) => M.l + ((Math.log(f) - lf0) / (lf1 - lf0)) * iw;
  const eMax = Math.max(...bins.map(b => b.energy), 0.01);
  const Y = (e) => M.t + ih - (e / (eMax * 1.06)) * ih;

  // Smooth area path (Catmull-Rom → cubic bezier)
  const pts = bins.map(b => [X(b.freq), Y(b.energy)]);
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1],
          p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  const area = `${d} L ${pts[pts.length - 1][0].toFixed(1)} ${M.t + ih} L ${pts[0][0].toFixed(1)} ${M.t + ih} Z`;

  // Period ticks (x axis, log-spaced in freq → natural for surfers)
  const pMin = 1 / bins[bins.length - 1].freq, pMax = 1 / bins[0].freq;
  const ticks = [25, 20, 16, 13, 10, 8, 6, 5, 4]
    .filter(p => p >= pMin * 1.02 && p <= pMax * 0.98);
  const tickEls = ticks.map(p => {
    const x = X(1 / p).toFixed(1);
    return `<line x1="${x}" y1="${M.t + ih}" x2="${x}" y2="${M.t + ih + 4}" stroke="rgba(148,163,184,0.4)"/>
      <text x="${x}" y="${H - 8}" class="bps-tick" text-anchor="middle">${p}s</text>`;
  }).join('');

  // Y gridlines
  const grid = [0.25, 0.5, 0.75, 1].map(k => {
    const y = (M.t + ih - k * ih).toFixed(1);
    return `<line x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}" stroke="rgba(148,163,184,0.08)"/>`;
  }).join('');
  const yLabel = `<text x="${M.l - 6}" y="${M.t + 4}" class="bps-tick" text-anchor="end">${eMax >= 10 ? eMax.toFixed(0) : eMax.toFixed(1)}</text>
    <text x="${M.l - 6}" y="${M.t + ih}" class="bps-tick" text-anchor="end">0</text>
    <text x="12" y="${M.t + ih / 2}" class="bps-tick" text-anchor="middle"
      transform="rotate(-90 12 ${M.t + ih / 2})">m²/Hz</text>`;

  // Dominant period marker (peak energy bin)
  const peak = bins.reduce((a, b) => (b.energy > a.energy ? b : a));
  const px = X(peak.freq), py = Y(peak.energy);
  // Label above the marker; if the peak crowds the top edge, shift it beside.
  const labelAbove = py - 10 > M.t + 8;
  const plx = labelAbove ? px : px + 14;
  const ply = labelAbove ? py - 10 : py + 3;
  const peakEl = `
    <line x1="${px}" y1="${py.toFixed(1)}" x2="${px}" y2="${M.t + ih}" stroke="rgba(56,189,248,0.5)" stroke-dasharray="3 3"/>
    <circle cx="${px}" cy="${py.toFixed(1)}" r="3.5" fill="#38bdf8" stroke="#0f172a" stroke-width="1.5"/>
    <text x="${plx.toFixed(1)}" y="${ply.toFixed(1)}" class="bps-peak"
      text-anchor="${labelAbove ? 'middle' : 'start'}">${(1 / peak.freq).toFixed(0)}s</text>`;

  // Swell / wind-sea separation frequency
  let sepEl = '';
  if (spectrum.sepFreq && spectrum.sepFreq > bins[0].freq && spectrum.sepFreq < bins[bins.length - 1].freq) {
    const sx = X(spectrum.sepFreq).toFixed(1);
    sepEl = `
      <line x1="${sx}" y1="${M.t - 4}" x2="${sx}" y2="${M.t + ih}" stroke="rgba(148,163,184,0.22)" stroke-dasharray="2 4"/>
      <text x="${sx - 5}" y="${M.t - 6}" class="bps-zone" text-anchor="end">swell</text>
      <text x="${Number(sx) + 5}" y="${M.t - 6}" class="bps-zone" text-anchor="start">wind sea</text>`;
  }

  // Direction ribbon: arrows above the plot for energetic bins with direction
  const dirBins = bins.filter(b => b.dir != null && b.energy > eMax * 0.12);
  const step = Math.max(1, Math.ceil(dirBins.length / 11));
  const arrows = dirBins.filter((_, i) => i % step === 0).map(b => {
    const x = X(b.freq).toFixed(1);
    const rot = (b.dir + 180) % 360;
    const strong = b.energy > eMax * 0.5;
    return `<g transform="translate(${x} ${M.t - 21}) rotate(${rot})"
        opacity="${strong ? 0.95 : 0.55}">
      <path d="M0 -5.5 L3 4.5 L0 2.4 L-3 4.5 Z" fill="${strong ? '#7dd3fc' : '#94a3b8'}"/>
    </g>`;
  }).join('');

  return `
  <svg class="bp-spectrum" viewBox="0 0 ${W} ${H}" role="img"
       aria-label="Swell spectrum: wave energy by period">
    <defs>
      <linearGradient id="bps-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(56,189,248,0.55)"/>
        <stop offset="65%" stop-color="rgba(56,189,248,0.18)"/>
        <stop offset="100%" stop-color="rgba(56,189,248,0.03)"/>
      </linearGradient>
    </defs>
    ${grid}
    ${sepEl}
    <path d="${area}" fill="url(#bps-fill)"/>
    <path d="${d}" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linejoin="round"/>
    ${peakEl}
    <line x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}" stroke="rgba(148,163,184,0.3)"/>
    ${tickEls}
    ${yLabel}
    ${arrows}
  </svg>`;
}
