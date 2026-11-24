// MCP save_research_bundle: whole-car research from Claude (claude.ai / mobile), the MCP twin of
// scripts/load-research.mjs. Same safety idea as the loader: existing rows are never replaced without overwrite=true,
// dry_run=true only reports, and research entries added since (save_research) are reported as drift.
// Schema: docs/research-schema.md.
import { HttpError, nowSec } from './util.js';

const MAX = 900_000;   // chars per JSON value (D1 rows can hold this; MCP clients rarely send more)
const LIST_KEYS = ['recalls', 'tsbs', 'schedule', 'known_issues', 'symptom_diagnosis', 'recommendations', 'questions'];
const keyOf = e => typeof e === 'string' ? e.toLowerCase().trim() : String(e?.title || e?.symptom || e?.number || e?.campaign || e?.item || e?.name || JSON.stringify(e)).toLowerCase().trim();

export function checkResearchShape(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'research must be an object');
  for (const k of LIST_KEYS) if (r[k] != null && !Array.isArray(r[k])) throw new HttpError(400, `research.${k} must be a list`);
  if (r.vehicle != null && (typeof r.vehicle !== 'object' || Array.isArray(r.vehicle))) throw new HttpError(400, 'research.vehicle must be an object');
  const text = JSON.stringify(r);
  if (text.length > MAX) throw new HttpError(413, 'research is too large');
  return text;
}

/** Entries live in D1 that the new research would drop (e.g. added with save_research). */
export function driftOf(live, next) {
  const out = [];
  for (const k of LIST_KEYS) {
    const keep = new Set((next?.[k] || []).map(keyOf));
    for (const e of live?.[k] || []) if (!keep.has(keyOf(e))) out.push(`${k}: ${keyOf(e).slice(0, 80)}`);
  }
  return out;
}

export async function saveResearchBundle(env, car, a) {
  const overwrite = a.overwrite === true, dry = a.dry_run === true;
  const plan = [], drift = [];
  const stmts = [];
  const now = nowSec();
  if (a.research != null) {
    const text = checkResearchShape(a.research);
    const md = a.report_md != null ? String(a.report_md).slice(0, MAX) : null;
    const live = await env.DB.prepare('SELECT data, md FROM research WHERE car_id = ?1').bind(car.id).first();
    if (live && !overwrite) throw new HttpError(409, 'This car already has research. Add entries with save_research, or pass overwrite=true to replace it all (dry_run=true first).');
    if (live) drift.push(...driftOf(JSON.parse(live.data), a.research));
    plan.push(live ? 'research: replace' : 'research: new');
    stmts.push(env.DB.prepare('INSERT INTO research (car_id, data, md, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(car_id) DO UPDATE SET data = excluded.data, md = COALESCE(excluded.md, research.md), updated_at = excluded.updated_at')
      .bind(car.id, text, md, now));
  } else if (a.report_md != null) throw new HttpError(400, 'report_md goes with research');
  if (a.parts_guides != null || a.fluids != null) {
    if (a.fluids != null && !Array.isArray(a.fluids)) throw new HttpError(400, 'fluids must be a list');
    if (a.parts_guides != null && (typeof a.parts_guides !== 'object' || Array.isArray(a.parts_guides))) throw new HttpError(400, 'parts_guides must be an object');
    const live = await env.DB.prepare('SELECT data, fluids FROM parts_guides WHERE car_id = ?1').bind(car.id).first();
    if (live && !overwrite) throw new HttpError(409, 'This car already has parts/fluids research. Pass overwrite=true to replace it (dry_run=true first).');
    const data = JSON.stringify(a.parts_guides ?? (live ? JSON.parse(live.data) : { parts: [], guides: [] }));
    const fluids = JSON.stringify(a.fluids ?? (live ? JSON.parse(live.fluids) : []));
    if (data.length > MAX || fluids.length > MAX) throw new HttpError(413, 'parts_guides is too large');
    plan.push(live ? 'parts_guides: replace' : 'parts_guides: new');
    stmts.push(env.DB.prepare('INSERT INTO parts_guides (car_id, data, md, fluids, updated_at) VALUES (?1, ?2, NULL, ?3, ?4) ON CONFLICT(car_id) DO UPDATE SET data = excluded.data, fluids = excluded.fluids, updated_at = excluded.updated_at')
      .bind(car.id, data, fluids, now));
  }
  if (!stmts.length) throw new HttpError(400, 'Nothing to save: pass research, fluids and/or parts_guides');
  const out = { car: car.nickname, plan, drift, dry_run: dry };
  if (dry) return { ...out, saved: false, note: drift.length ? 'Dry run. Overwriting would drop the drift entries listed; copy them into the new research first.' : 'Dry run: nothing saved.' };
  await env.DB.batch(stmts);
  return { ...out, saved: true };
}
