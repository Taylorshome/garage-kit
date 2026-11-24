// Workers AI helpers. Defaults (chosen after a side-by-side in Nov 2026): @cf/zai-org/glm-5.3 for the mechanic, with
// @cf/openai/gpt-oss-120b as fallback. Override in garage.config.json "ai" (vars AI_CHAT_MODEL / AI_CHAT_FALLBACK);
// configureModels(env) runs at the start of every request, and importers see the live bindings.
export const DEFAULT_MODEL = '@cf/zai-org/glm-5.3';
export const DEFAULT_FALLBACK = '@cf/openai/gpt-oss-120b';
export let MODEL = DEFAULT_MODEL;
export let FALLBACK_MODEL = DEFAULT_FALLBACK;
export function configureChatModels(env) {
  MODEL = env?.AI_CHAT_MODEL || DEFAULT_MODEL;
  FALLBACK_MODEL = env?.AI_CHAT_FALLBACK || DEFAULT_FALLBACK;
}

/** Reject with a TimeoutError-ish Error if p hasn't settled within ms. */
export function withTimeout(p, ms, what = 'request') {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => { const e = new Error(`${what} timed out after ${Math.round(ms / 1000)} s`); e.timeout = true; rej(e); }, ms); })])
    .finally(() => clearTimeout(t));
}

/** One non-streamed call with a timeout, falling back to the second model on any error (used by email extraction). */
export async function runWithFallback(env, body, { timeoutMs = 90_000 } = {}) {
  try { return { model: MODEL, res: await withTimeout(env.AI.run(MODEL, body), timeoutMs, MODEL) }; }
  catch (e) {
    console.warn('primary model failed', e.message);
    return { model: FALLBACK_MODEL, res: await withTimeout(env.AI.run(FALLBACK_MODEL, body), timeoutMs, FALLBACK_MODEL) };
  }
}

export const textOf = res => {
  const msg = res?.choices?.[0]?.message;
  if (msg && typeof msg.content === 'string') return msg.content;
  if (typeof res?.response === 'string') return res.response;
  if (res?.response && typeof res.response === 'object') return JSON.stringify(res.response);
  return '';
};

/** Pull the first JSON object out of model text (tolerates ```json fences and prose). */
export function parseJsonLoose(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  const start = src.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, escp = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(src.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

/**
 * Turn a Workers AI SSE stream (OpenAI chunk format, or legacy {response}) into callbacks.
 * Reasoning deltas are reported as ticks only (never shown or stored).
 * Returns { finish, usage, timedOut }: finish is the last finish_reason seen ("stop", "length", ... or null);
 * timedOut is set when no chunk arrived for idleMs or the deadline (epoch ms) passed - the stream is cancelled then.
 */
export async function pumpSse(stream, { onText, onReasoning, idleMs = 0, deadline = 0 } = {}) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '', finish = null, usage = null, timedOut = false;
  const IDLE = Symbol('idle');
  for (;;) {
    let wait = idleMs || 0;
    if (deadline) { const left = deadline - Date.now(); if (left <= 0) { timedOut = true; break; } wait = wait ? Math.min(wait, left) : left; }
    let timer;
    const next = wait ? Promise.race([reader.read(), new Promise(r => { timer = setTimeout(() => r(IDLE), wait); })]) : reader.read();
    const got = await next.finally(() => clearTimeout(timer));
    if (got === IDLE) { timedOut = true; break; }
    const { value, done } = got;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.usage && (ev.usage.completion_tokens || !usage)) usage = ev.usage;
      const ch = ev.choices?.[0];
      if (ch?.finish_reason) finish = ch.finish_reason;
      const delta = ch?.delta;
      if (delta) {
        if (delta.content) onText(delta.content);
        else if (delta.reasoning || delta.reasoning_content) onReasoning?.();
      } else if (typeof ev.response === 'string' && ev.response) onText(ev.response);
    }
  }
  if (timedOut) reader.cancel().catch(() => {});
  return { finish, usage, timedOut };
}
