// Guided diagnosis: a plan (ordered checks for a car + symptom) walked one step at a time, from the app or from Claude (MCP).
// Plans are data: research-built ones come from research/<car>/diagnosis-plans.json (scripts/load-research.mjs); a symptom
// with no plan can get an AI-generated one (generatePlan, marked "AI-generated, check before trusting").
// A session stores a snapshot of the plan it started with, so editing a plan never breaks a running session.
// The state of a session (current step, ranking of causes, found / complete) is recomputed from the recorded results every
// time (computeState), which makes skip, resume and going back to change an answer trivial. Pure parts are unit-tested in
// test/diagnosis.test.mjs; the DB parts run against SQLite there too.
import { HttpError, int, newId, nowSec, str, todayLocal } from './util.js';
import { queryTerms, stem, tokens } from './research-context.js';
import { robustAnswer, logAnswer } from './answer.js';
import { carContext, systemPrompt } from './mechanic.js';
import { createTodo } from './ops.js';

export const AI_WARNING = 'AI-generated, check before trusting';
export const EFFECTS = ['confirm', 'up', 'down', 'rule_out'];
export const CONFIDENCE = ['high', 'medium', 'low'];
export const STATUSES = ['active', 'found', 'inconclusive', 'abandoned'];
const UNSURE = { key: 'unsure', label: "Couldn't tell / not sure", means: 'No change; moving on.', effects: {} };
// Absolute app links in replies: set per request by index.js (APP_ORIGIN or the request's origin).
let BASE = '';
export function setDiagOrigin(o) { if (o) BASE = o.replace(/\/$/, ''); }

// ---------------------------------------------------------------------------- plan shape
const LIK = [['very low', 0.5], ['low-medium', 1.5], ['low', 1], ['medium-high', 3], ['medium', 2], ['high', 4], ['normal', 1.5]];
/** "high", "medium-high", "high if airflow is stuck", "normal" ... -> prior weight. */
export function likelihoodWeight(s) {
  const t = String(s || '').toLowerCase().trim();
  for (const [k, w] of LIK) if (t.startsWith(k)) return w;
  for (const [k, w] of LIK) if (t.includes(k)) return w;
  return 2;
}
const isUrl = u => /^https?:\/\/[^\s]+$/.test(String(u || ''));
const asList = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Fill defaults (and the implicit "not sure" option) so the engine and the UI can rely on the shape. */
export function normalizePlan(p) {
  const plan = { ...p };
  plan.aliases = asList(p.aliases).map(String);
  plan.todo_match = asList(p.todo_match).map(String);
  plan.causes = asList(p.causes).map(c => ({ ...c, parts: asList(c.parts), keywords: asList(c.keywords), sources: asList(c.sources) }));
  plan.steps = asList(p.steps).map(s => {
    const options = asList(s.options).map(o => ({ ...o, effects: o.effects && typeof o.effects === 'object' ? o.effects : {} }));
    if (!options.some(o => o.key === 'unsure')) options.push({ ...UNSURE });
    return { ...s, tools: asList(s.tools).map(String), safety: asList(s.safety).map(String), tests: asList(s.tests).map(String), sources: asList(s.sources).map(String), options };
  });
  return plan;
}

