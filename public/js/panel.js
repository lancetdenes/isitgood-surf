/**
 * panel.js — Surf rating sidebar panel
 *
 * Renders the full rating panel: overall score, compass diagram,
 * hourly scroll with mini compasses, and 7-day outlook.
 */

import {
  rateSwell, rateWind, rateOverall, overallRating, subRating,
  ratingBgColor, compassDir, msToMph, mToFt
} from './ratings.js';
import { computeForecast } from './forecast.js';
import { findNearestCoast, reverseGeocode, getCoastSnippet } from './coastline.js';
import { renderCompass as renderCompassSvg } from './compass-render.js';
import { renderMapCompassHTML, mountMapCompass, unmountAllMapCompasses } from './compass-map.js';

// ── State ──

let panelEl = null;
let currentData = null;   // { lat, lon, coast, hours[] }
let selectedDayIdx = 0;
let selectedHourIdx = 0;

// ── Initialization ──

export function initPanel() {
  panelEl = document.getElementById('rating-panel');
  document.getElementById('rating-close').addEventListener('click', closePanel);
}

export function closePanel() {
  panelEl.classList.remove('open');
  currentData = null;
}

/** Check if panel is currently open */
export function isPanelOpen() {
  return currentData !== null;
}

/** Update the spot name in the panel header (called after reverse geocoding) */
export function updatePanelSpotName(name) {
  if (!panelEl) return;
  const el = panelEl.querySelector('.rp-spot-name');
  if (el) el.textContent = name;
}

/** Update the panel's selected hour to match the slider position */
export function syncPanelHour(sliderHour) {
  if (!currentData || !currentData.hours.length) return;
  _selectClosestHour(sliderHour);
  render();
}

/** Find the day/hour indices closest to a given forecast hour */
function _selectClosestHour(targetHour) {
  if (!currentData) return;
  const { hours } = currentData;

  // Find the hour entry closest to targetHour
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < hours.length; i++) {
    const diff = Math.abs(hours[i].hour - targetHour);
    if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  }

  // Now figure out which day/hour index that maps to
  const days = _groupByDay(hours);
  let runningIdx = 0;
  for (let d = 0; d < days.length; d++) {
    if (runningIdx + days[d].hours.length > bestIdx) {
      selectedDayIdx = d;
      selectedHourIdx = bestIdx - runningIdx;
      return;
    }
    runningIdx += days[d].hours.length;
  }
}

// ── Build forecast data via server API ──

/**
 * Build the full 7-day forecast for a point via the server-side API.
 * One request returns all hours — much faster than loading 57+ grid files.
 */
