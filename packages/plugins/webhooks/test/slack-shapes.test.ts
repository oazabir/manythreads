import { parseMarkup } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { adapt, adaptSlackMessage, blocksToMarkdown, parseBody, slackToMarkdown } from '../src/adapters/index.ts';
import type { Adapted } from '../src/adapters/index.ts';
import { isTs, messageIdToTs, tsToIdRange } from '../src/ts.ts';
import { emojiFromSlackName } from '../src/emoji.ts';
import { API_TOKEN_SHAPE, hashWebhookSecret, newApiToken, newOutgoingSigningSecret } from '../src/secrets.ts';

// What the Slack-shaped payloads become: Block Kit (a subset) and attachments turned into Markdown, mrkdwn converted, hostile input made harmless and
// linear in time, a ts that maps to a message id, an emoji name, and the shape and hashing of a token.

const call = (json: unknown): Adapted => adapt({ headers: {}, contentType: 'application/json', raw: JSON.stringify(json), json });
const text = (r: Adapted): string => {
  expect(r.kind, JSON.stringify(r)).toBe('post');
  return r.kind === 'post' ? r.text : '';
};

describe('mrkdwn to Markdown', () => {
  it('converts bold, strike, links with and without a label, and unescapes the three entities', () => {
    expect(slackToMarkdown('*bold* and ~gone~')).toBe('**bold** and ~~gone~~');
    expect(slackToMarkdown('see <https://example.com/a|the docs> now')).toBe('see [the docs](https://example.com/a) now');
    expect(slackToMarkdown('see <https://example.com/a> now')).toContain('https://example.com/a');
    expect(slackToMarkdown('1 &lt; 2 &amp;&amp; 3 &gt; 2')).toBe('1 < 2 && 3 > 2');
  });
  it('keeps mentions as words that notify nobody', () => {
    for (const s of ['<@U123>', '<@U123|omar>', '<!here>', '<!channel>', '<!everyone>', '<#CHAN1|general>', '<!subteam^S1|@devs>']) {
      const out = slackToMarkdown(s);
      expect(parseMarkup(out).mentions, `${s} -> ${out}`).toEqual([]);
      expect(out, s).not.toMatch(/@(?=[A-Za-z0-9])/);
    }
  });
  it('does not make a link of a javascript: or data: address, or one with a password in it', () => {
    for (const s of ['<javascript:alert(1)|click>', '<data:text/html,x|click>', '<https://u:p@example.com/|click>']) {
      const out = slackToMarkdown(s);
      expect(out, s).not.toMatch(/\]\((javascript|data):/i);
      expect(out, s).not.toContain('u:p@');
    }
  });
  it('a label that names another site than the link goes to is followed by the real host; an ordinary label is left alone', () => {
    expect(slackToMarkdown('<https://evil.com/login|https://bank.com>')).toBe('[https://bank.com](https://evil.com/login) (evil.com)');
    expect(slackToMarkdown('<https://evil.com|Log in at www.bank.com now>')).toContain('(evil.com)');
    expect(slackToMarkdown('<https://evil.com/x|bank.com>')).toBe('[bank.com](https://evil.com/x) (evil.com)');
    // the label names the site it goes to (www or not, with a path): no extra host
    expect(slackToMarkdown('<https://example.com/a|https://www.example.com/a>')).toBe('[https://www.example.com/a](https://example.com/a)');
    expect(slackToMarkdown('<https://example.com/a|example.com>')).toBe('[example.com](https://example.com/a)');
    expect(slackToMarkdown('<https://example.com/a|the docs>')).toBe('[the docs](https://example.com/a)');
    // the same for a button and an image of Block Kit
    const r = blocksToMarkdown([{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'bank.com' }, url: 'https://evil.com/pay' }] }]);
    expect(r.text).toContain('(evil.com)');
  });
  it('a label cannot break out of the link or inject a second one', () => {
    const out = slackToMarkdown('<https://example.com/a|x](https://evil.example/)[y>');
    // the brackets of the label are escaped, so no second link is formed
    expect(out).not.toMatch(/(?<!\\)\]\(https:\/\/evil/);
  });
});

