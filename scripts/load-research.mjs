#!/usr/bin/env node
// Load one car's research files into D1 (schema: docs/research-schema.md). Safe by default (scripts/loader-safety.mjs):
// prints a plan against live D1, refuses overwrites/deletes without --force and drift (entries live in D1 that the
// files don't have, e.g. added with save_research) without --accept-drift, and exports the affected tables to
// backups/d1/ before writing. Always start with --dry-run.
//
//   node scripts/load-research.mjs --car <id|nickname> --dir research/<car-slug> [--dry-run] [--force] [--accept-drift]
//        [--schedule]  also apply research.json "schedule" (replaces the generic starter items; carries last-done over)
//        [--todos]     also turn "now" recommendations into to-dos (never duplicated)
//        [--local]     local D1 (wrangler dev) instead of your Cloudflare account
//   node scripts/load-research.mjs --symptom-report <todo-id> --file report.json [--local] [--dry-run]
//
// Files in --dir (all optional): research.json, research.md, parts-guides.json, parts-guides.md, fluids.json,
// brands.json, brands.md, diagnosis-plans.json ({ plans: [...] }, guided diagnosis; ids must be unique across cars).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, appendChunks, d1File, d1Query, dbName, flags, lit, wrangler } from './lib.mjs';
import { Plan, backup, canon, entryKey, listDrift } from './loader-safety.mjs';
import { validateReport } from '../src/research-jobs.js';
import { validatePlan } from '../src/diagnosis.js';

export const CATS = [  // (category, regex) - first match wins; used to carry last-done dates over to researched items
  ['oil', /\boil\b.*filter|engine oil|oil change/i], ['rotation', /rotat/i], ['cabin', /cabin/i], ['air', /air filter/i],
  ['coolant', /coolant|cooling system (drain|service|flush)/i], ['transfer', /transfer case/i], ['diff', /differential|axle fluid/i],
  ['trans', /trans(mission|axle).*fluid|automatic transmission fluid|automatic transaxle|^transmission/i], ['plugs', /spark plug/i],
  ['brakefluid', /brake fluid/i], ['brakes', /brake (inspection|linings|pads)|inspect brake/i], ['belt', /belt/i], ['fuelfilter', /fuel filter/i],
  ['pcv', /pcv/i], ['battery', /battery/i], ['wipers', /wiper/i],
];
export const categoryOf = name => (CATS.find(([, rx]) => rx.test(name)) || [null])[0];
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const words = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 2);
/** Best parts-list name for a brand entry (Jaccard on words, +0.3 when the first two words agree; >= 0.5 to match). */
export function matchPart(name, candidates) {
  const a = new Set(words(name)); let best = null, score = 0;
  for (const c of candidates) {
    const b = new Set(words(c)); if (!a.size || !b.size) continue;
    let s = [...a].filter(x => b.has(x)).length / new Set([...a, ...b]).size;
    if (words(name).slice(0, 2).join(' ') === words(c).slice(0, 2).join(' ')) s += 0.3;
    if (s > score) { best = c; score = s; }
  }
  return score >= 0.5 ? best : null;
}

const readJson = (dir, f) => existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null;
const readText = (dir, f) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null;