/** Problems with a plan, as plain sentences (empty = valid). ai=true relaxes the per-step source requirement. */
export function validatePlan(p, { ai = false } = {}) {
  const e = [];
  if (!p || typeof p !== 'object') return ['plan is not an object'];
  const plan = normalizePlan(p);
  for (const k of ['id', 'symptom', 'title']) if (!plan[k] || typeof plan[k] !== 'string') e.push(`missing ${k}`);
  if (plan.id && !/^[a-z0-9][a-z0-9_-]{2,80}$/.test(plan.id)) e.push(`bad id "${plan.id}"`);
  if (!Number.isInteger(plan.version) || plan.version < 1) e.push('version must be a positive integer');
  if (!plan.causes.length) e.push('no causes');
  if (!plan.steps.length) e.push('no steps');
  if (plan.steps.length > 20) e.push('more than 20 steps');
  const causeIds = new Set();
  for (const c of plan.causes) {
    if (!c.id || !/^[a-z0-9_]{1,40}$/.test(c.id)) e.push(`cause with bad id "${c.id}"`);
    if (causeIds.has(c.id)) e.push(`duplicate cause id "${c.id}"`);
    causeIds.add(c.id);
    if (!c.name) e.push(`cause ${c.id}: no name`);
  }
  const stepIds = new Set();
  plan.steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s.id || '?'})`;
    if (!s.id || !/^[a-z0-9_]{1,40}$/.test(s.id)) e.push(`${at}: bad id`);
    if (stepIds.has(s.id)) e.push(`${at}: duplicate id`);
    stepIds.add(s.id);
    for (const k of ['title', 'do', 'look_for']) if (!s[k] || typeof s[k] !== 'string') e.push(`${at}: missing ${k}`);
    if (s.minutes != null && !(Number(s.minutes) > 0 && Number(s.minutes) <= 600)) e.push(`${at}: minutes out of range`);
    for (const t of s.tests) if (!causeIds.has(t)) e.push(`${at}: tests unknown cause "${t}"`);
    if (!ai && !s.sources.length) e.push(`${at}: no sources`);
    for (const u of s.sources) if (!isUrl(u)) e.push(`${at}: source is not a URL: ${String(u).slice(0, 60)}`);
    const real = s.options.filter(o => o.key !== 'unsure');
    if (real.length < 2) e.push(`${at}: needs at least 2 result options`);
    if (s.options.length > 9) e.push(`${at}: more than 9 options`);
    const keys = new Set();
    for (const o of s.options) {
      if (!o.key || !/^[a-z0-9_]{1,30}$/.test(o.key)) e.push(`${at}: option with bad key "${o.key}"`);
      if (keys.has(o.key)) e.push(`${at}: duplicate option "${o.key}"`);
      keys.add(o.key);
      if (!o.label) e.push(`${at} option ${o.key}: no label`);
      if (!o.means) e.push(`${at} option ${o.key}: no "means"`);
      for (const [c, eff] of Object.entries(o.effects)) {
        if (!causeIds.has(c)) e.push(`${at} option ${o.key}: effect on unknown cause "${c}"`);
        if (!EFFECTS.includes(eff)) e.push(`${at} option ${o.key}: effect "${eff}" (use ${EFFECTS.join('/')})`);
      }
      if (o.found != null && !causeIds.has(o.found)) e.push(`${at} option ${o.key}: found unknown cause "${o.found}"`);
      if (o.confidence != null && !CONFIDENCE.includes(o.confidence)) e.push(`${at} option ${o.key}: confidence "${o.confidence}"`);
    }
  });
  return e;
}

// ---------------------------------------------------------------------------- engine
/**
 * Replay the recorded results over the plan.
 * results: { [step_id]: { result: option key | 'skipped', notes?, mileage? } }
 * Answered steps apply their effects in plan order (an answer that ends the diagnosis stops the replay; later answers are
 * kept but ignored until that answer changes). The current step is the first one neither answered nor skipped, and not
 * made pointless by the results (every cause it tests already ruled out).
 */
export function computeState(planIn, results = {}) {
  const plan = normalizePlan(planIn);
  const causes = new Map(plan.causes.map(c => [c.id, { id: c.id, name: c.name, score: likelihoodWeight(c.likelihood), status: 'open' }]));
  const answered = [], skipped = [], ignored = [];
  let found = null;
  for (const s of plan.steps) {
    const r = results[s.id];
    if (!r) continue;
    if (found) { if (r.result !== 'skipped') ignored.push(s.id); continue; }
    if (r.result === 'skipped') { skipped.push(s.id); continue; }
    const o = s.options.find(x => x.key === r.result) || UNSURE;
    const delta = applyEffects(causes, o.effects);
    answered.push({ step: s.id, option: o.key, ...delta });
    if (o.found) found = { cause: o.found, confidence: o.confidence || 'medium', step: s.id, option: o.key };
  }
  const notNeeded = [], pending = [];
  let current = null;
  if (!found) {
    for (const s of plan.steps) {
      if (results[s.id]) continue;
      if (s.tests.length && s.tests.every(c => causes.get(c)?.status === 'ruled_out')) { notNeeded.push(s.id); continue; }
      if (!current) current = s.id; else pending.push(s.id);
    }
  }
  const outcome = found ? 'found' : current ? 'in_progress' : skipped.length ? 'skipped_left' : 'complete';
  return { outcome, found, current, pending, skipped, not_needed: notNeeded, answered, ignored, ranking: rank([...causes.values()]) };
}

function applyEffects(causes, effects) {
  const out = { confirmed: [], ruled_out: [], up: [], down: [] };
  for (const [id, eff] of Object.entries(effects || {})) {
    const c = causes.get(id);
    if (!c) continue;
    if (eff === 'rule_out') { c.status = 'ruled_out'; out.ruled_out.push(id); }
    else if (eff === 'confirm') { c.status = 'confirmed'; c.score *= 4; out.confirmed.push(id); }
    else if (eff === 'up') { if (c.status === 'ruled_out') c.status = 'open'; c.score *= 2; out.up.push(id); }
    else if (eff === 'down') { c.score *= 0.5; out.down.push(id); }
  }
  return out;
}

/** Confirmed first, then open causes by score (with a plain-word standing), ruled-out last. */
export function rank(list) {
  const open = list.filter(c => c.status === 'open');
  const total = open.reduce((n, c) => n + c.score, 0) || 1;
  const order = { confirmed: 0, open: 1, ruled_out: 2 };
  return [...list].sort((a, b) => order[a.status] - order[b.status] || b.score - a.score).map(c => {
    const share = c.status === 'open' ? c.score / total : null;
    const standing = c.status === 'confirmed' ? 'confirmed' : c.status === 'ruled_out' ? 'ruled out' : share >= 0.25 ? 'leading' : share >= 0.1 ? 'possible' : 'unlikely';
    return { id: c.id, name: c.name, status: c.status, standing, score: Math.round(c.score * 100) / 100, share: share == null ? null : Math.round(share * 100) / 100 };
  });
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const OPT_STOP = new Set(['the', 'a', 'an', 'it', 'is', 'and', 'or', 'i', 'of', 'to', 'at', 'on', 'in', 'my', 'was', 'its']);
const optTokens = s => norm(s).split(' ').filter(w => w.length > 1 && !OPT_STOP.has(w)).map(stem);
/** A result typed loosely ("both run", "2", "Both fans", "both") -> the step's option, or null. */
export function matchOption(stepIn, input) {
  const step = normalizePlan({ steps: [stepIn], causes: [] }).steps[0];
  const s = norm(input);
  if (!s) return null;
  const opts = step.options;
  const exact = opts.find(o => o.key === String(input).trim() || norm(o.key) === s || norm(o.label) === s);
  if (exact) return exact;
  if (/^\d+$/.test(s) && opts[Number(s) - 1]) return opts[Number(s) - 1];
  if (/^(not sure|unsure|dunno|don t know|couldn t tell|no idea)\b/.test(s)) return opts.find(o => o.key === 'unsure');
  const want = new Set(optTokens(s));
  if (!want.size) return null;
  let best = null, bestScore = 0, tie = false;
  for (const o of opts) {
    const have = new Set(optTokens(`${o.label} ${o.key.replace(/_/g, ' ')}`));
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    const sc = hit / Math.max(want.size, 1) + (norm(o.label).startsWith(s) ? 0.5 : 0);
    if (sc > bestScore) { best = o; bestScore = sc; tie = false; } else if (sc === bestScore && sc > 0) tie = true;
  }
  return bestScore >= 0.5 && !tie ? best : null;
}

// ---------------------------------------------------------------------------- plan matching
const carMatch = (plan, car) => plan.car_id === car.id || (plan.vehicle && Number(plan.vehicle.year) === Number(car.year)
  && norm(plan.vehicle.make) === norm(car.make) && norm(plan.vehicle.model) === norm(car.model));

/** Plans for this car ranked against the symptom text. Returns [{ plan, score }] best first (score 0..~2). */
export function rankPlans(plans, car, symptom) {
  const q = queryTerms([{ text: symptom, weight: 1 }]);
  const direct = new Set(tokens(symptom));
  const directSum = [...direct].length || 1;
  const s = norm(symptom);
  return plans.filter(p => carMatch(p, car)).map(p => {
    const have = new Set(tokens(`${p.symptom} ${p.title} ${(p.aliases || []).join(' ')}`));
    let sc = 0;
    for (const [t, w] of q) if (have.has(t)) sc += w;
    sc /= directSum;
    if (s && [p.symptom, p.title, ...(p.aliases || [])].some(a => { const n = norm(a); return n && (s.includes(n) || n.includes(s)); })) sc += 0.6;
    return { plan: p, score: Math.round(sc * 100) / 100 };
  }).sort((a, b) => b.score - a.score);
}
export const MATCH_MIN = 0.6;

// ---------------------------------------------------------------------------- DB
export async function loadPlans(env) {
  const { results } = await env.DB.prepare("SELECT id, car_id, version, source, data FROM diag_plans WHERE status = 'active'").all();
  return results.map(r => ({ ...normalizePlan(JSON.parse(r.data)), id: r.id, car_id: r.car_id, version: r.version, source: r.source }));
}
export async function plansForCar(env, car) {
  return (await loadPlans(env)).filter(p => carMatch(p, car));
}

async function loadSession(env, id) {
  const s = await env.DB.prepare('SELECT * FROM diag_sessions WHERE id = ?1').bind(String(id || '')).first();
  if (!s) throw new HttpError(404, 'Diagnosis session not found. list_diagnoses shows the open ones.');
  const { results } = await env.DB.prepare('SELECT * FROM diag_results WHERE session_id = ?1').bind(s.id).all();
  const car = await env.DB.prepare('SELECT * FROM cars WHERE id = ?1').bind(s.car_id).first();
  return { s, plan: normalizePlan(JSON.parse(s.plan)), results: Object.fromEntries(results.map(r => [r.step_id, r])), car };
}

/** Link the session to an open to-do: the one given, else the first open to-do whose text matches the plan's todo_match words. */
async function relatedTodos(env, carId, plan, explicit = null) {
  const { results } = await env.DB.prepare("SELECT * FROM todos WHERE car_id = ?1 AND status = 'open' ORDER BY created_at").bind(carId).all();
  const words = plan.todo_match.map(w => w.toLowerCase());
  const hits = results.filter(t => t.id === explicit || words.some(w => `${t.title} ${t.notes || ''}`.toLowerCase().includes(w)));
  return { all: results, hits };
}

/**
 * Start (or resume) a diagnosis. input: { symptom?, plan_id?, todo_id?, generate?, fresh?, test? }.
 * No plan for the symptom: returns { needs_plan: true, ... } unless generate is set (then the AI writes one).
 */
export async function startDiagnosis(env, car, input, member) {
  const symptom = str(input.symptom, 300) || '';
  let plan = null, matches = [];
  const plans = await plansForCar(env, car);
  if (input.plan_id) {
    plan = plans.find(p => p.id === input.plan_id);
    if (!plan) throw new HttpError(404, `No plan "${input.plan_id}" for the ${car.nickname}. Plans: ${plans.map(p => p.id).join(', ') || 'none'}`);
  } else {
    if (!symptom && !input.todo_id) throw new HttpError(400, 'What symptom? e.g. "overheating", "coolant loss", "tick".');
    let text = symptom;
    if (!text && input.todo_id) {
      const t = await env.DB.prepare('SELECT title FROM todos WHERE id = ?1 AND car_id = ?2').bind(input.todo_id, car.id).first();
      text = t?.title || '';
    }
    matches = rankPlans(plans, car, text);
    if (matches[0] && matches[0].score >= MATCH_MIN && !(matches[1] && matches[1].score === matches[0].score)) plan = matches[0].plan;
    if (!plan && input.generate) plan = await generatePlan(env, car, text, member);
    if (!plan) {
      return {
        needs_plan: true, car: car.nickname, symptom: text,
        close_matches: matches.filter(m => m.score > 0.2).slice(0, 3).map(m => ({ plan_id: m.plan.id, title: m.plan.title, score: m.score })),
        available_plans: plans.map(p => ({ plan_id: p.id, title: p.title, source: p.source })),
        next_step: `No ready-made plan matches "${text}" for the ${car.nickname}. Offer the user: (a) one of the available plans (call start_diagnosis with plan_id), or (b) a plan generated by the garage AI from the car's research (takes 1-3 minutes and is marked "${AI_WARNING}"): call start_diagnosis again with generate: true.`,
      };
    }
  }
  // resume an open session on the same plan instead of starting a duplicate
  if (!input.fresh) {
    const open = await env.DB.prepare("SELECT id FROM diag_sessions WHERE car_id = ?1 AND plan_id = ?2 AND status = 'active' ORDER BY updated_at DESC LIMIT 1").bind(car.id, plan.id).first();
    if (open) return { ...(await sessionView(env, open.id, { intro: true })), resumed: true };
  }
  const { hits } = await relatedTodos(env, car.id, plan, input.todo_id || null);
  const todoId = input.todo_id && hits.some(t => t.id === input.todo_id) ? input.todo_id : hits[0]?.id || null;
  const id = newId(), now = nowSec();
  const snapshot = { ...plan };
  await env.DB.prepare(`INSERT INTO diag_sessions (id, car_id, plan_id, plan_version, plan, symptom, todo_id, status, started_by, started_by_id, is_test, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?10, ?11, ?11)`)
    .bind(id, car.id, plan.id, plan.version || 1, JSON.stringify(snapshot), symptom || plan.symptom, todoId, member?.name || null, member?.id || null, input.test ? 1 : 0, now).run();
  return { ...(await sessionView(env, id, { intro: true })), resumed: false };
}