describe('Block Kit subset', () => {
  it('shows header, section text and fields, divider, context, image as a link, actions as links only', () => {
    const r = blocksToMarkdown([
      { type: 'header', text: { type: 'plain_text', text: 'Deploy finished' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*prod* is on `v1.2`' }, fields: [{ type: 'mrkdwn', text: '*Env*\nprod' }, { type: 'mrkdwn', text: '*Who*\nana' }] },
      { type: 'divider' },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'by the pipeline' }, { type: 'image', image_url: 'https://example.com/i.png', alt_text: 'logo' }] },
      { type: 'image', image_url: 'https://example.com/chart.png', alt_text: 'Chart' },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open run' }, url: 'https://example.com/run/1' }, { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve' }] },
    ]);
    expect(r.skipped).toBe(0);
    expect(r.text).toContain('Deploy finished');
    expect(r.text).toContain('**prod** is on `v1.2`');
    expect(r.text).toContain('**Env**');
    expect(r.text).toContain('---');
    expect(r.text).toContain('by the pipeline');
    expect(r.text).toContain('[Chart](https://example.com/chart.png)');
    expect(r.text).toContain('[Open run](https://example.com/run/1)');
    // a button with no address cannot do anything here and is not pretended to
    expect(r.text).not.toContain('Approve');
  });
  it('skips blocks it does not know and counts them, never an error', () => {
    const r = blocksToMarkdown([{ type: 'rich_text', elements: [] }, { type: 'header', text: { type: 'plain_text', text: 'Kept' } }, { type: 'input' }, { nope: 1 }, 'string', null, 42]);
    expect(r.text).toContain('Kept');
    expect(r.skipped).toBe(6);
  });
  it('reads a message of blocks and fallback text, and a message with only an unknown block says what it skipped', () => {
    const a = adaptSlackMessage({ text: 'fallback', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'from the block' } }] });
    expect(a.kind).toBe('post');
    expect(text(a)).toContain('from the block');
    const b = adaptSlackMessage({ blocks: [{ type: 'rich_text' }] });
    expect(b.kind).toBe('reject');
  });
  it('is not a list: a non-array value of blocks is ignored without an error', () => {
    expect(adaptSlackMessage({ text: 'x', blocks: 'not blocks' as unknown as unknown[] }).kind).toBe('post');
    expect(adaptSlackMessage({ text: 'x', blocks: { type: 'section' } as unknown as unknown[] }).kind).toBe('post');
  });
  it('shows at most 50 blocks and counts the rest as skipped', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ type: 'section', text: { type: 'mrkdwn', text: `line ${i}` } }));
    const r = blocksToMarkdown(many);
    expect(r.text).toContain('line 0');
    expect(r.text).not.toContain('line 79');
    expect(r.skipped).toBe(30);
  });
  it('hostile text inside blocks cannot notify, run script, or link to javascript:', () => {
    // a Markdown link the sender writes by hand is left to the message renderer, which refuses javascript: addresses (clients/web/src/channels/markdown.ts)
    const hostile = '@here <@U1> <script>alert(1)</script> <!channel>';
    const r = blocksToMarkdown([
      { type: 'header', text: { type: 'plain_text', text: hostile } },
      { type: 'section', text: { type: 'mrkdwn', text: hostile }, fields: [{ type: 'mrkdwn', text: hostile }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: hostile }] },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: hostile }, url: 'javascript:alert(1)' }] },
    ]);
    expect(parseMarkup(r.text ?? '').mentions).toEqual([]);
    expect(r.text ?? '').not.toContain('<script');
    expect(r.text ?? '').not.toMatch(/javascript:/i);
  });
  it('stays linear on hostile 1 MB inputs', () => {
    const big = (s: string): string => s.repeat(Math.ceil(1_000_000 / s.length));
    for (const s of ['<', '<a|', '*', '~', '&amp;', '<@', '<https://x|', '`']) {
      const t0 = performance.now();
      blocksToMarkdown([{ type: 'section', text: { type: 'mrkdwn', text: big(s) }, fields: [{ type: 'mrkdwn', text: big(s) }] }]);
      slackToMarkdown(big(s));
      expect(performance.now() - t0, s).toBeLessThan(2_000);
    }
    const t1 = performance.now();
    blocksToMarkdown(Array.from({ length: 200_000 }, () => ({ type: 'nothing' })));
    expect(performance.now() - t1).toBeLessThan(2_000);
  });
});

