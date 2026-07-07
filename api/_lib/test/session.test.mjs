import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const { sessionCookie, readSession, logoutCookie } = await import('../session.mjs');

test('round-trips a session through the cookie', async () => {
  const cookie = await sessionCookie({ id: 'u1', email: 'a@b.c', handle: 'a' });
  assert.match(cookie, /^session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const token = cookie.match(/^session=([^;]+)/)[1];
  const sess = await readSession({ headers: { cookie: `session=${token}` } });
  assert.equal(sess.userId, 'u1');
  assert.equal(sess.email, 'a@b.c');
  assert.equal(sess.handle, 'a');
});

test('rejects a tampered token', async () => {
  const cookie = await sessionCookie({ id: 'u1', email: 'a@b.c', handle: 'a' });
  const token = cookie.match(/^session=([^;]+)/)[1] + 'x';
  assert.equal(await readSession({ headers: { cookie: `session=${token}` } }), null);
});

test('returns null with no cookie', async () => {
  assert.equal(await readSession({ headers: {} }), null);
});

test('logoutCookie expires the cookie', () => {
  assert.match(logoutCookie(), /Max-Age=0/);
});
