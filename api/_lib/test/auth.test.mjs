import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestLink, redeemToken } from '../auth.mjs';

/** Tiny in-memory sql mock covering the queries auth.mjs issues. */
function makeDb() {
  const state = { tokens: new Map(), users: new Map(), limits: new Map() };
  const sql = async (strings, ...vals) => {
    const q = strings.join('?');
    if (q.includes('INSERT INTO rate_limits')) {
      const k = `${vals[0]}|${vals[1].toISOString()}`;
      const count = (state.limits.get(k) || 0) + 1;
      state.limits.set(k, count);
      return [{ count }];
    }
    if (q.includes('INSERT INTO tokens')) {
      state.tokens.set(vals[0], { email: vals[1], expires_at: vals[2] });
      return [];
    }
    if (q.includes('DELETE FROM tokens') && q.includes('RETURNING')) {
      const t = state.tokens.get(vals[0]);
      if (!t || t.expires_at < new Date()) return [];
      state.tokens.delete(vals[0]);
      return [{ email: t.email }];
    }
    if (q.includes('SELECT') && q.includes('FROM users')) {
      const u = [...state.users.values()].find(u => u.email === vals[0]);
      return u ? [u] : [];
    }
    if (q.includes('INSERT INTO users')) {
      const u = { id: `u${state.users.size + 1}`, email: vals[0], handle: vals[1], banned: false };
      state.users.set(u.id, u);
      return [u];
    }
    throw new Error('unexpected query: ' + q);
  };
  return { sql, state };
}

test('requestLink stores a hashed token and emails a link', async () => {
  const { sql, state } = makeDb();
  const sent = [];
  await requestLink({ sql, sendEmail: async (to, url) => sent.push({ to, url }), email: 'Surfer@Example.com', ip: 'iphash', origin: 'https://x.test' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'surfer@example.com');
  const token = new URL(sent[0].url).searchParams.get('token');
  assert.ok(token.length >= 32);
  assert.ok(!state.tokens.has(token), 'raw token must not be stored');
  assert.equal(state.tokens.size, 1);
});

test('redeemToken creates the user once and is single-use', async () => {
  const { sql } = makeDb();
  const sent = [];
  await requestLink({ sql, sendEmail: async (to, url) => sent.push(url), email: 'a@b.c', ip: 'ip1', origin: 'https://x.test' });
  const token = new URL(sent[0]).searchParams.get('token');
  const { user } = await redeemToken({ sql, token, ip: 'ip1' });
  assert.equal(user.email, 'a@b.c');
  assert.equal(user.handle, 'a');
  await assert.rejects(() => redeemToken({ sql, token, ip: 'ip1' }), /bad_token/);
});

test('rejects malformed email', async () => {
  const { sql } = makeDb();
  await assert.rejects(() => requestLink({ sql, sendEmail: async () => {}, email: 'nope', ip: 'ip', origin: 'o' }), /bad_email/);
});

test('4th link request in an hour is rejected', async () => {
  const { sql } = makeDb();
  const send = async () => {};
  for (let i = 0; i < 3; i++) await requestLink({ sql, sendEmail: send, email: 'a@b.c', ip: 'ip', origin: 'o' });
  await assert.rejects(() => requestLink({ sql, sendEmail: send, email: 'a@b.c', ip: 'ip', origin: 'o' }), /rate_limited/);
});
