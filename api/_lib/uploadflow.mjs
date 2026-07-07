import { HttpError } from './http.mjs';
import { resolveStampSource } from './stamp.mjs';

/**
 * Flip a pending media row to live after verifying the object exists and
 * re-checking EXIF server-side. Deps are injected for testability:
 * { sql, headObject(key), readExif(key), reverseGeocode(lat,lng) }.
 */
export async function completeUpload(deps, input) {
  const { sql, headObject, readExif, reverseGeocode } = deps;
  const rows = await sql`SELECT * FROM media WHERE id = ${input.mediaId} AND user_id = ${input.userId}`;
  if (!rows.length) throw new HttpError(404, 'not_found');
  const media = rows[0];
  if (media.status === 'live') return media;           // idempotent
  if (media.status === 'removed') throw new HttpError(410, 'removed');

  const head = await headObject(media.r2_key);
  if (!head) throw new HttpError(400, 'no_object');

  let exif = null;
  if (media.kind === 'photo') {
    try { exif = await readExif(media.r2_key); } catch { exif = null; }
  }
  const stamp = resolveStampSource({
    claimed: { lat: input.lat, lng: input.lng, capturedAt: input.capturedAt, source: input.claimedStampSource },
    exif,
  });
  const spotName = (await reverseGeocode(input.lat, input.lng).catch(() => null)) || null;
  const caption = String(input.caption || '').slice(0, 140);

  const updated = await sql`
    UPDATE media SET status = 'live', stamp_source = ${stamp},
      lat = ${input.lat}, lng = ${input.lng}, captured_at = ${input.capturedAt},
      caption = ${caption}, spot_name = ${spotName}, bytes = ${head.bytes}
    WHERE id = ${input.mediaId} RETURNING *`;
  return updated[0];
}
