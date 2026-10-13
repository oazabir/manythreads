import { AnswerAnswerPostedEvent, eventRegistry, parseEvent } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
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
