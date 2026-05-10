/**
 * Map-backed compass for the rating panel's selected-detail row.
 *
 * Renders a circular MapLibre mini-map at the click's projected coast point,
 * using the same CartoDB Dark Matter style as the big map so coastlines look
 * identical. Swell arrow + wind barbs are layered as an absolutely-positioned
 * SVG overlay on top.
 *
 * Usage (two-step because innerHTML rebuilds destroy the map div):
 *   const html = renderMapCompassHTML(150, h, coast, slot);
 *   // ...inject html into the panel via innerHTML...
 *   mountMapCompass(slot, h, coast);
 */

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
// Zoom 13 ≈ ~5km radius visible — enough to read local coast features
// (points, jetties, bays) while still showing the coast as a recognizable
// shape rather than a wall of pixels.
const COMPASS_ZOOM = 13;

const _maps = new Map(); // slot id → { map, ready }

export function renderMapCompassHTML(size, h, coast, slotId) {
  const cb = coast.coastBearing || 0;
  const swellDir = h.swellDir || 0;
  const windDir = h.windDir || 0;

  const ht = Math.min(h.swellHeightFt, 8);
  const arrowW = Math.max(2, 1.5 + ht * 0.5);
  const arrowH = Math.max(14, 10 + ht * 3);
  const headW = Math.max(6, 4 + ht * 1.5);
  const headH = 10;
  const arrowStart = -58;
  const shaftEnd = arrowStart + arrowH;
  const arrowTip = shaftEnd + headH;
  const arrowOp = Math.min(0.95, 0.5 + ht / 10);

  const ws = Math.min(h.windSpeedMph, 30);
  const barbCount = Math.max(1, Math.min(6, Math.ceil(ws / 5)));
  const barbLen = Math.max(18, 12 + ws * 0.8);
  const barbW = 1.4;
  const barbOp = Math.min(0.7, 0.3 + ws / 30);
  const barbSpacing = 10;
  let barbs = '';
  const halfSpread = ((barbCount - 1) * barbSpacing) / 2;
  for (let i = 0; i < barbCount; i++) {
    const x = -halfSpread + i * barbSpacing;
    const startY = -77;
    const endY = startY + barbLen;
    barbs += `<line x1="${x}" y1="${startY}" x2="${x}" y2="${endY}" stroke="white" stroke-width="${barbW}" stroke-dasharray="5,4"/>`;
    barbs += `<line x1="${x}" y1="${endY}" x2="${x + 6}" y2="${endY - 6}" stroke="white" stroke-width="${barbW}"/>`;
  }

  return `
    <div class="rp-mapcompass" style="width:${size}px;height:${size}px"
         data-slot="${slotId}">
      <div class="rp-mapcompass-map" id="${slotId}"></div>
      <svg class="rp-mapcompass-overlay" viewBox="0 0 200 200">
        <text x="100" y="11" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="700" stroke="#000" stroke-width="2.5" paint-order="stroke">N</text>
        <text x="194" y="105" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="700" stroke="#000" stroke-width="2.5" paint-order="stroke">E</text>
        <text x="100" y="198" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="700" stroke="#000" stroke-width="2.5" paint-order="stroke">S</text>
        <text x="6" y="105" text-anchor="middle" fill="#e2e8f0" font-size="11" font-weight="700" stroke="#000" stroke-width="2.5" paint-order="stroke">W</text>
        <g transform="translate(100,100) rotate(${swellDir})">
          <rect x="${-arrowW}" y="${arrowStart}" width="${arrowW * 2}" height="${arrowH}" fill="white" opacity="${arrowOp}" rx="1" stroke="#000" stroke-width="0.5"/>
          <polygon points="0,${arrowTip} ${-headW},${shaftEnd} ${headW},${shaftEnd}" fill="white" opacity="${arrowOp}" stroke="#000" stroke-width="0.5"/>
        </g>
        <g transform="translate(100,100) rotate(${windDir})" opacity="${barbOp}">
          ${barbs}
        </g>
      </svg>
    </div>
  `;
}

/**
 * After the panel HTML is in the DOM, find the placeholder div and either
 * init a fresh MapLibre instance or update the existing one.
 */
export function mountMapCompass(slotId, coast) {
  const el = document.getElementById(slotId);
  if (!el) return;

  if (typeof maplibregl === 'undefined') {
    console.warn('maplibregl not loaded — compass map skipped');
    return;
  }

  const center = [coast.coastLon, coast.coastLat];
  let entry = _maps.get(slotId);

  if (entry && entry.map) {
    // Slot exists and points at the same DOM container? Just reuse.
    if (entry.map.getContainer() === el) {
      entry.map.setCenter(center);
      entry.map.setZoom(COMPASS_ZOOM);
      return;
    }
    // Container was replaced (innerHTML rebuild). Tear down stale map.
    try { entry.map.remove(); } catch {}
    _maps.delete(slotId);
  }

  const map = new maplibregl.Map({
    container: el,
    style: STYLE_URL,
    center,
    zoom: COMPASS_ZOOM,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
  });
  _maps.set(slotId, { map, ready: false });
  map.on('load', () => {
    // Strip everything except land + water + coastlines so the compass
    // reads as "this is the local coast", not a generic basemap with
    // road clutter. Layer ids in CartoDB Dark Matter follow OpenMapTiles
    // conventions: water*, landcover*, landuse*, boundary*, road*,
    // place_*, country_*, building, etc.
    const layers = map.getStyle().layers || [];
    const KEEP = /^(background|water|landcover|landuse|park|wetland|sand|beach|coast|ice)/i;
    for (const layer of layers) {
      if (!KEEP.test(layer.id)) {
        try { map.setLayoutProperty(layer.id, 'visibility', 'none'); } catch {}
      }
    }
    const e = _maps.get(slotId);
    if (e) e.ready = true;
  });
}

export function unmountAllMapCompasses() {
  for (const { map } of _maps.values()) {
    try { map.remove(); } catch {}
  }
  _maps.clear();
}
