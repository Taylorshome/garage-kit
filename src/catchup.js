// Catch-up: turn "about when did you last do this?" answers into approximate last-done values on schedule_items.
// Never creates service-history rows. Pure date/miles math is unit-tested in test/catchup.test.mjs.
import { addMonths } from './due.js';
import { HttpError, int, nowSec, todayLocal } from './util.js';
import { hoursPerMonth, hoursReadingsForCar, milesPerMonth, readingsForCar } from './mileage.js';
import { hoursNum, setHours, setMileage } from './ops.js';
import { usesHours } from './vehicle.js';

// months: how long ago, conservatively (an estimate errs toward "longer ago", so things come due sooner, not later)
export const ANSWERS = {
  this_month: { label: 'This month', months: 0.5 },
  '3mo': { label: '~3 mo', months: 3 },
  '6mo': { label: '~6 mo', months: 6 },
  '1yr': { label: '~1 yr', months: 12 },
  '2yr': { label: '2+ yr', months: 24 },
  unknown: { label: "Don't remember" },
  never: { label: 'Never' },
};

/** today minus `months` (fractional months under 1 are counted in days), YYYY-MM-DD */
export function monthsAgo(today, months) {
  if (months >= 1 && Number.isInteger(months)) return addMonths(today, -months);
  const ms = Date.parse(today + 'T00:00:00Z') - Math.round(months * 30.44) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The schedule_items fields one answer sets.
 * - dated answers: last_done_date = today minus the interval; last_done_miles = current miles minus miles/month x months
 *   (rounded to 100) only when miles/month is known, else null. Marked estimated.
 * - unknown ("Don't remember"): nothing known; reviewed, so it stops nagging.
 * - never: nothing known, and it's due now.
 */
export function estimateFor(answer, { today, mileage = null, mpm = null, hours = null, hpm = null }) {
  const a = ANSWERS[answer];
  if (!a) throw new HttpError(400, `Unknown answer "${answer}"`);
  if (answer === 'unknown') return { last_done_date: null, last_done_miles: null, last_done_hours: null, last_done_estimated: 0, due_now: null };
  if (answer === 'never') return { last_done_date: null, last_done_miles: null, last_done_hours: null, last_done_estimated: 0, due_now: 1 };
  const miles = mpm && mileage != null ? Math.max(0, Math.round((mileage - mpm * a.months) / 100) * 100) : null;
  // hours: same idea, rounded to whole hours, only when hours/month is known
  const hrs = hpm && hours != null ? Math.max(0, Math.round(Number(hours) - hpm * a.months)) : null;
  return { last_done_date: monthsAgo(today, a.months), last_done_miles: miles, last_done_hours: hrs, last_done_estimated: 1, due_now: 0 };
}

/** Items with no real history: never set, or only estimated. `pending` = not reviewed yet (drives the banner). */
export const needsCatchup = i => (i.last_done_date == null && i.last_done_miles == null && i.last_done_hours == null) || !!i.last_done_estimated;
export const isPending = i => i.last_done_date == null && i.last_done_miles == null && i.last_done_hours == null && !i.catchup_answer;

export async function catchupInfo(env, car) {
  const { results: items } = await env.DB.prepare('SELECT * FROM schedule_items WHERE car_id = ?1 ORDER BY sort_order, name').bind(car.id).all();
  const mpm = milesPerMonth(await readingsForCar(env, car));
  const hpm = usesHours(car) ? hoursPerMonth(await hoursReadingsForCar(env, car)) : null;
  return {
    car: { id: car.id, nickname: car.nickname, year: car.year, make: car.make, model: car.model, mileage: car.mileage, mileage_updated_at: car.mileage_updated_at,
      hours: car.hours, hours_updated_at: car.hours_updated_at, uses_hours: usesHours(car) },
    miles_per_month: mpm, hours_per_month: hpm,
    answers: Object.entries(ANSWERS).map(([key, a]) => ({ key, label: a.label })),
    items: items.filter(needsCatchup).map(i => ({
      id: i.id, name: i.name, interval_miles: i.interval_miles, interval_months: i.interval_months, interval_hours: i.interval_hours, due_now: i.due_now,
      last_done_date: i.last_done_date, last_done_miles: i.last_done_miles, last_done_hours: i.last_done_hours, estimated: !!i.last_done_estimated,
      answer: i.catchup_answer, pending: isPending(i),
    })),
  };
}

/** body: { mileage?, answers: { <item id>: <answer key> } }. Items with real (logged) history are never touched. */
export async function saveCatchup(env, car, body) {
  const answers = body?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new HttpError(400, 'answers must be an object of item id -> answer');
  const ids = Object.keys(answers).slice(0, 100);
  for (const id of ids) if (!ANSWERS[answers[id]]) throw new HttpError(400, `Unknown answer "${answers[id]}"`);
  let mileage = car.mileage;
  const m = int(body.mileage, { max: 2_000_000, name: 'Mileage' });
  if (m != null && m !== car.mileage) { mileage = await setMileage(env, car.id, m, 'catchup'); car = { ...car, mileage, mileage_updated_at: todayLocal() }; }
  let hours = car.hours;
  const h = hoursNum(body.hours);
  if (h != null && h !== car.hours) { hours = await setHours(env, car.id, h, 'catchup'); car = { ...car, hours, hours_updated_at: todayLocal() }; }
  const today = todayLocal();
  const mpm = milesPerMonth(await readingsForCar(env, car));
  const hpm = usesHours(car) ? hoursPerMonth(await hoursReadingsForCar(env, car)) : null;
  const { results: items } = await env.DB.prepare('SELECT * FROM schedule_items WHERE car_id = ?1').bind(car.id).all();
  const byId = new Map(items.map(i => [i.id, i]));
  const now = nowSec(), stmts = [], skipped = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (!it || !needsCatchup(it)) { skipped.push(id); continue; }
    const e = estimateFor(answers[id], { today, mileage, mpm, hours, hpm });
    if (e.due_now == null && it.catchup_answer === 'never') e.due_now = 0;   // changed from "Never": drop the due-now it set
    stmts.push(env.DB.prepare(`UPDATE schedule_items SET last_done_date = ?1, last_done_miles = ?2, last_done_estimated = ?3,
      due_now = COALESCE(?4, due_now), catchup_answer = ?5, catchup_at = ?6, last_done_hours = ?9 WHERE id = ?7 AND car_id = ?8`)
      .bind(e.last_done_date, e.last_done_miles, e.last_done_estimated, e.due_now, answers[id], now, id, car.id, e.last_done_hours));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, updated: stmts.length, skipped, mileage, miles_per_month: mpm, miles_estimated: mpm != null, hours, hours_per_month: hpm, hours_estimated: hpm != null };
}
