import exifr from 'exifr';
import { route, json, jsonBody, HttpError } from '../_lib/http.mjs';
import { readSession } from '../_lib/session.mjs';
import { getSql } from '../_lib/db.mjs';
import { completeUpload } from '../_lib/uploadflow.mjs';
import { headObject, getObjectBuffer, publicUrl, deleteObject } from '../_lib/r2.mjs';
import { spotNameFor } from '../_lib/spots.mjs';

async function readExifFromR2(key) {
  const buf = await getObjectBuffer(key, 4 * 1024 * 1024);   // EXIF lives in the first bytes
  // NOTE: per-segment pick, not a global pick array — a global
  // pick: ['latitude'] silently drops the GPS block before exifr converts
  // coordinates, so GPS would always come back undefined.
  const data = await exifr.parse(buf, { exif: ['DateTimeOriginal'], gps: true });
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
    // spot_name comes from the shipped named-spots list (no external API):
    // exact name within 2 km, "near <spot>" within 10 km, null beyond.
    // deleteObject: completeUpload re-checks the real object size and
    // deletes + 413s oversize bodies before the row can go live.
    { sql: getSql(), headObject, readExif: readExifFromR2, reverseGeocode: async (la, ln) => spotNameFor(la, ln), deleteObject },
    { mediaId: String(body.mediaId), userId: sess.userId, lat, lng,
      capturedAt: capturedAt.toISOString(), caption: body.caption,
      claimedStampSource: ['exif', 'device', 'manual'].includes(body.claimedStampSource) ? body.claimedStampSource : 'manual' },
  );
  json(res, 200, { media: { ...media, url: publicUrl(media.r2_key) } });
});
