import { AnswerInput, ANSWER_LIMITS } from '@manythreads/shared';
import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
import { buildAnswer, citationRef } from '../src/build.ts';
import type { AnswerView } from '../src/view.ts';

// The pure half of `answer.post`: what the bot sent plus the asker's view of it becomes the stored payload. No database here — the SQL view is
// tested in test/rls, the whole path in test/answer.test.ts.

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const RUN: AnswerView['run'] = {
  runId: uuid(1),
  botId: uuid(2),
  botName: 'Brain',
  botSlug: 'brain',
  alias: 'smart',
  teamId: uuid(3),
  workspaceId: uuid(4),
  trigger: 'conversation',
  hasAsker: true,
  askerPersonId: uuid(5),
  askerName: 'Nadia',
  channelId: uuid(6),
  replyRootId: uuid(7),
  private: true,
};

const visible = (over: Record<string, unknown> = {}) => ({ found: true, scope: 'team' as const, audience: true, label: 'A readable message', at: '2026-10-01T12:00:00.000Z', channelId: uuid(20), channelKind: 'channel' as const, channelName: 'dev', threadRootId: null, ...over });

const view = (over: Partial<AnswerView> = {}): AnswerView => ({ run: RUN, citations: [], sources: [], bots: [], ...over });

const input = (over: Record<string, unknown> = {}) => AnswerInput.parse({ body: 'The migration is waiting on the window [1], [2].', ...over });

