#!/usr/bin/env node
// Demo data for local testing and screenshots. LOCAL D1 by default (wrangler dev).
//   - always: the made-up "Demo Sedan" (demo/demo-car.json) with a little service history, a symptom, and the fake
//     research bundle in demo/research/;
//   - --bike: a 2007 Yamaha V Star 650 cruiser (demo/bike/: real public research for the model, its schedule, a
//     wet-clutch JASO oil row, brand alternates and a hard-starting diagnosis plan; no VIN/mileage, so "needs info");
//   - --utv:  a side-by-side (demo/utv/) serviced by engine hours, with hours history; the CVT-belt and overheating
//     diagnosis plans are built in for every UTV.
//   node scripts/seed-demo.mjs [--bike] [--utv]     local D1 (run `npm run db:local` first)
//   node scripts/seed-demo.mjs --all                the sedan, the bike and the UTV
//   node scripts/seed-demo.mjs --remote ...         your real garage (asks no questions; you can delete them in the app)
// Each vehicle is added once; run it again with another flag to add the others.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, d1File, d1Query, flags, lit } from './lib.mjs';
import { carSql } from './add-car.mjs';

const opts = flags(process.argv.slice(2), ['remote', 'bike', 'utv', 'all']);
const local = !opts.remote;
const now = Math.floor(Date.now() / 1000), day = 86400;
const iso = d => new Date(Date.now() - d * day * 1000).toISOString().slice(0, 10);
const svc = (car, id, daysAgo, miles, title, cost, shop, hours = null) => `INSERT INTO services (id, car_id, date, mileage, title, details, cost_cents, shop, diy, created_by, created_at, hours) VALUES (${[id, car, iso(daysAgo), miles, title, 'Demo entry.', cost, shop, shop ? 0 : 1, 'Demo', now - daysAgo * day].map(lit).join(', ')}, ${hours ?? 'NULL'});`;
const exists = id => d1Query(`SELECT id FROM cars WHERE id = '${id}'`, { local }).length > 0;
const sortOrder = () => Number(d1Query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM cars', { local })[0]?.n || 1);

function run(sql, label) {
  mkdirSync(join(ROOT, 'build'), { recursive: true });
  const f = join(ROOT, 'build', `seed-demo-${process.pid}.sql`);
  writeFileSync(f, sql.join('\n') + '\n');
  try { d1File(f, { local }); } finally { rmSync(f, { force: true }); }
  console.error(`${label} added`);
}
function loadResearch(id, dir) {
  console.error('loading its research…');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'load-research.mjs'), '--car', id, '--dir', dir, '--schedule', '--todos', ...(local ? ['--local'] : [])], { stdio: 'inherit', cwd: ROOT });
}
const input = path => JSON.parse(readFileSync(join(ROOT, 'demo', ...path), 'utf8'));

// ---------------------------------------------------------------- the demo sedan
{
  const ID = 'car-demo';
  if (exists(ID)) console.error('demo sedan already there (delete it in the app to re-seed)');
  else {
    const { sql } = carSql(input(['demo-car.json']), { id: ID, now, sortOrder: sortOrder() });
    sql.push(svc(ID, 'svc-demo-1', 200, 93100, 'Oil & filter change', 4999, 'Demo Quick Lube'));
    sql.push(svc(ID, 'svc-demo-2', 420, 88900, 'Front brake pads', null, null));
    sql.push(`INSERT INTO mileage_log (car_id, date, miles, source, created_at) VALUES ('${ID}', '${iso(200)}', 93100, 'service', ${now - 200 * day});`);
    sql.push(`UPDATE schedule_items SET last_done_date = '${iso(200)}', last_done_miles = 93100 WHERE car_id = '${ID}' AND name = 'Oil & filter change';`);
    sql.push(`INSERT INTO service_items (service_id, item_id) SELECT 'svc-demo-1', id FROM schedule_items WHERE car_id = '${ID}' AND name = 'Oil & filter change';`);
    run(sql, 'demo sedan');
    loadResearch(ID, join(ROOT, 'demo', 'research'));
  }
}

// ---------------------------------------------------------------- --bike: 2007 Yamaha V Star 650
if (opts.bike || opts.all) {
  const ID = 'car-demo-bike';
  if (exists(ID)) console.error('demo bike already there');
  else {
    const { sql } = carSql(input(['bike', 'demo-car.json']), { id: ID, now, sortOrder: sortOrder() });
    run(sql, 'demo bike (V Star 650)');
    loadResearch(ID, join(ROOT, 'demo', 'bike', 'research'));
  }
}

// ---------------------------------------------------------------- --utv: side-by-side on engine hours
if (opts.utv || opts.all) {
  const ID = 'car-demo-utv';
  if (exists(ID)) console.error('demo UTV already there');
  else {
    const { sql } = carSql(input(['utv', 'demo-car.json']), { id: ID, now, sortOrder: sortOrder() });
    // history: oil at 100 h (next due 150 h; the UTV is at 142.5 h), a belt inspection at 120 h, older hour readings
    sql.push(svc(ID, 'svc-demo-utv-1', 150, 1420, 'Oil & filter change', 8999, 'Demo Powersports', 100));
    sql.push(svc(ID, 'svc-demo-utv-2', 60, 1650, 'CVT belt inspected and blown out', null, null, 120));
    for (const [d, h] of [[240, 80], [150, 100], [60, 120]]) sql.push(`INSERT INTO hours_log (car_id, date, hours, source, created_at) VALUES ('${ID}', '${iso(d)}', ${h}, 'service', ${now - d * day});`);
    sql.push(`INSERT INTO mileage_log (car_id, date, miles, source, created_at) VALUES ('${ID}', '${iso(150)}', 1420, 'service', ${now - 150 * day});`);
    const done = (sid, name, d, mi, h) => [
      `UPDATE schedule_items SET last_done_date = '${iso(d)}', last_done_miles = ${mi}, last_done_hours = ${h} WHERE car_id = '${ID}' AND name = ${lit(name)};`,
      `INSERT INTO service_items (service_id, item_id) SELECT '${sid}', id FROM schedule_items WHERE car_id = '${ID}' AND name = ${lit(name)};`];
    sql.push(...done('svc-demo-utv-1', 'Engine oil & filter', 150, 1420, 100));
    sql.push(...done('svc-demo-utv-1', 'Engine oil & filter (break-in, once)', 150, 1420, 100));
    sql.push(...done('svc-demo-utv-2', 'CVT drive belt inspect / clean', 60, 1650, 120));
    run(sql, 'demo UTV');
  }
}
console.error(`done (${local ? 'local' : 'remote'} D1)`);
