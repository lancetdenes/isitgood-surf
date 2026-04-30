/**
 * ratings.js — Surf quality rating engine
 *
 * Computes swell, wind, and overall surf ratings from raw weather data
 * and coastal orientation. All scores are 0-10, mapped to labels/colors.
 *
 * Rating labels:
 *   Overall: Flat / Poor / Marginal / Fair / Good / Epic
 *   Swell & Wind: Flat / Poor / Marginal / Fair / Good / Perfect
 *
 * Colors (colorblind-friendly):
 *   Flat=#64748b  Poor=#e08a5e  Marginal=#d4a03a  Fair=#5bb8d4  Good=#3b82f6  Epic=#a855f7
 */

// ── Rating scale ──

const OVERALL_LABELS = [
  { min: 8,   label: 'Epic',     color: '#a855f7' },
  { min: 6.5, label: 'Good',     color: '#3b82f6' },
  { min: 4.5, label: 'Fair',     color: '#5bb8d4' },
  { min: 2.5, label: 'Marginal', color: '#d4a03a' },
  { min: 1,   label: 'Poor',     color: '#e08a5e' },
  { min: 0,   label: 'Flat',     color: '#64748b' },
];

const SUB_LABELS = [
  { min: 8,   label: 'Perfect',  color: '#3b82f6' },
  { min: 6.5, label: 'Good',     color: '#5bb8d4' },
  { min: 4.5, label: 'Fair',     color: '#d4a03a' },
  { min: 2.5, label: 'Marginal', color: '#e08a5e' },
  { min: 1,   label: 'Poor',     color: '#e08a5e' },
  { min: 0,   label: 'Flat',     color: '#64748b' },
];

function lookupRating(score, scale) {
  for (const entry of scale) {
    if (score >= entry.min) return entry;
  }
  return scale[scale.length - 1];
}

export function overallRating(score) { return lookupRating(score, OVERALL_LABELS); }
export function subRating(score) { return lookupRating(score, SUB_LABELS); }

