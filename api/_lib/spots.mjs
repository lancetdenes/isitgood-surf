/**
 * spots.mjs — server-side access to the named-spots list + spot naming.
 *
 * Reuses the same pure snapping logic the client uses
 * (public/js/spot-snap.js) so the DB spot_name and the UI label agree.
 * No external geocoding API — the 523-spot list ships with the app.
 */
import { createRequire } from 'node:module';
import { snapToSpot } from '../../public/js/spot-snap.js';

const require = createRequire(import.meta.url);

let _spots = null;
export function getSpots() {
  if (!_spots) _spots = require('../../public/data/named-spots.json');
  return _spots;
}

/**
 * Display name for a coordinate: spot name within 2 km, "near <spot>" within
 * 10 km, null beyond that (callers fall back to raw coordinates).
 */
export function spotNameFor(lat, lng) {
  return snapToSpot(getSpots(), lat, lng).label;
}
