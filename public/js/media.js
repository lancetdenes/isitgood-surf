/**
 * media.js — spot media: upload sheet, sign-in modal, media strip + lightbox.
 *
 * The whole feature is gated on the API actually being deployed: apiAvailable()
 * probes /api/me once and every entry point no-ops until it responds like a
 * real endpoint (200 or 401). This keeps the static site clean when the
 * serverless functions/env aren't provisioned yet.
 *
 * Location handling (photo-geolocation fork):
 *  - geotagged photo → EXIF GPS snapped to the named-spots list and labeled
 *    "📍 <spot> — from your photo" (auto-assign).
 *  - no geotag → the upload CANNOT proceed until the user sets a location in
 *    the full-screen picker (geo-picker.js). No more silent defaults.
 */
import { snapToSpot } from './spot-snap.js';
import { loadNamedSpots } from './named-spots.js';
import { pickLocation } from './geo-picker.js';

// exifr (75KB) is only needed when a user actually picks a photo to upload —
// import it lazily so it stays off the initial-load module graph.
let _exifrPromise = null;
function loadExifr() {
  if (!_exifrPromise) {
    _exifrPromise = import('/vendor/exifr/full.esm.js').then(m => m.default);
  }
  return _exifrPromise;
}

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

/**
 * Downscale an image file to <=1600px JPEG. Returns {blob, contentType}.
 * Files already within the limit upload as-is: a canvas re-encode strips
 * EXIF, which would make the server-side "verified" re-check impossible.
 */
async function downscalePhoto(file) {
  const bitmap = await createImageBitmap(file);
  if (Math.max(bitmap.width, bitmap.height) <= 1600 &&
      (file.type === 'image/jpeg' || file.type === 'image/png')) {
    return { blob: file, contentType: file.type };
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { blob, contentType: 'image/jpeg' };
}

/** "📍 Higgins Beach — from your photo" etc. for the upload sheet. */
function locationLabel(snap, lat, lng, origin) {
  const suffix = origin === 'exif' ? ' — from your photo'
    : origin === 'user' ? ' — set by you' : '';
  if (snap.tier === 'at') return `📍 ${snap.spot.n}${suffix}`;
  if (snap.tier === 'near') return `📍 near ${snap.spot.n} (${snap.km.toFixed(1)} km)${suffix}`;
  return `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}${suffix}`;
}

export async function openUploadSheet({ lat, lng }) {
  if (!(await apiAvailable())) return;
  const user = await ensureSignedIn();
  if (!user) return;
  const spots = await loadNamedSpots();

  const sheet = document.getElementById('upload-sheet');
  const backdrop = document.getElementById('upload-backdrop');
  const fileInput = document.getElementById('upload-file');
  const timeInput = document.getElementById('upload-time');
  const stampTag = document.getElementById('upload-stamp-tag');
  const submit = document.getElementById('upload-submit');
  const status = document.getElementById('upload-status');
  const preview = document.getElementById('upload-preview');
  const locLabel = document.getElementById('upload-location-label');
  const locBtn = document.getElementById('upload-location-btn');

  sheet.hidden = false; backdrop.hidden = false;
  status.textContent = ''; preview.innerHTML = ''; submit.disabled = true;
  fileInput.value = '';
  document.getElementById('upload-caption').value = '';

  let pin = { lat, lng };
  let locationConfirmed = false;   // EXIF GPS or an explicit pick — never silent
  let stampSource = 'manual';
  let picked = null;               // {blob, contentType, kind}

  const refreshLocationRow = (origin) => {
    if (!locationConfirmed) {
      locLabel.textContent = '📍 no location yet — set where this was taken';
      locLabel.classList.add('upload-location-missing');
      locBtn.textContent = 'set location';
      return;
    }
    locLabel.classList.remove('upload-location-missing');
    locLabel.textContent = locationLabel(snapToSpot(spots, pin.lat, pin.lng), pin.lat, pin.lng, origin);
    locBtn.textContent = 'adjust';
  };
  refreshLocationRow();

  const openPicker = async () => {
    const res = await pickLocation({ lat: pin.lat, lng: pin.lng });
    if (!res) return false;
    pin = { lat: res.lat, lng: res.lng };
    locationConfirmed = true;
    if (stampSource === 'exif') {
      stampSource = 'manual';                 // user overrode the EXIF pin
      stampTag.textContent = 'location set by uploader';
    } else if (picked) {
      stampSource = 'manual';
      stampTag.textContent = 'location set by uploader';
    }
    refreshLocationRow('user');
    return true;
  };
  locBtn.onclick = openPicker;

  const close = () => { sheet.hidden = true; backdrop.hidden = true; };
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
      locationConfirmed = false;              // videos carry no EXIF → must pick
      refreshLocationRow();
    } else {
      // EXIF prefill from the ORIGINAL file (downscaling can strip metadata).
      // NOTE: per-segment pick — a global pick: ['latitude'] drops the GPS
      // block before exifr converts coordinates. exifr itself loads lazily.
      const exif = await loadExifr()
        .then(exifr => exifr.parse(file, { exif: ['DateTimeOriginal'], gps: true }))
        .catch(() => null);
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
        // ── Auto-assign: geotagged photo snaps to its spot ──
        pin = { lat: exif.latitude, lng: exif.longitude };
        locationConfirmed = true;
        setTime(new Date(exif.DateTimeOriginal));
        stampSource = 'exif';
        stampTag.textContent = 'verified from photo';
        refreshLocationRow('exif');
      } else {
        stampSource = 'device';
        stampTag.textContent = 'no photo metadata — set time & location';
        locationConfirmed = false;
        refreshLocationRow();
      }
      submit.disabled = false;
    }
  };

  submit.onclick = async () => {
    if (!picked) return;
    // Non-geotagged media must pass through the picker before upload.
    if (!locationConfirmed) {
      if (!(await openPicker())) { status.textContent = 'Set a location to upload.'; return; }
    }
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
      el.onclick = () => openLightbox(m, window.__mediaTimelineCtx || null);
      return el;
    }));
  } catch {
    // List endpoint failing means the backend isn't (fully) provisioned —
    // e.g. functions deployed but no DATABASE_URL yet. Hide the feature
    // rather than showing a dead strip.
    strip.remove();
  }
}

