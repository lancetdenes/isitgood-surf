import { route, ipHash, getEnv } from '../_lib/http.mjs';
import { getSql } from '../_lib/db.mjs';
import { redeemToken } from '../_lib/auth.mjs';
import { sessionCookie } from '../_lib/session.mjs';

export default route(async (req, res) => {
  const { user } = await redeemToken({
    sql: getSql(),
    token: req.query.token,
    ip: ipHash(req, getEnv('SESSION_SECRET')),
  });
  res.setHeader('Set-Cookie', await sessionCookie(user));
  res.statusCode = 302;
  res.setHeader('Location', '/?signedin=1');
  res.end();
});
