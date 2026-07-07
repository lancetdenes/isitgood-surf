import { randomUUID } from 'node:crypto';
import { route, json, jsonBody, HttpError } from '../_lib/http.mjs';
import { readSession } from '../_lib/session.mjs';
import { getSql } from '../_lib/db.mjs';
import { checkLimit } from '../_lib/ratelimit.mjs';
import { validateUploadRequest } from '../_lib/uploadrules.mjs';
import { presignPut } from '../_lib/r2.mjs';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const sess = await readSession(req);
  if (!sess) throw new HttpError(401, 'signed_out');

  const { kind, contentType, bytes } = await jsonBody(req);
  const { ext } = validateUploadRequest({ kind, contentType, bytes });

  const sql = getSql();
  const user = await sql`SELECT banned FROM users WHERE id = ${sess.userId}`;
  if (!user.length || user[0].banned) throw new HttpError(403, 'banned');
  if (!(await checkLimit(sql, `upload:${sess.userId}:day`, 10, 86400))) throw new HttpError(429, 'rate_limited');

  const mediaId = randomUUID();
  const key = `media/${mediaId}.${ext}`;
  await sql`INSERT INTO media (id, user_id, kind, r2_key, content_type, status)
            VALUES (${mediaId}, ${sess.userId}, ${kind}, ${key}, ${contentType}, 'pending')`;
  const uploadUrl = await presignPut({ key, contentType });
  json(res, 200, { mediaId, key, uploadUrl });
});
