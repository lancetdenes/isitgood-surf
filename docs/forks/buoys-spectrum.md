# Fork report: buoys + swell spectrum (`fork/buoys-spectrum`)

NDBC buoys on the map with live observations, plus a Surfline-style swell
spectrum (energy by period, with direction) for buoys that report spectral
data.

## What changed

**Backend (shared parser + 3 endpoints)**
- `api/_lib/ndbc.mjs` — all NDBC fetch/parse logic in one module, used by both
  the Vercel functions and local Express. Parses stdmet (`.txt`), spectral
  summary (`.spec`), raw spectral density (`.data_spec`), per-frequency
  direction (`.swdir`), `activestations.xml`, and the realtime2 Apache
  directory index. `'MM'`/`'N/A'`/`999` sentinels → `null` throughout.
- `api/buoys/stations.mjs` — station list `{id, name, lat, lng, hasWave,
  hasSpectral}` built by joining `activestations.xml` (names/coords) with the
  realtime2 directory index (which feeds exist + when they last updated).
  Filtered to stations whose feed updated in the last 7 days (~900 stations);
  DART tsunami stations excluded. `Cache-Control: s-maxage=86400,
  stale-while-revalidate=86400`.
- `api/buoys/obs.mjs?station=X` — latest stdmet merged with the `.spec`
  summary. Wave fields ride 30–60 min rows between 10-min met rows, so the
  parser looks back ≤3 h for the freshest row that actually has them (each
  group carries its own timestamp). `s-maxage=600`.
- `api/buoys/spectrum.mjs?station=X` — newest `.data_spec` row merged with
  `.swdir` (alpha1 mean direction) by frequency bin:
  `{time, sepFreq, bins: [{freq, period, energy, dir|null}]}`. `s-maxage=1800`.
