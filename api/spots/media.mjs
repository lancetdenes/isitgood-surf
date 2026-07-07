import { route, json, HttpError } from '../_lib/http.mjs';
import { getSql } from '../_lib/db.mjs';
import { bboxFor } from '../_lib/query.mjs';
import { publicUrl } from '../_lib/r2.mjs';

export default route(async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'bad_location');
  const radiusKm = Math.min(Number(req.query.radiusKm) || 25, 100);
  const limit = Math.min(Number(req.query.limit) || 30, 50);
  const b = bboxFor(lat, lng, radiusKm);

  const rows = await getSql()`
    SELECT m.id, m.kind, m.r2_key, m.lat, m.lng, m.captured_at, m.stamp_source,
           m.caption, m.created_at, u.handle
    FROM media m JOIN users u ON u.id = m.user_id
    WHERE m.status = 'live'
      AND m.lat BETWEEN ${b.minLat} AND ${b.maxLat}
      AND m.lng BETWEEN ${b.minLng} AND ${b.maxLng}
      AND 2 * 6371 * asin(sqrt(
            power(sin(radians((m.lat - ${lat}) / 2)), 2) +
            cos(radians(${lat})) * cos(radians(m.lat)) *
            power(sin(radians((m.lng - ${lng}) / 2)), 2)
          )) <= ${radiusKm}
    ORDER BY m.created_at DESC LIMIT ${limit}`;

  json(res, 200, {
    items: rows.map(r => ({
      id: r.id, kind: r.kind, url: publicUrl(r.r2_key), lat: r.lat, lng: r.lng,
      capturedAt: r.captured_at, stampSource: r.stamp_source,
      caption: r.caption, handle: r.handle, createdAt: r.created_at,
    })),
  });
});
