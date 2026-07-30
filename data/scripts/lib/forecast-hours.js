/**
 * forecast-hours.js — CommonJS mirror of public/js/hours.js for the
 * pipeline scripts and server (which can't import browser ES modules).
 *
 * 0–168h @ 3h (GFS core), then 174–336h @ 6h (extended range): 85 steps.
 *
 * MIRRORS — keep in sync when changing the hour layout:
 *   public/js/hours.js                  (browser ESM — source of truth)
 *   data/scripts/process-grib.py        (forecast_hours())
 *   data/scripts/download-gfs.sh        (seq 0 3 168 / seq 174 6 336)
 * data/scripts/test/forecast-hours.test.js asserts the mirrors agree.
 */

const BASE_END = 168;
const BASE_STEP = 3;
const EXT_START = 174;
const EXT_END = 336;
const EXT_STEP = 6;

const FORECAST_HOURS = Object.freeze((() => {
  const arr = [];
  for (let h = 0; h <= BASE_END; h += BASE_STEP) arr.push(h);
  for (let h = EXT_START; h <= EXT_END; h += EXT_STEP) arr.push(h);
  return arr;
})());

module.exports = {
  BASE_END,
  BASE_STEP,
  EXT_START,
  EXT_END,
  EXT_STEP,
  FORECAST_HOURS,
  N_STEPS: FORECAST_HOURS.length,
  MAX_HOUR: FORECAST_HOURS[FORECAST_HOURS.length - 1],
  baseHours: () => FORECAST_HOURS.filter(h => h <= BASE_END),
  extendedHours: () => FORECAST_HOURS.filter(h => h > BASE_END),
};