export async function openPanel(lat, lon, coast, dataPath, runTime, currentHour = 0, cachedLoad = null) {
  panelEl.classList.add('open');
  // Fresh slot id per click — guarantees the prior map (if any) is torn down.
  _resetDetailSlot();
  renderLoading(lat, lon);

  try {
    // Client-side forecast computation — reuses the app's grid cache so
    // clicks are instant when the timeline has already been preloaded.
    const data = await computeForecast(lat, lon, dataPath, cachedLoad);

    // Prefer grid-detected coast (sharper at the actual ocean edge);
    // fall back to GeoJSON coastline when the point is too far inland.
    const effectiveCoast = data.coast || coast;

    const hours = data.hours.map(raw => {
      // Wave power per unit crest length (deep-water approximation).
      // P = (ρ g² / 64π) × H² × T  ≈  0.49 × H² × T  kW/m   (H in m, T in s)
      // This captures the "how much surf is actually showing up" quantity that
      // height alone misses: a clean long-period swell packs more energy than
      // a fatter short-period wave. Used below to size the 7-day bar.
      const surfPower = 0.49 * raw.swellHeightM * raw.swellHeightM * raw.swellPeriod;

      const entry = {
        hour: raw.hour,
        time: runTime
          ? new Date(runTime.getTime() + raw.hour * 3600000)
          : new Date(Date.now() + raw.hour * 3600000),
        windSpeedMph: msToMph(raw.windSpeedMs),
        windDir: raw.windDir,
        swellHeightFt: mToFt(raw.swellHeightM),
        swellDir: raw.swellDir,
        swellPeriod: raw.swellPeriod,
        surfPower,
        swellRating: null, windRating: null, overallRating: null,
      };

      // When the coastline lookup couldn't reliably determine a bearing
      // (no candidate in range, or both seaward dirs failed wet-test) we
      // skip rating rather than render a sentinel-derived score.
      const reliable = effectiveCoast && !effectiveCoast.unreliableBearing;
      if (reliable) {
        entry.swellRating = rateSwell(entry.swellHeightFt, entry.swellPeriod, entry.swellDir, effectiveCoast.seawardDir);
        entry.windRating = rateWind(entry.windSpeedMph, entry.windDir, effectiveCoast.offshoreDir);
        entry.overallRating = rateOverall(entry.swellRating, entry.windRating);
      } else {
        const flat = { score: null, label: '—', color: '#64748b' };
        entry.swellRating = { ...flat };
        entry.windRating = { ...flat, desc: 'coast unknown' };
        entry.overallRating = { ...flat, desc: 'coast unknown' };
      }

      return entry;
    });

    currentData = { lat, lon, coast: effectiveCoast, hours };
    _selectClosestHour(currentHour);
    render();
  } catch (e) {
    console.error('Forecast error:', e);
    panelEl.querySelector('.rating-body').innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:#94a3b8;">Error loading forecast</div>
    `;
  }
}

// ── Helpers ──

function _groupByDay(hours) {
  const days = [];
  let currentDay = null;
  for (const h of hours) {
    const dayKey = h.time.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (!currentDay || currentDay.label !== dayKey) {
      currentDay = { label: dayKey, dayName: h.time.toLocaleDateString('en-US', { weekday: 'short' }),
                     date: h.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), hours: [] };
      days.push(currentDay);
    }
    currentDay.hours.push(h);
  }
  return days;
}

// ── Rendering ──

function renderLoading(lat, lon) {
  panelEl.querySelector('.rating-body').innerHTML = `
    <div style="padding:40px 20px;text-align:center;color:#94a3b8;">
      Loading forecast for ${lat.toFixed(2)}°N, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}...
    </div>
  `;
}

function render() {
  if (!currentData || !currentData.hours.length) {
    panelEl.querySelector('.rating-body').innerHTML = `
      <div style="padding:40px 20px;text-align:center;color:#94a3b8;">No data available</div>
    `;
    return;
  }

  const { lat, lon, coast, hours } = currentData;
  const days = _groupByDay(hours);

  // Get selected hour
  const selDay = days[selectedDayIdx] || days[0];
  const selHour = selDay.hours[selectedHourIdx] || selDay.hours[0];
  const or = selHour.overallRating;

  panelEl.querySelector('.rating-body').innerHTML = `
    ${renderHeader(lat, lon)}
    ${renderOverall(or)}
    ${renderSelectedDetail(selHour, coast)}
    ${renderHourly(selDay, coast)}
    ${renderDaily(days, coast)}
    <div style="font-size: 10px; color: rgba(148,163,184,0.5); margin-top: 12px; text-align: right; padding-right: 4px;">
      Coast: GSHHG &bull; Weather: NOAA GFS
    </div>
  `;

  // Mount/refresh the MapLibre mini-map for the selected-detail compass.
  // The placeholder only exists when renderSelectedDetail decided we have
  // a real coast feature, so just mount whenever the placeholder is there.
  const slotEl = panelEl.querySelector('.rp-mapcompass[data-slot]');
  if (slotEl && coast) {
    mountMapCompass(slotEl.dataset.slot, coast);
  }

  // Wire up click handlers
  panelEl.querySelectorAll('[data-hour-idx]').forEach(el => {
    el.addEventListener('click', () => {
      selectedHourIdx = parseInt(el.dataset.hourIdx);
      render();
    });
  });
  panelEl.querySelectorAll('[data-day-idx]').forEach(el => {
    el.addEventListener('click', () => {
      selectedDayIdx = parseInt(el.dataset.dayIdx);
      selectedHourIdx = 0;
      render();
    });
  });
}

function renderHeader(lat, lon) {
  const lonLabel = `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
  return `
    <div class="rp-header">
      <div>
        <div class="rp-spot-name">Surf Check</div>
        <div class="rp-coords">${lat.toFixed(2)}°N, ${lonLabel}</div>
      </div>
    </div>
  `;
}

