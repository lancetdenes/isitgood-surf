import { neon } from '@neondatabase/serverless';
import { getEnv } from './http.mjs';

let _sql = null;
export function getSql() {
  if (!_sql) _sql = neon(getEnv('DATABASE_URL'));
  return _sql;
}
