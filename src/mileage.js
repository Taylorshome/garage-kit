// Odometer readings: the mileage log, typical miles per month, and validation of typed mileage replies
// (the monthly mileage check). Pure functions are unit-tested in test/mileage.test.mjs.
import { daysBetween } from './due.js';
import { HttpError, nowSec, todayLocal } from './util.js';

export const MAX_JUMP = 5000;        // a reply more than this above the current reading is ignored
const MIN_SPAN_DAYS = 60;            // need readings at least this far apart to trust a miles/month figure
const DAYS_PER_MONTH = 30.44;

/**
 * Parse a typed mileage reply ("222450", "222,450", "222 450 mi") and check it against the current reading.
 * Never accepts a lower number, or one more than MAX_JUMP above the current reading. Same number = confirmed.
 */
export function parseMileageReply(text, current) {
  const raw = String(text ?? '').trim();
  const m = raw.replace(/[,\s]/g, '').match(/^(\d{1,7})(mi|miles)?$/i);
  if (!m) return { ok: false, reason: 'not a number' };
  const miles = Number(m[1]);
  if (miles > 2_000_000) return { ok: false, reason: 'too large' };
  if (current != null && miles < current) return { ok: false, reason: `lower than the current ${current.toLocaleString('en-US')} mi` };
  if (current != null && miles > current + MAX_JUMP) return { ok: false, reason: `more than ${MAX_JUMP.toLocaleString('en-US')} mi above the current ${current.toLocaleString('en-US')} mi` };
  return { ok: true, miles, unchanged: current != null && miles === current };
}

/**
 * Typical miles per month from dated odometer readings [{date, miles}], or null when the data can't support it:
 * fewer than two readings, readings less than 60 days apart, or no increase. Uses the earliest and latest reading.
 */
export function milesPerMonth(readings) {
  const v = perMonth(readings, 'miles');
  return v != null && v < 10000 ? Math.round(v) : null;
}
/** Typical engine hours per month from [{date, hours}] (same rules as milesPerMonth), one decimal; null when unknown. */
export function hoursPerMonth(readings) {
  const v = perMonth(readings, 'hours');
  return v != null && v < 500 ? Math.round(v * 10) / 10 : null;
}
function perMonth(readings, key) {
  const pts = (readings || []).filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && r[key] !== null && r[key] !== undefined && Number.isFinite(Number(r[key])))
    .map(r => ({ date: r.date, v: Number(r[key]) })).sort((a, b) => a.date.localeCompare(b.date) || a.v - b.v);
  if (pts.length < 2) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const days = daysBetween(first.date, last.date);
  if (days < MIN_SPAN_DAYS || last.v <= first.v) return null;
  const pm = (last.v - first.v) / (days / DAYS_PER_MONTH);
  return pm > 0 ? pm : null;
}

export const MAX_HOURS_JUMP = 300;   // an hours reply more than this above the current reading is ignored
/** Parse a typed engine-hours reply ("145", "145.5", "145 h", "145 hrs"); never lower, at most MAX_HOURS_JUMP above. */
export function parseHoursReply(text, current) {
  const raw = String(text ?? '').trim().toLowerCase();
  const m = raw.replace(/,/g, '').replace(/\s+/g, '').match(/^(\d{1,6}(?:\.\d)?)\d*(h|hr|hrs|hour|hours)?$/);
  if (!m) return { ok: false, reason: 'not a number' };
  const hours = Number(m[1]);
  const cur = current == null || current === '' ? null : Number(current);
  if (hours > 100000) return { ok: false, reason: 'too large' };
  if (cur != null && hours < cur) return { ok: false, reason: `lower than the current ${cur} h` };
  if (cur != null && hours > cur + MAX_HOURS_JUMP) return { ok: false, reason: `more than ${MAX_HOURS_JUMP} h above the current ${cur} h` };
  return { ok: true, hours, unchanged: cur != null && hours === cur };
}

