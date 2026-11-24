// Shared garage operations used by both the web API (api.js) and the MCP tools (mcp.js),
// so a change made from Claude is recorded exactly like one made in the app.
import { FAST_MODEL, aiOff } from './ai.js';
import { logAnswer, robustAnswer } from './answer.js';
import { carContext, systemPrompt } from './mechanic.js';
import { HttpError, date, int, newId, nowSec, sha256Hex, str, todayLocal } from './util.js';
import { queueJob } from './research-jobs.js';
import { logHours, logMileage } from './mileage.js';
import { typeOf } from './vehicle.js';

export const KINDS = { noise: 'Noise', smell: 'Smell', leak: 'Leak', warning_light: 'Warning light', handling: 'Drives / handles weird', no_start: "Won't start", other: 'Other' };
export const WHENS = { cold_start: 'Cold start', warm: 'Warmed up', idle: 'Idle', accelerating: 'Accelerating', braking: 'Braking', turning: 'Turning', highway: 'Highway', bumps: 'Over bumps', always: 'All the time' };
export const WHERES = { front: 'Front', back: 'Back', left: 'Left', right: 'Right', under_hood: 'Under the hood / engine', inside: 'Inside / cab' };
const PRIORITIES = ['high', 'medium', 'low'];

/** Accept keys or labels, single value or list; return known keys only. */
function pick(v, dict) {
  const list = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  const out = new Set();
  for (const x of list.slice(0, 12)) {
    const s = String(x).trim().toLowerCase();
    const key = Object.keys(dict).find(k => k === s || k.replace(/_/g, ' ') === s || dict[k].toLowerCase() === s || dict[k].toLowerCase().replace(/[^a-z]/g, '') === s.replace(/[^a-z]/g, ''));
    if (key) out.add(key);
  }
  return [...out];
}
const normText = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- cars ----------
// loose words -> vehicle type ("the truck", "the bike", "the side by side") or body style ("the coupe")
const ALIASES = { truck: 'truck', pickup: 'truck', minivan: 'van', van: 'van', sedan: 'car', car: 'car', suv: 'suv', crossover: 'suv',
  bike: 'motorcycle', motorcycle: 'motorcycle', motorbike: 'motorcycle', moto: 'motorcycle', cruiser: 'motorcycle', scooter: 'motorcycle',
  utv: 'utv', sxs: 'utv', rzr: 'utv', atv: 'atv', quad: 'atv', 'four wheeler': 'atv', 'side by side': 'utv' };
const BODY_ALIASES = { coupe: 'coupe', hatch: 'hatchback', hatchback: 'hatchback', wagon: 'wagon' };
const compact = s => normText(s).replace(/\s+/g, '');
/** Vehicle by id or nickname ("civic", "the truck", "the bike", "vstar", "the side by side"), case-insensitive and forgiving. */
export async function resolveCar(env, ref) {
  let s = normText(ref).replace(/^(the|my|our)\s+/, '').replace(/\bchevy\b/g, 'chevrolet');
  for (const [k, v] of [['side by side', 'utv'], ['four wheeler', 'atv'], ['sxs', 'utv']]) s = s.replace(k, v);
  if (!s) throw new HttpError(400, 'Which vehicle? Pass its nickname or model (or "the truck", "the bike").');
  const { results: cars } = await env.DB.prepare('SELECT * FROM cars WHERE archived = 0').all();
  const byId = cars.find(c => c.id === String(ref).trim());
  if (byId) return byId;
  const score = c => {
    const hay = normText(`${c.nickname} ${c.make} ${c.model} ${c.year} ${c.trim || ''}`);
    if (normText(c.nickname) === s) return 100;
    if (normText(c.model) === s) return 90;
    const hayC = compact(`${c.nickname} ${c.make} ${c.model}`);
    let sc = 0;
    for (const w of s.split(' ')) {
      if (!w) continue;
      if (hay.split(' ').includes(w)) sc += 10;
      else if (hay.includes(w)) sc += 5;
      else if (w.length >= 4 && hayC.includes(w)) sc += 7;    // "vstar" -> "V Star 650"
      if (ALIASES[w] && typeOf(c) === ALIASES[w]) sc += 8;
      else if (BODY_ALIASES[w] && c.body_type === BODY_ALIASES[w]) sc += 8;
    }
    if (sc === 0 && s.length >= 4 && hayC.includes(s.replace(/\s+/g, ''))) sc = 7;
    return sc;
  };
  const ranked = cars.map(c => [score(c), c]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]);
  if (!ranked.length || (ranked[1] && ranked[1][0] === ranked[0][0])) {
    throw new HttpError(400, `Couldn't tell which vehicle "${ref}" means. Vehicles: ${cars.map(c => `${c.nickname} (${c.year} ${c.make} ${c.model})`).join('; ')}`);
  }
  return ranked[0][1];
}