describe('the citations', () => {
  it('keeps what the asker may open, numbered by the position the bot gave, with the platform’s own label, scope and date', () => {
    const i = input({
      citations: [
        { kind: 'message', messageId: uuid(10), snippet: '  Tester: 213 passing.  ' },
        { kind: 'page', path: 'pages/specs/schedule-migration.md' },
      ],
    });
    const v = view({
      citations: [visible({ label: 'Tester: 213 passing at f07b3d9' }), { found: true, scope: 'team', audience: true, label: 'pages/specs/schedule-migration.md', at: '2026-09-29T08:00:00.000Z', teamId: uuid(3) }],
    });
    const { payload, keptCitations, droppedCitations } = buildAnswer(i, v);
    expect(keptCitations).toBe(2);
    expect(droppedCitations).toBe(0);
    expect(payload.citations.map((c) => (c.kind === 'masked' ? [c.n, c.kind] : [c.n, c.kind, c.label, c.scope]))).toEqual([
      [1, 'message', 'Tester: 213 passing at f07b3d9', 'team'],
      [2, 'page', 'pages/specs/schedule-migration.md', 'team'],
    ]);
    // a message carries where it lives, so a client opens it without asking
    expect(payload.citations[0]).toMatchObject({ messageId: uuid(10), channelId: uuid(20), channelKind: 'channel', channelName: 'dev', threadRootId: null });
    // the lineage says how old each is and quotes the bot's own words, trimmed
    expect(payload.lineage).toEqual([
      { n: 1, kind: 'message', label: 'Tester: 213 passing at f07b3d9', at: '2026-10-01T12:00:00.000Z', snippet: 'Tester: 213 passing.' },
      { n: 2, kind: 'page', label: 'pages/specs/schedule-migration.md', at: '2026-09-29T08:00:00.000Z', snippet: null },
    ]);
  });

  it('drops a citation the asker cannot read, and nothing of it is in the payload: not its label, its snippet or its id', () => {
    const secret = 'Layoffs are planned for March';
    const i = input({
      citations: [
        { kind: 'message', messageId: uuid(10), snippet: 'a public quote' },
        { kind: 'message', messageId: uuid(11), snippet: secret },
        { kind: 'thread', threadRootId: uuid(12), snippet: secret },
      ],
    });
    // the SQL view answers `{ found: false }` for a hidden source and a missing one alike, with no label to leak; even a view that did carry one
    // (it cannot) must not reach the payload, which is why the builder reads nothing from a source that was not found
    const v = view({ citations: [visible(), { found: false, label: secret } as never, { found: false, label: secret } as never] });
    const { payload, droppedCitations } = buildAnswer(i, v);
    expect(droppedCitations).toBe(2);
    expect(payload.citations.map((c) => c.n)).toEqual([1]);
    const json = JSON.stringify(payload);
    expect(json).not.toContain('Layoffs');
    expect(json).not.toContain(uuid(11));
    expect(json).not.toContain(uuid(12));
    // what is left is a kind, a reason and a count
    expect(payload.outsideScope).toEqual({
      count: 2,
      items: [
        { kind: 'message', reason: 'not_visible', count: 1 },
        { kind: 'thread', reason: 'not_visible', count: 1 },
      ],
    });
  });

  it('keeps the numbers of what is left: dropping the first leaves a gap, never a renumbering', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10) }, { kind: 'message', messageId: uuid(11) }, { kind: 'file', fileId: uuid(12) }] });
    const v = view({ citations: [{ found: false }, visible({ label: 'Second' }), { found: true, scope: 'channel', audience: true, label: 'plan.pdf', at: null }] });
    const { payload } = buildAnswer(i, v);
    expect(payload.citations.map((c) => c.n)).toEqual([2, 3]);
    expect(payload.lineage.map((l) => l.n)).toEqual([2, 3]);
  });

  it('drops a source the asker can read but the reply’s readers cannot, for its own reason', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10) }, { kind: 'file', fileId: uuid(11) }] });
    const v = view({ citations: [visible({ scope: 'channel', audience: false, label: 'A DM about the migration' }), visible({ label: 'plan.pdf' })] });
    const { payload, droppedCitations } = buildAnswer(i, v);
    expect(droppedCitations).toBe(1);
    expect(payload.outsideScope.items).toEqual([{ kind: 'message', reason: 'not_shared', count: 1 }]);
    expect(JSON.stringify(payload)).not.toContain('A DM about');
  });

  it('treats a source the view did not describe as unreadable rather than guessing', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10) }, { kind: 'run', runId: uuid(11) }, { kind: 'page', path: 'a.md' }] });
    // found, but without the channel / bot / team the citation needs to be opened: dropped
    const v = view({ citations: [{ found: true, scope: 'team', audience: true, label: 'x' }, { found: true, scope: 'team', audience: true, label: 'x' }, { found: true, scope: 'team', audience: true, label: 'x' }] });
    expect(buildAnswer(i, v).payload.citations).toEqual([]);
    // a view shorter than the citations (it cannot be) reads the rest as not found
    expect(buildAnswer(i, view()).droppedCitations).toBe(3);
  });

  it('labels a source with a plain word when the platform could not read a name', () => {
    const i = input({ citations: [{ kind: 'file', fileId: uuid(10) }] });
    const { payload } = buildAnswer(i, view({ citations: [{ found: true, scope: 'team', audience: true, label: '   ' }] }));
    const first = payload.citations[0];
    expect(first !== undefined && first.kind !== 'masked' ? first.label : null).toBe('A file');
  });
});

describe('a source the run never reached', () => {
  it('is not discussed: dropped as not reached, whatever else the view says, with nothing of it in the payload', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10), snippet: 'guessing' }, { kind: 'page', path: 'pages/guess.md' }, { kind: 'message', messageId: uuid(11) }] });
    const v = view({
      citations: [
        { found: false, reached: false },
        // even a view that claimed more (it cannot: nothing was looked up) is not believed for a source that was not reached
        { found: true, reached: false, scope: 'team', audience: true, label: 'pages/guess.md', teamId: uuid(3) },
        visible({ reached: true, label: 'Read in this run' }),
      ],
    });
    const { payload, droppedCitations, keptCitations } = buildAnswer(i, v);
    expect(droppedCitations).toBe(2);
    expect(keptCitations).toBe(1);
    expect(payload.citations.map((c) => c.n)).toEqual([3]);
    expect(payload.outsideScope.items).toEqual([
      { kind: 'message', reason: 'not_reached', count: 1 },
      { kind: 'page', reason: 'not_reached', count: 1 },
    ]);
    const json = JSON.stringify(payload);
    expect(json).not.toContain('guessing');
    expect(json).not.toContain('pages/guess.md');
    expect(json).not.toContain(uuid(10));
  });

  it('is told apart from one that was read and cannot be opened', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10) }, { kind: 'message', messageId: uuid(11) }] });
    const v = view({ citations: [{ found: false, reached: false }, { found: false, reached: true }] });
    expect(buildAnswer(i, v).payload.outsideScope.items).toEqual([
      { kind: 'message', reason: 'not_reached', count: 1 },
      { kind: 'message', reason: 'not_visible', count: 1 },
    ]);
  });
});

