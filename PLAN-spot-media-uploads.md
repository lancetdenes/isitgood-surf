# Spot Media Uploads (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Signed-in users upload time/location-stamped photos and ≤30s clips of surf spots; media shows in the spot rating panel with trust tags; admin can moderate.

**Architecture:** Static frontend (unchanged deploy) + Vercel serverless functions in `api/`. Media goes browser→R2 via presigned PUT into the existing bucket under `media/`; metadata lives in Neon Postgres; sessions are signed JWT cookies; magic-link email via Resend. See `SPEC-spot-media-uploads.md` for the approved design.

**Tech Stack:** Vercel Node functions (ESM), `@neondatabase/serverless`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `jose` (JWT), `exifr` (EXIF, server + vendored client), Resend REST API, vanilla JS frontend (no build step), `node --test`.

## Global Constraints

- Frontend stays a no-build static site: client libraries are vendored ESM files under `public/vendor/`, never bundled.
- All API routes are Vercel functions: `api/<name>.js` exporting `export default async function handler(req, res)`.
- Media caps (spec): photos `image/jpeg|image/png` ≤ 15 MB (client downscales to ≤1600px before upload); video `video/mp4|video/quicktime` ≤ 100 MB, ≤ 30 s (duration checked client-side only in v1).
- Trust tiers exactly: `exif` (server-verified, ≤ 25 km AND ≤ 48 h delta), `device`, `manual`. Server never hard-rejects on mismatch — downgrades to `manual`.
- Quotas (spec): 10 uploads/day/user, 3 magic-link requests/hour/email, 3 new accounts/day/IP-hash, 20 reports/day/IP-hash. 3 distinct-IP reports flag media for admin review.
- Sessions: HTTP-only, `Secure`, `SameSite=Lax` cookie named `session`, HS256 JWT, 90-day expiry.
- Admin = session email listed in `ADMIN_EMAILS` (comma-separated env var).
- Env vars (all in Vercel project settings + local `.env`): `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `MEDIA_PUBLIC_BASE` (e.g. `https://pub-….r2.dev`), `ADMIN_EMAILS`, `APP_ORIGIN` (e.g. `https://isitgood.surf`).
- Unit tests use dependency injection (pass `sql`/fetch mocks); no test touches real Neon/R2/Resend.
- Run tests with `npm run test:api` (added in Task 1). Commit after every green task.

---

### Task 0: Provisioning (human-gated — cannot be done by an agent)

**Files:**
- Create: `.env.example`

**Interfaces:**
- Produces: the env vars in Global Constraints, present in `.env` locally and in Vercel project settings.

These steps need the project owner's accounts. Everything after this task can be implemented and unit-tested without them, but integration/e2e (Task 12) and deployment are blocked until done:

- [ ] **Step 1: Neon** — In Vercel dashboard → Storage/Marketplace, add Neon Postgres (free tier) to the `isitgood-surf` project. This injects `DATABASE_URL` automatically. Copy it into local `.env`.
- [ ] **Step 2: Resend** — Create a free Resend account, verify the sending domain (or use `onboarding@resend.dev` for testing), create an API key. Set `RESEND_API_KEY` and `EMAIL_FROM`.
- [ ] **Step 3: R2 CORS** — In Cloudflare R2 bucket settings, add a CORS rule allowing `PUT` from `APP_ORIGIN` (and `http://localhost:3000` for dev) with headers `content-type`. The existing R2 keys already have write access; reuse them for `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`.
- [ ] **Step 4: Secrets** — Generate `SESSION_SECRET` (`openssl rand -hex 32`). Set `ADMIN_EMAILS` to your email. Add every var to Vercel project settings (Production + Preview + Development).
- [ ] **Step 5: Commit `.env.example`** (names only, no values):

```bash
# .env.example
DATABASE_URL=
SESSION_SECRET=
RESEND_API_KEY=
EMAIL_FROM=surf@example.com
R2_ACCOUNT_ID=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
MEDIA_PUBLIC_BASE=
ADMIN_EMAILS=
APP_ORIGIN=http://localhost:3000
```

---

### Task 1: Dependencies, schema, migrate script

**Files:**
- Modify: `package.json` (deps + `test:api` + `migrate` scripts)
- Create: `api/_lib/schema.sql`
- Create: `data/scripts/migrate.js`

**Interfaces:**
- Produces: tables `users`, `media`, `reports`, `tokens`, `rate_limits` exactly as below; `npm run migrate` applies idempotently.

- [ ] **Step 1: Install deps**

```bash
npm install @neondatabase/serverless @aws-sdk/client-s3 @aws-sdk/s3-request-presigner jose exifr
```

- [ ] **Step 2: Add scripts to package.json**

```json
"test:api": "node --test 'api/_lib/test/*.test.js'",
"migrate": "node data/scripts/migrate.js"
```

- [ ] **Step 3: Write `api/_lib/schema.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  handle text NOT NULL,
  banned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('photo','video')),
  r2_key text NOT NULL,
  bytes integer,
  content_type text NOT NULL,
  lat double precision,
  lng double precision,
  captured_at timestamptz,
  stamp_source text CHECK (stamp_source IN ('exif','device','manual')),
  spot_name text,
  caption text,
  status text NOT NULL CHECK (status IN ('pending','live','removed')) DEFAULT 'pending',
  report_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_live_recent ON media (status, created_at DESC);
CREATE INDEX IF NOT EXISTS media_geo ON media (lat, lng);
CREATE INDEX IF NOT EXISTS media_captured ON media (captured_at);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  reason text,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_dedupe ON reports (media_id, ip_hash);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash text PRIMARY KEY,
  email citext NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);
```

- [ ] **Step 4: Write `data/scripts/migrate.js`**

```js
// migrate.js — apply api/_lib/schema.sql to DATABASE_URL (idempotent).
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(path.join(dir, '../../api/_lib/schema.sql'), 'utf8');
const sql = neon(process.env.DATABASE_URL);

// Split on semicolons at line ends; neon() runs one statement per call.
const statements = schema.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
for (const stmt of statements) {
  await sql.query(stmt);
  console.log('ok:', stmt.slice(0, 60).replace(/\s+/g, ' '));
}
console.log(`Applied ${statements.length} statements.`);
```

- [ ] **Step 5: Verify + commit** — `node --check data/scripts/migrate.js` passes (actual run happens after Task 0). Commit: `feat(api): add schema, migrate script, server deps`

---

### Task 2: Shared HTTP + config helpers

**Files:**
- Create: `api/_lib/http.js`
- Test: `api/_lib/test/http.test.js`

**Interfaces:**
- Produces: `json(res, status, body)`, `readJson(req)` (returns parsed body or throws `HttpError(400,'bad_json')`), `HttpError(status, code, message?)`, `ipHash(req, secret)` (sha256 of client IP, first 16 hex chars), `getEnv(name)` (throws if missing).

- [ ] **Step 1: Write failing tests `api/_lib/test/http.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, ipHash, jsonBody } from '../http.js';

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
});

test('jsonBody parses valid JSON and rejects invalid', async () => {
  assert.deepEqual(await jsonBody({ body: { a: 1 } }), { a: 1 });        // vercel pre-parsed
  await assert.rejects(() => jsonBody({ body: undefined, headers: {} }), /bad_json/);
});
```