const causeName = (plan, id) => plan.causes.find(c => c.id === id)?.name || id;
const stepNo = (plan, id) => plan.steps.findIndex(s => s.id === id) + 1;

function stepCard(plan, stepId) {
  const s = plan.steps.find(x => x.id === stepId);
  if (!s) return null;
  return {
    id: s.id, number: stepNo(plan, s.id), of: plan.steps.length, title: s.title,
    safety: s.safety, do: s.do, look_for: s.look_for, tools: s.tools, minutes: s.minutes ?? null,
    options: s.options.map(o => ({ key: o.key, label: o.label })), sources: s.sources,
  };
}

/** Everything a phone screen or a chat needs about a session: one step, the latest interpretation, the standing of causes. */
export async function sessionView(env, id, { intro = false, last = null } = {}) {
  const { s, plan, results, car } = await loadSession(env, id);
  const st = computeState(plan, results);
  const answeredN = st.answered.length, skippedN = st.skipped.length;
  const finished = s.status !== 'active';
  const view = {
    session_id: s.id, car: car?.nickname || s.car_id, car_id: s.car_id, symptom: s.symptom, status: s.status,
    plan: { id: plan.id, title: plan.title, version: s.plan_version, source: plan.source || 'research', ...(plan.source === 'ai' ? { warning: AI_WARNING } : {}) },
    started_by: s.started_by, started: new Date(s.created_at * 1000).toISOString().slice(0, 10), updated_at: s.updated_at,
    progress: { answered: answeredN, skipped: skippedN, total: plan.steps.length, text: `${answeredN} of ${plan.steps.length} checks done${skippedN ? `, ${skippedN} skipped` : ''}` },
    ...(intro && !finished ? { intro: plan.intro || null, safety_overview: plan.safety_overview || null } : {}),
    ...(last ? { last_result: last } : {}),
    step: !finished && st.current ? stepCard(plan, st.current) : null,
    found: st.found ? { cause: causeName(plan, st.found.cause), cause_id: st.found.cause, confidence: st.found.confidence, at_step: plan.steps.find(x => x.id === st.found.step)?.title, ...pick(plan.causes.find(c => c.id === st.found.cause), ['fix', 'cost']) } : null,
    outcome: st.outcome,
    likely_causes: st.ranking.filter(c => c.status !== 'ruled_out').slice(0, 4).map(c => ({ cause: c.name, standing: c.standing })),
    ruled_out: st.ranking.filter(c => c.status === 'ruled_out').map(c => c.name),
    skipped_steps: st.skipped.map(x => ({ id: x, title: plan.steps.find(p => p.id === x)?.title })),
    history: plan.steps.filter(p => results[p.id]).map(p => {
      const r = results[p.id], o = p.options.find(x => x.key === r.result);
      return { step: p.id, number: stepNo(plan, p.id), title: p.title, result: r.result === 'skipped' ? 'skipped' : o?.label || r.result, notes: r.notes || undefined, mileage: r.mileage ?? undefined, ignored: st.ignored.includes(p.id) || undefined };
    }),
    ...(finished ? { conclusion: s.conclusion, confidence: s.confidence, summary: s.summary, finished: s.finished_at ? new Date(s.finished_at * 1000).toISOString().slice(0, 10) : null, service_id: s.service_id, fix_todo_id: s.fix_todo_id } : {}),
    app_link: `${BASE}/#/diag/${s.id}`,
  };
  view.next_step = finished ? 'This diagnosis is finished. Start a new one with start_diagnosis (fresh: true) if needed.'
    : st.outcome === 'found' ? `The plan says this is it: ${view.found.cause} (${view.found.confidence} confidence). Tell the user, then ask whether to wrap up; call finish_diagnosis. Its reply proposes a fix to-do; create it only after they say yes (finish_diagnosis again with create_fix_todo: true). They can also change an earlier answer with record_check_result.`
    : st.outcome === 'in_progress' ? 'Read the user ONLY this step: safety notes first (never skip them), then what to do and what to look for, then offer the result options. Wait for their answer and call record_check_result. "Can\'t do that now" = skip_step.'
    : st.outcome === 'skipped_left' ? `All other checks are done. Skipped: ${view.skipped_steps.map(x => x.title).join('; ')}. Offer to do one now (record_check_result with that step) or finish_diagnosis.`
    : 'Every check is done and nothing was conclusive. Summarize the remaining likely causes from likely_causes (don\'t go beyond them), then finish_diagnosis.';
  view._text = renderText(view);
  return view;
}
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] != null).map(k => [k, o[k]]));

