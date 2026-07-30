/**
 * heatmap.js — Vibrant Windy-style color layer rendered as a MapLibre CanvasSource
 *
 * Renders the heatmap INSIDE the map layer stack (below labels/borders,
 * above base tiles) so map features remain visible on top of colors.
 *
 * Performance design (the scrub-critical path):
 *   - The offscreen canvas is attached as a `canvas` source with
 *     animate:false. After each redraw we call source.play() + pause(),
 *     which uploads the canvas straight to the GPU texture — no PNG
 *     encode / blob URL / async image fetch like the old ImageSource path.
 *   - Per-pixel grid sample positions (bilinear indices + weights) only
 *     depend on the viewport and grid geometry, not the forecast hour, so
 *     they're precomputed once per viewport change. A scrub tick then only
 *     runs a tight typed-array loop: 4 reads + LUT palette map per pixel.
 *   - Grid changes render on the next animation frame (no artificial
 *     debounce); viewport moves keep a short debounce since they also
 *     rebuild the sample tables.
 */

// ── Windy-style wind speed palette (m/s) — full spectrum, vivid ──
const WIND_PALETTE = [
  [0,   [15,  20,  80]],
  [1,   [30,  50, 145]],
  [2,   [40,  85, 195]],
  [3,   [30, 145, 215]],
  [5,   [25, 195, 195]],
  [7,   [50, 205, 120]],
  [9,   [135, 220, 60]],
  [11,  [215, 225, 40]],
  [14,  [250, 185, 30]],
  [17,  [245, 115, 30]],
  [20,  [230, 55, 35]],
  [25,  [195, 30, 60]],
  [30,  [165, 20, 115]],
  [40,  [205, 105, 205]],
];

// ── Swell height palette (meters) — indigo → blue → teal → pink/magenta ──
// Distinct from the wind rainbow: stays in the cool/purple family
const SWELL_PALETTE = [
  [0,    [12,   8,  45]],
  [0.3,  [25,  15,  90]],
  [0.6,  [45,  30, 140]],
  [1.0,  [55,  60, 190]],
  [1.5,  [40, 110, 210]],
  [2.0,  [30, 160, 215]],
  [2.5,  [50, 200, 210]],
  [3.5,  [120, 220, 200]],
  [5.0,  [200, 190, 220]],
  [7.0,  [220, 140, 200]],
  [10,   [210,  70, 160]],
  [15,   [180,  30, 120]],
];

function interpolatePalette(palette, val) {
  if (val <= palette[0][0]) return palette[0][1];
  if (val >= palette[palette.length - 1][0]) return palette[palette.length - 1][1];

  for (let i = 1; i < palette.length; i++) {
    if (val <= palette[i][0]) {
      const [v0, c0] = palette[i - 1];
      const [v1, c1] = palette[i];
      const t = (val - v0) / (v1 - v0);
      return [
        Math.round(c0[0] + t * (c1[0] - c0[0])),
        Math.round(c0[1] + t * (c1[1] - c0[1])),
        Math.round(c0[2] + t * (c1[2] - c0[2])),
      ];
    }
  }
  return palette[palette.length - 1][1];
}

const HEATMAP_ALPHA = 220; // per-pixel alpha — high for vibrant color

/**
 * Build a palette LUT packed as little-endian RGBA pixels (Uint32: ABGR),
 * ready to write straight into an ImageData's Uint32 view. All supported
 * browsers/CPUs are little-endian; ImageData bytes are R,G,B,A in memory.
 */
function buildLUT(palette, steps = 1024, maxVal = null) {
  if (!maxVal) maxVal = palette[palette.length - 1][0];
  const lut32 = new Uint32Array(steps);
  for (let i = 0; i < steps; i++) {
    const val = (i / (steps - 1)) * maxVal;
    const [r, g, b] = interpolatePalette(palette, val);
    lut32[i] = (HEATMAP_ALPHA << 24) | (b << 16) | (g << 8) | r;
  }
  return { lut32, steps, maxVal };
}

export { WIND_PALETTE, SWELL_PALETTE, interpolatePalette };

function boundsToCoords(bounds) {
  return [
    [bounds.getWest(), bounds.getNorth()],
    [bounds.getEast(), bounds.getNorth()],
    [bounds.getEast(), bounds.getSouth()],
    [bounds.getWest(), bounds.getSouth()],
  ];
}

export class HeatmapRenderer {
  constructor(map) {
    this.map = map;
    this.grid = null;
    this.mode = 'wind';
    this.visible = true;
    this._renderTimer = null;
    this._renderRaf = null;
    this._layerReady = false;

    // Offscreen rendering
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d');
    this._imgData = null;
    this._data32 = null;

    // Pre-build color LUTs
    this.windLUT = buildLUT(WIND_PALETTE, 1024, 40);
    this.swellLUT = buildLUT(SWELL_PALETTE, 1024, 15);

    // Per-viewport bilinear sample tables (see _ensureSampleTables)
    this._sampleKey = null;
    this._sIdx = null;   // Int32Array, 4 corner indices per pixel (-1 = out of grid)
    this._sWt = null;    // Float32Array, 4 corner weights per pixel

    // Resolution of offscreen render (width; height derived from aspect)
    this.renderWidth = 500;

    this._initLayer();

    map.on('moveend', () => this._scheduleRender());
    map.on('zoomend', () => this._scheduleRender());
  }

