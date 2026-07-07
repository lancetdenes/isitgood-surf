import { route, json } from '../_lib/http.mjs';
import { logoutCookie } from '../_lib/session.mjs';

export default route(async (req, res) => {
  res.setHeader('Set-Cookie', logoutCookie());
  json(res, 200, { ok: true });
});
