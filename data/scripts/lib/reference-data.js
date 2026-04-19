import fs from 'node:fs';
import path from 'node:path';
import KDBush from 'kdbush';

const REF_DIR = path.resolve(import.meta.dirname, '../../reference');

/** Load Natural Earth admin-0 countries as a FeatureCollection. */
export function loadCountries() {
  const file = path.join(REF_DIR, 'ne_10m_admin_0_countries.geojson');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run: bash data/scripts/download-reference-data.sh`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Load Natural Earth coastline as a FeatureCollection of LineStrings/MultiLineStrings. */
export function loadCoastline() {
  const file = path.join(REF_DIR, 'ne_10m_coastline.geojson');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run: bash data/scripts/download-reference-data.sh`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Load GeoNames cities1000 as an array of {name, lat, lon, country}.
 * Tab-separated; columns per https://download.geonames.org/export/dump/
 */
export function loadCities() {
  const file = path.join(REF_DIR, 'cities1000.txt');
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run: bash data/scripts/download-reference-data.sh`);
  }
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    const cols = line.split('\t');
    const name = cols[1];
    const lat = parseFloat(cols[4]);
    const lon = parseFloat(cols[5]);
    const country = cols[8];
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    out.push({ name, lat, lon, country });
  }
  return out;
}

/** Build a KDBush index over an array of {lat, lon}. Returns {index, cities}. */
export function buildCityIndex(cities) {
  const index = new KDBush(cities.length);
  for (const c of cities) index.add(c.lon, c.lat);
  index.finish();
  return { index, cities };
}

/** Find nearest city within maxKm. Returns null if none. */
export function nearestCity(index, cities, lat, lon, maxKm) {
  const boxDeg = (maxKm / 111) / Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const ids = index.range(lon - boxDeg, lat - boxDeg, lon + boxDeg, lat + boxDeg);
  if (ids.length === 0) return null;

  let best = null, bestD = Infinity;
  for (const i of ids) {
    const c = cities[i];
    const d = haversineKm(lat, lon, c.lat, c.lon);
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= maxKm ? { ...best, distanceKm: bestD } : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, TR = Math.PI / 180;
  const dLat = (lat2 - lat1) * TR, dLon = (lon2 - lon1) * TR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * TR) * Math.cos(lat2 * TR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
