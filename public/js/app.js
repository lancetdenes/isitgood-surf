/**
 * app.js — Main application controller for Is It Good?
 *
 * Layer stack (bottom to top):
 *   1. MapLibre dark basemap (land, water fills)
 *   2. Heatmap raster (MapLibre ImageSource — vibrant colors)
 *   3. Map borders + coastlines (MapLibre line layers)
 *   4. Map labels (MapLibre symbol layers)
 *   5. Wind/Swell particle canvases (DOM overlay)
 */

import { initMap, enhanceMapStyle } from './map.js';
import { WindRenderer } from './wind.js';
import { SwellRenderer } from './swell.js';
import { HeatmapRenderer } from './heatmap.js';
import { GridStore } from './grid-store.js';
import { initUI, updateLegendVisibility, setStatus, syncTimeline } from './ui.js';
import { FORECAST_HOURS, hourToIndex } from './hours.js';
import { loadCoastline, findNearestCoast, reverseGeocode } from './coastline.js';
import KDBush from '/vendor/kdbush/index.js';
import { setKDBush } from './coastline-hires.js';

setKDBush(KDBush);
import { initPanel, openPanel, isPanelOpen, syncPanelHour, updatePanelSpotName } from './panel.js';
import { initPumping, onHourChanged, invalidatePumpingCache } from './pumping.js';

class App {
  constructor() {
    this.model = 'gfs';
    this.layer = 'wind';
    this.hour = 0;
    this.dataPath = null;
    this.runTime = null;
    this.marker = null;
    this.windGrid = null;
    this.swellGrid = null;
    this.map = null;
    this.wind = null;
    this.swell = null;
    this.heatmap = null;
  }

  async init() {
    this.map = initMap('map');

    this.map.on('load', async () => {
      // Heatmap renders inside MapLibre's layer stack (below labels/borders)
      this.heatmap = new HeatmapRenderer(this.map);

      // Restyle borders/labels to be visible over the heatmap
      enhanceMapStyle(this.map);

      // Particle canvases sit on top of everything
      this.wind = new WindRenderer(document.getElementById('wind-canvas'), this.map);
      this.swell = new SwellRenderer(document.getElementById('swell-canvas'), this.map);

      // Flow-speed zoom-feel tuning: ?flowexp=0.25 in the URL, or
      // __flowTune(0.25) in the console. 0 = constant screen speed,
      // 0.33 = old steep curve. Live-adjustable to find the right feel.
      const tune = (exp) => {
        this.wind.speedZoomExp = exp;
        this.swell.speedZoomExp = exp;
        console.log(`flow speedZoomExp = ${exp}`);
      };
      window.__flowTune = tune;
      const flowExp = parseFloat(new URLSearchParams(location.search).get('flowexp'));
      if (Number.isFinite(flowExp)) tune(flowExp);

      initUI(this);
      initPanel();
      initPumping(this);

      this.map.on('click', (e) => this._onMapClick(e));

      await this._loadLatestRun();
    });
  }

