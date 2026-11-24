#!/usr/bin/env node
// Restore table(s) from a backup export (scripts/backup.mjs -> backups/d1/garage-*.sql, or a loader's pre-*.sql).
//   node scripts/d1-restore.mjs backups/d1/garage-2026-01-31.sql --table research [--table cars ...]          dry run
//   node scripts/d1-restore.mjs backups/d1/garage-2026-01-31.sql --table research --apply [--local]          write it
// The backup is loaded into an in-memory SQLite; each backed-up row is written back with an UPSERT, so nothing is deleted
// first (no ON DELETE CASCADE can fire). Live rows missing from the backup are left alone. Long text goes in 40 KB appends
// (D1's 100 KB statement cap). Before --apply, the live tables are exported to backups/d1/pre-restore-*.sql.
// Whole database to a point in time instead: npx wrangler d1 time-travel restore <db> --timestamp <ISO>.
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, d1File, d1Query, dbName, lit, wrangler } from './lib.mjs';
import { backup } from './loader-safety.mjs';

const CHUNK = 40000, MAX_STMT = 90000;
const q = s => `"${String(s).replace(/"/g, '""')}"`;
const litv = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? `X'${Buffer.from(v).toString('hex')}'` : lit(String(v));

export function loadBackup(text) { const db = new DatabaseSync(':memory:'); db.exec(text); return db; }

/** { pk, rows: [{ key, stmts }] } for every row of `table` in the backup db. */
export function upserts(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  if (!cols.length) throw new Error(`table ${table} is not in the backup`);
  const names = cols.map(c => c.name);
  let pk = cols.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const useRowid = !pk.length; if (useRowid) pk = ['rowid'];
  const rows = [];
  for (const rec of db.prepare(`SELECT ${names.map(q).join(', ')}${useRowid ? ', rowid' : ''} FROM ${q(table)}`).all()) {
    const big = Object.fromEntries(names.filter(n => typeof rec[n] === 'string' && rec[n].length > CHUNK).map(n => [n, rec[n]]));
    const upd = names.filter(n => !pk.includes(n)).map(n => `${q(n)} = excluded.${q(n)}`).join(', ') || `${q(pk[0])} = excluded.${q(pk[0])}`;
    const stmts = [`INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES (${names.map(n => n in big ? "''" : litv(rec[n])).join(', ')}) ON CONFLICT(${pk.map(q).join(', ')}) DO UPDATE SET ${upd};`];
    const where = pk.map(p => `${q(p)} = ${litv(rec[p])}`).join(' AND ');
    for (const [n, v] of Object.entries(big)) for (let i = 0; i < v.length; i += CHUNK) stmts.push(`UPDATE ${q(table)} SET ${q(n)} = COALESCE(${q(n)}, '') || ${lit(v.slice(i, i + CHUNK))} WHERE ${where};`);
    if (stmts.some(s => Buffer.byteLength(s) > MAX_STMT)) throw new Error(`${table}: a row is over D1's statement cap; restore it by hand`);
    rows.push({ key: JSON.stringify(pk.map(p => rec[p])), stmts });
  }
  return { pk, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [path, ...rest] = process.argv.slice(2);
    if (!path || path.startsWith('-')) throw new Error('usage: node scripts/d1-restore.mjs <backup.sql[.gz]> --table <name> [--table ...] [--apply] [--local]');
    const tables = rest.flatMap((a, i) => a === '--table' && rest[i + 1] ? [rest[i + 1]] : []);
    const apply = rest.includes('--apply'), local = rest.includes('--local');
    if (!tables.length) throw new Error('name at least one --table');
    const buf = readFileSync(path);
    const db = loadBackup(path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8'));
    const sql = [];
    for (const t of tables) {
      const { pk, rows } = upserts(db, t);
      const live = new Set(d1Query(`SELECT ${pk.map(q).join(', ')} FROM ${q(t)}`, { local }).map(r => JSON.stringify(pk.map(p => r[p]))));
      const backed = new Set(rows.map(r => r.key));
      const missing = [...backed].filter(k => !live.has(k)).length, both = [...backed].filter(k => live.has(k)).length, extra = [...live].filter(k => !backed.has(k)).length;
      console.error(`${t}: ${rows.length} rows in the backup, ${live.size} live; ${missing} missing live (re-inserted), ${both} reset to the backed-up values, ${extra} live rows not in the backup (left alone)`);
      for (const r of rows) sql.push(...r.stmts);
    }
    if (!apply) { console.error('DRY RUN: nothing written. Add --apply to restore.'); process.exit(0); }
    const b = backup({ tables, loader: 'restore', remote: !local, dbName: dbName(), root: ROOT, run: wrangler });
    if (b.exit) process.exit(b.exit);
    mkdirSync(join(ROOT, 'build'), { recursive: true });
    const out = join(ROOT, 'build', 'd1-restore.sql');
    writeFileSync(out, 'PRAGMA defer_foreign_keys = true;\n' + sql.join('\n') + '\n');
    try { d1File(out, { local }); } finally { rmSync(out, { force: true }); }
    console.error(`restored ${tables.join(', ')} (${sql.length} statements)`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
