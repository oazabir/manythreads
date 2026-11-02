import { renderMail } from '@manythreads/kernel';
import { DIGEST_EXCERPT_MAX, DIGEST_MAX_ITEMS } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { excerptOf, mailGroups, messageLink, oneLine, placeOf, planDigest, type DigestItem } from '../src/digest.ts';
import { digestMacMatches, parseDigestToken, signDigestToken } from '../src/digest-token.ts';

// P14-09: the pure rules of the email digest: which items, grouped how, in what words, and the signed unsubscribe link.

const PERSON = '01a0fb83-ada6-7efa-8bc6-50dade5f5784';
const OTHER = '01a0fb83-ada6-7efa-8bc6-50dade5f5785';
const KEY = 'k'.repeat(64);
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

let n = 0;
const item = (over: Partial<DigestItem> = {}): DigestItem => {
  n += 1;
  return {
    notificationId: `n${n}`,
    kind: 'mention',
    actorName: 'Nadia',
    preview: `message ${n}`,
    channelId: 'c-dev',
    channelKind: 'channel',
    channelName: 'dev',
    messageId: `m${n}`,
    threadRootId: null,
    createdAt: new Date(T0 + n * 1000),
    ...over,
  };
};

describe('planDigest', () => {
  it('keeps at most 10 items, counts the rest as "more", and counts them all as the total', () => {
    const items = Array.from({ length: 14 }, () => item());
    const plan = planDigest(items);
    expect(plan.shown).toBe(DIGEST_MAX_ITEMS);
    expect(plan.more).toBe(4);
    expect(plan.total).toBe(14);
    expect(plan.groups.flatMap((g) => g.items)).toHaveLength(10);
  });

  it('chooses mentions before direct messages before replies, the newest first within a kind', () => {
    const reply = item({ kind: 'reply' });
    const dm = item({ kind: 'dm', channelId: 'c-dm', channelKind: 'dm', channelName: '' });
    const oldMention = item({ kind: 'mention' });
    const newMention = item({ kind: 'mention' });
    const plan = planDigest([reply, dm, oldMention, newMention], 3);
    const chosen = plan.groups.flatMap((g) => g.items.map((i) => i.notificationId));
    expect(chosen.sort()).toEqual([oldMention.notificationId, newMention.notificationId, dm.notificationId].sort());
    expect(plan.more).toBe(1);
  });

  it('groups by channel, the group with the newest item first, oldest first inside a group', () => {
    const a1 = item({ channelId: 'a', channelName: 'alpha' });
    const b1 = item({ channelId: 'b', channelName: 'beta' });
    const a2 = item({ channelId: 'a', channelName: 'alpha' });
    const dm = item({ kind: 'dm', channelId: 'd', channelKind: 'dm', channelName: '' });
    const plan = planDigest([a1, b1, a2, dm]);
    expect(plan.groups.map((g) => g.title)).toEqual(['Direct message', '#alpha', '#beta']);
    expect(plan.groups[1]?.items.map((i) => i.notificationId)).toEqual([a1.notificationId, a2.notificationId]);
  });

  it('is empty for no items', () => {
    expect(planDigest([])).toEqual({ groups: [], total: 0, shown: 0, more: 0 });
  });
});

