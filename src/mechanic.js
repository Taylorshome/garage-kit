// "Ask the mechanic": per-car AI chat, streamed, conversations saved in D1.
import { AI_OFF_MESSAGE, aiOff } from './ai.js';
import { logAnswer, robustAnswer } from './answer.js';
import { carSummary, sortByUrgency } from './due.js';
import { HttpError, newId, nowSec, str, todayLocal } from './util.js';
import { reportBrief } from './research-jobs.js';
import { RESEARCH_BUDGET, selectResearch } from './research-context.js';
import { attrsOf, fluidsFor, noun, typeOf, usesHours, wetClutch } from './vehicle.js';

const HISTORY_TURNS = 20;
const HISTORY_CHARS = 40000;   // newest turns first; keeps the prompt well inside gpt-oss-120b's 128k-token window (glm-5.3: 1M)

/**
 * Everything the app knows about one car, as prompt text. The research part is chosen for the question:
 * query = [{ text, weight }] (see research-context.js), budget = max chars of research.
 */
export async function carContext(env, carId, { query = [], budget = RESEARCH_BUDGET } = {}) {
  const car = await env.DB.prepare('SELECT * FROM cars WHERE id = ?1 AND archived = 0').bind(carId).first();
  if (!car) throw new HttpError(404, 'Car not found');
  const [items, todos, services, scans, codes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM schedule_items WHERE car_id = ?1').bind(carId),
    env.DB.prepare("SELECT * FROM todos WHERE car_id = ?1 AND status = 'open' ORDER BY created_at").bind(carId),
    env.DB.prepare('SELECT * FROM services WHERE car_id = ?1 ORDER BY date DESC, created_at DESC LIMIT 10').bind(carId),
    env.DB.prepare('SELECT * FROM scans WHERE car_id = ?1 ORDER BY received_at DESC LIMIT 3').bind(carId),
    env.DB.prepare('SELECT c.* FROM scan_codes c JOIN scans s ON s.id = c.scan_id WHERE s.car_id = ?1').bind(carId),
  ]);
  const today = todayLocal();
  const sum = carSummary(car, items.results, todos.results, today);
  const due = sortByUrgency(sum.items).filter(i => i.status === 'overdue' || i.status === 'soon');
  const lines = [];
  lines.push(`Vehicle: ${car.year ?? '?'} ${car.make ?? ''} ${car.model ?? ''}${car.trim ? ` (${car.trim})` : ''}, nickname "${car.nickname}". Type: ${noun(car)}${car.body_type && typeOf(car) === 'motorcycle' ? ` (${car.body_type})` : ''}.`);
  const a = attrsOf(car);
  const facts = [a.cooling && `${a.cooling}-cooled`, a.fuel_system, a.clutch ? `${a.clutch} clutch` : wetClutch(car) ? 'wet clutch' : null, a.final_drive && `${a.final_drive} final drive`,
    a.shared_sump === true ? 'engine/gearbox share one oil sump' : a.shared_sump === false ? 'separate gearbox oil' : null].filter(Boolean);
  if (facts.length) lines.push(`Drivetrain facts: ${facts.join(', ')}.`);
  if (car.engine) lines.push(`Engine: ${car.engine}.`);
  if (car.transmission) lines.push(`Transmission: ${car.transmission}.`);
  if (car.vin) lines.push(`VIN: ${car.vin}.`);
  lines.push(`Mileage: ${car.mileage != null ? car.mileage.toLocaleString('en-US') + ' miles' : 'unknown'} (as of ${car.mileage_updated_at || 'unknown'}). Today is ${today}.`);
  if (usesHours(car)) lines.push(`Engine hours: ${car.hours != null ? `${car.hours} h` : 'unknown'} (as of ${car.hours_updated_at || 'unknown'}). Off-road maintenance is mostly by hours.`);
  if (car.notes) lines.push(`Owner notes: ${car.notes}`);
  lines.push('', 'Open issues / to-dos:');
  lines.push(...(todos.results.length ? todos.results.map(t => `- [${t.priority}] ${t.title}${t.dtc_code ? ` (code ${t.dtc_code})` : ''}${t.notes ? `\n  notes: ${t.notes.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`) : ['- none']));
  lines.push('', 'Maintenance due (overdue or due soon):');
  lines.push(...(due.length ? due.map(i => `- ${i.name}: ${i.label}`) : ['- nothing overdue or due soon']));
  const unknown = sum.items.filter(i => i.status === 'unknown');
  if (unknown.length) lines.push(`Last-done unknown for: ${unknown.map(i => i.name).join(', ')}.`);
  lines.push('', 'Recent service history:');
  lines.push(...(services.results.length ? services.results.map(s => `- ${s.date}${s.mileage ? ` @ ${s.mileage.toLocaleString('en-US')} mi` : ''}: ${s.title}${s.details ? ` (${s.details.replace(/\s+/g, ' ').slice(0, 200)})` : ''}${s.diy ? ' [DIY]' : s.shop ? ` [${s.shop}]` : ''}`) : ['- none recorded']));
  lines.push('', 'Recent scan-tool reports:');
  lines.push(...(scans.results.length ? scans.results.map(s => {
    const cs = codes.results.filter(c => c.scan_id === s.id);
    return `- ${s.scan_date || new Date(s.received_at * 1000).toISOString().slice(0, 10)}${s.mileage ? ` @ ${s.mileage} mi` : ''}: ${cs.length ? cs.map(c => `${c.code}${c.description ? ` ${c.description}` : ''}${c.module ? ` [${c.module}]` : ''}`).join('; ') : 'no codes'}`;
  }) : ['- none']));
  const pg = await env.DB.prepare('SELECT fluids FROM parts_guides WHERE car_id = ?1').bind(carId).first();
  const fl = fluidsFor(car, pg ? JSON.parse(pg.fluids) : []);
  if (fl.length) lines.push('', fluidsBrief(fl));
  const { results: reports } = await env.DB.prepare(`SELECT j.result, t.title FROM research_jobs j JOIN todos t ON t.id = j.todo_id
    WHERE j.car_id = ?1 AND j.status = 'done' AND t.status = 'open' ORDER BY j.finished_at DESC LIMIT 4`).bind(carId).all();
  for (const r of reports) lines.push('', reportBrief(r.title, JSON.parse(r.result)));
  const research = await env.DB.prepare('SELECT data, md FROM research WHERE car_id = ?1').bind(carId).first();
  let selected = [];
  if (research) {
    const sel = selectResearch(JSON.parse(research.data), research.md || '', { query, openTodos: todos.results, budget });
    selected = sel.selected;
    lines.push('', sel.text);
    console.log(`research context ${carId}: ${sel.selected.length}/${sel.chunks} chunks, ${sel.text.length}/${budget} chars`);
  }
  return { car, text: lines.join('\n'), selected };
}

/** Fluids table for the prompt (from the parts research; newer than the general research). */
export function fluidsBrief(rows) {
  return 'FLUIDS (from the parts research; these supersede older figures):\n' + rows.map(f => `- ${f.fluid}: ${f.buy}; ${f.amount}${f.amount_label ? ` ${f.amount_label}` : ''}${f.total ? `, ${f.total} ${f.total_label}` : ''}${f.liters ? ` (${f.liters})` : ''}${f.notes ? `. ${f.notes}` : ''}${f.warning ? ` WARNING: ${f.warning}` : ''}${f.sump ? ` ${f.sump}` : ''}${f.verify ? ' [verify]' : ''}`).join('\n');
}

export function systemPrompt(ctxText) {
  return `You are "the mechanic", a friendly, experienced technician (cars, trucks, motorcycles, side-by-sides and ATVs) helping a family keep their own vehicles running. You are talking to the owners, who may do some of their own work.

Here is what the garage app knows about THIS vehicle (trust it, refer to it; it may be a motorcycle, UTV or ATV, not a car):
${ctxText}

How to help:
- Diagnose like a good tech: ask the one or two questions that matter most, then give "what to check first", ordered cheapest/easiest and most likely cause first. Number the steps.
- Explain fixes step by step in plain language, with the tools needed and roughly how hard it is (DIY-friendly vs. shop job).
- Use the car's known issues, history and scan codes above. Mention known patterns for this engine/model as things to check, not certainties.
- If there is a DEEP RESEARCH REPORT for the issue being discussed, use it first and mention it ("the research report for this symptom says…").
- Prefer the RESEARCH FINDINGS above and cite them briefly when you use them (e.g. "TSB 09-002-14", "known issue: rocker arm failure", "recall 14V-224", "manual: 5W-30, 6.0 qt"). When a finding lists a source link, include that link (markdown) in your citation. The findings are the parts of the research most relevant to this conversation; "Other research on file" lists titles that were left out. When something comes from your general knowledge rather than those findings, say so ("general knowledge, not in your research").
- Specs from the research (oil type/capacity, fluids, part numbers) are fine to quote as "per the research"; still remind them to verify part fitment by VIN.
- Safety first, whenever relevant: hot cooling systems (never open when hot), jack stands (never work under a car on a jack alone), fuel and battery hazards, brakes/steering being safety-critical, and when to stop driving the car. Motorcycles: secure the bike on a center/rear stand, hot pipes, tires and brakes are life-critical, don't ride it if brakes, tires or steering are in doubt. UTVs/ATVs: park + chock, never run with the CVT cover off, check for water after crossings.
- Motorcycles with a wet clutch need JASO MA/MA2 oil (never energy-conserving car oil: the clutch can slip). UTV/ATV service is by engine hours as much as miles.
- Be honest about uncertainty. Say "I'm not sure" or "this could be several things" when that's the truth.
- Do NOT state torque specs, fluid capacities, part numbers or wiring pin-outs as facts. If they matter, give a typical ballpark clearly labelled as approximate and tell them to verify it in the service manual, on the part's packaging, or with a parts counter for their VIN.
- If a symptom suggests something dangerous (brake failure, fuel smell, overheating badly, smoke, steering issues), say clearly not to drive it until checked.
- Keep answers focused and skimmable: short paragraphs, numbered steps, bold only for key warnings. No filler.`;
}

/** Research query from the chat: newest message (the question) counts fully, the few turns before it less. hist is newest first. */
export function chatQuery(hist) {
  return hist.slice(0, 5).map((m, i) => ({ text: String(m.content).slice(0, i ? 1500 : 4000), weight: i === 0 ? 1 : m.role === 'user' ? 0.5 : 0.25 }));
}
/** Oldest-first history, keeping the newest turns that fit HISTORY_CHARS (the newest message always). hist is newest first. */
export function trimHistory(hist, max = HISTORY_CHARS) {
  const out = [];
  let n = 0;
  for (const m of hist) {
    n += String(m.content).length;
    if (out.length && n > max) break;
    out.push(m);
  }
  return out.reverse();
}

async function loadChat(env, id) {
  const c = await env.DB.prepare('SELECT * FROM chats WHERE id = ?1').bind(id).first();
  if (!c) throw new HttpError(404, 'Conversation not found');
  return c;
}

/** Prompt for the chat: system (car context, research picked for the conversation) + trimmed history (oldest first). hist is newest first. */
async function chatMessages(env, chat, hist) {
  const { text } = await carContext(env, chat.car_id, { query: chatQuery(hist) });
  return [{ role: 'system', content: systemPrompt(text) }, ...trimHistory(hist).map(m => ({ role: m.role, content: m.content }))];
}

export const CHAT_MAX_TOKENS = 16000;   // glm-5.3 reasoning counts against this; at 6000 two of three live answers were cut off (Nov 24, 2026)

/**
 * Stream an answer as NDJSON events: model, c (text delta), r (thinking tick), reset (clear what's shown: a retry
 * starts over), status (progress note), error, done {status: ok|truncated|failed}.
 * mode 'ask': answer the newest user message. mode 'continue': finish the cut-off assistant message `cont`.
 * Only real answers are saved: ok -> saved; truncated -> saved with truncated = 1 (UI: "cut off, tap to continue");
 * failed -> nothing saved (the question stays unanswered and the UI offers "Try again").
 */
function streamAnswer(env, ctx, chat, hist, { cont = null } = {}) {
  if (aiOff(env)) throw new HttpError(424, AI_OFF_MESSAGE);
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => writer.write(enc.encode(JSON.stringify(obj) + '\n')).catch(() => {}); // client may have gone away; still save the answer
  const work = (async () => {
    let lastTick = 0, result = null;
    try {
      // continuing: the prompt ends with the question the cut-off answer belongs to
      const messages = await chatMessages(env, chat, cont ? hist.filter(m => m.id !== cont.id) : hist);
      await send({ t: 'model', model: 'mechanic' });
      result = await robustAnswer(env, messages, {
        maxTokens: CHAT_MAX_TOKENS, temperature: 0.4, partial: cont?.content || '',
        hooks: {
          onText: d => send({ t: 'c', d }),
          onReset: () => send({ t: 'reset' }),
          onStatus: msg => send({ t: 'status', msg }),
          onReasoning: () => { const n = Date.now(); if (n - lastTick > 700) { lastTick = n; send({ t: 'r' }); } },
        },
      });
      await logAnswer(env, cont ? 'chat_continue' : 'chat', chat.id, result);
      if (result.status !== 'failed') {
        const flag = result.status === 'truncated' ? 1 : 0;
        await env.DB.batch([
          cont
            ? env.DB.prepare('UPDATE chat_messages SET content = ?1, truncated = ?2, model = ?3 WHERE id = ?4').bind(result.text, flag, result.model, cont.id)
            : env.DB.prepare('INSERT INTO chat_messages (chat_id, role, content, author, model, created_at, truncated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(chat.id, 'assistant', result.text, 'mechanic', result.model, nowSec(), flag),
          env.DB.prepare('UPDATE chats SET updated_at = ?1 WHERE id = ?2').bind(nowSec(), chat.id),
        ]);
      } else {
        await send({ t: 'error', message: `The mechanic couldn't answer just now (${result.error}).` });
      }
    } catch (e) {
      console.error('mechanic stream failed', e.stack || e);
      await logAnswer(env, cont ? 'chat_continue' : 'chat', chat.id, { outcome: 'failed', model: null, trace: [{ result: 'error', error: String(e.message).slice(0, 200) }] });
      await send({ t: 'error', message: `The mechanic couldn't answer just now (${e.message}).` });
      result = { status: 'failed' };
    }
    await send({ t: 'done', status: result?.status || 'failed' });
    await writer.close().catch(() => {});
  })();
  ctx.waitUntil(work);
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}

