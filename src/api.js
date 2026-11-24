// JSON API (signed-in only; index.js enforces sign-in, Origin and Content-Type before we get here).
import { carSummary, itemStatus, sortByUrgency } from './due.js';
import { COLOR_RE, HttpError, date, email, int, json, money, newId, nowSec, str, todayLocal } from './util.js';
import { MAX_FILE, deleteFile, getBlob, getText, putFile, safeName } from './store.js';
import { applyScanToCar, processReport } from './email.js';
import { chatRoutes } from './mechanic.js';
import { aiFirstChecks, createSymptom, createTodo, expireStaleAi, hoursNum, setHours, setMileage, updateTodo } from './ops.js';
import { BODY_TYPES, VEHICLE_TYPES, attrsOf, bodyFor, clearNeeds, defaultSchedule, fluidsFor, needsInfo, partsSources, typeOf, usesHours } from './vehicle.js';
import { decodeVin, recallsFor } from './recalls.js';
import { jobsForCar, listQueued, queueJob, recentReports } from './research-jobs.js';
import { authMode } from './auth.js';
import { AI_OFF_MESSAGE, aiOff } from './ai.js';
import { integrations, notify } from './notify.js';
import { recentNotifications, subscribe, unsubscribe } from './push.js';
import { DISCLAIMER, ackStatus, acknowledge } from './disclaimer.js';
export { decodeVin };
import { addExtra, brandsForCar, removeExtra, shoppingList } from './shopping.js';
import { finishDiagnosis, listSessions, normalizePlan, plansForCar, recordResult, sessionView, skipStep, startDiagnosis } from './diagnosis.js';
import { catchupInfo, saveCatchup } from './catchup.js';
import { alternatesForCar } from './alternates.js';
import { logHours, logMileage } from './mileage.js';
import { confirmReceipt, createReceipt, discardReceipt, listPending, receiptView, reparseReceipt } from './receipts.js';
import { resolveCar } from './ops.js';

const PRIORITIES = ['high', 'medium', 'low'];

// ---------- loaders ----------
export async function loadCar(env, id) {
  const car = await env.DB.prepare('SELECT * FROM cars WHERE id = ?1 AND archived = 0').bind(id).first();
  if (!car) throw new HttpError(404, 'Car not found');
  return car;
}

/** Uploaded .glb link for the 3D viewer (car3d.js loads model_url when set). */
export const withModel = car => ({ ...car, model_url: car.model_key ? `/api/cars/${car.id}/model?v=${car.model_updated_at || 0}` : null });
/** The car row plus the derived vehicle facts the UI and MCP use (type, hours, needs-info placeholders, model link). */
export function withVehicle(car) {
  const attrs = attrsOf(car);
  return { ...withModel(car), vehicle_type: typeOf(car), attrs, uses_hours: usesHours(car), needs_info: needsInfo(car) };
}

export async function garageOverview(env, today = todayLocal()) {
  const [cars, items, todos] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM cars WHERE archived = 0 ORDER BY sort_order, created_at'),
    env.DB.prepare('SELECT * FROM schedule_items ORDER BY sort_order, name'),
    env.DB.prepare("SELECT * FROM todos WHERE status = 'open' ORDER BY created_at"),
  ]);
  return cars.results.map(car => {
    const s = carSummary(car, items.results.filter(i => i.car_id === car.id), todos.results.filter(t => t.car_id === car.id), today);
    return { ...withVehicle(car), summary: s, todos: todos.results.filter(t => t.car_id === car.id) };
  });
}

export async function carFull(env, id) {
  const car = await loadCar(env, id);
  await expireStaleAi(env, { carId: id });
  const today = todayLocal();
  const [items, services, links, todos, scans, codes, files] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM schedule_items WHERE car_id = ?1 ORDER BY sort_order, name').bind(id),
    env.DB.prepare('SELECT * FROM services WHERE car_id = ?1 ORDER BY date DESC, created_at DESC').bind(id),
    env.DB.prepare('SELECT si.* FROM service_items si JOIN services s ON s.id = si.service_id WHERE s.car_id = ?1').bind(id),
    env.DB.prepare("SELECT * FROM todos WHERE car_id = ?1 ORDER BY status = 'closed', CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC").bind(id),
    env.DB.prepare('SELECT * FROM scans WHERE car_id = ?1 ORDER BY received_at DESC').bind(id),
    env.DB.prepare('SELECT c.* FROM scan_codes c JOIN scans s ON s.id = c.scan_id WHERE s.car_id = ?1').bind(id),
    env.DB.prepare('SELECT id, service_id, scan_id, todo_id, receipt_id, diag_session_id, diag_step, filename, content_type, size, created_at FROM files WHERE car_id = ?1 ORDER BY created_at').bind(id),
  ]);
  const jobs = await jobsForCar(env, id);
  const pg = await env.DB.prepare('SELECT fluids FROM parts_guides WHERE car_id = ?1').bind(id).first();
  const photos = files.results.filter(f => !f.service_id && !f.scan_id && !f.todo_id && !f.receipt_id && !f.diag_session_id && f.content_type.startsWith('image/'));
  const diagnoses = await listSessions(env, { carId: id, includeTest: true, limit: 10 });
  const summary = carSummary(car, items.results, todos.results.filter(t => t.status === 'open'), today);
  const svc = services.results.map(s => ({
    ...s,
    item_ids: links.results.filter(l => l.service_id === s.id).map(l => l.item_id),
    files: files.results.filter(f => f.service_id === s.id),
  }));
  const itemList = sortByUrgency(summary.items.map(i => ({ ...i, history: svc.filter(s => s.item_ids.includes(i.id)).map(s => ({ id: s.id, date: s.date, mileage: s.mileage, title: s.title })) })));
  delete summary.items;
  return {
    car: withVehicle(car), summary, today, photos, fluids: fluidsFor(car, pg ? JSON.parse(pg.fluids) : []), diagnoses,
    parts_sources: partsSources(car),
    items: itemList,
    services: svc,
    todos: todos.results.map(t => ({ ...t, symptom: t.symptom ? JSON.parse(t.symptom) : null, files: files.results.filter(f => f.todo_id === t.id), research: jobs[t.id] || null })),
    scans: scans.results.map(s => ({ ...s, codes: codes.results.filter(c => c.scan_id === s.id), files: files.results.filter(f => f.scan_id === s.id) })),
  };
}

