// AI without the Workers AI binding (Docker / self-hosting). makeProviderAi(env) returns an object with the same two
// methods the app uses on env.AI, so answer.js (retry / continue / fallback / timeouts), receipts.js and email.js work
// unchanged on every provider:
//   run(model, { messages, stream, max_tokens, temperature, reasoning_effort })
//       stream: false -> { choices: [{ message: { content }, finish_reason }] }   (OpenAI shape; "length" = cut off)
//       stream: true  -> a ReadableStream of OpenAI-style SSE chunks (data: {"choices":[{"delta":{"content":"..."}}]})
//   toMarkdown(files) -> [{ name, format: 'markdown' | 'error', data | error }]
// AI_PROVIDER:
//   cloudflare-rest     Workers AI over the REST API with your own account id + API token (CF_ACCOUNT_ID, CF_API_TOKEN)
//   openai-compatible   any /v1/chat/completions server: Ollama, LM Studio, llama.cpp, vLLM, OpenAI, OpenRouter
//                       (AI_BASE_URL, optional AI_API_KEY)
//   anthropic           the Claude API (ANTHROPIC_API_KEY)
//   none                AI switched off: run() throws, the UI hides AI features (see ai.js aiOff)
//   mock                canned answers for tests (src/ai-mock.js)
// Cloudflare deploys keep the real Workers AI binding and never load this file's providers.
import { AI_OFF_MESSAGE } from './ai.js';
import { mockAi } from './ai-mock.js';

export const PROVIDERS = ['cloudflare-rest', 'openai-compatible', 'anthropic', 'none', 'mock'];

const enc = new TextEncoder();
const sse = obj => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const clip = s => String(s || '').replace(/\s+/g, ' ').slice(0, 300);

async function httpError(provider, r) {
  let detail = '';
  try { const t = await r.text(); try { const j = JSON.parse(t); detail = j.error?.message || j.errors?.[0]?.message || j.message || t; } catch { detail = t; } } catch { /* body unreadable */ }
  const e = new Error(`${provider} returned ${r.status}${detail ? `: ${clip(detail)}` : ''}`);
  e.status = r.status;
  return e;
}

/** Plain text from simple documents (no AI needed); PDFs through the optional pdfToText hook (Docker: unpdf). */
export function localToMarkdown({ pdfToText = null } = {}) {
  return async files => Promise.all((Array.isArray(files) ? files : [files]).map(async f => {
    const name = f.name || 'file';
    const type = String(f.blob?.type || '').toLowerCase();
    try {
      if (/^text\/(plain|csv|markdown)/.test(type)) return { name, mimeType: 'text/markdown', format: 'markdown', data: await f.blob.text() };
      if (type === 'application/pdf' && pdfToText) {
        const text = await pdfToText(new Uint8Array(await f.blob.arrayBuffer()));
        return text && text.trim() ? { name, mimeType: 'text/markdown', format: 'markdown', data: text } : { name, format: 'error', error: 'no text layer in this PDF (a scanned image?)' };
      }
      return { name, format: 'error', error: `can't convert ${type || 'this file'} without Workers AI` };   // HTML: email.js strips tags itself
    } catch (e) { return { name, format: 'error', error: clip(e.message) }; }
  }));
}

// ---------------------------------------------------------------- OpenAI-compatible (Ollama, LM Studio, OpenAI, OpenRouter, ...)
export function openAiCompatible(env, { fetchImpl = fetch } = {}) {
  const base = String(env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('AI_PROVIDER=openai-compatible needs AI_BASE_URL, e.g. http://ollama:11434/v1');
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    async run(model, body = {}) {
      const { messages, stream = false, max_tokens, temperature } = body;
      const req = { model, messages, stream };
      if (max_tokens) req.max_tokens = max_tokens;
      if (temperature !== undefined) req.temperature = temperature;
      // reasoning_effort is only understood by some servers (and rejected by others): pass it only when asked to
      if (body.reasoning_effort && env.AI_SEND_REASONING_EFFORT === '1') req.reasoning_effort = body.reasoning_effort;
      const headers = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
      if (env.AI_API_KEY) headers.Authorization = `Bearer ${env.AI_API_KEY}`;
      const r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(req) });
      if (!r.ok) throw await httpError('AI server', r);
      if (stream) return r.body;   // already OpenAI SSE (Ollama sends "reasoning" deltas for thinking models; ai.js counts them as ticks)
      return r.json();
    },
  };
}

// ---------------------------------------------------------------- Anthropic (Claude API, raw HTTP like the other providers)
export const ANTHROPIC_DEFAULTS = { chat: 'claude-opus-5-5', fallback: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5', vision: 'claude-opus-5-5', visionFallback: 'claude-sonnet-5-5' };
const SERVER_FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1|fable-5-2)$/;
const STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'refusal', pause_turn: 'length' };

