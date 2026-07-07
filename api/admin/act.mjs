import { route, json, jsonBody, HttpError } from '../_lib/http.mjs';
import { getSql } from '../_lib/db.mjs';
import { deleteObject } from '../_lib/r2.mjs';
import { requireAdmin } from './media.mjs';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  await requireAdmin(req);
  const { action, mediaId, userId } = await jsonBody(req);
  const sql = getSql();

  if (action === 'remove') {
    const rows = await sql`UPDATE media SET status = 'removed' WHERE id = ${String(mediaId)} RETURNING r2_key`;
    if (rows.length) await deleteObject(rows[0].r2_key).catch(() => {});
    return json(res, 200, { ok: true });
  }
  if (action === 'ban') {
    await sql`UPDATE users SET banned = true WHERE id = ${String(userId)}`;
    await sql`UPDATE media SET status = 'removed' WHERE user_id = ${String(userId)}`;
    return json(res, 200, { ok: true });
  }
  throw new HttpError(400, 'bad_action');
});
