import exifr from 'exifr';
import { route, json, jsonBody, HttpError } from '../_lib/http.mjs';
import { readSession } from '../_lib/session.mjs';
import { getSql } from '../_lib/db.mjs';
import { completeUpload } from '../_lib/uploadflow.mjs';
import { headObject, getObjectBuffer, publicUrl } from '../_lib/r2.mjs';

async function readExifFromR2(key) {
  const buf = await getObjectBuffer(key, 4 * 1024 * 1024);   // EXIF lives in the first bytes
  const data = await exifr.parse(buf, { gps: true, pick: ['DateTimeOriginal', 'latitude', 'longitude'] });
  if (!data) return null;
  return {
    lat: data.latitude ?? null,
    lng: data.longitude ?? null,
    capturedAt: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).toISOString() : null,
  };
}

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const sess = await readSession(req);
  if (!sess) throw new HttpError(401, 'signed_out');

  const body = await jsonBody(req);
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'bad_location');
  }
  const capturedAt = new Date(body.capturedAt);
  if (Number.isNaN(+capturedAt) || +capturedAt > Date.now() + 60_000) throw new HttpError(400, 'bad_time');

  const media = await completeUpload(
    // spot_name stays null in v1 — the panel shows coordinates + relative time.
    { sql: getSql(), headObject, readExif: readExifFromR2, reverseGeocode: async () => null },
    { mediaId: String(body.mediaId), userId: sess.userId, lat, lng,
      capturedAt: capturedAt.toISOString(), caption: body.caption,
      claimedStampSource: ['exif', 'device', 'manual'].includes(body.claimedStampSource) ? body.claimedStampSource : 'manual' },
  );
  json(res, 200, { media: { ...media, url: publicUrl(media.r2_key) } });
});
