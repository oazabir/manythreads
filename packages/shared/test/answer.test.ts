import { describe, expect, it } from 'vitest';
import {
  ANSWER_CITATION_KINDS,
  ANSWER_LIMITS,
  AnswerCitation,
  AnswerCitationInput,
  AnswerInput,
  AnswerPayload,
  AnswerPayloadView,
  AnswerAnswerPostedEvent,
  Message,
  eventRegistry,
  isSupportedCitation,
  parseEvent,
} from '../src/index.ts';
import { messageWire, uuid } from './fixtures.ts';

// The Answer's schemas (PLAN P5-18): what a bot sends is strict and carries nothing the platform stamps; what is stored is the platform's reading;
// what a client parses tolerates a citation kind it has never seen.

const base = { n: 1, label: 'What is blocking the release?', scope: 'team' as const };

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  body: 'Review is green [1]; the deploy waits for the window [2].',
  citations: [
    { kind: 'message', ...base, messageId: uuid(10), channelId: uuid(11), teamId: uuid(12), channelKind: 'channel', channelName: 'dev', threadRootId: null },
    { kind: 'page', n: 2, label: 'pages/specs/schedule-migration.md', scope: 'team', teamId: uuid(12), path: 'pages/specs/schedule-migration.md' },
  ],
  lineage: [
    { n: 1, kind: 'message', label: 'What is blocking the release?', at: '2026-10-01T12:00:00.000Z', snippet: '213 passing' },
    { n: 2, kind: 'page', label: 'pages/specs/schedule-migration.md', at: null, snippet: null },
  ],
  sourcesReached: [{ kind: 'message', ref: uuid(10), label: 'What is blocking the release?', marker: 'full' }],
  outsideScope: { count: 1, items: [{ kind: 'message', reason: 'not_visible', count: 1 }] },
  answeredFor: { personId: uuid(20), name: 'Nadia', scope: 'scoped', alias: 'smart', botId: uuid(21), runId: uuid(22) },
  chips: [
    { kind: 'followup', label: 'Why is it waiting?', prompt: 'Why is the deploy waiting for the window?' },
    { kind: 'handoff', botId: uuid(23), botSlug: 'coder', botName: 'Coder' },
  ],
  ...over,
});

describe('AnswerInput (what a bot sends)', () => {
  it('takes a body, citations by id, what it could not reach and suggestions; every list defaults to empty', () => {
    expect(AnswerInput.parse({ body: 'Plain text.' })).toEqual({ body: 'Plain text.', citations: [], outsideScope: [], chips: [] });
    const full = AnswerInput.parse({
      body: 'See [1].',
      citations: [
        { kind: 'message', messageId: uuid(1), snippet: 'a quote' },
        { kind: 'thread', threadRootId: uuid(2) },
        { kind: 'page', path: 'pages/a.md' },
        { kind: 'file', fileId: uuid(3) },
        { kind: 'run', runId: uuid(4) },
      ],
      outsideScope: [{ kind: 'drive', count: 2 }],
      chips: [{ kind: 'followup', prompt: 'And then?' }, { kind: 'handoff', botSlug: 'coder' }],
    });
    expect(full.citations.map((c) => c.kind)).toEqual([...ANSWER_CITATION_KINDS]);
  });

  it('is strict: a bot cannot name who the answer is for, a lineage, a scope or a label', () => {
    for (const extra of [{ answeredFor: { name: 'Omar' } }, { lineage: [] }, { sourcesReached: [] }, { version: 1 }, { personId: uuid(9) }]) {
      const r = AnswerInput.safeParse({ body: 'x', ...extra });
      expect(r.success, JSON.stringify(extra)).toBe(false);
      expect(r.error?.issues[0]?.code).toBe('unrecognized_keys');
    }
    expect(AnswerCitationInput.safeParse({ kind: 'message', messageId: uuid(1), scope: 'team' }).success).toBe(false);
    expect(AnswerCitationInput.safeParse({ kind: 'message', messageId: uuid(1), label: 'Mine' }).success).toBe(false);
    expect(AnswerInput.safeParse({ body: 'x', chips: [{ kind: 'handoff', botSlug: 'coder', botId: uuid(1) }] }).success).toBe(false);
  });

  it('refuses a kind it does not know, an empty or oversized body, and a list over its cap', () => {
    expect(AnswerInput.safeParse({ body: 'x', citations: [{ kind: 'memory', conceptPath: 'a' }] }).success).toBe(false);
    expect(AnswerInput.safeParse({ body: '' }).success).toBe(false);
    expect(AnswerInput.safeParse({ body: 'x'.repeat(ANSWER_LIMITS.body + 1) }).success).toBe(false);
    const many = Array.from({ length: ANSWER_LIMITS.citations + 1 }, (_, i) => ({ kind: 'file', fileId: uuid(100 + i) }));
    expect(AnswerInput.safeParse({ body: 'x', citations: many }).success).toBe(false);
    expect(AnswerCitationInput.safeParse({ kind: 'message', messageId: 'not-a-uuid' }).success).toBe(false);
    expect(AnswerCitationInput.safeParse({ kind: 'message', messageId: uuid(1), snippet: 's'.repeat(ANSWER_LIMITS.snippet + 1) }).success).toBe(false);
  });
});

