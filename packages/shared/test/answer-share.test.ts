import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../test-utils/src/linear.ts';
import {
  ANSWER_LIMITS,
  AnswerMaskedCitation,
  AnswerPayload,
  AnswerPayloadView,
  AnswerAnswerSharedEvent,
  answerPageMarkdown,
  answerPagePath,
  citationNumbers,
  eventRegistry,
  handoffMessage,
  isSubsequence,
  isSupportedCitation,
  maskAnswer,
  pageSlug,
  pageTitle,
  removeClaims,
  type CitationVerdict,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

// Masking an answer for the readers of a copy (PLAN P5-17, SPEC §6.3): the pure rules. The database decides which citations a place's readers
// may open (answer migration 0003, tested in test/rls); this is what is built from its verdicts — and the proof that a copy is only ever less.

const BODY = 'The deploy waits for the Monday window [1]. Leadership also has plans [2] that I cannot repeat. Your own question is [3].';

const original = (over: Record<string, unknown> = {}): AnswerPayload =>
  AnswerPayload.parse({
    version: 1,
    body: BODY,
    citations: [
      { kind: 'message', n: 1, label: 'The deploy waits for the Monday change window', scope: 'team', messageId: uuid(10), channelId: uuid(11), teamId: uuid(12), channelKind: 'channel', channelName: 'dev', threadRootId: null },
      { kind: 'message', n: 2, label: 'Layoffs are planned for March', scope: 'channel', messageId: uuid(13), channelId: uuid(14), teamId: uuid(12), channelKind: 'channel', channelName: 'leads', threadRootId: null },
      { kind: 'run', n: 3, label: 'Brain · conversation', scope: 'person', runId: uuid(15), botId: uuid(16), botSlug: 'brain' },
    ],
    lineage: [
      { n: 1, kind: 'message', label: 'The deploy waits for the Monday change window', at: '2026-10-01T12:00:00.000Z', snippet: 'waits for the Monday window' },
      { n: 2, kind: 'message', label: 'Layoffs are planned for March', at: '2026-10-02T09:00:00.000Z', snippet: 'Layoffs are planned for March' },
      { n: 3, kind: 'run', label: 'Brain · conversation', at: '2026-10-03T09:00:00.000Z', snippet: null },
    ],
    sourcesReached: [
      { kind: 'message', ref: uuid(10), label: 'The deploy waits for the Monday change window', marker: 'full' },
      { kind: 'message', ref: uuid(13), label: 'Layoffs are planned for March', marker: 'full' },
      { kind: 'drive', ref: 'doc-1', label: null, marker: 'scoped' },
    ],
    outsideScope: { count: 1, items: [{ kind: 'message', reason: 'not_visible', count: 1 }] },
    answeredFor: { personId: uuid(20), name: 'Omar', scope: 'scoped', alias: 'smart', botId: uuid(21), runId: uuid(22) },
    chips: [
      { kind: 'followup', label: 'Why?', prompt: 'Why is it waiting?' },
      { kind: 'handoff', botId: uuid(23), botSlug: 'coder', botName: 'Coder' },
    ],
    ...over,
  });

const KEEP_ONE: CitationVerdict[] = [
  { n: 1, kept: true, label: 'The deploy waits for the Monday change window' },
  { n: 2, kept: false },
  { n: 3, kept: false },
];

describe('maskAnswer', () => {
  it('keeps what the readers may open, replaces the rest by a masked citation and leaves the text as it was', () => {
    const m = maskAnswer(original(), KEEP_ONE, [{ kept: true }, { kept: false }, { kept: false }], []);
    const copy = m.copy!;
    expect(copy.body).toBe(BODY);
    expect(copy.citations.map((c) => [c.n, c.kind])).toEqual([[1, 'message'], [2, 'masked'], [3, 'masked']]);
    expect(m.counts).toMatchObject({ kept: 1, masked: 2, removed: 0, sentences: 0, sourcesDropped: 2 });
    expect(m.maskedNumbers).toEqual([2, 3]);
    expect(copy.share).toEqual({ masked: 2, removed: 0 });
    expect(m.items.map((i) => [i.n, i.status])).toEqual([[1, 'kept'], [2, 'masked'], [3, 'masked']]);
  });

  it('a masked citation is its number and the kind of source: no label, scope, date, snippet or any field that says where it lives', () => {
    const copy = maskAnswer(original(), KEEP_ONE, [], []).copy!;
    const masked = copy.citations.filter((c) => c.kind === 'masked');
    expect(masked).toEqual([
      { kind: 'masked', n: 2, source: 'message' },
      { kind: 'masked', n: 3, source: 'run' },
    ]);
    // the lineage keeps an entry for each, with the label, date and snippet gone
    expect(copy.lineage.filter((l) => l.masked)).toEqual([
      { n: 2, kind: 'message', label: '', at: null, snippet: null, masked: true },
      { n: 3, kind: 'run', label: '', at: null, snippet: null, masked: true },
    ]);
    // and nothing of a masked source is anywhere in what is posted: not its words, its ids, its team or its channel
    const wire = JSON.stringify(copy);
    for (const secret of ['Layoffs', 'leads', uuid(13), uuid(14), uuid(15), uuid(16), 'brain', '2026-10-02', '2026-10-03', 'Brain · conversation']) {
      expect(wire, `the copy must not contain "${secret}"`).not.toContain(secret);
    }
    // a masked citation carries no teamId at all, even though the original's two did
    expect(masked.every((c) => !('teamId' in c))).toBe(true);
    expect(wire.match(/teamId/g) ?? []).toHaveLength(1); // the kept message's own
  });

  it('a citation with no verdict is masked: absent is never "may be shown"', () => {
    const copy = maskAnswer(original(), [{ n: 1, kept: true }], [], []).copy!;
    expect(copy.citations.map((c) => c.kind)).toEqual(['message', 'masked', 'masked']);
  });

  it('reads a kept citation again: its label and date are the verdict’s, not the stored ones', () => {
    const copy = maskAnswer(original(), [{ n: 1, kept: true, label: 'The window moved to Tuesday', at: '2026-10-05T08:00:00.000Z' }, { n: 2, kept: false }, { n: 3, kept: false }], [], []).copy!;
    const first = copy.citations[0]!;
    expect(first.kind === 'message' ? first.label : null).toBe('The window moved to Tuesday');
    expect(copy.lineage[0]).toMatchObject({ n: 1, label: 'The window moved to Tuesday', at: '2026-10-05T08:00:00.000Z', snippet: 'waits for the Monday window' });
  });

  it('removing a claim takes its sentence and its citation out, and nothing else; only removal', () => {
    const m = maskAnswer(original(), KEEP_ONE, [], [2]);
    const copy = m.copy!;
    expect(copy.body).toBe('The deploy waits for the Monday window [1]. Your own question is [3].');
    expect(copy.citations.map((c) => c.n)).toEqual([1, 3]);
    expect(copy.lineage.map((l) => l.n)).toEqual([1, 3]);
    expect(m.counts).toMatchObject({ removed: 1, sentences: 1, masked: 1 });
    expect(m.items.find((i) => i.n === 2)).toMatchObject({ status: 'removed', label: 'Layoffs are planned for March' });
    // what is posted never names the removed claim's source
    expect(JSON.stringify(copy)).not.toContain('Layoffs');
    expect(isSubsequence(copy.body, BODY)).toBe(true);
  });

  it('removing every claim leaves nothing to share: no copy', () => {
    expect(maskAnswer(original({ body: 'Only claim [1].' }), KEEP_ONE, [], [1]).copy).toBeNull();
  });

  it('never adds: citations, lineage and sources reached of the copy are subsets by number, chips are gone and the counts only grow by what was taken out', () => {
    const o = original();
    const copy = maskAnswer(o, KEEP_ONE, [{ kept: true }, { kept: false }, { kept: false }], [3]).copy!;
    const have = new Set(citationNumbers(o));
    expect(copy.citations.every((c) => have.has(c.n))).toBe(true);
    expect(copy.lineage.every((l) => have.has(l.n))).toBe(true);
    expect(copy.chips).toEqual([]);
    expect(copy.sourcesReached.every((s) => o.sourcesReached.some((r) => JSON.stringify(r) === JSON.stringify(s)))).toBe(true);
    expect(copy.answeredFor).toEqual(o.answeredFor);
    // the two reached sources it dropped are counted as "not shared" by kind, never named
    expect(copy.outsideScope.items).toContainEqual({ kind: 'message', reason: 'not_shared', count: 1 });
    expect(copy.outsideScope.items).toContainEqual({ kind: 'drive', reason: 'not_shared', count: 1 });
    expect(copy.outsideScope.count).toBe(o.outsideScope.count + 2);
    expect(JSON.stringify(copy.outsideScope)).not.toContain('doc-1');
  });

  it('a payload with a masked citation parses with the strict and the tolerant schema, and clients know the kind', () => {
    const copy = maskAnswer(original(), KEEP_ONE, [], []).copy!;
    expect(AnswerPayload.safeParse(JSON.parse(JSON.stringify(copy))).success).toBe(true);
    const view = AnswerPayloadView.parse(JSON.parse(JSON.stringify(copy)));
    expect(view.citations.map((c) => isSupportedCitation(c))).toEqual([true, true, true]);
    expect(AnswerMaskedCitation.safeParse({ kind: 'masked', n: 1, source: 'message', teamId: uuid(1) }).success).toBe(false);
  });

  it('survives forty citations, a hundred sources and a body of 20,000 characters', () => {
    const citations = Array.from({ length: ANSWER_LIMITS.citations }, (_, i) => ({
      kind: 'file' as const,
      n: i + 1,
      label: `file ${String(i)}`,
      scope: 'channel' as const,
      fileId: uuid(100 + i),
    }));
    const big = AnswerPayload.parse({
      ...original(),
      body: `${'Claim [1]. '.repeat(1_500)}${'x'.repeat(1_000)}`,
      citations,
      lineage: citations.map((c) => ({ n: c.n, kind: 'file', label: c.label, at: null, snippet: null })),
      sourcesReached: Array.from({ length: ANSWER_LIMITS.sources }, (_, i) => ({ kind: 'file', ref: uuid(300 + i), label: null, marker: 'full' as const })),
    });
    const m = maskAnswer(big, [], [], [1, 2, 3]);
    expect(m.copy!.citations).toHaveLength(37);
    expect(m.counts.sourcesDropped).toBe(ANSWER_LIMITS.sources);
  });
});

describe('removeClaims', () => {
  it('takes the sentences that carry a removed marker, the marker after a stop included', () => {
    expect(removeClaims('First [1]. Second.[2] Third [3].', new Set([2])).body).toBe('First [1]. Third [3].');
    expect(removeClaims('A claim [2]! And a question [3]? Done.', new Set([2, 3])).body).toBe('Done.');
    expect(removeClaims('It is 3.5 percent [1] today.', new Set([1])).body).toBe('');
  });

  it('leaves the text alone when nothing is removed, and when the number is not in it', () => {
    expect(removeClaims(BODY, new Set()).body).toBe(BODY);
    expect(removeClaims(BODY, new Set([9])).body).toBe(BODY);
    expect(removeClaims(BODY, new Set([9])).sentences).toBe(0);
  });

  it('drops a whole list item with its bullet and keeps the others; a paragraph that empties leaves one blank line', () => {
    const body = 'Intro text.\n\n- first point [1]\n- second point [2]\n- third point [3]\n\nSecond paragraph [2].\n\nClosing.';
    expect(removeClaims(body, new Set([2])).body).toBe('Intro text.\n\n- first point [1]\n- third point [3]\n\nClosing.');
  });

  it('does not touch fenced code: a [2] in it is text', () => {
    const body = 'Run it [2].\n\n```\nlist[2] = 1;\n```\n\nDone [1].';
    expect(removeClaims(body, new Set([2])).body).toBe('```\nlist[2] = 1;\n```\n\nDone [1].');
  });

  it('is a deletion only: for any input the result is a subsequence of it', () => {
    const alphabet = ['a', 'b', ' ', '.', '!', '?', '[', ']', '1', '2', '3', '\n', '-', '*', '>', '`', '#', '. ', '[1]', '[2]', '。'];
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 400; round += 1) {
      let text = '';
      const len = 1 + (next() % 60);
      for (let i = 0; i < len; i += 1) text += alphabet[next() % alphabet.length]!;
      const out = removeClaims(text, new Set([1, 2]));
      expect(isSubsequence(out.body, text), JSON.stringify({ text, out: out.body })).toBe(true);
      expect(out.body.length).toBeLessThanOrEqual(text.length);
    }
  });

  it('isSubsequence says no to an added word', () => {
    expect(isSubsequence('a c', 'a b c')).toBe(true);
    expect(isSubsequence('a d c', 'a b c')).toBe(false);
    expect(isSubsequence('abc', 'ab')).toBe(false);
  });
});