describe('words in the mail', () => {
  it('cuts an excerpt to 140 characters on one line without control characters', () => {
    expect([...excerptOf('x'.repeat(500))]).toHaveLength(DIGEST_EXCERPT_MAX);
    expect(excerptOf('a\n\nb\t c')).toBe('a b c');
    const odd = `bell${String.fromCharCode(7)} and ${String.fromCharCode(0x202e)}right-to-left${String.fromCharCode(0x202c)} and zero${String.fromCharCode(0x200b)}width`;
    expect(excerptOf(odd)).toBe('bell and right-to-left and zero width');
    expect(excerptOf('   ')).toBe('New message');
    expect([...excerptOf(String.fromCodePoint(0x1f600).repeat(300))]).toHaveLength(DIGEST_EXCERPT_MAX);
  });

  it('stays fast on hostile input', () => {
    const started = Date.now();
    oneLine(' '.repeat(5_000_000) + 'x', 140);
    oneLine('\u0000'.repeat(5_000_000), 140);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('names a place as #channel or Direct message', () => {
    expect(placeOf({ channelKind: 'channel', channelName: 'dev' })).toBe('#dev');
    expect(placeOf({ channelKind: 'channel', channelName: '#dev' })).toBe('#dev');
    expect(placeOf({ channelKind: 'dm', channelName: '' })).toBe('Direct message');
  });

  it('links to the message by ids only, with the thread root when there is one', () => {
    expect(messageLink('https://x.test', { channelId: 'c', messageId: 'm', threadRootId: null })).toBe('https://x.test/open?channel=c&message=m');
    expect(messageLink('https://x.test', { channelId: 'c', messageId: 'm', threadRootId: 'r' })).toBe('https://x.test/open?channel=c&message=m&root=r');
  });
});

describe('the mail', () => {
  const render = (items: DigestItem[], extra: { more?: number; unsubscribeUrl?: string; delayMinutes?: number } = {}) => {
    const plan = planDigest(items);
    return renderMail({
      template: 'digest',
      to: 'a@example.test',
      name: 'Aya',
      groups: mailGroups(plan, 'https://m.test'),
      more: extra.more ?? plan.more,
      openUrl: 'https://m.test/',
      unsubscribeUrl: extra.unsubscribeUrl ?? `https://m.test/api/notifications/digest/unsubscribe/${signDigestToken(PERSON, KEY)}`,
      settingsUrl: 'https://m.test/account#' + 'acc-notifications',
      delayMinutes: extra.delayMinutes ?? 60,
    });
  };

  it('lists sender, place, excerpt and a link, says "and N more", and carries the one-click headers', () => {
    const mail = render(Array.from({ length: 12 }, () => item({ preview: 'deploy is red' })));
    expect(mail.subject).toBe('12 new messages for you');
    expect(mail.text).toContain('#dev');
    expect(mail.text).toContain('Nadia: deploy is red');
    expect(mail.text).toContain('https://m.test/open?channel=c-dev&message=');
    expect(mail.text).toContain('and 2 more.');
    expect(mail.text).toContain('/api/notifications/digest/unsubscribe/v1.');
    expect(mail.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/m\.test\/api\/notifications\/digest\/unsubscribe\/v1\.[0-9a-f-]+\.[A-Za-z0-9_-]+>$/);
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('says "1 new message" for one, and never claims to count everything unread', () => {
    expect(render([item()]).subject).toBe('1 new message for you');
    expect(render([item()]).subject).not.toMatch(/unread/);
  });

  it('says in the footer how often the mail can come, in the person\'s own delay, and does not promise "never"', () => {
    expect(render([item()]).text).toContain('at most one email every 1 hour');
    expect(render([item()], { delayMinutes: 240 }).text).toContain('at most one email every 4 hours');
    expect(render([item()], { delayMinutes: 30 }).html).toContain('at most one email every 30 minutes');
    expect(render([item()]).text).not.toContain('never repeats');
  });

  it('drops every mark that reorders or hides text, including the Arabic letter mark', () => {
    const marks = ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u200b', '\ufeff', '\u0000'];
    for (const m of marks) {
      expect(excerptOf(`a${m}b`), JSON.stringify(m)).toBe('a b');
      const mail = render([item({ actorName: `Ev${m}e`, preview: `x${m}y` })]);
      expect(mail.text, JSON.stringify(m)).not.toContain(m);
      expect(mail.html, JSON.stringify(m)).not.toContain(m);
    }
  });

  it('escapes everything somebody else wrote in the HTML part', () => {
    const mail = render([item({ actorName: '<b>Eve</b>', preview: '<script>alert(1)</script> & "quotes" <img src=x onerror=y>', channelName: '<i>sneaky</i>' })]);
    expect(mail.html).not.toContain('<script');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).not.toContain('<b>Eve');
    expect(mail.html).not.toContain('<i>sneaky');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
  });

  it('refuses an unsubscribe address that could break a header line', () => {
    expect(() => render([item()], { unsubscribeUrl: 'https://m.test/x>\r\nBcc: evil@example.test' })).toThrow();
    expect(() => render([item()], { unsubscribeUrl: 'javascript:alert(1)' })).toThrow();
  });

  it('never turns a javascript: link into a clickable one', () => {
    const plan = planDigest([item()]);
    const groups = mailGroups(plan, 'javascript:alert(1)//');
    const mail = renderMail({ template: 'digest', to: 'a@example.test', name: 'Aya', groups, more: 0, openUrl: 'https://m.test/', unsubscribeUrl: 'https://m.test/u', settingsUrl: 'https://m.test/s', delayMinutes: 60 });
    expect(mail.html).not.toContain('javascript:');
  });
});

describe('the unsubscribe token', () => {
  it('verifies for the person and key it was made for', () => {
    const token = signDigestToken(PERSON, KEY);
    const parsed = parseDigestToken(token);
    expect(parsed?.personId).toBe(PERSON);
    expect(digestMacMatches(KEY, parsed!.personId, parsed!.mac)).toBe(true);
  });

  it('is the same every time (no clock in it, so it never expires)', () => {
    expect(signDigestToken(PERSON, KEY)).toBe(signDigestToken(PERSON, KEY));
  });

  it('does not verify under another key or for another person', () => {
    const parsed = parseDigestToken(signDigestToken(PERSON, KEY))!;
    expect(digestMacMatches('j'.repeat(64), PERSON, parsed.mac)).toBe(false);
    expect(digestMacMatches(KEY, OTHER, parsed.mac)).toBe(false);
  });

  it('does not verify when the signature is changed', () => {
    const token = signDigestToken(PERSON, KEY);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const parsed = parseDigestToken(flipped)!;
    expect(digestMacMatches(KEY, parsed.personId, parsed.mac)).toBe(false);
  });

  it('accepts only the exact text the server wrote, not another spelling of the same bytes', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const token = signDigestToken(PERSON, KEY);
    const mac = token.split('.')[2]!;
    const i = alphabet.indexOf(mac.slice(-1));
    const sibling = alphabet[(i & ~3) | ((i + 1) & 3)]!;               // same four data bits, different spare bits
    expect(Buffer.from(mac.slice(0, -1) + sibling, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    expect(digestMacMatches(KEY, PERSON, mac)).toBe(true);
    expect(digestMacMatches(KEY, PERSON, mac.slice(0, -1) + sibling)).toBe(false);
  });

  it('is not parsed when it is not shaped like a token', () => {
    const good = signDigestToken(PERSON, KEY);
    for (const bad of ['', 'v1', 'v2.' + good.slice(3), `v1.${PERSON}`, `v1.not-a-uuid.${good.split('.')[2]}`, `${good}.extra`, `${good}x`, 'x'.repeat(500), good.replace('.', '/')]) {
      expect(parseDigestToken(bad), bad).toBeNull();
    }
  });
});
