import { expectLinear } from '@manythreads/test-utils';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_DOC_CHARS,
  MAX_MESSAGE_CHARS,
  clip,
  contentHash,
  documentIdFor,
  metadataOf,
  renderApproval,
  renderMessage,
  renderPage,
  renderRun,
  renderThread,
  tagOf,
  tidy,
} from '../src/render.ts';

// The feed's text work: bounded, linear, and stable (the same source text always has the same hash and document id).

const ID = '01a12f92-3e2a-78fd-88fd-5762c95a772b';

describe('clip', () => {
  it('leaves short text alone and cuts long text with an ellipsis, never inside a surrogate pair', () => {
    expect(clip('short', 10)).toBe('short');
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    const emoji = '😀'.repeat(10); // 20 UTF-16 units
    for (let max = 2; max < 20; max += 1) {
      const out = clip(emoji, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(/[\ud800-\udbff]…$/); // no lone high surrogate before the ellipsis
    }
  });
});

describe('tidy', () => {
  it('normalises newlines, drops trailing spaces and collapses blank runs', () => {
    expect(tidy('a  \r\n\r\n\r\n\r\nb\r\n')).toBe('a\n\nb');
    expect(tidy('  \n\n x \n')).toBe('x');
  });

  it('is linear: a megabyte of blank lines and of long lines takes well under a second', () => {
    // the same three constructions at n and 4n: linear growth, under a ceiling a busy machine does not reach
    expectLinear(
      (n) => ['\n'.repeat(n), `${'x'.repeat(n)}\n`, ' \r\n'.repeat(n / 3)],
      (inputs) => inputs.forEach((input) => tidy(input)),
      { n: 250_000, label: 'tidy' },
    );
  });
});

describe('hash and document id', () => {
  const KEY = Buffer.alloc(32, 7);

  it('the same text under the same key has the same digest; another text or another key a different one; a document id carries kind, source and version', () => {
    const a = contentHash('hello', KEY);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash('hello', KEY)).toBe(a);
    expect(contentHash('hello!', KEY)).not.toBe(a);
    expect(contentHash('hello', Buffer.alloc(32, 8))).not.toBe(a);
    const id = documentIdFor('message', ID, a);
    expect(id).toBe(`feed:message:${ID}:${a.slice(0, 16)}`);
    expect(documentIdFor('message', ID, contentHash('hello!', KEY))).not.toBe(id);
    expect(documentIdFor('thread', ID, a)).not.toBe(id);
  });

  it('is keyed: the digest is not the plain sha-256 of the text, so a guess cannot be tested against a log line or a document id', () => {
    const plain = createHash('sha256').update('hello', 'utf8').digest('hex');
    expect(contentHash('hello', KEY)).not.toBe(plain);
    expect(documentIdFor('message', ID, contentHash('hello', KEY))).not.toContain(plain.slice(0, 16));
  });

  it('a path-like source id is hashed, so the id stays short and cannot collide with a uuid shape', () => {
    const long = `${ID}/pages/${'deep/'.repeat(100)}page.md`;
    const id = documentIdFor('page', long, contentHash('x', KEY));
    expect(id.length).toBeLessThan(80);
    expect(id).toMatch(/^feed:page:[0-9a-f]{24}:[0-9a-f]{16}$/);
    expect(documentIdFor('page', `${ID}/pages/a.md`, contentHash('x', KEY))).not.toBe(documentIdFor('page', `${ID}/pages/b.md`, contentHash('x', KEY)));
  });
});

describe('metadataOf and tagOf', () => {
  it('leaves out empty values and clips to the provider’s limits', () => {
    const m = metadataOf({ a: 'x', b: '', c: null, d: undefined, e: 'y'.repeat(900), ['k'.repeat(100)]: 'v' });
    expect(Object.keys(m).sort()).toEqual(['a', 'e', 'k'.repeat(64)]);
    expect(m['e']?.length).toBe(500);
  });

  it('a tag is at most 64 characters', () => {
    expect(tagOf('channel', 'general')).toBe('channel:general');
    expect(tagOf('channel', 'x'.repeat(100)).length).toBe(64);
  });
});

