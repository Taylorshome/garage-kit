// Hourly cron (wrangler.jsonc "triggers", added by scripts/configure.mjs when a notification integration is on).
// Every run: research queue sweep (stuck jobs requeued / failed -> announced once) and emailed-receipt notices.
// At NOTIFY_HOUR local time (default 8): the daily "what's due" reminder (each item at most once a week unless its
// status changes) and the Home Assistant due sensor. On the 1st of the month at that hour: the monthly mileage check
// (one notification per car, linking to its odometer box) - this replaces the HA actionable-notification version.
import { dueList } from './api.js';
import { absUrl, enabled, firstTime, haSetDueSensor, notify } from './notify.js';
import { announceFailures, sweepStale } from './research-jobs.js';
import { markNotified, unnotified } from './receipts.js';
import { TZ } from './util.js';

function localParts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, ym: `${p.year}-${p.month}`, day: Number(p.day), hour: Number(p.hour) };
}

/** Emailed receipts waiting to be checked: one notification each (once). Also called right after an email lands. */
export async function deliverReceiptNotices(env) {
  let n = 0;
  for (const r of await unnotified(env)) {
    if (!(await markNotified(env, r.id))) continue;
    await notify(env, { kind: 'receipt', title: r.title, body: r.message, url: r.url.replace(/^.*?(#\/)/, '#/') });
    n++;
  }
  return n;
}

export async function dueReminder(env) {
  const due = await dueList(env);
  if (enabled(env, 'home_assistant')) await haSetDueSensor(env, due).catch(e => console.warn('HA sensor failed', e.message));
  const fresh = [];
  for (const i of due.items.filter(i => i.status === 'overdue' || i.status === 'soon')) {
    if (await firstTime(env, `due:${i.item_id}:${i.status}`, 7 * 86400)) fresh.push(i);
  }
  if (!fresh.length) return 0;
  const overdue = fresh.filter(i => i.status === 'overdue').length;
  const lines = fresh.slice(0, 6).map(i => `${i.car}: ${i.name} (${i.label})`);
  if (fresh.length > 6) lines.push(`+${fresh.length - 6} more`);
  await notify(env, { kind: 'due', title: `${env.APP_NAME || 'Garage'}: ${fresh.length} maintenance item${fresh.length === 1 ? '' : 's'} ${overdue ? 'due' : 'coming up'}`, body: lines.join('\n'), url: '#/due' });
  return fresh.length;
}

export async function mileageCheck(env, ym) {
  const { results: cars } = await env.DB.prepare('SELECT id, nickname, mileage FROM cars WHERE archived = 0 ORDER BY sort_order').all();
  let n = 0;
  for (const c of cars) {
    if (!(await firstTime(env, `mileage:${ym}:${c.id}`, 20 * 86400))) continue;
    // Home Assistant: an actionable notification with a text box; an HA automation posts the reply to /api/ha/mileage
    // (docs/integrations.md#home-assistant). Other channels: tap -> the car's odometer box.
    const haData = env.HA_MILEAGE_TOKEN ? { actions: [{ action: `GARAGE_MI_${c.id}`, title: 'Enter mileage', behavior: 'textInput', textInputButtonTitle: 'Save', textInputPlaceholder: 'Odometer' }, { action: 'URI', title: 'Open in the app', uri: absUrl(env, `#/car/${c.id}/mileage`) }] } : null;
    await notify(env, { kind: 'mileage', title: `${env.APP_NAME || 'Garage'}: monthly mileage check (${c.nickname})`, body: `What's the ${c.nickname}'s odometer now? Last reading ${c.mileage != null ? c.mileage.toLocaleString('en-US') : 'unknown'}. Tap to update.`, url: `#/car/${c.id}/mileage`, haData });
    n++;
  }
  return n;
}

export async function runScheduled(env, when = new Date()) {
  const out = {};
  try { await sweepStale(env); out.failures = await announceFailures(env); } catch (e) { console.warn('research sweep failed', e.message); }
  try { out.receipts = await deliverReceiptNotices(env); } catch (e) { console.warn('receipt notices failed', e.message); }
  const notifying = ['push', 'home_assistant', 'email'].some(k => enabled(env, k));
  const t = localParts(when), hour = Number(env.NOTIFY_HOUR ?? 8);
  if (notifying && t.hour === hour) {
    out.due = await dueReminder(env);
    if (t.day === 1 && String(env.MILEAGE_CHECK ?? 'on') !== 'off') out.mileage = await mileageCheck(env, t.ym);
  }
  console.log(`scheduled ${t.ymd} ${t.hour}:00 ${TZ}: ${JSON.stringify(out)} (${absUrl(env, '')})`);
  return out;
}
