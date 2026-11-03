import { parseAddresses, readMailHeaders } from '@manythreads/sdk/extract';
import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { ownerActor } from '../src/actions.ts';
import { combineAuth, inboxAddress, MAIL_DOMAIN_DEFAULT, mailDomain, senderCheckOf, teamSlugOfAddress, teamSlugsOf } from '../src/mail-address.ts';

// P8-19, P8-20: the pure rules of the email door (the address, which teams a message is for, what the sender check says), the header reader behind them, and the
// owner lookup of the action items. No database.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('the team address', () => {
  it('is made of the mailbox name, a plus, the team slug and the mail domain', () => {
    expect(inboxAddress('inbox', 'engineering', 'mail.example.com')).toBe('inbox+engineering@mail.example.com');
  });

  it('uses the domain from the environment, or a domain that never resolves', () => {
    expect(mailDomain({ MANYTHREADS_MAIL_DOMAIN: ' Mail.Example.COM ' })).toBe('mail.example.com');
    expect(mailDomain({})).toBe(MAIL_DOMAIN_DEFAULT);
    expect(mailDomain({ MANYTHREADS_MAIL_DOMAIN: 'not a domain' })).toBe(MAIL_DOMAIN_DEFAULT);
    expect(mailDomain({ MANYTHREADS_MAIL_DOMAIN: '' })).toBe(MAIL_DOMAIN_DEFAULT);
    expect(MAIL_DOMAIN_DEFAULT.endsWith('.invalid')).toBe(true);
  });

  it('reads the team back from an address, and nothing from any other address', () => {
    const d = 'mail.example.com';
    expect(teamSlugOfAddress('inbox+engineering@mail.example.com', 'inbox', d)).toBe('engineering');
    expect(teamSlugOfAddress('Inbox+Product-Design@Mail.Example.com', 'inbox', d)).toBe('product-design');
    expect(teamSlugOfAddress('inbox@mail.example.com', 'inbox', d)).toBeNull();
    expect(teamSlugOfAddress('other+engineering@mail.example.com', 'inbox', d)).toBeNull();
    expect(teamSlugOfAddress('inbox+engineering@elsewhere.example.com', 'inbox', d)).toBeNull();
    expect(teamSlugOfAddress('inbox+@mail.example.com', 'inbox', d)).toBeNull();
    expect(teamSlugOfAddress('inbox+-x@mail.example.com', 'inbox', d)).toBeNull();
    expect(teamSlugOfAddress('inbox+a b@mail.example.com', 'inbox', d)).toBeNull();
    expect(teamSlugOfAddress('no-at-sign', 'inbox', d)).toBeNull();
  });

  it('finds every team a message is for, once each, from Delivered-To, To and Cc', () => {
    const d = 'mail.example.com';
    const slugs = teamSlugsOf(
      {
        deliveredTo: ['inbox+research@mail.example.com'],
        to: ['inbox+engineering@mail.example.com', 'someone@else.com', 'inbox+research@mail.example.com'],
        cc: ['inbox+marketing@mail.example.com', 'inbox+engineering@mail.example.com'],
      },
      'inbox',
      d,
    );
    expect(slugs).toEqual(['research', 'engineering', 'marketing']);
    expect(teamSlugsOf({ deliveredTo: [], to: ['a@b.com'], cc: [] }, 'inbox', d)).toEqual([]);
  });
});

describe('what the transport vouched for', () => {
  it('passes only when SPF or DKIM passed and neither failed', () => {
    expect(combineAuth('pass', 'pass')).toBe('pass');
    expect(combineAuth('pass', undefined)).toBe('pass');
    expect(combineAuth(undefined, 'pass')).toBe('pass');
    expect(combineAuth('pass', 'none')).toBe('pass');
    expect(combineAuth('pass', 'fail')).toBe('fail');
    expect(combineAuth('fail', 'pass')).toBe('fail');
    expect(combineAuth('softfail', 'pass')).toBe('pass');
  });

  it('treats no result, a soft fail and a neutral result as a failed check', () => {
    expect(combineAuth(undefined, undefined)).toBe('fail');
    expect(combineAuth('none', 'none')).toBe('fail');
    expect(combineAuth('softfail', undefined)).toBe('fail');
    expect(combineAuth('neutral', 'neutral')).toBe('fail');
  });

  it('maps to the item’s sender check: a stranger who passed is "none", never "pass"', () => {
    expect(senderCheckOf('pass', true)).toBe('pass');
    expect(senderCheckOf('pass', false)).toBe('none');
    expect(senderCheckOf('fail', true)).toBe('fail');
    expect(senderCheckOf('fail', false)).toBe('fail');
  });
});

