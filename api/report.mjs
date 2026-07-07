import { route, json, jsonBody, ipHash, getEnv, HttpError } from './_lib/http.mjs';
import { getSql } from './_lib/db.mjs';
import { checkLimit } from './_lib/ratelimit.mjs';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const { mediaId, reason } = await jsonBody(req);
  const ip = ipHash(req, getEnv('SESSION_SECRET'));
  const sql = getSql();
  if (!(await checkLimit(sql, `report:${ip}:day`, 20, 86400))) throw new HttpError(429, 'rate_limited');

  await sql`INSERT INTO reports (media_id, reason, ip_hash)
            VALUES (${String(mediaId)}, ${String(reason || '').slice(0, 200)}, ${ip})
            ON CONFLICT (media_id, ip_hash) DO NOTHING`;
  await sql`UPDATE media SET report_count = (SELECT count(DISTINCT ip_hash) FROM reports WHERE media_id = ${String(mediaId)})
            WHERE id = ${String(mediaId)}`;
  json(res, 200, { ok: true });
});
