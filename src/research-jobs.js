// Deep-research job queue. Members queue jobs (auto for new symptoms, or "Research this"). They are fulfilled either
// by the optional background research worker (research-worker/, on your own always-on computer with your own Claude
// Code; it claims a job with the per-install bearer RESEARCH_WORKER_TOKEN and posts a report back), or by hand from
// Claude (MCP save_symptom_report, or the research-car skill). Reports are validated here: only the expected shape,
// only http(s) URLs, bounded sizes. When a report lands (or a job finally fails) the household is notified through
// whichever notification integration is enabled (src/notify.js).
import { carContext } from './mechanic.js';
import { JOB_RESEARCH_BUDGET } from './research-context.js';
import { HttpError, newId, nowSec } from './util.js';
import { notify } from './notify.js';

export const STALE_SEC = 20 * 60;   // running longer than this -> requeue (once) or fail
const STALE = STALE_SEC;
const MAX_ATTEMPTS = 2;         // first try + one retry

export async function queueJob(env, todoId, requestedBy) {
  const t = await env.DB.prepare('SELECT id, car_id FROM todos WHERE id = ?1').bind(todoId).first();
  if (!t) throw new HttpError(404, 'To-do not found');
  const active = await env.DB.prepare("SELECT * FROM research_jobs WHERE todo_id = ?1 AND status IN ('queued','running')").bind(todoId).first();
  if (active) return { id: active.id, status: active.status, duplicate: true };
  const id = newId();
  await env.DB.prepare('INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, requested_by, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)')
    .bind(id, t.id, t.car_id, 'queued', requestedBy || null, nowSec()).run();
  return { id, status: 'queued', duplicate: false };
}

export async function sweepStale(env) {
  const cut = nowSec() - STALE;
  await env.DB.batch([
    env.DB.prepare(`UPDATE research_jobs SET status = 'failed', finished_at = ?1, error = 'Timed out (worker stopped responding)' WHERE status = 'running' AND started_at < ?2 AND attempts >= ${MAX_ATTEMPTS}`).bind(nowSec(), cut),
    env.DB.prepare(`UPDATE research_jobs SET status = 'queued', error = 'Previous attempt timed out; retrying' WHERE status = 'running' AND started_at < ?1 AND attempts < ${MAX_ATTEMPTS}`).bind(cut),
  ]);
}

/** Claim the oldest queued job and return everything the worker needs to build its prompt. */
export async function claimNext(env) {
  await sweepStale(env);
  const job = await env.DB.prepare("SELECT j.* FROM research_jobs j JOIN cars c ON c.id = j.car_id WHERE j.status = 'queued' AND c.archived = 0 ORDER BY j.created_at LIMIT 1").first();
  if (!job) return null;
  const upd = await env.DB.prepare("UPDATE research_jobs SET status = 'running', started_at = ?1, attempts = attempts + 1 WHERE id = ?2 AND status = 'queued'").bind(nowSec(), job.id).run();
  if (!upd.meta?.changes) return null; // someone else claimed it
  const t = await env.DB.prepare('SELECT * FROM todos WHERE id = ?1').bind(job.todo_id).first();
  const car = await env.DB.prepare('SELECT * FROM cars WHERE id = ?1').bind(job.car_id).first();
  const sym = t.symptom ? JSON.parse(t.symptom) : null;
  // research chosen for this symptom (title counts most), sized so worker.py never has to cut the context
  const { text } = await carContext(env, job.car_id, { query: [{ text: t.title, weight: 1 }, { text: t.notes || '', weight: 0.6 }], budget: JOB_RESEARCH_BUDGET });
  return {
    job: { id: job.id, attempt: job.attempts + 1 },
    car: { id: car.id, nickname: car.nickname, year: car.year, make: car.make, model: car.model, trim: car.trim, engine: car.engine, transmission: car.transmission, vin: car.vin, mileage: car.mileage,
      vehicle_type: car.vehicle_type || 'car', hours: car.hours ?? null },
    todo: { id: t.id, type: t.type || 'todo', title: t.title, notes: t.notes, priority: t.priority, reporter: t.reporter, mileage: t.mileage, symptom: sym, created_at: t.created_at, quick_checks: t.ai_status === 'done' ? t.ai_note : null },
    context: text,
    url: `#/car/${car.id}/todo`,
  };
}