/** Short, phone-friendly text (what the MCP returns as text content). */
export function renderText(v) {
  const L = [];
  L.push(`${v.car}: ${v.symptom}${v.plan.warning ? ` [${v.plan.warning}]` : ''}`);
  L.push(`${v.progress.text}. Session ${v.session_id}.`);
  if (v.intro) L.push('', v.intro);
  if (v.safety_overview) L.push('', `SAFETY: ${v.safety_overview}`);
  if (v.last_result) {
    const r = v.last_result;
    L.push('', `Result for "${r.step_title}": ${r.answer}`, r.means);
    if (r.confirmed.length) L.push(`Confirmed: ${r.confirmed.join('; ')}`);
    if (r.ruled_out.length) L.push(`Ruled out: ${r.ruled_out.join('; ')}`);
    if (r.more_likely.length) L.push(`More likely now: ${r.more_likely.join('; ')}`);
    if (r.less_likely.length) L.push(`Less likely now: ${r.less_likely.join('; ')}`);
    if (r.stop) L.push(`STOP: ${r.stop}`);
  }
  if (v.status !== 'active') {
    L.push('', `Finished (${v.status}${v.confidence ? `, ${v.confidence} confidence` : ''}): ${v.conclusion || ''}`);
  } else if (v.found) {
    L.push('', `FOUND: ${v.found.cause} (${v.found.confidence} confidence).${v.found.fix ? ` Fix: ${v.found.fix}.` : ''}${v.found.cost ? ` Cost: ${v.found.cost}.` : ''}`);
  } else if (v.step) {
    const s = v.step;
    L.push('', `Step ${s.number} of ${s.of}: ${s.title}${s.minutes ? ` (~${s.minutes} min)` : ''}`);
    if (s.safety.length) L.push(`SAFETY: ${s.safety.join(' ')}`);
    L.push(`Do: ${s.do}`, `Look for: ${s.look_for}`);
    if (s.tools.length) L.push(`Tools: ${s.tools.join(', ')}`);
    L.push('Answers:', ...s.options.map((o, i) => `${i + 1}. ${o.label} [${o.key}]`));
  } else if (v.skipped_steps.length) {
    L.push('', `Skipped checks left: ${v.skipped_steps.map(x => x.title).join('; ')}`);
  }
  if (v.status === 'active' && v.likely_causes.length) L.push('', `Most likely now: ${v.likely_causes.map(c => `${c.cause} (${c.standing})`).join('; ')}`);
  if (v.status === 'active' && v.ruled_out.length) L.push(`Ruled out: ${v.ruled_out.join('; ')}`);
  L.push('', `Next: ${v.next_step}`, `App: ${v.app_link}`);
  return L.join('\n');
}