describe('where a kept citation lives', () => {
  it('carries the team of a message and of a thread (null for a direct message), as the platform read it', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10) }, { kind: 'thread', threadRootId: uuid(11) }, { kind: 'message', messageId: uuid(12) }] });
    const v = view({
      citations: [
        visible({ teamId: uuid(3) }),
        visible({ teamId: uuid(9), channelName: 'launch' }),
        visible({ scope: 'channel', channelKind: 'dm', channelName: null, teamId: null }),
      ],
    });
    const { payload } = buildAnswer(i, v);
    expect(payload.citations.map((c) => (c.kind === 'message' || c.kind === 'thread' ? c.teamId : 'n/a'))).toEqual([uuid(3), uuid(9), null]);
  });
});

describe('what the run reached and what was out of scope', () => {
  it('lists what the asker and the readers may see, marks the asker’s own connection, and counts the rest by kind and reason', () => {
    const v = view({
      sources: [
        { found: true, scope: 'team', audience: true, label: 'Release thread', kind: 'message', ref: uuid(10), logScope: 'channel' },
        { found: true, scope: 'team', audience: true, kind: 'memory', ref: 'bank:team:engineering', logScope: 'team' },
        { found: true, scope: 'person', audience: true, kind: 'drive', ref: 'doc-1', logScope: 'person' },
        { found: false, kind: 'message', ref: uuid(11), logScope: 'channel' },
        { found: true, scope: 'channel', audience: false, kind: 'file', ref: uuid(12), logScope: 'channel' },
      ],
    });
    const { payload } = buildAnswer(input(), v);
    expect(payload.sourcesReached).toEqual([
      { kind: 'message', ref: uuid(10), label: 'Release thread', marker: 'full' },
      { kind: 'memory', ref: 'bank:team:engineering', label: 'Team memory', marker: 'full' },
      { kind: 'drive', ref: 'doc-1', label: null, marker: 'scoped' },
    ]);
    expect(payload.outsideScope).toEqual({
      count: 2,
      items: [
        { kind: 'message', reason: 'not_visible', count: 1 },
        { kind: 'file', reason: 'not_shared', count: 1 },
      ],
    });
    expect(JSON.stringify(payload.outsideScope)).not.toContain(uuid(11));
  });

  it('counts a source that was both read and cited once, and adds what the bot says it could not reach as not granted', () => {
    const i = input({ citations: [{ kind: 'message', messageId: uuid(10) }], outsideScope: [{ kind: 'drive', count: 3 }] });
    const v = view({ citations: [{ found: false }], sources: [{ found: false, kind: 'message', ref: uuid(10), logScope: 'channel' }] });
    const { payload } = buildAnswer(i, v);
    expect(payload.outsideScope).toEqual({
      count: 4,
      items: [
        { kind: 'message', reason: 'not_visible', count: 1 },
        { kind: 'drive', reason: 'not_granted', count: 3 },
      ],
    });
  });
});

