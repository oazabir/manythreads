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
  mdLine,
  pageSlug,
  pageTitle,
  removeClaims,
  type CitationVerdict,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

// Masking an answer for the readers of a copy (PLAN P5-17, SPEC §6.3): the pure rules. The database decides which citations a place's readers
// may open (answer migration 0003, tested in test/rls); this is what is built from its verdicts — and the proof that a copy is only ever less.

/** A small deterministic generator (a 32-bit LCG with `Math.imul`, so the multiplication never leaves 32 bits). */
const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s >>> 8;
  };
};

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
    // the bot quoted the source as it was: a source that reads otherwise now keeps no quote
    expect(copy.lineage[0]).toMatchObject({ n: 1, label: 'The window moved to Tuesday', at: '2026-10-05T08:00:00.000Z', snippet: null });
  });

  it('keeps the quote while the source still reads as it did, and reads the label of "Sources reached" again too', () => {
    const same = maskAnswer(original(), KEEP_ONE, [], []).copy!;
    expect(same.lineage[0]).toMatchObject({ n: 1, snippet: 'waits for the Monday window' });
    const reread = maskAnswer(original(), KEEP_ONE, [{ kept: true, label: 'The window moved to Tuesday' }, { kept: false }, { kept: false }], []).copy!;
    expect(reread.sourcesReached.map((s) => s.label)).toEqual(['The window moved to Tuesday']);
    // a kept entry whose verdict carries no label keeps the stored one
    expect(maskAnswer(original(), KEEP_ONE, [{ kept: true }, { kept: false }, { kept: false }], []).copy!.sourcesReached[0]!.label).toBe('The deploy waits for the Monday change window');
  });

  it('says what goes with a removed claim, as the words that are taken out', () => {
    const m = maskAnswer(original(), KEEP_ONE, [], [2]);
    expect(m.removedText).toEqual(['Leadership also has plans [2] that I cannot repeat.']);
    expect(maskAnswer(original(), KEEP_ONE, [], []).removedText).toEqual([]);
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
      body: `${'Claim [1]. '.repeat(1_500)}\n\n${'x'.repeat(1_000)}`,
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

  it('a marker group written after the stop and a space takes the sentence before it AND the one after it (it may be a prefix): one neighbour is the price', () => {
    expect(removeClaims('Revenue grew 4%. [2] Costs fell. Keep this.', new Set([2])).body).toBe('Keep this.');
    expect(removeClaims('Revenue grew 4%. [1], [2] Costs fell. Keep this.', new Set([2])).body).toBe('Keep this.');
    expect(removeClaims('Revenue grew 4%. [1][2]\nCosts fell. Keep this.', new Set([1])).body).toBe('Keep this.');
    // at the end of the text there is no neighbour to take
    expect(removeClaims('Keep this. Revenue grew 4%. [2]', new Set([2])).body).toBe('Keep this.');
    // before the stop, or with no space, the group is the sentence's own and nothing else goes
    expect(removeClaims('Keep this. Revenue grew [1], [2]. Next claim.', new Set([2])).body).toBe('Keep this. Next claim.');
    expect(removeClaims('Keep this. Revenue grew.[2] Next claim.', new Set([2])).body).toBe('Keep this. Next claim.');
    // a marker group that is not removed leaves its sentence alone
    expect(removeClaims('Revenue grew 4%. [1] Next claim [2].', new Set([2])).body).toBe('Revenue grew 4%. [1]');
  });

  it('a sentence wrapped over several lines goes whole, a list item with its wrapped lines too, and a quote', () => {
    expect(removeClaims('The deal closes for $4M, according to\nthe board [2]. The rest stays.', new Set([2])).body).toBe('The rest stays.');
    expect(removeClaims('Intro.\n\n- Revenue closes for $4M\n  according to the board [2].\n- Other point [1].', new Set([2])).body).toBe('Intro.\n\n- Other point [1].');
    expect(removeClaims('> The board said so\n> in writing [2].\n\nAfter.', new Set([2])).body).toBe('After.');
    // a marker at the start of a block opens its own sentence; one after a stop and a line break is the previous sentence's and the next one's
    expect(removeClaims('[2] The first claim here.\nThe second claim.', new Set([2])).body).toBe('The second claim.');
    expect(removeClaims('Fine so far.\n[2] A hard-wrapped claim.\nStays put.', new Set([2])).body).toBe('Stays put.');
  });

  it('fails toward removing more: no break at a lower-case word, a digit or an abbreviation, so a claim is never cut short', () => {
    expect(removeClaims('It closes for $4M. according to the board [2]. After.', new Set([2])).body).toBe('After.');
    expect(removeClaims('Revenue is 4. 2025 was better [2]. After.', new Set([2])).body).toBe('After.');
    expect(removeClaims('See e.g. the board report [2]. After.', new Set([2])).body).toBe('After.');
    expect(removeClaims('Ask Dr. Reyes about it [2]. After.', new Set([2])).body).toBe('After.');
    expect(removeClaims('Ships from the U.S. by Friday [2]. After.', new Set([2])).body).toBe('After.');
  });

  it('markdown links and footnotes next to a marker are part of its sentence', () => {
    expect(removeClaims('Read [the board note](https://example.com/a.html) for details [2](https://example.com/b). After.', new Set([2])).body).toBe('After.');
    expect(removeClaims('A claim[^1] with a note [2]. After.', new Set([2])).body).toBe('After.');
    expect(removeClaims('A claim with a note[^1]. Keep [1].', new Set([2])).body).toBe('A claim with a note[^1]. Keep [1].');
  });

  it('a table row that carries a removed marker goes whole', () => {
    expect(removeClaims('| a | b |\n| - | - |\n| revenue [2] | 4% |\n| cost | 3% |', new Set([2])).body).toBe('| a | b |\n| - | - |\n| cost | 3% |');
  });

  it('reports the words it took out, per sentence', () => {
    const r = removeClaims('Keep this. Revenue grew 4%. [2] Costs fell [1]. And this stays.', new Set([2]));
    expect(r.removed).toEqual(['Revenue grew 4%. [2]', 'Costs fell [1].']);
    expect(r.sentences).toBe(2);
    expect(r.body).toBe('Keep this. And this stays.');
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

  it('fenced code that holds a removed marker goes whole; code that does not is left exactly as it was', () => {
    expect(removeClaims('Figures:\n```\nRevenue 4.2M [2]\n```\nAfter.', new Set([2])).body).toBe('Figures:\nAfter.');
    expect(removeClaims('Run it [1].\n\n```\nlist[3] = 1;\n\n\n  indented();\n```\n\nDone [2].', new Set([2])).body).toBe('Run it [1].\n\n```\nlist[3] = 1;\n\n\n  indented();\n```');
    expect(removeClaims('~~~\nx [2]\n~~~\nKeep [1].', new Set([2])).body).toBe('Keep [1].');
  });

  it('a fence with no closing line is prose: it shields nothing after it', () => {
    expect(removeClaims('```js\nCode.\n\nA claim [2]. Another claim [1].', new Set([2])).body).toBe('```js\nCode.\n\nAnother claim [1].');
    // (the stray fence line is part of the sentence it starts: it goes with the claim, which is the side to err on)
    expect(removeClaims('```\nA claim [2].\nKeep [1].', new Set([2])).body).toBe('Keep [1].');
    // an odd number of fences: the last one is the stray
    expect(removeClaims('```\ncode\n```\n\nA claim [2].\n\n```\nKeep [1].', new Set([2])).body).toBe('```\ncode\n```\n\n```\nKeep [1].');
  });

  it('an inline code span is one piece, and a removed marker in it takes its sentence', () => {
    expect(removeClaims('Set `x. y [2]` first. Keep [1].', new Set([2])).body).toBe('Keep [1].');
    expect(removeClaims('Call `a. b` then go [2]. Keep [1].', new Set([2])).body).toBe('Keep [1].');
  });

  it('white space of every kind is white space: NBSP, thin and zero-width spaces', () => {
    expect(removeClaims('Revenue grew.\u00a0[2] Costs fell. Keep.', new Set([2])).body).toBe('Keep.');
    expect(removeClaims('Revenue grew.\u2009[2]\u202fCosts fell. Keep.', new Set([2])).body).toBe('Keep.');
    expect(removeClaims('Revenue grew.\u200b[2] Costs fell. Keep.', new Set([2])).body).toBe('Keep.');
    expect(removeClaims('A claim [2].\u00a0Keep this.', new Set([2])).body).toBe('Keep this.');
  });

  it('every marker form carries its numbers: lists, ranges, spaces, full-width and lenticular brackets', () => {
    for (const marker of ['[1, 2]', '[2, 3]', '[1-3]', '[ 2 ]', '［2］', '【2】', '[1;2]', '[2–4]']) {
      expect(removeClaims(`A claim ${marker}. Keep [5].`, new Set([2])).body, marker).toBe('Keep [5].');
    }
    // a group of numbers none of which is removed is left alone, and so is a range that stops short
    expect(removeClaims('A claim [1, 3]. Keep [5].', new Set([2])).body).toBe('A claim [1, 3]. Keep [5].');
    expect(removeClaims('A claim [3-5]. Keep [5].', new Set([2])).body).toBe('A claim [3-5]. Keep [5].');
    // four digits are a year, not a citation
    expect(removeClaims('In [2024] it grew. Keep [5].', new Set([2])).body).toBe('In [2024] it grew. Keep [5].');
  });

  it('scripts written without spaces end a sentence at the stop; Urdu and Hindi stops end one too', () => {
    expect(removeClaims('收入增长了四个百分点[2]。成本下降了。保持不变[1]。', new Set([2])).body).toBe('成本下降了。保持不变[1]。');
    expect(removeClaims('यह एक दावा है [2]। यह रहेगा [1]।', new Set([2])).body).toBe('यह रहेगा [1]।');
    expect(removeClaims('یہ ایک دعویٰ ہے [2]۔ یہ رہے گا [1]۔', new Set([2])).body).toBe('یہ رہے گا [1]۔');
  });

  it('is a deletion only: for any input the result is a subsequence of it', () => {
    const alphabet = ['a', 'b', ' ', '.', '!', '?', '[', ']', '1', '2', '3', '\n', '-', '*', '>', '`', '#', '. ', '[1]', '[2]', '。'];
    const next = lcg(7);
    for (let round = 0; round < 400; round += 1) {
      let text = '';
      const len = 1 + (next() % 60);
      for (let i = 0; i < len; i += 1) text += alphabet[next() % alphabet.length]!;
      const out = removeClaims(text, new Set([1, 2]));
      expect(isSubsequence(out.body, text), JSON.stringify({ text, out: out.body })).toBe(true);
      expect(out.body.length).toBeLessThanOrEqual(text.length);
    }
  });

  // The claim side of the guarantee. Each unit of the generated answer is a sentence with a UNIQUE token; a unit "carries" the removed citation
  // (number 2) or does not. The assertions: the token of every carrying unit is ABSENT; the token of every unit that neither carries nor sits next
  // to one that does is PRESENT (a neighbour may go: a marker group after a stop may be a prefix); the text is a subsequence of the original.
  // (A property test that only checks "[2] is gone" passes for a removal that deleted the innocent neighbour and kept the claim.)
  type Unit = { text: string; carries: boolean; sep: string };
  const unitFor = (i: number, pick: number): { text: string; carries: boolean; atLineStart?: boolean } => {
    const t = `Tok${String(i)}`;
    const kinds: Array<{ text: string; carries: boolean; atLineStart?: boolean }> = [
      { text: `${t} says something plain.`, carries: false },
      { text: `${t} says something [1].`, carries: false },
      { text: `${t} says something [2].`, carries: true },
      { text: `${t} says something [1, 2].`, carries: true },
      { text: `${t} says something [1-3].`, carries: true },
      { text: `${t} says something [ 2 ].`, carries: true },
      { text: `${t} says something ［2］.`, carries: true },
      { text: `${t} says something 【2】.`, carries: true },
      { text: `${t} says something. [2]`, carries: true },
      { text: `${t} says something.[2]`, carries: true },
      { text: `${t} says something. [1], [2]`, carries: true },
      { text: `[2] ${t} says something.`, carries: true },
      { text: `${t} wraps over\ntwo lines [2].`, carries: true },
      { text: `${t} wraps over\ntwo lines [1].`, carries: false },
      { text: `- ${t} item [2].`, carries: true, atLineStart: true },
      { text: `- ${t} item [3].`, carries: false, atLineStart: true },
      { text: `\`\`\`\n${t} code [2]\n\`\`\``, carries: true, atLineStart: true },
      { text: `\`\`\`\n${t} code [1]\n\`\`\``, carries: false, atLineStart: true },
      { text: `${t} says \`a. b [2]\` inline.`, carries: true },
      { text: `${t} 事実です[2]。`, carries: true },
      { text: `${t} 事実です[1]。`, carries: false },
      { text: `${t} यह तथ्य है [2]।`, carries: true },
    ];
    return kinds[pick % kinds.length]!;
  };

  it('removes the token of every claim that carries a removed marker and keeps the other tokens (barring the neighbour), in every layout', () => {
    const seps = [' ', '\n', ' ', ' ', ' ', ' ', '\n\n'];
    const next = lcg(20_261_013);
    for (let round = 0; round < 500; round += 1) {
      const count = 2 + (next() % 7);
      const units: Unit[] = [];
      for (let i = 0; i < count; i += 1) {
        const u = unitFor(round * 10 + i, next());
        let sep = seps[next() % seps.length]!;
        // a list item and a fenced block start a line (and a fence ends one)
        if (u.atLineStart) sep = '\n\n';
        const before = units[units.length - 1];
        if (before !== undefined && /```$|^- /.test(before.text) && sep !== '\n\n') sep = '\n\n';
        units.push({ text: u.text, carries: u.carries, sep });
      }
      const text = units.map((u, i) => (i === 0 ? '' : u.sep) + u.text).join('');
      const out = removeClaims(text, new Set([2])).body;
      const tokenOf = (i: number): string => /Tok\d+/.exec(units[i]!.text)![0];
      units.forEach((u, i) => {
        const near = (units[i - 1]?.carries ?? false) || (units[i + 1]?.carries ?? false);
        const present = new RegExp(`${tokenOf(i)}(?!\\d)`).test(out);
        const ctx = JSON.stringify({ text, out, token: tokenOf(i) });
        if (u.carries) expect(present, `the claim must be gone: ${ctx}`).toBe(false);
        else if (!near) expect(present, `an unrelated sentence was lost: ${ctx}`).toBe(true);
      });
      expect(isSubsequence(out, text), JSON.stringify({ text, out })).toBe(true);
    }
  });

  it('never leaves a removed marker behind outside kept code, whatever the layout', () => {
    const alphabet = ['a', 'B', ' ', '.', '!', '?', '[', ']', '1', '2', '3', '\n', '\n\n', '- ', '> ', '# ', '| ', ', ', '. ', '[1]', '[2]', '[1], [2]', '。', 'e.g. ', '4%. ', '(', ')', '*', ' ', ' ', '［2］', '【2】', '[1-3]', '`', '```\n'];
    const next = lcg(11);
    for (let round = 0; round < 800; round += 1) {
      let text = '';
      const len = 1 + (next() % 80);
      for (let i = 0; i < len; i += 1) text += alphabet[next() % alphabet.length]!;
      const out = removeClaims(text, new Set([2])).body;
      // what is left holds no [2], in any marker form, except inside a fenced block that was kept (which holds none either: it would have gone)
      expect(/\[\s*2\s*\]|［2］|【2】|\[1-3\]/.test(out), JSON.stringify({ text, out })).toBe(false);
      expect(isSubsequence(out, text), JSON.stringify({ text, out })).toBe(true);
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
    ['stops, spaces and marker groups', (n) => '. [1], [2] '.repeat(n / 11)],
    ['stops then commas', (n) => '.,'.repeat(n / 2)],
    ['wrapped lines', (n) => 'a long line of words\n'.repeat(n / 21) + '[2].'],
    ['line breaks after stops', (n) => '.\n'.repeat(n / 2)],
    ['a long run of spaces after a stop', (n) => `a.${' '.repeat(n)}[1]`],
    ['list items with wrapped lines', (n) => '- item\n  wrapped [1]\n'.repeat(n / 22)],
  ];
  for (const [name, build] of cases) {
    it(name, () => {
      // a removed marker at the end, so that the whole text is read and not turned away at the door
      expectLinear(build, (input) => removeClaims(`${input} [2]`, new Set([1, 2])), { n: 20_000, label: name, ceilingMs: 1500 });
    });
  }
});

describe('the page', () => {
  it('names a page by day, a slug of its first line and the tail of the answer’s id; only a-z, 0-9 and dashes reach the path', () => {
    const title = pageTitle('## **The deploy** waits for the `Monday` window [1].\n\nMore.');
    expect(title).toBe('The deploy waits for the Monday window');
    const path = answerPagePath(title, '0190a000-0000-7000-8000-0000deadbeef');
    expect(path).toBe('pages/answers/the-deploy-waits-for-the-monday-window-deadbeef.md');
    expect(answerPagePath('../../../etc/passwd', uuid(1))).toMatch(/^pages\/answers\/etc-passwd-[0-9a-f]{8}\.md$/);
    // no day in it: the same answer saved on another day is the same file
  });

  it('falls back to "answer" when no letter or digit is left (an Arabic title, symbols) and refuses a bad date', () => {
    expect(pageSlug('مرحبا بالعالم')).toBe('answer');
    expect(pageSlug('!!! ???')).toBe('answer');
    expect(answerPagePath('x', uuid(1))).toMatch(/^pages\/answers\/x-[0-9a-f]{8}\.md$/);
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

describe('a label on the team’s page', () => {
  it('is one line with markdown structure escaped: a multi-line label cannot open a heading, a table or a link', () => {
    expect(mdLine('first line\n# A heading\n| a | b |\n[x](https://evil.example)')).toBe('first line \\# A heading \\| a \\| b \\| \\[x\\](https://evil.example)');
    const copy = AnswerPayload.parse({
      ...original(),
      citations: [{ kind: 'file', n: 1, label: 'plan.pdf\n\n# Injected heading\n<script>x</script>', scope: 'team', fileId: uuid(40) }],
      lineage: [{ n: 1, kind: 'file', label: 'plan.pdf', at: null, snippet: 'a quote\n- with a bullet' }],
      body: 'One claim [1].',
      sourcesReached: [],
    });
    const md = answerPageMarkdown(copy, '2026-10-13');
    expect(md).not.toMatch(/^# Injected/m);
    expect(md).not.toContain('<script>');
    expect(md).toContain('1. plan.pdf \\# Injected heading \\<script\\>x\\</script\\> (file)');
    expect(md).not.toMatch(/^- with a bullet/m);
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