- [ ] **Step 2: Run** `npm run test:api` — FAIL (module not found).

- [ ] **Step 3: Implement `api/_lib/http.js`**

```js
import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Vercel parses JSON bodies into req.body; validate presence + type. */
export async function jsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  throw new HttpError(400, 'bad_json');
}

export function ipHash(req, secret) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  return createHash('sha256').update(`${secret}:${fwd}`).digest('hex').slice(0, 16);
}

export function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

/** Wrap a handler: catches HttpError -> JSON, others -> 500. */
export function route(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      return json(res, 500, { error: 'internal', code: 'internal' });
    }
  };
}
```

- [ ] **Step 4: Run** `npm run test:api` — PASS.
- [ ] **Step 5: Commit** `feat(api): http helpers`

---

### Task 3: Sessions (JWT cookie)

**Files:**
- Create: `api/_lib/session.js`
- Test: `api/_lib/test/session.test.js`

**Interfaces:**
- Consumes: `getEnv` from `api/_lib/http.js`.
- Produces: `async sessionCookie(user)` → Set-Cookie string for `{id, email, handle}`; `async readSession(req, secret?)` → `{userId, email, handle}` or `null`; `logoutCookie()` → expired Set-Cookie string. Cookie name `session`.

- [ ] **Step 1: Write failing tests `api/_lib/test/session.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const { sessionCookie, readSession, logoutCookie } = await import('../session.js');

test('round-trips a session through the cookie', async () => {
  const cookie = await sessionCookie({ id: 'u1', email: 'a@b.c', handle: 'a' });
  assert.match(cookie, /^session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const token = cookie.match(/^session=([^;]+)/)[1];
  const sess = await readSession({ headers: { cookie: `session=${token}` } });
  assert.equal(sess.userId, 'u1');
  assert.equal(sess.email, 'a@b.c');
});

test('rejects a tampered token', async () => {
  const cookie = await sessionCookie({ id: 'u1', email: 'a@b.c', handle: 'a' });
  const token = cookie.match(/^session=([^;]+)/)[1] + 'x';
  assert.equal(await readSession({ headers: { cookie: `session=${token}` } }), null);
});

test('logoutCookie expires the cookie', () => {
  assert.match(logoutCookie(), /Max-Age=0/);
});
```

- [ ] **Step 2: Run** `npm run test:api` — FAIL.

- [ ] **Step 3: Implement `api/_lib/session.js`**

```js
import { SignJWT, jwtVerify } from 'jose';
import { getEnv } from './http.js';

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
```

- [ ] **Step 4: Run** `npm run test:api` — PASS.
- [ ] **Step 5: Commit** `feat(api): jwt cookie sessions`

---

### Task 4: DB handle + rate limiter

**Files:**
- Create: `api/_lib/db.js`
- Create: `api/_lib/ratelimit.js`
- Test: `api/_lib/test/ratelimit.test.js`

**Interfaces:**
- Produces: `db.js` exports `getSql()` (lazy `neon(DATABASE_URL)` singleton). `ratelimit.js` exports `async checkLimit(sql, key, max, windowSeconds)` → `true` if allowed (and counted), `false` if over limit. Callers build keys like `upload:<userId>:day`, `link:<email>:hour`, `report:<ipHash>:day`, `signup:<ipHash>:day`.

- [ ] **Step 1: Write failing tests `api/_lib/test/ratelimit.test.js`**

The mock emulates the single UPSERT the implementation issues.

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLimit } from '../ratelimit.js';

