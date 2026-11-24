// Admin access to the container's D1 for the kit's own scripts (add-car, load-research, seed-demo, backup), so they
// work the same against Docker as against Cloudflare. Listens on 127.0.0.1 INSIDE the container only (never
// published), and every call needs the per-boot token in /data/.admin-token (0600). docker/cli.mjs is the client;
// scripts/lib.mjs reaches it with `docker exec` when GARAGE_DOCKER is set.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
import { splitSql } from './migrate.mjs';

const q = s => `'${String(s).replace(/'/g, "''")}'`;
const ident = s => `"${String(s).replace(/"/g, '""')}"`;
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (Array.isArray(v) || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return `X'${Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v).toString('hex')}'`;
  return q(v);
}

/** SQL dump (schema + rows) of the given tables, or of every table when none are given. */
export async function exportSql(db, tables = []) {
  const all = (await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()).results;
  const pick = tables.length ? all.filter(t => tables.includes(t.name)) : all;
  const missing = tables.filter(t => !all.some(a => a.name === t));
  if (missing.length) throw new Error(`no such table: ${missing.join(', ')}`);
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  for (const t of pick) {
    out.push(`${t.sql.replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')};`);
    const { results } = await db.prepare(`SELECT * FROM ${ident(t.name)}`).all();
    for (const r of results) out.push(`INSERT INTO ${ident(t.name)} (${Object.keys(r).map(ident).join(', ')}) VALUES (${Object.values(r).map(sqlValue).join(', ')});`);
  }
  if (!tables.length) {
    const idx = (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()).results;
    for (const i of idx) out.push(`${i.sql.replace(/^CREATE (UNIQUE )?INDEX\s+(?!IF NOT EXISTS)/i, 'CREATE $1INDEX IF NOT EXISTS ')};`);
  }
  return out.join('\n') + '\n';
}

export function startAdmin({ port, tokenFile, getDb, runScheduled, deliverEmail, log }) {
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenFile, token, { mode: 0o600 }); try { chmodSync(tokenFile, 0o600); } catch { /* ignore */ }
  const server = createServer(async (req, res) => {
    const send = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));
    if (req.method !== 'POST' || req.url !== '/d1' || req.headers.authorization !== `Bearer ${token}`) return send(404, { error: 'not found' });
    let body = '';
    for await (const c of req) { body += c; if (body.length > 256 * 1024 * 1024) return send(413, { error: 'too large' }); }
    try {
      const { op, sql = '', tables = [] } = JSON.parse(body);
      if (op === 'scheduled') return send(200, await runScheduled());
      if (op === 'email') { const j = JSON.parse(body); return send(200, await deliverEmail(Buffer.from(j.raw, 'base64'), { from: j.from || '' })); }
      const db = await getDb();
      if (op === 'query') return send(200, [{ results: (await db.prepare(sql).all()).results, success: true }]);
      if (op === 'exec') {
        const stmts = splitSql(sql).filter(s => !/^PRAGMA\s+defer_foreign_keys/i.test(s));
        if (stmts.length) await db.batch(stmts.map(s => db.prepare(s)));
        return send(200, [{ results: [], success: true, meta: { statements: stmts.length } }]);
      }
      if (op === 'export') return send(200, { sql: await exportSql(db, tables) });
      return send(400, { error: 'unknown op' });
    } catch (e) { send(500, { error: String(e.message).slice(0, 2000) }); }
  });
  server.listen(port, '127.0.0.1', () => log.log(`admin (scripts) on 127.0.0.1:${port} inside the container`));
  server.on('error', e => log.warn(`admin port ${port}: ${e.code || e.message} (scripts via docker exec won't work)`));
  return server;
}