function renderOverall(or) {
  const scoreText = or.score == null ? '—' : or.score.toFixed(1);
  return `
    <div class="rp-overall">
      <div class="rp-score" style="background:${or.color}">${scoreText}</div>
      <div>
        <div class="rp-rating-label" style="color:${or.color}">${or.label}</div>
        <div class="rp-rating-desc">${or.desc || ''}</div>
      </div>
    </div>
  `;
}

// Stable slot id so the map can be reused across re-renders when the same
// panel is open. Reset whenever a new openPanel() runs (different lat/lon)
// — and tear down any prior MapLibre instance to avoid leaking GL contexts.
let _detailSlotId = 'rp-mapcompass-' + Math.random().toString(36).slice(2, 8);
export function _resetDetailSlot() {
  unmountAllMapCompasses();
  _detailSlotId = 'rp-mapcompass-' + Math.random().toString(36).slice(2, 8);
}

function renderSelectedDetail(h, coast) {
  const timeStr = h.time.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' +
                  h.time.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
  const windLabel = h.windRating.desc || '';

  // findNearestCoast does a tiered search up to ~2200km and almost
  // always returns a real coast. Only the "true mid-ocean" sentinel
  // (no coast within 20°) falls through to the schematic SVG.
  const hasRealCoast = coast
    && coast.featureIdx >= 0
    && Number.isFinite(coast.distance)
    && coast.distance < Infinity;
  const compassHtml = hasRealCoast
    ? renderMapCompassHTML(150, h, coast, _detailSlotId)
    : renderCompass(150, h, coast || { coastBearing: 0 }, false);

  return `
    <div class="rp-detail">
      ${compassHtml}
      <div class="rp-detail-info">
        <div class="rp-detail-time">${timeStr} <span>· selected</span></div>
        <div class="rp-detail-row">
          <span class="rp-detail-label">Swell</span>
          <span class="rp-detail-val">${h.swellHeightFt.toFixed(1)}</span><span class="rp-detail-unit">ft</span>
          <span class="rp-detail-sub">${h.swellPeriod.toFixed(0)}s · ${compassDir(h.swellDir)}</span>
        </div>
        <div class="rp-detail-row">
          <span class="rp-detail-label">Energy</span>
          <span class="rp-detail-val">${h.surfPower.toFixed(1)}</span><span class="rp-detail-unit">kW/m</span>
          <span class="rp-detail-sub">${h.swellRating.label}</span>
        </div>
        <div class="rp-detail-row">
          <span class="rp-detail-label">Wind</span>
          <span class="rp-detail-val">${h.windSpeedMph.toFixed(0)}</span><span class="rp-detail-unit">mph</span>
          <span class="rp-detail-sub">${compassDir(h.windDir)} · ${windLabel}</span>
        </div>
      </div>
    </div>
  `;
}

function renderHourly(day, coast) {
  // Pick ~6 evenly spaced hours
  const hrs = day.hours;
  const step = Math.max(1, Math.floor(hrs.length / 6));
  const shown = [];
  for (let i = 0; i < hrs.length; i += step) {
    if (shown.length < 6) shown.push({ h: hrs[i], origIdx: i });
  }

  const cards = shown.map(({ h, origIdx }) => {
    const sel = origIdx === selectedHourIdx ? 'rp-hc-sel' : '';
    const timeStr = h.time.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
    const bg = ratingBgColor(h.overallRating.score);

    return `
      <div class="rp-hc ${sel}" data-hour-idx="${origIdx}">
        <div class="rp-hc-time">${timeStr}</div>
        ${renderCompass(36, h, coast, true, bg)}
        <div class="rp-hc-ht">${h.swellHeightFt.toFixed(1)}<span class="rp-hc-unit">ft</span> <span class="rp-hc-unit">${h.swellPeriod.toFixed(0)}s ${compassDir(h.swellDir)}</span></div>
        <div class="rp-hc-wind">${h.windSpeedMph.toFixed(0)}<span class="rp-hc-unit">mph</span> <span class="rp-hc-unit">${compassDir(h.windDir)}</span></div>
      </div>
    `;
  }).join('');

  return `
    <div class="rp-hourly">
      <div class="rp-sec-title">${day.label}</div>
      <div class="rp-hour-scroll">${cards}</div>
    </div>
  `;
}

