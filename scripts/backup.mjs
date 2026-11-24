#!/usr/bin/env node
// Export the whole garage D1 (schema + rows) to backups/d1/garage-YYYY-MM-DD.sql and keep the newest 30.
// Run it by hand, or nightly from the same always-on computer as the research worker (see docs/operations.md).
// Restore: `npx wrangler d1 time-travel restore <db> --timestamp <ISO>` (any minute in the last 30 days), or load a
// backup into a fresh database with `npx wrangler d1 execute <db> --remote --file backups/d1/<file>.sql`.
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, dbName, wrangler } from './lib.mjs';

const dir = join(ROOT, 'backups', 'd1');
mkdirSync(dir, { recursive: true });
const file = join(dir, `garage-${new Date().toISOString().slice(0, 10)}.sql`);
wrangler(['d1', 'export', dbName(), '--remote', '--output', file]);
chmodSync(file, 0o600);
const size = statSync(file).size;
if (size < 1000) { console.error(`backup looks empty (${size} bytes): ${file}`); process.exit(1); }
const old = readdirSync(dir).filter(f => /^garage-\d{4}-\d{2}-\d{2}\.sql$/.test(f)).sort().slice(0, -30);
for (const f of old) rmSync(join(dir, f));
console.log(`backup ${file} (${size.toLocaleString()} bytes)${old.length ? `, removed ${old.length} old` : ''}`);