export async function setMileage(env, carId, miles, source = 'web') {
  const m = int(miles, { max: 2_000_000, name: 'Mileage' });
  if (m == null) throw new HttpError(400, 'Mileage is required');
  await env.DB.prepare('UPDATE cars SET mileage = ?1, mileage_updated_at = ?2, updated_at = ?3 WHERE id = ?4').bind(m, todayLocal(), nowSec(), carId).run();
  await logMileage(env, carId, m, source);
  return m;
}

/** Set the engine hours (UTVs / ATVs; any vehicle with an hour meter). Logged like mileage. */
export async function setHours(env, carId, hours, source = 'web') {
  const h = hoursNum(hours);
  if (h == null) throw new HttpError(400, 'Hours are required');
  await env.DB.prepare('UPDATE cars SET hours = ?1, hours_updated_at = ?2, updated_at = ?3 WHERE id = ?4').bind(h, todayLocal(), nowSec(), carId).run();
  await logHours(env, carId, h, source);
  return h;
}
/** Engine hours: a number 0-100,000 with one decimal ("145", "145.5 h"), or null when empty. */
export function hoursNum(v, name = 'Hours') {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[, ]|h(ou)?rs?$|h$/gi, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(400, `${name} must be a number between 0 and 100000`);
  return Math.round(n * 10) / 10;
}

// ---------- to-dos ----------
export async function createTodo(env, carId, b, reporter) {
  const priority = PRIORITIES.includes(b.priority) ? b.priority : 'medium';
  const id = newId();
  await env.DB.prepare('INSERT INTO todos (id, car_id, title, notes, priority, status, created_at, source, reporter, reporter_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(id, carId, str(b.title, 200, { required: true, name: 'Title' }), str(b.notes, 8000), priority, 'open', nowSec(), b.source || 'user', reporter || null, b.reporter_id || null).run();
  return id;
}

/** status / notes / title / priority; closing can log a history entry (body.history). */
export async function updateTodo(env, id, body, member, createService) {
  const t = await env.DB.prepare('SELECT * FROM todos WHERE id = ?1').bind(id).first();
  if (!t) throw new HttpError(404, 'To-do not found');
  const title = body.title !== undefined ? str(body.title, 200, { required: true, name: 'Title' }) : t.title;
  let notes = t.notes;
  if (body.notes !== undefined) notes = str(body.notes, 8000);
  if (body.append_notes) notes = `${t.notes ? t.notes + '\n\n' : ''}${str(body.append_notes, 4000)}`.slice(-8000);
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) throw new HttpError(400, 'Priority must be high, medium or low');
  const priority = body.priority ?? t.priority;
  let status = t.status, closedAt = t.closed_at, serviceId = t.service_id;
  if (body.status !== undefined) {
    if (!['open', 'closed'].includes(body.status)) throw new HttpError(400, 'Status must be open or closed');
    status = body.status; closedAt = status === 'closed' ? (t.closed_at || nowSec()) : null;
  }
  if (status === 'closed' && t.status === 'open' && body.history) serviceId = await createService(env, t.car_id, { title: t.title, details: t.notes, ...body.history }, member);
  await env.DB.prepare('UPDATE todos SET title=?1, notes=?2, priority=?3, status=?4, closed_at=?5, service_id=?6 WHERE id=?7')
    .bind(title, notes, priority, status, closedAt, serviceId, id).run();
  return { ok: true, id, status, service_id: serviceId };
}

// ---------- symptoms ----------
/**
 * Record a symptom as a to-do of type "symptom". Same car + same text (open, last 30 days) is not duplicated.
 * The AI "first things to check" note is generated in the background (ctx.waitUntil) and stored on the to-do.
 */