/** OpenAI-style messages -> { system, messages } for the Messages API (images: data URLs -> base64 image blocks). */
export function toAnthropicMessages(messages) {
  const system = [];
  const out = [];
  const block = part => {
    if (typeof part === 'string') return part ? { type: 'text', text: part } : null;
    if (part?.type === 'text') return part.text ? { type: 'text', text: part.text } : null;
    if (part?.type === 'image_url') {
      const m = String(part.image_url?.url || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
    }
    return null;
  };
  for (const msg of messages || []) {
    const parts = (Array.isArray(msg.content) ? msg.content : [msg.content]).map(block).filter(Boolean);
    if (msg.role === 'system') { for (const p of parts) if (p.type === 'text') system.push(p.text); continue; }
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    if (!parts.length) continue;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...parts); else out.push({ role, content: parts });
  }
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  if (out.at(-1)?.role === 'assistant') out.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });   // no prefill on current models
  return { system: system.join('\n\n'), messages: out };
}

/** Anthropic SSE -> OpenAI-style SSE chunks (text deltas, thinking ticks, finish_reason). Errors error the stream. */
export function anthropicToOpenAiStream(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return new ReadableStream({
    async pull(ctl) {
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) { ctl.enqueue(sse({ choices: [{ delta: { content: ev.delta.text } }] })); return; }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') { ctl.enqueue(sse({ choices: [{ delta: { reasoning: '.' } }] })); return; }
          if (ev.type === 'message_delta' && ev.delta?.stop_reason) { ctl.enqueue(sse({ choices: [{ delta: {}, finish_reason: STOP[ev.delta.stop_reason] || ev.delta.stop_reason }], usage: ev.usage })); return; }
          if (ev.type === 'error') { ctl.error(new Error(`Claude API stream error: ${clip(ev.error?.message || ev.error?.type)}`)); reader.cancel().catch(() => {}); return; }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) { ctl.enqueue(enc.encode('data: [DONE]\n\n')); ctl.close(); return; }
        buf += dec.decode(value, { stream: true });
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

export function anthropic(env, { fetchImpl = fetch } = {}) {
  const key = env.ANTHROPIC_API_KEY || env.AI_API_KEY;
  if (!key) throw new Error('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
  const base = String(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const serverFallback = String(env.ANTHROPIC_SERVER_FALLBACK || 'on') !== 'off';
  return {
    async run(model, body = {}) {
      const { system, messages } = toAnthropicMessages(body.messages);
      // no temperature: current Claude models reject sampling parameters; effort replaces reasoning_effort
      const req = { model, max_tokens: body.max_tokens || 8000, messages, stream: !!body.stream };
      if (system) req.system = system;
      if (body.reasoning_effort) req.output_config = { effort: body.reasoning_effort };
      const headers = { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      if (serverFallback && SERVER_FALLBACK_MODELS.test(model)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; req.fallbacks = 'default'; }
      const r = await fetchImpl(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(req) });
      if (!r.ok) throw await httpError('Claude API', r);
      if (req.stream) return anthropicToOpenAiStream(r.body);
      const j = await r.json();
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return { choices: [{ message: { content: text }, finish_reason: STOP[j.stop_reason] || j.stop_reason || null }], usage: j.usage };
    },
  };
}

// ---------------------------------------------------------------- Workers AI over REST (your own account; free tier works)
export function cloudflareRest(env, { fetchImpl = fetch } = {}) {
  const acct = String(env.CF_ACCOUNT_ID || '').trim(), token = env.CF_API_TOKEN;
  if (!/^[0-9a-f]{32}$/i.test(acct) || !token) throw new Error('AI_PROVIDER=cloudflare-rest needs CF_ACCOUNT_ID (32 hex characters) and CF_API_TOKEN (Workers AI: Read + Edit)');
  const base = `https://api.cloudflare.com/client/v4/accounts/${acct}/ai`;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    async run(model, body = {}) {
      const r = await fetchImpl(`${base}/run/${model.replace(/[^\w@./:-]/g, encodeURIComponent)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw await httpError('Workers AI', r);
      if (body.stream) return r.body;
      const j = await r.json();
      return j.result ?? j;
    },
    async toMarkdown(files) {
      const fd = new FormData();
      for (const f of Array.isArray(files) ? files : [files]) fd.append('files', f.blob, f.name || 'file');
      const r = await fetchImpl(`${base}/tomarkdown`, { method: 'POST', headers: auth, body: fd });
      if (!r.ok) throw await httpError('Workers AI toMarkdown', r);
      const j = await r.json();
      return j.result || [];
    },
  };
}

const disabled = {
  async run() { throw new Error(AI_OFF_MESSAGE); },
};

/** env.AI for a non-Cloudflare runtime. hooks.pdfToText(bytes) -> text, used when the provider can't convert PDFs. */
export function makeProviderAi(env, hooks = {}) {
  const p = String(env.AI_PROVIDER || 'none').trim().toLowerCase();
  const local = localToMarkdown(hooks);
  if (p === 'mock') return mockAi;
  if (p === 'cloudflare-rest') return cloudflareRest(env, hooks);
  if (p === 'openai-compatible' || p === 'openai' || p === 'ollama') return { ...openAiCompatible(env, hooks), toMarkdown: local };
  if (p === 'anthropic') return { ...anthropic(env, hooks), toMarkdown: local };
  if (p !== 'none') console.warn(`AI_PROVIDER "${p}" is not one of ${PROVIDERS.join(', ')}; AI is off`);
  return { ...disabled, toMarkdown: local };
}