/** Record (or change) the result of a step. step defaults to the current one. */
export async function recordResult(env, id, input, member) {
  const { s, plan, results } = await loadSession(env, id);
  if (s.status !== 'active') throw new HttpError(409, `This diagnosis is already finished (${s.status}).`);
  const before = computeState(plan, results);
  const stepId = resolveStep(plan, input.step, before.current);
  const step = plan.steps.find(x => x.id === stepId);
  const opt = matchOption(step, input.result);
  if (!opt) throw new HttpError(400, `"${String(input.result ?? '').slice(0, 80)}" doesn't match an answer for "${step.title}". Answers: ${step.options.map((o, i) => `${i + 1}. ${o.label} [${o.key}]`).join('; ')}`);
  const mileage = int(input.mileage, { max: 2_000_000, name: 'Mileage' });
  const changed = results[stepId] && results[stepId].result !== 'skipped' && results[stepId].result !== opt.key;
  await env.DB.prepare(`INSERT INTO diag_results (session_id, step_id, result, notes, mileage, recorded_by, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (session_id, step_id) DO UPDATE SET result = excluded.result, notes = COALESCE(excluded.notes, diag_results.notes), mileage = COALESCE(excluded.mileage, diag_results.mileage), recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`)
    .bind(s.id, stepId, opt.key, str(input.notes, 2000), mileage, member?.name || null, nowSec()).run();
  await env.DB.prepare('UPDATE diag_sessions SET updated_at = ?1 WHERE id = ?2').bind(nowSec(), s.id).run();
  const after = computeState(plan, { ...results, [stepId]: { result: opt.key } });
  const delta = after.answered.find(a => a.step === stepId) || { confirmed: [], ruled_out: [], up: [], down: [] };
  const names = ids => ids.map(x => causeName(plan, x));
  const last = {
    step: stepId, step_title: step.title, answer: opt.label, means: opt.means, changed_earlier_answer: !!changed || undefined,
    confirmed: names(delta.confirmed), ruled_out: names(delta.ruled_out), more_likely: names(delta.up), less_likely: names(delta.down),
    ...(opt.stop ? { stop: opt.stop } : {}), ...(after.ignored.includes(stepId) ? { note: 'An earlier answer already ended the diagnosis, so this one is saved but not counted.' } : {}),
  };
  return sessionView(env, s.id, { last });
}

/** "Can't do that now": mark a step skipped (it is offered again at the end). */
export async function skipStep(env, id, input, member) {
  const { s, plan, results } = await loadSession(env, id);
  if (s.status !== 'active') throw new HttpError(409, `This diagnosis is already finished (${s.status}).`);
  const stepId = resolveStep(plan, input.step, computeState(plan, results).current);
  await env.DB.prepare(`INSERT INTO diag_results (session_id, step_id, result, notes, recorded_by, recorded_at) VALUES (?1, ?2, 'skipped', ?3, ?4, ?5)
    ON CONFLICT (session_id, step_id) DO UPDATE SET result = 'skipped', notes = COALESCE(excluded.notes, diag_results.notes), recorded_by = excluded.recorded_by, recorded_at = excluded.recorded_at`)
    .bind(s.id, stepId, str(input.reason, 500), member?.name || null, nowSec()).run();
  await env.DB.prepare('UPDATE diag_sessions SET updated_at = ?1 WHERE id = ?2').bind(nowSec(), s.id).run();
  const title = plan.steps.find(x => x.id === stepId).title;
  return sessionView(env, s.id, { last: { step: stepId, step_title: title, answer: 'Skipped', means: 'Skipped for now; it comes back at the end.', confirmed: [], ruled_out: [], more_likely: [], less_likely: [] } });
}

function resolveStep(plan, ref, current) {
  if (ref == null || ref === '') {
    if (!current) throw new HttpError(400, 'No current step (all checks answered or the diagnosis already points to a cause). Pass step to change an earlier answer.');
    return current;
  }
  const r = String(ref).trim();
  const byId = plan.steps.find(s => s.id === r);
  if (byId) return byId.id;
  if (/^\d+$/.test(r) && plan.steps[Number(r) - 1]) return plan.steps[Number(r) - 1].id;
  const n = norm(r);
  const byTitle = plan.steps.find(s => norm(s.title) === n) || plan.steps.find(s => norm(s.title).includes(n));
  if (byTitle) return byTitle.id;
  throw new HttpError(400, `No step "${r}". Steps: ${plan.steps.map((s, i) => `${i + 1}. ${s.title} [${s.id}]`).join('; ')}`);
}

// ---------------------------------------------------------------------------- finishing
async function partsFor(env, plan, cause) {
  if (!cause?.parts?.length) return [];
  const srcCar = plan.car_id || null;
  const pg = srcCar && await env.DB.prepare('SELECT data FROM parts_guides WHERE car_id = ?1').bind(srcCar).first();
  const parts = pg ? JSON.parse(pg.data).parts || [] : [];
  const { results: brands } = srcCar ? await env.DB.prepare('SELECT part, matched_part, data FROM brands WHERE car_id = ?1').bind(srcCar).all() : { results: [] };
  const out = [];
  for (const name of cause.parts) {
    const n = norm(name);
    const p = parts.find(x => norm(x.name) === n) || parts.find(x => norm(x.name).includes(n) || n.includes(norm(x.name)));
    const b = brands.find(x => norm(x.matched_part) === norm(p?.name || name) || norm(x.part) === n);
    const pickText = b ? JSON.parse(b.data).pick : null;
    const nums = (p?.part_numbers || []).slice(0, 3).map(x => `${x.brand} ${x.number}`);
    if (!p && !b) { out.push({ part: name }); continue; }
    out.push({ part: p?.name || b.part, numbers: nums, pick: pickText ? String(pickText).slice(0, 200) : undefined });
  }
  return out;
}

