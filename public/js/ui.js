/**
 * ui.js — Controls, timeline, legends, and forecast panel
 */

import { WIND_PALETTE, SWELL_PALETTE, interpolatePalette } from './heatmap.js';
import {
  FORECAST_HOURS, N_STEPS, BASE_END, MAX_HOUR,
  hourToIndex, indexToHour, isExtended,
} from './hours.js';

export function initUI(app) {
  initSiteName();
  initModelSelector(app);
  initLayerSelector(app);
  initTimeline(app);
  initLegends();
}

// ── Site name based on domain ──
function initSiteName() {
  const el = document.getElementById('site-name');
  const host = window.location.hostname;
  if (host.includes('spotsblown')) {
    el.textContent = 'SpotsBlown';
    document.title = 'SpotsBlown — Surf Forecast';
  } else if (host.includes('isitgood')) {
    el.textContent = 'Is It Good?';
    document.title = 'Is It Good? — Surf Forecast';
  }
}

// ── Model selector ──
function initModelSelector(app) {
  const btns = document.querySelectorAll('#model-selector .ctrl-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      app.setModel(btn.dataset.model);
    });
  });
}

// ── Layer selector ──
function initLayerSelector(app) {
  const btns = document.querySelectorAll('#layer-selector .ctrl-btn');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      app.setLayer(btn.dataset.layer);
    });
  });
}

// ── Timeline ──
//
// The slider is index-based: its value is a position in FORECAST_HOURS
// (0-168h @3h then 174-336h @6h), not a raw hour. That keeps scrubbing
// smooth across the 168h cadence change — one slider step is always one
// forecast step.
let _sliderEl = null;

function initTimeline(app) {
  const slider = document.getElementById('hour-slider');
  _sliderEl = slider;
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  let playing = false;

  // Index-based slider over the shared hours list.
  slider.min = 0;
  slider.max = N_STEPS - 1;
  slider.step = 1;

  // Tell CSS where the extended (hatched) segment starts, as a fraction of
  // the index axis — matches the thumb position exactly.
  const track = slider.closest('.timeline-track');
  if (track) {
    track.style.setProperty('--ext-split',
      `${(hourToIndex(BASE_END) / (N_STEPS - 1) * 100).toFixed(3)}%`);
  }

  // Coalesce scrub events to one setHour per animation frame — the input
  // event can fire far faster than we can usefully re-render, and each
  // setHour kicks off grid loads + layer updates.
  let pendingHour = null;
  slider.addEventListener('input', () => {
    const hour = indexToHour(parseInt(slider.value));
    updateHourDisplay(hour, app.runTime);  // label stays instant
    if (pendingHour === null) {
      requestAnimationFrame(() => {
        app.setHour(pendingHour);
        pendingHour = null;
      });
    }
    pendingHour = hour;
  });

  async function animateStep() {
    if (!playing) return;
    let idx = parseInt(slider.value) + 1;
    if (idx > N_STEPS - 1) idx = 0;
    slider.value = idx;
    const h = indexToHour(idx);
    updateHourDisplay(h, app.runTime);
    await app.setHourAsync(h);
    // Wait a beat for rendering, then advance
    if (playing) setTimeout(animateStep, 300);
  }

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playIcon.style.display = playing ? 'none' : '';
    pauseIcon.style.display = playing ? '' : 'none';

    if (playing) {
      animateStep();
    }
  });

  // Build tick marks with day names
  buildTicks(app.runTime);

  // Rebuild ticks when run time changes
  app._onRunTimeReady = (runTime) => buildTicks(runTime);
}

/** Move the slider thumb + hour label to a given forecast hour without
 *  re-triggering a load. Used when something other than the slider changes
 *  the app hour (e.g. a pumping-panel peak-hour click). */
export function syncTimeline(hour, runTime) {
  if (!_sliderEl) return;
  _sliderEl.value = hourToIndex(hour);
  updateHourDisplay(hour, runTime);
}