export async function createSymptom(env, ctx, car, input, reporter, reporterId = null) {
  const description = str(input.description, 4000, { required: true, name: "What's happening" });
  const kind = pick(input.kind, KINDS), when = pick(input.when, WHENS), where = pick(input.where, WHERES);
  const mileage = int(input.mileage, { max: 2_000_000, name: 'Mileage' });
  const hash = (await sha256Hex(`${car.id}|${normText(description)}`)).slice(0, 32);
  const dup = await env.DB.prepare("SELECT * FROM todos WHERE car_id = ?1 AND text_hash = ?2 AND status = 'open' AND created_at > ?3").bind(car.id, hash, nowSec() - 30 * 86400).first();
  if (dup) return { id: dup.id, duplicate: true, ai_status: dup.ai_status };
  const title = description.replace(/\s+/g, ' ').slice(0, 90) + (description.length > 90 ? '…' : '');
  const priority = kind.some(k => ['no_start', 'warning_light', 'smell', 'leak'].includes(k)) || /brake|smoke|fire|overheat|fuel smell|steer/i.test(description) ? 'high' : 'medium';
  const lines = [description];
  if (kind.length) lines.push(`Kind: ${kind.map(k => KINDS[k]).join(', ')}`);
  if (when.length) lines.push(`When: ${when.map(k => WHENS[k]).join(', ')}`);
  if (where.length) lines.push(`Where: ${where.map(k => WHERES[k]).join(', ')}`);
  const id = newId();
  await env.DB.prepare(`INSERT INTO todos (id, car_id, title, notes, priority, status, created_at, source, type, symptom, reporter, mileage, text_hash, ai_status, reporter_id)
    VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, 'symptom', 'symptom', ?7, ?8, ?9, ?10, ?11, ?12)`)
    .bind(id, car.id, title, lines.join('\n'), priority, nowSec(), JSON.stringify({ kind, when, where }), reporter || null, mileage, hash, aiOff(env) ? null : 'pending', reporterId).run();
  await env.DB.prepare('UPDATE todos SET ai_updated_at = ?1 WHERE id = ?2').bind(nowSec(), id).run();
  const research = await queueJob(env, id, reporter);   // deep web research: the background worker, or your Claude by hand
  if (mileage != null) await env.DB.prepare('UPDATE cars SET mileage = ?1, mileage_updated_at = ?2 WHERE id = ?3 AND (mileage IS NULL OR mileage < ?1)').bind(mileage, todayLocal(), car.id).run();
  if (aiOff(env)) return { id, duplicate: false, ai_status: null, priority, research: research.status };
  const job = aiFirstChecks(env, id).catch(e => console.error('first-checks failed', e.message));
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return { id, duplicate: false, ai_status: 'pending', priority, research: research.status };
}

export const FIRST_CHECKS_MAX_TOKENS = 8000;   // reasoning counts against this (see mechanic.js)
export const AI_STALE_SEC = 5 * 60;           // "pending" longer than this = the background job died (e.g. waitUntil cut off)

/**
 * The symptom's "first things to check" note, through robustAnswer (continue/retry/fallback + timeouts).
 * ok -> ai_status done; still cut off -> ai_status truncated with the partial note (UI: "cut off, tap to continue",
 * which calls this again with { continue: true }); failed -> ai_status error + ai_error, and any earlier good note is kept.
 */
export async function aiFirstChecks(env, todoId, { continue: cont = false } = {}) {
  const t = await env.DB.prepare('SELECT * FROM todos WHERE id = ?1').bind(todoId).first();
  if (!t) return;
  const partial = cont && t.ai_note && t.ai_status === 'truncated' ? t.ai_note : '';
  let result;
  try {
    const { text } = await carContext(env, t.car_id, { query: [{ text: t.title, weight: 1 }, { text: t.notes || '', weight: 0.6 }] });
    const ask = `New symptom just reported${t.reporter ? ` by ${t.reporter}` : ''}${t.mileage ? ` at ${t.mileage.toLocaleString('en-US')} miles` : ''}:
"""${t.notes}"""

Reply in under 250 words, markdown:
1. **First things to check, cheapest first**: a numbered list; each item = what to check, how (plain words), and rough cost.
2. **OK to drive?** one line (say plainly if it should not be driven).
3. **Tell me next**: the one or two details that would narrow it down.
Use the research findings and history above and cite them briefly; mark anything else as general knowledge. Don't invent part numbers or torque specs.`;
    result = await robustAnswer(env, [{ role: 'system', content: systemPrompt(text) }, { role: 'user', content: ask }], { maxTokens: FIRST_CHECKS_MAX_TOKENS, temperature: 0.3, partial, primary: FAST_MODEL });
  } catch (e) {
    result = { status: 'failed', outcome: 'failed', model: null, error: e.message, trace: [{ result: 'error', error: String(e.message).slice(0, 200) }] };
  }
  await logAnswer(env, 'first_checks', todoId, result);
  if (result.status === 'failed') {
    await env.DB.prepare("UPDATE todos SET ai_status = 'error', ai_error = ?1, ai_updated_at = ?2 WHERE id = ?3")
      .bind(`The mechanic couldn't answer just now (${String(result.error).slice(0, 200)}).`, nowSec(), todoId).run();
    throw new Error(result.error);
  }
  await env.DB.prepare('UPDATE todos SET ai_note = ?1, ai_status = ?2, ai_model = ?3, ai_error = NULL, ai_updated_at = ?4 WHERE id = ?5')
    .bind(result.text.slice(0, 8000), result.status === 'ok' ? 'done' : 'truncated', result.model, nowSec(), todoId).run();
}