// ---------- write helpers ----------
function carFields(b, partial) {
  const f = {};
  const set = (k, v) => { if (!partial || b[k] !== undefined) f[k] = v; };
  set('nickname', str(b.nickname, 60, { required: !partial || b.nickname !== undefined, name: 'Name' }));
  set('year', int(b.year, { min: 1900, max: 2100, name: 'Year' }));
  set('make', str(b.make, 60));
  set('model', str(b.model, 60));
  set('trim', str(b.trim, 80));
  set('engine', str(b.engine, 120));
  set('transmission', str(b.transmission, 120));
  if (b.vin !== undefined || !partial) {
    const vin = str(b.vin, 17);
    if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) throw new HttpError(400, 'VIN must be 17 letters/digits (no I, O or Q)');
    f.vin = vin ? vin.toUpperCase() : null;
  }
  if (b.vehicle_type !== undefined || !partial) {
    const vt = b.vehicle_type || typeOf({ body_type: b.body_type });
    if (!VEHICLE_TYPES[vt]) throw new HttpError(400, `Vehicle type must be one of ${Object.keys(VEHICLE_TYPES).join(', ')}`);
    f.vehicle_type = vt;
  }
  if (b.body_type !== undefined || !partial) {
    const bt = b.body_type || (f.vehicle_type ? bodyFor(f.vehicle_type) : 'sedan');
    if (!BODY_TYPES.includes(bt)) throw new HttpError(400, `Body type must be one of ${BODY_TYPES.join(', ')}`);
    f.body_type = bt;
  }
  if (b.attrs !== undefined) {
    if (b.attrs !== null && (typeof b.attrs !== 'object' || Array.isArray(b.attrs))) throw new HttpError(400, 'attrs must be an object');
    const a = {}, ENUMS = { cooling: ['air', 'liquid', 'oil-air'], fuel_system: ['carbureted', 'efi'], clutch: ['wet', 'dry', 'cvt'], final_drive: ['chain', 'shaft', 'belt'] };
    for (const [k, vals] of Object.entries(ENUMS)) if (b.attrs?.[k] != null && b.attrs[k] !== '') { if (!vals.includes(b.attrs[k])) throw new HttpError(400, `${k} must be ${vals.join(' / ')}`); a[k] = b.attrs[k]; }
    if (b.attrs?.shared_sump != null) a.shared_sump = !!b.attrs.shared_sump;
    if (Array.isArray(b.attrs?.needs_info)) a.needs_info = b.attrs.needs_info.filter(x => ['vin', 'mileage', 'hours', 'color', 'variant'].includes(x));
    f.attrs = b.attrs === null ? null : JSON.stringify(a);
  }
  if (b.color !== undefined || !partial) {
    const c = b.color || '#8a8f98';
    if (!COLOR_RE.test(c)) throw new HttpError(400, 'Color must be #rrggbb');
    f.color = c.toLowerCase();
  }
  set('mileage', int(b.mileage, { max: 2_000_000, name: 'Mileage' }));
  if (b.hours !== undefined) f.hours = hoursNum(b.hours);
  set('notes', str(b.notes, 2000));
  return f;
}


async function updateItemFromHistory(env, itemId) {
  const latest = await env.DB.prepare(`SELECT s.date, s.mileage, s.hours FROM services s JOIN service_items si ON si.service_id = s.id
    WHERE si.item_id = ?1 ORDER BY s.date DESC, s.created_at DESC LIMIT 1`).bind(itemId).first();
  // a real logged service replaces any catch-up estimate (estimated miles/hours are dropped if the service has none)
  if (latest) await env.DB.prepare(`UPDATE schedule_items SET last_done_date = ?1,
      last_done_miles = CASE WHEN ?2 IS NOT NULL THEN ?2 WHEN last_done_estimated = 1 THEN NULL ELSE last_done_miles END,
      last_done_hours = CASE WHEN ?4 IS NOT NULL THEN ?4 WHEN last_done_estimated = 1 THEN NULL ELSE last_done_hours END,
      last_done_estimated = 0, due_now = 0 WHERE id = ?3`)
    .bind(latest.date, latest.mileage, itemId, latest.hours ?? null).run();
}

async function bumpMileage(env, carId, miles) {
  if (miles == null) return;
  const r = await env.DB.prepare('UPDATE cars SET mileage = ?1, mileage_updated_at = ?2, updated_at = ?3 WHERE id = ?4 AND (mileage IS NULL OR mileage < ?1)')
    .bind(miles, todayLocal(), nowSec(), carId).run();
  if (r.meta?.changes) await logMileage(env, carId, miles, 'service');
}
async function bumpHours(env, carId, hours) {
  if (hours == null) return;
  const r = await env.DB.prepare('UPDATE cars SET hours = ?1, hours_updated_at = ?2, updated_at = ?3 WHERE id = ?4 AND (hours IS NULL OR hours < ?1)')
    .bind(hours, todayLocal(), nowSec(), carId).run();
  if (r.meta?.changes) await logHours(env, carId, hours, 'service');
}

async function validItemIds(env, carId, ids) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 50) throw new HttpError(400, 'item_ids must be a list');
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(`SELECT id FROM schedule_items WHERE car_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(carId, ...ids.map(String)).all();
  return results.map(r => r.id);
}

export async function createService(env, carId, b, member) {
  const s = {
    id: newId(), date: date(b.date, { required: true }), mileage: int(b.mileage, { max: 2_000_000, name: 'Mileage' }),
    title: str(b.title, 160, { required: true, name: 'Title' }), details: str(b.details, 8000), parts: str(b.parts, 4000),
    cost_cents: money(b.cost), diy: b.diy ? 1 : 0, shop: b.diy ? null : str(b.shop, 120), hours: hoursNum(b.hours),
  };
  const items = await validItemIds(env, carId, b.item_ids);
  await env.DB.prepare(`INSERT INTO services (id, car_id, date, mileage, title, details, parts, cost_cents, shop, diy, created_by, created_at, hours)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
    .bind(s.id, carId, s.date, s.mileage, s.title, s.details, s.parts, s.cost_cents, s.shop, s.diy, member?.name || null, nowSec(), s.hours).run();
  for (const it of items) {
    await env.DB.prepare('INSERT OR IGNORE INTO service_items (service_id, item_id) VALUES (?1, ?2)').bind(s.id, it).run();
    await updateItemFromHistory(env, it);
  }
  await bumpMileage(env, carId, s.mileage);
  await bumpHours(env, carId, s.hours);
  return s.id;
}

