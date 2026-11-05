import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '@manythreads/shared';
import { continuesRun, RUN_GAP_MS } from '../src/channels/runs';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2026-09-07T10:00:00.000Z');
const at = (ms: number): string => new Date(AT + ms).toISOString();

function msg(over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(1),
    workspaceId: uuid(9),
    channelId: uuid(8),
    authorId: uuid(2),
    author: { actorId: uuid(2), kind: 'person', displayName: 'Nadia' },
    body: 'hi',
    bodyPlain: 'hi',
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: {},
    createdAt: at(0),
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as ChannelMessage;
}

describe('continuesRun (P21-01)', () => {
  it('joins the same author within five minutes, exactly five included, six minutes and one second not', () => {
    expect(continuesRun(msg(), msg({ createdAt: at(60_000) }))).toBe(true);
    expect(continuesRun(msg(), msg({ createdAt: at(RUN_GAP_MS) }))).toBe(true);
    expect(continuesRun(msg(), msg({ createdAt: at(RUN_GAP_MS + 1_000) }))).toBe(false);
  });

  it('never joins the first message or a message that is older than the previous one', () => {
    expect(continuesRun(undefined, msg())).toBe(false);
    expect(continuesRun(null, msg())).toBe(false);
    expect(continuesRun(msg({ createdAt: at(60_000) }), msg({ createdAt: at(0) }))).toBe(false);
  });

  it('a different author or a different kind of author starts a new run', () => {
    expect(continuesRun(msg(), msg({ authorId: uuid(3) as ChannelMessage['authorId'], createdAt: at(1_000) }))).toBe(false);
    const bot = { actorId: uuid(2), kind: 'bot', displayName: 'Nadia' } as ChannelMessage['author'];
    expect(continuesRun(msg(), msg({ author: bot, createdAt: at(1_000) }))).toBe(false);
  });

  it('a day change breaks the run even inside five minutes', () => {
    const late = new Date(2026, 8, 7, 23, 58).toISOString();
    const early = new Date(2026, 8, 8, 0, 1).toISOString();
    expect(continuesRun(msg({ createdAt: late }), msg({ createdAt: early }))).toBe(false);
    expect(continuesRun(msg({ createdAt: new Date(2026, 8, 7, 12, 0).toISOString() }), msg({ createdAt: new Date(2026, 8, 7, 12, 3).toISOString() }))).toBe(true);
  });

  it('replies or reactions under the previous message split the run', () => {
    expect(continuesRun(msg({ replyCount: 1 }), msg({ createdAt: at(1_000) }))).toBe(false);
    expect(continuesRun(msg({ reactions: [{ emoji: '👍', count: 1, mine: false }] }), msg({ createdAt: at(1_000) }))).toBe(false);
    // the current message having them does not matter: it is the last of its run so far
    expect(continuesRun(msg(), msg({ createdAt: at(1_000), replyCount: 2, reactions: [{ emoji: '👍', count: 1, mine: false }] }))).toBe(true);
  });

  it('an Answer, a screen, a poll or a forward stands alone, before or after', () => {
    const cur = msg({ createdAt: at(1_000) });
    expect(continuesRun(msg({ meta: { answer: { text: 'x' } } as never }), cur)).toBe(false);
    expect(continuesRun(msg(), msg({ createdAt: at(1_000), meta: { answer: { text: 'x' } } as never }))).toBe(false);
    expect(continuesRun(msg({ meta: { surfaceRef: { id: 'x' } } as never }), cur)).toBe(false);
    expect(continuesRun(msg(), msg({ createdAt: at(1_000), poll: {} as never }))).toBe(false);
    expect(continuesRun(msg({ forward: {} as never }), cur)).toBe(false);
  });

  it('a deleted message and a system message never join', () => {
    expect(continuesRun(msg({ deletedAt: at(10) }), msg({ createdAt: at(1_000) }))).toBe(false);
    expect(continuesRun(msg(), msg({ createdAt: at(1_000), deletedAt: at(2_000) }))).toBe(false);
    const sys = { actorId: uuid(2), kind: 'system', displayName: 'System' } as ChannelMessage['author'];
    expect(continuesRun(msg({ author: sys }), msg({ author: sys, createdAt: at(1_000) }))).toBe(false);
  });

  it('an edited message may continue (the edited mark stays on its text line)', () => {
    expect(continuesRun(msg({ editedAt: at(5_000) }), msg({ createdAt: at(1_000), editedAt: at(6_000) }))).toBe(true);
  });
});
