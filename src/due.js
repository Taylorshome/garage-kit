// Maintenance due computation. Pure functions; unit-tested in test/due.test.mjs.

const DAY = 86400000;
export const SOON_DAYS = 30;

export function addMonths(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
export const soonMiles = interval => Math.min(1500, Math.max(500, Math.round(interval * 0.1)));
/** "Due soon" window for an engine-hours interval: 10% of it, at least 2 h, at most 25 h. */
export const soonHours = interval => Math.min(25, Math.max(2, Math.round(interval * 0.1)));
const fmtH = h => `${Math.round(h * 10) / 10} h`;

/**
 * Status of one schedule item.
 * status: overdue | soon | ok | unknown
 *  - due_now (owner says it's due) => overdue, label "Due now"
 *  - no usable last-done => unknown ("unknown, set last done"), never "wildly overdue"
 */
export function itemStatus(item, carMileage, today, carHours = null) {
  const out = { status: 'unknown', next_due_miles: null, next_due_date: null, next_due_hours: null, miles_left: null, days_left: null, hours_left: null, label: 'Unknown, set last done', urgency: 0 };
  if (item.due_now) return { ...out, status: 'overdue', label: 'Due now', urgency: 1000 };
  const byMiles = item.interval_miles && item.last_done_miles != null;
  const byDate = item.interval_months && item.last_done_date;
  const byHours = item.interval_hours && item.last_done_hours != null;
  const t = item.last_done_estimated ? '~' : '';   // catch-up estimate: show approximate values with "~"
  if (t) out.estimated = true;
  if (!byMiles && !byDate && !byHours) {
    // e.g. a miles-only item whose catch-up answer gave a date but the car's miles/month isn't known yet
    if (item.last_done_date && item.interval_miles) out.label = `Last done ${t}${item.last_done_date}; miles unknown`;
    else if (item.last_done_date && item.interval_hours) out.label = `Last done ${t}${item.last_done_date}; hours unknown`;
    return out;
  }
  let fracLeft = Infinity, overdue = false, soon = false;
  if (byMiles) {
    out.next_due_miles = item.last_done_miles + item.interval_miles;
    if (carMileage != null) {
      out.miles_left = out.next_due_miles - carMileage;
      if (out.miles_left <= 0) overdue = true;
      else if (out.miles_left <= soonMiles(item.interval_miles)) soon = true;
      fracLeft = Math.min(fracLeft, out.miles_left / item.interval_miles);
    }
  }
  if (byHours) {
    out.next_due_hours = Math.round((Number(item.last_done_hours) + Number(item.interval_hours)) * 10) / 10;
    if (carHours != null && carHours !== '') {
      out.hours_left = Math.round((out.next_due_hours - Number(carHours)) * 10) / 10;
      if (out.hours_left <= 0) overdue = true;
      else if (out.hours_left <= soonHours(item.interval_hours)) soon = true;
      fracLeft = Math.min(fracLeft, out.hours_left / item.interval_hours);
    }
  }
  if (byDate) {
    out.next_due_date = addMonths(item.last_done_date, item.interval_months);
    out.days_left = daysBetween(today, out.next_due_date);
    if (out.days_left <= 0) overdue = true;
    else if (out.days_left <= SOON_DAYS) soon = true;
    fracLeft = Math.min(fracLeft, out.days_left / (item.interval_months * 30.44));
  }
  if (overdue) {
    out.status = 'overdue';
    const parts = [];
    if (out.miles_left != null && out.miles_left <= 0) parts.push(`${t}${(-out.miles_left).toLocaleString('en-US')} mi over`);
    if (out.hours_left != null && out.hours_left <= 0) parts.push(`${t}${fmtH(-out.hours_left)} over`);
    if (out.days_left != null && out.days_left <= 0) parts.push(`${t}${-out.days_left} days over`);
    out.label = 'Overdue' + (parts.length ? ` (${parts.join(', ')})` : '');
    out.urgency = 500 - fracLeft * 100;
  } else if (soon) {
    out.status = 'soon';
    const parts = [];
    if (out.miles_left != null) parts.push(`${t}${out.miles_left.toLocaleString('en-US')} mi`);
    if (out.hours_left != null) parts.push(`${t}${fmtH(out.hours_left)}`);
    if (out.days_left != null) parts.push(`${t}${out.days_left} days`);
    out.label = 'Due soon' + (parts.length ? ` (${parts.join(' or ')})` : '');
    out.urgency = 200 - fracLeft * 100;
  } else if (fracLeft === Infinity) {
    // has a miles/hours-based schedule but the vehicle has no reading yet
    out.status = 'unknown'; out.label = byHours && !byMiles ? 'Set the engine hours' : byHours ? 'Set the mileage / hours' : 'Set the mileage';
  } else {
    out.status = 'ok';
    const parts = [];
    if (out.next_due_miles != null) parts.push(`${t}${out.next_due_miles.toLocaleString('en-US')} mi`);
    if (out.next_due_hours != null) parts.push(`${t}${fmtH(out.next_due_hours)}`);
    if (out.next_due_date) parts.push(`${t}${out.next_due_date}`);
    out.label = 'OK, next ' + parts.join(' or ');
    out.urgency = 100 - fracLeft * 100;
  }
  return out;
}

const PRIORITY_COST = { high: 8, medium: 4, low: 2 };

/** Stats for the garage-select card. */
export function carSummary(car, items, openTodos, today) {
  const withStatus = items.map(i => ({ ...i, ...itemStatus(i, car.mileage, today, car.hours ?? null) }));
  const overdue = withStatus.filter(i => i.status === 'overdue');
  const soon = withStatus.filter(i => i.status === 'soon');
  const unknown = withStatus.filter(i => i.status === 'unknown');
  const known = withStatus.filter(i => i.status !== 'unknown').sort((a, b) => b.urgency - a.urgency);
  let health = 100 - overdue.length * 22 - soon.length * 7;
  for (const t of openTodos) health -= PRIORITY_COST[t.priority] ?? 4;
  health = Math.max(5, Math.min(100, Math.round(health)));
  return {
    health,
    overdue_count: overdue.length,
    soon_count: soon.length,
    unknown_count: unknown.length,
    // never done and not yet reviewed on the catch-up screen (drives the "catch up" banner)
    catchup_pending: items.filter(i => i.last_done_date == null && i.last_done_miles == null && i.last_done_hours == null && !i.catchup_answer).length,
    open_issues: openTodos.length,
    next_due: known[0] ? { id: known[0].id, name: known[0].name, status: known[0].status, label: known[0].label, next_due_miles: known[0].next_due_miles, next_due_hours: known[0].next_due_hours, next_due_date: known[0].next_due_date } : null,
    items: withStatus,
  };
}

export function sortByUrgency(list) {
  const rank = { overdue: 0, soon: 1, ok: 2, unknown: 3 };
  return list.sort((a, b) => (rank[a.status] - rank[b.status]) || (b.urgency - a.urgency));
}
