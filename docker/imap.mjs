// Email-in without Cloudflare Email Routing: poll one mailbox folder over IMAP and hand each new message to the
// Worker's email() handler (same allowlist + senderCheck as Email Routing). Use a mailbox only the garage reads
// (a dedicated address, or a filter into its own folder) at a provider that adds Authentication-Results
// (Gmail, Fastmail, iCloud, Outlook.com do): senderCheck relies on the receiving provider's DMARC/SPF verdicts.
// Processed messages are marked \Seen (and moved to IMAP_PROCESSED_FOLDER when set); rejected or failed ones are
// marked \Seen + \Flagged so they aren't retried forever. Unseen messages are the queue.
import { ImapFlow } from 'imapflow';

const MAX_RAW = 25 * 1024 * 1024;

/** Envelope sender for senderCheck: the Return-Path the final delivery server recorded. */
export function returnPath(raw) {
  const head = raw.subarray(0, Math.min(raw.length, 64 * 1024)).toString('latin1').split(/\r?\n\r?\n/)[0];
  const m = head.match(/^Return-Path:\s*<?([^>\s]*)>?/im);
  return m ? m[1].trim().toLowerCase() : '';
}

export function startImap(cfg, { deliver, log = console }) {
  let timer = null, stopped = false, running = null, client = null;
  const run = async () => {
    client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: cfg.user, pass: cfg.pass }, logger: false, socketTimeout: 120_000 });
    let n = 0;
    try {
      await client.connect();
      const lock = await client.getMailboxLock(cfg.folder);
      try {
        const uids = (await client.search({ seen: false }, { uid: true })) || [];
        for (const uid of uids.slice(0, 20)) {
          if (stopped) break;
          const msg = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
          if (!msg?.source) continue;
          let flags = ['\\Seen'], move = false;
          if (msg.source.length > MAX_RAW) { log.warn(`imap: message ${uid} is over 25 MB, skipped`); flags.push('\\Flagged'); }
          else {
            try {
              const r = await deliver(msg.source, { from: returnPath(msg.source) });
              if (r.ok) { n++; move = !!cfg.processedFolder; } else { flags.push('\\Flagged'); log.log(`imap: message ${uid} rejected (${r.rejected})`); }
            } catch (e) { flags.push('\\Flagged'); log.error(`imap: message ${uid} failed: ${e.message}`); }
          }
          await client.messageFlagsAdd(String(uid), flags, { uid: true });
          if (move) await client.messageMove(String(uid), cfg.processedFolder, { uid: true }).catch(e => log.warn(`imap: move to ${cfg.processedFolder} failed: ${e.message}`));
        }
      } finally { lock.release(); }
      if (n) log.log(`imap: processed ${n} message(s)`);
    } catch (e) {
      log.warn(`imap: ${cfg.host}: ${e.responseText || e.message}`);   // never the password
    } finally {
      await client.logout().catch(() => {});
      client = null;
    }
  };
  const loop = async () => {
    if (stopped) return;
    running = run();
    await running;
    running = null;
    if (!stopped) timer = setTimeout(loop, cfg.pollSec * 1000);
  };
  timer = setTimeout(loop, 5000);
  return {
    async stop() { stopped = true; clearTimeout(timer); if (running) await Promise.race([running, new Promise(r => setTimeout(r, 10_000))]); try { client?.close(); } catch { /* closing */ } },
  };
}
