import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimit } from '../ratelimit.mjs';

function mockSql() {
  const rows = new Map(); // key|window -> count
  return async function sql(strings, ...vals) {
    const [key, windowStart] = vals;
    const k = `${key}|${windowStart.toISOString()}`;
    const count = (rows.get(k) || 0) + 1;
    rows.set(k, count);
    return [{ count }];
  };
}

test('allows up to max within a window, then blocks', async () => {
  const sql = mockSql();
  for (let i = 0; i < 3; i++) assert.equal(await checkLimit(sql, 'k', 3, 3600), true);
  assert.equal(await checkLimit(sql, 'k', 3, 3600), false);
});

test('separate keys have separate budgets', async () => {
  const sql = mockSql();
  for (let i = 0; i < 3; i++) await checkLimit(sql, 'a', 3, 3600);
  assert.equal(await checkLimit(sql, 'b', 3, 3600), true);
});
