import { route, json, jsonBody, ipHash, getEnv, HttpError } from '../_lib/http.mjs';
import { getSql } from '../_lib/db.mjs';
import { requestLink, makeResendSender } from '../_lib/auth.mjs';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const { email } = await jsonBody(req);
  await requestLink({
    sql: getSql(),
    sendEmail: makeResendSender(getEnv('RESEND_API_KEY'), getEnv('EMAIL_FROM')),
    email,
    ip: ipHash(req, getEnv('SESSION_SECRET')),
    origin: getEnv('APP_ORIGIN'),
  });
  json(res, 200, { ok: true });
});
