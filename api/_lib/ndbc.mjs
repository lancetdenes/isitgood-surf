/**
 * ndbc.mjs — NDBC realtime2 fetch + parse helpers.
 *
 * Shared by the Vercel functions in api/buoys/*.mjs and the local Express
 * routes in server.js. NDBC serves plain text with NO CORS headers, so the
 * browser can never talk to it directly — these parsers always run
 * server-side.
 *
 * Formats (verified July 2026 against www.ndbc.noaa.gov/data/realtime2/):
 *   <ID>.txt        stdmet: newest-first rows, 'MM' = missing
 *   <ID>.spec       spectral summary (SwH/SwP/SwD windsea split)
 *   <ID>.data_spec  raw spectral energy density: "energy (freq)" pairs
 *   <ID>.swdir      mean wave direction per frequency (alpha1), 999 = missing
 */

const NDBC_BASE = 'https://www.ndbc.noaa.gov';
const FETCH_TIMEOUT_MS = 8000;

// ── Fetch layer (live NDBC with optional fixture fallback) ──

// Tiny in-memory TTL cache. On Vercel this only helps warm lambdas; locally
// it keeps dev from hammering NDBC while scrubbing around the map.
const _cache = new Map();

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.text;
  if (hit) _cache.delete(key);
  return null;
}

function _cachePut(key, text, ttlMs) {
  if (_cache.size > 200) _cache.clear(); // crude bound; entries are small text
  _cache.set(key, { text, expires: Date.now() + ttlMs });
}

/** Map an NDBC URL path to a fixture filename under NDBC_FIXTURE_DIR. */
export function fixtureNameFor(urlPath) {
  if (urlPath === '/activestations.xml') return 'activestations.xml';
  if (urlPath === '/data/realtime2/') return 'realtime2-index.html';
  const m = urlPath.match(/^\/data\/realtime2\/([A-Za-z0-9]+\.[a-z_]+)$/);
  return m ? m[1] : null;
}

/**
 * Fetch a text resource from NDBC. Tries live first (unless NDBC_OFFLINE=1),
 * then falls back to fixture files when NDBC_FIXTURE_DIR is set (local dev).
 */
