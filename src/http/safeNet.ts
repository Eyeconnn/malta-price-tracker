import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

// Address ranges we never connect to: loopback, private, link-local, CGNAT, documentation,
// benchmarking, multicast/reserved, and their IPv6 equivalents (incl. NAT64, 6to4, Teredo, site-local).
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
  ['2002::', 16], ['100::', 64], ['2001:db8::', 32],
  // local-use NAT64, deprecated site-local, IPv4-compatible (::a.b.c.d) and Teredo
  ['64:ff9b:1::', 48], ['fec0::', 10], ['::', 96], ['2001::', 32],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True if the address is not on the public internet. IPv4-mapped IPv6 is judged by its IPv4 part. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return blocked.check(mapped[1]!, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * DNS lookup used for every outgoing connection. It fails closed: if resolution fails or any
 * resolved address is private, the connection is refused. Because it runs at connect time, the
 * address that was checked is the address connected to (no DNS rebinding window).
 */
function safeLookup(hostname: string, options: dns.LookupOptions, cb: LookupCb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, '');
    const list = addrs as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`refusing to connect to ${hostname}: resolves to a non-public address`) as NodeJS.ErrnoException;
      e.code = 'EPRIVATEADDR';
      return cb(e, '');
    }
    if (options.all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  });
}

const baseConnect = buildConnector({ lookup: safeLookup as never });

// Every connection (first request and every redirect hop) goes through this check:
// IP literals are judged here, host names by safeLookup.
const dispatcher = new Agent({
  connections: 4,
  connect: (opts, cb) => {
    const host = String(opts.hostname).replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host)) return cb(new Error(`refusing to connect to private address ${host}`), null);
    return baseConnect(opts, (err, sock) => {
      // belt and braces: judge the address the socket actually connected to
      const remote = (sock as { remoteAddress?: string } | null)?.remoteAddress;
      if (!err && sock && remote && isPrivateAddress(remote)) {
        sock.destroy();
        return cb(new Error(`refusing connection to private address ${remote}`), null);
      }
      return err ? cb(err, null) : cb(null, sock!);
    });
  },
});

/** fetch that only ever connects to public addresses. URL literals that are private IPs are refused too. */
export function safeFetch(url: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new Error(`refusing to connect to private address ${host}`));
  }
  return undiciFetch(url, { ...init, dispatcher });
}
