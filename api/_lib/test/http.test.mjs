import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, ipHash, jsonBody } from '../http.mjs';

test('HttpError carries status and code', () => {
  const e = new HttpError(429, 'rate_limited');
  assert.equal(e.status, 429);
  assert.equal(e.code, 'rate_limited');
});

test('ipHash is stable and anonymized', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } };
  const a = ipHash(req, 'secret');
  assert.equal(a, ipHash(req, 'secret'));
  assert.equal(a.length, 16);
  assert.ok(!a.includes('1.2.3.4'));
  const b = ipHash({ headers: { 'x-forwarded-for': '5.6.7.8' } }, 'secret');
  assert.notEqual(a, b);
});

test('jsonBody accepts pre-parsed body and rejects missing', async () => {
  assert.deepEqual(await jsonBody({ body: { a: 1 } }), { a: 1 });
  await assert.rejects(() => jsonBody({ body: undefined, headers: {} }), /bad_json/);
});
