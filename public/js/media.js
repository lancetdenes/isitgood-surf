/**
 * media.js — spot media: upload sheet, sign-in modal, media strip + lightbox.
 *
 * The whole feature is gated on the API actually being deployed: apiAvailable()
 * probes /api/me once and every entry point no-ops until it responds like a
 * real endpoint (200 or 401). This keeps the static site clean when the
 * serverless functions/env aren't provisioned yet.
 */
import exifr from '/vendor/exifr/full.esm.js';

// ── API availability + session ──

let _apiProbe = null;
export function apiAvailable() {
  if (!_apiProbe) {
    _apiProbe = fetch('/api/me')
      .then(r => r.status === 200 || r.status === 401)
      .catch(() => false);
  }
  return _apiProbe;
}

let _me = null;
export async function getMe() {
  if (_me !== null) return _me;
  try {
    const r = await fetch('/api/me');
    _me = r.ok ? (await r.json()).user : false;
  } catch { _me = false; }
  return _me;
}

export function ensureSignedIn() {
  return getMe().then(u => {
    if (u) return u;
    return new Promise((resolve) => {
      const modal = document.getElementById('signin-modal');
      modal.hidden = false;
      document.getElementById('signin-close').onclick = () => { modal.hidden = true; resolve(null); };
      document.getElementById('signin-send').onclick = async () => {
        const email = document.getElementById('signin-email').value.trim();
        const status = document.getElementById('signin-status');
        status.textContent = 'Sending…';
        try {
          const r = await fetch('/api/auth/request-link', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          status.textContent = r.ok
            ? 'Check your email and open the link, then try again.'
            : 'Could not send — check the address.';
        } catch {
          status.textContent = 'Could not send — try again.';
        }
      };
    });
  });
}

// ── Upload sheet ──

/** Downscale an image file to <=1600px JPEG. Returns {blob, contentType}. */
async function downscalePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { blob, contentType: 'image/jpeg' };
}

export async function openUploadSheet({ lat, lng }) {
  if (!(await apiAvailable())) return;
  const user = await ensureSignedIn();
  if (!user) return;

  const sheet = document.getElementById('upload-sheet');
  const backdrop = document.getElementById('upload-backdrop');
  const fileInput = document.getElementById('upload-file');
  const timeInput = document.getElementById('upload-time');
  const stampTag = document.getElementById('upload-stamp-tag');
  const submit = document.getElementById('upload-submit');
  const status = document.getElementById('upload-status');
  const preview = document.getElementById('upload-preview');

  sheet.hidden = false; backdrop.hidden = false;
  status.textContent = ''; preview.innerHTML = ''; submit.disabled = true;
  fileInput.value = '';
  document.getElementById('upload-caption').value = '';

  let pin = { lat, lng };
  let stampSource = 'manual';
  let picked = null;   // {blob, contentType, kind}

  // Mini-map for pin confirm (plain background — precision comes from context
  // of where the user clicked; full basemap tiles are overkill here).
  const mini = new maplibregl.Map({
    container: 'upload-minimap',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#12203a' } }] },
    center: [lng, lat], zoom: 9, attributionControl: false,
  });
  const marker = new maplibregl.Marker({ draggable: true, color: '#38bdf8' })
    .setLngLat([lng, lat]).addTo(mini);
  marker.on('dragend', () => {
    const p = marker.getLngLat();
    pin = { lat: p.lat, lng: p.lng };
    stampSource = 'manual';
    stampTag.textContent = 'location set by uploader';
  });

  const close = () => { sheet.hidden = true; backdrop.hidden = true; mini.remove(); };
  document.getElementById('upload-close').onclick = close;
  backdrop.onclick = close;

  const setTime = (d) => {
    timeInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  setTime(new Date());
  timeInput.onchange = () => {
    if (stampSource === 'exif') {
      stampSource = 'manual';
      stampTag.textContent = 'location set by uploader';
    }
  };

  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');
    submit.disabled = true;
    status.textContent = '';

    if (isVideo) {
      if (file.size > 100 * 1024 * 1024) { status.textContent = 'Video too large (max 100 MB).'; return; }
      picked = { blob: file, contentType: file.type, kind: 'video' };
      const v = document.createElement('video');
      v.src = URL.createObjectURL(file); v.muted = true; v.controls = true;
      v.onloadedmetadata = () => {
        if (v.duration > 31) {
          status.textContent = 'Clips must be 30 seconds or less.';
          picked = null;
        } else {
          submit.disabled = false;
        }
      };
      preview.replaceChildren(v);
      stampSource = 'device';
      stampTag.textContent = 'user-reported time & place';
    } else {
      // EXIF prefill from the ORIGINAL file (downscaling strips metadata)
      const exif = await exifr.parse(file, { gps: true, pick: ['DateTimeOriginal', 'latitude', 'longitude'] }).catch(() => null);
      try {
        picked = { ...(await downscalePhoto(file)), kind: 'photo' };
      } catch {
        status.textContent = 'Could not read that image.';
        return;
      }
      const img = document.createElement('img');
      img.src = URL.createObjectURL(picked.blob);
      preview.replaceChildren(img);
      if (exif && exif.latitude != null && exif.DateTimeOriginal) {
        pin = { lat: exif.latitude, lng: exif.longitude };
        marker.setLngLat([pin.lng, pin.lat]);
        mini.setCenter([pin.lng, pin.lat]);
        setTime(new Date(exif.DateTimeOriginal));
        stampSource = 'exif';
        stampTag.textContent = 'verified from photo — confirm the pin';
      } else {
        stampSource = 'device';
        stampTag.textContent = 'no photo metadata — confirm time & pin';
      }
      submit.disabled = false;
    }
  };

  submit.onclick = async () => {
    if (!picked) return;
    submit.disabled = true;
    status.textContent = 'Uploading…';
    try {
      const presign = await fetch('/api/uploads/presign', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: picked.kind, contentType: picked.contentType, bytes: picked.blob.size }),
      });
      if (!presign.ok) throw new Error((await presign.json()).code || 'presign_failed');
      const { mediaId, uploadUrl } = await presign.json();

      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': picked.contentType }, body: picked.blob });
      if (!put.ok) throw new Error('storage_failed');

      const complete = await fetch('/api/uploads/complete', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaId, lat: pin.lat, lng: pin.lng,
          capturedAt: new Date(timeInput.value).toISOString(),
          caption: document.getElementById('upload-caption').value,
          claimedStampSource: stampSource,
        }),
      });
      if (!complete.ok) throw new Error((await complete.json()).code || 'complete_failed');
      status.textContent = 'Uploaded ✓';
      _stripCache = { key: null, items: null };   // force refetch
      setTimeout(close, 700);
      document.dispatchEvent(new CustomEvent('media-uploaded', { detail: { lat: pin.lat, lng: pin.lng } }));
    } catch (e) {
      status.textContent = e.message === 'rate_limited' ? 'Daily upload limit reached.' : 'Upload failed — try again.';
      submit.disabled = false;
    }
  };
}

