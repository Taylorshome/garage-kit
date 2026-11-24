// Relevance-based research context for the AI mechanic (chat, first checks) and the deep-research worker.
// The research per car is ~60-95 KB of JSON plus ~60 KB of markdown, far more than fits a useful prompt, so it is
// split into chunks (one per known issue, TSB, recall, diagnosis, recommendation, markdown section, vehicle fact
// group) and the chunks most relevant to the question are packed into a fixed character budget.
// Always included: core vehicle facts + recalls, and the diagnoses for the car's live (open to-do) symptoms.
// Scoring is cheap keyword matching (crude stemming, IDF, a small synonym table); no embeddings needed.
// Pure functions; unit-tested in test/research-context.test.mjs.

export const RESEARCH_BUDGET = 32000;       // chars of research in the chat / first-checks prompt (~9k tokens)
export const JOB_RESEARCH_BUDGET = 40000;   // chars for the background research worker (Claude, large context)

const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its ' +
  'me my no not of on or our so than that the their them then there these they this to too up was we were what when where ' +
  'which while who why will with would you your about after again all also any just like more most only other over same should ' +
  'some such very get got going still now one two car truck van has having been per see use used using check first minute minutes ' +
  'thing things need want know tell help please think much many any lot').split(' '));

export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
export function tokens(text) {
  const out = [];
  for (const m of String(text ?? '').toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const w = m[0];
    if (w.length < 2 || STOP.has(w) || (/^\d+$/.test(w) && w.length < 3)) continue;
    out.push(stem(w));
  }
  return out;
}

// Owner words -> research words. A query token in a group pulls in the rest of the group at reduced weight.
const SYNONYMS = [
  'coolant antifreeze overheat overheating hot temp temperature gauge fan fans radiator thermostat waterpump pump crossover surge cap dexcool hoat ect boil steam cooling bleed',
  'tick ticking tap tapping lifter lifters rocker rockers valvetrain cam camshaft noise clatter',
  'rattle rattling mount mounts flexplate flex plate heat shield vibration vibrate clunk rumble shake buzz',
  'hvac blend actuator actuators door doors mode recirc defrost vent vents heater heat climate blower dash clicking click temperature',
  'ac a/c air conditioning compressor refrigerant condenser warm',
  'oil filter viscosity synthetic 5w 5w30 pressure sludge consumption',
  'brake brakes pedal pad pads rotor rotors caliper abs line lines hose fluid',
  'transmission trans transaxle shift shifting slip slipping flare atf 4l60 62te 4t45 converter',
  'battery alternator charging dim lights crank starter start no-start security stall',
  'fuel gas smell evap tank injector gasoline',
  '4wd transfer case front axle actuator 4x4 auto-trak',
  'misfire rough coil coils plug plugs spark ping knock p0300',
  'steering suspension ball joint tie rod idler clunk wander alignment',
  'maintenance schedule interval service due mileage miles change',
].map(g => [...new Set(tokens(g))]);
const SYN = new Map();
for (const g of SYNONYMS) for (const t of g) SYN.set(t, [...new Set([...(SYN.get(t) || []), ...g])]);

/** Weighted query terms: the newest message counts fully, earlier turns less; synonyms at 40%. */
export function queryTerms(parts) {
  const w = new Map();
  const add = (t, x) => { if (x > (w.get(t) || 0)) w.set(t, x); };
  for (const { text, weight } of parts) for (const t of tokens(text)) add(t, weight);
  for (const [t, x] of [...w]) for (const s of SYN.get(t) || []) add(s, x * 0.4);
  return w;
}