// ---------- report validation (mirrors research-worker/schema.json) ----------
const str = (v, max) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const url = v => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.toString().slice(0, 500) : null; } catch { return null; } };
const LIK = ['high', 'med', 'low'];
export function validateReport(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'report must be an object');
  const arr = (v, n) => Array.isArray(v) ? v.slice(0, n) : [];
  const summary = str(r.summary, 1500);
  if (!summary) throw new HttpError(400, 'report.summary is required');
  const sd = r.safe_to_drive || {};
  const verdict = String(sd.verdict || sd.answer || '').toLowerCase();
  if (!['yes', 'caution', 'no'].includes(verdict)) throw new HttpError(400, 'report.safe_to_drive.verdict must be yes/caution/no');
  const out = {
    summary,
    likely_causes: arr(r.likely_causes, 10).map(c => ({
      cause: str(c?.cause, 200), likelihood: LIK.includes(String(c?.likelihood).toLowerCase()) ? String(c.likelihood).toLowerCase() : 'med',
      why: str(c?.why, 600), how_to_check: str(c?.how_to_check, 600), fix: str(c?.fix, 400),
      diy_difficulty: Math.max(1, Math.min(5, Math.round(Number(c?.diy_difficulty) || 3))), cost_diy: str(c?.cost_diy, 80), cost_shop: str(c?.cost_shop, 80),
    })).filter(c => c.cause),
    check_order: arr(r.check_order, 15).map(s => str(typeof s === 'string' ? s : s?.step, 400)).filter(Boolean),
    safe_to_drive: { verdict, why: str(sd.why, 600) },
    parts: arr(r.parts, 12).map(p => ({ name: str(p?.name, 120), part_numbers: str(Array.isArray(p?.part_numbers) ? p.part_numbers.join(', ') : p?.part_numbers, 200), approx_price: str(p?.approx_price, 60), link: url(p?.link) })).filter(p => p.name),
    videos: arr(r.videos, 8).map(v => ({ title: str(v?.title, 200), channel: str(v?.channel, 80), url: url(v?.url) })).filter(v => v.title && v.url),
    sources: arr(r.sources, 25).map(s => ({ title: str(s?.title, 200) || 'source', url: url(s?.url) })).filter(s => s.url),
    questions_for_owner: arr(r.questions_for_owner, 10).map(q => str(q, 300)).filter(Boolean),
  };
  if (!out.likely_causes.length) throw new HttpError(400, 'report.likely_causes is empty');
  if (!out.sources.length) throw new HttpError(400, 'report.sources is empty (only real URLs)');
  return out;
}

export async function submitResult(env, id, body) {
  const job = await env.DB.prepare('SELECT * FROM research_jobs WHERE id = ?1').bind(id).first();
  if (!job) throw new HttpError(404, 'Job not found');
  if (job.status !== 'running') throw new HttpError(409, `Job is ${job.status}, not running`);
  const meta = body.meta && typeof body.meta === 'object' ? JSON.stringify(body.meta).slice(0, 2000) : null;
  if (body.ok) {
    let report;
    try { report = validateReport(body.report); }
    catch (e) { body = { ok: false, error: `Invalid report: ${e.message}` }; }
    if (report) {
      await env.DB.batch([
        env.DB.prepare("UPDATE research_jobs SET status = 'done', finished_at = ?1, result = ?2, error = NULL, meta = ?3 WHERE id = ?4").bind(nowSec(), JSON.stringify(report), meta, id),
        env.DB.prepare('UPDATE todos SET researched_at = ?1 WHERE id = ?2').bind(nowSec(), job.todo_id),
      ]);
      await announceDone(env, job, report);
      return { status: 'done' };
    }
  }
  const err = String(body.error || 'unknown error').slice(0, 500);
  const retry = job.attempts < MAX_ATTEMPTS;
  await env.DB.prepare('UPDATE research_jobs SET status = ?1, finished_at = ?2, error = ?3, meta = ?4 WHERE id = ?5')
    .bind(retry ? 'queued' : 'failed', retry ? null : nowSec(), err, meta, id).run();
  if (!retry) await announceFailures(env);
  return { status: retry ? 'queued' : 'failed', error: err };
}