// ── Media strip (rendered into the rating panel) ──

let _stripCache = { key: null, items: null };

/**
 * Render the "Recent media" strip into `container`. Called from panel.js
 * render(), which runs on every hour scrub — so results are cached per
 * location and re-rendered synchronously when possible.
 */
export async function renderMediaStrip(container, lat, lng) {
  if (!(await apiAvailable())) return;
  if (!container || !container.isConnected) return;

  let strip = container.querySelector('.media-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'media-strip';
    container.appendChild(strip);
  }
  strip.innerHTML = '<div class="media-strip-head"><span>Recent media</span>' +
    '<button class="ctrl-btn media-add-btn" title="Add photo/clip">📷 add</button></div>' +
    '<div class="media-thumbs">Loading…</div>';
  strip.querySelector('.media-add-btn').onclick = () => openUploadSheet({ lat, lng });

  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  try {
    if (_stripCache.key !== key) {
      const r = await fetch(`/api/spots/media?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`);
      if (!r.ok) throw new Error();
      _stripCache = { key, items: (await r.json()).items };
    }
    const items = _stripCache.items;
    const thumbs = strip.querySelector('.media-thumbs');
    if (!thumbs) return;                    // panel re-rendered underneath us
    if (!items.length) { thumbs.textContent = 'No media yet — be the first.'; return; }
    thumbs.replaceChildren(...items.map(m => {
      const el = document.createElement(m.kind === 'video' ? 'video' : 'img');
      el.src = m.url;
      if (m.kind === 'video') { el.muted = true; el.preload = 'metadata'; }
      el.className = 'media-thumb';
      el.title = `${new Date(m.capturedAt).toLocaleString()} · ${m.stampSource === 'exif' ? 'verified' : 'user-reported'}`;
      el.onclick = () => openLightbox(m);
      return el;
    }));
  } catch {
    const thumbs = strip.querySelector('.media-thumbs');
    if (thumbs) thumbs.textContent = 'Media unavailable.';
  }
}

function openLightbox(m) {
  const wrap = document.createElement('div');
  wrap.className = 'media-lightbox';
  const media = document.createElement(m.kind === 'video' ? 'video' : 'img');
  media.src = m.url;
  if (m.kind === 'video') { media.controls = true; media.autoplay = true; }
  const meta = document.createElement('div');
  meta.className = 'media-lightbox-meta';
  const when = new Date(m.capturedAt);
  const line1 = document.createElement('span');
  line1.textContent = `${when.toLocaleString()} · ${m.stampSource === 'exif' ? '✓ verified capture data' : 'user-reported'}`;
  const line2 = document.createElement('span');
  line2.textContent = `@${m.handle}${m.caption ? ' — ' + m.caption : ''}`;
  const report = document.createElement('button');
  report.className = 'media-report';
  report.textContent = 'report';
  report.onclick = async () => {
    await fetch('/api/report', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: m.id, reason: 'user report' }),
    }).catch(() => {});
    report.textContent = 'reported ✓';
  };
  meta.append(line1, line2, report);
  wrap.append(media, meta);
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}