function mockSql() {
  const rows = new Map(); // key|window -> count
  return async function sql(strings, ...vals) {
    // implementation calls exactly one INSERT ... ON CONFLICT ... RETURNING count
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
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**

`api/_lib/db.js`:

```js
import { neon } from '@neondatabase/serverless';
import { getEnv } from './http.js';

let _sql = null;
export function getSql() {
  if (!_sql) _sql = neon(getEnv('DATABASE_URL'));
  return _sql;
}
```

`api/_lib/ratelimit.js`:

```js
/** Fixed-window counter in Postgres. Returns true if this call is allowed. */
export async function checkLimit(sql, key, max, windowSeconds) {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const rows = await sql`
    INSERT INTO rate_limits (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count`;
  return rows[0].count <= max;
}
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(api): db handle + pg-backed rate limiter`

---

### Task 5: Auth endpoints (magic link)

**Files:**
- Create: `api/_lib/auth.js` (logic, injectable deps)
- Create: `api/auth/request-link.js`, `api/auth/callback.js`, `api/auth/logout.js`, `api/me.js`
- Test: `api/_lib/test/auth.test.js`

**Interfaces:**
- Consumes: `checkLimit`, `sessionCookie`, `readSession`, `HttpError`, `ipHash`.
- Produces: `requestLink({ sql, sendEmail, email, ip, origin })` → creates token row + sends email, throws `HttpError(429,'rate_limited')` / `HttpError(400,'bad_email')`. `redeemToken({ sql, token, ip })` → `{user}` (creates user on first sign-in; handle = email local part; enforces signup IP quota; throws `HttpError(400,'bad_token')` on missing/expired). Tokens are stored as sha256 hashes, 15-min TTL, single-use (deleted on redeem).

- [ ] **Step 1: Write failing tests `api/_lib/test/auth.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestLink, redeemToken } from '../auth.js';

/** Tiny in-memory sql mock covering the queries auth.js issues, keyed on SQL verbs. */
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

test('4th link request in an hour is rejected', async () => {
  const { sql } = makeDb();
  const send = async () => {};
  for (let i = 0; i < 3; i++) await requestLink({ sql, sendEmail: send, email: 'a@b.c', ip: 'ip', origin: 'o' });
  await assert.rejects(() => requestLink({ sql, sendEmail: send, email: 'a@b.c', ip: 'ip', origin: 'o' }), /rate_limited/);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `api/_lib/auth.js`**

```js
import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.js';
import { checkLimit } from './ratelimit.js';

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
```

- [ ] **Step 4: Implement the four endpoints**

`api/auth/request-link.js`:

```js
import { route, json, jsonBody, ipHash, getEnv, HttpError } from '../_lib/http.js';
import { getSql } from '../_lib/db.js';
import { requestLink, makeResendSender } from '../_lib/auth.js';

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
```

`api/auth/callback.js`:

```js
import { route, ipHash, getEnv, HttpError } from '../_lib/http.js';
import { getSql } from '../_lib/db.js';
import { redeemToken } from '../_lib/auth.js';
import { sessionCookie } from '../_lib/session.js';

export default route(async (req, res) => {
  const { user } = await redeemToken({
    sql: getSql(),
    token: req.query.token,
    ip: ipHash(req, getEnv('SESSION_SECRET')),
  });
  res.setHeader('Set-Cookie', await sessionCookie(user));
  res.status(302).setHeader('Location', '/?signedin=1');
  res.end();
});
```

`api/auth/logout.js`:

```js
import { route, json } from '../_lib/http.js';
import { logoutCookie } from '../_lib/session.js';

export default route(async (req, res) => {
  res.setHeader('Set-Cookie', logoutCookie());
  json(res, 200, { ok: true });
});
```

`api/me.js`:

```js
import { route, json } from '../_lib/http.js';
import { readSession } from '../_lib/session.js';

export default route(async (req, res) => {
  const sess = await readSession(req);
  if (!sess) return json(res, 401, { error: 'signed_out', code: 'signed_out' });
  json(res, 200, { user: { id: sess.userId, email: sess.email, handle: sess.handle } });
});
```

- [ ] **Step 5: Run** `npm run test:api` — PASS; `node --check` each endpoint.
- [ ] **Step 6: Commit** `feat(api): magic-link auth endpoints`

---

### Task 6: Trust-tier resolution (EXIF verification logic)

**Files:**
- Create: `api/_lib/stamp.js`
- Test: `api/_lib/test/stamp.test.js`

**Interfaces:**
- Produces: `haversineKm(lat1, lng1, lat2, lng2)`; `resolveStampSource({ claimed: {lat, lng, capturedAt, source}, exif: {lat, lng, capturedAt} | null })` → `'exif' | 'device' | 'manual'`. Thresholds: 25 km, 48 h.

- [ ] **Step 1: Write failing tests `api/_lib/test/stamp.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, resolveStampSource } from '../stamp.js';

test('haversine sanity: NYC to Philly ~ 130 km', () => {
  const d = haversineKm(40.7128, -74.006, 39.9526, -75.1652);
  assert.ok(d > 120 && d < 140, `got ${d}`);
});

const T = '2026-07-01T12:00:00Z';

test('claimed exif + matching server exif stays exif', () => {
  const out = resolveStampSource({
    claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' },
    exif: { lat: 40.01, lng: -74.01, capturedAt: '2026-07-01T11:00:00Z' },
  });
  assert.equal(out, 'exif');
});

test('claimed exif but >25km away downgrades to manual', () => {
  const out = resolveStampSource({
    claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' },
    exif: { lat: 41, lng: -74, capturedAt: T },   // ~111 km
  });
  assert.equal(out, 'manual');
});

test('claimed exif but >48h off downgrades to manual', () => {
  const out = resolveStampSource({
    claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' },
    exif: { lat: 40, lng: -74, capturedAt: '2026-06-25T12:00:00Z' },
  });
  assert.equal(out, 'manual');
});

test('claimed exif with no server exif downgrades to manual', () => {
  const out = resolveStampSource({ claimed: { lat: 40, lng: -74, capturedAt: T, source: 'exif' }, exif: null });
  assert.equal(out, 'manual');
});

test('device and manual claims pass through', () => {
  assert.equal(resolveStampSource({ claimed: { lat: 0, lng: 0, capturedAt: T, source: 'device' }, exif: null }), 'device');
  assert.equal(resolveStampSource({ claimed: { lat: 0, lng: 0, capturedAt: T, source: 'manual' }, exif: null }), 'manual');
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `api/_lib/stamp.js`**

```js
const R = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const MAX_KM = 25;
const MAX_MS = 48 * 3600 * 1000;

export function resolveStampSource({ claimed, exif }) {
  if (claimed.source !== 'exif') return claimed.source === 'device' ? 'device' : 'manual';
  if (!exif || exif.lat == null || exif.capturedAt == null) return 'manual';
  const km = haversineKm(claimed.lat, claimed.lng, exif.lat, exif.lng);
  const ms = Math.abs(new Date(claimed.capturedAt) - new Date(exif.capturedAt));
  return km <= MAX_KM && ms <= MAX_MS ? 'exif' : 'manual';
}
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(api): exif trust-tier resolution`

---

### Task 7: R2 client + upload endpoints (presign / complete)

**Files:**
- Create: `api/_lib/r2.js`
- Create: `api/uploads/presign.js`, `api/uploads/complete.js`
- Test: `api/_lib/test/uploads.test.js`

**Interfaces:**
- Consumes: `readSession`, `checkLimit`, `resolveStampSource`, `getSql`, http helpers.
- Produces:
  - `r2.js`: `getR2()` (S3Client singleton for `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`), `presignPut({ key, contentType })` → URL string (10 min TTL), `headObject(key)` → `{ bytes, contentType } | null`, `getObjectBuffer(key, maxBytes)` → Buffer, `deleteObject(key)`, `publicUrl(key)` = `${MEDIA_PUBLIC_BASE}/${key}`.
  - `validateUploadRequest({ kind, contentType, bytes })` (exported from `api/_lib/uploads.js` section of `r2.js`? No — put it in `api/_lib/uploadrules.js`) — see below; returns `{ext}` or throws `HttpError(400, 'bad_type'|'too_big')`.
  - `POST api/uploads/presign` `{kind, contentType, bytes}` → `{mediaId, key, uploadUrl}`; inserts `media` row status `pending`.
  - `POST api/uploads/complete` `{mediaId, lat, lng, capturedAt, caption, claimedStampSource}` → `{media}`; verifies object, EXIF re-check for photos, flips to `live`. Idempotent: completing an already-`live` row returns it unchanged.

**Files (corrected list):** also Create: `api/_lib/uploadrules.js`.

- [ ] **Step 1: Write failing tests `api/_lib/test/uploads.test.js`** (pure logic only — rules + complete-flow with injected deps)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUploadRequest } from '../uploadrules.js';
import { completeUpload } from '../uploadflow.js';

test('accepts jpeg photo within cap', () => {
  assert.deepEqual(validateUploadRequest({ kind: 'photo', contentType: 'image/jpeg', bytes: 5_000_000 }), { ext: 'jpg' });
});
test('rejects oversize photo and wrong types', () => {
  assert.throws(() => validateUploadRequest({ kind: 'photo', contentType: 'image/jpeg', bytes: 16_000_000 }), /too_big/);
  assert.throws(() => validateUploadRequest({ kind: 'photo', contentType: 'image/gif', bytes: 1000 }), /bad_type/);
  assert.throws(() => validateUploadRequest({ kind: 'video', contentType: 'video/webm', bytes: 1000 }), /bad_type/);
});
test('accepts mp4 video within cap', () => {
  assert.deepEqual(validateUploadRequest({ kind: 'video', contentType: 'video/mp4', bytes: 80_000_000 }), { ext: 'mp4' });
});

test('completeUpload verifies object, resolves tier, and goes live', async () => {
  const calls = [];
  const media = { id: 'm1', user_id: 'u1', kind: 'photo', r2_key: 'media/m1.jpg', status: 'pending', content_type: 'image/jpeg' };
  const deps = {
    sql: async (strings, ...vals) => {
      const q = strings.join('?');
      calls.push(q);
      if (q.includes('SELECT') && q.includes('FROM media')) return [media];
      if (q.includes('UPDATE media')) return [{ ...media, status: 'live', stamp_source: vals[0] }];
      throw new Error('unexpected: ' + q);
    },
    headObject: async () => ({ bytes: 5000, contentType: 'image/jpeg' }),
    readExif: async () => ({ lat: 40.001, lng: -74.001, capturedAt: '2026-07-01T12:00:00Z' }),
    reverseGeocode: async () => 'Sandy Hook, NJ',
  };
  const out = await completeUpload(deps, {
    mediaId: 'm1', userId: 'u1',
    lat: 40, lng: -74, capturedAt: '2026-07-01T12:30:00Z',
    caption: 'firing', claimedStampSource: 'exif',
  });
  assert.equal(out.status, 'live');
  assert.equal(out.stamp_source, 'exif');
});

test('completeUpload downgrades when object EXIF contradicts claim', async () => {
  const media = { id: 'm1', user_id: 'u1', kind: 'photo', r2_key: 'media/m1.jpg', status: 'pending', content_type: 'image/jpeg' };
  const deps = {
    sql: async (strings, ...vals) => {
      const q = strings.join('?');
      if (q.includes('SELECT')) return [media];
      if (q.includes('UPDATE')) return [{ ...media, status: 'live', stamp_source: vals[0] }];
    },
    headObject: async () => ({ bytes: 5000, contentType: 'image/jpeg' }),
    readExif: async () => ({ lat: 0, lng: 0, capturedAt: '2020-01-01T00:00:00Z' }),
    reverseGeocode: async () => null,
  };
  const out = await completeUpload(deps, {
    mediaId: 'm1', userId: 'u1', lat: 40, lng: -74,
    capturedAt: '2026-07-01T12:30:00Z', caption: '', claimedStampSource: 'exif',
  });
  assert.equal(out.stamp_source, 'manual');
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `api/_lib/uploadrules.js`**

```js
import { HttpError } from './http.js';

const RULES = {
  photo: { types: { 'image/jpeg': 'jpg', 'image/png': 'png' }, maxBytes: 15 * 1024 * 1024 },
  video: { types: { 'video/mp4': 'mp4', 'video/quicktime': 'mov' }, maxBytes: 100 * 1024 * 1024 },
};

export function validateUploadRequest({ kind, contentType, bytes }) {
  const rule = RULES[kind];
  if (!rule || !rule.types[contentType]) throw new HttpError(400, 'bad_type');
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > rule.maxBytes) throw new HttpError(400, 'too_big');
  return { ext: rule.types[contentType] };
}
```

- [ ] **Step 4: Implement `api/_lib/uploadflow.js`** (pure, injectable)

```js
import { HttpError } from './http.js';
import { resolveStampSource } from './stamp.js';

export async function completeUpload(deps, input) {
  const { sql, headObject, readExif, reverseGeocode } = deps;
  const rows = await sql`SELECT * FROM media WHERE id = ${input.mediaId} AND user_id = ${input.userId}`;
  if (!rows.length) throw new HttpError(404, 'not_found');
  const media = rows[0];
  if (media.status === 'live') return media;           // idempotent
  if (media.status === 'removed') throw new HttpError(410, 'removed');

  const head = await headObject(media.r2_key);
  if (!head) throw new HttpError(400, 'no_object');

  let exif = null;
  if (media.kind === 'photo') {
    try { exif = await readExif(media.r2_key); } catch { exif = null; }
  }
  const stamp = resolveStampSource({
    claimed: { lat: input.lat, lng: input.lng, capturedAt: input.capturedAt, source: input.claimedStampSource },
    exif,
  });
  const spotName = (await reverseGeocode(input.lat, input.lng).catch(() => null)) || null;
  const caption = String(input.caption || '').slice(0, 140);

  const updated = await sql`
    UPDATE media SET status = 'live', stamp_source = ${stamp},
      lat = ${input.lat}, lng = ${input.lng}, captured_at = ${input.capturedAt},
      caption = ${caption}, spot_name = ${spotName}, bytes = ${head.bytes}
    WHERE id = ${input.mediaId} RETURNING *`;
  return updated[0];
}
```

- [ ] **Step 5: Implement `api/_lib/r2.js`**

```js
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from './http.js';

let _client = null;
function client() {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${getEnv('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: getEnv('R2_ACCESS_KEY_ID'),
        secretAccessKey: getEnv('R2_SECRET_ACCESS_KEY'),
      },
    });
  }
  return _client;
}
const bucket = () => getEnv('R2_BUCKET');

export function presignPut({ key, contentType }) {
  return getSignedUrl(client(), new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }), { expiresIn: 600 });
}

export async function headObject(key) {
  try {
    const h = await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { bytes: h.ContentLength, contentType: h.ContentType };
  } catch {
    return null;
  }
}

export async function getObjectBuffer(key, maxBytes = 20 * 1024 * 1024) {
  const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key, Range: `bytes=0-${maxBytes - 1}` }));
  return Buffer.from(await r.Body.transformToByteArray());
}

export async function deleteObject(key) {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export const publicUrl = (key) => `${getEnv('MEDIA_PUBLIC_BASE')}/${key}`;
```

- [ ] **Step 6: Implement the endpoints**

`api/uploads/presign.js`:

```js
import { randomUUID } from 'node:crypto';
import { route, json, jsonBody, HttpError } from '../_lib/http.js';
import { readSession } from '../_lib/session.js';
import { getSql } from '../_lib/db.js';
import { checkLimit } from '../_lib/ratelimit.js';
import { validateUploadRequest } from '../_lib/uploadrules.js';
import { presignPut } from '../_lib/r2.js';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const sess = await readSession(req);
  if (!sess) throw new HttpError(401, 'signed_out');

  const { kind, contentType, bytes } = await jsonBody(req);
  const { ext } = validateUploadRequest({ kind, contentType, bytes });

  const sql = getSql();
  const banned = await sql`SELECT banned FROM users WHERE id = ${sess.userId}`;
  if (!banned.length || banned[0].banned) throw new HttpError(403, 'banned');
  if (!(await checkLimit(sql, `upload:${sess.userId}:day`, 10, 86400))) throw new HttpError(429, 'rate_limited');

  const mediaId = randomUUID();
  const key = `media/${mediaId}.${ext}`;
  await sql`INSERT INTO media (id, user_id, kind, r2_key, content_type, status)
            VALUES (${mediaId}, ${sess.userId}, ${kind}, ${key}, ${contentType}, 'pending')`;
  const uploadUrl = await presignPut({ key, contentType });
  json(res, 200, { mediaId, key, uploadUrl });
});
```

`api/uploads/complete.js`:

```js
import exifr from 'exifr';
import { route, json, jsonBody, HttpError } from '../_lib/http.js';
import { readSession } from '../_lib/session.js';
import { getSql } from '../_lib/db.js';
import { completeUpload } from '../_lib/uploadflow.js';
import { headObject, getObjectBuffer, publicUrl } from '../_lib/r2.js';

async function readExifFromR2(key) {
  const buf = await getObjectBuffer(key, 4 * 1024 * 1024);   // EXIF lives in the first bytes
  const data = await exifr.parse(buf, { gps: true, pick: ['DateTimeOriginal', 'latitude', 'longitude'] });
  if (!data) return null;
  return {
    lat: data.latitude ?? null,
    lng: data.longitude ?? null,
    capturedAt: data.DateTimeOriginal ? new Date(data.DateTimeOriginal).toISOString() : null,
  };
}

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const sess = await readSession(req);
  if (!sess) throw new HttpError(401, 'signed_out');

  const body = await jsonBody(req);
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new HttpError(400, 'bad_location');
  }
  const capturedAt = new Date(body.capturedAt);
  if (Number.isNaN(+capturedAt) || +capturedAt > Date.now() + 60_000) throw new HttpError(400, 'bad_time');

  const media = await completeUpload(
    { sql: getSql(), headObject, readExif: readExifFromR2, reverseGeocode: async () => null },
    { mediaId: String(body.mediaId), userId: sess.userId, lat, lng,
      capturedAt: capturedAt.toISOString(), caption: body.caption,
      claimedStampSource: ['exif', 'device', 'manual'].includes(body.claimedStampSource) ? body.claimedStampSource : 'manual' },
  );
  json(res, 200, { media: { ...media, url: publicUrl(media.r2_key) } });
});
```

(`reverseGeocode` is stubbed null here; the client already displays coordinates, and the existing in-browser `reverseGeocode` from `coastline.js` supplies the display name at upload time via `spot_name`… **No** — keep it server-null and have the client pass nothing; `spot_name` stays null in v1. The panel shows coordinates + relative time.)

- [ ] **Step 7: Run** `npm run test:api` — PASS; `node --check` each new file.
- [ ] **Step 8: Commit** `feat(api): presigned R2 uploads with server-side exif verification`

---

### Task 8: Media list, report, admin endpoints

**Files:**
- Create: `api/spots/media.js`, `api/report.js`, `api/admin/media.js`, `api/admin/act.js`
- Test: `api/_lib/test/query.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `GET api/spots/media?lat&lng&radiusKm=25&limit=30` → `{items: [{id, kind, url, lat, lng, capturedAt, stampSource, caption, handle, createdAt}]}` (live only, newest first, limit ≤ 50).
  - `POST api/report {mediaId, reason}` → `{ok:true}`; unique per (media, ipHash); at 3 distinct reports sets `report_count` (admin list surfaces `report_count >= 3`).
  - `GET api/admin/media?status=reported|live` → full rows incl. email; `POST api/admin/act {action: 'remove'|'ban', mediaId?, userId?}`.
  - `api/_lib/query.js` exports `bboxFor(lat, lng, radiusKm)` → `{minLat, maxLat, minLng, maxLng}` (pure, tested).

- [ ] **Step 1: Write failing test `api/_lib/test/query.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bboxFor } from '../query.js';

test('bbox spans ~2x radius and widens with latitude', () => {
  const b = bboxFor(40, -74, 25);
  assert.ok(Math.abs((b.maxLat - b.minLat) - 0.4496) < 0.01);          // 50km / 111.2
  const bHigh = bboxFor(60, -74, 25);
  assert.ok((bHigh.maxLng - bHigh.minLng) > (b.maxLng - b.minLng));    // cos(lat) shrinks
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement `api/_lib/query.js`**

```js
export function bboxFor(lat, lng, radiusKm) {
  const dLat = radiusKm / 111.2;
  const dLng = radiusKm / (111.2 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}
```

- [ ] **Step 4: Implement endpoints**

`api/spots/media.js`:

```js
import { route, json, HttpError } from '../_lib/http.js';
import { getSql } from '../_lib/db.js';
import { bboxFor } from '../_lib/query.js';
import { publicUrl } from '../_lib/r2.js';

export default route(async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, 'bad_location');
  const radiusKm = Math.min(Number(req.query.radiusKm) || 25, 100);
  const limit = Math.min(Number(req.query.limit) || 30, 50);
  const b = bboxFor(lat, lng, radiusKm);

  const rows = await getSql()`
    SELECT m.id, m.kind, m.r2_key, m.lat, m.lng, m.captured_at, m.stamp_source,
           m.caption, m.created_at, u.handle
    FROM media m JOIN users u ON u.id = m.user_id
    WHERE m.status = 'live'
      AND m.lat BETWEEN ${b.minLat} AND ${b.maxLat}
      AND m.lng BETWEEN ${b.minLng} AND ${b.maxLng}
      AND 2 * 6371 * asin(sqrt(
            sin(radians((m.lat - ${lat}) / 2)) ^ 2 +
            cos(radians(${lat})) * cos(radians(m.lat)) * sin(radians((m.lng - ${lng}) / 2)) ^ 2
          )) <= ${radiusKm}
    ORDER BY m.created_at DESC LIMIT ${limit}`;

  json(res, 200, {
    items: rows.map(r => ({
      id: r.id, kind: r.kind, url: publicUrl(r.r2_key), lat: r.lat, lng: r.lng,
      capturedAt: r.captured_at, stampSource: r.stamp_source,
      caption: r.caption, handle: r.handle, createdAt: r.created_at,
    })),
  });
});
```

`api/report.js`:

```js
import { route, json, jsonBody, ipHash, getEnv, HttpError } from './_lib/http.js';
import { getSql } from './_lib/db.js';
import { checkLimit } from './_lib/ratelimit.js';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const { mediaId, reason } = await jsonBody(req);
  const ip = ipHash(req, getEnv('SESSION_SECRET'));
  const sql = getSql();
  if (!(await checkLimit(sql, `report:${ip}:day`, 20, 86400))) throw new HttpError(429, 'rate_limited');

  await sql`INSERT INTO reports (media_id, reason, ip_hash)
            VALUES (${String(mediaId)}, ${String(reason || '').slice(0, 200)}, ${ip})
            ON CONFLICT (media_id, ip_hash) DO NOTHING`;
  await sql`UPDATE media SET report_count = (SELECT count(DISTINCT ip_hash) FROM reports WHERE media_id = ${String(mediaId)})
            WHERE id = ${String(mediaId)}`;
  json(res, 200, { ok: true });
});
```

`api/admin/media.js`:

```js
import { route, json, getEnv, HttpError } from '../_lib/http.js';
import { readSession } from '../_lib/session.js';
import { getSql } from '../_lib/db.js';
import { publicUrl } from '../_lib/r2.js';

export async function requireAdmin(req) {
  const sess = await readSession(req);
  const admins = getEnv('ADMIN_EMAILS').split(',').map(s => s.trim().toLowerCase());
  if (!sess || !admins.includes(sess.email.toLowerCase())) throw new HttpError(403, 'forbidden');
  return sess;
}

export default route(async (req, res) => {
  await requireAdmin(req);
  const reportedOnly = req.query.status === 'reported';
  const rows = await getSql()`
    SELECT m.*, u.email, u.handle FROM media m JOIN users u ON u.id = m.user_id
    WHERE m.status = 'live' ${reportedOnly ? getSql()`AND m.report_count >= 3` : getSql()``}
    ORDER BY m.report_count DESC, m.created_at DESC LIMIT 200`;
  json(res, 200, { items: rows.map(r => ({ ...r, url: publicUrl(r.r2_key) })) });
});
```

`api/admin/act.js`:

```js
import { route, json, jsonBody, HttpError } from '../_lib/http.js';
import { getSql } from '../_lib/db.js';
import { deleteObject } from '../_lib/r2.js';
import { requireAdmin } from './media.js';

export default route(async (req, res) => {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  await requireAdmin(req);
  const { action, mediaId, userId } = await jsonBody(req);
  const sql = getSql();

  if (action === 'remove') {
    const rows = await sql`UPDATE media SET status = 'removed' WHERE id = ${String(mediaId)} RETURNING r2_key`;
    if (rows.length) await deleteObject(rows[0].r2_key).catch(() => {});
    return json(res, 200, { ok: true });
  }
  if (action === 'ban') {
    await sql`UPDATE users SET banned = true WHERE id = ${String(userId)}`;
    await sql`UPDATE media SET status = 'removed' WHERE user_id = ${String(userId)}`;
    return json(res, 200, { ok: true });
  }
  throw new HttpError(400, 'bad_action');
});
```

- [ ] **Step 5: Run** `npm run test:api` + `node --check` each file — PASS.
- [ ] **Step 6: Commit** `feat(api): media list, reports, admin moderation`

---

### Task 9: Client — vendored exifr + upload sheet

**Files:**
- Create: `public/vendor/exifr/full.esm.js` (copy `node_modules/exifr/dist/full.esm.mjs`)
- Create: `public/js/media.js`
- Modify: `public/index.html` (upload sheet markup before `</body>`, script unchanged — `media.js` is imported from `panel.js` in Task 10)
- Modify: `public/css/style.css` (append styles)

**Interfaces:**
- Consumes: `POST api/uploads/presign`, PUT to R2, `POST api/uploads/complete`, `GET api/me`, `POST api/auth/request-link`.
- Produces: `openUploadSheet({ lat, lng, map })` and `getMe()` exported from `public/js/media.js`. Task 10 calls `openUploadSheet` from the panel; Task 11's auth modal is also in `media.js` (`ensureSignedIn()`).

- [ ] **Step 1: Vendor exifr**

```bash
cp node_modules/exifr/dist/full.esm.mjs public/vendor/exifr/full.esm.js
```

- [ ] **Step 2: Add sheet markup to `public/index.html`** (before the scripts at the end of `<body>`)

```html
  <!-- Upload sheet -->
  <div class="upload-backdrop" id="upload-backdrop" hidden></div>
  <div class="upload-sheet" id="upload-sheet" hidden>
    <div class="upload-head">
      <h3>Add spot media</h3>
      <button class="close-btn" id="upload-close">&times;</button>
    </div>
    <div class="upload-body">
      <input type="file" id="upload-file" accept="image/jpeg,image/png,video/mp4,video/quicktime">
      <div class="upload-preview" id="upload-preview"></div>
      <div class="upload-meta">
        <label>Captured <input type="datetime-local" id="upload-time"></label>
        <div class="upload-stamp-tag" id="upload-stamp-tag"></div>
      </div>
      <div class="upload-minimap" id="upload-minimap"></div>
      <input type="text" id="upload-caption" maxlength="140" placeholder="Caption (optional)">
      <button class="ctrl-btn" id="upload-submit" disabled>Upload</button>
      <div class="upload-status" id="upload-status"></div>
    </div>
  </div>

  <!-- Sign-in modal -->
  <div class="signin-modal" id="signin-modal" hidden>
    <div class="signin-box">
      <h3>Sign in to upload</h3>
      <p>We'll email you a one-time link.</p>
      <input type="email" id="signin-email" placeholder="you@example.com">
      <button class="ctrl-btn" id="signin-send">Send link</button>
      <div class="signin-status" id="signin-status"></div>
      <button class="close-btn" id="signin-close">&times;</button>
    </div>
  </div>
```

- [ ] **Step 3: Implement `public/js/media.js`** — full module:

```js
/**
 * media.js — spot media upload sheet + light auth client.
 */
import exifr from '/vendor/exifr/full.esm.js';

let me = null;
export async function getMe() {
  if (me !== null) return me;
  try {
    const r = await fetch('/api/me');
    me = r.ok ? (await r.json()).user : false;
  } catch { me = false; }
  return me;
}

export function ensureSignedIn() {
  return getMe().then(u => {
    if (u) return u;
    return new Promise((resolve) => {
      const modal = document.getElementById('signin-modal');
      modal.hidden = false;
      document.getElementById('signin-close').onclick = () => { modal.hidden = true; resolve(null); };
      document.getElementById('signin-send').onclick = async () => {
        const email = document.getElementById('signin-email').value.trim();
        const status = document.getElementById('signin-status');
        status.textContent = 'Sending…';
        const r = await fetch('/api/auth/request-link', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        status.textContent = r.ok
          ? 'Check your email and open the link, then try again.'
          : 'Could not send — check the address.';
      };
    });
  });
}

/** Downscale an image file to <=1600px JPEG. Returns {blob, contentType}. */
async function downscalePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  return { blob, contentType: 'image/jpeg' };
}

export async function openUploadSheet({ lat, lng }) {
  const user = await ensureSignedIn();
  if (!user) return;

  const sheet = document.getElementById('upload-sheet');
  const backdrop = document.getElementById('upload-backdrop');
  const fileInput = document.getElementById('upload-file');
  const timeInput = document.getElementById('upload-time');
  const stampTag = document.getElementById('upload-stamp-tag');
  const submit = document.getElementById('upload-submit');
  const status = document.getElementById('upload-status');
  const preview = document.getElementById('upload-preview');

  sheet.hidden = false; backdrop.hidden = false;
  status.textContent = ''; preview.innerHTML = ''; submit.disabled = true;
  fileInput.value = '';

  let pin = { lat, lng };
  let stampSource = 'manual';
  let picked = null;   // {blob, contentType, kind}

  // Mini-map pin confirm
  const mini = new maplibregl.Map({
    container: 'upload-minimap',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0f172a' } }] },
    center: [lng, lat], zoom: 9, attributionControl: false, interactive: true,
  });
  const marker = new maplibregl.Marker({ draggable: true, color: '#38bdf8' })
    .setLngLat([lng, lat]).addTo(mini);
  marker.on('dragend', () => {
    const p = marker.getLngLat();
    pin = { lat: p.lat, lng: p.lng };
    stampSource = 'manual';
    stampTag.textContent = 'location set by uploader';
  });

  const close = () => { sheet.hidden = true; backdrop.hidden = true; mini.remove(); };
  document.getElementById('upload-close').onclick = close;
  backdrop.onclick = close;

  const setTime = (d) => { timeInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  setTime(new Date());
  timeInput.onchange = () => { if (stampSource === 'exif') { stampSource = 'manual'; stampTag.textContent = 'location set by uploader'; } };

  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const isVideo = file.type.startsWith('video/');

    if (isVideo && file.size > 100 * 1024 * 1024) { status.textContent = 'Video too large (max 100 MB).'; return; }

    if (isVideo) {
      picked = { blob: file, contentType: file.type, kind: 'video' };
      const v = document.createElement('video');
      v.src = URL.createObjectURL(file); v.muted = true; v.controls = true;
      v.onloadedmetadata = () => {
        if (v.duration > 31) { status.textContent = 'Clips must be 30 seconds or less.'; submit.disabled = true; }
      };
      preview.replaceChildren(v);
      stampSource = 'device';
      stampTag.textContent = 'user-reported time & place';
    } else {
      // EXIF prefill from the ORIGINAL file (downscale strips metadata)
      const exif = await exifr.parse(file, { gps: true, pick: ['DateTimeOriginal', 'latitude', 'longitude'] }).catch(() => null);
      picked = { ...(await downscalePhoto(file)), kind: 'photo' };
      const img = document.createElement('img');
      img.src = URL.createObjectURL(picked.blob);
      preview.replaceChildren(img);
      if (exif && exif.latitude != null && exif.DateTimeOriginal) {
        pin = { lat: exif.latitude, lng: exif.longitude };
        marker.setLngLat([pin.lng, pin.lat]); mini.setCenter([pin.lng, pin.lat]);
        setTime(new Date(exif.DateTimeOriginal));
        stampSource = 'exif';
        stampTag.textContent = 'verified from photo — confirm the pin';
      } else {
        stampSource = navigator.geolocation ? 'device' : 'manual';
        stampTag.textContent = 'no photo metadata — confirm time & pin';
      }
    }
    submit.disabled = false;
  };

  submit.onclick = async () => {
    if (!picked) return;
    submit.disabled = true;
    status.textContent = 'Uploading…';
    try {
      const presign = await fetch('/api/uploads/presign', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: picked.kind, contentType: picked.contentType, bytes: picked.blob.size }),
      });
      if (!presign.ok) throw new Error((await presign.json()).code || 'presign_failed');
      const { mediaId, uploadUrl } = await presign.json();

      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': picked.contentType }, body: picked.blob });
      if (!put.ok) throw new Error('storage_failed');

      const complete = await fetch('/api/uploads/complete', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mediaId, lat: pin.lat, lng: pin.lng,
          capturedAt: new Date(timeInput.value).toISOString(),
          caption: document.getElementById('upload-caption').value,
          claimedStampSource: stampSource,
        }),
      });
      if (!complete.ok) throw new Error((await complete.json()).code || 'complete_failed');
      status.textContent = 'Uploaded ✓';
      setTimeout(close, 700);
      document.dispatchEvent(new CustomEvent('media-uploaded', { detail: { lat: pin.lat, lng: pin.lng } }));
    } catch (e) {
      status.textContent = e.message === 'rate_limited' ? 'Daily upload limit reached.' : 'Upload failed — try again.';
      submit.disabled = false;
    }
  };
}
```

- [ ] **Step 4: Append styles to `public/css/style.css`**

```css
/* ── Upload sheet & sign-in ── */
.upload-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 70; }
.upload-sheet {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 24px)); max-height: min(640px, calc(100dvh - 24px));
  overflow-y: auto; z-index: 71; background: var(--surface-solid);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 14px;
}
.upload-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.upload-preview img, .upload-preview video { max-width: 100%; border-radius: var(--radius); margin: 8px 0; }
.upload-minimap { height: 180px; border-radius: var(--radius); margin: 8px 0; }
.upload-meta { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.upload-stamp-tag { color: var(--accent); font-size: 11px; }
.upload-status { font-size: 12px; color: var(--text-muted); margin-top: 8px; }
#upload-caption { width: 100%; margin: 8px 0; padding: 8px; background: rgba(30,41,59,0.8);
  border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); }
.signin-modal { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }
.signin-box { position: relative; width: min(360px, calc(100vw - 24px)); background: var(--surface-solid);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
.signin-box input { width: 100%; margin: 10px 0; padding: 8px; background: rgba(30,41,59,0.8);
  border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); }
```

- [ ] **Step 5: Verify** — `node --check public/js/media.js`; load the app locally, run `openUploadSheet({lat: 40, lng: -74})` from the console: sheet opens, file pick previews, EXIF photo prefills pin/time (fixture: any phone photo). API calls will 404 under plain `node server.js` — full flow is exercised in Task 12 under `vercel dev`.
- [ ] **Step 6: Commit** `feat(ui): upload sheet with exif prefill and sign-in modal`

---

### Task 10: Client — media strip in the spot panel

**Files:**
- Modify: `public/js/panel.js` (render media strip in `render()`; camera button in panel header)
- Modify: `public/css/style.css` (append)

**Interfaces:**
- Consumes: `GET api/spots/media`, `openUploadSheet` from `public/js/media.js`, panel's existing `state` holding `lat`/`lng` (see `panel.js` — `openPanel(lat, lng, …)`).
- Produces: media strip section rendered at the bottom of `.rating-body`; refreshes on `media-uploaded` DOM event.

- [ ] **Step 1: Add to `public/js/panel.js`** — import at top:

```js
import { openUploadSheet } from './media.js';
```

Add these functions near the bottom of the file:

```js
async function renderMediaStrip(container, lat, lng) {
  let strip = container.querySelector('.media-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'media-strip';
    container.appendChild(strip);
  }
  strip.innerHTML = '<div class="media-strip-head">Recent media' +
    ' <button class="ctrl-btn media-add-btn" title="Add photo/clip">📷 add</button></div>' +
    '<div class="media-thumbs">Loading…</div>';
  strip.querySelector('.media-add-btn').onclick = () => openUploadSheet({ lat, lng });

  try {
    const r = await fetch(`/api/spots/media?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}`);
    if (!r.ok) throw new Error();
    const { items } = await r.json();
    const thumbs = strip.querySelector('.media-thumbs');
    if (!items.length) { thumbs.textContent = 'No media yet — be the first.'; return; }
    thumbs.replaceChildren(...items.map(m => {
      const el = document.createElement(m.kind === 'video' ? 'video' : 'img');
      el.src = m.url;
      if (m.kind === 'video') { el.muted = true; el.preload = 'metadata'; }
      el.className = 'media-thumb';
      el.title = `${new Date(m.capturedAt).toLocaleString()} · ${m.stampSource === 'exif' ? 'verified' : 'user-reported'}`;
      el.onclick = () => openLightbox(m);
      return el;
    }));
  } catch {
    strip.querySelector('.media-thumbs').textContent = 'Media unavailable.';
  }
}

function openLightbox(m) {
  const wrap = document.createElement('div');
  wrap.className = 'media-lightbox';
  const media = document.createElement(m.kind === 'video' ? 'video' : 'img');
  media.src = m.url;
  if (m.kind === 'video') { media.controls = true; media.autoplay = true; }
  const meta = document.createElement('div');
  meta.className = 'media-lightbox-meta';
  const when = new Date(m.capturedAt);
  meta.innerHTML =
    `<span>${when.toLocaleString()} · ${m.stampSource === 'exif' ? '✓ verified capture data' : 'user-reported'}</span>` +
    `<span>@${m.handle}${m.caption ? ' — ' + m.caption.replace(/</g, '&lt;') : ''}</span>` +
    `<button class="media-report">report</button>`;
  meta.querySelector('.media-report').onclick = async () => {
    await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: m.id, reason: 'user report' }) });
    meta.querySelector('.media-report').textContent = 'reported ✓';
  };
  wrap.append(media, meta);
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  document.body.appendChild(wrap);
}
```

Call `renderMediaStrip` at the end of the existing `render()` function (after the rating body is populated — find the function that sets `.rating-body` innerHTML and append):

```js
  const body = document.querySelector('.rating-body');
  renderMediaStrip(body, state.lat, state.lng);
```

And refresh on upload — top-level in the module:

```js
document.addEventListener('media-uploaded', () => {
  if (isPanelOpen() && state.lat != null) {
    renderMediaStrip(document.querySelector('.rating-body'), state.lat, state.lng);
  }
});
```

(Adjust identifiers to the actual names in `panel.js` — it keeps panel state in module scope; reuse whatever holds the current lat/lng, e.g. `current.lat`. The implementer must read `panel.js:1-80` first.)

- [ ] **Step 2: Append styles**

```css
/* ── Media strip & lightbox ── */
.media-strip { padding: 12px 16px 20px; border-top: 1px solid var(--border); }
.media-strip-head { display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; font-weight: 600; margin-bottom: 8px; }
.media-add-btn { font-size: 11px; }
.media-thumbs { display: flex; gap: 8px; overflow-x: auto; font-size: 12px; color: var(--text-muted); }
.media-thumb { width: 96px; height: 72px; object-fit: cover; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border); flex-shrink: 0; }
.media-lightbox { position: fixed; inset: 0; z-index: 90; background: rgba(0,0,0,0.85);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.media-lightbox img, .media-lightbox video { max-width: 92vw; max-height: 75vh; border-radius: var(--radius); }
.media-lightbox-meta { display: flex; flex-direction: column; align-items: center; gap: 4px;
  font-size: 12px; color: var(--text); }
.media-lightbox-meta .media-report { background: none; border: none; color: var(--text-muted);
  text-decoration: underline; cursor: pointer; font-size: 11px; }
```

- [ ] **Step 3: Verify** — `node --check public/js/panel.js`; local app: click a coast point, panel shows "Recent media" section ("Media unavailable." is correct under plain `node server.js`).
- [ ] **Step 4: Commit** `feat(ui): media strip + lightbox in spot panel`

---

### Task 11: Admin page

**Files:**
- Create: `public/admin.html` (self-contained page, inline script)

**Interfaces:**
- Consumes: `GET api/admin/media`, `POST api/admin/act`, `GET api/me`.

- [ ] **Step 1: Write `public/admin.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Media admin</title>
  <link rel="stylesheet" href="css/style.css">
  <style>
    body { overflow: auto; padding: 20px; height: auto; }
    .row { display: flex; gap: 12px; align-items: center; border-bottom: 1px solid var(--border); padding: 10px 0; }
    .row img, .row video { width: 120px; height: 90px; object-fit: cover; border-radius: 6px; }
    .row .meta { flex: 1; font-size: 12px; }
    .row button { margin-left: 6px; }
    .tabs { margin: 12px 0; }
  </style>
</head>
<body>
  <h2>Media admin</h2>
  <div class="tabs">
    <button class="ctrl-btn" data-status="reported">Reported</button>
    <button class="ctrl-btn" data-status="live">All live</button>
  </div>
  <div id="list">Loading…</div>
  <script>
    const list = document.getElementById('list');
    async function load(status) {
      list.textContent = 'Loading…';
      const r = await fetch('/api/admin/media?status=' + status);
      if (r.status === 403) { list.textContent = 'Not authorized — sign in on the main app first.'; return; }
      const { items } = await r.json();
      list.replaceChildren(...items.map(m => {
        const row = document.createElement('div');
        row.className = 'row';
        const media = document.createElement(m.kind === 'video' ? 'video' : 'img');
        media.src = m.url; if (m.kind === 'video') media.controls = true;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${m.email} · ${m.stamp_source} · reports:${m.report_count} · ${new Date(m.created_at).toLocaleString()} · "${m.caption || ''}"`;
        const rm = document.createElement('button'); rm.className = 'ctrl-btn'; rm.textContent = 'Remove';
        rm.onclick = () => act({ action: 'remove', mediaId: m.id }, row);
        const ban = document.createElement('button'); ban.className = 'ctrl-btn'; ban.textContent = 'Ban user';
        ban.onclick = () => confirm('Ban ' + m.email + ' and remove all their media?') && act({ action: 'ban', userId: m.user_id }, row);
        row.append(media, meta, rm, ban);
        return row;
      }));
      if (!items.length) list.textContent = 'Nothing here.';
    }
    async function act(body, row) {
      const r = await fetch('/api/admin/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) row.remove();
    }
    document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => load(b.dataset.status));
    load('reported');
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify** page loads locally (shows "Not authorized" without session — correct).
- [ ] **Step 3: Commit** `feat(admin): moderation page`

---

### Task 12: Integration + e2e (gated on Task 0)

**Files:**
- Create: `test/e2e/media-upload.mjs` (Playwright, system Chrome)
- Create: `test/e2e/fixtures/exif-photo.jpg` (any JPEG with GPS + DateTimeOriginal; generate with `exiftool` or copy a phone photo)

- [ ] **Step 1: Migrate + start** — `npm run migrate` (against the Neon branch DB), then `npx vercel dev --listen 3000` with `.env` loaded.
- [ ] **Step 2: API integration pass (curl)** — request-link (intercept token from the tokens table directly: `SELECT` the row, reconstruct is impossible since hashed — instead set a test-only `ADMIN_EMAILS` account and use Resend's test inbox, or read the emailed link from Resend dashboard). Verify: 401 presign signed out; sign-in; presign → PUT → complete → media listed by `GET /api/spots/media`; report ×3 different `x-forwarded-for` values flags it; admin list shows it; admin remove deletes from R2.
- [ ] **Step 3: Playwright e2e `test/e2e/media-upload.mjs`** — sign-in is the awkward bit; for e2e, mint a session cookie directly with `SESSION_SECRET` from `.env` (same JWT code path as `session.js`) and inject via `context.addCookies`, then: open app → click coast → panel shows media strip → upload `fixtures/exif-photo.jpg` via the sheet → assert thumb appears and lightbox shows "verified capture data".
- [ ] **Step 4: Commit** `test: media upload integration + e2e`

---

### Task 13: Docs + deploy

**Files:**
- Modify: `README.md` (Spot media section: env vars, migrate command, admin page URL)
- Modify: `vercel.json` — no change needed for functions (zero-config `api/`), but verify `cleanUrls` doesn't shadow `/api/*`.

- [ ] **Step 1: README section** — document env vars (from `.env.example`), `npm run migrate`, quotas, admin page at `/admin.html`, and the R2 CORS requirement.
- [ ] **Step 2: Deploy** — push to main; Vercel builds functions automatically. Run `npm run migrate` once against production `DATABASE_URL`. Smoke: sign in on prod, upload one photo, see it in the panel, remove it via `/admin.html`.
- [ ] **Step 3: Commit** `docs: spot media setup`

---

## Self-Review Notes

- Spec coverage: UX (Tasks 9-10), trust model (6-7), API surface (5, 7, 8), schema (1), quotas (4, 5, 7, 8), admin (8, 11), error handling (2, 9), testing (unit throughout, integration/e2e 12), rollout (13). `spot_name` reverse geocode is stubbed null (documented in Task 7) — panel shows coordinates/time instead; spec's "reverse-geocodes a display name" is deferred intentionally and the column exists.
- Orphaned-object sweep: spec marks it accepted debt; `media.status='pending'` rows + `created_at` make the later sweep possible. No task needed.
- Types consistent: `checkLimit(sql, key, max, windowSeconds)` used identically in Tasks 4, 5, 7, 8; `resolveStampSource({claimed, exif})` defined in 6, consumed in 7; endpoint payloads match `media.js` client calls.
