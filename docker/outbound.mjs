// Every fetch() the Worker makes in the container goes through here (Miniflare outboundService). On Cloudflare the
// global_fetch_strictly_public flag keeps user-supplied URLs (push endpoints, MCP client metadata documents, ...)
// off private networks; in a container on your LAN that protection has to be ours:
//   - only http/https;
//   - the host is resolved and every address checked: loopback, RFC 1918, CGNAT, link-local (cloud metadata),
//     ULA, multicast, documentation and other special ranges are refused;
//   - the connection uses the address that was checked (custom lookup), so DNS rebinding can't swap it afterwards;
//   - redirects are not followed here: the Worker's fetch follows them, and each hop comes back through this check.
// Hosts you configured yourself (AI_BASE_URL, HA_URL, OIDC_ISSUER, OUTBOUND_ALLOW_HOSTS) may be private.
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';

// two lists: a single BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules
const v4 = new BlockList(), v6 = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) v4.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8]]) v6.addSubnet(net, bits, 'ipv6');

/** true for addresses the app must not reach on its own. IPv4-mapped / NAT64 IPv6 are judged by their IPv4 part. */
export function isPrivateAddress(addr) {
  const a = String(addr).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const fam = isIP(a);
  if (fam === 4) return v4.check(a, 'ipv4');
  if (fam === 6) {
    const m = a.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i);
    if (m) return v4.check(m[1], 'ipv4');
    if (/^(::ffff:|64:ff9b::)/i.test(a)) return true;   // mapped/NAT64 in hex form: refuse rather than parse
    return v6.check(a, 'ipv6');
  }
  return true;   // not an IP at all: refuse
}

export class OutboundBlocked extends Error {}

/** lookup() for net/tls.connect that refuses private answers (unless the host is allowlisted). */
export function guardedLookup(allowHosts) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const host = String(hostname).toLowerCase();
    dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!allowHosts.has(host)) {
        const bad = addrs.find(x => isPrivateAddress(x.address));
        if (bad) return cb(new OutboundBlocked(`${host} resolves to a private address (${bad.address}); add it to OUTBOUND_ALLOW_HOSTS if you meant it`));
      }
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/** Throws OutboundBlocked unless the URL may be fetched (literal IPs checked here; names at connect time). */
export function checkUrl(url, allowHosts) {
  let u;
  try { u = new URL(url); } catch { throw new OutboundBlocked('not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new OutboundBlocked(`${u.protocol} is not allowed`);
  if (u.username || u.password) throw new OutboundBlocked('credentials in URLs are not allowed');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (allowHosts.has(host)) return u;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new OutboundBlocked(`${host} is a local name`);
  if (isIP(host) && isPrivateAddress(host)) throw new OutboundBlocked(`${host} is a private address`);
  return u;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length']);

/** Miniflare outboundService handler: (Request) -> Response. ResponseCtor = Miniflare's Response class. */
export function outboundHandler({ allowHosts, ResponseCtor, log = console }) {
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(allowHosts) }, headersTimeout: 300_000, bodyTimeout: 300_000 });
  return async request => {
    let u;
    try { u = checkUrl(request.url, allowHosts); }
    catch (e) { log.warn(`outbound blocked: ${e.message}`); return new ResponseCtor(`Blocked by the garage's outbound filter: ${e.message}`, { status: 403 }); }
    const headers = {};
    for (const [k, v] of request.headers) if (!HOP.has(k.toLowerCase()) && !k.toLowerCase().startsWith('mf-') && !k.toLowerCase().startsWith('cf-')) headers[k] = v;
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    try {
      const r = await undiciFetch(u, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined, redirect: 'manual', dispatcher });
      const h = new Headers();
      for (const [k, v] of r.headers) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) h.append(k, v);
      const nobody = [101, 204, 205, 304].includes(r.status) || request.method === 'HEAD';
      return new ResponseCtor(nobody ? null : r.body, { status: r.status, statusText: r.statusText, headers: h });
    } catch (e) {
      const cause = e.cause || e;
      if (cause instanceof OutboundBlocked) { log.warn(`outbound blocked: ${cause.message}`); return new ResponseCtor(`Blocked by the garage's outbound filter: ${cause.message}`, { status: 403 }); }
      throw new Error(`fetch ${u.host} failed: ${cause.code || cause.message}`);
    }
  };
}