describe('hostile input stays linear', () => {
  const cases: Array<[string, (n: number) => string]> = [
    ['brackets', (n) => '['.repeat(n)],
    ['markers', (n) => '[1]'.repeat(n / 3)],
    ['stops', (n) => '.'.repeat(n)],
    ['stops and markers', (n) => '.[1]'.repeat(n / 4)],
    ['stops then spaces', (n) => '. '.repeat(n / 2)],
    ['fence marks', (n) => '```\n'.repeat(n / 4)],
    ['bullets', (n) => '- a [1]\n'.repeat(n / 8)],
    ['digits in brackets', (n) => '[123456789]'.repeat(n / 11)],
    ['one very long line', (n) => `${'word '.repeat(n / 5)}[2].`],
  ];
  for (const [name, build] of cases) {
    it(name, () => {
      expectLinear(build, (input) => removeClaims(input, new Set([1, 2])), { n: 20_000, label: name, ceilingMs: 1500 });
    });
  }
});

describe('the page', () => {
  it('names a page by day, a slug of its first line and the tail of the answer’s id; only a-z, 0-9 and dashes reach the path', () => {
    const title = pageTitle('## **The deploy** waits for the `Monday` window [1].\n\nMore.');
    expect(title).toBe('The deploy waits for the Monday window');
    const path = answerPagePath('2026-10-13', title, '0190a000-0000-7000-8000-0000deadbeef');
    expect(path).toBe('pages/answers/2026-10-13-the-deploy-waits-for-the-monday-window-deadbeef.md');
    expect(answerPagePath('2026-10-13', '../../../etc/passwd', uuid(1))).toMatch(/^pages\/answers\/2026-10-13-etc-passwd-[0-9a-f]{8}\.md$/);
  });

  it('falls back to "answer" when no letter or digit is left (an Arabic title, symbols) and refuses a bad date', () => {
    expect(pageSlug('مرحبا بالعالم')).toBe('answer');
    expect(pageSlug('!!! ???')).toBe('answer');
    expect(answerPagePath('not-a-date', 'x', uuid(1))).toMatch(/^pages\/answers\/1970-01-01-x-/);
    expect(pageSlug('a'.repeat(500)).length).toBeLessThanOrEqual(48);
  });

  it('renders the copy: the text, the kept sources with their labels, the masked ones as "not shared", and whom it was for', () => {
    const copy = maskAnswer(original(), KEEP_ONE, [], []).copy!;
    const md = answerPageMarkdown(copy, '2026-10-13');
    expect(md).toContain('# The deploy waits for the Monday window');
    expect(md).toContain(BODY);
    expect(md).toContain('1. The deploy waits for the Monday change window (message)');
    expect(md).toContain("2. from Omar's message · not shared");
    expect(md).toContain("3. from Omar's run · not shared");
    expect(md).toContain('Answered for Omar · scoped · smart. Saved from a conversation on 2026-10-13.');
    for (const secret of ['Layoffs', 'leads', uuid(13), 'Brain · conversation']) expect(md).not.toContain(secret);
  });
});

