#!/usr/bin/env node
// Helper commands inside the container:  docker exec -it garage-kit garage <command>
//   backup                     SQL dump of the whole database to /data/backups/garage-<date>.sql (while running)
//   hash-password              prompt for a password (not echoed) and print a PASSWORD_HASH value
//   run-scheduled              run the hourly job now (research queue sweep, receipt notices; reminders at NOTIFY_HOUR)
//   email-in [--from a@b] < msg.eml   feed one message to email-in (same checks as IMAP; for testing the allowlist)
//   research-token             print the research worker's bearer token (for research-worker/worker.conf)
//   d1 query|exec|export ...   used by the kit's scripts (scripts/lib.mjs with GARAGE_DOCKER set); SQL on stdin
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from './config.mjs';

const DATA = process.env.DATA_DIR || '/data';
const ADMIN = `http://127.0.0.1:${process.env.ADMIN_PORT || 8788}/d1`;
const [cmd, ...args] = process.argv.slice(2);

async function stdinBuf() { const b = []; for await (const c of process.stdin) b.push(c); return Buffer.concat(b); }
const stdin = async () => (await stdinBuf()).toString('utf8');
async function admin(body) {
  const tokenFile = join(DATA, '.admin-token');
  if (!existsSync(tokenFile)) throw new Error('the garage server is not running in this container (no /data/.admin-token)');
  const r = await fetch(ADMIN, { method: 'POST', headers: { Authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `admin ${r.status}`);
  return j;
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY) return (await stdin()).replace(/\r?\n$/, '');
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  let s = '';
  return new Promise((resolve, reject) => {
    process.stdin.on('data', d => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); return resolve(s); }
        if (ch === '\u0003') { process.stdin.setRawMode(false); return reject(new Error('cancelled')); }
        if (ch === '\u007f') s = s.slice(0, -1); else s += ch;
      }
    });
  });
}

try {
  if (cmd === 'd1') {
    const [op, ...rest] = args;
    if (op === 'export') process.stdout.write((await admin({ op, tables: rest })).sql);
    else if (op === 'query' || op === 'exec') process.stdout.write(JSON.stringify(await admin({ op, sql: await stdin() })));
    else throw new Error('d1 query|exec|export');
  } else if (cmd === 'email-in') {
    const i = args.indexOf('--from');
    const raw = await stdinBuf();
    console.log(JSON.stringify(await admin({ op: 'email', raw: raw.toString('base64'), from: i >= 0 ? args[i + 1] : '' })));
  } else if (cmd === 'run-scheduled') {
    console.log(JSON.stringify(await admin({ op: 'scheduled' })));
  } else if (cmd === 'backup') {
    const dir = join(DATA, 'backups'); mkdirSync(dir, { recursive: true });
    const file = join(dir, `garage-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
    const { sql } = await admin({ op: 'export', tables: [] });
    writeFileSync(file, sql, { mode: 0o600 }); chmodSync(file, 0o600);
    console.log(`backup ${file} (${Buffer.byteLength(sql).toLocaleString()} bytes)`);
  } else if (cmd === 'hash-password') {
    const pw = await readHidden('New household password: ');
    if (pw.length < 8) throw new Error('use at least 8 characters');
    if (process.stdin.isTTY && (await readHidden('Again: ')) !== pw) throw new Error("the two didn't match");
    console.log(await hashPassword(pw));
  } else if (cmd === 'research-token') {
    const f = join(DATA, 'secrets.json');
    const t = process.env.RESEARCH_WORKER_TOKEN || (existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).RESEARCH_WORKER_TOKEN);
    if (!t) throw new Error('no research worker token yet: set RESEARCH_WORKER=on and restart');
    console.log(t);
  } else {
    console.error('usage: garage backup | run-scheduled | email-in | hash-password | research-token | d1 query|exec|export');
    process.exit(cmd ? 2 : 0);
  }
} catch (e) { console.error(`garage: ${e.message}`); process.exit(1); }
