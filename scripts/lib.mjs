// Shared helpers for the kit's scripts: config files, wrangler, D1 queries, SQL literals.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'garage.config.json');
export const WRANGLER_PATH = join(ROOT, 'wrangler.jsonc');

// Strip line and block comments (outside strings) and trailing commas, then JSON.parse.
export function parseJsonc(text) {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function readConfig({ required = true } = {}) {
  if (!existsSync(CONFIG_PATH)) {
    if (required) throw new Error('garage.config.json not found. Copy garage.config.example.json or run the setup-garage skill.');
    return null;
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function readWrangler() {
  if (!existsSync(WRANGLER_PATH)) throw new Error('wrangler.jsonc not found. Run: npm run configure');
  return parseJsonc(readFileSync(WRANGLER_PATH, 'utf8'));
}
export const dbName = () => DOCKER ? 'garage' : readWrangler().d1_databases?.[0]?.database_name || 'garage';

// Docker: GARAGE_DOCKER=<container name> (on the host; runs `docker exec`), or "self" inside the container. The
// d1 commands the scripts use (execute --command / --file, export) then go to the container's database instead of
// wrangler; --local / --remote don't matter there.
export const DOCKER = process.env.GARAGE_DOCKER || '';
function dockerD1(args, input) {
  const op = args[1] === 'export' ? 'export' : args.includes('--command') ? 'query' : 'exec';
  const val = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const tables = args.flatMap((a, i) => (a === '--table' ? [args[i + 1]] : []));
  const sql = op === 'query' ? val('--command') : op === 'exec' ? readFileSync(val('--file'), 'utf8') : '';
  const cli = ['d1', op, ...(op === 'export' ? tables : [])];
  const [cmd, argv] = DOCKER === 'self' ? [process.execPath, [join(ROOT, 'docker', 'cli.mjs'), ...cli]] : ['docker', ['exec', '-i', DOCKER, 'garage', ...cli]];
  const r = spawnSync(cmd, argv, { input: sql ?? input ?? '', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`garage d1 ${op} (${DOCKER === 'self' ? 'this container' : `container ${DOCKER}`}) failed:\n${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  if (op === 'export') { writeFileSync(val('--output'), r.stdout, { mode: 0o600 }); return ''; }
  return r.stdout;
}

/** Run wrangler (from the repo's node_modules when present). Returns stdout; throws with stderr on failure. */
export function wrangler(args, { input, quiet = false } = {}) {
  if (DOCKER && args[0] === 'd1' && ['execute', 'export'].includes(args[1])) return dockerD1(args, input);
  if (DOCKER) throw new Error(`wrangler ${args.slice(0, 2).join(' ')} is not available with GARAGE_DOCKER (Docker install)`);
  const local = join(ROOT, 'node_modules', '.bin', 'wrangler');
  const [cmd, pre] = existsSync(local) ? [local, []] : ['npx', ['--yes', 'wrangler']];
  const r = spawnSync(cmd, [...pre, ...args], { cwd: ROOT, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(' ')} failed:\n${(r.stderr || r.stdout || '').trim().slice(-2000)}`);
  if (!quiet && r.stderr?.trim()) process.stderr.write('');
  return r.stdout;
}

/** SELECT against D1 (--local or --remote); returns rows. */
export function d1Query(sql, { local = false } = {}) {
  const out = wrangler(['d1', 'execute', dbName(), local ? '--local' : '--remote', '--json', '--command', sql]);
  const rows = JSON.parse(out)[0]?.results || [];
  return rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === 'null' ? null : v])));
}
export function d1File(path, { local = false } = {}) {
  return wrangler(['d1', 'execute', dbName(), local ? '--local' : '--remote', '--file', path, '--yes']);
}

export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v)) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * D1 caps one SQL statement at 100 KB. For a long text value, write it as `col = ''` first and append it in
 * 40,000-character pieces (the split happens before escaping, so a '' escape is never cut).
 */
export function appendChunks(table, col, where, text, size = 40000) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(`UPDATE ${table} SET ${col} = ${col} || ${lit(text.slice(i, i + size))} WHERE ${where};`);
  return out;
}

export function flags(argv, allowed) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (!allowed.includes(k)) throw new Error(`unknown option --${k}. Options: ${allowed.map(x => '--' + x).join(' ')}`);
    out[k.replace(/-/g, '_')] = v !== undefined ? v : (argv[i + 1] && !argv[i + 1].startsWith('--') && ['car', 'dir', 'file', 'symptom-report', 'todo', 'env'].includes(k) ? argv[++i] : true);
  }
  return out;
}
export { execFileSync };