export async function fetchNdbcText(urlPath, ttlMs = 5 * 60 * 1000) {
  const cached = _cacheGet(urlPath);
  if (cached !== null) return cached;

  let liveErr = null;
  if (process.env.NDBC_OFFLINE !== '1') {
    try {
      const r = await fetch(`${NDBC_BASE}${urlPath}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'surf-app buoy layer (github.com/lancetdenes)' },
      });
      if (r.ok) {
        const text = await r.text();
        _cachePut(urlPath, text, ttlMs);
        return text;
      }
      liveErr = new Error(`NDBC ${r.status} for ${urlPath}`);
      liveErr.status = r.status;
    } catch (e) {
      liveErr = e;
    }
  }

  const dir = process.env.NDBC_FIXTURE_DIR;
  if (dir) {
    const name = fixtureNameFor(urlPath);
    if (name) {
      try {
        const { readFile } = await import('node:fs/promises');
        return await readFile(`${dir}/${name}`, 'utf8');
      } catch { /* fall through to live error */ }
    }
  }
  throw liveErr || new Error(`NDBC offline and no fixture for ${urlPath}`);
}

// ── Generic text-table helpers ──

/** 'MM' / 'N/A' / non-numeric → null, else float. */
function num(v) {
  if (v == null || v === 'MM' || v === 'N/A') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Build an ISO UTC timestamp from NDBC's YY MM DD hh mm columns. */
function rowTime(parts) {
  const [yy, mo, dd, hh, mn] = parts;
  const t = Date.UTC(+yy, +mo - 1, +dd, +hh, +mn);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Parse a headered NDBC table (#YY header line, newest-first data rows) into
 * [{time, <COL>: value}]. Numeric columns become numbers (null when missing);
 * columns listed in stringCols keep their raw token (null when MM/N/A).
 */
function parseTable(text, stringCols = new Set()) {
  const lines = text.split('\n');
  let header = null;
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) {
      // First # line holds column names; second holds units.
      if (!header) header = trimmed.replace(/^#/, '').trim().split(/\s+/);
      continue;
    }
    if (!header) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    const time = rowTime(parts);
    if (!time) continue;
    const row = { time };
    for (let i = 5; i < header.length && i < parts.length; i++) {
      const col = header[i];
      if (stringCols.has(col)) {
        row[col] = (parts[i] === 'MM' || parts[i] === 'N/A') ? null : parts[i];
      } else {
        row[col] = num(parts[i]);
      }
    }
    out.push(row);
  }
  return out;
}

// ── stdmet (<ID>.txt) ──

export function parseStdmet(text, maxRows = 60) {
  return parseTable(text).slice(0, maxRows);
}

const LOOKBACK_MS = 3 * 60 * 60 * 1000;

/**
 * Merge the newest stdmet rows into one observation. Wave fields only appear
 * on some rows (30/60-min cadence vs 10-min met rows), so look back up to 3h
 * for the freshest row that actually has them.
 */
export function latestStdmetObs(rows) {
  if (!rows.length) return null;
  const t0 = Date.parse(rows[0].time);
  const recent = rows.filter(r => t0 - Date.parse(r.time) <= LOOKBACK_MS);
  const firstWith = (col) => recent.find(r => r[col] != null);

  const waveRow = firstWith('WVHT');
  const windRow = firstWith('WSPD');
  const val = (col) => firstWith(col)?.[col] ?? null;

  return {
    time: rows[0].time,
    wind: windRow ? {
      time: windRow.time,
      dirDeg: windRow.WDIR ?? null,
      speedMs: windRow.WSPD,
      gustMs: windRow.GST ?? null,
    } : null,
    waves: waveRow ? {
      time: waveRow.time,
      heightM: waveRow.WVHT,
      dominantPeriodS: waveRow.DPD ?? null,
      avgPeriodS: waveRow.APD ?? null,
      dirDeg: waveRow.MWD ?? null,
    } : null,
    waterTempC: val('WTMP'),
    airTempC: val('ATMP'),
    dewpointC: val('DEWP'),
    pressureHpa: val('PRES'),
    pressureTendencyHpa: val('PTDY'),
  };
}

// ── spectral summary (<ID>.spec) ──

const SPEC_STRING_COLS = new Set(['SwD', 'WWD', 'STEEPNESS']);

export function parseSpec(text, maxRows = 30) {
  return parseTable(text, SPEC_STRING_COLS).slice(0, maxRows);
}

/**
 * Latest usable spectral summary. Prefers the freshest row that has the
 * swell/windsea split (SwH); falls back to the freshest row with any WVHT.
 */
export function latestSpecSummary(rows) {
  if (!rows.length) return null;
  const t0 = Date.parse(rows[0].time);
  const recent = rows.filter(r => t0 - Date.parse(r.time) <= 6 * 60 * 60 * 1000);
  const row = recent.find(r => r.SwH != null) || recent.find(r => r.WVHT != null);
  if (!row) return null;
  return {
    time: row.time,
    waveHeightM: row.WVHT ?? null,
    swell: row.SwH != null ? {
      heightM: row.SwH, periodS: row.SwP ?? null, dirCard: row.SwD ?? null,
    } : null,
    windWave: row.WWH != null ? {
      heightM: row.WWH, periodS: row.WWP ?? null, dirCard: row.WWD ?? null,
    } : null,
    steepness: row.STEEPNESS ?? null,
    avgPeriodS: row.APD ?? null,
    meanDirDeg: row.MWD ?? null,
  };
}

// ── raw spectral density (<ID>.data_spec) ──

const PAIR_RE = /(-?\d+(?:\.\d+)?)\s+\((\d+(?:\.\d+)?)\)/g;

function firstDataLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed;
  }
  return null;
}

/**
 * Parse the newest .data_spec row: separation frequency + spectral energy
 * density (m²/Hz) per frequency bin.
 */
export function parseDataSpec(text) {
  const line = firstDataLine(text);
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 8) return null;
  const time = rowTime(parts);
  const sepFreq = num(parts[5]);
  const bins = [];
  const rest = parts.slice(6).join(' ');
  for (const m of rest.matchAll(PAIR_RE)) {
    const energy = parseFloat(m[1]);
    const freq = parseFloat(m[2]);
    if (Number.isFinite(energy) && Number.isFinite(freq) && freq > 0) {
      bins.push({ freq, energy: Math.max(0, energy) });
    }
  }
  return bins.length ? { time, sepFreq, bins } : null;
}

/**
 * Parse the newest .swdir row: mean wave direction (alpha1, degT) per
 * frequency bin. 999 = missing.
 */
export function parseSwdir(text) {
  const line = firstDataLine(text);
  if (!line) return null;
  const parts = line.split(/\s+/);
  if (parts.length < 7) return null;
  const time = rowTime(parts);
  const bins = [];
  const rest = parts.slice(5).join(' ');
  for (const m of rest.matchAll(PAIR_RE)) {
    const dir = parseFloat(m[1]);
    const freq = parseFloat(m[2]);
    if (!Number.isFinite(freq) || freq <= 0) continue;
    bins.push({ freq, dir: dir >= 0 && dir < 360 ? dir : null });
  }
  return bins.length ? { time, bins } : null;
}

/** Attach per-bin direction (from .swdir) to the energy bins (from .data_spec). */
export function mergeSpectrum(dataSpec, swdir) {
  if (!dataSpec) return null;
  const dirByFreq = new Map();
  if (swdir) for (const b of swdir.bins) dirByFreq.set(b.freq.toFixed(3), b.dir);
  return {
    time: dataSpec.time,
    sepFreq: dataSpec.sepFreq,
    bins: dataSpec.bins.map(b => ({
      freq: b.freq,
      period: Math.round((1 / b.freq) * 10) / 10,
      energy: b.energy,
      dir: dirByFreq.get(b.freq.toFixed(3)) ?? null,
    })),
  };
}

// ── station list (activestations.xml + realtime2 directory index) ──

export function parseActiveStations(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<station\s+([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const id = (attrs.id || '').toUpperCase();
    const lat = parseFloat(attrs.lat);
    const lng = parseFloat(attrs.lon);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out.set(id, { id, lat, lng, name: attrs.name || '', type: attrs.type || '' });
  }
  return out;
}

const INDEX_ROW_RE =
  /<a href="([A-Za-z0-9]+)\.(txt|spec|data_spec|swdir)">[^<]*<\/a><\/td><td[^>]*>\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/g;

/** Map station id → {ext: modifiedEpochMs} from the realtime2 Apache index. */
export function parseRealtimeIndex(html) {
  const out = new Map();
  for (const m of html.matchAll(INDEX_ROW_RE)) {
    const id = m[1].toUpperCase();
    const ext = m[2];
    const modified = Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7]);
    let entry = out.get(id);
    if (!entry) { entry = {}; out.set(id, entry); }
    entry[ext] = modified;
  }
  return out;
}

const STATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Join the metadata + realtime index into the station list served to the
 * frontend. Keeps stations with a recently-updated stdmet or spectral feed.
 */
export function buildStationList(xml, indexHtml, now = Date.now()) {
  const meta = parseActiveStations(xml);
  const index = parseRealtimeIndex(indexHtml);
  const out = [];
  for (const [id, feeds] of index) {
    if (!feeds.txt && !feeds.spec) continue;
    const newest = Math.max(...Object.values(feeds));
    if (now - newest > STATION_MAX_AGE_MS) continue;
    const m = meta.get(id);
    if (!m || m.type === 'dart') continue;
    out.push({
      id,
      name: m.name,
      lat: m.lat,
      lng: m.lng,
      hasWave: Boolean(feeds.spec),
      hasSpectral: Boolean(feeds.data_spec),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Validate a station id from user input. */
export function normalizeStationId(raw) {
  const id = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9]{4,10}$/.test(id) ? id : null;
}
