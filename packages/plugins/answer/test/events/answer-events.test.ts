import { AnswerAnswerPostedEvent, AnswerAnswerSharedEvent, eventRegistry, parseEvent } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import conversations from '../../../conversations/src/index.ts';
import pages from '../../../pages/src/index.ts';
import plugin from '../../src/index.ts';

// Event contract of the answer plugin (pnpm test:events). The stored row of a real answer is asserted end to end in test/answer.test.ts; this
// pins what is declared: one event type, registered once, ids and counts, no team (an answer to a private conversation is its asker's).

const uuid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const sample = {
  type: 'answer.answer.posted',
  schemaVersion: 1,
  workspaceId: uuid(1),
  botId: uuid(2),
  runId: uuid(3),
  askerPersonId: null,
  channelId: uuid(5),
  messageId: uuid(6),
  threadRootId: null,
  citationCount: 0,
  droppedCount: 0,
  reachedCount: 0,
};

describe('answer.answer.posted', () => {
  it('is the only event the plugin emits, registered at version 1, and the manifest says so', () => {
    expect([...plugin.manifest.events.emits]).toEqual(['answer.answer.posted']);
    expect(plugin.manifest.events.consumes).toEqual([]);
    expect(Object.keys(eventRegistry['answer.answer.posted'])).toEqual(['1']);
  });

  it('carries ids and counts only: no team, no text, nothing a title or a snippet could ride on', () => {
    const keys = Object.keys(AnswerAnswerPostedEvent.shape).sort();
    expect(keys).toEqual(
      ['askerPersonId', 'botId', 'channelId', 'citationCount', 'droppedCount', 'messageId', 'reachedCount', 'runId', 'schemaVersion', 'threadRootId', 'type', 'workspaceId'].sort(),
    );
    expect(keys).not.toContain('teamId');
  });

  it('parses through the registry like every event, and refuses a payload with a negative count or a missing run', () => {
    expect(parseEvent(sample).type).toBe('answer.answer.posted');
    expect(() => parseEvent({ ...sample, droppedCount: -1 })).toThrow();
    expect(() => parseEvent({ ...sample, runId: undefined })).toThrow();
  });
});

// The access event of a share (PLAN P5-17): emitted by the plugins that do the sharing (a channel copy and a hand-off by `conversations`, a page
// by `pages`), named for the answer. Ids, counts and the numbers of citations; never an id, a label or a team of a source.
describe('answer.answer.shared', () => {
  const shared = {
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

  it('is registered at version 1 and emitted by the two plugins that share, not by this one', () => {
    expect(Object.keys(eventRegistry['answer.answer.shared'])).toEqual(['1']);
    expect([...conversations.manifest.events.emits]).toContain('answer.answer.shared');
    expect([...pages.manifest.events.emits]).toContain('answer.answer.shared');
    expect([...plugin.manifest.events.emits]).not.toContain('answer.answer.shared');
  });

  it('carries ids, counts and citation numbers only: no team, no text, nothing a title or a snippet could ride on', () => {
    const keys = Object.keys(AnswerAnswerSharedEvent.shape).sort();
    expect(keys).toEqual(
      [
        'botId', 'channelId', 'copyMessageId', 'keptCount', 'kind', 'maskedCount', 'maskedNumbers', 'messageId', 'personId', 'removedCount',
        'removedNumbers', 'runId', 'schemaVersion', 'type', 'workspaceId',
      ].sort(),
    );
    for (const forbidden of ['teamId', 'label', 'snippet', 'path', 'title', 'body', 'citations']) expect(keys).not.toContain(forbidden);
  });

  it('parses through the registry for each kind, and refuses a negative count, a citation number out of range and a made-up kind', () => {
    expect(parseEvent(shared).type).toBe('answer.answer.shared');
    expect(parseEvent({ ...shared, kind: 'page', channelId: null, copyMessageId: null }).type).toBe('answer.answer.shared');
    expect(parseEvent({ ...shared, kind: 'handoff' }).type).toBe('answer.answer.shared');
    expect(() => parseEvent({ ...shared, maskedCount: -1 })).toThrow();
    expect(() => parseEvent({ ...shared, maskedNumbers: [0] })).toThrow();
    expect(() => parseEvent({ ...shared, maskedNumbers: [41] })).toThrow();
    expect(() => parseEvent({ ...shared, kind: 'email' })).toThrow();
  });
});
