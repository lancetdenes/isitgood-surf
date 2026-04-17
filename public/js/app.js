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
import { loadGrid } from './grid.js';
import { initUI, updateLegendVisibility, setStatus } from './ui.js';
import { loadCoastline, findNearestCoast, reverseGeocode } from './coastline.js';
import { initPanel, openPanel, isPanelOpen, syncPanelHour, updatePanelSpotName } from './panel.js';

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

      initUI(this);
      initPanel();

      // Load coastline data in background
      loadCoastline().catch(e => console.warn('Coastline load failed:', e));

      this.map.on('click', (e) => this._onMapClick(e));

      await this._loadLatestRun();
    });
  }

  async _loadLatestRun() {
    setStatus('Finding latest data...');

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

    try {
      const [windGrid, swellGrid] = await Promise.all([
        this._cachedLoadGrid(`${this.dataPath}/wind_f${fhr}.bin`),
        this._loadSwellWithFallback(hour),
      ]);

      if (windGrid) {
        this.windGrid = windGrid;
        this.wind.setGrid(windGrid);
      }
      if (swellGrid) {
        this.swellGrid = swellGrid;
        this.swell.setGrid(swellGrid);
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
    for (const offset of [3, 6]) {
      const h = currentHour + offset;
      if (h > 168) continue;
      const fhr = String(h).padStart(3, '0');
      this._cachedLoadGrid(`${this.dataPath}/wind_f${fhr}.bin`);
      this._cachedLoadGrid(`${this.dataPath}/swell_f${fhr}.bin`);
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
    this._loadLatestRun();
  }

  setLayer(layer) {
    this.layer = layer;
    this._updateVisibility();
  }

  setHour(hour) {
    this.hour = hour;
    this._loadHour(hour);
    if (isPanelOpen()) syncPanelHour(hour);
  }

  /** Like setHour but returns a promise that resolves when grids are loaded */
  async setHourAsync(hour) {
    this.hour = hour;
    await this._loadHour(hour);
    if (isPanelOpen()) syncPanelHour(hour);
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
      const coast = findNearestCoast(lat, lng);
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
