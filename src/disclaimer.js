// The "not professional advice" disclaimer: shown in the app footer, acknowledged once per person, under every AI
// answer, on Research / Guides / guided diagnosis, and passed to Claude through the MCP server.
import { nowSec } from './util.js';

export const DISCLAIMER = 'Not professional advice. This information comes from AI and online research, not a certified mechanic. Verify before acting, follow safety precautions, and do all work at your own risk.';
export const DISCLAIMER_VERSION = 1;

/** Who acknowledges: the member, plus the name typed at sign-in for the shared household login. */
export const ackKey = member => `${member.id}:${String(member.name || '').trim().toLowerCase().slice(0, 40)}`;

export async function ackStatus(env, member) {
  const row = await env.DB.prepare('SELECT version FROM disclaimer_acks WHERE ack_key = ?1').bind(ackKey(member)).first();
  return { text: DISCLAIMER, version: DISCLAIMER_VERSION, acked: !!row && row.version >= DISCLAIMER_VERSION };
}

export async function acknowledge(env, member) {
  await env.DB.prepare(`INSERT INTO disclaimer_acks (ack_key, member_id, name, version, at) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(ack_key) DO UPDATE SET version = excluded.version, at = excluded.at`)
    .bind(ackKey(member), member.id, member.name || null, DISCLAIMER_VERSION, nowSec()).run();
  return { ok: true, version: DISCLAIMER_VERSION };
}
