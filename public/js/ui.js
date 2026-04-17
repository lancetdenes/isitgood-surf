/**
 * ui.js — Controls, timeline, legends, and forecast panel
 */

import { WIND_PALETTE, SWELL_PALETTE, interpolatePalette } from './heatmap.js';

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
function initTimeline(app) {
  const slider = document.getElementById('hour-slider');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  let playing = false;
  let interval = null;

  slider.addEventListener('input', () => {
    app.setHour(parseInt(slider.value));
    updateHourDisplay(parseInt(slider.value), app.runTime);
  });

  let animating = false;
  async function animateStep() {
    if (!playing) return;
    let h = parseInt(slider.value) + 3;
    if (h > parseInt(slider.max)) h = 0;
    slider.value = h;
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

function buildTicks(runTime) {
  const ticks = document.getElementById('timeline-ticks');
  ticks.innerHTML = '';
  const now = runTime || new Date();
  // Show day labels at 24h intervals with 12h sub-ticks
  for (let h = 0; h <= 168; h += 12) {
    const tick = document.createElement('span');
    const d = new Date(now.getTime() + h * 3600000);
    if (h === 0) {
      tick.textContent = 'Now';
      tick.classList.add('tick-major');
    } else if (h % 24 === 0) {
      tick.textContent = d.toLocaleDateString('en-US', { weekday: 'short' });
      tick.classList.add('tick-major');
    } else {
      tick.textContent = d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      tick.classList.add('tick-minor');
    }
    ticks.appendChild(tick);
  }
}

function updateHourDisplay(hour, runTime) {
  const label = document.querySelector('.hour-label');
  const dateEl = document.getElementById('hour-date');

  if (runTime) {
    const valid = new Date(runTime.getTime() + hour * 3600000);
    const timeStr = valid.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
    const dayStr = valid.toLocaleDateString('en-US', { weekday: 'short' });

    if (hour === 0) {
      label.textContent = dayStr + ' ' + timeStr;
    } else {
      label.textContent = dayStr + ' ' + timeStr;
    }
    dateEl.textContent = valid.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } else {
    label.textContent = hour === 0 ? 'Now' : `+${hour}h`;
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