/** Mark first-checks notes stuck in "pending" (the background job was cut off) as errors, so the UI offers "Try again". */
export async function expireStaleAi(env, { carId = null, todoId = null } = {}) {
  const cut = nowSec() - AI_STALE_SEC;
  const where = todoId ? 'id = ?2' : carId ? 'car_id = ?2' : '1 = 1';
  const sel = await env.DB.prepare(`SELECT id FROM todos WHERE ai_status = 'pending' AND COALESCE(ai_updated_at, created_at) < ?1 AND ${where}`).bind(cut, ...(todoId ? [todoId] : carId ? [carId] : [])).all();
  for (const { id } of sel.results) {
    const upd = await env.DB.prepare("UPDATE todos SET ai_status = 'error', ai_error = 'The mechanic took too long to answer.', ai_updated_at = ?1 WHERE id = ?2 AND ai_status = 'pending'").bind(nowSec(), id).run();
    if (upd.meta?.changes) await logAnswer(env, 'first_checks', id, { outcome: 'failed', model: null, trace: [{ result: 'stale', error: `pending > ${AI_STALE_SEC / 60} min` }] });
  }
  return sel.results.length;
}

// ---------- history ----------
export async function searchHistory(env, carId, query, limit = 20) {
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const like = query ? `%${String(query).slice(0, 80).replace(/[%_]/g, '')}%` : null;
  const { results } = await env.DB.prepare(`SELECT s.*, (SELECT group_concat(i.name, '; ') FROM service_items si JOIN schedule_items i ON i.id = si.item_id WHERE si.service_id = s.id) AS items
    FROM services s WHERE s.car_id = ?1 ${like ? 'AND (s.title LIKE ?2 OR s.details LIKE ?2 OR s.parts LIKE ?2 OR s.shop LIKE ?2)' : ''} ORDER BY s.date DESC, s.created_at DESC LIMIT ${n}`)
    .bind(...(like ? [carId, like] : [carId])).all();
  return results.map(s => ({ id: s.id, date: s.date, mileage: s.mileage, title: s.title, details: s.details, parts: s.parts, cost: s.cost_cents != null ? s.cost_cents / 100 : null, shop: s.diy ? 'DIY' : s.shop, schedule_items: s.items ? s.items.split('; ') : [], logged_by: s.created_by }));
}

/** Map schedule item names (or ids) to ids for a car: exact id, then case-insensitive contains either way. */
export async function itemIdsByName(env, carId, names) {
  if (!names) return { ids: [], missing: [], available: [] };
  const list = (Array.isArray(names) ? names : [names]).map(String).slice(0, 20);
  const { results: items } = await env.DB.prepare('SELECT id, name FROM schedule_items WHERE car_id = ?1').bind(carId).all();
  const out = new Set(), missing = [];
  for (const n of list) {
    const s = normText(n);
    const hit = items.find(i => i.id === n) || items.find(i => normText(i.name) === s) || items.find(i => normText(i.name).includes(s) || s.includes(normText(i.name)))
      || items.find(i => s.split(' ').filter(w => w.length > 3).every(w => normText(i.name).includes(w)));
    if (hit) out.add(hit.id); else missing.push(n);
  }
  return { ids: [...out], missing, available: items.map(i => i.name) };
}

export { date as validDate };