// ---------- routes ----------
const routes = [];
const on = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern}$`), fn]);

/** Who am I + the app config the UI needs (no secrets). */
export function publicConfig(env, url) {
  const ints = [...integrations(env)];
  return {
    app_name: env.APP_NAME || 'Garage', auth_mode: authMode(env), origin: env.APP_ORIGIN || url.origin, timezone: env.TIMEZONE || 'UTC',
    integrations: ints, mail_address: ints.includes('email') ? env.MAIL_ADDRESS || null : null,
    vapid_public_key: ints.includes('push') ? env.VAPID_PUBLIC_KEY || null : null,
    disclaimer: DISCLAIMER, research_worker: ints.includes('research_worker'), glb_max_mb: glbMax(env) / 1048576, body_types: BODY_TYPES,
    ai: !aiOff(env), version: env.APP_VERSION || null, runtime: env.GARAGE_RUNTIME === 'docker' ? 'docker' : 'cloudflare',
  };
}
on('GET', '/api/me', async ({ env, url, member }) => ({ member, config: publicConfig(env, url), disclaimer: await ackStatus(env, member) }));
on('POST', '/api/disclaimer/ack', async ({ env, member }) => acknowledge(env, member));

// ---------- web push ----------
on('POST', '/api/push/subscribe', async ({ env, req, body, member }) => subscribe(env, member, body, req.headers.get('User-Agent') || ''));
on('POST', '/api/push/unsubscribe', async ({ env, body }) => unsubscribe(env, body));
on('POST', '/api/push/test', async ({ env, member }) => notify(env, { kind: 'test', title: `${env.APP_NAME || 'Garage'}: test notification`, body: `Sent by ${member.name}. Notifications work.`, url: '#/settings' }));
on('GET', '/api/notifications/recent', async ({ env }) => ({ notifications: await recentNotifications(env) }));
on('GET', '/api/notifications', async ({ env }) => ({ notifications: (await env.DB.prepare('SELECT id, at, kind, title, body, url FROM notifications ORDER BY id DESC LIMIT 30').all()).results }));

// ---------- your own 3D model per car (.glb in KV) ----------
const glbMax = env => Math.max(1, Math.min(24, Number(env.GLB_MAX_MB) || 15)) * 1048576;
on('PUT', '/api/cars/([\\w-]+)/model', async ({ env, m, req }) => uploadModel(env, m[1], req));
on('POST', '/api/cars/([\\w-]+)/model', async ({ env, m, req }) => uploadModel(env, m[1], req));
async function uploadModel(env, carId, req) {
  await loadCar(env, carId);
  const max = glbMax(env);
  if (Number(req.headers.get('Content-Length') || 0) > max) throw new HttpError(413, `The .glb is larger than ${max / 1048576} MB`);
  const data = await req.arrayBuffer();
  if (data.byteLength > max) throw new HttpError(413, `The .glb is larger than ${max / 1048576} MB`);
  const head = new Uint8Array(data, 0, Math.min(12, data.byteLength));
  if (data.byteLength < 20 || String.fromCharCode(...head.slice(0, 4)) !== 'glTF' || head[4] !== 2) throw new HttpError(415, 'That is not a binary glTF 2.0 (.glb) file');
  const key = `models/${carId}.glb`;
  await env.FILES.put(key, data, { metadata: { contentType: 'model/gltf-binary' } });
  await env.DB.prepare('UPDATE cars SET model_key = ?1, model_size = ?2, model_updated_at = ?3, updated_at = ?3 WHERE id = ?4').bind(key, data.byteLength, nowSec(), carId).run();
  return { ok: true, size: data.byteLength };
}
on('GET', '/api/cars/([\\w-]+)/model', async ({ env, m }) => {
  const car = await loadCar(env, m[1]);
  if (!car.model_key) throw new HttpError(404, 'No model uploaded for this car');
  const body = await env.FILES.get(car.model_key, 'stream');
  if (!body) throw new HttpError(404, 'Model file missing');
  return new Response(body, { headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'private, max-age=86400' } });
});
on('DELETE', '/api/cars/([\\w-]+)/model', async ({ env, m }) => {
  const car = await loadCar(env, m[1]);
  if (car.model_key) await env.FILES.delete(car.model_key);
  await env.DB.prepare('UPDATE cars SET model_key = NULL, model_size = NULL, model_updated_at = ?1 WHERE id = ?2').bind(nowSec(), car.id).run();
  return { ok: true };
});

// ---------- research requests waiting for a Claude (the background worker, or by hand) ----------
on('GET', '/api/research/queue', async ({ env }) => ({ queue: await listQueued(env) }));

on('GET', '/api/cars', async ({ env }) => ({ cars: await garageOverview(env), today: todayLocal() }));

/** New car (web form, MCP add_car). body.default_schedule adds the generic starter schedule. */
export async function createCar(env, body) {
  const f = carFields(body, false);
  return insertCar(env, f, { defaultSchedule: !!body.default_schedule, id: body.id });
}
/** Insert a vehicle row (+ the starter schedule for its type). Also used by tests and the fixture loader's API path. */
export async function insertCar(env, fIn, { defaultSchedule: withSchedule = false, id = null } = {}) {
  const f = new Proxy(fIn, { get: (o, k) => o[k] ?? null });   // D1 refuses undefined binds
  id = id && /^[a-z0-9-]{3,60}$/.test(id) ? id : newId();
  const now = nowSec();
  const { n } = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM cars').first();
  await env.DB.prepare(`INSERT INTO cars (id, nickname, year, make, model, trim, engine, transmission, vin, body_type, color, mileage, mileage_updated_at, notes, sort_order, created_at, updated_at, vehicle_type, hours, hours_updated_at, attrs)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18, ?19, ?20)`)
    .bind(id, f.nickname, f.year, f.make, f.model, f.trim, f.engine, f.transmission, f.vin, f.body_type || bodyFor(f.vehicle_type || 'car'), f.color || '#8a8f98', f.mileage, f.mileage != null ? todayLocal() : null, f.notes, n, now,
      f.vehicle_type || typeOf({ body_type: f.body_type }), f.hours ?? null, f.hours != null ? todayLocal() : null, f.attrs ?? null).run();
  if (f.mileage != null) await logMileage(env, id, f.mileage, 'web');
  if (f.hours != null) await logHours(env, id, f.hours, 'web');
  if (withSchedule) {
    const rows = defaultSchedule({ ...fIn, attrs: f.attrs });
    await env.DB.batch(rows.map((r, i) => env.DB.prepare(`INSERT INTO schedule_items (id, car_id, name, interval_miles, interval_months, interval_hours, notes, severe_note, sort_order, created_at, source)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'starter')`).bind(newId(), id, r.name, r.interval_miles, r.interval_months, r.interval_hours, r.notes, r.severe_note, i + 1, now)));
  }
  return id;
}
on('POST', '/api/cars', async ({ env, body }) => ({ id: await createCar(env, body) }));

// VIN decode (NHTSA vPIC: cars, trucks, motorcycles; off-road coverage is spotty, so the form falls back to manual entry)
on('GET', '/api/vin/([A-Za-z0-9*]{5,17})', async ({ m }) => decodeVin(m[1]));
// open recalls: NHTSA for road vehicles, CPSC for UTVs / ATVs (with the official search links as a fallback)
on('GET', '/api/cars/([\\w-]+)/recalls', async ({ env, m }) => recallsFor(await loadCar(env, m[1])));

/** MCP update_schedule_item: add an item, or change the one with the same name. Intervals in miles, hours and/or months. */
export async function upsertScheduleItem(env, car, a) {
  const name = str(a.name, 120, { required: true, name: 'name' });
  const mi = int(a.interval_miles, { max: 1_000_000, name: 'interval_miles' }), mo = int(a.interval_months, { max: 600, name: 'interval_months' });
  const hr = hoursNum(a.interval_hours, 'interval_hours');
  const source = ['manual', 'typical', 'user'].includes(a.source) ? a.source : 'user';
  const existing = await env.DB.prepare('SELECT * FROM schedule_items WHERE car_id = ?1 AND lower(name) = lower(?2) AND severe = ?3').bind(car.id, name, a.severe ? 1 : 0).first();
  if (existing) {
    await env.DB.prepare('UPDATE schedule_items SET interval_miles = COALESCE(?1, interval_miles), interval_months = COALESCE(?2, interval_months), notes = COALESCE(?3, notes), source = ?4, interval_hours = COALESCE(?6, interval_hours) WHERE id = ?5')
      .bind(mi, mo, str(a.notes, 2000), source, existing.id, hr).run();
    return { car: car.nickname, id: existing.id, updated: true };
  }
  const id = newId();
  const { n } = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM schedule_items WHERE car_id = ?1').bind(car.id).first();
  await env.DB.prepare('INSERT INTO schedule_items (id, car_id, name, interval_miles, interval_months, notes, sort_order, created_at, source, severe, interval_hours) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)')
    .bind(id, car.id, name, mi, mo, str(a.notes, 2000), n, nowSec(), source, a.severe ? 1 : 0, hr).run();
  return { car: car.nickname, id, added: true };
}

on('GET', '/api/cars/([\\w-]+)', async ({ env, m }) => carFull(env, m[1]));
on('GET', '/api/cars/([\\w-]+)/research', async ({ env, m }) => {
  await loadCar(env, m[1]);
  const r = await env.DB.prepare('SELECT data, md, updated_at FROM research WHERE car_id = ?1').bind(m[1]).first();
  return r ? { data: JSON.parse(r.data), md: r.md, updated_at: r.updated_at } : { data: null };
});

on('PATCH', '/api/cars/([\\w-]+)', async ({ env, m, body }) => {
  const car = await loadCar(env, m[1]);
  const f = carFields(body, true);
  // a vehicle-type change without a body type picks a matching body (and a body change implies its type)
  if (f.vehicle_type && !f.body_type) f.body_type = bodyFor(f.vehicle_type, car.body_type);
  else if (f.body_type && !f.vehicle_type && typeOf({ body_type: f.body_type }) !== typeOf(car)) f.vehicle_type = typeOf({ body_type: f.body_type });
  // filled-in placeholders stop showing as "needs info" (color counts only when it actually changes)
  if (f.attrs !== null && (f.attrs !== undefined || car.attrs)) {
    const base = f.attrs !== undefined ? JSON.parse(f.attrs) : attrsOf(car);
    if (f.attrs !== undefined && !Array.isArray(base.needs_info) && Array.isArray(attrsOf(car).needs_info)) base.needs_info = attrsOf(car).needs_info;
    const a = clearNeeds(base, { vin: f.vin, mileage: f.mileage, hours: f.hours, color: f.color && f.color !== car.color ? f.color : null, trim: f.trim && f.trim !== car.trim ? f.trim : null });
    if (f.attrs !== undefined || JSON.stringify(a) !== JSON.stringify(attrsOf(car))) f.attrs = JSON.stringify(a);
  }
  const keys = Object.keys(f);
  if (!keys.length) return { ok: true };
  if ('mileage' in f) { keys.push('mileage_updated_at'); f.mileage_updated_at = todayLocal(); }
  if ('hours' in f) { keys.push('hours_updated_at'); f.hours_updated_at = todayLocal(); }
  await env.DB.prepare(`UPDATE cars SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(', ')}, updated_at = ?${keys.length + 1} WHERE id = ?${keys.length + 2}`)
    .bind(...keys.map(k => f[k]), nowSec(), m[1]).run();
  if (f.mileage != null) await logMileage(env, m[1], f.mileage, 'web');
  if (f.hours != null) await logHours(env, m[1], f.hours, 'web');
  return { ok: true };
});

on('DELETE', '/api/cars/([\\w-]+)', async ({ env, m }) => {
  await loadCar(env, m[1]);
  await env.DB.prepare('UPDATE cars SET archived = 1, updated_at = ?1 WHERE id = ?2').bind(nowSec(), m[1]).run();
  return { ok: true, archived: true };
});

// catch-up: approximate last-done values for items with no history (schedule_items only, no history rows)
on('GET', '/api/cars/([\\w-]+)/catchup', async ({ env, m }) => catchupInfo(env, await loadCar(env, m[1])));
on('POST', '/api/cars/([\\w-]+)/catchup', async ({ env, m, body }) => saveCatchup(env, await loadCar(env, m[1]), body));

on('POST', '/api/cars/([\\w-]+)/mileage', async ({ env, m, body }) => {
  await loadCar(env, m[1]);
  return { ok: true, mileage: await setMileage(env, m[1], body.mileage) };
});
on('POST', '/api/cars/([\\w-]+)/hours', async ({ env, m, body }) => {
  await loadCar(env, m[1]);
  return { ok: true, hours: await setHours(env, m[1], body.hours) };
});

// schedule items
function itemFields(b, partial) {
  const f = {};
  const set = (k, v) => { if (!partial || b[k] !== undefined) f[k] = v; };
  set('name', str(b.name, 120, { required: !partial || b.name !== undefined, name: 'Name' }));
  set('interval_miles', int(b.interval_miles, { min: 1, max: 500_000, name: 'Interval miles' }));
  set('interval_months', int(b.interval_months, { min: 1, max: 240, name: 'Interval months' }));
  set('last_done_date', date(b.last_done_date, { name: 'Last done date' }));
  set('last_done_miles', int(b.last_done_miles, { max: 2_000_000, name: 'Last done miles' }));
  if (b.interval_hours !== undefined || !partial) { const h = hoursNum(b.interval_hours, 'Interval hours'); if (h != null && h < 1) throw new HttpError(400, 'Interval hours must be at least 1'); f.interval_hours = h; }
  if (b.last_done_hours !== undefined || !partial) f.last_done_hours = hoursNum(b.last_done_hours, 'Last done hours');
  set('notes', str(b.notes, 2000));
  if (b.due_now !== undefined) f.due_now = b.due_now ? 1 : 0;
  return f;
}
on('POST', '/api/cars/([\\w-]+)/items', async ({ env, m, body }) => {
  await loadCar(env, m[1]);
  const f = itemFields(body, false);
  if (!f.interval_miles && !f.interval_months && !f.interval_hours) throw new HttpError(400, 'Give an interval in miles, hours and/or months');
  const id = newId();
  const { n } = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM schedule_items WHERE car_id = ?1').bind(m[1]).first();
  await env.DB.prepare(`INSERT INTO schedule_items (id, car_id, name, interval_miles, interval_months, last_done_date, last_done_miles, due_now, notes, sort_order, created_at, interval_hours, last_done_hours)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
    .bind(id, m[1], f.name, f.interval_miles, f.interval_months, f.last_done_date, f.last_done_miles, f.due_now || 0, f.notes, n, nowSec(), f.interval_hours, f.last_done_hours).run();
  return { id };
});
on('PATCH', '/api/items/([\\w-]+)', async ({ env, m, body }) => {
  const it = await env.DB.prepare('SELECT * FROM schedule_items WHERE id = ?1').bind(m[1]).first();
  if (!it) throw new HttpError(404, 'Item not found');
  const f = itemFields(body, true);
  if ('last_done_date' in f || 'last_done_miles' in f || 'last_done_hours' in f) {
    if (f.due_now === undefined) f.due_now = 0;
    f.last_done_estimated = 0;   // set by hand: no longer a catch-up estimate
  }
  const keys = Object.keys(f);
  if (!keys.length) return { ok: true };
  await env.DB.prepare(`UPDATE schedule_items SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(', ')} WHERE id = ?${keys.length + 1}`)
    .bind(...keys.map(k => f[k]), m[1]).run();
  return { ok: true };
});
on('DELETE', '/api/items/([\\w-]+)', async ({ env, m }) => {
  await env.DB.prepare('DELETE FROM schedule_items WHERE id = ?1').bind(m[1]).run();
  return { ok: true };
});

