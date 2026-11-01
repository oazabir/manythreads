import { describe, expect, it } from 'vitest';
import { isPublicAddress, parseIPv4, parseIPv6 } from '../src/address.ts';

// Which addresses may the server ever connect to? Everything that is not plainly public is refused: private, loopback, link-local (the cloud
// metadata address 169.254.169.254 lives there), shared (CGNAT), documentation, multicast, reserved, and every IPv6 form that carries one of them.

const REFUSED: Array<[string, string]> = [
  ['0.0.0.0', 'this network'],
  ['0.1.2.3', 'this network'],
  ['10.0.0.1', 'private 10/8'],
  ['10.255.255.255', 'private 10/8'],
  ['100.64.0.1', 'CGNAT low end'],
  ['100.127.255.254', 'CGNAT high end'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['169.254.169.254', 'cloud metadata'],
  ['169.254.0.1', 'link-local'],
  ['172.16.0.1', 'private 172.16/12'],
  ['172.31.255.255', 'private 172.16/12'],
  ['192.0.0.1', 'IETF protocol assignments'],
  ['192.0.2.7', 'documentation'],
  ['192.88.99.1', '6to4 relay'],
  ['192.168.1.1', 'private 192.168/16'],
  ['198.18.0.1', 'benchmarking'],
  ['198.19.255.255', 'benchmarking'],
  ['198.51.100.9', 'documentation'],
  ['203.0.113.9', 'documentation'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.250', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'broadcast'],
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
  ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
  ['::ffff:10.1.2.3', 'IPv4-mapped private'],
  ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata, hex'],
  ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
  ['0:0:0:0:0:ffff:192.168.0.1', 'IPv4-mapped, long form'],
  ['::127.0.0.1', 'IPv4-compatible loopback'],
  ['64:ff9b::7f00:1', 'NAT64 well-known prefix'],
  ['64:ff9b::169.254.169.254', 'NAT64 metadata'],
  ['100::1', 'discard-only'],
  ['fe80::1', 'link-local'],
  ['fe80::a9fe:a9fe', 'link-local'],
  ['febf::1', 'link-local high end'],
  ['fc00::1', 'unique local'],
  ['fd12:3456:789a::1', 'unique local'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['2001::1', 'Teredo'],
  ['2001:10::1', 'IETF protocol block'],
  ['2002:7f00:1::1', '6to4 of loopback'],
  ['2002:a9fe:a9fe::1', '6to4 of metadata'],
  ['2002:0a00:0001::', '6to4 of private'],
  ['3fff::1', 'documentation'],
  ['fec0::1', 'site-local'],
  ['1::1', 'outside global unicast'],
];

const ALLOWED: Array<[string, string]> = [
  ['8.8.8.8', 'public'],
  ['1.1.1.1', 'public'],
  ['93.184.216.34', 'public'],
  ['100.63.255.255', 'just below CGNAT'],
  ['100.128.0.1', 'just above CGNAT'],
  ['172.15.255.255', 'just below 172.16/12'],
  ['172.32.0.1', 'just above 172.16/12'],
  ['169.253.1.1', 'just below link-local'],
  ['169.255.0.1', 'just above link-local'],
  ['198.17.255.255', 'just below benchmarking'],
  ['198.20.0.1', 'just above benchmarking'],
  ['223.255.255.254', 'just below multicast'],
  ['2606:4700:4700::1111', 'public IPv6'],
  ['2a00:1450:4001:81b::200e', 'public IPv6'],
  ['::ffff:8.8.8.8', 'IPv4-mapped public'],
  ['2002:0808:0808::1', '6to4 of a public address'],
];

describe('isPublicAddress', () => {
  it.each(REFUSED)('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(ALLOWED)('allows %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['example.com', 'a name'],
    ['256.1.1.1', 'octet out of range'],
    ['1.2.3', 'three parts'],
    ['1.2.3.4.5', 'five parts'],
    ['01.2.3.4', 'leading zero (octal trick)'],
    ['0x7f.0.0.1', 'hex octet'],
    ['2130706433', 'decimal integer form'],
    ['::1%eth0', 'zone id'],
    ['fe80::1%lo', 'zone id on link-local'],
    [':::', 'too many colons'],
    ['1::2::3', 'two gaps'],
    ['12345::1', 'group too long'],
    ['g::1', 'not hex'],
    [' 8.8.8.8', 'leading space'],
    ['8.8.8.8 ', 'trailing space'],
    ['8.8.8.8\n', 'trailing newline'],
  ])('treats %j as not public (%s)', (text) => {
    expect(isPublicAddress(text)).toBe(false);
  });
});

describe('parsers', () => {
  it('parses a dotted quad', () => {
    expect(parseIPv4('127.0.0.1')).toBe(0x7f000001);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('1.2.3.256')).toBeNull();
    expect(parseIPv4('1.2.3.04')).toBeNull();
  });

  it('parses IPv6 into eight groups, with an embedded IPv4 tail', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('::1%x')).toBeNull();
  });
});