/** Colorblind-safe rgba background tint for a rating color */
export function ratingBgColor(score) {
  const { color } = overallRating(score);
  // Parse hex to rgba at 0.2 opacity
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r},${g},${b},0.2)`;
}

// ── Angular math ──

/** Shortest angular difference in degrees (-180 to 180) */
function angDiff(a, b) {
  return ((a - b) % 360 + 540) % 360 - 180;
}

/** Compass direction label from degrees */
export function compassDir(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// ── Swell rating ──

/**
 * Rate swell quality (0-10).
 *
 * Physics-based rather than the old bucketed additive scoring. Two inputs:
 *   1. Wave power per unit crest (deep-water): P = 0.49 × H² × T  kW/m.
 *      Captures the "how much surf actually shows up" quantity — pairs height
 *      and period multiplicatively the way energy flux really works.
 *   2. Direction alignment with the seaward direction. Smooth falloff; energy
 *      reaching the coast drops roughly as (dirDiff/100°)^1.5 and zeroes out
 *      past ~105° since the swell is then heading away from land.
 *
 * Calibration anchors (on-axis, clean):
 *     3 ft @ 10 s  →  ~4.2   Fair
 *     5 ft @ 12 s  →  ~6.2   Fair–Good
 *     7 ft @ 14 s  →  ~7.5   Good
 *    10 ft @ 16 s  →  ~8.8   Epic
 *    15 ft @ 20 s  →  10     Epic (clamped)
 *
 * @param {number} heightFt - significant wave height in feet
 * @param {number} periodS - peak period in seconds
 * @param {number} swellDir - swell direction (degrees, where it comes FROM)
 * @param {number} optimalDir - seaward direction of the coast (ideal swell source)
 * @returns {{ score: number, label: string, color: string }}
 */
export function rateSwell(heightFt, periodS, swellDir, optimalDir) {
  if (heightFt < 0.5 || periodS < 3) return { score: 0, ...subRating(0) };

  // Wave power in kW/m — formula expects meters, we store feet in the UI.
  const heightM = heightFt / 3.281;
  const power = 0.49 * heightM * heightM * periodS;

  // Log curve tuned so "small fun" lands around 4 and "pumping" around 7-8.
  // `1 + 2*power` keeps low-end flat days near zero; the 4× scales to ~10.
  const powerScore = 4 * Math.log10(1 + 2 * power);

  // Direction factor: 1 on-axis, ~0.54 at 60°, ~0.15 at 90°, 0 past ~105°.
  // 105° cutoff reflects that swell coming from more than a right angle off
  // the seaward bearing is physically obstructed by the land.
  const dirDiff = Math.abs(angDiff(swellDir, optimalDir));
  const dirFactor = dirDiff >= 105 ? 0
    : Math.max(0, 1 - Math.pow(dirDiff / 100, 1.5));

  const score = Math.min(10, powerScore * dirFactor);
  return { score, ...subRating(score) };
}

// ── Wind rating ──

/**
 * Rate wind conditions (0-10).
 * @param {number} speedMph - wind speed in mph
 * @param {number} windDir - wind direction (degrees, where it comes FROM)
 * @param {number} offshoreDir - direction wind blows FROM for offshore conditions
 * @returns {{ score: number, label: string, color: string, desc: string }}
 */
export function rateWind(speedMph, windDir, offshoreDir) {
  // Glassy
  if (speedMph < 3) {
    return { score: 10, ...subRating(10), desc: 'Glassy' };
  }

  const offDiff = Math.abs(angDiff(windDir, offshoreDir));

  // Offshore (<45°)
  if (offDiff < 45) {
    if (speedMph <= 10) return { score: 9, ...subRating(9), desc: 'Clean offshore' };
    if (speedMph <= 15) return { score: 7, ...subRating(7), desc: 'Offshore' };
    return { score: 5, ...subRating(5), desc: 'Strong offshore' };
  }

  // Sideshore (45-135°)
  if (offDiff < 135) {
    if (speedMph <= 6) return { score: 7, ...subRating(7), desc: 'Light side' };
    if (speedMph <= 12) return { score: 4.5, ...subRating(4.5), desc: 'Sideshore' };
    return { score: 3, ...subRating(3), desc: 'Choppy side' };
  }

  // Onshore (>135°)
  if (speedMph <= 5) return { score: 4, ...subRating(4), desc: 'Light onshore' };
  if (speedMph <= 10) return { score: 2.5, ...subRating(2.5), desc: 'Onshore' };
  if (speedMph <= 18) return { score: 1.5, ...subRating(1.5), desc: 'Choppy' };
  return { score: 0.5, ...subRating(0.5), desc: 'Blown out' };
}

// ── Overall rating ──

/**
 * Compute overall surf rating (60% swell + 40% wind).
 * @returns {{ score: number, label: string, color: string, desc: string }}
 */
export function rateOverall(swellResult, windResult) {
  const score = swellResult.score * 0.6 + windResult.score * 0.4;
  const { label, color } = overallRating(score);

  let desc;
  if (label === 'Epic') desc = `${windResult.desc} with solid swell`;
  else if (label === 'Good') desc = `${windResult.desc} with moderate swell`;
  else if (label === 'Fair') desc = `Rideable with ${windResult.desc.toLowerCase()}`;
  else if (label === 'Marginal') desc = `Weak conditions, ${windResult.desc.toLowerCase()}`;
  else if (label === 'Poor') desc = `Poor — ${windResult.desc.toLowerCase()}`;
  else desc = 'Flat';

  return { score, label, color, desc };
}

// ── Unit conversion helpers ──

export const msToMph = (ms) => ms * 2.237;
export const mToFt = (m) => m * 3.281;

/**
 * Wind direction from u, v components (meteorological convention: where FROM).
 * u = eastward, v = northward.
 */
export function windDirection(u, v) {
  return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
}

export function windSpeed(u, v) {
  return Math.sqrt(u * u + v * v);
}