/** Pure planning step (tested in test/load-research.test.mjs): returns { plan, sql, tables }. q(sql) -> rows. */
export function planLoad({ car, dir, opts, q, now = Math.floor(Date.now() / 1000) }) {
  const plan = new Plan('load-research'), sql = [], tables = new Set();
  const research = readJson(dir, 'research.json'), md = readText(dir, 'research.md');
  const pg = readJson(dir, 'parts-guides.json'), pgMd = readText(dir, 'parts-guides.md'), fluids = readJson(dir, 'fluids.json');
  const brands = readJson(dir, 'brands.json'), brMd = readText(dir, 'brands.md');
  const diag = readJson(dir, 'diagnosis-plans.json');
  if (!research && !pg && !fluids && !brands && !diag) throw new Error(`no research files in ${dir} (research.json, parts-guides.json, fluids.json, brands.json)`);
  const C = lit(car.id);

  if (research) {
    tables.add('research');
    const live = q(`SELECT data, md FROM research WHERE car_id = ${C}`)[0];
    plan.compareJson('research', `${car.nickname} data`, live ? live.data : null, research);
    if (live && md != null) plan.compareText('research', `${car.nickname} report`, live.md, md);
    const text = JSON.stringify(research);
    sql.push(`INSERT INTO research (car_id, data, md, updated_at) VALUES (${C}, '', NULL, ${now}) ON CONFLICT(car_id) DO UPDATE SET data = '', updated_at = ${now};`);
    sql.push(...appendChunks('research', 'data', `car_id = ${C}`, text));
    if (md != null) { sql.push(`UPDATE research SET md = '' WHERE car_id = ${C};`); sql.push(...appendChunks('research', 'md', `car_id = ${C}`, md)); }

    // car fields: only fill empty ones (never overwrite what the owner typed)
    const v = research.vehicle || {};
    const row = q(`SELECT trim, engine, transmission FROM cars WHERE id = ${C}`)[0] || {};
    for (const k of ['trim', 'engine', 'transmission']) {
      if (!row[k] && typeof v[k] === 'string' && v[k].trim()) {
        tables.add('cars'); plan.add('update', 'cars', car.nickname, `${k} (empty) -> ${v[k].slice(0, 60)}`);
        sql.push(`UPDATE cars SET ${k} = ${lit(v[k].slice(0, 120))}, updated_at = ${now} WHERE id = ${C} AND (${k} IS NULL OR ${k} = '');`);
      }
    }

    if (opts.schedule && Array.isArray(research.schedule)) {
      tables.add('schedule_items'); tables.add('service_items');
      const old = q(`SELECT * FROM schedule_items WHERE car_id = ${C}`);
      const researched = old.filter(o => ['manual', 'typical'].includes(o.source));
      const generic = old.filter(o => ['starter', 'seed'].includes(o.source) || o.source == null);
      const links = q(`SELECT si.* FROM service_items si JOIN schedule_items s ON s.id = si.item_id WHERE s.car_id = ${C}`);
      const byCat = {};
      for (const o of generic) (byCat[categoryOf(o.name)] ||= []).push(o);
      const used = new Set();
      let order = Math.max(0, ...old.map(o => o.sort_order || 0));
      for (const s of research.schedule) {
        if (!s.item || (!s.interval_miles && !s.interval_months)) continue;   // informational rows: Research tab only
        const severe = s.severe === true ? 1 : 0, severeNote = typeof s.severe === 'string' ? s.severe : null;
        const src = ['manual', 'typical'].includes(s.source) ? s.source : 'typical';
        const same = researched.find(o => o.name.toLowerCase() === String(s.item).toLowerCase().slice(0, 120) && (o.severe || 0) === severe);
        if (same) {
          const target = { interval_miles: s.interval_miles ?? null, interval_months: s.interval_months ?? null, notes: s.notes || null };
          const diff = Object.entries(target).filter(([k, x]) => (same[k] ?? null) != x);
          if (diff.length) {
            plan.add('overwrite', 'schedule_items', same.name, diff.map(([k, x]) => `${k}: ${same[k]} -> ${x}`).join('; '));
            sql.push(`UPDATE schedule_items SET interval_miles = ${lit(target.interval_miles)}, interval_months = ${lit(target.interval_months)}, notes = ${lit(target.notes)}, source = ${lit(src)} WHERE id = ${lit(same.id)};`);
          }
          continue;
        }
        const c = categoryOf(s.item);
        const match = c && !severe ? (byCat[c] || []).find(o => !used.has(o.id)) : null;
        if (match) used.add(match.id);
        const id = 'r-' + randomUUID().slice(0, 12);
        plan.add('new', 'schedule_items', s.item.slice(0, 60), match ? `replaces starter "${match.name}"${match.last_done_date || match.last_done_miles != null ? ' (its last-done carries over)' : ''}` : '');
        sql.push(`INSERT INTO schedule_items (id, car_id, name, interval_miles, interval_months, last_done_date, last_done_miles, due_now, notes, sort_order, created_at, source, severe, severe_note, last_done_estimated, catchup_answer, catchup_at) VALUES (${lit(id)}, ${C}, ${lit(String(s.item).slice(0, 120))}, ${lit(s.interval_miles ?? null)}, ${lit(s.interval_months ?? null)}, ${lit(match?.last_done_date ?? null)}, ${lit(match?.last_done_miles ?? null)}, ${lit(match?.due_now ?? 0)}, ${lit(s.notes || null)}, ${++order}, ${now}, ${lit(src)}, ${severe}, ${lit(severeNote)}, ${lit(match?.last_done_estimated ?? 0)}, ${lit(match?.catchup_answer ?? null)}, ${lit(match?.catchup_at ?? null)});`);
        if (match) for (const l of links.filter(l => l.item_id === match.id)) sql.push(`INSERT OR IGNORE INTO service_items (service_id, item_id) VALUES (${lit(l.service_id)}, ${lit(id)});`);
      }
      for (const o of generic) {
        const hasHistory = o.last_done_date || o.last_done_miles != null || links.some(l => l.item_id === o.id);
        if (used.has(o.id) || !hasHistory) {
          plan.add('update', 'schedule_items', o.name, used.has(o.id) ? 'starter item replaced by the researched one' : 'unused starter item removed (no history)');
          sql.push(`DELETE FROM schedule_items WHERE id = ${lit(o.id)};`);
        } else sql.push(`UPDATE schedule_items SET source = 'user' WHERE id = ${lit(o.id)};`);   // has history and no researched twin: keep it
      }
    }

    if (opts.todos && Array.isArray(research.recommendations)) {
      tables.add('todos');
      const todos = q(`SELECT source FROM todos WHERE car_id = ${C}`);
      for (const r of research.recommendations) {
        if (r.priority !== 'now' || !r.item) continue;
        const key = 'research:' + slug(r.item);
        if (todos.some(t => t.source === key)) continue;
        plan.add('new', 'todos', String(r.item).slice(0, 60));
        const prio = /brake|recall|safety|stop driving|leak|steer/i.test(r.item) ? 'high' : 'medium';
        sql.push(`INSERT INTO todos (id, car_id, title, notes, priority, status, created_at, source) VALUES (${lit('t-' + randomUUID().slice(0, 12))}, ${C}, ${lit(String(r.item).slice(0, 200))}, ${lit(('Research recommends now. ' + (r.why || '') + (r.cost ? ' Cost: ' + r.cost : '')).trim())}, ${lit(prio)}, 'open', ${now}, ${lit(key)});`);
      }
    }
  }

  if (pg || fluids) {
    tables.add('parts_guides');
    const live = q(`SELECT data, md, fluids FROM parts_guides WHERE car_id = ${C}`)[0];
    const data = pg ?? (live ? JSON.parse(live.data) : { parts: [], guides: [] });
    const fl = fluids ?? (live ? JSON.parse(live.fluids) : []);
    if (pg) plan.compareJson('parts_guides', `${car.nickname} parts/guides`, live ? live.data : null, data);
    if (fluids) plan.compareJson('parts_guides', `${car.nickname} fluids`, live ? live.fluids : null, fl, { driftCheck: false });
    if (live && pgMd != null) plan.compareText('parts_guides', `${car.nickname} parts report`, live.md, pgMd);
    sql.push(`INSERT INTO parts_guides (car_id, data, md, fluids, updated_at) VALUES (${C}, '', NULL, '', ${now}) ON CONFLICT(car_id) DO UPDATE SET data = '', fluids = '', updated_at = ${now};`);
    sql.push(...appendChunks('parts_guides', 'data', `car_id = ${C}`, JSON.stringify(data)));
    sql.push(...appendChunks('parts_guides', 'fluids', `car_id = ${C}`, JSON.stringify(fl)));
    if (pgMd != null) { sql.push(`UPDATE parts_guides SET md = '' WHERE car_id = ${C};`); sql.push(...appendChunks('parts_guides', 'md', `car_id = ${C}`, pgMd)); }
  }

  if (brands) {
    tables.add('brands'); tables.add('brands_meta');
    const parts = Array.isArray(brands.parts) ? brands.parts : [];
    const liveRows = q(`SELECT idx, part, data FROM brands WHERE car_id = ${C} ORDER BY idx`);
    const liveParts = liveRows.map(r => JSON.parse(r.data));
    if (!liveRows.length) plan.add('new', 'brands', car.nickname, `${parts.length} parts`);
    else {
      for (const [, lab] of listDrift({ parts: liveParts }, { parts })) plan.add('drift', 'brands', car.nickname, `part "${lab}" is in D1 but not in the files`);
      if (canon(liveParts) !== canon(parts)) plan.add('overwrite', 'brands', car.nickname, `${liveRows.length} live rows replaced by ${parts.length} from the files`);
    }
    const pgData = pg ?? (() => { const r = q(`SELECT data FROM parts_guides WHERE car_id = ${C}`)[0]; return r ? JSON.parse(r.data) : { parts: [] }; })();
    const names = (pgData.parts || []).map(p => p.name).filter(Boolean);
    const used = new Set();
    sql.push(`DELETE FROM brands WHERE car_id = ${C};`);
    parts.forEach((p, i) => {
      const m = p.in_parts_list === false ? null : matchPart(p.part || '', names.filter(n => !used.has(n)));
      if (m) used.add(m);
      const text = JSON.stringify(p);
      if (text.length < 60000) sql.push(`INSERT INTO brands (car_id, idx, part, category, matched_part, data) VALUES (${C}, ${i}, ${lit(p.part || '?')}, ${lit(p.category || null)}, ${lit(m)}, ${lit(text)});`);
      else { sql.push(`INSERT INTO brands (car_id, idx, part, category, matched_part, data) VALUES (${C}, ${i}, ${lit(p.part || '?')}, ${lit(p.category || null)}, ${lit(m)}, '');`); sql.push(...appendChunks('brands', 'data', `car_id = ${C} AND idx = ${i}`, text)); }
    });
    const meta = Object.fromEntries(Object.entries(brands).filter(([k]) => k !== 'parts'));
    const lm = q(`SELECT meta, md FROM brands_meta WHERE car_id = ${C}`)[0];
    plan.compareJson('brands_meta', `${car.nickname} meta`, lm ? lm.meta : null, meta);
    sql.push(`INSERT INTO brands_meta (car_id, meta, md, updated_at) VALUES (${C}, '', NULL, ${now}) ON CONFLICT(car_id) DO UPDATE SET meta = '', updated_at = ${now};`);
    sql.push(...appendChunks('brands_meta', 'meta', `car_id = ${C}`, JSON.stringify(meta)));
    if (brMd != null) { sql.push(`UPDATE brands_meta SET md = '' WHERE car_id = ${C};`); sql.push(...appendChunks('brands_meta', 'md', `car_id = ${C}`, brMd)); }
  }
  if (diag) {
    // Guided-diagnosis plans: validated with the Worker's own validatePlan(); new plans and higher versions load
    // (running sessions keep the plan copy they started with); same version with changed content, a lower version, or
    // replacing an AI-generated plan with the same id are overwrites (--force). Plans in D1 not in the file stay.
    tables.add('diag_plans');
    const plans = Array.isArray(diag.plans) ? diag.plans : [];
    const bad = plans.flatMap(p => validatePlan(p).map(e => `${p.id || '?'}: ${e}`));
    const ids = plans.map(p => p.id); if (new Set(ids).size !== ids.length) bad.push('duplicate plan ids in the file');
    if (bad.length) throw new Error(`diagnosis-plans.json is invalid, nothing loaded:\n  ${bad.slice(0, 30).join('\n  ')}`);
    const live = Object.fromEntries(q('SELECT id, car_id, version, source, data FROM diag_plans').map(r => [r.id, r]));
    for (const p of plans) {
      const full = { ...p, car_id: car.id };
      const r = live[p.id];
      if (r && r.car_id && r.car_id !== car.id) { plan.add('overwrite', 'diag_plans', p.id, `belongs to another car (${r.car_id}); give the plan a unique id`); continue; }
      let kind = 'new', detail = `v${p.version}, ${p.steps.length} steps`;
      if (r) {
        const lv = Number(r.version);
        if (r.source !== 'research') { kind = 'overwrite'; detail = `replaces a ${r.source} plan with the same id`; }
        else if (p.version > lv) { kind = 'update'; detail = `v${lv} -> v${p.version}`; }
        else if (p.version < lv) { kind = 'overwrite'; detail = `downgrade v${lv} -> v${p.version}`; }
        else if (canon(r.data) === canon(full)) continue;
        else { kind = 'overwrite'; detail = `content changed but still v${lv} (bump "version" instead)`; }
      }
      plan.add(kind, 'diag_plans', p.id, detail);
      sql.push(`INSERT INTO diag_plans (id, car_id, version, source, symptom, title, data, status, created_by, created_at, updated_at) VALUES (${lit(p.id)}, ${C}, ${p.version}, 'research', ${lit(p.symptom)}, ${lit(p.title)}, ${lit(JSON.stringify(full))}, 'active', 'load-research', ${now}, ${now}) ON CONFLICT(id) DO UPDATE SET car_id = excluded.car_id, version = excluded.version, source = 'research', symptom = excluded.symptom, title = excluded.title, data = excluded.data, status = 'active', updated_at = excluded.updated_at;`);
    }
  }
  return { plan, sql, tables: [...tables] };
}