function renderDaily(days, coast) {
  const rows = days.map((day, dayIdx) => {
    const sel = dayIdx === selectedDayIdx ? 'rp-day-sel' : '';

    // Get AM (first hour), Noon (middle), PM (last) entries
    const am = day.hours[0];
    const noon = day.hours[Math.floor(day.hours.length / 2)] || am;
    const pm = day.hours[day.hours.length - 1] || am;

    // Bar magnitude = peak wave power over the day (the best window, not the
    // average) with a sqrt curve so the low end reads more honestly. Ceiling
    // at 100 kW/m, which lines up with big-wave days (e.g. 10 ft @ 18 s).
    // Color still comes from the avg overall rating so wind/direction affect it.
    const avgScore = day.hours.reduce((s, h) => s + h.overallRating.score, 0) / day.hours.length;
    const peakPower = day.hours.reduce((m, h) => Math.max(m, h.surfPower), 0);
    const { color } = overallRating(avgScore);
    const POWER_CEILING = 100; // kW/m
    const barWidth = Math.max(5, Math.sqrt(Math.min(1, peakPower / POWER_CEILING)) * 100);

    // Best swell stats for the day
    const bestSwell = day.hours.reduce((best, h) => h.swellHeightFt > best.swellHeightFt ? h : best, day.hours[0]);

    return `
      <div class="rp-day ${sel}" data-day-idx="${dayIdx}">
        <div>
          <div class="rp-day-name">${day.dayName}</div>
          <div class="rp-day-date">${day.date}</div>
        </div>
        <div class="rp-mini-dot" style="background:${am.overallRating.color}"></div>
        <div class="rp-mini-dot" style="background:${noon.overallRating.color}"></div>
        <div class="rp-mini-dot" style="background:${pm.overallRating.color}"></div>
        <div class="rp-bar-bg"><div class="rp-bar-fill" style="width:${barWidth}%;background:${color}"></div></div>
        ${renderCompass(28, am, coast, true, ratingBgColor(am.overallRating.score))}
        ${renderCompass(28, noon, coast, true, ratingBgColor(noon.overallRating.score))}
        ${renderCompass(28, pm, coast, true, ratingBgColor(pm.overallRating.score))}
      </div>
    `;
  }).join('');

  return `
    <div class="rp-daily">
      <div class="rp-sec-title">7-Day Outlook</div>
      <div class="rp-day-labels">
        <div></div><div></div><div></div><div></div><div></div>
        <div class="rp-day-col-label">AM</div>
        <div class="rp-day-col-label">Noon</div>
        <div class="rp-day-col-label">PM</div>
      </div>
      ${rows}
    </div>
  `;
}

// ── Compass SVG rendering ──

/**
 * Wrapper around compass-render.js that fetches the coast snippet here so
 * callers don't have to.
 */
function renderCompass(size, h, coast, mini = false, bgColor = null) {
  // 6 km snippet — wider gives a too-zoomed-out view where real local
  // features (points, bays, jetties) get smoothed away inside the compass
  // circle. compass-render.js scales the half-span (3 km) to 75% of r so
  // the snippet sits well inside the bezel even when it runs diagonally.
  const snip = mini ? null : getCoastSnippet(coast.featureIdx, coast.segIdx, coast.coastLat, coast.coastLon, 6);
  return renderCompassSvg(size, h, coast, snip, mini, bgColor);
}
