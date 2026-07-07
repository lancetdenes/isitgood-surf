import { createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
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