function summaryText(plan, view, { status, conclusion, confidence }) {
  const L = [`Guided diagnosis: ${plan.title}${plan.source === 'ai' ? ` (${AI_WARNING})` : ''}.`];
  L.push(`Result: ${status}${conclusion ? ` - ${conclusion}` : ''}${confidence ? ` (${confidence} confidence)` : ''}.`);
  if (view.history.length) {
    L.push('Checks:');
    for (const h of view.history) L.push(`- ${h.title}: ${h.result}${h.notes ? ` (${h.notes})` : ''}${h.ignored ? ' [after the finding; not counted]' : ''}`);
  }
  if (view.ruled_out.length) L.push(`Ruled out: ${view.ruled_out.join('; ')}.`);
  if (status !== 'found' && view.likely_causes.length) L.push(`Still possible: ${view.likely_causes.map(c => `${c.cause} (${c.standing})`).join('; ')}.`);
  L.push(`Session: ${view.app_link}`);
  return L.join('\n');
}

/**
 * End a session: write the summary to the car's history, note the finding on related open to-dos (never closing them),
 * and propose a fix to-do (created only when create_fix_todo is true, i.e. after the user said yes).
 * Calling it again on a finished session with create_fix_todo creates the proposed to-do once.
 */
export async function finishDiagnosis(env, id, input, member, createService) {
  const { s, plan, results, car } = await loadSession(env, id);
  const st = computeState(plan, results);
  let view = await sessionView(env, s.id);
  const foundId = s.status !== 'active' ? s.found_cause : st.found?.cause || st.ranking.find(c => c.status === 'confirmed')?.id || null;
  const cause = plan.causes.find(c => c.id === foundId) || null;
  const parts = await partsFor(env, plan, cause);
  const { hits: related, all: openTodos } = await relatedTodos(env, s.car_id, plan, s.todo_id);
  const proposal = cause ? {
    title: `Fix: ${cause.name}`.slice(0, 200),
    notes: [`Found by guided diagnosis (${plan.title}) on ${todayLocal()}.`, cause.fix && `Fix: ${cause.fix}`, cause.cost && `Cost: ${cause.cost}`,
      parts.length && `Parts:\n${parts.map(p => `- ${p.part}${p.numbers?.length ? `: ${p.numbers.join(', ')}` : ''}${p.pick ? `\n  pick: ${p.pick}` : ''}`).join('\n')}`,
      related.length && `Related to-dos: ${related.map(t => t.title).join('; ')}`, `Session: ${view.app_link}`].filter(Boolean).join('\n'),
    parts, related_todos: related.map(t => ({ id: t.id, title: t.title })),
  } : null;

  if (s.status !== 'active') {
    let fixId = s.fix_todo_id;
    if (input.create_fix_todo && !fixId && proposal) {
      fixId = await createTodo(env, s.car_id, { title: proposal.title, notes: proposal.notes, priority: 'high', source: `diagnosis:${s.id}`, reporter_id: member?.id }, member?.name);
      await env.DB.prepare('UPDATE diag_sessions SET fix_todo_id = ?1, updated_at = ?2 WHERE id = ?3').bind(fixId, nowSec(), s.id).run();
    }
    view = await sessionView(env, s.id);
    return { ...view, fix_todo_created: !!fixId && fixId !== s.fix_todo_id, fix_todo_id: fixId, ...(!fixId && proposal ? { fix_todo_proposal: proposal } : {}),
      note: 'Already finished; nothing was logged twice.', _text: `${view._text}${fixId && fixId !== s.fix_todo_id ? `\nFix to-do created: ${proposal.title}` : ''}` };
  }

  let status = input.status;
  if (status && !STATUSES.includes(status)) throw new HttpError(400, `status must be found, inconclusive or abandoned`);
  if (!status || status === 'active') status = st.found || cause ? 'found' : st.answered.length ? 'inconclusive' : 'abandoned';
  const userConclusion = str(input.conclusion, 1000);
  const conclusion = userConclusion || (cause ? cause.name : st.answered.length ? `Not pinned down. Most likely: ${view.likely_causes.slice(0, 2).map(c => c.cause).join('; ')}` : 'Stopped before any checks');
  const confidence = st.found ? st.found.confidence : cause ? 'medium' : status === 'found' ? 'user' : 'low';
  const summary = summaryText(plan, view, { status, conclusion, confidence });
  const maxMiles = Math.max(0, ...Object.values(results).map(r => r.mileage || 0)) || null;

  // history entry (only when something was actually checked)
  let serviceId = null;
  if (st.answered.length || userConclusion) {
    serviceId = await createService(env, s.car_id, {
      date: todayLocal(), mileage: maxMiles, diy: true,
      title: `Diagnosis: ${s.symptom}`.slice(0, 100) + ` - ${status === 'found' ? (cause?.name || conclusion) : status}`.slice(0, 60),
      details: summary.slice(0, 8000),
    }, member);
  }
  // notes on related open to-dos (finding + ruled-out causes they mention); never closed
  const ruled = st.ranking.filter(c => c.status === 'ruled_out').map(c => plan.causes.find(x => x.id === c.id)).filter(Boolean);
  const noted = [];
  for (const t of openTodos) {
    const text = `${t.title} ${t.notes || ''}`.toLowerCase();
    const isRelated = related.some(r => r.id === t.id);
    const ruledHere = ruled.filter(c => (c.keywords || []).some(k => k && text.includes(String(k).toLowerCase())));
    if (!isRelated && !ruledHere.length) continue;
    const lines = [`[${todayLocal()} guided diagnosis: ${plan.title}] ${status === 'found' ? `Found: ${conclusion} (${confidence} confidence).` : `Result: ${status}. ${conclusion}.`}`];
    if (ruledHere.length) lines.push(`Ruled out: ${ruledHere.map(c => c.name).join('; ')}.`);
    lines.push(`Details: ${view.app_link}`);
    await env.DB.prepare('UPDATE todos SET notes = substr(COALESCE(notes || char(10) || char(10), \'\') || ?1, -8000) WHERE id = ?2').bind(lines.join(' '), t.id).run();
    noted.push({ id: t.id, title: t.title, ruled_out: ruledHere.map(c => c.name) });
  }
  let fixId = null;
  if (input.create_fix_todo && proposal) fixId = await createTodo(env, s.car_id, { title: proposal.title, notes: proposal.notes, priority: 'high', source: `diagnosis:${s.id}`, reporter_id: member?.id }, member?.name);
  await env.DB.prepare(`UPDATE diag_sessions SET status = ?1, conclusion = ?2, confidence = ?3, found_cause = ?4, summary = ?5, service_id = ?6, fix_todo_id = ?7, updated_at = ?8, finished_at = ?8 WHERE id = ?9`)
    .bind(status, conclusion, confidence, cause?.id || null, summary, serviceId, fixId, nowSec(), s.id).run();
  view = await sessionView(env, s.id);
  const out = {
    ...view, history_entry: serviceId ? 'Summary saved to the car\'s history.' : 'Nothing was checked, so no history entry was written.',
    todos_noted: noted, fix_todo_id: fixId,
    ...(proposal && !fixId ? { fix_todo_proposal: proposal } : {}),
    next_step: proposal && !fixId ? 'Tell the user the conclusion, read the proposed fix to-do (title, parts) and ask whether to add it. Only after a yes: call finish_diagnosis again with create_fix_todo: true.' : 'Done. Tell the user the conclusion and that it was saved to the car\'s history.',
  };
  out._text = [view._text, '', out.history_entry, noted.length ? `Noted on to-dos (not closed): ${noted.map(n => n.title).join('; ')}` : '',
    proposal && !fixId ? `Proposed fix to-do: ${proposal.title}${parts.length ? `\nParts: ${parts.map(p => `${p.part}${p.numbers?.length ? ` (${p.numbers.join(', ')})` : ''}`).join('; ')}` : ''}\nAsk before creating it.` : '',
    fixId ? `Fix to-do created: ${proposal.title}` : '', `Next: ${out.next_step}`].filter(Boolean).join('\n');
  return out;
}

