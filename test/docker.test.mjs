// Docker runtime pieces: migrations runner, outbound (SSRF) filter, config, AI providers, IMAP helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, listMigrations, migrationStatus, splitSql } from '../docker/migrate.mjs';
import { checkUrl, guardedLookup, isPrivateAddress, outboundHandler } from '../docker/outbound.mjs';
import { buildConfig, hashPassword, readEnv, vapidKeys } from '../docker/config.mjs';
import { exportSql } from '../docker/admin.mjs';
import { returnPath } from '../docker/imap.mjs';
import { parseHeaders } from '../src/email.js';
import { anthropic, anthropicToOpenAiStream, cloudflareRest, localToMarkdown, makeProviderAi, openAiCompatible, toAnthropicMessages } from '../src/ai-providers.js';
import { pumpSse } from '../src/ai.js';
import { verifyPassword } from '../src/auth.js';

const MIG = new URL('../migrations/', import.meta.url).pathname;
function d1(db) {
  const prep = sql => {
    let s = null; const st = new Proxy({}, { get: (_, k) => { s ||= db.prepare(sql); return s[k].bind(s); } });   // lazy, like D1
    const bound = args => ({
      first: async () => st.get(...args) ?? null,
      all: async () => ({ results: st.all(...args) }),
      run: async () => { const r = st.run(...args); return { meta: { changes: Number(r.changes) } }; },
      _run: () => st.run(...args),
    });
    return { bind: (...args) => bound(args), ...bound([]) };
  };
  return { prepare: prep, batch: async stmts => { db.exec('BEGIN'); try { for (const s of stmts) s._run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; } };
}

test('splitSql: quotes, comments, doubled quotes', () => {
  assert.deepEqual(splitSql("-- c\nCREATE TABLE a (x TEXT DEFAULT 'a;b'); /* x; */ INSERT INTO a VALUES ('it''s;');\n"), ["CREATE TABLE a (x TEXT DEFAULT 'a;b')", "INSERT INTO a VALUES ('it''s;')"]);
});

test('migrations: apply all, then idempotent (second run applies nothing)', async () => {
  const db = new DatabaseSync(':memory:');
  const D = d1(db);
  const before = await migrationStatus(D, MIG);
  assert.equal(before.fresh, true); assert.equal(before.pending.length, listMigrations(MIG).length);
  const applied = await applyMigrations(D, MIG, { log: () => {} });
  assert.equal(applied.length, listMigrations(MIG).length);
  assert.deepEqual(await applyMigrations(D, MIG, { log: () => {} }), []);
  const st = await migrationStatus(D, MIG);
  assert.equal(st.fresh, false); assert.equal(st.pending.length, 0);
  assert.ok(db.prepare("SELECT 1 FROM members WHERE id = 'm-household'").get(), 'seed ran once');
  const dump = await exportSql(D, ['members']);
  assert.match(dump, /CREATE TABLE IF NOT EXISTS members/); assert.match(dump, /INSERT INTO "members"/);
});

test('migrations: a failing file rolls back and is not recorded', async () => {
  const db = new DatabaseSync(':memory:');
  const D = d1(db);
  await D.batch([D.prepare('CREATE TABLE cars (id TEXT)')]);   // 0001 will collide
  await assert.rejects(applyMigrations(D, MIG, { log: () => {} }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n, 0);
});

test('outbound: private, special and local addresses are refused', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '224.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['23.203.239.224', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) assert.ok(!isPrivateAddress(a), a);
  const allow = new Set(['ollama', '192.168.1.50']);
  assert.throws(() => checkUrl('http://localhost:11434/', allow));
  assert.throws(() => checkUrl('http://10.0.0.1/', allow));
  assert.throws(() => checkUrl('file:///etc/passwd', allow));
  assert.throws(() => checkUrl('http://user:pw@example.com/', allow));
  assert.throws(() => checkUrl('http://[::1]/', allow));
  assert.doesNotThrow(() => checkUrl('http://ollama:11434/v1', allow));
  assert.doesNotThrow(() => checkUrl('http://192.168.1.50:8123/', allow));
  assert.doesNotThrow(() => checkUrl('https://vpic.nhtsa.dot.gov/api', allow));
});

test('outbound: a name that resolves to a private address is blocked at connect time; allowlisted works', { timeout: 20_000 }, async () => {
  const srv = createServer((req, res) => res.end('hi')).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const port = srv.address().port;
  try {
    const warn = []; const log = { warn: m => warn.push(m) };
    const blocked = outboundHandler({ allowHosts: new Set(), ResponseCtor: Response, log });
    let r = await blocked(new Request(`http://localhost:${port}/`));
    assert.equal(r.status, 403); assert.match(await r.text(), /local name/);
    r = await blocked(new Request(`http://127.0.0.1:${port}/`));
    assert.equal(r.status, 403);
    // names are checked again at connect time (DNS rebinding): a name answering 127.0.0.1 / ::1 is refused
    const err = await new Promise(res => guardedLookup(new Set())('localhost', {}, e => res(e)));
    assert.match(String(err?.message), /private address/);
    assert.match(String(await new Promise(res => guardedLookup(new Set(['localhost']))('localhost', {}, (e, a) => res(e || a)))), /^(127\.0\.0\.1|::1)$/);
    const allowed = outboundHandler({ allowHosts: new Set(['127.0.0.1']), ResponseCtor: Response, log });
    r = await allowed(new Request(`http://127.0.0.1:${port}/`, { headers: { Connection: 'close' } }));
    assert.equal(r.status, 200); assert.equal(await r.text(), 'hi');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('config: _FILE secrets, generated secrets persist, provider defaults, password hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-'));
  try {
    const f = join(dir, 'pw'); (await import('node:fs')).writeFileSync(f, 'correct horse battery\n');
    assert.equal(readEnv({ GARAGE_PASSWORD_FILE: f }).GARAGE_PASSWORD, 'correct horse battery');
    assert.throws(() => readEnv({ X_FILE: join(dir, 'missing') }), /X_FILE/);
    const env = { GARAGE_PASSWORD_FILE: f, PUBLIC_URL: 'https://garage.example.com', AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', HA_URL: 'http://192.168.1.5:8123', HA_TOKEN: 't' };
    const a = await buildConfig(env, { dataDir: dir, version: '9.9.9' });
    assert.deepEqual(a.errors, []);
    assert.ok(await verifyPassword('correct horse battery', a.bindings.PASSWORD_HASH));
    assert.equal(a.vars.AI_CHAT_MODEL, 'claude-opus-5-5'); assert.equal(a.vars.AI_FAST_MODEL, 'claude-haiku-5-5');
    assert.equal(a.vars.APP_ORIGIN, 'https://garage.example.com'); assert.equal(a.vars.APP_VERSION, '9.9.9');
    assert.deepEqual(a.vars.INTEGRATIONS.split(','), ['push', 'home_assistant']);
    assert.ok(a.settings.allowHosts.has('192.168.1.5'));
    assert.ok(!('GARAGE_PASSWORD' in a.bindings), 'the plain password never reaches the Worker');
    const b = await buildConfig(env, { dataDir: dir });
    assert.equal(b.bindings.SESSION_SECRET, a.bindings.SESSION_SECRET, 'session key survives a restart');
    assert.equal(b.bindings.VAPID_PRIVATE_KEY, a.bindings.VAPID_PRIVATE_KEY);
    assert.equal((statSync(join(dir, 'secrets.json')).mode & 0o777).toString(8), '600');
    const c = await buildConfig({ AI_PROVIDER: 'openai-compatible' }, { dataDir: dir });
    assert.ok(c.errors.some(e => /AI_BASE_URL/.test(e)) && c.errors.some(e => /AI_CHAT_MODEL/.test(e)));
    const d = await buildConfig({ AI_PROVIDER: 'ollama', AI_BASE_URL: 'http://ollama:11434/v1', AI_CHAT_MODEL: 'qwen3:14b', AI_VISION_MODEL: 'qwen2.5vl:7b' }, { dataDir: dir });
    assert.equal(d.vars.AI_PROVIDER, 'openai-compatible'); assert.equal(d.vars.AI_FAST_MODEL, 'qwen3:14b'); assert.equal(d.vars.AI_VISION_FALLBACK, 'qwen2.5vl:7b');
    assert.ok(d.settings.allowHosts.has('ollama'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config: VAPID keys have the shapes push.js expects; hashPassword matches auth.js', async () => {
  const k = vapidKeys();
  assert.equal(Buffer.from(k.publicKey, 'base64url').length, 65); assert.equal(Buffer.from(k.privateKey, 'base64url').length, 32);
  assert.ok(await verifyPassword('pw-123456', await hashPassword('pw-123456')));
});

const sseBody = lines => new Response(lines.map(l => `data: ${JSON.stringify(l)}\n\n`).join('')).body;
const fakeFetch = handler => async (url, init) => handler(String(url), init, JSON.parse(init.body || '{}'));

test('openai-compatible: request shape, stream passthrough, errors without secrets', async () => {
  let seen;
  const ai = openAiCompatible({ AI_BASE_URL: 'http://ollama:11434/v1/', AI_API_KEY: 'sekret' }, { fetchImpl: fakeFetch((url, init, body) => {
    seen = { url, auth: init.headers.Authorization, body };
    if (body.stream) return new Response(sseBody([{ choices: [{ delta: { reasoning: 'hm' } }] }, { choices: [{ delta: { content: 'Hello' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]));
    return Response.json({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] });
  }) });
  const res = await ai.run('qwen3:14b', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, temperature: 0, reasoning_effort: 'low' });
  assert.equal(seen.url, 'http://ollama:11434/v1/chat/completions'); assert.equal(seen.auth, 'Bearer sekret');
  assert.equal(seen.body.reasoning_effort, undefined, 'not sent unless AI_SEND_REASONING_EFFORT=1');
  assert.equal(res.choices[0].message.content, '{"a":1}');
  let text = '', ticks = 0;
  const out = await pumpSse(await ai.run('m', { messages: [], stream: true }), { onText: d => { text += d; }, onReasoning: () => ticks++ });
  assert.equal(text, 'Hello'); assert.equal(out.finish, 'length'); assert.equal(ticks, 1);
  const bad = openAiCompatible({ AI_BASE_URL: 'http://x/v1', AI_API_KEY: 'sekret' }, { fetchImpl: async () => new Response('{"error":{"message":"model not found"}}', { status: 404 }) });
  await assert.rejects(bad.run('nope', { messages: [] }), e => /404: model not found/.test(e.message) && !/sekret/.test(e.message));
});

test('anthropic: message conversion (system, images, merging, no prefill)', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'Be a mechanic.' },
    { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] },
    { role: 'user', content: 'and this' },
    { role: 'assistant', content: 'partial answer' },
  ]);
  assert.equal(system, 'Be a mechanic.');
  assert.equal(messages[0].role, 'user'); assert.equal(messages[0].content.length, 3);
  assert.deepEqual(messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(messages.at(-1).role, 'user', 'never ends on an assistant turn');
});

test('anthropic: request has no sampling params; effort mapped; stream converted; max_tokens -> length', async () => {
  let req, hdr;
  const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
  const ai = anthropic({ ANTHROPIC_API_KEY: 'k' }, { fetchImpl: async (url, init) => {
    req = JSON.parse(init.body); hdr = init.headers;
    if (req.stream) return new Response([ev('message_start', { message: {} }), ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '...' } }),
      ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Check the ' } }), ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'coolant.' } }),
      ev('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 5 } }), ev('message_stop', {})].join(''));
    return Response.json({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' });
  } });
  const r = await ai.run('claude-opus-5-5', { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }], max_tokens: 100, temperature: 0.3, reasoning_effort: 'low' });
  assert.equal(r.choices[0].message.content, '{"ok":true}'); assert.equal(r.choices[0].finish_reason, 'stop');
  assert.equal(req.temperature, undefined); assert.deepEqual(req.output_config, { effort: 'low' }); assert.equal(req.system, 'S');
  assert.equal(hdr['x-api-key'], 'k'); assert.equal(req.fallbacks, 'default');
  let text = '', ticks = 0;
  const out = await pumpSse(await ai.run('claude-haiku-5-5', { messages: [{ role: 'user', content: 'Q' }], stream: true }), { onText: d => { text += d; }, onReasoning: () => ticks++ });
  assert.equal(text, 'Check the coolant.'); assert.equal(out.finish, 'length'); assert.equal(ticks, 1);
  assert.equal(req.fallbacks, undefined, 'server-side fallback only on models that support it');
});

test('anthropic: a stream error event errors the stream', async () => {
  const body = new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`).body;
  await assert.rejects(pumpSse(anthropicToOpenAiStream(body), { onText: () => {} }), /Overloaded/);
});

test('cloudflare-rest: run unwraps result; toMarkdown posts files', async () => {
  const calls = [];
  const ai = cloudflareRest({ CF_ACCOUNT_ID: 'a'.repeat(32), CF_API_TOKEN: 't' }, { fetchImpl: async (url, init) => {
    calls.push(url);
    if (url.endsWith('/tomarkdown')) return Response.json({ result: [{ name: 'r.pdf', format: 'markdown', data: '# hi' }] });
    return Response.json({ result: { choices: [{ message: { content: 'ok' } }] }, success: true });
  } });
  assert.equal((await ai.run('@cf/zai-org/glm-5.3', { messages: [] })).choices[0].message.content, 'ok');
  assert.match(calls[0], /\/accounts\/a{32}\/ai\/run\/@cf\/zai-org\/glm-5\.3$/);
  assert.equal((await ai.toMarkdown([{ name: 'r.pdf', blob: new Blob(['x'], { type: 'application/pdf' }) }]))[0].data, '# hi');
  assert.throws(() => cloudflareRest({ CF_ACCOUNT_ID: 'nope', CF_API_TOKEN: 't' }), /CF_ACCOUNT_ID/);
});

test('none / local conversion: AI off throws a clear error; text and PDFs still convert', async () => {
  const ai = makeProviderAi({ AI_PROVIDER: 'none' }, { pdfToText: async () => 'PDF TEXT' });
  await assert.rejects(ai.run('x', {}), /turned off/);
  const [t, p, img] = await ai.toMarkdown([{ name: 'a.csv', blob: new Blob(['a,b'], { type: 'text/csv' }) }, { name: 'b.pdf', blob: new Blob(['%PDF'], { type: 'application/pdf' }) }, { name: 'c.png', blob: new Blob(['x'], { type: 'image/png' }) }]);
  assert.equal(t.data, 'a,b'); assert.equal(p.data, 'PDF TEXT'); assert.equal(img.format, 'error');
  assert.equal((await localToMarkdown()([{ name: 'b.pdf', blob: new Blob(['%PDF'], { type: 'application/pdf' }) }]))[0].format, 'error');
});

test('email-in helpers: headers parsed like Email Routing (repeated headers joined), Return-Path as envelope sender', () => {
  const raw = Buffer.from('Return-Path: <Shop@Example.com>\r\nAuthentication-Results: mx.example; spf=pass\r\nAuthentication-Results: other;\r\n dmarc=pass\r\nSubject: hi\r\n\r\nbody');
  const h = parseHeaders(new Uint8Array(raw));
  assert.equal(h.get('subject'), 'hi');
  assert.match(h.get('authentication-results'), /spf=pass.*dmarc=pass/);
  assert.equal(returnPath(raw), 'shop@example.com');
});

test('Docker files: no secrets baked into the image, non-root, healthcheck', () => {
  const df = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(df, /^USER node$/m); assert.match(df, /HEALTHCHECK/); assert.match(df, /VOLUME \/data/);
  assert.doesNotMatch(df, /PASSWORD|API_KEY|TOKEN=/);
  const di = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  for (const p of ['.env', '.dev.vars*', 'garage.config.json', 'wrangler.jsonc', 'node_modules', '.git']) assert.ok(di.split('\n').includes(p), p);
});
