// File storage: R2 when the BUCKET binding exists, otherwise KV (R2 isn't enabled on the account yet).
// Each file row records which store holds it, so switching to R2 later needs no data migration.
import { newId, nowSec, HttpError } from './util.js';

export const MAX_FILE = 20 * 1024 * 1024;

export async function putFile(env, { key, data, contentType, filename, carId = null, serviceId = null, scanId = null, receiptId = null }) {
  const size = data.byteLength ?? data.length;
  if (size > MAX_FILE) throw new HttpError(413, 'File is larger than 20 MB');
  let store;
  if (env.BUCKET) { await env.BUCKET.put(key, data, { httpMetadata: { contentType } }); store = 'r2'; }
  else { await env.FILES.put(key, data, { metadata: { contentType } }); store = 'kv'; }
  const id = newId();
  await env.DB.prepare(`INSERT INTO files (id, car_id, service_id, scan_id, store, key, filename, content_type, size, created_at, receipt_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`).bind(id, carId, serviceId, scanId, store, key, filename, contentType, size, nowSec(), receiptId).run();
  return { id, store, key, size };
}

/** Put a blob without a files row (derived text, raw message). Returns the store used. */
export async function putBlob(env, key, data, contentType) {
  if (env.BUCKET) { await env.BUCKET.put(key, data, { httpMetadata: { contentType } }); return 'r2'; }
  await env.FILES.put(key, data, { metadata: { contentType } });
  return 'kv';
}

export async function getBlob(env, store, key) {
  if (store === 'r2') {
    if (!env.BUCKET) return null;
    const o = await env.BUCKET.get(key);
    return o ? o.body : null;
  }
  return env.FILES.get(key, 'stream');
}

export async function getText(env, key) {
  if (env.BUCKET) { const o = await env.BUCKET.get(key); if (o) return o.text(); }
  return env.FILES.get(key, 'text');
}

export async function deleteFile(env, row) {
  if (row.store === 'r2') { if (env.BUCKET) await env.BUCKET.delete(row.key); }
  else await env.FILES.delete(row.key);
  await env.DB.prepare('DELETE FROM files WHERE id = ?1').bind(row.id).run();
}

export const safeName = n => (String(n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120) || 'file');
