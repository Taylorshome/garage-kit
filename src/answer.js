// Robust AI mechanic answers (chat + symptom first checks).
// glm-5.3 always reasons and the reasoning counts against max_tokens, so an answer can come back cut off
// (finish_reason "length") or empty. This wraps the model calls so that:
//   1. a cut-off answer is continued once, an empty / near-empty one is retried once (same model);
//   2. if it still isn't complete, the fallback model continues the partial answer (or answers fresh);
//   3. every call has a start timeout, an idle timeout between chunks and an overall deadline;
//   4. the caller gets status ok | truncated | failed, and anything other than a clean first answer is logged
//      (D1 ai_failures + a console line in Workers observability).
import { FALLBACK_MODEL, MODEL, pumpSse, withTimeout } from './ai.js';
import { nowSec } from './util.js';

export const LIMITS = { startMs: 60_000, idleMs: 90_000, attemptMs: 200_000, totalMs: 420_000 };
export const NEAR_EMPTY = 40;   // characters; anything shorter is not a real mechanic answer
export const CONTINUE_PROMPT = 'Your previous answer was cut off. Continue it exactly where it stopped: do not repeat anything already written, do not restart or summarise, just carry on from the last word.';

/** ok | empty | truncated for one attempt's (accumulated) text. */
export function classify(text, { finish = null, timedOut = false } = {}) {
  if (String(text || '').trim().length < NEAR_EMPTY) return 'empty';
  if (finish === 'length' || timedOut) return 'truncated';
  return 'ok';
}

/** Append a continuation, dropping any overlap where the model repeated the end of the previous text. */
export function joinContinuation(prev, next) {
  const p = String(prev || ''), n = String(next || '');
  const nt = n.replace(/^\s+/, '');
  for (let len = Math.min(300, p.length, nt.length); len >= 15; len--) {
    if (nt.startsWith(p.slice(-len))) return p + nt.slice(len);
  }
  if (!p || !n) return p + n;
  // mid-word / mid-sentence cut: keep the model's own leading whitespace, or add a space between words
  return /\s$/.test(p) || /^\s/.test(n) || /^[,.;:!?)\]]/.test(n) ? p + n : p + (/[\w*]$/.test(p) && /^[\w*(]/.test(n) ? ' ' : '') + n;
}

/**
 * One streamed model call. Text deltas go to onText as they arrive; returns { text, finish, timedOut, ms }.
 * Throws on a start timeout or a model error.
 */
async function attempt(env, model, messages, { maxTokens, temperature, extra = {}, onText, onReasoning, deadline, limits }) {
  const t0 = Date.now();
  const stop = Math.min(deadline, t0 + limits.attemptMs);
  const res = await withTimeout(env.AI.run(model, { messages, stream: true, max_tokens: maxTokens, temperature, ...extra }), Math.max(1000, Math.min(limits.startMs, stop - t0)), `${model} start`);
  let text = '';
  const out = await pumpSse(res, { onText: d => { text += d; onText?.(d); }, onReasoning, idleMs: limits.idleMs, deadline: stop });
  return { text, finish: out.finish, timedOut: out.timedOut, ms: Date.now() - t0 };
}

/**
 * messages: the full prompt (system + history ending with the user turn).
 * partial: an earlier cut-off answer to continue (the "tap to continue" button) instead of answering fresh.
 * hooks (all optional, for streaming to a client):
 *   onText(delta)  text to append to what the client shows
 *   onReset()      the client should clear what it shows (a fresh retry / fallback starts over)
 *   onStatus(msg)  short progress note ("The answer was cut off, continuing…")
 *   onReasoning()  the model is thinking (keep-alive tick)
 * extra: more model params, e.g. { reasoning_effort: 'low' } (plan generation: glm-5.3 otherwise spends the whole budget reasoning).
 * Returns { text, status: ok|truncated|failed, outcome: clean|recovered|truncated|failed, model, trace, error }.
 */
