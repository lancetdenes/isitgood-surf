import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';
import { checkLimit } from './ratelimit.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function requestLink({ sql, sendEmail, email, ip, origin }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_email');
  if (!(await checkLimit(sql, `link:${email}:hour`, 3, 3600))) throw new HttpError(429, 'rate_limited');

  const token = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + 15 * 60 * 1000);
  await sql`INSERT INTO tokens (token_hash, email, expires_at) VALUES (${sha256(token)}, ${email}, ${expires})`;
  await sendEmail(email, `${origin}/api/auth/callback?token=${token}`);
}

export async function redeemToken({ sql, token, ip }) {
  const rows = await sql`DELETE FROM tokens WHERE token_hash = ${sha256(String(token || ''))} AND expires_at > now() RETURNING email`;
  if (!rows.length) throw new HttpError(400, 'bad_token');
  const email = rows[0].email;

  const existing = await sql`SELECT id, email, handle, banned FROM users WHERE email = ${email}`;
  if (existing.length) {
    if (existing[0].banned) throw new HttpError(403, 'banned');
    return { user: existing[0] };
  }
  if (!(await checkLimit(sql, `signup:${ip}:day`, 3, 86400))) throw new HttpError(429, 'rate_limited');
  const handle = email.split('@')[0].slice(0, 24);
  const created = await sql`INSERT INTO users (email, handle) VALUES (${email}, ${handle}) RETURNING id, email, handle, banned`;
  return { user: created[0] };
}

/** Resend REST call — injected in tests, used directly by the endpoint. */
export function makeResendSender(apiKey, from) {
  return async (to, url) => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from, to,
        subject: 'Your sign-in link',
        text: `Sign in to Is It Good?\n\n${url}\n\nThis link expires in 15 minutes.`,
      }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  };
}