describe('attachments (Slack legacy) and Mattermost', () => {
  it('turns title, text, color, fields and fallback into a card', () => {
    const t = text(call({ attachments: [{ color: 'good', title: 'Build 12', title_link: 'https://ci.example.com/12', text: 'All *green*', fields: [{ title: 'Branch', value: 'main', short: true }, { title: 'Time', value: '2 min' }], fallback: 'Build 12 ok' }] }));
    expect(t).toContain('Build 12');
    expect(t).toContain('https://ci.example.com/12');
    expect(t).toContain('All **green**');
    expect(t).toContain('Branch');
    expect(t).toContain('main');
    expect(t).toContain('2 min');
  });
  it('uses the fallback only when there is nothing else to show', () => {
    expect(text(call({ attachments: [{ fallback: 'Only a fallback' }] }))).toContain('Only a fallback');
    expect(text(call({ attachments: [{ text: 'Real text', fallback: 'ignored fallback' }] }))).not.toContain('ignored fallback');
  });
  it('reads Mattermost: text with props.card, and attachments with the same fields', () => {
    const t = text(call({ text: 'hello from mm', username: 'ignored', icon_url: 'https://x.example/i.png', attachments: [{ pretext: 'Pre', title: 'T', text: 'Body', fields: [{ title: 'F', value: 'V', short: false }] }] }));
    expect(t).toContain('hello from mm');
    expect(t).toContain('Body');
    expect(t).toContain('V');
  });
  it('counts skipped blocks of a call and is not an error', () => {
    const r = call({ text: 'hi', blocks: [{ type: 'rich_text' }, { type: 'section', text: { type: 'mrkdwn', text: 'ok' } }] });
    expect(r.kind).toBe('post');
    expect(r.kind === 'post' ? r.skipped : -1).toBe(1);
  });
  it('a JSON body that is deeply nested or huge is answered, not run into', () => {
    const deep = `{"text":"x","blocks":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;
    expect(['post', 'reject']).toContain(adapt({ headers: {}, contentType: 'application/json', raw: deep, json: parseBody('application/json', deep) }).kind);
  });
});

describe('ts: a message id as a Slack timestamp', () => {
  const id = '019a4c3e-7f2b-7abc-8123-456789abcdef';
  it('is "<seconds>.<six digits>" and is found again through the id range', () => {
    const ts = messageIdToTs(id);
    expect(ts).toMatch(/^\d{10}\.\d{6}$/);
    expect(isTs(ts)).toBe(true);
    const range = tsToIdRange(ts)!;
    expect(range.lo <= id && id <= range.hi).toBe(true);
    expect(range.lo.slice(14, 15)).toBe('7');
  });
  it('is increasing with time and rejects what is not a ts', () => {
    const a = messageIdToTs('019a4c3e-7f2b-7000-8000-000000000000');
    const b = messageIdToTs('019a4c3e-7f2c-7000-8000-000000000000');
    expect(b > a).toBe(true);
    for (const bad of ['', 'abc', '1700000000', '1700000000.12', '1700000000.1234567', '-1.000000', '99999999999999.000000']) {
      expect(isTs(bad), bad).toBe(false);
      if (!isTs(bad)) expect(tsToIdRange(bad), bad).toBeNull();
    }
  });
  it('round-trips many ids over a range of times', () => {
    for (let ms = 1_700_000_000_000; ms < 1_700_000_000_000 + 5_000; ms += 137) {
      const hex = ms.toString(16).padStart(12, '0');
      const rand = Math.floor(Math.random() * 4096).toString(16).padStart(3, '0');
      const mid = `${hex.slice(0, 8)}-${hex.slice(8)}-7${rand}-9abc-0123456789ab`;
      const range = tsToIdRange(messageIdToTs(mid))!;
      expect(range.lo <= mid && mid <= range.hi, mid).toBe(true);
    }
  });
});

describe('emoji names', () => {
  it('maps common Slack names, with colons and skin tone ignored, and leaves unknown names unknown', () => {
    expect(emojiFromSlackName('thumbsup')).toEqual({ kind: 'unicode', emoji: '👍' });
    expect(emojiFromSlackName(':white_check_mark:')).toEqual({ kind: 'unicode', emoji: '✅' });
    expect(emojiFromSlackName('+1::skin-tone-3')).toEqual({ kind: 'unicode', emoji: '👍' });
    expect(emojiFromSlackName('party_parrot_x')).toEqual({ kind: 'custom', name: 'party_parrot_x' });
    expect(emojiFromSlackName('bad name!')).toEqual({ kind: 'unknown' });
    expect(emojiFromSlackName(42)).toEqual({ kind: 'unknown' });
  });
});

describe('token shape and hashing', () => {
  it('an API token is mtat_ plus 43 url-safe characters, never repeats, and is stored as a hash that is not the token', () => {
    const a = newApiToken();
    const b = newApiToken();
    expect(a).toMatch(API_TOKEN_SHAPE);
    expect(a).not.toBe(b);
    const h = hashWebhookSecret(a);
    expect(h.toString('utf8')).not.toContain(a);
    expect(h).toHaveLength(32);
    expect(h.equals(hashWebhookSecret(a))).toBe(true);
    expect(h.equals(hashWebhookSecret(b))).toBe(false);
    expect(newOutgoingSigningSecret()).toMatch(/^mtos_/);
  });
});
