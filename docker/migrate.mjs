// D1 migrations for the container: the same migrations/NNNN_*.sql files and the same d1_migrations bookkeeping table
// wrangler uses, applied through the D1 binding (each file in one batch = one transaction). Idempotent: applied
// files are skipped, so running it on every start is safe.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Split a migration file into statements: semicolons outside quotes; -- and block comments removed. No triggers here. */
export function splitSql(sql) {
  const out = [];
  let cur = '', i = 0, q = null;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (q) { cur += c; if (c === q) { if (n === q) { cur += n; i += 2; continue; } q = null; } i++; continue; }
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; i++; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const listMigrations = dir => readdirSync(dir).filter(f => /^\d{4}_[\w-]+\.sql$/.test(f)).sort();

const TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;

/** { applied: [...names], pending: [...names], fresh: true when the database has no tables of ours yet }. */
export async function migrationStatus(db, dir) {
  await db.prepare(TABLE).run();
  const applied = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(r => r.name);
  const pending = listMigrations(dir).filter(f => !applied.includes(f));
  const tables = (await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").first()).n;
  return { applied, pending, fresh: tables === 0 };
}

export async function applyMigrations(db, dir, { log = console.log } = {}) {
  const { pending } = await migrationStatus(db, dir);
  for (const name of pending) {
    const stmts = splitSql(readFileSync(join(dir, name), 'utf8')).map(s => db.prepare(s));
    stmts.push(db.prepare('INSERT INTO d1_migrations (name) VALUES (?1)').bind(name));
    await db.batch(stmts);
    log(`migration applied: ${name}`);
  }
  return pending;
}