  async _loadLatestRun() {
    setStatus('Finding latest data...');
    invalidatePumpingCache();
    this._store.reset(); // drop queued prefetches from a previous run/model

    const config = window.SURF_CONFIG || {};
    const manifestUrl = config.MANIFEST_URL || `/api/latest/${this.model}`;
    const dataBase = config.DATA_BASE || '';

    try {
      let resp = await fetch(manifestUrl);
      if (!resp.ok && !config.MANIFEST_URL) {
        // Only fall back to demo when on Fly (same-origin manifest).
        resp = await fetch('/api/latest/demo');
      }
      if (!resp.ok) {
        setStatus('No data — run: npm run demo');
        return;
      }

      const info = await resp.json();
      // Prepend the data base so absolute R2 URLs work the same as relative
      // /data/ paths under Fly. info.path is e.g. "/data/gfs/20260417_12z".
      this.dataPath = dataBase ? `${dataBase}${info.path}` : info.path;

      if (info.run && info.run !== 'demo') {
        const m = info.run.match(/(\d{4})(\d{2})(\d{2})_(\d{2})z/);
        if (m) this.runTime = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00Z`);
      } else {
        this.runTime = new Date();
      }

      // Update timeline ticks with actual day names
      if (this._onRunTimeReady) this._onRunTimeReady(this.runTime);

      await this._loadHour(this.hour);
      setStatus(`${info.model.toUpperCase()} — ${info.run}`);
    } catch (err) {
      console.error('Failed to load run:', err);
      setStatus('Error loading data');
    }
  }

  // Decoded-grid cache + prioritized fetch/decode pipeline (Web Worker).
  // `_gridCache` aliases the store's LRU map for dev tooling/back-compat.
  _store = new GridStore();
  _gridCache = this._store.cache;
  _loadSeq = 0;

  _cachedLoadGrid(url, priority = 0) {
    return this._store.load(url, priority);
  }

  _windUrl(hour) {
    return `${this.dataPath}/wind_f${String(hour).padStart(3, '0')}.bin`;
  }

  _swellUrl(hour) {
    return `${this.dataPath}/swell_f${String(hour).padStart(3, '0')}.bin`;
  }

  /**
   * Apply grids to the renderers, then refresh layers. Always assigns —
   * a missing hour (null grid) must clear the layer rather than silently
   * keep the previous hour's field on screen labelled as this hour. All
   * renderers and the heatmap handle a null grid.
   */
  _applyGrids(windGrid, swellGrid) {
    this.windGrid = windGrid;
    this.wind.setGrid(windGrid);
    this.swellGrid = swellGrid;
    this.swell.setGrid(swellGrid);
    this._updateVisibility();
  }

  /**
   * Status honesty: say exactly what is showing for this hour —
   * "loaded", "swell showing fMMM (nearest available)", or
   * "no wind/swell data for this hour". Never label a neighboring
   * hour's field as this hour without saying so.
   */
  _setHourStatus(hour, windGrid, swellRes) {
    const fhr = String(hour).padStart(3, '0');
    const missing = [];
    if (!windGrid) missing.push('wind');
    if (!swellRes.grid) missing.push('swell');
    if (missing.length) {
      setStatus(`f${fhr} — no ${missing.join('/')} data for this hour`);
    } else if (swellRes.actualHour !== hour) {
      setStatus(`f${fhr} loaded — swell showing f${String(swellRes.actualHour).padStart(3, '0')} (nearest available)`);
    } else {
      setStatus(`f${fhr} loaded`);
    }
  }

  async _loadHour(hour) {
    if (!this.dataPath) return;

    const fhr = String(hour).padStart(3, '0');

    // Latest-wins: rapid scrubbing spawns overlapping loads; only the most
    // recently requested hour may apply its grids when it resolves.
    const seq = ++this._loadSeq;

    // Re-center the background prefetcher on the new hour.
    this._schedulePrefetch(hour);

    // ── Instant path — serve from the decoded cache, no await. Covers the
    //    known-missing case too (negative cache): status says so honestly. ──
    const cachedWind = this._store.peek(this._windUrl(hour));
    const windKnownMissing = !cachedWind && this._store.isNegative(this._windUrl(hour));
    const swellPeek = this._peekSwellResolved(hour);
    if ((cachedWind || windKnownMissing) && swellPeek) {
      this._applyGrids(cachedWind, swellPeek.grid);
      this._setHourStatus(hour, cachedWind, swellPeek);
      (window.__perfLog ||= []).push({ t: performance.now(), type: 'hour-applied', hour });
      this._kickCoastlineLoad();
      return;
    }

    // ── Never leave the map stale while the network runs: render the
    //    nearest already-decoded frame right now — honestly labelled as a
    //    preview — then swap when the exact data arrives (latest-wins). ──
    setStatus(`Loading f${fhr}...`);
    {
      const nearHour = this._nearestCachedHour(hour);
      if (nearHour !== null) {
        this._applyGrids(
          cachedWind || this._store.peek(this._windUrl(nearHour)) || this.windGrid,
          (swellPeek && swellPeek.grid) || this._store.peek(this._swellUrl(nearHour)) || this.swellGrid,
        );
        setStatus(`f${fhr} — previewing f${String(nearHour).padStart(3, '0')} while loading...`);
      }
    }

    try {
      const [windGrid, swellRes] = await Promise.all([
        this._store.load(this._windUrl(hour), -1),
        this._loadSwellWithFallback(hour),
      ]);

      if (seq !== this._loadSeq) return;

      this._applyGrids(windGrid, swellRes.grid);
      this._setHourStatus(hour, windGrid, swellRes);
      (window.__perfLog ||= []).push({ t: performance.now(), type: 'hour-applied', hour });
      this._kickCoastlineLoad();
    } catch (err) {
      console.error('Load error:', err);
      setStatus('Error loading forecast hour');
    }
  }

  /**
   * Start the (14.5 MB) hires coastline download once the first grids are
   * on screen so it doesn't compete with the initial heatmap for bandwidth.
   * Clicking the map earlier still works: loadCoastline() kicks the same
   * shared fetch on demand.
   */
  _kickCoastlineLoad() {
    if (this._coastlineKicked) return;
    this._coastlineKicked = true;
    const start = () => loadCoastline().catch(e => console.warn('Coastline load failed:', e));
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
    else setTimeout(start, 500);
  }

  /**
   * Enqueue every forecast hour (all 85 steps, 0–336h — the shared
   * FORECAST_HOURS list, 3h core / 6h extended), prioritized by
   * timeline-step distance from the current hour (slight forward bias —
   * play/scrub usually moves forward). The store dedups: already-cached/
   * pending URLs are a no-op apart from a possible priority bump, so
   * calling this on every scrub tick is cheap and keeps the pool always
   * working on the most useful frames.
   */
  _schedulePrefetch(centerHour) {
    if (!this.dataPath) return;
    const ci = hourToIndex(centerHour);
    for (let i = 0; i < FORECAST_HOURS.length; i++) {
      const h = FORECAST_HOURS[i];
      const d = i - ci;
      const priority = d >= 0 ? d : -d + 1;
      this._store.load(this._windUrl(h), priority);
      this._store.load(this._swellUrl(h), priority);
    }
  }

  /**
   * Nearest hour (by timeline-step distance on the non-uniform axis) whose
   * wind grid is already decoded, or null.
   */
  _nearestCachedHour(hour) {
    const ci = hourToIndex(hour);
    for (let d = 1; d < FORECAST_HOURS.length; d++) {
      for (const i of [ci - d, ci + d]) {
        if (i < 0 || i >= FORECAST_HOURS.length) continue;
        if (this._store.has(this._windUrl(FORECAST_HOURS[i]))) return FORECAST_HOURS[i];
      }
    }
    return null;
  }

  /**
   * The two timeline steps on either side of `hour`, in swap-in preference
   * order. Uses the shared hours list so the 6-hourly extended range and
   * the 168→174 cadence change are handled — never h±3 arithmetic.
   */
  _swellNeighborHours(hour) {
    const ci = hourToIndex(hour);
    const out = [];
    for (const i of [ci + 1, ci - 1, ci + 2, ci - 2]) {
      if (i < 0 || i >= FORECAST_HOURS.length) continue;
      if (FORECAST_HOURS[i] !== hour) out.push(FORECAST_HOURS[i]);
    }
    return out;
  }

  /**
   * Synchronous, fully-resolved swell lookup for the instant scrub path.
   * Returns `{ grid, actualHour }` for the exact hour, or — ONLY when the
   * exact hour is negative-cached (known missing) — the nearest cached
   * timeline-step neighbor, mirroring _loadSwellWithFallback (actualHour
   * reveals the substitution so status can label it). Returns null when
   * the answer can't be determined without the network (caller falls
   * through to the async path).
   */
  _peekSwellResolved(hour) {
    const exact = this._store.peek(this._swellUrl(hour));
    if (exact) return { grid: exact, actualHour: hour };
    if (!this._store.isNegative(this._swellUrl(hour))) return null;
    for (const nearby of this._swellNeighborHours(hour)) {
      const url = this._swellUrl(nearby);
      const fallback = this._store.peek(url);
      if (fallback) return { grid: fallback, actualHour: nearby };
      if (!this._store.isNegative(url)) return null;
    }
    // Exact hour and all neighbors are known-missing: honest "no data".
    return { grid: null, actualHour: null };
  }

  /**
   * Try loading the exact swell hour; if missing, try the neighboring
   * timeline steps (non-uniform axis aware). Returns { grid, actualHour }
   * so callers can surface the substitution instead of silently labelling
   * a neighboring hour's field as this hour.
   */
  async _loadSwellWithFallback(hour) {
    const grid = await this._store.load(this._swellUrl(hour), -1);
    if (grid) return { grid, actualHour: hour };

    for (const nearby of this._swellNeighborHours(hour)) {
      const fallback = await this._store.load(this._swellUrl(nearby), -1);
      if (fallback) return { grid: fallback, actualHour: nearby };
    }
    return { grid: null, actualHour: null };
  }

  _updateVisibility() {
    const showWind = this.layer === 'wind' || this.layer === 'both';
    const showSwell = this.layer === 'swell' || this.layer === 'both';

    // Heatmap background: wind speed or swell height
    if (showSwell && !showWind) {
      this.heatmap.setMode('swell');
      this.heatmap.setGrid(this.swellGrid);
    } else {
      this.heatmap.setMode('wind');
      this.heatmap.setGrid(this.windGrid);
    }
    this.heatmap.setVisible(true);

    // Wind particles
    this.wind.setVisible(showWind);
    if (showWind && this.windGrid) this.wind.start();
    else this.wind.stop();

    // Swell particles
    this.swell.setVisible(showSwell);
    if (showSwell && this.swellGrid) this.swell.start();
    else this.swell.stop();

    updateLegendVisibility(this.layer);
  }

  setModel(model) {
    if (model === this.model) return;
    this.model = model;
    invalidatePumpingCache();
    this._loadLatestRun();
  }

  setLayer(layer) {
    this.layer = layer;
    this._updateVisibility();
  }

  setHour(hour) {
    this.hour = hour;
    this._loadHour(hour);
    syncTimeline(hour, this.runTime);
    if (isPanelOpen()) syncPanelHour(hour);
    onHourChanged();
  }

  /** Like setHour but returns a promise that resolves when grids are loaded */
  async setHourAsync(hour) {
    this.hour = hour;
    syncTimeline(hour, this.runTime);
    await this._loadHour(hour);
    if (isPanelOpen()) syncPanelHour(hour);
    onHourChanged();
  }

  async _onMapClick(e) {
    const { lng, lat } = e.lngLat;
    if (!this.dataPath) return;

    if (this.marker) this.marker.remove();
    this.marker = new maplibregl.Marker({ color: '#a855f7' })
      .setLngLat([lng, lat])
      .addTo(this.map);

    setStatus('Loading surf rating...');

    try {
      await loadCoastline();
      const coast = findNearestCoast(lat, lng, this.swellGrid);
      // Start geocode in background (don't block panel opening)
      const geocodePromise = reverseGeocode(lat, lng);
      // Pass our grid cache loader so the panel's 57-hour forecast reuses
      // already-downloaded grids instead of re-fetching them.
      await openPanel(lat, lng, coast, this.dataPath, this.runTime, this.hour,
                      (url) => this._cachedLoadGrid(url));
      // Update spot name once geocode resolves
      geocodePromise.then(name => { if (name) updatePanelSpotName(name); });
      setStatus('Surf rating ready');
    } catch (err) {
      console.error('Rating panel error:', err);
      setStatus('Error loading rating');
    }
  }
}

const app = new App();
// Dev/measurement hook — used by verify/measure.js (Playwright harness).
window.__app = app;
app.init().catch(err => {
  console.error('App init failed:', err);
  setStatus('Initialization error — check console');
});
