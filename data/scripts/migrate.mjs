// migrate.mjs — apply api/_lib/schema.sql to DATABASE_URL (idempotent).
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
