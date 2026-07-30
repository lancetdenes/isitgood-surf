/**
 * hours.js — Single source of truth for the forecast-hour timeline.
 *
 * The forecast runs 0–168h at 3-hourly steps (GFS core range), then
 * 174–336h at 6-hourly steps (GFS extended range, days 7–14): 85 steps
 * total. The timeline slider, preloader, pumping panel, and spot panel all
 * index into FORECAST_HOURS instead of assuming a uniform step.
 *
 * Beyond BASE_END (168h) GFS skill drops noticeably — the UI renders that
 * range with a "lower confidence / extended" treatment.
 *
 * MIRRORS — keep in sync when changing the hour layout:
 *   data/scripts/lib/forecast-hours.js  (CommonJS, pipeline + server)
 *   data/scripts/process-grib.py        (forecast_hours())
 *   data/scripts/download-gfs.sh        (seq 0 3 168 / seq 174 6 336)
 * data/scripts/test/forecast-hours.test.js asserts the mirrors agree.
 */

export const BASE_END = 168;  // last 3-hourly forecast hour (day 7)
export const BASE_STEP = 3;
export const EXT_START = 174; // first 6-hourly extended hour
export const EXT_END = 336;   // last forecast hour (day 14)
export const EXT_STEP = 6;

function buildHours() {
  const arr = [];
  for (let h = 0; h <= BASE_END; h += BASE_STEP) arr.push(h);
  for (let h = EXT_START; h <= EXT_END; h += EXT_STEP) arr.push(h);
  return arr;
}

/** All forecast hours, ascending: [0, 3, …, 168, 174, 180, …, 336]. */
export const FORECAST_HOURS = Object.freeze(buildHours());

/** Number of timeline steps (85). */
export const N_STEPS = FORECAST_HOURS.length;

/** Highest forecast hour (336). */
export const MAX_HOUR = FORECAST_HOURS[N_STEPS - 1];

/** True when an hour falls in the lower-confidence extended range. */
export function isExtended(hour) {
  return hour > BASE_END;
}

/** Timeline index → forecast hour (clamped to valid range). */
export function indexToHour(i) {
  if (i <= 0) return FORECAST_HOURS[0];
  if (i >= N_STEPS) return FORECAST_HOURS[N_STEPS - 1];
  return FORECAST_HOURS[Math.round(i)];
}

/** Forecast hour → nearest timeline index. */
export function hourToIndex(hour) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < N_STEPS; i++) {
    const diff = Math.abs(FORECAST_HOURS[i] - hour);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

/** Core-range hours: 0–168 @ 3h (57 entries). */
export function baseHours() {
  return FORECAST_HOURS.filter(h => h <= BASE_END);
}

/** Extended-range hours: 174–336 @ 6h (28 entries). */
export function extendedHours() {
  return FORECAST_HOURS.filter(h => h > BASE_END);
}