/** "Garage: <car> symptom researched" through the enabled notification integration. */
async function announceDone(env, job, report) {
  const row = await env.DB.prepare('SELECT t.title, c.nickname FROM todos t JOIN cars c ON c.id = t.car_id WHERE t.id = ?1').bind(job.todo_id).first();
  const first = report.summary.split(/(?<=[.!?])\s/)[0];
  const verdict = { yes: 'OK to drive', caution: 'Drive with caution', no: "Don't drive it" }[report.safe_to_drive.verdict];
  await notify(env, { kind: 'research', title: `${env.APP_NAME || 'Garage'}: ${row?.nickname || 'car'} symptom researched`, body: `${first} ${verdict}.`, url: `#/car/${job.car_id}/todo` });
}

/** Tell the household once about each job that failed for good (also called by the hourly cron after the stale sweep). */
export async function announceFailures(env) {
  const list = await unnotifiedFailures(env);
  for (const f of list) {
    if (!(await markFailureNotified(env, f.id))) continue;      // someone else got it first
    await notify(env, { kind: 'research_failed', title: `${env.APP_NAME || 'Garage'}: research failed (${f.car})`, body: `Couldn't research "${String(f.title).slice(0, 60)}" after ${f.attempts || 2} tries: ${String(f.error || 'unknown error').slice(0, 140)}. Tap Research again on the to-do.`, url: f.url });
  }
  return list.length;
}

/**
 * Save a report written by hand (MCP save_symptom_report / research-car skill) for a to-do: completes its queued job,
 * or creates a finished one. Same validation as the worker's reports.
 */
export async function saveManualReport(env, todoId, rawReport, who) {
  const t = await env.DB.prepare('SELECT id, car_id FROM todos WHERE id = ?1').bind(todoId).first();
  if (!t) throw new HttpError(404, 'To-do not found');
  const report = validateReport(rawReport);
  const active = await env.DB.prepare("SELECT * FROM research_jobs WHERE todo_id = ?1 AND status IN ('queued','running') ORDER BY created_at DESC").bind(todoId).first();
  const id = active?.id || newId(), now = nowSec(), meta = JSON.stringify({ via: String(who || 'Claude').slice(0, 80) });
  await env.DB.batch([
    active
      ? env.DB.prepare("UPDATE research_jobs SET status = 'done', finished_at = ?1, result = ?2, error = NULL, meta = ?3, attempts = attempts + 1 WHERE id = ?4").bind(now, JSON.stringify(report), meta, id)
      : env.DB.prepare("INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, requested_by, created_at, started_at, finished_at, result, meta) VALUES (?1, ?2, ?3, 'done', 1, ?4, ?5, ?5, ?5, ?6, ?7)")
        .bind(id, t.id, t.car_id, String(who || '').slice(0, 80) || null, now, JSON.stringify(report), meta),
    env.DB.prepare('UPDATE todos SET researched_at = ?1 WHERE id = ?2').bind(now, t.id),
  ]);
  return { ok: true, job_id: id, todo_id: t.id, causes: report.likely_causes.length, sources: report.sources.length };
}

/** Queued requests (oldest first) for a person's Claude to pick up by hand. Does not claim them. */
export async function listQueued(env) {
  const { results } = await env.DB.prepare(`SELECT j.id, j.todo_id, j.car_id, j.status, j.created_at, j.requested_by, t.title, t.notes, c.nickname FROM research_jobs j
    JOIN todos t ON t.id = j.todo_id JOIN cars c ON c.id = j.car_id WHERE j.status IN ('queued','running') AND c.archived = 0 AND t.status = 'open' ORDER BY j.created_at LIMIT 20`).all();
  return results.map(r => ({ job_id: r.id, todo_id: r.todo_id, car: r.nickname, car_id: r.car_id, status: r.status, title: r.title, details: r.notes, requested_by: r.requested_by, queued_at: new Date(r.created_at * 1000).toISOString() }));
}

