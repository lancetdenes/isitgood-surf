/**
 * media-map.js — photos ON the map, coupled to the forecast timeline.
 *
 * Each live photo is a small circular thumbnail marker at its (lat, lng).
 * Scrubbing the timeline brightens photos captured within ±TIME_WINDOW_HOURS
 * of the frame's absolute time (runTime + hour) and dims the rest to 30% —
 * a photo is ground truth pinned to (lat, lng, captured_at), so when you
 * look at a forecast frame you see the photographic evidence from around
 * that moment. Hour scrubs only toggle a CSS class per marker (Date parsed
 * once per photo); no re-fetch, no layout work.
 *
 * Fetching: GET /api/spots/media?bbox=w,s,e,n&sinceHours=168 on layer
 * enable + debounced moveend, cached by rounded bbox. Everything hides when
 * the media API isn't provisioned (same gate as the rest of media.js).
 */
import { apiAvailable, openUploadSheet, openLightbox } from './media.js';
import { hourToIndex } from './hours.js';

/** Photos within ±6h of the timeline frame are "live" (bright). */
export const TIME_WINDOW_HOURS = 6;
const SINCE_HOURS = 168;             // how far back the map layer looks
const MIN_ZOOM = 3.5;                // below this markers hide entirely
const DOT_ZOOM = 5;                  // below this markers shrink to dots

let _app = null;
let _enabled = false;
let _userToggled = false;            // once the user chooses, stop auto-defaulting
let _markers = new Map();            // id -> {marker, el, t}
let _cache = new Map();              // bboxKey -> items
let _fetchSeq = 0;

function timelineCtx() {
  return {
    runTime: _app.runTime,
    getHour: () => _app.hour,
    jumpToHour: (h) => {
      // The slider is INDEX-based over the non-uniform 85-step timeline
      // (0-168h @3h, 174-336h @6h) — hourToIndex snaps any hour value to
      // the nearest step and clamps to the 0-336h range.
      const slider = document.getElementById('hour-slider');
      slider.value = hourToIndex(h);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
}

function bboxKey(b) {
  const r = (v) => (Math.round(v * 50) / 50).toFixed(2);   // 0.02° ≈ 2 km buckets
  return `${r(b.getWest())},${r(b.getSouth())},${r(b.getEast())},${r(b.getNorth())}`;
}

async function fetchViewport() {
  const b = _app.map.getBounds();
  const key = bboxKey(b);
  if (_cache.has(key)) return _cache.get(key);
  const seq = ++_fetchSeq;
  try {
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map(v => v.toFixed(3)).join(',');
    const r = await fetch(`/api/spots/media?bbox=${bbox}&sinceHours=${SINCE_HOURS}&limit=200`);
    if (!r.ok) throw new Error();
    const items = (await r.json()).items;
    if (seq === _fetchSeq) _cache.set(key, items);
    return items;
  } catch {
    return null;                       // backend half-provisioned → treat as none
  }
}

function makeMarkerEl(m) {
  // MapLibre owns the marker root's inline transform/opacity (positioning,
  // terrain occlusion) — all visual state lives on an inner element so the
  // dim/tiny classes can't be clobbered.
  const root = document.createElement('div');
  const el = document.createElement('div');
  el.className = 'photo-marker';
  el.style.backgroundImage = `url("${m.url}")`;
  el.title = m.spotName || `${(+m.lat).toFixed(3)}, ${(+m.lng).toFixed(3)}`;
  el.addEventListener('click', (e) => {
    e.stopPropagation();               // don't trigger the map's rating click
    openLightbox(m, timelineCtx());
  });
  root.appendChild(el);
  return { root, el };
}

function renderMarkers(items) {
  const keep = new Set();
  for (const m of items) {
    keep.add(m.id);
    if (_markers.has(m.id)) continue;
    const { root, el } = makeMarkerEl(m);
    const marker = new maplibregl.Marker({ element: root, anchor: 'center' })
      .setLngLat([m.lng, m.lat])
      .addTo(_app.map);
    _markers.set(m.id, { marker, el, t: Date.parse(m.capturedAt) });
  }
  for (const [id, rec] of _markers) {
    if (!keep.has(id)) { rec.marker.remove(); _markers.delete(id); }
  }
  syncHour();
  syncZoom();
}

function clearMarkers() {
  for (const rec of _markers.values()) rec.marker.remove();
  _markers.clear();
}

/** Cheap per-scrub update: toggle one class per marker. */
export function syncHour() {
  if (!_enabled || !_app || !_app.runTime) return;
  const frameMs = _app.runTime.getTime() + _app.hour * 3600e3;
  const win = TIME_WINDOW_HOURS * 3600e3;
  for (const rec of _markers.values()) {
    rec.el.classList.toggle('photo-dim', Math.abs(rec.t - frameMs) > win);
  }
}

function syncZoom() {
  if (!_app) return;
  const z = _app.map.getZoom();
  for (const rec of _markers.values()) {
    rec.el.classList.toggle('photo-hidden', z < MIN_ZOOM);
    rec.el.classList.toggle('photo-tiny', z >= MIN_ZOOM && z < DOT_ZOOM);
  }
}

async function refresh() {
  if (!_enabled) return;
  const items = await fetchViewport();
  if (!_enabled) return;               // toggled off while fetching
  if (items) renderMarkers(items);
}

function setEnabled(on) {
  _enabled = on;
  const btn = document.getElementById('photos-toggle');
  if (btn) btn.classList.toggle('active', on);
  if (on) refresh();
  else clearMarkers();
}

export async function initMediaMap(app) {
  _app = app;
  if (!(await apiAvailable())) return;   // unprovisioned backend → stay hidden

  // Timeline context for lightboxes opened from the panel strip too.
  window.__mediaTimelineCtx = timelineCtx();

  // ── "Photos" toggle in the layer switcher ──
  const btn = document.getElementById('photos-toggle');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    _userToggled = true;
    setEnabled(!_enabled);
  });

  // ── Floating upload button (📷) ──
  const fab = document.getElementById('media-fab');
  fab.hidden = false;
  fab.addEventListener('click', () => {
    const c = _app.map.getCenter();
    openUploadSheet({ lat: c.lat, lng: c.lng });
  });

  // Debounced viewport refetch.
  let moveTimer = null;
  _app.map.on('moveend', () => {
    if (!_enabled) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refresh, 350);
  });
  _app.map.on('zoom', syncZoom);

  document.addEventListener('media-uploaded', () => {
    _cache.clear();
    if (_enabled) refresh();
    else if (!_userToggled) setEnabled(true);
  });

  // Default ON when there are photos in the initial view — the photos are
  // the differentiator. Stay off (until toggled) when the area is empty.
  const items = await fetchViewport();
  if (items && items.length && !_userToggled) setEnabled(true);
}