async function history(env, chatId) {
  return (await env.DB.prepare('SELECT id, role, content, truncated FROM chat_messages WHERE chat_id = ?1 ORDER BY id DESC LIMIT ?2').bind(chatId, HISTORY_TURNS).all()).results;
}

async function streamReply(env, ctx, chat, content, member) {
  if (aiOff(env)) throw new HttpError(424, AI_OFF_MESSAGE);
  await env.DB.prepare('INSERT INTO chat_messages (chat_id, role, content, author, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(chat.id, 'user', content, member.name, nowSec()).run();
  if (chat.title === 'New conversation') await env.DB.prepare('UPDATE chats SET title = ?1 WHERE id = ?2').bind(content.replace(/\s+/g, ' ').slice(0, 60), chat.id).run();
  return streamAnswer(env, ctx, chat, await history(env, chat.id));
}

/** "Tap to continue" / "Try again": finish a cut-off last answer, or answer a question that got no answer. */
export async function continueChat(env, ctx, chat) {
  const hist = await history(env, chat.id);
  const last = hist[0];
  if (!last) throw new HttpError(409, 'Nothing to continue');
  if (last.role === 'assistant' && last.truncated) return streamAnswer(env, ctx, chat, hist, { cont: last });
  if (last.role === 'user') return streamAnswer(env, ctx, chat, hist);
  throw new HttpError(409, 'The last answer is already complete');
}

const r = (method, pattern, fn) => [method, new RegExp(`^${pattern}$`), fn];
export const chatRoutes = [
  r('GET', '/api/cars/([\\w-]+)/chats', async ({ env, m }) => ({
    chats: (await env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM chat_messages WHERE chat_id = c.id) AS messages FROM chats c WHERE car_id = ?1 ORDER BY updated_at DESC`).bind(m[1]).all()).results,
  })),
  r('POST', '/api/cars/([\\w-]+)/chats', async ({ env, m }) => {
    if (!(await env.DB.prepare('SELECT 1 FROM cars WHERE id = ?1').bind(m[1]).first())) throw new HttpError(404, 'Car not found');
    const id = newId(), now = nowSec();
    await env.DB.prepare('INSERT INTO chats (id, car_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)').bind(id, m[1], 'New conversation', now).run();
    return { id };
  }),
  r('GET', '/api/chats/([\\w-]+)', async ({ env, m }) => {
    const chat = await loadChat(env, m[1]);
    const { results } = await env.DB.prepare('SELECT id, role, content, author, model, created_at, truncated FROM chat_messages WHERE chat_id = ?1 ORDER BY id').bind(chat.id).all();
    return { chat, messages: results };
  }),
  r('DELETE', '/api/chats/([\\w-]+)', async ({ env, m }) => {
    await env.DB.prepare('DELETE FROM chats WHERE id = ?1').bind(m[1]).run();
    return { ok: true };
  }),
  r('POST', '/api/chats/([\\w-]+)/messages', async ({ env, ctx, m, body, member }) => {
    const chat = await loadChat(env, m[1]);
    const content = str(body.content, 4000, { required: true, name: 'Message' });
    return streamReply(env, ctx, chat, content, member);
  }),
  r('POST', '/api/chats/([\\w-]+)/continue', async ({ env, ctx, m }) => continueChat(env, ctx, await loadChat(env, m[1]))),
];
