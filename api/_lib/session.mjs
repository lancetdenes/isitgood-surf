import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from './http.mjs';

const NINETY_DAYS = 90 * 24 * 3600;
const key = () => new TextEncoder().encode(getEnv('SESSION_SECRET'));

export async function sessionCookie(user) {
  const jwt = await new SignJWT({ email: user.email, handle: user.handle })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setExpirationTime(`${NINETY_DAYS}s`)
    .sign(key());
  return `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${NINETY_DAYS}`;
}

export async function readSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], key());
    return { userId: payload.sub, email: payload.email, handle: payload.handle };
  } catch {
    return null;
  }
}

export function logoutCookie() {
  return 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