// ---------- failure notifications (sent once per failed job) ----------
export async function unnotifiedFailureCount(env) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM research_jobs WHERE status = 'failed' AND failure_notified_at IS NULL").first()).n;
}
export async function unnotifiedFailures(env) {
  await sweepStale(env);
  const { results } = await env.DB.prepare(`SELECT j.id, j.car_id, j.attempts, j.error, j.finished_at, t.title, c.nickname FROM research_jobs j
    JOIN todos t ON t.id = j.todo_id JOIN cars c ON c.id = j.car_id WHERE j.status = 'failed' AND j.failure_notified_at IS NULL ORDER BY j.finished_at LIMIT 10`).all();
  return results.map(r => ({ id: r.id, car: r.nickname, title: r.title, attempts: r.attempts, error: r.error, finished_at: r.finished_at, url: `#/car/${r.car_id}/todo` }));
}
/** Mark a failure as told; returns false if it was already marked (so a second worker run never notifies twice). */
export async function markFailureNotified(env, id) {
  const r = await env.DB.prepare("UPDATE research_jobs SET failure_notified_at = ?1 WHERE id = ?2 AND status = 'failed' AND failure_notified_at IS NULL").bind(nowSec(), id).run();
  return !!r.meta?.changes;
}

/** Latest job per to-do for a car (for the UI / AI / MCP). */
export async function jobsForCar(env, carId) {
  const { results } = await env.DB.prepare(`SELECT j.* FROM research_jobs j WHERE j.car_id = ?1 AND j.created_at = (SELECT MAX(created_at) FROM research_jobs WHERE todo_id = j.todo_id)`).bind(carId).all();
  const map = {};
  for (const j of results) map[j.todo_id] = { id: j.id, status: j.status, attempts: j.attempts, created_at: j.created_at, finished_at: j.finished_at, error: j.error, seen_at: j.seen_at, report: j.result ? JSON.parse(j.result) : null };
  return map;
}

/** Done reports from the last 14 days, newest first (garage home "New research"). */
export async function recentReports(env) {
  const { results } = await env.DB.prepare(`SELECT j.id, j.todo_id, j.car_id, j.finished_at, j.seen_at, j.result, t.title, c.nickname FROM research_jobs j
    JOIN todos t ON t.id = j.todo_id JOIN cars c ON c.id = j.car_id WHERE j.status = 'done' AND c.archived = 0 AND j.finished_at > ?1 ORDER BY j.finished_at DESC LIMIT 10`).bind(nowSec() - 14 * 86400).all();
  return results.map(r => { const rep = JSON.parse(r.result); return { id: r.id, todo_id: r.todo_id, car_id: r.car_id, car: r.nickname, title: r.title, finished_at: r.finished_at, unseen: !r.seen_at, summary: rep.summary.split(/(?<=\.)\s/)[0], safe_to_drive: rep.safe_to_drive.verdict }; });
}

/** Condensed reports for the AI mechanic prompt. */
export function reportBrief(title, rep) {
  const L = [`DEEP RESEARCH REPORT for "${title}" (web research by Claude; cite it):`, `Summary: ${rep.summary}`,
    `Safe to drive: ${rep.safe_to_drive.verdict}${rep.safe_to_drive.why ? ` (${rep.safe_to_drive.why})` : ''}`];
  if (rep.check_order.length) L.push('Check order: ' + rep.check_order.map((s, i) => `${i + 1}. ${s}`).join(' '));
  if (rep.likely_causes.length) L.push('Likely causes: ' + rep.likely_causes.map(c => `${c.cause} [${c.likelihood}; DIY ${c.cost_diy || '?'}, shop ${c.cost_shop || '?'}]`).join('; '));
  return L.join('\n').slice(0, 3000);
}
