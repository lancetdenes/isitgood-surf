import { route, json, HttpError } from '../_lib/http.mjs';
import { getSql } from '../_lib/db.mjs';
import { bboxFor, parseBbox, clampSinceHours } from '../_lib/query.mjs';
import { publicUrl } from '../_lib/r2.mjs';

const shape = (r) => ({
  id: r.id, kind: r.kind, url: publicUrl(r.r2_key), lat: r.lat, lng: r.lng,
  capturedAt: r.captured_at, stampSource: r.stamp_source, spotName: r.spot_name,
  caption: r.caption, handle: r.handle, createdAt: r.created_at,
});

export default route(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);

  // ── Map-viewport mode: ?bbox=w,s,e,n&sinceHours=168 ──
  // Additive alongside the original point+radius mode; hits the same
  // (lat,lng) + (captured_at) indexes.
  if (req.query.bbox !== undefined) {
    const b = parseBbox(req.query.bbox);
    const since = new Date(Date.now() - clampSinceHours(req.query.sinceHours) * 3600 * 1000);
    const rows = await getSql()`
      SELECT m.id, m.kind, m.r2_key, m.lat, m.lng, m.captured_at, m.stamp_source,
             m.spot_name, m.caption, m.created_at, u.handle
      FROM media m JOIN users u ON u.id = m.user_id
      WHERE m.status = 'live'
        AND m.lat BETWEEN ${b.s} AND ${b.n}
        AND m.lng BETWEEN ${b.w} AND ${b.e}
        AND m.captured_at >= ${since}
      ORDER BY m.captured_at DESC LIMIT ${limit}`;
    return json(res, 200, { items: rows.map(shape) });
  }

  // ── Original point+radius mode: ?lat&lng&radiusKm ──
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'bad_location');
  const radiusKm = Math.min(Number(req.query.radiusKm) || 25, 100);
  const b = bboxFor(lat, lng, radiusKm);

  const rows = await getSql()`
    SELECT m.id, m.kind, m.r2_key, m.lat, m.lng, m.captured_at, m.stamp_source,
           m.spot_name, m.caption, m.created_at, u.handle
    FROM media m JOIN users u ON u.id = m.user_id
    WHERE m.status = 'live'
      AND m.lat BETWEEN ${b.minLat} AND ${b.maxLat}
      AND m.lng BETWEEN ${b.minLng} AND ${b.maxLng}
      AND 2 * 6371 * asin(sqrt(
            power(sin(radians((m.lat - ${lat}) / 2)), 2) +
            cos(radians(${lat})) * cos(radians(m.lat)) *
            power(sin(radians((m.lng - ${lng}) / 2)), 2)
          )) <= ${radiusKm}
    ORDER BY m.created_at DESC LIMIT ${Math.min(limit, 50)}`;

  json(res, 200, { items: rows.map(shape) });
});
