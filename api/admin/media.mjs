import { route, json, getEnv, HttpError } from '../_lib/http.mjs';
import { readSession } from '../_lib/session.mjs';
import { getSql } from '../_lib/db.mjs';
import { publicUrl } from '../_lib/r2.mjs';

export async function requireAdmin(req) {
  const sess = await readSession(req);
  const admins = getEnv('ADMIN_EMAILS').split(',').map(s => s.trim().toLowerCase());
  if (!sess || !admins.includes(sess.email.toLowerCase())) throw new HttpError(403, 'forbidden');
  return sess;
}

export default route(async (req, res) => {
  await requireAdmin(req);
  const sql = getSql();
  const rows = req.query.status === 'reported'
    ? await sql`SELECT m.*, u.email, u.handle FROM media m JOIN users u ON u.id = m.user_id
                WHERE m.status = 'live' AND m.report_count >= 3
                ORDER BY m.report_count DESC, m.created_at DESC LIMIT 200`
    : await sql`SELECT m.*, u.email, u.handle FROM media m JOIN users u ON u.id = m.user_id
                WHERE m.status = 'live'
                ORDER BY m.report_count DESC, m.created_at DESC LIMIT 200`;
  json(res, 200, { items: rows.map(r => ({ ...r, url: publicUrl(r.r2_key) })) });
});