// ---------------------------------------------------------------------------- chunking
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const flat = v => (v && typeof v === 'object') ? Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(x) ? x.map(flat).join('; ') : typeof x === 'object' ? flat(x) : x}`).join('; ') : String(v ?? '');
const arr = v => Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [];
const URL_RE = /https?:\/\/[^\s)\]"'<>|]+/g;
const urlsIn = v => [...new Set((JSON.stringify(v ?? '').match(URL_RE) || []).map(u => u.replace(/[.,;]+$/, '').replace(/\\+$/, '')))];
function withSources(text, entry, max = 3) {
  const us = urlsIn(entry).filter(u => !text.includes(u)).slice(0, max);
  return us.length ? `${text} Sources: ${us.join(' ')}` : text;
}
const CORE_KEYS = ['trim', 'trim_likely', 'trim_reported', 'engine', 'engine_likely', 'engine_alternative', 'transmission', 'transmission_likely', 'drive', 'oil', 'coolant',
  'spark_plug_gap_in', 'capacities', 'fluids', 'parts', 'climate_control', 'owner_manual_fluids'];

/** Split one car's research (JSON + markdown) into scoreable chunks. */
export function researchChunks(d, md) {
  const C = [];
  const add = (id, kind, title, text) => { if (text) C.push({ id, kind, title: clip(title, 160), text }); };
  const v = d?.vehicle || {};
  const core = CORE_KEYS.filter(k => v[k] != null).map(k => `${k.replace(/_/g, ' ')} = ${clip(flat(v[k]), k === 'owner_manual_fluids' ? 1400 : 500)}`).join(' | ');
  const recalls = arr(d?.recalls).map(r => `${r.campaign} ${clip(r.component, 50)}: ${clip(r.summary, 120)}`).join(' || ');
  add('vehicle', 'core', 'Vehicle facts', `Specs: ${core}${recalls ? `\nRecalls (check open status by VIN): ${recalls}` : ''}`);
  for (const [k, x] of Object.entries(v)) {
    if (CORE_KEYS.includes(k) || x == null || typeof x !== 'object') continue;
    add(`vehicle:${k}`, 'vehicle', `Vehicle: ${k.replace(/_/g, ' ')}`, `${k.replace(/_/g, ' ')}: ${clip(flat(x), 3000)}`);
  }
  arr(d?.recalls).forEach((r, i) => add(`recall:${i}`, 'recall', `Recall ${r.campaign ?? ''} ${r.component ?? ''}`,
    withSources(`Recall ${r.campaign ?? ''} (${r.date || '?'}) ${r.component || ''}: ${clip(r.summary, 600)} Remedy: ${clip(r.remedy, 300)}`, r)));
  arr(d?.tsbs).forEach((t, i) => add(`tsb:${i}`, 'tsb', `TSB ${t.number ?? ''} ${t.title ?? ''}`,
    withSources(`TSB ${t.number ?? ''}: ${clip(t.title, 200)}. ${clip(t.summary, 900)}`, t)));
  arr(d?.known_issues).forEach((k, i) => add(`issue:${i}`, 'issue', `Known issue: ${k.title ?? ''}`,
    withSources(`Known issue: ${clip(k.title, 200)} [${clip(k.mileage_range, 60)}; urgency ${clip(k.urgency, 40)}]. Symptoms: ${clip(k.symptoms, 500)} Fix: ${clip(k.fix, 500)} DIY ${clip(k.cost_diy, 80)}, shop ${clip(k.cost_shop, 80)}.`, k)));
  arr(d?.symptom_diagnosis).forEach((s, i) => {
    const causes = (Array.isArray(s.likely_causes) ? s.likely_causes : []).map((c, n) => `${n + 1}. ${clip(c.cause, 140)} (${clip(c.likelihood, 60)}; check: ${clip(c.how_to_check, 260)}; fix: ${clip(c.fix, 160)}; ${clip(c.cost, 60)})`).join(' ');
    const stc = s.scan_tool_checks ? ` Scan tool: ${clip(Array.isArray(s.scan_tool_checks) ? s.scan_tool_checks.join('; ') : s.scan_tool_checks, 500)}` : '';
    add(`diag:${i}`, 'diag', `Symptom diagnosis: ${s.symptom ?? ''}`, withSources(`Symptom diagnosis: ${clip(s.symptom, 200)}. Likely causes: ${causes}${stc}`, s));
    if (C.at(-1)?.id === `diag:${i}`) C.at(-1).causes = (Array.isArray(s.likely_causes) ? s.likely_causes : []).map(c => String(c?.cause ?? ''));
  });
  arr(d?.recommendations).forEach((r, i) => add(`rec:${i}`, 'rec', `Recommendation: ${r.item ?? ''}`,
    withSources(`Recommendation [${r.priority}]: ${clip(r.item, 300)}${r.why ? ` (why: ${clip(r.why, 300)})` : ''}${r.cost ? ` cost ${clip(r.cost, 60)}` : ''}`, r)));
  if (d?.schedule?.length) add('schedule', 'schedule', 'Researched maintenance schedule (owner manual)',
    'Researched maintenance schedule: ' + arr(d.schedule).map(s => `${clip(s.item, 110)}: ${[s.interval_miles && `${s.interval_miles} mi`, s.interval_months && `${s.interval_months} mo`].filter(Boolean).join(' / ') || 'no interval'} [${s.source || '?'}${s.severe === true ? ', severe' : typeof s.severe === 'string' ? `; ${clip(s.severe, 60)}` : ''}]${s.notes ? ` ${clip(s.notes, 120)}` : ''}`).join(' | '));
  if (d?.questions?.length) add('questions', 'questions', 'Open questions for the owner', 'Open questions for the owner: ' + d.questions.map(q => clip(typeof q === 'string' ? q : flat(q), 160)).join(' | '));
  if (d?.nhtsa_complaints) add('nhtsa', 'vehicle', 'NHTSA complaints summary', withSources(`NHTSA complaints: ${clip(flat(d.nhtsa_complaints), 1500)}`, d.nhtsa_complaints));
  for (const c of mdChunks(md || '')) C.push(c);
  return C;
}

const MD_PIECE = 1800;
/** Markdown -> one chunk per section (## / ### / ####), long sections split at line boundaries. */
export function mdChunks(md) {
  const out = [];
  const path = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body.length >= 40) {
      const title = (path.length > 1 && path[0] ? path.slice(1) : path).filter(Boolean).join(' > ') || path[0] || 'Report';   // the H1 is just the car name
      const pieces = [];
      let buf = '';
      for (const line of body.split('\n')) {
        if (buf && buf.length + line.length + 1 > MD_PIECE) { pieces.push(buf); buf = ''; }
        buf += (buf ? '\n' : '') + (line.length > MD_PIECE ? line.slice(0, MD_PIECE - 1) + '…' : line);
      }
      if (buf) pieces.push(buf);
      const last = path[path.length - 1] || '';
      const kind = /^sources|sources skipped|sources \(/i.test(last) ? 'md-sources' : /^questions/i.test(last) ? 'questions' : 'md';
      pieces.forEach((p, i) => out.push({ id: `md:${out.length}`, kind, title: clip(pieces.length > 1 ? `${title} (part ${i + 1})` : title, 160), text: `[Report: ${title}]\n${p}` }));
    }
    cur = null;
  };
  for (const line of md.split('\n')) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      path.length = Math.max(0, level - 1);
      path[level - 1] = h[2].replace(/[*_`]/g, '').trim();
      cur = { lines: [] };
    } else {
      if (!cur) cur = { lines: [] };
      cur.lines.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------- scoring + packing
const KIND_WEIGHT = { core: 1, vehicle: 1, recall: 1, tsb: 1, issue: 1.1, diag: 1.1, rec: 0.9, schedule: 1, questions: 0.4, md: 1, 'md-sources': 0.2 };

export function scoreChunks(chunks, terms) {
  if (!terms.size) return chunks.map(c => ({ ...c, score: 0 }));
  const toks = chunks.map(c => ({ title: new Set(tokens(c.title)), text: tokens(c.text) }));
  const df = new Map();
  for (const t of toks) for (const w of new Set([...t.title, ...t.text])) if (terms.has(w)) df.set(w, (df.get(w) || 0) + 1);
  const N = chunks.length;
  return chunks.map((c, i) => {
    const tf = new Map();
    for (const w of toks[i].text) if (terms.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const [t, wt] of terms) {
      const n = df.get(t);
      if (!n) continue;
      const idf = Math.log(1 + N / n);
      s += wt * idf * ((toks[i].title.has(t) ? 3 : 0) + Math.min(3, tf.get(t) || 0));
    }
    return { ...c, score: s * (KIND_WEIGHT[c.kind] ?? 1) / Math.sqrt(Math.max(1, c.text.length / 1200)) };
  });
}

/** Diagnoses that match the car's open to-dos (the owner's live symptoms). */
export function liveDiagnoses(chunks, openTodos) {
  const diags = chunks.filter(c => c.kind === 'diag');
  const out = new Set();
  for (const t of openTodos || []) {
    const q = new Set(tokens(t.title));
    if (!q.size) continue;
    for (const c of diags) {
      const ct = new Set(tokens(c.title.replace(/^Symptom diagnosis:/, '')));
      const hits = [...q].filter(w => ct.has(w)).length;
      if (hits >= 2 || (hits >= 1 && q.size <= 2)) out.add(c.id);
    }
  }
  return out;
}

// Bulletin / recall numbers: GM 07-06-02-006E, Chrysler 09-002-14 or 23-005-14, NHTSA 14V-224 (revision letter ignored)
const REF_RE = /\b(\d{2}-\d{2}-\d{2}-\d{3}|\d{2}-\d{3}-\d{2}|\d{2}V-?\d{3})[A-Z]?\b/g;
const refsIn = s => new Set([...String(s).matchAll(REF_RE)].map(m => m[1].replace('V-', 'V')));
/**
 * Follow cross-references from the best-matching chunks: bulletins/recalls they cite by number, and known issues /
 * bulletins named like one of a matching diagnosis's likely causes (e.g. "Cooling fan(s) not running" -> "Cooling fans / relays / fuses").
 */
export function followRefs(scored) {
  const top = scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);
  if (!top.length) return scored;
  const refs = new Set();
  for (const c of top) for (const r of refsIn(c.text)) refs.add(r);
  const causes = top.flatMap(c => c.causes || []).map(x => new Set(tokens(x))).filter(x => x.size);
  if (!refs.size && !causes.length) return scored;
  const bonus = top[0].score * 0.5, seeds = new Set(top.map(c => c.id));
  return scored.map(c => {
    if (seeds.has(c.id) || !['tsb', 'recall', 'issue'].includes(c.kind)) return c;
    const byRef = [...refsIn(c.title)].some(r => refs.has(r));
    const tt = new Set(tokens(c.title.replace(/^(Known issue|TSB|Recall):?/, '')));
    const byCause = causes.some(cs => [...tt].filter(w => cs.has(w)).length >= Math.min(2, tt.size));
    return byRef || byCause ? { ...c, score: c.score + bonus * (byRef ? 1 : 0.8) } : c;
  });
}