/** Sessions, active first (most recent first), then finished. */
export async function listSessions(env, { carId = null, status = null, limit = 20, includeTest = false } = {}) {
  const where = ['1 = 1'], args = [];
  if (carId) { args.push(carId); where.push(`d.car_id = ?${args.length}`); }
  if (status) { args.push(status); where.push(`d.status = ?${args.length}`); }
  if (!includeTest) where.push('d.is_test = 0');
  const { results } = await env.DB.prepare(`SELECT d.*, c.nickname, (SELECT COUNT(*) FROM diag_results r WHERE r.session_id = d.id AND r.result != 'skipped') AS answered
    FROM diag_sessions d JOIN cars c ON c.id = d.car_id WHERE ${where.join(' AND ')} ORDER BY d.status = 'active' DESC, d.updated_at DESC LIMIT ${Math.max(1, Math.min(100, Number(limit) || 20))}`).bind(...args).all();
  return results.map(r => {
    const plan = normalizePlan(JSON.parse(r.plan));
    return { session_id: r.id, car: r.nickname, car_id: r.car_id, symptom: r.symptom, plan: plan.title, source: plan.source || 'research', status: r.status,
      answered: r.answered, total: plan.steps.length, conclusion: r.conclusion || undefined, started_by: r.started_by, todo_id: r.todo_id, service_id: r.service_id, fix_todo_id: r.fix_todo_id,
      updated: new Date(r.updated_at * 1000).toISOString().slice(0, 10), app_link: `${BASE}/#/diag/${r.id}` };
  });
}

// ---------------------------------------------------------------------------- AI-generated plans
export const GEN_LIMITS = { startMs: 60_000, idleMs: 90_000, attemptMs: 150_000, totalMs: 210_000 };
const URL_RE = /https?:\/\/[^\s)\]"'<>|]+/g;

/** Pull the first JSON object out of a model answer (```json fences, prose around it). */
export function extractJson(text) {
  const t = String(text || '');
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}

/** Shape the model's plan: ids slugged, keys fixed, sources limited to URLs that were in the research context. */
export function shapeGenerated(raw, car, symptom, contextText) {
  const allowed = new Set((String(contextText || '').match(URL_RE) || []).map(u => u.replace(/[.,;]+$/, '')));
  const causes = asList(raw?.causes).slice(0, 12).map((c, i) => ({ id: slug(c.id || c.name) || `c${i + 1}`, name: str(c.name, 200) || `Cause ${i + 1}`, likelihood: str(c.likelihood, 40) || 'medium', fix: str(c.fix, 300), cost: str(c.cost, 120), parts: asList(c.parts).slice(0, 5).map(x => str(x, 120)).filter(Boolean), keywords: asList(c.keywords).slice(0, 6).map(x => str(x, 40)).filter(Boolean) }));
  const ids = new Set(causes.map(c => c.id));
  const fix = id => { const s = slug(id); return ids.has(s) ? s : null; };
  const steps = asList(raw?.steps).slice(0, 10).map((s, i) => ({
    id: slug(s.id || s.title) || `s${i + 1}`, title: str(s.title, 120) || `Check ${i + 1}`, do: str(s.do || s.instructions, 1500), look_for: str(s.look_for, 600),
    minutes: Number(s.minutes) > 0 ? Math.min(600, Math.round(Number(s.minutes))) : null, tools: asList(s.tools).slice(0, 8).map(x => str(x, 80)).filter(Boolean),
    safety: asList(s.safety).slice(0, 5).map(x => str(x, 300)).filter(Boolean), tests: asList(s.tests).map(fix).filter(Boolean),
    sources: asList(s.sources).map(u => String(u).trim()).filter(u => allowed.has(u)).slice(0, 4),
    options: asList(s.options).slice(0, 7).map((o, j) => {
      const effects = {};
      for (const [k, v] of Object.entries(o?.effects || {})) { const c = fix(k); if (c && EFFECTS.includes(v)) effects[c] = v; }
      // AI plans may end a diagnosis only at medium confidence (never high); a "low confidence" ending is just a shift in the ranking
      const found = o?.found && o.confidence !== 'low' ? fix(o.found) : null;
      return { key: slug(o?.key || o?.label) || `o${j + 1}`, label: str(o?.label, 120) || `Option ${j + 1}`, means: str(o?.means, 400) || 'Noted.', effects, ...(found ? { found, confidence: 'medium' } : {}), ...(o?.stop ? { stop: str(o.stop, 300) } : {}) };
    }).filter(o => o.key !== 'unsure'),
  }));
  // unique step / option ids
  const seen = new Set();
  for (const s of steps) { let id = s.id, n = 2; while (seen.has(id)) id = `${s.id}_${n++}`; s.id = id; seen.add(id); const ok = new Set(); s.options = s.options.filter(o => !ok.has(o.key) && ok.add(o.key)); }
  return {
    id: `ai-${slug(car.nickname).replace(/_/g, '-')}-${slug(symptom).replace(/_/g, '-').slice(0, 30)}-${Math.random().toString(36).slice(2, 6)}`.replace(/-+/g, '-'),
    car_id: car.id, vehicle: { year: car.year, make: car.make, model: car.model }, version: 1, source: 'ai', generated: true, warning: AI_WARNING,
    symptom: str(symptom, 200), title: str(raw?.title, 120) || `${car.nickname}: ${symptom}`.slice(0, 120),
    aliases: asList(raw?.aliases).slice(0, 8).map(x => str(x, 60)).filter(Boolean), todo_match: asList(raw?.todo_match).slice(0, 4).map(x => str(x, 40)).filter(Boolean),
    intro: str(raw?.intro, 600), safety_overview: str(raw?.safety_overview, 600), causes, steps,
  };
}

