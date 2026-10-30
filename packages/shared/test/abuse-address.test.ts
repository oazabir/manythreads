import { describe, expect, it } from 'vitest';
import { addressKey } from '../src/common/abuse-limits.ts';

describe('addressKey: what a limit counts a client address as', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    [' 203.0.113.9 ', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['0:0:0:0:0:ffff:203.0.113.9', '203.0.113.9'],
    ['::ffff:cb00:7109', '203.0.113.9'],
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8:0001:0002::', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['[2001:db8:1:2::9]', '2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ])('%s -> %s', (input, expected) => {
    expect(addressKey(input)).toBe(expected);
  });

  it('every address inside one /64 is one key; a different /64 is another', () => {
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe(addressKey('2001:db8:1:2:bbbb::2'));
    expect(addressKey('2001:db8:1:3::1')).not.toBe(addressKey('2001:db8:1:2::1'));
  });

  it('a value that is not an address is left as it is (trimmed, lower-cased), never throws', () => {
    expect(addressKey(' Not-An-Address ')).toBe('not-an-address');
    expect(addressKey('1:2:3')).toBe('1:2:3');
    expect(addressKey('1::2::3')).toBe('1::2::3');
    expect(addressKey('::ffff:999.1.1.1')).toBe('::ffff:999.1.1.1');
    expect(addressKey('')).toBe('');
  });
});