function buildTicks(runTime) {
  const ticks = document.getElementById('timeline-ticks');
  ticks.innerHTML = '';
  const now = runTime || new Date();
  const lastIdx = N_STEPS - 1;

  // Core range (0-168h): day names every 24h, time sub-ticks every 12h.
  // Extended range (>168h): 6h steps compress the axis 2×, so 24h labels
  // land at the same pixel spacing as the core 12h ticks. Alternate days
  // get minor styling so phones (which hide minors) stay uncluttered.
  const addTick = (h, text, cls) => {
    const tick = document.createElement('span');
    tick.textContent = text;
    tick.classList.add(cls);
    if (isExtended(h)) tick.classList.add('tick-ext');
    const idx = hourToIndex(h);
    if (idx === 0) tick.classList.add('tick-first');
    else if (idx === lastIdx) tick.classList.add('tick-last');
    tick.style.left = `${(idx / lastIdx * 100).toFixed(3)}%`;
    ticks.appendChild(tick);
  };

  for (let h = 0; h <= BASE_END; h += 12) {
    const d = new Date(now.getTime() + h * 3600000);
    if (h === 0) {
      addTick(h, 'Now', 'tick-major');
    } else if (h % 24 === 0) {
      addTick(h, d.toLocaleDateString('en-US', { weekday: 'short' }), 'tick-major');
    } else {
      addTick(h, d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }), 'tick-minor');
    }
  }
  for (let h = BASE_END + 24; h <= MAX_HOUR; h += 24) {
    const d = new Date(now.getTime() + h * 3600000);
    const label = d.toLocaleDateString('en-US', { weekday: 'short' });
    // 192, 240, 288, 336 → major; 216, 264, 312 → minor (hidden on phones)
    addTick(h, label, ((h - BASE_END) / 24) % 2 === 1 ? 'tick-major' : 'tick-minor');
  }
}

function updateHourDisplay(hour, runTime) {
  const label = document.querySelector('.hour-label');
  const dateEl = document.getElementById('hour-date');
  const extSuffix = isExtended(hour) ? ' · extended' : '';

  if (runTime) {
    const valid = new Date(runTime.getTime() + hour * 3600000);
    const timeStr = valid.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
    const dayStr = valid.toLocaleDateString('en-US', { weekday: 'short' });

    label.textContent = dayStr + ' ' + timeStr;
    dateEl.textContent =
      valid.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + extSuffix;
  } else {
    label.textContent = hour === 0 ? 'Now' : `+${hour}h`;
    dateEl.textContent = extSuffix ? 'extended' : '';
  }
}

// ── Legends ──
function initLegends() {
  // Wind legend
  const windBar = document.getElementById('wind-legend-bar');
  const windLabels = document.getElementById('wind-legend-labels');
  const maxWind = WIND_PALETTE[WIND_PALETTE.length - 1][0];
  const windGrad = WIND_PALETTE.map(([s, [r, g, b]]) =>
    `rgb(${r},${g},${b}) ${(s / maxWind * 100)}%`
  ).join(', ');
  windBar.style.background = `linear-gradient(to right, ${windGrad})`;
  [0, 5, 10, 15, 20, 25, 30, 35].forEach(v => {
    const span = document.createElement('span');
    span.textContent = v;
    windLabels.appendChild(span);
  });

  // Swell legend
  const swellBar = document.getElementById('swell-legend-bar');
  const swellLabels = document.getElementById('swell-legend-labels');
  const maxSwell = SWELL_PALETTE[SWELL_PALETTE.length - 1][0];
  const swellGrad = SWELL_PALETTE.map(([s, [r, g, b]]) =>
    `rgb(${r},${g},${b}) ${(s / maxSwell * 100)}%`
  ).join(', ');
  swellBar.style.background = `linear-gradient(to right, ${swellGrad})`;
  [0, 1, 2, 3, 4, 6, 8, 10].forEach(v => {
    const span = document.createElement('span');
    span.textContent = v;
    swellLabels.appendChild(span);
  });
}

export function updateLegendVisibility(layer) {
  document.getElementById('wind-legend').style.display =
    (layer === 'wind' || layer === 'both') ? '' : 'none';
  document.getElementById('swell-legend').style.display =
    (layer === 'swell' || layer === 'both') ? '' : 'none';
}


export function setStatus(text) {
  document.getElementById('status').textContent = text;
}
