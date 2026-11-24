// Safety rails for the research loader (scripts/load-research.mjs). Every load first works out a PLAN by comparing
// what it would write with what is live in D1:
//   new        a row that doesn't exist yet                                  -> always allowed
//   update     an additive/derived change (e.g. filling an empty car field)  -> always allowed
//   overwrite  replaces live content that differs from the files              -> refused unless --force
//   delete     removes live rows                                             -> refused unless --force
//   drift      live D1 has entries the files don't (e.g. added with the save_research MCP tool or in the app) that
//              this load would throw away                                     -> refused unless --accept-drift (on top of --force)
// Before anything is written, the affected tables are exported to backups/d1/pre-<loader>-<UTC stamp>.sql (mode 600).
// Exit codes: 0 ok / dry run, 2 refused (destructive), 3 refused (drift), 4 backup failed.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const KEY_FIELDS = ['symptom', 'number', 'campaign', 'title', 'summary', 'item', 'name', 'part', 'fluid', 'topic', 'issue'];
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const sortKeys = v => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v;

export function entryKey(e) {
  if (e && typeof e === 'object' && !Array.isArray(e)) {
    for (const k of KEY_FIELDS) if (e[k] != null && String(e[k]).trim()) return `${k}:${norm(e[k])}`;
    return 'json:' + JSON.stringify(sortKeys(e));
  }
  return typeof e === 'string' ? norm(e) : 'json:' + JSON.stringify(sortKeys(e));
}
export function labelOf(e) {
  if (e && typeof e === 'object') for (const k of KEY_FIELDS) if (e[k]) return String(e[k]).slice(0, 80);
  return String(typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 80);
}

/** Entries in the live JSON that the planned JSON doesn't have (dicts recursed, lists by entry key). [[path, label]] */
export function listDrift(live, planned, path = '') {
  const out = [];
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(live) && isObj(planned)) {
    for (const [k, v] of Object.entries(live)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in planned)) {
        if (Array.isArray(v) && v.length) out.push(...v.map(e => [p, labelOf(e)]));
        else if (isObj(v) && Object.keys(v).length) out.push([p, `section "${k}"`]);
      } else out.push(...listDrift(v, planned[k], p));
    }
  } else if (Array.isArray(live) && Array.isArray(planned)) {
    const keys = new Set(planned.map(entryKey));
    out.push(...live.filter(e => !keys.has(entryKey(e))).map(e => [path, labelOf(e)]));
  }
  return out;
}

export function canon(v) {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v; } }
  return JSON.stringify(sortKeys(v));
}

export class Plan {
  constructor(loader) { this.loader = loader; this.items = []; }
  add(kind, table, what, detail = '') { this.items.push([kind, table, what, detail]); }
  compareJson(table, what, live, planned, { driftCheck = true } = {}) {
    if (live == null) return this.add('new', table, what);
    if (canon(live) === canon(planned)) return;
    if (driftCheck) {
      const lv = typeof live === 'string' ? JSON.parse(live) : live, pv = typeof planned === 'string' ? JSON.parse(planned) : planned;
      for (const [p, lab] of listDrift(lv, pv)) this.add('drift', table, what, `${p}: "${lab}" is in D1 but not in the files`);
    }
    this.add('overwrite', table, what, 'live content differs from the files');
  }
  compareText(table, what, live, planned) {
    if (live == null) return this.add('new', table, what);
    if ((live || '') !== (planned || '')) this.add('overwrite', table, what, `${(live || '').length} -> ${(planned || '').length} chars`);
  }
  count(kind) { return this.items.filter(i => i[0] === kind).length; }
  report(log = console.error) {
    log(`--- ${this.loader} plan ---`);
    if (!this.items.length) log('  nothing to change (D1 already matches the files)');
    for (const kind of ['drift', 'delete', 'overwrite', 'update', 'new']) {
      const rows = this.items.filter(i => i[0] === kind);
      if (!rows.length) continue;
      log(`  ${kind.toUpperCase()} (${rows.length}):`);
      for (const [, table, what, detail] of rows.slice(0, 40)) log(`    ${table} ${what}${detail ? ': ' + detail : ''}`);
      if (rows.length > 40) log(`    … ${rows.length - 40} more`);
    }
  }
  /** Returns { exit: code } to stop, or { write: true } when the loader may write (after the backup). */
  gate(opts, { hint = '', log = console.error } = {}) {
    this.report(log);
    const destructive = this.count('overwrite') + this.count('delete');
    if (opts.dry_run) {
      if (this.count('drift') && !opts.accept_drift) log('\nWould be REFUSED: drift (needs --accept-drift and --force).');
      else if (destructive && !opts.force) log(`\nWould be REFUSED: ${destructive} destructive step(s) (needs --force).`);
      log('\nDRY RUN: nothing written.');
      return { exit: 0 };
    }
    if (this.count('drift') && !opts.accept_drift) {
      log(`\nREFUSED: live D1 has ${this.count('drift')} entr${this.count('drift') === 1 ? 'y' : 'ies'} that the files do not (probably added with the save_research MCP tool or in the app). This load would throw them away.\nCopy them into the research files first (or check them), then re-run. To discard them anyway: --force --accept-drift.`);
      return { exit: 3 };
    }
    if (destructive && !opts.force) {
      log(`\nREFUSED: ${destructive} destructive step(s) (overwrite/delete of live rows). Re-run with --force to apply (the affected tables are exported to backups/d1/ first).${hint ? ' ' + hint : ''}`);
      return { exit: 2 };
    }
    if (!this.items.length) { log('nothing to do'); return { exit: 0 }; }
    return { write: true };
  }
}

/**
 * Export the given tables before a write. run(args) runs wrangler and throws on failure. Returns the file path,
 * or { exit: 4 } if the export failed or is incomplete. Local D1 (wrangler dev) is not backed up.
 */
export function backup({ tables, loader, remote, dbName, root, run, log = console.error }) {
  if (!remote) { log('local D1: no backup taken'); return { path: null }; }
  const dir = join(root, 'backups', 'd1');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const path = join(dir, `pre-${loader}-${stamp}.sql`);
  try { run(['d1', 'export', dbName, '--remote', '--output', path, ...tables.flatMap(t => ['--table', t])]); }
  catch (e) { log(`BACKUP FAILED, nothing written (${String(e.message).slice(-300)})`); return { exit: 4 }; }
  const ok = existsSync(path) && statSync(path).size > 0 && tables.every(t => new RegExp(`CREATE TABLE\\s+(IF NOT EXISTS\\s+)?[\`"']?${t}[\`"']?\\s*\\(`, 'i').test(readFileSync(path, 'utf8')));
  if (!ok) { log('BACKUP FAILED (export incomplete), nothing written'); return { exit: 4 }; }
  chmodSync(path, 0o600);
  log(`backup: ${path} (${statSync(path).size.toLocaleString()} bytes; tables ${tables.join(', ')})`);
  return { path };
}