describe('renderers', () => {
  it('a message names the author, the channel and the day, and keeps the text', () => {
    const r = renderMessage({ channelName: 'dev', authorName: 'Nadia', at: '2026-10-12T09:30:00.000Z', body: 'We freeze on Friday.' });
    expect(r.content).toBe('Nadia wrote in #dev on 2026-10-12 09:30:\nWe freeze on Friday.');
    expect(r.context).toBe('Message in #dev');
  });

  it('a message is bounded', () => {
    const r = renderMessage({ channelName: 'dev', authorName: 'N', at: '2026-10-12T09:30:00.000Z', body: 'x'.repeat(200_000) });
    expect(r.content.length).toBeLessThanOrEqual(MAX_DOC_CHARS + 100);
  });

  it('a thread quotes the root and replies in order, and says when it is partial', () => {
    const messages = [
      { authorName: 'Omar', at: '2026-10-12T09:00:00.000Z', body: 'Can we ship?' },
      { authorName: 'Nadia', at: '2026-10-12T09:05:00.000Z', body: 'After the migration.' },
    ];
    const whole = renderThread({ channelName: 'dev', title: 'Ship it', messages, moreReplies: 0 });
    expect(whole.content).toBe('Thread in #dev: Ship it\n[2026-10-12 09:00] Omar: Can we ship?\n[2026-10-12 09:05] Nadia: After the migration.');
    const partial = renderThread({ channelName: 'dev', title: '', messages, moreReplies: 3 });
    expect(partial.content).toMatch(/^Thread in #dev\n/);
    expect(partial.content).toMatch(/\(3 more messages in the thread are not included\.\)$/);
  });

  it('a thread never exceeds the engine’s limit, however many long messages it has', () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({ authorName: `P${i}`, at: '2026-10-12T09:00:00.000Z', body: 'w'.repeat(MAX_MESSAGE_CHARS * 2) }));
    const r = renderThread({ channelName: 'dev', title: 't', messages, moreReplies: 0 });
    expect(r.content.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
    expect(r.content).toMatch(/more messages in the thread are not included/);
  });

  it('a run is told in words with counts of what it read, never ids', () => {
    const r = renderRun({
      botName: 'Archivist',
      teamSlug: 'engineering',
      trigger: 'mention',
      status: 'done',
      startedAt: '2026-10-12T09:00:00.000Z',
      endedAt: '2026-10-12T09:01:00.000Z',
      askerName: 'Nadia',
      channelName: 'dev',
      sources: [{ type: 'memory', count: 1 }, { type: 'message', count: 3 }],
    });
    expect(r.content).toContain('The bot Archivist of team engineering ran for a mention in #dev, asked by Nadia.');
    expect(r.content).toContain('It read 4 sources: 1 memory, 3 message.');
    expect(renderRun({ botName: 'B', teamSlug: 't', trigger: 'routine', status: 'failed', startedAt: '2026-10-12T09:00:00.000Z', endedAt: null, askerName: null, channelName: null, sources: [] }).content).toContain('It read nothing');
  });

  it('an approval says who asked, what, and how it ended, without arguments', () => {
    const approved = renderApproval({
      tool: 'pages.write',
      source: 'grant',
      summary: 'Write pages/reports/q3.md',
      status: 'approved',
      outcome: 'ran',
      outcomeDetail: '',
      requesterName: 'Nadia',
      botName: 'Reporter',
      deciderName: 'Omar',
      decidedAt: '2026-10-12T10:00:00.000Z',
      channelName: 'dev',
    });
    expect(approved.content).toContain('Approval requested by Reporter (for Nadia) in #dev: Write pages/reports/q3.md');
    expect(approved.content).toContain('Approved by Omar on 2026-10-12 10:00.');
    expect(approved.content).toContain('The call ran');
    expect(renderApproval({ ...{ tool: 't', source: 'dlp', summary: 's', outcome: 'none', outcomeDetail: '', requesterName: 'N', botName: null, deciderName: null, decidedAt: null, channelName: null }, status: 'expired' }).content).toContain('it lapsed');
  });

  it('a page is its path, its last writer and its text, bounded', () => {
    const r = renderPage({ path: 'pages/plan.md', text: `# Plan\n\n\n\n${'y'.repeat(100_000)}`, authorName: 'Omar', at: '2026-10-12T09:00:00.000Z' });
    expect(r.content.startsWith('Page pages/plan.md, last written by Omar on 2026-10-12 09:00:\n# Plan\n\ny')).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(MAX_DOC_CHARS);
  });
});
