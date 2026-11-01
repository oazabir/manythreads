import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { cleanHostList, extractLinks, hostMatches, normalizeLink, refusedByRules } from '../src/links.ts';

describe('extractLinks', () => {
  it('finds bare links in the order written, without repeats', () => {
    expect(extractLinks('see https://a.example/x and https://b.example/y then https://a.example/x again')).toEqual([
      'https://a.example/x',
      'https://b.example/y',
    ]);
  });

  it('finds the target of a [label](address) link', () => {
    expect(extractLinks('read [the post](https://a.example/post?id=1) now')).toEqual(['https://a.example/post?id=1']);
  });

  it.each([
    ['see https://a.example/x.', 'https://a.example/x'],
    ['see https://a.example/x, ok', 'https://a.example/x'],
    ['(see https://a.example/x)', 'https://a.example/x'],
    ['see https://a.example/x!?', 'https://a.example/x'],
    ['**https://a.example/x**', 'https://a.example/x'],
    ['https://en.example.org/wiki/Foo_(bar)', 'https://en.example.org/wiki/Foo_(bar)'],
    ['<https://a.example/x>', 'https://a.example/x'],
  ])('trims the punctuation of %j', (body, expected) => {
    expect(extractLinks(body)).toEqual([expected]);
  });

  it('skips links inside code spans and code blocks', () => {
    expect(extractLinks('run `curl https://a.example/in-code` please')).toEqual([]);
    expect(extractLinks('```\nhttps://a.example/in-block\n```')).toEqual([]);
  });

  it('keeps only the first five', () => {
    const body = Array.from({ length: 12 }, (_, i) => `https://a.example/${i}`).join(' ');
    expect(extractLinks(body)).toHaveLength(5);
    expect(extractLinks(body)[0]).toBe('https://a.example/0');
  });

  it('returns nothing for plain text, empty text and other schemes', () => {
    expect(extractLinks('')).toEqual([]);
    expect(extractLinks('no links, only words')).toEqual([]);
    expect(extractLinks('ftp://a.example/x mailto:a@b.example javascript:alert(1)')).toEqual([]);
  });

  it('is linear on a message that is nothing but links', () => {
    expectLinear(
      (n) => 'https://a.example/x '.repeat(n),
      (body) => extractLinks(body),
      { n: 10_000, label: 'many links' },
    );
    expectLinear(
      (n) => '[a](https://'.repeat(n),
      (body) => extractLinks(body),
      { n: 10_000, label: 'unclosed link syntax' },
    );
    expectLinear(
      (n) => `https://a.example/${'('.repeat(n)}`,
      (body) => extractLinks(body),
      { n: 10_000, label: 'unbalanced brackets' },
    );
    expectLinear(
      (n) => `https://a.example/${')'.repeat(n)}`,
      (body) => extractLinks(body),
      { n: 10_000, label: 'unbalanced closing brackets' },
    );
  });
});

describe('normalizeLink', () => {
  it('drops credentials and the fragment', () => {
    expect(normalizeLink('https://me:secret@a.example/x?y=1#top')).toBe('https://a.example/x?y=1');
  });

  it.each([
    ['https://a.example:8443/x'],
    ['http://a.example:8080/'],
    ['ftp://a.example/'],
    ['javascript:alert(1)'],
    ['http://localhost/'],
    ['http://intranet/'],
    ['not a link'],
    [''],
    [`https://a.example/${'x'.repeat(2100)}`],
  ])('refuses %j', (raw) => {
    expect(normalizeLink(raw)).toBeNull();
  });

  it('keeps an address literal (the fetcher judges whether it is public)', () => {
    expect(normalizeLink('http://8.8.8.8/')).toBe('http://8.8.8.8/');
  });
});

describe('workspace rules', () => {
  it('matches a host and its subdomains, not look-alikes', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('www.example.com', 'example.com')).toBe(true);
    expect(hostMatches('a.b.example.com', 'example.com')).toBe(true);
    expect(hostMatches('badexample.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com.evil.test', 'example.com')).toBe(false);
  });

  it('with no lists everything is allowed; off refuses everything', () => {
    expect(refusedByRules({ enabled: true, allow: [], deny: [] }, 'a.example')).toBeNull();
    expect(refusedByRules({ enabled: false, allow: [], deny: [] }, 'a.example')).toBe('off');
  });

  it('deny wins over allow', () => {
    const rules = { enabled: true, allow: ['example.com'], deny: ['bad.example.com'] };
    expect(refusedByRules(rules, 'good.example.com')).toBeNull();
    expect(refusedByRules(rules, 'bad.example.com')).toBe('denied');
    expect(refusedByRules(rules, 'x.bad.example.com')).toBe('denied');
  });

  it('a non-empty allow list closes everything else', () => {
    const rules = { enabled: true, allow: ['example.com'], deny: [] };
    expect(refusedByRules(rules, 'other.org')).toBe('not_allowed');
    expect(refusedByRules(rules, 'EXAMPLE.COM.')).toBeNull();
  });

  it('cleans an admin list into plain sorted host names', () => {
    expect(cleanHostList(['https://Example.com/path', 'b.example', 'example.com'])).toEqual({ hosts: ['b.example', 'example.com'] });
    expect(cleanHostList([])).toEqual({ hosts: [] });
    expect(cleanHostList(['ok.example', 'not a host!'])).toEqual({ bad: 'not a host!' });
  });
});
