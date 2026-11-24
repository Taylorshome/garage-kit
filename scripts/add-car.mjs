#!/usr/bin/env node
// Add a vehicle (used by the add-car skill; the app's Settings -> Add a vehicle does the same): a car, truck, van, SUV,
// motorcycle, side-by-side (UTV) or ATV.
//   node scripts/add-car.mjs --file car.json [--local] [--dry-run]
// car.json:
//   { "car": { "nickname", "year", "make", "model", "trim", "engine", "transmission", "vin", "vehicle_type", "body_type",
//              "color", "mileage", "hours", "attrs", "notes" },
//     "starter_schedule": true,                       // the typical schedule for the vehicle type, marked "check your owner's manual"
//     "todos": [{ "title", "notes", "priority": "high|medium|low", "symptom": true }] }   // known problems in the owner's words
//   vehicle_type: car | truck | van | suv | motorcycle | utv | atv (default: from body_type, else car)
//   body_type (3D model): sedan, coupe, hatchback, minivan, suv, pickup; bikes cruiser, sport, dualsport, scooter; utv; atv
//   hours: engine-hour meter (UTVs / ATVs). attrs (bikes / off-road; they pick the starter items):
//     { "final_drive": "chain|shaft|belt", "cooling": "air|oil-air|liquid", "fuel_system": "carbureted|efi", "clutch": "wet|dry|cvt",
//       "shared_sump": true, "needs_info": ["vin", "mileage", "hours", "color", "variant"] }
// Prints the new car id on stdout.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, d1File, d1Query, flags, lit } from './lib.mjs';
import { BODY_TYPES, VEHICLE_TYPES, bodyFor, defaultSchedule, typeOf } from '../src/vehicle.js';

export { BODY_TYPES };
/** The car starter schedule (12 items); other types: defaultSchedule() in src/vehicle.js. */
export const STARTER = defaultSchedule({ vehicle_type: 'car' });
const ATTR_ENUMS = { cooling: ['air', 'liquid', 'oil-air'], fuel_system: ['carbureted', 'efi'], clutch: ['wet', 'dry', 'cvt'], final_drive: ['chain', 'shaft', 'belt'] };
const num1 = v => v == null ? 'NULL' : String(Math.round(Number(v) * 10) / 10);   // engine hours keep one decimal

export function carSql(input, { now = Math.floor(Date.now() / 1000), today = new Date().toISOString().slice(0, 10), id = randomUUID(), sortOrder = 1 } = {}) {
  const c = input.car || input;
  const err = m => { throw new Error(m); };
  const nickname = String(c.nickname || '').trim() || err('car.nickname is required');
  const year = c.year == null || c.year === '' ? null : Number(c.year);
  if (year != null && !(year >= 1900 && year <= 2100)) err('car.year must be a year');
  const vin = c.vin ? String(c.vin).toUpperCase().trim() : null;
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) err('car.vin must be 17 letters/digits (no I, O or Q)');
  if (c.body_type && !BODY_TYPES.includes(c.body_type)) err(`car.body_type must be one of ${BODY_TYPES.join(', ')}`);
  const type = c.vehicle_type || typeOf({ body_type: c.body_type });
  if (!VEHICLE_TYPES[type]) err(`car.vehicle_type must be one of ${Object.keys(VEHICLE_TYPES).join(', ')}`);
  const body = c.body_type || bodyFor(type);   // the 3D model; a type's default when not given
  const color = (c.color || '#8a8f98').toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(color)) err('car.color must be #rrggbb');
  const miles = c.mileage == null || c.mileage === '' ? null : Math.round(Number(String(c.mileage).replace(/[, ]/g, '')));
  if (miles != null && !(miles >= 0 && miles < 2_000_000)) err('car.mileage must be a number');
  const hours = c.hours == null || c.hours === '' ? null : Number(String(c.hours).replace(/[, ]|h(ou)?rs?$|h$/gi, ''));
  if (hours != null && !(hours >= 0 && hours <= 100000)) err('car.hours must be a number of engine hours');
  let attrs = null;
  if (c.attrs != null) {
    if (typeof c.attrs !== 'object' || Array.isArray(c.attrs)) err('car.attrs must be an object');
    const a = {};
    for (const [k, vals] of Object.entries(ATTR_ENUMS)) if (c.attrs[k] != null && c.attrs[k] !== '') { if (!vals.includes(c.attrs[k])) err(`car.attrs.${k} must be ${vals.join(' / ')}`); a[k] = c.attrs[k]; }
    if (c.attrs.shared_sump != null) a.shared_sump = !!c.attrs.shared_sump;
    if (Array.isArray(c.attrs.needs_info)) a.needs_info = c.attrs.needs_info.filter(x => ['vin', 'mileage', 'hours', 'color', 'variant'].includes(x));
    attrs = JSON.stringify(a);
  }
  const s = (v, n) => v == null || v === '' ? null : String(v).trim().slice(0, n);
  const sql = [`INSERT INTO cars (id, nickname, year, make, model, trim, engine, transmission, vin, body_type, color, mileage, mileage_updated_at, notes, sort_order, created_at, updated_at, vehicle_type, hours, hours_updated_at, attrs) VALUES (${[
    id, nickname.slice(0, 60), year, s(c.make, 60), s(c.model, 60), s(c.trim, 80), s(c.engine, 120), s(c.transmission, 120), vin, body, color, miles, miles != null ? today : null, s(c.notes, 2000), sortOrder, now, now, type].map(lit).join(', ')}, ${num1(hours)}, ${lit(hours != null ? today : null)}, ${lit(attrs)});`];
  if (miles != null) sql.push(`INSERT INTO mileage_log (car_id, date, miles, source, created_at) VALUES (${lit(id)}, ${lit(today)}, ${miles}, 'web', ${now});`);
  if (hours != null) sql.push(`INSERT INTO hours_log (car_id, date, hours, source, created_at) VALUES (${lit(id)}, ${lit(today)}, ${num1(hours)}, 'web', ${now});`);
  if (input.starter_schedule !== false) {
    defaultSchedule({ vehicle_type: type, body_type: body, attrs }).forEach((r, i) => sql.push(`INSERT INTO schedule_items (id, car_id, name, interval_miles, interval_months, interval_hours, notes, severe_note, sort_order, created_at, source) VALUES (${[
      randomUUID(), id, r.name, r.interval_miles, r.interval_months].map(lit).join(', ')}, ${num1(r.interval_hours)}, ${[r.notes, r.severe_note, i + 1, now, 'starter'].map(lit).join(', ')});`));
  }
  for (const t of input.todos || []) {
    const title = s(t.title, 200) || err('each todo needs a title');
    const pr = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
    sql.push(`INSERT INTO todos (id, car_id, title, notes, priority, status, created_at, source, type, reporter, mileage) VALUES (${[randomUUID(), id, title, s(t.notes, 8000), pr, 'open', now, t.symptom ? 'symptom' : 'user', t.symptom ? 'symptom' : null, 'add-car', t.symptom ? miles : null].map(lit).join(', ')});`);
  }
  return { id, sql, vehicle_type: type, body_type: body };
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
