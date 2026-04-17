/**
 * map.js — MapLibre GL initialization with Windy-style border/label treatment
 *
 * Uses CartoDB Dark Matter base, then enhances borders (dark/black outlines)
 * and labels (white text with dark halos) so they stay readable over the heatmap.
 */

export function initMap(container) {
  const map = new maplibregl.Map({
    container,
    style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    center: [-74.0, 38.5],
    zoom: 5,
    minZoom: 2,
    maxZoom: 12,
    antialias: true,
    doubleClickZoom: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

  return map;
}

/**
 * After the heatmap layer is added, call this to restyle borders/labels
 * so they pop over the colored background.
 */
export function enhanceMapStyle(map) {
  const layers = map.getStyle().layers;

  for (const layer of layers) {
    const id = (layer.id || '').toLowerCase();

    // ── Dark boundary lines ──
    if (layer.type === 'line') {
      if (id.includes('boundar') || id.includes('border') || id.includes('admin')) {
        try {
          map.setPaintProperty(layer.id, 'line-color', '#111111');
          map.setPaintProperty(layer.id, 'line-opacity', 1);
        } catch (e) { /* ignore unsupported */ }
      }
    }

    // ── White labels with dark halos (like Windy) ──
    if (layer.type === 'symbol') {
      try {
        map.setPaintProperty(layer.id, 'text-color', '#e8e8e8');
        map.setPaintProperty(layer.id, 'text-halo-color', '#111111');
        map.setPaintProperty(layer.id, 'text-halo-width', 1.8);
        map.setPaintProperty(layer.id, 'text-opacity', 0.95);
      } catch (e) { /* ignore */ }
    }
  }

  // ── Add coastline outlines from the water polygon boundaries ──
  // CartoDB Dark Matter uses OpenMapTiles vector tiles which include a "water"
  // layer with polygons. We render their outlines as black coastline lines.
  const style = map.getStyle();
  const sourceName = _findVectorSource(style);
  if (sourceName) {
    map.addLayer({
      id: 'coastline-outline',
      type: 'line',
      source: sourceName,
      'source-layer': 'water',
      paint: {
        'line-color': '#000000',
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          2, 0.6,
          5, 1.0,
          10, 1.4,
        ],
        'line-opacity': 0.85,
      },
    });
  }

  // Move all symbol layers to the very top (above heatmap)
  const symbolLayers = layers.filter(l => l.type === 'symbol').map(l => l.id);
  for (const id of symbolLayers) {
    try { map.moveLayer(id); } catch (e) { /* ignore */ }
  }

  // Move boundary lines and coastline above heatmap too
  const boundaryLayers = layers.filter(l =>
    l.type === 'line' && /(boundar|border|admin)/i.test(l.id)
  ).map(l => l.id);
  if (sourceName) boundaryLayers.push('coastline-outline');
  for (const id of boundaryLayers) {
    try {
      if (symbolLayers.length > 0) {
        map.moveLayer(id, symbolLayers[0]);
      } else {
        map.moveLayer(id);
      }
    } catch (e) { /* ignore */ }
  }
}

/** Find the first vector tile source in the style (CartoDB's source). */
function _findVectorSource(style) {
  if (!style.sources) return null;
  for (const [name, src] of Object.entries(style.sources)) {
    if (src.type === 'vector') return name;
  }
  return null;
}
