import { route, json } from './_lib/http.mjs';
import { readSession } from './_lib/session.mjs';

export default route(async (req, res) => {
  const sess = await readSession(req);
  if (!sess) return json(res, 401, { error: 'signed_out', code: 'signed_out' });
  json(res, 200, { user: { id: sess.userId, email: sess.email, handle: sess.handle } });
});
