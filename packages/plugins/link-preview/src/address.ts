import { isIP } from 'node:net';

// Which addresses the server may connect to when it reads a page for a link preview. The answer is "only a public, globally routable address":
// everything else (this machine, the private ranges, the link-local range that holds the cloud metadata service, carrier-grade NAT, documentation
// and multicast ranges, and the IPv6 forms that carry an IPv4 address inside them) is refused. Pure and allocation-light; no I/O.

/** Parses a dotted-quad IPv4 address with no leading zeros ("010.0.0.1" is ambiguous, so it is not an address here). Null when it is not one. */
export function parseIPv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** [network, prefix length] pairs: addresses that are not public. Source: IANA special-purpose registry (RFC 6890 and updates). */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // old 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including the broadcast address
];

const BLOCKED_V4_RANGES = BLOCKED_V4.map(([net, bits]) => {
  const base = parseIPv4(net) as number;
  const size = 2 ** (32 - bits);
  return [base, base + size - 1] as const;
});

/** True when the IPv4 number is public. */
export function isPublicIPv4Number(value: number): boolean {
  return !BLOCKED_V4_RANGES.some(([lo, hi]) => value >= lo && value <= hi);
}

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one (a zone id such as `%eth0` is refused). */
export function parseIPv6(text: string): number[] | null {
  let s = text;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%') || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let tail: number[] = [];
  // an embedded IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups
  const lastColon = s.lastIndexOf(':');
  if (lastColon < 0) return null;
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = groups(halves[0] as string);
  if (head === null) return null;
  let all: number[];
  if (halves.length === 2) {
    const rest = groups(halves[1] as string);
    if (rest === null) return null;
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // "::" stands for at least one group
    all = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    all = head;
  }
  if (all.length !== 8) return null;
  if (tail.length === 2) {
    all[6] = tail[0] as number;
    all[7] = tail[1] as number;
  }
  return all;
}

const v4Of = (hi: number, lo: number): number => hi * 65536 + lo;

/** True when the eight groups of an IPv6 address are a public, globally routable address. */
function isPublicIPv6Groups(g: number[]): boolean {
  const [a, b, c, d, e, f, hi, lo] = g as [number, number, number, number, number, number, number, number];
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (the old IPv4-compatible form, which also covers :: and ::1): judged as the IPv4 address inside
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return isPublicIPv4Number(v4Of(hi, lo));
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48: an IPv4 address behind a translator; refused whole
  if (a === 0x64 && b === 0xff9b) return false;
  // 100::/64 (discard-only)
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return false;
  // Only global unicast 2000::/3 can be a public host.
  if (a < 0x2000 || a > 0x3fff) return false;
  // 2001::/23 (IETF protocol assignments, Teredo 2001::/32 hides an IPv4 address) and 2001:db8::/32 (documentation)
  if (a === 0x2001 && (b < 0x200 || b === 0xdb8)) return false;
  // 2002::/16 (6to4): judged by the IPv4 address in groups two and three
  if (a === 0x2002) return isPublicIPv4Number(v4Of(b, c));
  // 3fff::/20 (documentation)
  if (a === 0x3fff && b <= 0x0fff) return false;
  return true;
}

/** True when `address` (as `dns.lookup` or a URL host gives it) is a public IPv4 or IPv6 address. Anything that is not an address is not public. */
export function isPublicAddress(address: string): boolean {
  const text = address.replace(/^\[|\]$/g, '');
  const family = isIP(text);
  if (family === 4) {
    const n = parseIPv4(text);
    return n !== null && isPublicIPv4Number(n);
  }
  if (family === 6) {
    const groups = parseIPv6(text);
    return groups !== null && isPublicIPv6Groups(groups);
  }
  return false;
}