export async function robustAnswer(env, messages, { maxTokens = 16000, temperature = 0.4, partial = '', hooks = {}, limits = LIMITS, extra = {} } = {}) {
  const deadline = Date.now() + limits.totalMs;
  const trace = [];
  let text = String(partial || '');
  let model = MODEL, lastError = null;

  // Each step: which model, and whether it continues `text` or starts over.
  const run = async (m, mode) => {
    if (Date.now() >= deadline - 2000) { trace.push({ model: m, mode, result: 'skipped', reason: 'deadline' }); return null; }
    const cont = mode === 'continue';
    const msgs = cont ? [...messages, { role: 'assistant', content: text }, { role: 'user', content: CONTINUE_PROMPT }] : messages;
    if (!cont && text) hooks.onReset?.();
    // Continuations are buffered until the overlap with the previous text can be removed, then streamed.
    let head = '', flushed = !cont;
    const base = text;
    const emit = d => {
      if (flushed) { hooks.onText?.(d); return; }
      head += d;
      if (head.length >= 320) { flushed = true; const joined = joinContinuation(base, head); hooks.onText?.(joined.slice(base.length)); }
    };
    const rec = { model: m, mode };
    try {
      const r = await attempt(env, m, msgs, { maxTokens, temperature, extra, onText: emit, onReasoning: hooks.onReasoning, deadline, limits });
      if (cont && !flushed) { const joined = joinContinuation(base, head); hooks.onText?.(joined.slice(base.length)); }
      const merged = cont ? joinContinuation(base, r.text) : r.text;
      const result = cont ? (r.text.trim().length < 5 ? 'empty' : classify(merged, r)) : classify(r.text, r);
      Object.assign(rec, { result, chars: r.text.length, finish: r.finish, ms: r.ms, ...(r.timedOut ? { timed_out: true } : {}) });
      trace.push(rec);
      // keep the longest usable text: a continuation that added nothing must not wipe the partial
      if (cont) { if (r.text.trim()) text = merged; }
      else if (r.text.trim().length >= NEAR_EMPTY || !text) text = r.text;
      model = m;
      return result;
    } catch (e) {
      lastError = e;
      Object.assign(rec, { result: 'error', error: String(e.message || e).slice(0, 200), ...(e.timeout ? { timed_out: true } : {}) });
      trace.push(rec);
      if (cont && head) { const joined = joinContinuation(base, head); if (!flushed) hooks.onText?.(joined.slice(base.length)); text = joined; }
      return 'error';
    }
  };

  // 1. primary: fresh answer, or continue the given partial
  let r = await run(MODEL, text ? 'continue' : 'fresh');
  // 2. one automatic continue (cut off) or retry (empty) on the primary model
  if (r === 'truncated') { hooks.onStatus?.('The answer was cut off, continuing…'); r = await run(MODEL, 'continue'); }
  else if (r === 'empty') { hooks.onStatus?.('No answer came back, asking again…'); r = await run(MODEL, text.trim().length >= NEAR_EMPTY ? 'continue' : 'fresh'); }
  // 3. fallback model: continue a usable partial, else answer fresh
  if (r !== 'ok') {
    hooks.onStatus?.('Trying the backup model…');
    const usable = text.trim().length >= NEAR_EMPTY;
    r = await run(FALLBACK_MODEL, usable ? 'continue' : 'fresh');
  }
  const usable = text.trim().length >= NEAR_EMPTY;
  const status = r === 'ok' ? 'ok' : usable ? 'truncated' : 'failed';
  const outcome = status !== 'ok' ? status : trace.length === 1 && !partial ? 'clean' : 'recovered';
  return { text: usable ? text : '', status, outcome, model, trace, error: status === 'failed' ? (lastError?.message || 'no answer from the model') : null };
}

/** Record anything other than a clean answer: D1 row (health check reads it) + one console line (Workers observability). */
export async function logAnswer(env, kind, ref, result) {
  if (result.outcome === 'clean') return;
  const line = { kind, ref, outcome: result.outcome, model: result.model, trace: result.trace };
  (result.outcome === 'recovered' ? console.warn : console.error)('mechanic answer ' + JSON.stringify(line));
  try {
    await env.DB.prepare('INSERT INTO ai_failures (at, kind, ref, outcome, model, trace) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(nowSec(), kind, ref || null, result.outcome, result.model || null, JSON.stringify(result.trace).slice(0, 4000)).run();
  } catch (e) { console.error('ai_failures insert failed', e.message); }
}