// service history
on('POST', '/api/cars/([\\w-]+)/services', async ({ env, m, body, member }) => {
  await loadCar(env, m[1]);
  return { id: await createService(env, m[1], body, member) };
});
on('PATCH', '/api/services/([\\w-]+)', async ({ env, m, body }) => {
  const s = await env.DB.prepare('SELECT * FROM services WHERE id = ?1').bind(m[1]).first();
  if (!s) throw new HttpError(404, 'Service entry not found');
  const merged = { date: s.date, mileage: s.mileage, hours: s.hours, title: s.title, details: s.details, parts: s.parts, cost: s.cost_cents != null ? s.cost_cents / 100 : null, shop: s.shop, diy: s.diy, ...body };
  const f = {
    date: date(merged.date, { required: true }), mileage: int(merged.mileage, { max: 2_000_000, name: 'Mileage' }),
    title: str(merged.title, 160, { required: true, name: 'Title' }), details: str(merged.details, 8000), parts: str(merged.parts, 4000),
    cost_cents: money(merged.cost), diy: merged.diy ? 1 : 0, hours: hoursNum(merged.hours),
  };
  f.shop = f.diy ? null : str(merged.shop, 120);
  await env.DB.prepare('UPDATE services SET date=?1, mileage=?2, title=?3, details=?4, parts=?5, cost_cents=?6, diy=?7, shop=?8, hours=?10 WHERE id=?9')
    .bind(f.date, f.mileage, f.title, f.details, f.parts, f.cost_cents, f.diy, f.shop, m[1], f.hours).run();
  const before = (await env.DB.prepare('SELECT item_id FROM service_items WHERE service_id = ?1').bind(m[1]).all()).results.map(r => r.item_id);
  let after = before;
  if (body.item_ids !== undefined) {
    after = await validItemIds(env, s.car_id, body.item_ids);
    await env.DB.prepare('DELETE FROM service_items WHERE service_id = ?1').bind(m[1]).run();
    for (const it of after) await env.DB.prepare('INSERT INTO service_items (service_id, item_id) VALUES (?1, ?2)').bind(m[1], it).run();
  }
  for (const it of new Set([...before, ...after])) await updateItemFromHistory(env, it);
  await bumpMileage(env, s.car_id, f.mileage);
  await bumpHours(env, s.car_id, f.hours);
  return { ok: true };
});
on('DELETE', '/api/services/([\\w-]+)', async ({ env, m }) => {
  const items = (await env.DB.prepare('SELECT item_id FROM service_items WHERE service_id = ?1').bind(m[1]).all()).results;
  const files = (await env.DB.prepare('SELECT * FROM files WHERE service_id = ?1').bind(m[1]).all()).results;
  for (const f of files) await deleteFile(env, f);
  await env.DB.prepare('DELETE FROM services WHERE id = ?1').bind(m[1]).run();
  for (const r of items) await updateItemFromHistory(env, r.item_id);
  return { ok: true };
});