describe('who it was for, and the suggestions', () => {
  it('stamps answeredFor from the run: the asker, scoped, and the alias — a run nobody asked is the team’s', () => {
    expect(buildAnswer(input(), view()).payload.answeredFor).toEqual({
      personId: uuid(5),
      name: 'Nadia',
      scope: 'scoped',
      alias: 'smart',
      botId: uuid(2),
      runId: uuid(1),
    });
    const nobody = buildAnswer(input(), view({ run: { ...RUN, hasAsker: false, askerPersonId: null, askerName: null, trigger: 'routine', private: false } })).payload.answeredFor;
    expect(nobody).toMatchObject({ personId: null, name: null, scope: 'team' });
  });

  it('turns a hand-off into a bot the platform found, drops one it could not, and a follow-up keeps its words', () => {
    const i = input({
      chips: [
        { kind: 'followup', prompt: 'Why is it waiting for the window?', label: 'Why waiting?' },
        { kind: 'followup', prompt: 'Why is it waiting for the window?' },
        { kind: 'handoff', botSlug: 'coder' },
        { kind: 'handoff', botSlug: 'coder' },
        { kind: 'handoff', botSlug: 'nobody-here' },
      ],
    });
    const v = view({ bots: [{ id: uuid(30), slug: 'coder', name: 'Coder' }] });
    expect(buildAnswer(i, v).payload.chips).toEqual([
      { kind: 'followup', label: 'Why waiting?', prompt: 'Why is it waiting for the window?' },
      { kind: 'handoff', botId: uuid(30), botSlug: 'coder', botName: 'Coder' },
    ]);
  });
});

describe('the reference of a citation', () => {
  it('is the id it names, and for a page the path with its team', () => {
    expect(citationRef({ kind: 'message', messageId: uuid(1) } as never)).toEqual({ kind: 'message', ref: uuid(1), team: null });
    expect(citationRef({ kind: 'page', path: 'pages/a.md', teamId: uuid(3) } as never)).toEqual({ kind: 'page', ref: 'pages/a.md', team: uuid(3) });
  });
});

describe('hostile input', () => {
  it('builds in linear time for the largest answer the schema allows, and for hostile text', () => {
    // 40 citations with the longest snippet, 100 sources, a body of the cap made of brackets: nothing here is quadratic
    const make = (n: number) => {
      const count = Math.min(ANSWER_LIMITS.citations, Math.max(1, n));
      const i = AnswerInput.parse({
        body: '['.repeat(Math.min(ANSWER_LIMITS.body, n * 200)),
        citations: Array.from({ length: count }, (_, k) => ({ kind: 'message', messageId: uuid(100 + k), snippet: '[1]'.repeat(100) })),
      });
      const v = view({
        citations: Array.from({ length: count }, (_, k) => visible({ label: `Message ${k} `.repeat(30) })),
        sources: Array.from({ length: 200 }, (_, k) => ({ found: k % 2 === 0, scope: 'team' as const, audience: true, kind: 'message', ref: uuid(1000 + k), logScope: 'channel' as const })),
      });
      return { i, v };
    };
    expectLinear(make, ({ i, v }) => buildAnswer(i, v), { n: 20, factor: 2, ceilingMs: 1000, label: 'building an answer' });
  });

  it('never lets the payload exceed what the schema allows, whatever was sent', () => {
    const i = AnswerInput.parse({
      body: 'x'.repeat(ANSWER_LIMITS.body),
      citations: Array.from({ length: ANSWER_LIMITS.citations }, (_, k) => ({ kind: 'message', messageId: uuid(100 + k), snippet: 's'.repeat(ANSWER_LIMITS.snippet) })),
      outsideScope: Array.from({ length: ANSWER_LIMITS.outside }, (_, k) => ({ kind: `kind_${k}`, count: 1000 })),
      chips: Array.from({ length: ANSWER_LIMITS.chips }, (_, k) => ({ kind: 'followup', prompt: `q${k} `.repeat(100).slice(0, ANSWER_LIMITS.prompt) })),
    });
    const v = view({
      citations: Array.from({ length: ANSWER_LIMITS.citations }, () => visible({ label: 'l'.repeat(1000) })),
      sources: Array.from({ length: 2000 }, (_, k) => ({ found: true, scope: 'team' as const, audience: true, kind: 'message', ref: uuid(5000 + k), logScope: 'channel' as const })),
    });
    const { payload } = buildAnswer(i, v);
    expect(payload.citations).toHaveLength(ANSWER_LIMITS.citations);
    expect(payload.sourcesReached.length).toBeLessThanOrEqual(ANSWER_LIMITS.sources);
    expect(payload.citations.every((c) => c.kind === 'masked' || c.label.length <= ANSWER_LIMITS.label)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(96_000);
  });
});
