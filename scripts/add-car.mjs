#!/usr/bin/env node
// Add a car (used by the add-car skill; the app's Settings -> Add a car does the same).
//   node scripts/add-car.mjs --file car.json [--local] [--dry-run]
// car.json:
//   { "car": { "nickname", "year", "make", "model", "trim", "engine", "transmission", "vin", "body_type", "color", "mileage", "notes" },
//     "starter_schedule": true,                       // generic intervals, marked "Typical interval, check your owner's manual"
//     "todos": [{ "title", "notes", "priority": "high|medium|low", "symptom": true }] }   // known problems in the owner's words
// Prints the new car id on stdout.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, d1File, d1Query, flags, lit } from './lib.mjs';

export const BODY_TYPES = ['sedan', 'coupe', 'hatchback', 'minivan', 'suv', 'pickup'];
export const STARTER = [
  ['Oil & filter change', 5000, 6], ['Tire rotation', 7500, 6], ['Engine air filter', 30000, 36], ['Cabin air filter', 15000, 12],
  ['Coolant flush', 100000, 60], ['Transmission fluid', 60000, 60], ['Spark plugs', 100000, null], ['Brake fluid flush', null, 36],
  ['Brake inspection', 12000, 12], ['Serpentine belt inspection', 30000, 24], ['Battery & terminals check', null, 12], ['Wiper blades', null, 12],
];

export function carSql(input, { now = Math.floor(Date.now() / 1000), today = new Date().toISOString().slice(0, 10), id = randomUUID(), sortOrder = 1 } = {}) {
  const c = input.car || input;
  const err = m => { throw new Error(m); };
  const nickname = String(c.nickname || '').trim() || err('car.nickname is required');
  const year = c.year == null || c.year === '' ? null : Number(c.year);
  if (year != null && !(year >= 1900 && year <= 2100)) err('car.year must be a year');
  const vin = c.vin ? String(c.vin).toUpperCase().trim() : null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) err('car.vin must be 17 letters/digits (no I, O or Q)');
  const body = c.body_type || 'sedan';
  if (!BODY_TYPES.includes(body)) err(`car.body_type must be one of ${BODY_TYPES.join(', ')}`);
  const color = (c.color || '#8a8f98').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) err('car.color must be #rrggbb');
  const miles = c.mileage == null || c.mileage === '' ? null : Math.round(Number(String(c.mileage).replace(/[, ]/g, '')));
  if (miles != null && !(miles >= 0 && miles < 2_000_000)) err('car.mileage must be a number');
  const s = (v, n) => v == null || v === '' ? null : String(v).trim().slice(0, n);
  const sql = [`INSERT INTO cars (id, nickname, year, make, model, trim, engine, transmission, vin, body_type, color, mileage, mileage_updated_at, notes, sort_order, created_at, updated_at) VALUES (${[
    id, nickname.slice(0, 60), year, s(c.make, 60), s(c.model, 60), s(c.trim, 80), s(c.engine, 120), s(c.transmission, 120), vin, body, color, miles, miles != null ? today : null, s(c.notes, 2000), sortOrder, now, now].map(lit).join(', ')});`];
  if (miles != null) sql.push(`INSERT INTO mileage_log (car_id, date, miles, source, created_at) VALUES (${lit(id)}, ${lit(today)}, ${miles}, 'web', ${now});`);
  if (input.starter_schedule !== false) STARTER.forEach(([name, mi, mo], i) => sql.push(`INSERT INTO schedule_items (id, car_id, name, interval_miles, interval_months, notes, sort_order, created_at, source) VALUES (${[randomUUID(), id, name, mi, mo, "Typical interval, check your owner's manual.", i + 1, now, 'starter'].map(lit).join(', ')});`));
  for (const t of input.todos || []) {
    const title = s(t.title, 200) || err('each todo needs a title');
    const pr = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
    sql.push(`INSERT INTO todos (id, car_id, title, notes, priority, status, created_at, source, type, reporter, mileage) VALUES (${[randomUUID(), id, title, s(t.notes, 8000), pr, 'open', now, t.symptom ? 'symptom' : 'user', t.symptom ? 'symptom' : null, 'add-car', t.symptom ? miles : null].map(lit).join(', ')});`);
  }
  return { id, sql };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = flags(process.argv.slice(2), ['file', 'local', 'dry-run']);
    if (!opts.file) throw new Error('--file car.json is required');
    const input = JSON.parse(readFileSync(resolve(opts.file), 'utf8'));
    const local = !!opts.local;
    const n = opts.dry_run ? 1 : Number(d1Query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM cars', { local })[0]?.n || 1);
    const { id, sql } = carSql(input, { sortOrder: n });
    if (opts.dry_run) { console.error(sql.join('\n')); console.error('DRY RUN: nothing written'); process.exit(0); }
    mkdirSync(join(ROOT, 'build'), { recursive: true });
    const f = join(ROOT, 'build', `add-car-${process.pid}.sql`);
    writeFileSync(f, sql.join('\n') + '\n');
    try { d1File(f, { local }); } finally { rmSync(f, { force: true }); }
    console.error(`added ${input.car?.nickname || input.nickname}${local ? ' (local D1)' : ''}`);
    console.log(id);
  } catch (e) { console.error(e.message); process.exit(1); }
}