// files: receipts (raw body upload; the one write API that isn't JSON)
const UPLOAD_TYPES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/;
on('POST', '/api/services/([\\w-]+)/files', async ({ env, m, req }) => {
  const s = await env.DB.prepare('SELECT * FROM services WHERE id = ?1').bind(m[1]).first();
  if (!s) throw new HttpError(404, 'Service entry not found');
  const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.test(ct)) throw new HttpError(415, 'Upload a photo (JPEG/PNG/WebP/HEIC) or a PDF');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_FILE) throw new HttpError(413, 'File is larger than 20 MB');
  const data = await req.arrayBuffer();
  const name = safeName(decodeURIComponent(req.headers.get('X-Filename') || 'receipt'));
  const f = await putFile(env, { key: `receipts/${s.car_id}/${s.id}/${newId()}-${name}`, data, contentType: ct, filename: name, carId: s.car_id, serviceId: s.id });
  return { id: f.id };
});
// "my car" photos of the real vehicles
on('POST', '/api/cars/([\\w-]+)/photos', async ({ env, m, req }) => {
  await loadCar(env, m[1]);
  const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(ct)) throw new HttpError(415, 'Upload a photo (JPEG/PNG/WebP/HEIC)');
  if (Number(req.headers.get('Content-Length') || 0) > MAX_FILE) throw new HttpError(413, 'File is larger than 20 MB');
  const data = await req.arrayBuffer();
  const name = safeName(decodeURIComponent(req.headers.get('X-Filename') || 'photo.jpg'));
  const f = await putFile(env, { key: `photos/${m[1]}/${newId()}-${name}`, data, contentType: ct, filename: name, carId: m[1] });
  return { id: f.id };
});
on('GET', '/api/files/([\\w-]+)', async ({ env, m }) => {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?1').bind(m[1]).first();
  if (!f) throw new HttpError(404, 'File not found');
  const body = await getBlob(env, f.store, f.key);
  if (!body) throw new HttpError(404, 'File content missing');
  const inline = /^(image\/(jpeg|png|webp|gif)|application\/pdf|video\/(mp4|quicktime|webm))$/.test(f.content_type);
  return new Response(body, { headers: {
    'Content-Type': inline ? f.content_type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${f.filename.replace(/"/g, '')}"`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'private, max-age=3600',
  } });
});
on('DELETE', '/api/files/([\\w-]+)', async ({ env, m }) => {
  const f = await env.DB.prepare('SELECT * FROM files WHERE id = ?1').bind(m[1]).first();
  if (f) await deleteFile(env, f);
  return { ok: true };
});

// to-dos & symptoms
on('POST', '/api/cars/([\\w-]+)/todos', async ({ env, m, body, member }) => {
  await loadCar(env, m[1]);
  return { id: await createTodo(env, m[1], { ...body, reporter_id: member.id }, member.name) };
});
on('POST', '/api/cars/([\\w-]+)/symptoms', async ({ env, ctx, m, body, member }) => createSymptom(env, ctx, await loadCar(env, m[1]), body, member.name, member.id));
on('POST', '/api/todos/([\\w-]+)/research', async ({ env, m, member }) => queueJob(env, m[1], member.name));
on('GET', '/api/cars/([\\w-]+)/parts', async ({ env, m }) => {
  await loadCar(env, m[1]);
  const r = await env.DB.prepare('SELECT data, fluids, updated_at FROM parts_guides WHERE car_id = ?1').bind(m[1]).first();
  const brands = await brandsForCar(env, m[1]);
  return r ? { data: JSON.parse(r.data), fluids: JSON.parse(r.fluids), updated_at: r.updated_at, brands } : { data: null, fluids: [], brands };
});
on('GET', '/api/cars/([\\w-]+)/alternates', async ({ env, m }) => { await loadCar(env, m[1]); return alternatesForCar(env, m[1]); });
on('GET', '/api/cars/([\\w-]+)/shopping', async ({ env, m }) => shoppingList(env, await loadCar(env, m[1])));
on('POST', '/api/cars/([\\w-]+)/shopping/extras', async ({ env, m, body, member }) => addExtra(env, await loadCar(env, m[1]), body, member));
on('DELETE', '/api/shopping-extras/([\\w-]+)', async ({ env, m }) => removeExtra(env, m[1]));

// ---------- guided diagnosis (src/diagnosis.js; same functions as the MCP tools) ----------
on('GET', '/api/cars/([\\w-]+)/diagnoses', async ({ env, m }) => {
  const car = await loadCar(env, m[1]);
  const plans = await plansForCar(env, car);
  return { car: { id: car.id, nickname: car.nickname, year: car.year, make: car.make, model: car.model }, plans: plans.map(p => ({ id: p.id, title: p.title, symptom: p.symptom, source: p.source, steps: p.steps.length, todo_match: p.todo_match })), sessions: await listSessions(env, { carId: car.id, includeTest: true, limit: 30 }) };
});
on('POST', '/api/cars/([\\w-]+)/diagnoses', async ({ env, m, body, member }) => startDiagnosis(env, await loadCar(env, m[1]), { symptom: body.symptom, plan_id: body.plan_id, todo_id: body.todo_id, generate: !!body.generate, fresh: !!body.fresh }, member));
on('GET', '/api/diagnoses', async ({ env, url }) => ({ sessions: await listSessions(env, { status: url.searchParams.get('status') || null }) }));
on('GET', '/api/diagnoses/([\\w-]+)', async ({ env, m }) => diagFull(env, m[1]));
on('POST', '/api/diagnoses/([\\w-]+)/result', async ({ env, m, body, member }) => { const r = await recordResult(env, m[1], body, member); return { ...(await diagFull(env, m[1])), last_result: r.last_result }; });
on('POST', '/api/diagnoses/([\\w-]+)/skip', async ({ env, m, body, member }) => { const r = await skipStep(env, m[1], body, member); return { ...(await diagFull(env, m[1])), last_result: r.last_result }; });
on('POST', '/api/diagnoses/([\\w-]+)/finish', async ({ env, m, body, member }) => {
  const r = await finishDiagnosis(env, m[1], { status: body.status, conclusion: body.conclusion, create_fix_todo: !!body.create_fix_todo }, member, createService);
  return { ...(await diagFull(env, m[1])), fix_todo_proposal: r.fix_todo_proposal || null, todos_noted: r.todos_noted || [], history_entry: r.history_entry || null };
});
const DIAG_PHOTO = /^image\/(jpeg|png|webp|heic|heif)$/;
on('POST', '/api/diagnoses/([\\w-]+)/photos', async ({ env, m, req, url }) => {
  const s = await env.DB.prepare('SELECT id, car_id, plan FROM diag_sessions WHERE id = ?1').bind(m[1]).first();
  if (!s) throw new HttpError(404, 'Diagnosis not found');
  const step = String(url.searchParams.get('step') || '');
  if (!JSON.parse(s.plan).steps.some(x => x.id === step)) throw new HttpError(400, 'Unknown step');
  const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!DIAG_PHOTO.test(ct)) throw new HttpError(415, 'Upload a photo (JPEG/PNG/WebP/HEIC)');
  if (Number(req.headers.get('Content-Length') || 0) > MAX_FILE) throw new HttpError(413, 'File is larger than 20 MB');
  const data = await req.arrayBuffer();
  const name = safeName(decodeURIComponent(req.headers.get('X-Filename') || 'photo.jpg'));
  const f = await putFile(env, { key: `diagnosis/${s.car_id}/${s.id}/${step}/${newId()}-${name}`, data, contentType: ct, filename: name, carId: s.car_id });
  await env.DB.prepare('UPDATE files SET diag_session_id = ?1, diag_step = ?2 WHERE id = ?3').bind(s.id, step, f.id).run();
  return { id: f.id };
});
/** Session view + the plan's steps (for "change an answer") + photos, for the app's step screen. */
async function diagFull(env, id) {
  const v = await sessionView(env, id, { intro: true });
  const s = await env.DB.prepare('SELECT plan, todo_id FROM diag_sessions WHERE id = ?1').bind(id).first();
  const plan = JSON.parse(s.plan);
  const { results: photos } = await env.DB.prepare('SELECT id, diag_step, filename, content_type FROM files WHERE diag_session_id = ?1 ORDER BY created_at').bind(id).all();
  const { results: res } = await env.DB.prepare('SELECT step_id, result, notes, mileage FROM diag_results WHERE session_id = ?1').bind(id).all();
  delete v._text;
  return { ...v, todo_id: s.todo_id, steps: normalizePlan(plan).steps.map((x, i) => ({ id: x.id, number: i + 1, of: plan.steps.length, title: x.title, do: x.do, look_for: x.look_for, safety: x.safety, tools: x.tools, minutes: x.minutes ?? null, sources: x.sources, options: x.options.map(o => ({ key: o.key, label: o.label })) })), results: Object.fromEntries(res.map(r => [r.step_id, r])), photos };
}
on('GET', '/api/research/recent', async ({ env }) => ({ reports: await recentReports(env) }));
on('POST', '/api/research-jobs/([\\w-]+)/seen', async ({ env, m }) => {
  await env.DB.prepare('UPDATE research_jobs SET seen_at = COALESCE(seen_at, ?1) WHERE id = ?2').bind(nowSec(), m[1]).run();
  return { ok: true };
});
on('GET', '/api/todos/([\\w-]+)', async ({ env, m }) => {
  await expireStaleAi(env, { todoId: m[1] });
  const t = await env.DB.prepare('SELECT id, car_id, title, notes, type, ai_status, ai_note, ai_model, ai_error FROM todos WHERE id = ?1').bind(m[1]).first();
  if (!t) throw new HttpError(404, 'To-do not found');
  return t;
});
on('POST', '/api/todos/([\\w-]+)/ask', async ({ env, ctx, m, body }) => {
  // body.continue: finish a cut-off note ("tap to continue") instead of asking again from scratch
  const t = await env.DB.prepare('SELECT ai_status FROM todos WHERE id = ?1').bind(m[1]).first();
  if (!t) throw new HttpError(404, 'To-do not found');
  if (aiOff(env)) throw new HttpError(424, AI_OFF_MESSAGE);
  const cont = !!body?.continue && t.ai_status === 'truncated';
  await env.DB.prepare("UPDATE todos SET ai_status = 'pending', ai_updated_at = ?1 WHERE id = ?2").bind(nowSec(), m[1]).run();
  // aiFirstChecks reads the partial before it is overwritten; the status column is all that changed
  ctx.waitUntil(aiFirstChecks(env, m[1], { continue: cont }).catch(e => console.error('first-checks retry failed', e.message)));
  return { ok: true, ai_status: 'pending' };
});
const TODO_FILE_TYPES = /^(image\/(jpeg|png|webp|heic|heif|gif)|video\/(mp4|quicktime|webm))$/;
on('POST', '/api/todos/([\\w-]+)/files', async ({ env, m, req }) => {
  const t = await env.DB.prepare('SELECT * FROM todos WHERE id = ?1').bind(m[1]).first();
  if (!t) throw new HttpError(404, 'To-do not found');
  const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!TODO_FILE_TYPES.test(ct)) throw new HttpError(415, 'Upload a photo or a short video (MP4/MOV)');
  if (Number(req.headers.get('Content-Length') || 0) > MAX_FILE) throw new HttpError(413, 'File is larger than 20 MB (keep videos short)');
  const data = await req.arrayBuffer();
  const name = safeName(decodeURIComponent(req.headers.get('X-Filename') || 'symptom'));
  const f = await putFile(env, { key: `symptoms/${t.car_id}/${t.id}/${newId()}-${name}`, data, contentType: ct, filename: name, carId: t.car_id });
  await env.DB.prepare('UPDATE files SET todo_id = ?1 WHERE id = ?2').bind(t.id, f.id).run();
  return { id: f.id };
});
on('PATCH', '/api/todos/([\\w-]+)', async ({ env, m, body, member }) => updateTodo(env, m[1], body, member, createService));
on('DELETE', '/api/todos/([\\w-]+)', async ({ env, m }) => {
  await env.DB.prepare('DELETE FROM todos WHERE id = ?1').bind(m[1]).run();
  return { ok: true };
});

// scans
on('GET', '/api/scans', async ({ env, url }) => {
  const unmatched = url.searchParams.get('unmatched') === '1';
  const { results } = await env.DB.prepare(`SELECT * FROM scans ${unmatched ? 'WHERE car_id IS NULL' : ''} ORDER BY received_at DESC LIMIT 100`).all();
  const codes = results.length ? (await env.DB.prepare(`SELECT * FROM scan_codes WHERE scan_id IN (${results.map((_, i) => `?${i + 1}`).join(',')})`).bind(...results.map(r => r.id)).all()).results : [];
  const files = results.length ? (await env.DB.prepare(`SELECT id, scan_id, filename, content_type, size FROM files WHERE scan_id IN (${results.map((_, i) => `?${i + 1}`).join(',')})`).bind(...results.map(r => r.id)).all()).results : [];
  return { scans: results.map(s => ({ ...s, codes: codes.filter(c => c.scan_id === s.id), files: files.filter(f => f.scan_id === s.id) })) };
});
on('GET', '/api/scans/([\\w-]+)/text', async ({ env, m }) => {
  const s = await env.DB.prepare('SELECT text_key FROM scans WHERE id = ?1').bind(m[1]).first();
  if (!s) throw new HttpError(404, 'Scan not found');
  return { text: s.text_key ? ((await getText(env, s.text_key)) || '').slice(0, 60000) : '' };
});
on('POST', '/api/scans/([\\w-]+)/assign', async ({ env, m, body }) => {
  const s = await env.DB.prepare('SELECT * FROM scans WHERE id = ?1').bind(m[1]).first();
  if (!s) throw new HttpError(404, 'Scan not found');
  const car = await loadCar(env, String(body.car_id || ''));
  await env.DB.prepare("UPDATE scans SET car_id = ?1, match_how = 'assigned by hand' WHERE id = ?2").bind(car.id, s.id).run();
  await env.DB.prepare('UPDATE files SET car_id = ?1 WHERE scan_id = ?2').bind(car.id, s.id).run();
  const created = await applyScanToCar(env, { ...s, car_id: car.id }, car);
  if (body.save_vin && s.vin && !car.vin) await env.DB.prepare('UPDATE cars SET vin = ?1 WHERE id = ?2').bind(s.vin, car.id).run();
  return { ok: true, todos: created };
});
on('POST', '/api/scans/([\\w-]+)/save-vin', async ({ env, m }) => {
  const s = await env.DB.prepare('SELECT * FROM scans WHERE id = ?1').bind(m[1]).first();
  if (!s || !s.car_id || !s.vin) throw new HttpError(400, 'Scan has no VIN or no car');
  await env.DB.prepare('UPDATE cars SET vin = ?1, updated_at = ?2 WHERE id = ?3').bind(s.vin, nowSec(), s.car_id).run();
  return { ok: true };
});
on('DELETE', '/api/scans/([\\w-]+)', async ({ env, m }) => {
  const files = (await env.DB.prepare('SELECT * FROM files WHERE scan_id = ?1').bind(m[1]).all()).results;
  for (const f of files) await deleteFile(env, f);
  await env.DB.prepare('DELETE FROM scans WHERE id = ?1').bind(m[1]).run();
  return { ok: true };
});
// Upload a scan report by hand (same pipeline as email)
on('POST', '/api/cars/([\\w-]+)/scans', async ({ env, m, req, member }) => {
  const car = await loadCar(env, m[1]);
  const ct = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!/^(application\/pdf|text\/html|text\/plain)$/.test(ct)) throw new HttpError(415, 'Upload the report as a PDF (or HTML/text)');
  if (Number(req.headers.get('Content-Length') || 0) > MAX_FILE) throw new HttpError(413, 'File is larger than 20 MB');
  const data = await req.arrayBuffer();
  const name = safeName(decodeURIComponent(req.headers.get('X-Filename') || 'report.pdf'));
  const r = await processReport(env, { from: member.email, subject: `Uploaded by ${member.name}`, attachments: [{ filename: name, mimeType: ct, content: data }], text: '', html: '', forceCar: car });
  return r;
});

// receipts: snap / pick photos or a PDF -> pending receipt (AI draft) -> confirm card -> service
on('GET', '/api/receipts', async ({ env, url }) => ({ receipts: await listPending(env, { carId: url.searchParams.get('car') || null }) }));
on('POST', '/api/receipts', async ({ env, req, member }) => {
  // multipart/form-data: file (repeat for each page), car_id (optional). The one non-JSON write besides the raw uploads.
  const ct = (req.headers.get('Content-Type') || '').toLowerCase();
  if (!ct.startsWith('multipart/form-data')) throw new HttpError(415, 'Send the receipt as multipart/form-data');
  if (Number(req.headers.get('Content-Length') || 0) > 26 * 1024 * 1024) throw new HttpError(413, 'The receipt files add up to more than 25 MB');
  const form = await req.formData();
  const files = [];
  for (const f of form.getAll('file')) if (f && typeof f === 'object' && f.size) files.push({ name: f.name || 'receipt', mime: f.type || 'application/octet-stream', data: await f.arrayBuffer() });
  if (!files.length) throw new HttpError(400, 'Add a photo or PDF of the receipt');
  const carId = String(form.get('car_id') || '');
  const carRef = carId ? await loadCar(env, carId) : null;
  return createReceipt(env, { source: 'app', files, carRef, member: { id: member.id, name: member.name } });
});
on('GET', '/api/receipts/([\\w-]+)', async ({ env, m }) => receiptView(env, m[1]));
on('POST', '/api/receipts/([\\w-]+)/confirm', async ({ env, m, body, member }) =>
  confirmReceipt(env, m[1], { edits: body.edits || {}, close_todo_ids: body.close_todo_ids || [] }, { id: member.id, name: member.name }, { createService, resolveCar }));
on('POST', '/api/receipts/([\\w-]+)/discard', async ({ env, m }) => discardReceipt(env, m[1]));
on('POST', '/api/receipts/([\\w-]+)/reparse', async ({ env, m }) => reparseReceipt(env, m[1]));

// due list
export async function dueList(env, { all = false } = {}) {
  const today = todayLocal();
  const cars = await garageOverview(env, today);
  const items = [], todos = [];
  for (const c of cars) {
    const label = `${c.year ?? ''} ${c.make ?? ''} ${c.model ?? ''}`.trim();
    for (const i of c.summary.items) {
      if (!all && !['overdue', 'soon'].includes(i.status)) continue;
      items.push({ key: `${c.id}:${i.id}`, car_id: c.id, car: c.nickname, car_label: label, item_id: i.id, name: i.name, status: i.status, label: i.label,
        next_due_miles: i.next_due_miles, next_due_date: i.next_due_date, next_due_hours: i.next_due_hours, miles_left: i.miles_left, days_left: i.days_left, hours_left: i.hours_left, urgency: i.urgency });
    }
    for (const t of c.todos) todos.push({ key: `todo:${t.id}`, car_id: c.id, car: c.nickname, id: t.id, title: t.title, priority: t.priority, dtc_code: t.dtc_code, type: t.type || null, reporter: t.reporter || null, created_at: t.created_at });
  }
  sortByUrgency(items);
  const pr = { high: 0, medium: 1, low: 2 };
  todos.sort((a, b) => pr[a.priority] - pr[b.priority] || a.created_at - b.created_at);
  return {
    generated_at: new Date().toISOString(), today,
    counts: { overdue: items.filter(i => i.status === 'overdue').length, soon: items.filter(i => i.status === 'soon').length, open_todos: todos.length },
    items, todos,
    cars: cars.map(c => ({ id: c.id, nickname: c.nickname, vehicle_type: c.vehicle_type, mileage: c.mileage, hours: c.hours, uses_hours: c.uses_hours, health: c.summary.health })),
  };
}
on('GET', '/api/due', async ({ env, url }) => dueList(env, { all: url.searchParams.get('all') === '1' }));

// members & senders
on('GET', '/api/members', async ({ env }) => ({ members: (await env.DB.prepare("SELECT id, email, name, is_owner, sub IS NOT NULL AS linked, created_at FROM members WHERE id != 'm-household' ORDER BY created_at").all()).results }));
on('POST', '/api/members', async ({ env, body, member }) => {
  if (!member.is_owner) throw new HttpError(403, 'Only an owner can change the members list');
  const e = email(body.email);
  if (await env.DB.prepare('SELECT 1 FROM members WHERE email = ?1 COLLATE NOCASE').bind(e).first()) throw new HttpError(409, 'Already a member');
  await env.DB.prepare('INSERT INTO members (id, email, name, is_owner, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(newId(), e, str(body.name, 80), body.is_owner ? 1 : 0, nowSec()).run();
  return { ok: true };
});
on('DELETE', '/api/members/([\\w-]+)', async ({ env, m, member }) => {
  if (!member.is_owner) throw new HttpError(403, 'Only an owner can change the members list');
  if (m[1] === 'm-household') throw new HttpError(400, 'The built-in household member stays');
  if (m[1] === member.id) throw new HttpError(400, "You can't remove yourself");
  await env.DB.prepare('DELETE FROM members WHERE id = ?1 AND is_owner = 0').bind(m[1]).run();
  return { ok: true };
});
on('GET', '/api/senders', async ({ env }) => ({ senders: (await env.DB.prepare('SELECT * FROM senders ORDER BY created_at').all()).results, address: env.MAIL_ADDRESS }));
on('POST', '/api/senders', async ({ env, body, member }) => {
  if (!member.is_owner) throw new HttpError(403, 'Only an owner can change who may email the garage');
  const e = email(body.email);
  await env.DB.prepare('INSERT OR REPLACE INTO senders (email, note, created_at) VALUES (?1, ?2, ?3)').bind(e, str(body.note, 120), nowSec()).run();
  return { ok: true };
});
on('DELETE', '/api/senders/(.+)', async ({ env, m, member }) => {
  if (!member.is_owner) throw new HttpError(403, 'Only an owner can change who may email the garage');
  await env.DB.prepare('DELETE FROM senders WHERE email = ?1 COLLATE NOCASE').bind(decodeURIComponent(m[1])).run();
  return { ok: true };
});

// connected Claude apps (OAuth grants issued to MCP clients for this member)
on('GET', '/api/connections', async ({ env, member }) => {
  const h = env.OAUTH_PROVIDER;
  if (!h) return { grants: [] };
  const out = [];
  let cursor;
  do {
    const page = await h.listUserGrants(member.id, cursor ? { cursor } : {});
    for (const g of page.items) out.push({ id: g.id, client: g.metadata?.client || g.clientId, client_id: g.clientId, created_at: g.createdAt, scope: g.scope });
    cursor = page.cursor;
  } while (cursor && out.length < 200);
  return { grants: out };
});
on('DELETE', '/api/connections/([\\w-]+)', async ({ env, m, member }) => {
  // record the grant's nonce first: KV-held tokens can stay valid at other edges for ~60 s after revokeGrant
  const page = await env.OAUTH_PROVIDER.listUserGrants(member.id);
  const g = page.items.find(x => x.id === m[1]);
  if (g?.metadata?.nonce) await env.DB.prepare('INSERT OR IGNORE INTO revoked_grants (nonce, member_id, revoked_at) VALUES (?1, ?2, ?3)').bind(g.metadata.nonce, member.id, nowSec()).run();
  await env.OAUTH_PROVIDER.revokeGrant(m[1], member.id);
  return { ok: true };
});

for (const r of chatRoutes) routes.push(r);

export async function handleApi(req, env, ctx, url, member) {
  for (const [method, re, fn] of routes) {
    if (method !== req.method) continue;
    const m = url.pathname.match(re);
    if (!m) continue;
    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && (req.headers.get('Content-Type') || '').startsWith('application/json')) {
      try { body = await req.json(); } catch { throw new HttpError(400, 'Body is not valid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object');
    }
    const out = await fn({ req, env, ctx, url, m, body, member });
    return out instanceof Response ? out : json(out);
  }
  throw new HttpError(404, 'Not found');
}