  _initLayer() {
    // Canvas sources refuse zero-sized canvases — give it a real size up front.
    this._resizeCanvas();

    this.map.addSource('heatmap', {
      type: 'canvas',
      canvas: this._canvas,
      coordinates: boundsToCoords(this.map.getBounds()),
      animate: false,
    });

    // Insert above ALL base layers (fills, water, lines) — only labels on top.
    // enhanceMapStyle() will then move borders and labels above us.
    const layers = this.map.getStyle().layers;
    let insertBefore = null;
    for (const l of layers) {
      if (l.type === 'symbol') {
        insertBefore = l.id;
        break;
      }
    }

    this.map.addLayer({
      id: 'heatmap-layer',
      type: 'raster',
      source: 'heatmap',
      paint: {
        'raster-opacity': 0.82,
        'raster-fade-duration': 0,
      },
    }, insertBefore);

    this._layerReady = true;
  }

  _resizeCanvas() {
    const w = this.renderWidth;
    const container = this.map.getContainer();
    const aspect = (container.clientHeight || 1) / (container.clientWidth || 1);
    const h = Math.max(1, Math.round(w * aspect));
    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
      this._imgData = this._ctx.createImageData(w, h);
      this._data32 = new Uint32Array(this._imgData.data.buffer);
    }
  }

  /** Debounced render — used for viewport changes (rebuilds sample tables). */
  _scheduleRender() {
    if (!this.visible || !this.grid || !this._layerReady) return;
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => this._render(), 40);
  }

  /** Next-frame render — used when only the data changed (timeline scrub). */
  _renderSoon() {
    if (!this.visible || !this.grid || !this._layerReady) return;
    if (this._renderRaf) return;
    this._renderRaf = requestAnimationFrame(() => {
      this._renderRaf = null;
      this._render();
    });
  }

  setGrid(grid) {
    this.grid = grid;
    if (!grid && this._layerReady) {
      // Clear stale heatmap when no data is available
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      this._pushFrame(null);
      return;
    }
    this._renderSoon();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._renderSoon();
  }

  setVisible(v) {
    this.visible = v;
    if (this._layerReady) {
      this.map.setLayoutProperty('heatmap-layer', 'visibility', v ? 'visible' : 'none');
    }
    if (v) this._renderSoon();
  }

  /** Convert latitude (degrees) to Mercator Y */
  _latToMercY(lat) {
    const radLat = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + radLat / 2));
  }

  /** Convert Mercator Y back to latitude (degrees) */
  _mercYToLat(y) {
    return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
  }

  /**
   * Precompute the 4 bilinear corner indices + weights for every canvas
   * pixel. Depends only on viewport bounds, canvas size and grid geometry —
   * NOT on the forecast hour — so scrubbing reuses it for every frame.
   */
  _ensureSampleTables(grid, w, h, west, east, north, south) {
    const key = `${grid.nx},${grid.ny},${grid.lo1},${grid.la1},${grid.dx},${grid.dy}|` +
                `${w}x${h}|${west},${east},${north},${south}`;
    if (this._sampleKey === key) return;
    this._sampleKey = key;

    const n = w * h;
    if (!this._sIdx || this._sIdx.length !== n * 4) {
      this._sIdx = new Int32Array(n * 4);
      this._sWt = new Float32Array(n * 4);
    }
    const sIdx = this._sIdx;
    const sWt = this._sWt;

    const { nx, ny, lo1, la1, dx, dy } = grid;

    // Per-column longitude → grid i0/i1/fx (columns share these across rows)
    const colI0 = new Int32Array(w);
    const colI1 = new Int32Array(w);
    const colFx = new Float32Array(w);
    for (let col = 0; col < w; col++) {
      const lon = west + (col / (w - 1)) * (east - west);
      let fi = (lon - lo1) / dx;
      fi -= Math.floor(fi / nx) * nx; // wrap into [0, nx)
      const i0 = Math.floor(fi);
      colI0[col] = i0;
      colI1[col] = (i0 + 1) % nx;
      colFx[col] = fi - i0;
    }

    // Use Mercator projection for latitude interpolation so the heatmap
    // pixels align with the map's Mercator-projected tiles.
    const mercNorth = this._latToMercY(north);
    const mercSouth = this._latToMercY(south);

    for (let row = 0; row < h; row++) {
      const mercY = mercNorth - (row / (h - 1)) * (mercNorth - mercSouth);
      const lat = this._mercYToLat(mercY);
      const fj = (la1 - lat) / dy;
      const base = row * w * 4;

      if (fj < 0 || fj >= ny - 1) {
        for (let col = 0; col < w; col++) sIdx[base + col * 4] = -1;
        continue;
      }

      const j0 = Math.floor(fj);
      const fy = fj - j0;
      const row0 = j0 * nx;
      const row1 = Math.min(j0 + 1, ny - 1) * nx;

      for (let col = 0; col < w; col++) {
        const o = base + col * 4;
        const fx = colFx[col];
        sIdx[o]     = row0 + colI0[col];
        sIdx[o + 1] = row0 + colI1[col];
        sIdx[o + 2] = row1 + colI0[col];
        sIdx[o + 3] = row1 + colI1[col];
        sWt[o]     = (1 - fx) * (1 - fy);
        sWt[o + 1] = fx * (1 - fy);
        sWt[o + 2] = (1 - fx) * fy;
        sWt[o + 3] = fx * fy;
      }
    }
  }

  /** Upload the freshly drawn canvas to the map (one-shot, no encode). */
  _pushFrame(coords) {
    let src;
    try {
      src = this.map.getSource('heatmap');
    } catch (e) { return; }
    if (!src) return;
    if (coords) {
      try { src.setCoordinates(coords); } catch (e) { /* source not ready */ }
    }
    // animate:false canvas source only re-uploads its texture while playing;
    // play() marks it dirty + triggers a repaint, pause() (which re-uploads
    // once more) stops it from forcing continuous repaints afterwards.
    if (src.play && src.pause) {
      src.play();
      this.map.once('render', () => { try { src.pause(); } catch (e) {} });
    }
    (window.__perfLog ||= []).push({ t: performance.now(), type: 'heatmap-frame' });
  }

  _render() {
    if (!this.visible || !this.grid || !this._layerReady) return;
    const _t0 = performance.now();

    const bounds = this.map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();

    this._resizeCanvas();
    const w = this._canvas.width;
    const h = this._canvas.height;

    this._ensureSampleTables(this.grid, w, h, west, east, north, south);

    const data32 = this._data32;
    const sIdx = this._sIdx;
    const sWt = this._sWt;
    const { lut32, steps, maxVal } = this.mode === 'wind' ? this.windLUT : this.swellLUT;
    const idxScale = steps / maxVal;
    const n = w * h;

    if (this.mode === 'swell') {
      // Swell uses an ocean-only rule: pixels whose bilinear cell touches
      // land (height < minH at any corner) stay transparent — no smeared
      // heights over the coastline. Mirrors Grid.interpolateSwellHeight.
      const H = this.grid.arrays[0];
      const minH = 0.05;
      for (let px = 0; px < n; px++) {
        const o = px * 4;
        const i00 = sIdx[o];
        if (i00 < 0) { data32[px] = 0; continue; }
        const h00 = H[i00], h10 = H[sIdx[o + 1]], h01 = H[sIdx[o + 2]], h11 = H[sIdx[o + 3]];
        if (h00 < minH || h10 < minH || h01 < minH || h11 < minH) { data32[px] = 0; continue; }
        const mag = sWt[o] * h00 + sWt[o + 1] * h10 + sWt[o + 2] * h01 + sWt[o + 3] * h11;
        if (mag < 0.05) { data32[px] = 0; continue; }
        let li = (mag * idxScale) | 0;
        if (li >= steps) li = steps - 1;
        data32[px] = lut32[li];
      }
    } else {
      const U = this.grid.arrays[0];
      const V = this.grid.arrays[1];
      for (let px = 0; px < n; px++) {
        const o = px * 4;
        const i00 = sIdx[o];
        if (i00 < 0) { data32[px] = 0; continue; }
        const i10 = sIdx[o + 1], i01 = sIdx[o + 2], i11 = sIdx[o + 3];
        const w00 = sWt[o], w10 = sWt[o + 1], w01 = sWt[o + 2], w11 = sWt[o + 3];
        const u = w00 * U[i00] + w10 * U[i10] + w01 * U[i01] + w11 * U[i11];
        const v = w00 * V[i00] + w10 * V[i10] + w01 * V[i01] + w11 * V[i11];
        const mag = Math.sqrt(u * u + v * v);
        if (mag < 0.05) { data32[px] = 0; continue; }
        let li = (mag * idxScale) | 0;
        if (li >= steps) li = steps - 1;
        data32[px] = lut32[li];
      }
    }

    this._ctx.putImageData(this._imgData, 0, 0);
    (window.__perfLog ||= []).push({ t: performance.now(), type: 'heatmap-render', dur: performance.now() - _t0 });

    this._pushFrame(boundsToCoords(bounds));
  }

  destroy() {
    clearTimeout(this._renderTimer);
    if (this._renderRaf) cancelAnimationFrame(this._renderRaf);
  }
}