/** All dated odometer readings for a car: mileage log, services, scans, symptom reports and the current reading. */
export async function readingsForCar(env, car) {
  const { results } = await env.DB.prepare(`SELECT date, miles FROM mileage_log WHERE car_id = ?1
    UNION ALL SELECT date, mileage FROM services WHERE car_id = ?1 AND mileage IS NOT NULL
    UNION ALL SELECT scan_date, mileage FROM scans WHERE car_id = ?1 AND mileage IS NOT NULL AND scan_date IS NOT NULL
    UNION ALL SELECT date(created_at, 'unixepoch'), mileage FROM todos WHERE car_id = ?1 AND mileage IS NOT NULL`).bind(car.id).all();
  const out = results.map(r => ({ date: r.date, miles: r.miles }));
  if (car.mileage != null && car.mileage_updated_at) out.push({ date: car.mileage_updated_at, miles: car.mileage });
  return out;
}

/** All dated engine-hour readings for a vehicle: hours log, services and the current reading. */
export async function hoursReadingsForCar(env, car) {
  const { results } = await env.DB.prepare(`SELECT date, hours FROM hours_log WHERE car_id = ?1
    UNION ALL SELECT date, hours FROM services WHERE car_id = ?1 AND hours IS NOT NULL`).bind(car.id).all();
  const out = results.map(r => ({ date: r.date, hours: r.hours }));
  if (car.hours != null && car.hours_updated_at) out.push({ date: car.hours_updated_at, hours: car.hours });
  return out;
}

export async function logHours(env, carId, hours, source) {
  if (hours == null) return;
  await env.DB.prepare('INSERT INTO hours_log (car_id, date, hours, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(carId, todayLocal(), hours, source || null, nowSec()).run();
}

export async function logMileage(env, carId, miles, source) {
  if (miles == null) return;
  await env.DB.prepare('INSERT INTO mileage_log (car_id, date, miles, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(carId, todayLocal(), miles, source || null, nowSec()).run();
}

/**
 * A typed mileage reply from the Home Assistant actionable notification (POST /api/ha/mileage, bearer HA_MILEAGE_TOKEN).
 * body: { car_id, reply, dry_run? }. Saves only valid replies (see parseMileageReply); dry_run never saves.
 */
export async function applyMileageReply(env, body) {
  const carId = String(body?.car_id || '');
  const car = carId && await env.DB.prepare('SELECT id, nickname, mileage, hours FROM cars WHERE id = ?1 AND archived = 0').bind(carId).first();
  if (!car) throw new HttpError(404, 'Car not found');
  if (body.kind === 'hours') return applyHoursReply(env, car, body);
  const v = parseMileageReply(body.reply, car.mileage);
  const base = { car_id: car.id, car: car.nickname, previous: car.mileage, dry_run: !!body.dry_run };
  if (!v.ok) return { ...base, ok: false, saved: false, reason: v.reason };
  if (body.dry_run) return { ...base, ok: true, saved: false, mileage: v.miles, note: 'dry run: valid, not saved' };
  // guard against a race with another update: only move forward
  const r = await env.DB.prepare('UPDATE cars SET mileage = ?1, mileage_updated_at = ?2, updated_at = ?3 WHERE id = ?4 AND (mileage IS NULL OR mileage <= ?1)')
    .bind(v.miles, todayLocal(), nowSec(), car.id).run();
  if (!r.meta?.changes) return { ...base, ok: false, saved: false, reason: 'the mileage changed meanwhile and is now higher' };
  await logMileage(env, car.id, v.miles, 'ha');
  return { ...base, ok: true, saved: true, mileage: v.miles, unchanged: v.unchanged };
}

/** The hours version of applyMileageReply (UTVs / ATVs get "Enter hours" in the monthly prompt). */
async function applyHoursReply(env, car, body) {
  const v = parseHoursReply(body.reply, car.hours);
  const base = { car_id: car.id, car: car.nickname, kind: 'hours', previous: car.hours, dry_run: !!body.dry_run };
  if (!v.ok) return { ...base, ok: false, saved: false, reason: v.reason };
  if (body.dry_run) return { ...base, ok: true, saved: false, hours: v.hours, note: 'dry run: valid, not saved' };
  const r = await env.DB.prepare('UPDATE cars SET hours = ?1, hours_updated_at = ?2, updated_at = ?3 WHERE id = ?4 AND (hours IS NULL OR hours <= ?1)')
    .bind(v.hours, todayLocal(), nowSec(), car.id).run();
  if (!r.meta?.changes) return { ...base, ok: false, saved: false, reason: 'the hours changed meanwhile and are now higher' };
  await logHours(env, car.id, v.hours, 'ha');
  return { ...base, ok: true, saved: true, hours: v.hours, unchanged: v.unchanged };
}
