/**
 * geo-picker.js — full-screen location picker for photo uploads.
 *
 * pickLocation({lat, lng}) opens a fullscreen MapLibre map with a fixed
 * center crosshair, a live nearest-spot label that updates as you pan, a
 * "use my location" button (browser geolocation), and a search box that
 * filters the named-spots list. Resolves {lat, lng, snap} on confirm or
 * null on cancel. Non-geotagged uploads are routed through this before
 * they can be submitted (media.js enforces it).
 */
import { snapToSpot } from './spot-snap.js';
import { loadNamedSpots } from './named-spots.js';

const fmt = (v) => v.toFixed(4);

export function pickLocation({ lat, lng }) {
  return new Promise(async (resolve) => {
    const spots = await loadNamedSpots();

    const overlay = document.createElement('div');
    overlay.className = 'geo-picker';
    overlay.innerHTML = `
      <div class="geo-picker-head">
        <div class="geo-picker-search">
          <input type="text" id="geo-picker-search" placeholder="Search spots… e.g. Higgins Beach" autocomplete="off">
          <div class="geo-picker-results" id="geo-picker-results" hidden></div>
        </div>
        <button class="close-btn" id="geo-picker-close">&times;</button>
      </div>
      <div class="geo-picker-map" id="geo-picker-map">
        <div class="geo-picker-crosshair" aria-hidden="true">
          <span class="gp-ring"></span><span class="gp-dot"></span>
        </div>
      </div>
      <div class="geo-picker-foot">
        <div class="geo-picker-label" id="geo-picker-label"></div>
        <div class="geo-picker-actions">
          <button class="ctrl-btn" id="geo-picker-locate">◎ use my location</button>
          <button class="ctrl-btn geo-picker-confirm" id="geo-picker-confirm">Set photo location</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const map = new maplibregl.Map({
      container: 'geo-picker-map',
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [lng, lat],
      zoom: 10,
      minZoom: 2,
      maxZoom: 15,
      attributionControl: false,
      doubleClickZoom: false,
    });

    const labelEl = overlay.querySelector('#geo-picker-label');
    const updateLabel = () => {
      const c = map.getCenter();
      const snap = snapToSpot(spots, c.lat, c.lng);
      if (snap.tier === 'at') {
        labelEl.innerHTML = `📍 <b>${snap.spot.n}</b> <span class="gp-region">${snap.spot.r}</span>`;
      } else if (snap.tier === 'near') {
        labelEl.innerHTML = `📍 near <b>${snap.spot.n}</b> · ${snap.km.toFixed(1)} km <span class="gp-region">(exact spot kept)</span>`;
      } else {
        labelEl.innerHTML = `📍 ${fmt(c.lat)}, ${fmt(c.lng)}`;
      }
    };
    map.on('move', updateLabel);
    map.on('load', updateLabel);

    // ── Spot search ──
    const searchInput = overlay.querySelector('#geo-picker-search');
    const resultsEl = overlay.querySelector('#geo-picker-results');
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (q.length < 2) { resultsEl.hidden = true; return; }
      const hits = spots.filter(s =>
        s.n.toLowerCase().includes(q) || (s.r || '').toLowerCase().includes(q)).slice(0, 8);
      resultsEl.replaceChildren(...hits.map(s => {
        const row = document.createElement('button');
        row.className = 'geo-picker-result';
        row.innerHTML = `${s.n} <span class="gp-region">${s.r || ''}</span>`;
        row.onclick = () => {
          resultsEl.hidden = true;
          searchInput.value = s.n;
          map.jumpTo({ center: [s.ln, s.la], zoom: 12 });
        };
        return row;
      }));
      resultsEl.hidden = hits.length === 0;
    });

    // ── Browser geolocation ──
    const locateBtn = overlay.querySelector('#geo-picker-locate');
    locateBtn.onclick = () => {
      if (!navigator.geolocation) { locateBtn.textContent = 'geolocation unavailable'; return; }
      locateBtn.textContent = '◎ locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          locateBtn.textContent = '◎ use my location';
          map.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 12 });
        },
        () => { locateBtn.textContent = 'location denied'; },
        { enableHighAccuracy: true, timeout: 8000 },
      );
    };

    const finish = (result) => {
      map.remove();
      overlay.remove();
      resolve(result);
    };
    overlay.querySelector('#geo-picker-close').onclick = () => finish(null);
    overlay.querySelector('#geo-picker-confirm').onclick = () => {
      const c = map.getCenter();
      finish({ lat: c.lat, lng: c.lng, snap: snapToSpot(spots, c.lat, c.lng) });
    };
  });
}