// The household's tools (garage.config.json "my_tools" -> var OWNER_TOOLS), so generated plans only ask for what they have.
let OWNER_TOOLS = 'basic hand tools, a flashlight, jack and jack stands; maybe a multimeter and an OBD-II code reader (ask before relying on them)';
export function setOwnerTools(t) { if (t && String(t).trim()) OWNER_TOOLS = String(t).trim().slice(0, 400); }
const GEN_PROMPT = (car, symptom) => `Write a guided diagnosis plan for this symptom on the ${car.year} ${car.make} ${car.model} ("${car.nickname}"): """${symptom}"""

The owner will do it themselves at the car, one check at a time. Their tools: ${OWNER_TOOLS}.

Rules:
- 4 to 8 steps, cheapest and most likely first, based on the research above (known issues, TSBs, symptom checklists). Mark anything not from the research as general knowledge in the step text.
- Each step: plain-language instructions for doing it at the car, tools, minutes, safety notes (hot cooling system under pressure, fans that start with the key on, jack stands, battery, airbags) whenever relevant, what to look for, and 2-5 result options.
- Each option: key (snake_case), label (short, what they'd see), means (one or two sentences: what it means), effects on causes ({cause_id: "confirm" | "up" | "down" | "rule_out"}), and only when that result really settles it (a direct observation of the fault, not a hint): "found": cause_id plus "confidence": "medium". Early listening/classifying steps never end the diagnosis.
- sources: only URLs that appear in the research above; [] if none fit.
- Don't invent part numbers or torque specs.

Reply with ONLY one JSON object, no prose:
{"title": "...", "aliases": ["..."], "todo_match": ["one or two words to find the related to-do"], "intro": "...", "safety_overview": "...",
 "causes": [{"id": "snake_case", "name": "...", "likelihood": "high|medium|low", "fix": "...", "cost": "...", "keywords": ["..."]}],
 "steps": [{"id": "snake_case", "title": "...", "do": "...", "look_for": "...", "tools": ["..."], "minutes": 10, "safety": ["..."], "tests": ["cause_id"], "sources": ["https://..."],
   "options": [{"key": "...", "label": "...", "means": "...", "effects": {"cause_id": "up"}, "found": "cause_id", "confidence": "medium"}]}]}`;

/** One model call (through robustAnswer), validated and stored. Throws HttpError with the reasons when unusable. */
export async function generatePlan(env, car, symptom, member, { limits = GEN_LIMITS } = {}) {
  if (!str(symptom, 300)) throw new HttpError(400, 'Describe the symptom to build a plan for.');
  // a car without its own research (e.g. a second car of the same model) borrows the research of a car with the same year/make/model
  let ctxCar = car.id;
  if (!await env.DB.prepare('SELECT 1 FROM research WHERE car_id = ?1').bind(car.id).first()) {
    const twin = await env.DB.prepare('SELECT c.id FROM cars c JOIN research r ON r.car_id = c.id WHERE c.archived = 0 AND c.year = ?1 AND lower(c.make) = lower(?2) AND lower(c.model) = lower(?3) LIMIT 1').bind(car.year, car.make, car.model).first();
    if (twin) ctxCar = twin.id;
  }
  const { text: ctxText } = await carContext(env, ctxCar, { query: [{ text: symptom, weight: 1 }] });
  const result = await robustAnswer(env, [{ role: 'system', content: systemPrompt(ctxText) }, { role: 'user', content: GEN_PROMPT(car, symptom) }], { maxTokens: 12000, temperature: 0.2, limits, extra: { reasoning_effort: 'low' } });
  // (at default effort glm-5.3 used all 12k tokens reasoning and returned nothing, twice, on Nov 24)
  const raw = result.status === 'failed' ? null : extractJson(result.text);
  const plan = raw ? shapeGenerated(raw, car, symptom, ctxText) : null;
  const errors = plan ? validatePlan(plan, { ai: true }) : [result.status === 'failed' ? `model failed: ${result.error}` : 'the model did not return a readable plan'];
  if (errors.length) {
    await logAnswer(env, 'diagnosis_plan', car.id, { ...result, outcome: 'failed', trace: [...(result.trace || []), { result: 'invalid', error: errors.slice(0, 5).join('; ').slice(0, 300) }] });
    throw new HttpError(424, `The garage AI couldn't produce a usable plan (${errors.slice(0, 3).join('; ')}). Try again, or pick one of the ready-made plans.`);
  }
  await logAnswer(env, 'diagnosis_plan', car.id, result);
  const now = nowSec();
  await env.DB.prepare(`INSERT INTO diag_plans (id, car_id, version, source, symptom, title, data, status, created_by, created_at, updated_at) VALUES (?1, ?2, 1, 'ai', ?3, ?4, ?5, 'active', ?6, ?7, ?7)`)
    .bind(plan.id, car.id, plan.symptom, plan.title, JSON.stringify(plan), member?.name || null, now).run();
  return normalizePlan(plan);
}