describe('the hand-off text', () => {
  it('quotes the question, gives the answer and names each source; a masked one is "not shared"', () => {
    const copy = maskAnswer(original(), KEEP_ONE, [], []).copy!;
    const text = handoffMessage({ fromBot: 'Brain', question: 'What is blocking\nthe release?', copy });
    expect(text).toContain('Handed over from Brain.');
    expect(text).toContain('> What is blocking\n> the release?');
    expect(text).toContain(BODY);
    expect(text).toContain('[1] The deploy waits for the Monday change window (message)');
    expect(text).toContain('[2] a message that is not shared');
    expect(text).not.toContain('Layoffs');
    expect(text.length).toBeLessThan(40_000);
  });
});

describe('the access event', () => {
  it('is registered, strict about what it carries and names no source', () => {
    expect(eventRegistry['answer.answer.shared'][1]).toBe(AnswerAnswerSharedEvent);
    const base = {
      type: 'answer.answer.shared',
      schemaVersion: 1,
      workspaceId: uuid(1),
      kind: 'channel',
      personId: uuid(2),
      botId: uuid(3),
      runId: uuid(4),
      messageId: uuid(5),
      channelId: uuid(6),
      copyMessageId: uuid(7),
      keptCount: 1,
      maskedCount: 2,
      removedCount: 0,
      maskedNumbers: [2, 3],
      removedNumbers: [],
    };
    expect(AnswerAnswerSharedEvent.parse(base)).toEqual(base);
    expect(AnswerAnswerSharedEvent.parse({ ...base, kind: 'page', channelId: null, copyMessageId: null }).kind).toBe('page');
    expect(Object.keys(AnswerAnswerSharedEvent.shape)).not.toContain('teamId');
  });
});