describe('the header reader', () => {
  const message = [
    'From: "Eloise Marchand" <Eloise@Example.com>',
    'To: Inbox <inbox+engineering@mail.example.com>, "Ops, Team" <ops@example.com>',
    'Cc: inbox+research@mail.example.com (the research team)',
    'Delivered-To: inbox+engineering@mail.example.com',
    'X-Original-To: inbox+marketing@mail.example.com',
    'Subject: =?UTF-8?B?UXVhcnRlcmx5IHBsYW4g4oCTIGRyYWZ0?=',
    'Message-ID: <abc123@example.com>',
    'Authentication-Results: mx.example.com; spf=pass; dkim=pass',
    '',
    'To: someone@not-a-header.com',
    'Body text',
  ].join('\r\n');

  it('reads who, to whom, what it is called and its Message-ID', () => {
    const env = readMailHeaders(enc(message));
    expect(env.from).toEqual(['eloise@example.com']);
    expect(env.to).toEqual(['inbox+engineering@mail.example.com', 'ops@example.com']);
    expect(env.cc).toEqual(['inbox+research@mail.example.com']);
    expect(env.deliveredTo).toEqual(['inbox+engineering@mail.example.com', 'inbox+marketing@mail.example.com']);
    expect(env.subject).toBe('Quarterly plan – draft');
    expect(env.messageId).toBe('<abc123@example.com>');
  });

  it('reads the headers only, never the body', () => {
    expect(readMailHeaders(enc(message)).to).not.toContain('someone@not-a-header.com');
  });

  it('gives empty fields for a message with no headers, an empty input and plain junk', () => {
    for (const input of ['', 'just some words', '\u0000\u0001\u0002', '\r\n\r\nbody']) {
      const env = readMailHeaders(enc(input));
      expect(env.from).toEqual([]);
      expect(env.to).toEqual([]);
      expect(env.subject).toBeNull();
      expect(env.messageId).toBeNull();
    }
  });

  it('reads an address list with groups, comments, odd quoting and bare addresses', () => {
    expect(parseAddresses('Team: a@x.com, "B, B" <b@x.com>;')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseAddresses('c@x.com (Carol, the boss), D <D@X.com>')).toEqual(['c@x.com', 'd@x.com']);
    expect(parseAddresses(undefined)).toEqual([]);
    expect(parseAddresses('')).toEqual([]);
    expect(parseAddresses('not an address')).toEqual([]);
    expect(parseAddresses('a@x.com, a@x.com, A@X.COM')).toEqual(['a@x.com']);
  });

  it('keeps at most 50 addresses per header', () => {
    const many = Array.from({ length: 500 }, (_, i) => `u${String(i)}@x.com`).join(', ');
    expect(parseAddresses(many)).toHaveLength(50);
  });

  it('does not slow down on hostile headers', () => {
    expectLinear(
      (n) => enc(`To: ${'"a'.repeat(n)}\r\nFrom: ${'('.repeat(n)}\r\nCc: ${'<'.repeat(n)}\r\nSubject: ${'=?UTF-8?B?'.repeat(n)}\r\n\r\n`),
      (bytes) => readMailHeaders(bytes),
      { n: 5_000, label: 'mail headers' },
    );
    expectLinear(
      (n) => 'a@'.repeat(n),
      (value) => parseAddresses(value),
      { n: 3_000, label: 'address list' },
    );
    expectLinear(
      (n) => `${'x'.repeat(n)}\r\n`.repeat(4).slice(0, -2),
      (value) => readMailHeaders(enc(value)),
      { n: 20_000, label: 'one huge line' },
    );
  });
});

describe('the owner of an action', () => {
  const roster = [
    { actor_id: 'a1', display_name: 'Nadia Karim' },
    { actor_id: 'a2', display_name: 'Rafi Haddad' },
    { actor_id: 'a3', display_name: 'Omar Saleh' },
    { actor_id: 'a4', display_name: 'Omar Nasser' },
  ];

  it('matches the whole name, ignoring case and spacing around it', () => {
    expect(ownerActor(roster, 'Nadia Karim')).toBe('a1');
    expect(ownerActor(roster, '  nadia karim ')).toBe('a1');
  });

  it('matches a first name when only one person has it', () => {
    expect(ownerActor(roster, 'Rafi')).toBe('a2');
    expect(ownerActor(roster, 'nadia')).toBe('a1');
  });

  it('does not guess when two people share the name, or when nobody does', () => {
    expect(ownerActor(roster, 'Omar')).toBeNull();
    expect(ownerActor(roster, 'Someone Else')).toBeNull();
    expect(ownerActor(roster, '')).toBeNull();
    expect(ownerActor(roster, null)).toBeNull();
    expect(ownerActor([], 'Nadia')).toBeNull();
  });
});