- `server.js` — mounts the same `route()`-wrapped handlers at
  `/api/buoys/*` (they're plain `(req,res)` functions, Express-compatible),
  and defaults `NDBC_FIXTURE_DIR` to the test fixtures so local dev works
  offline. Live NDBC is always tried first; fixtures are only the fallback
  (`NDBC_OFFLINE=1` forces them).

**Frontend**
- `public/js/buoys.js` — new component. "Buoys" toggle (persists in
  localStorage; **station list is fetched only the first time it's enabled**,
  so the default load is untouched). Stations render through one geojson
  source + two circle layers (no DOM markers), zoom-gated to z ≥ 4: hollow
  dark-filled rings — bright `#38bdf8` ring + center dot for spectral buoys,
  dimmer rings for wave-only / met-only stations. Click → buoy panel (reuses
  the rating-panel shell/visual language): station name, NDBC id, obs age,
  WVHT/DPD/MWD hero row (ft/s/cardinal + travel arrow), wind/water/air/
  pressure/avg-period rows, swell-partition table (swell vs wind sea from
  `.spec`, with the STEEPNESS tag), and for spectral stations an inline-SVG
  spectrum: log-period x-axis (25s→4s), smoothed filled area, dominant-period
  marker, swell|wind-sea separation line at NDBC's `sepFreq`, and a
  direction-arrow ribbon (arrows point where each band is heading, weighted
  by energy). No chart libraries.
- `app.js` — map clicks on a buoy no longer fall through to the rating panel
  (`buoyFeatureAt`); opening one right-hand panel closes the other.
- `index.html`, `css/style.css` — toggle button, panel markup, `bp-*` styles.

**Tests** — `api/_lib/test/ndbc.test.mjs`: 19 tests over real downloaded
fixtures (46042 Monterey, 46026 San Francisco) plus synthetic edge cases
(missing-value merge, lookback expiry, 999 sentinel, stale-station filter,
station-id validation). `npm run test:api`: **46/46 pass**.

## NDBC / CDIP research findings

- **CORS reality**: `www.ndbc.noaa.gov` (CloudFront + Apache) sends **no
  `Access-Control-Allow-Origin` header** on `/data/realtime2/*` or
  `/activestations.xml` (verified via `curl -sI` July 2026). Browser access is
  impossible; a server-side proxy is mandatory. NDBC's own cache headers are
  `max-age=600` on realtime2 files, `max-age=60` on activestations.xml.
- **URL patterns** (all confirmed live):
  `https://www.ndbc.noaa.gov/data/realtime2/<ID>.{txt,spec,data_spec,swdir,swdir2,swr1,swr2}`
  and `https://www.ndbc.noaa.gov/activestations.xml` (1351 stations, has
  lat/lon/name but **no wave-capability flag**). The realtime2 **directory
  index** turned out to be the best capability source: 944 stations with
  `.txt`, 251 with `.spec`, 175 with `.data_spec`, and per-file last-modified
  times that double as a "recently reporting" filter.
- **Formats**: `.txt`/`.spec` are whitespace tables with `MM` missing values;
  `.data_spec` rows are `sepFreq` + `energy (freq)` pairs; `.swdir` is
  `alpha1 (freq)` pairs with `999.0` missing. Rows are newest-first.
- **CDIP**: not used. CDIP's THREDDS/netCDF JSON access is nicer for full 2D
  spectra, but most surf-relevant CDIP buoys are cross-listed in NDBC's
  realtime2 feed (e.g. 46042 *is* spectral there), so NDBC-only keeps v1 to
  one source, one parser, one proxy. CDIP remains the obvious v2 upgrade for
  true directional 2D spectra.

## Caching strategy

| Endpoint | CDN (`s-maxage` / `stale-while-revalidate`) | In-process TTL |
|---|---|---|
| `/api/buoys/stations` | 86400 / 86400 | 1 h |
| `/api/buoys/obs` | 600 / 600 | 5 min |
| `/api/buoys/spectrum` | 1800 / 1800 | 15 min |

Vercel's CDN takes the brunt: one origin invocation per station per TTL
window worldwide. The small in-memory TTL cache in `ndbc.mjs` additionally
dedupes within a warm lambda and keeps local dev polite to NDBC.

## Verification (all in `verify/`)

- `buoy-layer-west-coast.png` — layer on over CA, spectral vs non-spectral rings visible
- `buoy-panel-46042.png` / `buoy-panel-46042-closeup.png` — Monterey panel,
  **live obs** (8.5 ft @ 16 s WSW that evening) + two-peak spectrum (16 s
  groundswell + 8 s windsea) with direction ribbon
- `buoy-panel-46026-partitions.png` — SF buoy with swell-partition table + STEEP tag
- `buoy-panel-closeup.png` — spectrum detail
- `buoys-verify.mjs` — repeatable headless-Chrome check (`node
  verify/buoys-verify.mjs` with the demo server on :3004): asserts no buoy
  fetches before toggle, layer renders, 46042 panel + spectrum SVG populate,
  and ocean clicks still open the rating panel. **PASSED**; `npm run
  test:api` 46/46.

## Risks / notes

- **Function invocation volume**: worst case is `obs`/`spectrum` per buoy
  click past CDN TTL — negligible at current traffic. The `stations` function
  fetches two ~300–550 KB NDBC files; at s-maxage=86400 that's a handful of
  invocations/day.
- **Directory-index scraping**: `parseRealtimeIndex` regexes an Apache
  autoindex page; if NOAA restyles it, station flags degrade (stations
  endpoint would return an empty list — the toggle simply shows nothing —
  and the parser test fixture pins today's format).
- **Station-list staleness vs fixtures**: the 7-day recency filter uses the
  fixture's own timestamps only in offline mode; months-old fixtures would
  yield an empty offline station list (tests pin `now` explicitly).
- **`.spec` gaps**: some buoys (46042 at times) report `MM` for the
  swell/windsea split; the panel degrades gracefully (partition table hides,
  hero falls back across stdmet→spec fields).
- **Shared Playwright MCP browser** clashed with a concurrent agent during
  verification; the committed `buoys-verify.mjs` launches its own Chrome and
  is the source of truth for the screenshots.
