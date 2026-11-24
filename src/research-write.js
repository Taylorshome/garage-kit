// save_research (MCP, owner only): add entries to a car's researched data (research.data JSON).
// New entries are appended; ones already there (same key) are skipped unless overwrite=true, which
// replaces them in place. dry_run=true reports what would change and saves nothing.
// The write is an optimistic lock on the research row: it only lands if the row is unchanged since
// it was read, so a concurrent apply-research.sh run or another save is never silently clobbered.
import { HttpError, nowSec } from './util.js';

/** MCP section name -> key in the research JSON, plus the field(s) that identify an entry. */
export const WRITE_SECTIONS = {
  symptom_checklists: { field: 'symptom_diagnosis', keys: ['symptom'] },
  known_issues: { field: 'known_issues', keys: ['title'] },
  tsbs: { field: 'tsbs', keys: ['number', 'title'] },
  recalls: { field: 'recalls', keys: ['campaign', 'summary'] },
  recommendations: { field: 'recommendations', keys: ['item'] },
  questions: { field: 'questions', keys: null }, // plain strings
};
const MAX_ENTRIES = 50;
const MAX_ENTRY_CHARS = 8000;

const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Identity of one entry within its section (case/whitespace-insensitive). Throws 400 if it has none. */
export function entryKey(section, e) {
  const spec = WRITE_SECTIONS[section];
  if (!spec.keys) {
    if (typeof e !== 'string' || !e.trim()) throw new HttpError(400, 'questions entries must be non-empty strings');
    return norm(e);
  }
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new HttpError(400, `${section} entries must be objects`);
  for (const k of spec.keys) if (e[k] != null && String(e[k]).trim()) return `${k}:${norm(e[k])}`;
  throw new HttpError(400, `each ${section} entry needs ${spec.keys.join(' or ')}`);
}

const label = (section, e) => {
  const spec = WRITE_SECTIONS[section];
  if (!spec.keys) return e;
  const k = spec.keys.find(k => e[k] != null && String(e[k]).trim());
  return String(e[k]);
};

function validate(section, entries) {
  if (!Object.hasOwn(WRITE_SECTIONS, section ?? '')) throw new HttpError(400, `section must be one of ${Object.keys(WRITE_SECTIONS).join(', ')}`);
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, 'entries must be a non-empty array');
  if (entries.length > MAX_ENTRIES) throw new HttpError(400, `at most ${MAX_ENTRIES} entries per call`);
  const seen = new Set();
  for (const e of entries) {
    const k = entryKey(section, e);
    if (seen.has(k)) throw new HttpError(400, `duplicate entry in this call: ${label(section, e)}`);
    seen.add(k);
    if (JSON.stringify(e).length > MAX_ENTRY_CHARS) throw new HttpError(400, `entry too long (max ${MAX_ENTRY_CHARS} characters): ${String(label(section, e)).slice(0, 80)}`);
    if (section === 'symptom_checklists' && e.likely_causes != null && !Array.isArray(e.likely_causes)) throw new HttpError(400, 'symptom_checklists likely_causes must be an array');
  }
}

/** Pure: the research JSON after the write, and which entries were added / replaced / skipped. */
export function planResearchWrite(data, section, entries, overwrite) {
  const { field } = WRITE_SECTIONS[section];
  const current = data[field] ?? [];
  if (!Array.isArray(current)) throw new HttpError(409, `research ${field} for this car is not a list; fix it by hand`);
  const list = current.slice();
  const index = new Map();
  list.forEach((e, i) => { try { const k = entryKey(section, e); if (!index.has(k)) index.set(k, i); } catch { /* legacy entry without a key: leave it alone */ } });
  const added = [], replaced = [], skipped = [];
  for (const raw of entries) {
    const e = JSON.parse(JSON.stringify(raw));
    const k = entryKey(section, e), at = index.get(k);
    if (at === undefined) { index.set(k, list.length); list.push(e); added.push(label(section, e)); }
    else if (overwrite) { list[at] = e; replaced.push(label(section, e)); }
    else skipped.push(label(section, e));
  }
  return { next: { ...data, [field]: list }, added, replaced, skipped, total: list.length };
}

const bool = (v, name) => {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new HttpError(400, `${name} must be true or false`);
  return v;
};

/** MCP save_research. car is a resolved cars row; who carries is_owner from handleMcp. */
export async function saveResearch(env, car, a, who) {
  if (!who?.is_owner) throw new HttpError(403, 'save_research is limited to garage owners.');
  const overwrite = bool(a.overwrite, 'overwrite'), dryRun = bool(a.dry_run, 'dry_run');
  validate(a.section, a.entries);
  const row = await env.DB.prepare('SELECT data, updated_at FROM research WHERE car_id = ?1').bind(car.id).first();
  const data = row ? JSON.parse(row.data) : {};
  const plan = planResearchWrite(data, a.section, a.entries, overwrite);
  const out = { car: car.nickname, section: a.section, overwrite, dry_run: dryRun, added: plan.added, replaced: plan.replaced, skipped: plan.skipped, total_after: plan.total };
  if (dryRun) return { ...out, saved: false, note: 'Dry run: nothing was saved.' };
  if (!plan.added.length && !plan.replaced.length) return { ...out, saved: false, note: 'Nothing new to save (all entries already exist; pass overwrite=true to replace them).' };
  const text = JSON.stringify(plan.next);
  const now = Math.max(nowSec(), (row?.updated_at ?? 0) + 1); // always moves, so a lock taken in the same second still fails
  const r = row
    ? await env.DB.prepare('UPDATE research SET data = ?1, updated_at = ?2 WHERE car_id = ?3 AND updated_at = ?4 AND data = ?5').bind(text, now, car.id, row.updated_at, row.data).run()
    : await env.DB.prepare('INSERT INTO research (car_id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(car_id) DO NOTHING').bind(car.id, text, now).run();
  if (!r?.meta?.changes) throw new HttpError(409, 'The research for this car changed while saving, so nothing was saved. Run save_research again.');
  return { ...out, saved: true, updated_at: now };
}
