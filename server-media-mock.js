/**
 * server-media-mock.js — local-dev mock of the media backend.
 *
 * The real media backend is Vercel functions + Neon + R2 (see
 * SPEC-spot-media-uploads.md) and needs provisioning that hasn't happened
 * yet. This module makes the whole media feature demoable under plain
 * `node server.js`: an always-signed-in /api/me, seeded photo fixtures near
 * real NE-US spots, and a presign/complete upload flow that stores bytes in
 * a local tmp dir. It is mounted by server.js ONLY when DATABASE_URL is
 * absent (or MEDIA_MOCK=1), so the production Vercel path is untouched.
 *
 * Endpoint shapes mirror the real functions in api/ (same JSON fields) so
 * the client code exercised locally is exactly what runs in prod.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const FIXTURE_DIR = path.join(__dirname, 'test', 'fixtures', 'media');
const UPLOAD_DIR = path.join(os.tmpdir(), 'surf-media-mock');

// ESM/CJS bridge: the real validation + trust-tier logic is reused, not
// reimplemented, so mock behavior can't drift from the prod functions.
const libs = Promise.all([
  import('./api/_lib/uploadrules.mjs'),
  import('./api/_lib/stamp.mjs'),
  import('./public/js/spot-snap.js'),
]).then(([uploadrules, stamp, snap]) => ({ ...uploadrules, ...stamp, ...snap }));
const exifr = require('exifr');

const spots = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data', 'named-spots.json'), 'utf8'));
const spotByName = (n) => spots.find(s => s.n === n);

// ── Seed data: ~15 photos around real NE-US spots, captured over the ──
// ── past 48 h (relative to server boot). ──
function seedItems() {
  const now = Date.now();
  // [spot name, dLat, dLng, hoursAgo, stampSource, caption]
  // Small offsets keep some seeds "at" the spot (<2 km) and push others
  // into the "near" (2–10 km) tier.
  const rows = [
    ['Higgins Beach',       0.002,  0.003,  1.5, 'exif',   'clean lines this morning'],
    ['Higgins Beach',       0.030,  0.040,  7,   'device', ''],
    ['Hampton Beach',      -0.003,  0.002,  3,   'exif',   'waist high and glassy'],
    ['Nantasket',           0.004, -0.002,  5.5, 'manual', ''],
    ['Narragansett',        0.001,  0.004, 10,   'exif',   'point was working'],
    ['Narragansett',       -0.045,  0.020, 26,   'device', 'south end, bit mushy'],
    ['Montauk',             0.003, -0.004,  2,   'exif',   'pumping'],
    ['Montauk',             0.002,  0.002, 30,   'manual', ''],
    ['Rockaway Beach',     -0.002,  0.003,  4,   'exif',   'crowded but fun'],
    ['Long Beach',          0.001, -0.003, 14,   'device', ''],
    ['Manasquan Inlet',     0.002,  0.001,  0.5, 'exif',   'RIGHT NOW'],
    ['Long Beach Island',  -0.004,  0.002, 20,   'manual', 'yesterday evening'],
    ['Ocean City NJ',       0.003, -0.001, 36,   'device', ''],
    ['Ocean City MD',      -0.001,  0.002, 42,   'exif',   'leftover swell'],
    ['Virginia Beach',      0.002,  0.004, 47,   'device', 'small but rideable'],
  ];
  return rows.map(([name, dLat, dLng, hoursAgo, stampSource, caption], i) => {
    const s = spotByName(name);
    if (!s) return null;
    return {
      id: `seed-${i + 1}`,
      kind: 'photo',
      url: `/fixtures/media/placeholder-${(i % 6) + 1}.png`,
      lat: +(s.la + dLat).toFixed(5),
      lng: +(s.ln + dLng).toFixed(5),
      capturedAt: new Date(now - hoursAgo * 3600 * 1000).toISOString(),
      stampSource,
      spotName: null,        // filled from snapToSpot once libs resolve
      caption,
      handle: 'seed',
      createdAt: new Date(now - hoursAgo * 3600 * 1000).toISOString(),
    };
  }).filter(Boolean);
}

module.exports = function mountMediaMock(app) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const items = seedItems();                 // newest data lives in memory only
  const pending = new Map();                 // mediaId -> {kind, contentType, ext}

  libs.then(({ snapToSpot }) => {
    for (const it of items) it.spotName = snapToSpot(spots, it.lat, it.lng).label;
  });

  // Seed placeholder images + uploaded files.
  app.use('/fixtures/media', express.static(FIXTURE_DIR, { maxAge: '1h' }));
  app.use('/mock-media', express.static(UPLOAD_DIR));

  // ── Session: always signed in as a local dev user ──
  app.get('/api/me', (req, res) => {
    res.json({ user: { id: 'dev-user', email: 'dev@local', handle: 'dev' } });
  });
  app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));

  // ── Media list: point+radius AND bbox modes, mirroring api/spots/media.mjs ──
  app.get('/api/spots/media', async (req, res) => {
    const { haversineKm } = await libs;
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const live = items.filter(m => m.status !== 'removed');

    if (req.query.bbox !== undefined) {
      const parts = String(req.query.bbox).split(',').map(Number);
      if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
        return res.status(400).json({ error: 'bad_bbox', code: 'bad_bbox' });
      }
      const [w, s, e, n] = parts;
      const sinceHours = Math.min(Number(req.query.sinceHours) > 0 ? Number(req.query.sinceHours) : 168, 720);
      const since = Date.now() - sinceHours * 3600 * 1000;
      const out = live
        .filter(m => m.lat >= s && m.lat <= n && m.lng >= w && m.lng <= e && Date.parse(m.capturedAt) >= since)
        .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
        .slice(0, limit);
      return res.json({ items: out });
    }

    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'bad_location', code: 'bad_location' });
    }
    const radiusKm = Math.min(Number(req.query.radiusKm) || 25, 100);
    const out = live
      .filter(m => haversineKm(lat, lng, m.lat, m.lng) <= radiusKm)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.min(limit, 50));
    res.json({ items: out });
  });

  // ── Upload flow: presign → PUT bytes → complete ──
  app.post('/api/uploads/presign', express.json(), async (req, res) => {
    try {
      const { validateUploadRequest } = await libs;
      const { kind, contentType, bytes } = req.body || {};
      const { ext } = validateUploadRequest({ kind, contentType, bytes });
      const mediaId = crypto.randomUUID();
      pending.set(mediaId, { kind, contentType, ext });
      res.json({ mediaId, key: `media/${mediaId}.${ext}`, uploadUrl: `/api/mock-upload/${mediaId}` });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.code || 'internal', code: e.code || 'internal' });
    }
  });

  app.put('/api/mock-upload/:id', express.raw({ type: () => true, limit: '120mb' }), (req, res) => {
    const p = pending.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not_found', code: 'not_found' });
    fs.writeFileSync(path.join(UPLOAD_DIR, `${req.params.id}.${p.ext}`), req.body);
    res.sendStatus(200);
  });

  app.post('/api/uploads/complete', express.json(), async (req, res) => {
    const { resolveStampSource, snapToSpot } = await libs;
    const b = req.body || {};
    const p = pending.get(String(b.mediaId));
    if (!p) return res.status(404).json({ error: 'not_found', code: 'not_found' });
    const filePath = path.join(UPLOAD_DIR, `${b.mediaId}.${p.ext}`);
    if (!fs.existsSync(filePath)) return res.status(400).json({ error: 'no_object', code: 'no_object' });

    const lat = Number(b.lat), lng = Number(b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'bad_location', code: 'bad_location' });
    }

    // Server-side EXIF re-read, exactly like api/uploads/complete.mjs.
    let exif = null;
    if (p.kind === 'photo') {
      try {
        const data = await exifr.parse(fs.readFileSync(filePath), { exif: ['DateTimeOriginal'], gps: true });
        if (data) {
          exif = {
            lat: data.latitude ?? null,
            lng: data.longitude ?? null,
            capturedAt: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).toISOString() : null,
          };
        }
      } catch { exif = null; }
    }
    const stampSource = resolveStampSource({
      claimed: { lat, lng, capturedAt: b.capturedAt, source: b.claimedStampSource },
      exif,
    });

    const item = {
      id: String(b.mediaId),
      kind: p.kind,
      url: `/mock-media/${b.mediaId}.${p.ext}`,
      lat, lng,
      capturedAt: new Date(b.capturedAt).toISOString(),
      stampSource,
      spotName: snapToSpot(spots, lat, lng).label,
      caption: String(b.caption || '').slice(0, 140),
      handle: 'dev',
      createdAt: new Date().toISOString(),
    };
    items.unshift(item);
    pending.delete(String(b.mediaId));
    res.json({ media: { ...item, spot_name: item.spotName, stamp_source: stampSource } });
  });

  app.post('/api/report', express.json(), (req, res) => res.json({ ok: true }));

  console.log(`  [media-mock] Mock media backend active (${items.length} seeded photos; uploads → ${UPLOAD_DIR})`);
  console.log('  [media-mock] Set DATABASE_URL (and unset MEDIA_MOCK) to disable.');
};