function resolveCar(ref, q) {
  const r = String(ref || '').trim();
  if (!r) throw new Error('--car is required (id or nickname)');
  const rows = q(`SELECT id, nickname, year, make, model FROM cars WHERE archived = 0 AND (id = ${lit(r)} OR lower(nickname) = lower(${lit(r)}) OR lower(model) = lower(${lit(r)}))`);
  if (rows.length !== 1) {
    const all = q('SELECT id, nickname FROM cars WHERE archived = 0');
    throw new Error(`${rows.length ? 'More than one' : 'No'} car matches "${r}". Cars: ${all.map(c => `${c.nickname} (${c.id})`).join(', ') || 'none'}`);
  }
  return rows[0];
}

async function main() {
  const opts = flags(process.argv.slice(2), ['car', 'dir', 'dry-run', 'force', 'accept-drift', 'local', 'schedule', 'todos', 'symptom-report', 'file']);
  const local = !!opts.local;
  const q = sql => d1Query(sql, { local });
  const build = join(ROOT, 'build'); mkdirSync(build, { recursive: true });
  const out = join(build, `load-research-${process.pid}.sql`);

  if (opts.symptom_report) {      // one deep-research report for a to-do
    if (!opts.file) throw new Error('--file report.json is required with --symptom-report');
    const report = validateReport(JSON.parse(readFileSync(resolve(opts.file), 'utf8')));
    const t = q(`SELECT id, car_id, title FROM todos WHERE id = ${lit(opts.symptom_report)}`)[0];
    if (!t) throw new Error(`to-do ${opts.symptom_report} not found`);
    const job = q(`SELECT id FROM research_jobs WHERE todo_id = ${lit(t.id)} AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`)[0];
    const now = Math.floor(Date.now() / 1000), id = job?.id || randomUUID();
    console.error(`${opts.dry_run ? 'DRY RUN: would save' : 'saving'} report for "${t.title}" (${report.likely_causes.length} causes, ${report.sources.length} sources)${job ? ', completing its queued job' : ''}`);
    if (opts.dry_run) return 0;
    const meta = JSON.stringify({ via: 'load-research.mjs' });
    writeFileSync(out, [
      job ? `UPDATE research_jobs SET status = 'done', finished_at = ${now}, result = ${lit(JSON.stringify(report))}, error = NULL, meta = ${lit(meta)}, attempts = attempts + 1 WHERE id = ${lit(id)};`
        : `INSERT INTO research_jobs (id, todo_id, car_id, status, attempts, created_at, started_at, finished_at, result, meta) VALUES (${lit(id)}, ${lit(t.id)}, ${lit(t.car_id)}, 'done', 1, ${now}, ${now}, ${now}, ${lit(JSON.stringify(report))}, ${lit(meta)});`,
      `UPDATE todos SET researched_at = ${now} WHERE id = ${lit(t.id)};`,
    ].join('\n') + '\n');
    try { d1File(out, { local }); } finally { rmSync(out, { force: true }); }
    console.error('saved');
    return 0;
  }

  if (!opts.dir) throw new Error('--dir research/<car-slug> is required');
  const car = resolveCar(opts.car, q);
  const { plan, sql, tables } = planLoad({ car, dir: resolve(opts.dir), opts, q });
  const g = plan.gate(opts, { hint: 'Check the plan above first (--dry-run).' });
  if (!g.write) return g.exit;
  const b = backup({ tables, loader: 'load-research', remote: !local, dbName: dbName(), root: ROOT, run: wrangler });
  if (b.exit) return b.exit;
  const big = sql.filter(s => Buffer.byteLength(s) > 100_000);
  if (big.length) throw new Error(`internal: ${big.length} statement(s) over D1's 100 KB limit`);
  writeFileSync(out, sql.join('\n') + '\n');
  try { d1File(out, { local }); } finally { rmSync(out, { force: true }); }
  console.error(`loaded ${car.nickname}: ${sql.length} statements${local ? ' (local D1)' : ''}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(code => process.exit(code), e => { console.error(e.message); process.exit(1); });
