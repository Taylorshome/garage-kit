// Worker entry for the Docker image (docker/server.mjs runs it in workerd through Miniflare). It is src/index.js plus:
//   - env.AI from AI_PROVIDER (src/ai-providers.js) instead of the Workers AI binding, with PDF text via unpdf;
//   - internal routes the Node server calls (never reachable from outside: the server refuses /__garage/* from the
//     network, and each call must carry the per-boot INTERNAL_TOKEN):
//       GET  /__garage/health   D1 answers (Docker HEALTHCHECK, through /healthz)
//       POST /__garage/email    one raw message from the IMAP poller -> the same email() handler as Email Routing
// The Cloudflare build (wrangler.jsonc main = src/index.js) never includes this file.
import worker from './index.js';
import { makeProviderAi } from './ai-providers.js';
import { safeEqual } from './util.js';
import { parseHeaders } from './email.js';

let aiError = null;
async function pdfToText(bytes) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

function prepare(env) {
  if (env.__garageReady) return;
  try { env.AI = makeProviderAi(env, { pdfToText }); }
  catch (e) { aiError = e.message; console.error(`AI provider not usable: ${e.message}`); env.AI = makeProviderAi({ AI_PROVIDER: 'none' }, { pdfToText }); }
  env.__garageReady = true;
}

async function internalEmail(req, env, ctx) {
  const url = new URL(req.url);
  const bytes = new Uint8Array(await req.arrayBuffer());
  let rejected = null;
  const message = {
    from: url.searchParams.get('from') || '',
    to: url.searchParams.get('to') || env.MAIL_ADDRESS || '',
    headers: parseHeaders(bytes),
    raw: new Response(bytes).body,
    rawSize: bytes.length,
    setReject(reason) { rejected = String(reason || 'rejected'); },
    async reply() { throw new Error('replies are not sent for IMAP email-in'); },
    async forward() { throw new Error('forward is not available for IMAP email-in'); },
  };
  await worker.email(message, env, ctx);
  return Response.json({ ok: !rejected, rejected });
}

export default {
  async fetch(req, env, ctx) {
    prepare(env);
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__garage/')) {
      if (!env.INTERNAL_TOKEN || !safeEqual(req.headers.get('X-Garage-Internal') || '', env.INTERNAL_TOKEN)) return new Response('not found', { status: 404 });
      if (url.pathname === '/__garage/health') {
        try { await env.DB.prepare('SELECT 1').first(); return Response.json({ ok: true, ai: aiError ? `error: ${aiError}` : (env.AI_PROVIDER || 'none') }); }
        catch (e) { return Response.json({ ok: false, error: String(e.message).slice(0, 200) }, { status: 503 }); }
      }
      if (url.pathname === '/__garage/email' && req.method === 'POST') return internalEmail(req, env, ctx);
      return new Response('not found', { status: 404 });
    }
    return worker.fetch(req, env, ctx);
  },
  async scheduled(event, env, ctx) {
    prepare(env);
    return worker.scheduled(event, env, ctx);
  },
};
