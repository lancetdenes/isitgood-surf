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
import { loadGrid, deriveGroundswellGrid, deriveWindseaGrid } from './grid.js';
import { initUI, updateLegendVisibility, updateSwellModeUI, setStatus } from './ui.js';
import { loadCoastline, findNearestCoast, reverseGeocode } from './coastline.js';
import KDBush from '/vendor/kdbush/index.js';
import { setKDBush, loadHiresCoastline } from './coastline-hires.js';

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
    // Partitioned swell (swellpart_fNNN.bin) — loaded lazily, only when a
    // partition sub-layer is selected, so the default path stays fast.
    // swellMode: 'combined' | 'ground' | 'windsea'
    this.swellMode = 'combined';
    this.swellPartGrid = null;
    // null = unknown (not probed yet), true/false once checked. Old runs
    // without swellpart files degrade to combined-only with the sub-toggle
    // hidden.
    this.partAvailable = null;
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

      // Load coastline data in background
      loadCoastline().catch(e => console.warn('Coastline load failed:', e));

      this.map.on('click', (e) => this._onMapClick(e));

      await this._loadLatestRun();
    });
  }

  async _loadLatestRun() {
    setStatus('Finding latest data...');
    invalidatePumpingCache();

    // New run/model: partition availability must be re-probed.
    this.partAvailable = null;
    this.swellPartGrid = null;

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

  // Client-side grid cache — avoids re-downloading when scrubbing timeline
  _gridCache = new Map();
  _loadSeq = 0;

  async _cachedLoadGrid(url) {
    if (this._gridCache.has(url)) return this._gridCache.get(url);
    const grid = await loadGrid(url).catch(() => null);
    if (grid) this._gridCache.set(url, grid);
    return grid;
  }

  async _loadHour(hour) {
    if (!this.dataPath) return;

    const fhr = String(hour).padStart(3, '0');
    setStatus(`Loading f${fhr}...`);

    // Latest-wins: rapid scrubbing spawns overlapping loads; only the most
    // recently requested hour may apply its grids when it resolves.
    const seq = ++this._loadSeq;

    // Partition grids are only fetched when a partition sub-layer is active —
    // the combined default never pays for the (4×-larger) swellpart file.
    const needPart = this.swellMode !== 'combined' &&
      (this.layer === 'swell' || this.layer === 'both');

    try {
      const [windGrid, swellGrid, partGrid] = await Promise.all([
        this._cachedLoadGrid(`${this.dataPath}/wind_f${fhr}.bin`),
        this._loadSwellWithFallback(hour),
        needPart ? this._loadPartWithFallback(hour) : Promise.resolve(undefined),
      ]);

      if (seq !== this._loadSeq) return;

      if (windGrid) {
        this.windGrid = windGrid;
        this.wind.setGrid(windGrid);
      }
      if (swellGrid) {
        this.swellGrid = swellGrid;
      }
      if (needPart) {
        this.swellPartGrid = partGrid || null;
        if (!partGrid) this._setPartUnavailable();
      }

      this._updateVisibility();
      setStatus(`f${fhr} loaded`);

      // Preload next 2 hours immediately, all hours in background
      this._preload(hour);
      this._preloadAll();
    } catch (err) {
      console.error('Load error:', err);
      setStatus('Error loading forecast hour');
    }
  }

  /** Preload upcoming hours so animation/scrubbing is instant */
  _preload(currentHour) {
    const partActive = this.swellMode !== 'combined' && this.partAvailable !== false;
    for (const offset of [3, 6]) {
      const h = currentHour + offset;
      if (h > 168) continue;
      const fhr = String(h).padStart(3, '0');
      this._cachedLoadGrid(`${this.dataPath}/wind_f${fhr}.bin`);
      this._cachedLoadGrid(`${this.dataPath}/swell_f${fhr}.bin`);
      if (partActive) this._cachedLoadGrid(`${this.dataPath}/swellpart_f${fhr}.bin`);
    }
  }

  /** Preload ALL hours in background (called after first load) */
  _preloadAll() {
    if (this._preloadStarted || !this.dataPath) return;
    this._preloadStarted = true;
    const load = async () => {
      for (let h = 0; h <= 168; h += 3) {
        const fhr = String(h).padStart(3, '0');
        await this._cachedLoadGrid(`${this.dataPath}/wind_f${fhr}.bin`);
        await this._cachedLoadGrid(`${this.dataPath}/swell_f${fhr}.bin`);
      }
      console.log('All forecast hours preloaded');
    };
    // Start after a short delay so initial render isn't blocked
    setTimeout(load, 2000);
  }

  /** Try loading the exact swell hour; if missing, try the nearest ±3h step. */
  async _loadSwellWithFallback(hour) {
    const fhr = String(hour).padStart(3, '0');
    const grid = await this._cachedLoadGrid(`${this.dataPath}/swell_f${fhr}.bin`);
    if (grid) return grid;

    for (const offset of [3, -3, 6, -6]) {
      const nearby = hour + offset;
      if (nearby < 0) continue;
      const nearFhr = String(nearby).padStart(3, '0');
      const fallback = await this._cachedLoadGrid(`${this.dataPath}/swell_f${nearFhr}.bin`);
      if (fallback) return fallback;
    }
    return null;
  }

  /** Same ±3/±6h fallback for the partitioned swell file. */
  async _loadPartWithFallback(hour) {
    const fhr = String(hour).padStart(3, '0');
    const grid = await this._cachedLoadGrid(`${this.dataPath}/swellpart_f${fhr}.bin`);
    if (grid) {
      this.partAvailable = true;
      return grid;
    }
    for (const offset of [3, -3, 6, -6]) {
      const nearby = hour + offset;
      if (nearby < 0 || nearby > 168) continue;
      const nearFhr = String(nearby).padStart(3, '0');
      const fallback = await this._cachedLoadGrid(`${this.dataPath}/swellpart_f${nearFhr}.bin`);
      if (fallback) {
        this.partAvailable = true;
        return fallback;
      }
    }
    return null;
  }

  /** Old runs have no swellpart files: hide the sub-toggle, go combined. */
  _setPartUnavailable() {
    this.partAvailable = false;
    this.swellMode = 'combined';
    updateSwellModeUI(this);
  }

  /**
   * Cheap availability probe (HEAD, no body) so the sub-toggle only shows
   * when the run actually has partition files. Runs once per data path.
   */
  async _probePartAvailability() {
    if (this.partAvailable !== null || !this.dataPath) return;
    try {
      const resp = await fetch(`${this.dataPath}/swellpart_f000.bin`, { method: 'HEAD' });
      // Only settle on false for a definitive 4xx; transient errors keep null
      // so a later layer switch re-probes.
      if (resp.ok) this.partAvailable = true;
      else if (resp.status >= 400 && resp.status < 500) this.partAvailable = false;
    } catch (e) { /* network hiccup: stay unknown */ }
    updateSwellModeUI(this);
  }

  /** The grid driving the swell heatmap + particles for the active sub-mode. */
  _activeSwellGrid() {
    if (this.swellMode !== 'combined' && this.swellPartGrid) {
      return this.swellMode === 'ground'
        ? deriveGroundswellGrid(this.swellPartGrid)
        : deriveWindseaGrid(this.swellPartGrid);
    }
    return this.swellGrid;
  }

  _updateVisibility() {
    const showWind = this.layer === 'wind' || this.layer === 'both';
    const showSwell = this.layer === 'swell' || this.layer === 'both';

    const swellField = this._activeSwellGrid();

    // Heatmap background: wind speed or swell height
    if (showSwell && !showWind) {
      this.heatmap.setMode('swell');
      this.heatmap.setGrid(swellField);
    } else {
      this.heatmap.setMode('wind');
      this.heatmap.setGrid(this.windGrid);
    }
    this.heatmap.setVisible(true);

    // Wind particles
    this.wind.setVisible(showWind);
    if (showWind && this.windGrid) this.wind.start();
    else this.wind.stop();

    // Swell particles — dash length encodes period on partition layers
    if (swellField) this.swell.setGrid(swellField);
    this.swell.periodDashes = this.swellMode !== 'combined' && !!this.swellPartGrid;
    this.swell.setVisible(showSwell);
    if (showSwell && swellField) this.swell.start();
    else this.swell.stop();

    updateLegendVisibility(this.layer);
    updateSwellModeUI(this);
  }

  setModel(model) {
    if (model === this.model) return;
    this.model = model;
    invalidatePumpingCache();
    this._loadLatestRun();
  }

  setLayer(layer) {
    this.layer = layer;
    if (layer === 'swell' || layer === 'both') this._probePartAvailability();
    this._updateVisibility();
  }

  /** Swell sub-layer: 'combined' | 'ground' | 'windsea'. */
  setSwellMode(mode) {
    if (mode === this.swellMode) return;
    this.swellMode = mode;
    if (mode !== 'combined') {
      // Fetch (or cache-hit) the partition grid for the current hour, then
      // _updateVisibility inside _loadHour swaps the field.
      this._loadHour(this.hour);
    } else {
      this._updateVisibility();
    }
  }

  setHour(hour) {
    this.hour = hour;
    this._loadHour(hour);
    if (isPanelOpen()) syncPanelHour(hour);
    onHourChanged();
  }

  /** Like setHour but returns a promise that resolves when grids are loaded */
  async setHourAsync(hour) {
    this.hour = hour;
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
app.init().catch(err => {
  console.error('App init failed:', err);
  setStatus('Initialization error — check console');
});
loadHiresCoastline().catch(err => {
  console.warn('Failed to load hires coastline; continuing with Natural Earth:', err);
});
