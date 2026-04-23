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

      entry.swellRating = rateSwell(entry.swellHeightFt, entry.swellPeriod, entry.swellDir, effectiveCoast.seawardDir);
      entry.windRating = rateWind(entry.windSpeedMph, entry.windDir, effectiveCoast.offshoreDir);
      entry.overallRating = rateOverall(entry.swellRating, entry.windRating);

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
  `;

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
  return `
    <div class="rp-overall">
      <div class="rp-score" style="background:${or.color}">${or.score.toFixed(1)}</div>
      <div>
        <div class="rp-rating-label" style="color:${or.color}">${or.label}</div>
        <div class="rp-rating-desc">${or.desc}</div>
      </div>
    </div>
  `;
}

function renderSelectedDetail(h, coast) {
  const timeStr = h.time.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' +
                  h.time.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
  const windLabel = h.windRating.desc;

  return `
    <div class="rp-detail">
      ${renderCompass(150, h, coast, false)}
      <div class="rp-detail-info">
        <div class="rp-detail-time">${timeStr} <span>· selected</span></div>
        <div class="rp-detail-row">
          <span class="rp-detail-label">Swell</span>
          <span class="rp-detail-val">${h.swellHeightFt.toFixed(1)}</span><span class="rp-detail-unit">ft</span>
          <span class="rp-detail-sub">${h.swellPeriod.toFixed(0)}s · ${compassDir(h.swellDir)}</span>
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
 * Render a compass SVG showing coast, swell arrow, and wind barbs.
 * @param {number} size - rendered pixel size
 * @param {object} h - hour data entry
 * @param {object} coast - coast orientation data
 * @param {boolean} mini - if true, use thicker strokes for small rendering
 * @param {string} bgColor - optional background tint color
 */