// ── Lightbox ──

/** "2h before this frame" / "at this frame" relative to the timeline hour. */
function relateToFrame(capturedMs, frameMs) {
  const dh = (frameMs - capturedMs) / 3600e3;
  if (Math.abs(dh) < 0.75) return 'at this frame';
  const h = Math.round(Math.abs(dh));
  const unit = h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`;
  return dh > 0 ? `${unit} before this frame` : `${unit} after this frame`;
}

/**
 * Lightbox for a media item. `ctx` (optional) couples it to the forecast
 * timeline: { runTime: Date, getHour(): number, jumpToHour(h): void }.
 */
export function openLightbox(m, ctx = null) {
  const wrap = document.createElement('div');
  wrap.className = 'media-lightbox';
  const media = document.createElement(m.kind === 'video' ? 'video' : 'img');
  media.src = m.url;
  if (m.kind === 'video') { media.controls = true; media.autoplay = true; }
  const meta = document.createElement('div');
  meta.className = 'media-lightbox-meta';

  const when = new Date(m.capturedAt);
  const whenStr = when.toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit',
  });

  const spotLine = document.createElement('span');
  spotLine.className = 'media-lightbox-spot';
  spotLine.textContent = `📍 ${m.spotName || `${(+m.lat).toFixed(3)}, ${(+m.lng).toFixed(3)}`}`;

  const line1 = document.createElement('span');
  const badge = m.stampSource === 'exif'
    ? '<span class="media-badge media-badge-exif">✓ verified capture</span>'
    : '<span class="media-badge">user-reported</span>';
  let rel = '';
  if (ctx && ctx.runTime) {
    const frameMs = ctx.runTime.getTime() + ctx.getHour() * 3600e3;
    rel = `, ${relateToFrame(when.getTime(), frameMs)}`;
  }
  line1.innerHTML = `${whenStr}${rel} ${badge}`;

  const line2 = document.createElement('span');
  line2.textContent = `@${m.handle}${m.caption ? ' — ' + m.caption : ''}`;

  meta.append(spotLine, line1, line2);

  if (ctx && ctx.runTime && ctx.jumpToHour) {
    const jump = document.createElement('button');
    jump.className = 'ctrl-btn media-jump';
    jump.textContent = '⏱ jump timeline to this photo';
    jump.onclick = () => {
      // Raw hours since runTime — jumpToHour snaps to the nearest step of
      // the non-uniform 85-step timeline (3h core / 6h extended, max 336h).
      const h = (when.getTime() - ctx.runTime.getTime()) / 3600e3;
      ctx.jumpToHour(Math.max(0, h));
      wrap.remove();
    };
    meta.append(jump);
  }

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
  meta.append(report);
  wrap.append(media, meta);
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}
