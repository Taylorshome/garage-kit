#!/usr/bin/env node
// Demo data for local testing and screenshots: the made-up "Demo Sedan" (demo/demo-car.json) with a little service
// history, a symptom, and the fake research bundle in demo/research/. LOCAL D1 by default (wrangler dev).
//   node scripts/seed-demo.mjs            local D1 (run `npm run db:local` first)
//   node scripts/seed-demo.mjs --remote   your real garage (asks no questions; you can delete the car in the app)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, d1File, d1Query, flags, lit } from './lib.mjs';
import { carSql } from './add-car.mjs';

const opts = flags(process.argv.slice(2), ['remote']);
const local = !opts.remote;
const ID = 'car-demo';
if (d1Query(`SELECT id FROM cars WHERE id = '${ID}'`, { local }).length) { console.error('demo car already there; nothing to do (delete it in the app to re-seed)'); process.exit(0); }
const input = JSON.parse(readFileSync(join(ROOT, 'demo', 'demo-car.json'), 'utf8'));
const now = Math.floor(Date.now() / 1000), day = 86400;
const iso = d => new Date(Date.now() - d * day * 1000).toISOString().slice(0, 10);
const { sql } = carSql(input, { id: ID, now });
const svc = (id, daysAgo, miles, title, cost, shop) => `INSERT INTO services (id, car_id, date, mileage, title, details, cost_cents, shop, diy, created_by, created_at) VALUES (${[id, ID, iso(daysAgo), miles, title, 'Demo entry.', cost, shop, shop ? 0 : 1, 'Demo', now - daysAgo * day].map(lit).join(', ')});`;
sql.push(svc('svc-demo-1', 200, 93100, 'Oil & filter change', 4999, 'Demo Quick Lube'));
sql.push(svc('svc-demo-2', 420, 88900, 'Front brake pads', null, null));
sql.push(`INSERT INTO mileage_log (car_id, date, miles, source, created_at) VALUES ('${ID}', '${iso(200)}', 93100, 'service', ${now - 200 * day});`);
sql.push(`UPDATE schedule_items SET last_done_date = '${iso(200)}', last_done_miles = 93100 WHERE car_id = '${ID}' AND name = 'Oil & filter change';`);
sql.push(`INSERT INTO service_items (service_id, item_id) SELECT 'svc-demo-1', id FROM schedule_items WHERE car_id = '${ID}' AND name = 'Oil & filter change';`);
mkdirSync(join(ROOT, 'build'), { recursive: true });
const f = join(ROOT, 'build', 'seed-demo.sql');
writeFileSync(f, sql.join('\n') + '\n');
try { d1File(f, { local }); } finally { rmSync(f, { force: true }); }
console.error('demo car added; loading the demo research…');
execFileSync(process.execPath, [join(ROOT, 'scripts', 'load-research.mjs'), '--car', ID, '--dir', join(ROOT, 'demo', 'research'), '--schedule', '--todos', ...(local ? ['--local'] : [])], { stdio: 'inherit', cwd: ROOT });
console.error(`done (${local ? 'local' : 'remote'} D1)`);