function renderCompass(size, h, coast, mini = false, bgColor = null) {
  const vb = 200; // viewBox is always 200x200
  const cx = 100, cy = 100, r = 85;
  const bg = bgColor || 'rgba(15,23,42,0.8)';

  // Coast bearing determines the coastline orientation
  const cb = coast.coastBearing;

  // Swell arrow scaling by height (1-8ft)
  const ht = Math.min(h.swellHeightFt, 8);
  const arrowW = mini ? Math.max(4, 3 + ht) : Math.max(2, 1.5 + ht * 0.5);
  const arrowH = mini ? Math.max(16, 10 + ht * 4) : Math.max(14, 10 + ht * 3);
  const headW = mini ? Math.max(10, 6 + ht * 2) : Math.max(6, 4 + ht * 1.5);
  const headH = mini ? 14 : 10;
  const arrowStart = mini ? -70 : -58;
  // Connect arrowhead directly to shaft end — no gap
  const shaftEnd = arrowStart + arrowH;
  const arrowTip = shaftEnd + headH;
  const arrowOp = Math.min(0.95, 0.5 + ht / 10);

  // Wind barb scaling by speed (0-30 mph)
  const ws = Math.min(h.windSpeedMph, 30);
  const barbCount = Math.max(1, Math.min(6, Math.ceil(ws / 5)));
  const barbLen = mini ? Math.max(20, 15 + ws) : Math.max(18, 12 + ws * 0.8);
  const barbW = mini ? 4 : 1.4;
  const barbOp = Math.min(0.7, 0.3 + ws / 30);
  const barbSpacing = mini ? 12 : 10;

  // Cardinal labels
  const labels = mini ? '' : `
    <text x="100" y="10" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">N</text>
    <text x="194" y="104" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">E</text>
    <text x="100" y="198" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">S</text>
    <text x="6" y="104" text-anchor="middle" fill="#475569" font-size="11" font-weight="600">W</text>
  `;

  // Wind barbs SVG — single line with tick at the end
  let barbs = '';
  const halfSpread = ((barbCount - 1) * barbSpacing) / 2;
  for (let i = 0; i < barbCount; i++) {
    const x = -halfSpread + i * barbSpacing;
    const startY = -(r - 8);
    const endY = startY + barbLen;
    barbs += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${endY}" stroke="white" stroke-width="${barbW}" stroke-dasharray="${mini ? '8,6' : '5,4'}"/>`;
    barbs += `<line x1="${x}" y1="${endY}" x2="${x + (mini ? 10 : 6)}" y2="${endY - (mini ? 10 : 6)}" stroke="white" stroke-width="${barbW}"/>`;
  }

  // Build coast representation: snippet for main compass, simple line for mini.
  let coastSvg;
  if (mini) {
    coastSvg = `
      <g transform="translate(${cx},${cy}) rotate(${cb})">
        <path d="M 0,-${r} A ${r} ${r} 0 0 1 0,${r}" fill="rgba(56,189,248,0.04)"/>
        <line x1="0" y1="-${r}" x2="0" y2="${r}" stroke="rgba(148,163,184,0.2)" stroke-width="4"/>
      </g>
    `;
  } else {
    const clipId = `cc-${size}-${Math.random().toString(36).slice(2, 8)}`;
    const snip = getCoastSnippet(coast.featureIdx, coast.segIdx, coast.coastLat, coast.coastLon, 30);
    if (snip.points.length >= 2) {
      // Scale so 15 km (half-span of 30 km snippet) maps to ~r pixels.
      const scale = r / 15;
      const pts = snip.points.map(p => ({
        // SVG y-axis is inverted (down = positive), but our local km y = north,
        // so negate y to make north appear at the top of the compass.
        sx: cx + p.x * scale,
        sy: cy - p.y * scale,
      }));
      const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.sx.toFixed(1)},${p.sy.toFixed(1)}`).join(' ');
      // Close a land polygon by extending the endpoints to the inshore side of the compass.
      // Inshore direction = opposite of seawardDir.
      const inshoreRad = ((coast.seawardDir + 180) % 360) * Math.PI / 180;
      const ext = r * 2.5;
      const ex = Math.sin(inshoreRad) * ext;
      const ey = -Math.cos(inshoreRad) * ext;
      const last = pts[pts.length - 1];
      const first = pts[0];
      const landD = `${pathD} L ${(last.sx + ex).toFixed(1)},${(last.sy + ey).toFixed(1)} L ${(first.sx + ex).toFixed(1)},${(first.sy + ey).toFixed(1)} Z`;
      coastSvg = `
        <defs><clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>
        <g clip-path="url(#${clipId})">
          <path d="${landD}" fill="rgba(194,140,102,0.12)" stroke="none"/>
          <path d="${pathD}" stroke="rgba(148,163,184,0.5)" stroke-width="2" fill="none"/>
        </g>
      `;
    } else {
      // Fallback to the old line if snippet unavailable.
      coastSvg = `
        <g transform="translate(${cx},${cy}) rotate(${cb})">
          <path d="M 0,-${r} A ${r} ${r} 0 0 1 0,${r}" fill="rgba(56,189,248,0.04)"/>
          <line x1="0" y1="-${r}" x2="0" y2="${r}" stroke="rgba(148,163,184,0.2)" stroke-width="2"/>
        </g>
      `;
    }
  }

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" style="flex-shrink:0">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}" stroke="rgba(148,163,184,0.12)" stroke-width="${mini ? 3 : 1}"/>
      ${coastSvg}
      ${labels}
      <g transform="translate(${cx},${cy}) rotate(${h.swellDir})">
        <rect x="${-arrowW}" y="${arrowStart}" width="${arrowW * 2}" height="${arrowH}" fill="white" opacity="${arrowOp}" rx="${mini ? 2 : 1}"/>
        <polygon points="0,${arrowTip} ${-headW},${shaftEnd} ${headW},${shaftEnd}" fill="white" opacity="${arrowOp}"/>
      </g>
      <g transform="translate(${cx},${cy}) rotate(${h.windDir})" opacity="${barbOp}">
        ${barbs}
      </g>
    </svg>
  `;
}