describe('AnswerPayload (what is stored and shown)', () => {
  it('round-trips through JSON', () => {
    const parsed = AnswerPayload.parse(payload());
    expect(AnswerPayload.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed.citations).toHaveLength(2);
  });

  it('names a citation by its own fields: a message has a channel, a page a team and a path', () => {
    expect(AnswerCitation.safeParse({ kind: 'message', ...base, messageId: uuid(1) }).success).toBe(false);
    expect(AnswerCitation.safeParse({ kind: 'page', ...base, path: 'a.md' }).success).toBe(false);
    expect(AnswerCitation.safeParse({ kind: 'run', ...base, runId: uuid(1), botId: uuid(2), botSlug: null }).success).toBe(true);
  });
});

describe('AnswerPayloadView (what a client parses)', () => {
  it('reads a citation of a kind it does not know as unsupported, and keeps the others', () => {
    const view = AnswerPayloadView.parse(
      payload({
        citations: [
          { kind: 'message', ...base, messageId: uuid(10), channelId: uuid(11), teamId: uuid(12), channelKind: 'channel', channelName: 'dev', threadRootId: null },
          { kind: 'memory', n: 2, conceptPath: 'memory/facts/window.md', trustTier: 'human-reviewed', stale: false },
        ],
      }),
    );
    expect(view.citations.map((c) => isSupportedCitation(c))).toEqual([true, false]);
    expect(view.citations[1]).toMatchObject({ kind: 'memory', n: 2, conceptPath: 'memory/facts/window.md' });
    // the strict shape refuses what the view accepts
    expect(AnswerPayload.safeParse(payload({ citations: [{ kind: 'memory', n: 1 }] })).success).toBe(false);
  });

  it('does not take a malformed citation of a known kind for an unsupported one', () => {
    expect(AnswerPayloadView.safeParse(payload({ citations: [{ kind: 'message', n: 1, label: 'x', scope: 'team' }] })).success).toBe(false);
  });
});

describe('a message that carries an Answer', () => {
  it('has it on meta.answer, and a payload that does not read leaves the message', () => {
    const withAnswer = Message.parse({ ...messageWire, meta: { answer: payload() } });
    expect(withAnswer.meta.answer?.answeredFor.name).toBe('Nadia');
    // a newer shape: the message still reads, without the Answer, and the text is still there
    const broken = Message.parse({ ...messageWire, meta: { answer: { version: 2, body: 7 } } });
    expect(broken.body).toBe(messageWire.body);
    expect(broken.meta.answer).toBeUndefined();
    expect(Message.parse(messageWire).meta.answer).toBeUndefined();
  });
});

describe('answer.answer.posted', () => {
  const event = {
    type: 'answer.answer.posted',
    schemaVersion: 1,
    workspaceId: uuid(1),
    botId: uuid(2),
    runId: uuid(3),
    askerPersonId: uuid(4),
    channelId: uuid(5),
    messageId: uuid(6),
    threadRootId: uuid(7),
    citationCount: 2,
    droppedCount: 1,
    reachedCount: 3,
  };

  it('is registered once, carries ids and counts, and has no team', () => {
    expect(Object.keys(eventRegistry['answer.answer.posted'])).toEqual(['1']);
    expect(AnswerAnswerPostedEvent.parse(event)).toEqual(event);
    expect(Object.keys(AnswerAnswerPostedEvent.shape)).not.toContain('teamId');
    expect(parseEvent(event).type).toBe('answer.answer.posted');
  });
});

describe('what a citation says of its team, and why a source is outside the scope', () => {
  it('carries the team of a message or a thread (null for a direct message) so a link can use its own team’s address', () => {
    const parsed = AnswerPayload.parse(payload());
    expect(parsed.citations[0]).toMatchObject({ kind: 'message', teamId: uuid(12) });
    const dm = AnswerPayload.parse(
      payload({
        citations: [
          { kind: 'message', ...base, messageId: uuid(10), channelId: uuid(11), teamId: null, channelKind: 'dm', channelName: null, threadRootId: null },
          { kind: 'thread', n: 2, label: 't', scope: 'channel', threadRootId: uuid(10), channelId: uuid(11), teamId: null, channelKind: 'dm', channelName: null },
        ],
      }),
    );
    expect(dm.citations.map((c) => (c.kind === 'message' || c.kind === 'thread' ? c.teamId : 'x'))).toEqual([null, null]);
  });

  it('reads a payload written before the team was carried as "no team", never as an unreadable message', () => {
    const old = payload({
      citations: [{ kind: 'message', ...base, messageId: uuid(10), channelId: uuid(11), channelKind: 'channel', channelName: 'dev', threadRootId: null }],
      lineage: [],
    });
    expect(AnswerPayloadView.parse(old).citations[0]).toMatchObject({ kind: 'message', teamId: null });
  });

  it('names a source the bot never reached as its own reason', () => {
    const p = AnswerPayload.parse(payload({ outsideScope: { count: 1, items: [{ kind: 'message', reason: 'not_reached', count: 1 }] } }));
    expect(p.outsideScope.items[0]?.reason).toBe('not_reached');
    expect(AnswerPayload.safeParse(payload({ outsideScope: { count: 1, items: [{ kind: 'message', reason: 'nope', count: 1 }] } })).success).toBe(false);
  });
});
