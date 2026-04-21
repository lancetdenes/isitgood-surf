/**
 * heatmap.js — Vibrant Windy-style color layer rendered as a MapLibre ImageSource
 *
 * Renders the heatmap INSIDE the map layer stack (below labels/borders,
 * above base tiles) so map features remain visible on top of colors.
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

// 1x1 transparent PNG data URL (placeholder before first render)
const TRANSPARENT_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQIHWNgAAIABQABNjN9GQAAAABJRlFOYQQAAAAASUVORK5CYII=';

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

function buildLUT(palette, steps = 1024, maxVal = null) {
  if (!maxVal) maxVal = palette[palette.length - 1][0];
  const lut = new Uint8Array(steps * 3);
  for (let i = 0; i < steps; i++) {
    const val = (i / (steps - 1)) * maxVal;
    const [r, g, b] = interpolatePalette(palette, val);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return { lut, steps, maxVal };
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
    this._layerReady = false;

    // Offscreen rendering
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d');
    this._imgData = null;

    // Pre-build color LUTs
    this.windLUT = buildLUT(WIND_PALETTE, 1024, 40);
    this.swellLUT = buildLUT(SWELL_PALETTE, 1024, 15);

    // Resolution of offscreen render (width; height derived from aspect)
    this.renderWidth = 500;

    this._initLayer();

    map.on('moveend', () => this._scheduleRender());
    map.on('zoomend', () => this._scheduleRender());
  }

  _initLayer() {
    const bounds = this.map.getBounds();

    this.map.addSource('heatmap', {
      type: 'image',
      url: TRANSPARENT_PIXEL,
      coordinates: boundsToCoords(bounds),
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

  _scheduleRender() {
    if (!this.visible || !this.grid || !this._layerReady) return;
    clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => this._render(), 40);
  }

  setGrid(grid) {
    this.grid = grid;
    if (!grid && this._layerReady) {
      // Clear stale heatmap when no data is available
      try {
        this.map.getSource('heatmap').updateImage({
          url: TRANSPARENT_PIXEL,
          coordinates: boundsToCoords(this.map.getBounds()),
        });
      } catch (e) { /* source not ready */ }
      return;
    }
    this._scheduleRender();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._scheduleRender();
  }

  setVisible(v) {
    this.visible = v;
    if (this._layerReady) {
      this.map.setLayoutProperty('heatmap-layer', 'visibility', v ? 'visible' : 'none');
    }
    if (v) this._scheduleRender();
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

  _render() {
    if (!this.visible || !this.grid || !this._layerReady) return;

    const bounds = this.map.getBounds();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const north = bounds.getNorth();
    const south = bounds.getSouth();

    const w = this.renderWidth;
    const mapContainer = this.map.getContainer();
    const aspect = mapContainer.clientHeight / mapContainer.clientWidth;
    const h = Math.round(w * aspect);

    if (this._canvas.width !== w || this._canvas.height !== h) {
      this._canvas.width = w;
      this._canvas.height = h;
      this._imgData = this._ctx.createImageData(w, h);
    }

    const data = this._imgData.data;
    const lutObj = this.mode === 'wind' ? this.windLUT : this.swellLUT;
    const { lut, steps, maxVal } = lutObj;
    const alpha = 220; // per-pixel alpha — high for vibrant color

    // Use Mercator projection for latitude interpolation so the heatmap
    // pixels align with the map's Mercator-projected tiles.
    const mercNorth = this._latToMercY(north);
    const mercSouth = this._latToMercY(south);

    const isSwell = this.mode === 'swell';
    for (let row = 0; row < h; row++) {
      const mercY = mercNorth - (row / (h - 1)) * (mercNorth - mercSouth);
      const lat = this._mercYToLat(mercY);
      for (let col = 0; col < w; col++) {
        const lon = west + (col / (w - 1)) * (east - west);
        const px = (row * w + col) * 4;

        // Swell uses an ocean-only interpolator so pixels whose bilinear cell
        // touches land stay transparent — no smeared heights over coastline.
        let magnitude;
        if (isSwell) {
          const sw = this.grid.interpolateSwell(lon, lat);
          if (!sw) {
            data[px] = 0; data[px + 1] = 0; data[px + 2] = 0; data[px + 3] = 0;
            continue;
          }
          magnitude = sw.height;
        } else {
          const vals = this.grid.interpolate(lon, lat);
          if (!vals) {
            data[px] = 0; data[px + 1] = 0; data[px + 2] = 0; data[px + 3] = 0;
            continue;
          }
          magnitude = Math.sqrt(vals[0] * vals[0] + vals[1] * vals[1]);
        }

        if (magnitude < 0.05) {
          data[px] = 0; data[px + 1] = 0; data[px + 2] = 0; data[px + 3] = 0;
          continue;
        }

        const idx = Math.min(Math.floor((magnitude / maxVal) * steps), steps - 1) * 3;
        data[px] = lut[idx];
        data[px + 1] = lut[idx + 1];
        data[px + 2] = lut[idx + 2];
        data[px + 3] = alpha;
      }
    }

    this._ctx.putImageData(this._imgData, 0, 0);

    try {
      this.map.getSource('heatmap').updateImage({
        url: this._canvas.toDataURL(),
        coordinates: boundsToCoords(bounds),
      });
    } catch (e) {
      // Source not ready yet
    }
  }

  destroy() {
    clearTimeout(this._renderTimer);
  }
}