const HEADER = 'RESEARCH FINDINGS FOR THIS CAR (compiled Nov 2026 from owner manuals, NHTSA, TSBs, service bulletins and owner forums; selected for this question. Cite them, with the source link when one is given):';
const ALWAYS_SHARE = 0.5;

/**
 * Pick research for the prompt. Returns { text, selected: [ids], chunks: n }. text.length <= budget, always.
 * query: [{ text, weight }] (newest message weight 1, earlier turns less). openTodos: [{ title }].
 */
export function selectResearch(data, md, { query = [], openTodos = [], budget = RESEARCH_BUDGET } = {}) {
  const chunks = researchChunks(data || {}, md || '');
  const scored = followRefs(scoreChunks(chunks, queryTerms(query)));
  const live = liveDiagnoses(chunks, openTodos);
  const parts = [], selected = [];
  let used = 0;
  const room = () => budget - used;
  const push = (s, id) => { parts.push(s); used += s.length + 1; if (id) selected.push(id); };
  if (HEADER.length + 1 > budget) return { text: '', selected, chunks: chunks.length };
  push(HEADER);

  // 1) always: core facts, then live-symptom diagnoses (most relevant first); capped at half the budget
  const alwaysCap = Math.floor(budget * ALWAYS_SHARE);
  const always = [scored.find(c => c.id === 'vehicle'), ...scored.filter(c => live.has(c.id)).sort((a, b) => b.score - a.score)].filter(Boolean);
  let alwaysUsed = 0;
  for (const c of always) {
    const left = Math.min(alwaysCap - alwaysUsed, room()) - 1;
    if (left < 200) break;
    const t = c.text.length <= left ? c.text : c.text.slice(0, left - 1) + '…';
    push(t, c.id);
    alwaysUsed += t.length + 1;
  }
  const taken = new Set(selected);

  // 2) most relevant chunks, best first; skip ones that don't fit, keep trying smaller ones
  const ranked = scored.filter(c => !taken.has(c.id) && c.score > 0).sort((a, b) => b.score - a.score);
  const INDEX_RESERVE = Math.min(1500, Math.floor(budget * 0.08));
  let headerDone = false;
  for (const c of ranked) {
    const head = headerDone ? 0 : 'Most relevant to the question:'.length + 1;
    if (c.text.length + 1 + head > room() - INDEX_RESERVE) continue;
    if (!headerDone) { push('Most relevant to the question:'); headerDone = true; }
    push(c.text, c.id);
    taken.add(c.id);
  }

  // 3) titles of everything else, so the model knows what else is on file
  const rest = scored.filter(c => !taken.has(c.id) && c.kind !== 'md-sources');
  if (rest.length) {
    let line = 'Other research on file (not included here; say so if one looks relevant):';
    if (line.length + 1 < room()) {
      for (const c of rest.sort((a, b) => b.score - a.score)) {
        const add = ` ${c.title};`;
        if (line.length + add.length + 1 > room()) break;
        line += add;
      }
      push(line);
    }
  }
  const text = parts.join('\n');
  return { text: text.length <= budget ? text : text.slice(0, budget), selected, chunks: chunks.length };
}
