import type { BotRunHandle, PluginContext } from '@manythreads/sdk';
import { RunEndedError } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/catalog.ts';
import { MEETING_RUN_TOOL_CALLS, MEETING_RUN_TOOLS, ROOM_SCOPED_READS, keepRoomHits, meetingBudgetSentence, meetingRunRefusal, meetingToolBudgetUsed, widenForRoom } from '../src/meeting-runs.ts';

// P17-06: a run that answers in a live call is held to the room BEFORE it reads (meeting-runs.ts): only searches, memory and knowledge are offered, a search of
// messages, files or meetings answers only the call's own channel, and the run has a cap of tool calls. The whole path (a real run over its MCP endpoint) is in
// packages/plugins/meetings/test/assistant.test.ts.

const ROOM = '00000000-0000-7000-8000-0000000c0001';
const OTHER = '00000000-0000-7000-8000-0000000c0002';
const inCall = { trigger: 'meeting_question', runId: 'r', workspaceId: 'w' } as unknown as BotRunHandle;
const chat = { trigger: 'mention', runId: 'r', workspaceId: 'w' } as unknown as BotRunHandle;

function ctxWith(n: number | Error): { ctx: PluginContext; asked: { count: number } } {
  const asked = { count: 0 };
  const ctx = {
    runs: {
      asBot: async (_run: unknown, fn: (tx: { query: (sql: string) => Promise<{ rows: Array<{ n: string }> }> }) => Promise<unknown>) => {
        if (n instanceof Error) throw n;
        return fn({
          query: async (sql: string) => {
            asked.count += 1;
            expect(sql).toContain("kind = 'tool'");
            return { rows: [{ n: String(n) }] };
          },
        });
      },
    },
  } as unknown as PluginContext;
  return { ctx, asked };
}

describe('the tools a run in a call is offered', () => {
  it('are the searches, the team’s memory and knowledge; anything else is refused with a sentence the model can act on', () => {
    expect([...MEETING_RUN_TOOLS].sort()).toEqual(['files.search', 'knowledge.search', 'meetings.search', 'memory.recall', 'messages.search']);
    for (const tool of MEETING_RUN_TOOLS) expect(meetingRunRefusal(inCall, tool)).toBeNull();
    for (const tool of ['personal.read', 'files.read', 'messages.post', 'answer.post', 'google_drive.search']) {
      expect(meetingRunRefusal(inCall, tool)).toMatchObject({ code: 'not_available', message: expect.stringContaining('not available here') });
    }
  });
  it('are not narrowed for any other run', () => {
    expect(meetingRunRefusal(chat, 'personal.read')).toBeNull();
    expect(meetingRunRefusal({ trigger: 'meeting_ended' } as BotRunHandle, 'meetings.read')).toBeNull();
  });
});

describe('a search of a run in a call', () => {
  it('asks the tool for its most hits, then keeps only the room’s, cut back to what the model asked for', () => {
    expect(widenForRoom('messages.search', { query: 'q', limit: 3 })).toEqual({ input: { query: 'q', limit: 50 }, keep: 3 });
    expect(widenForRoom('meetings.search', { query: 'q' })).toEqual({ input: { query: 'q', limit: 20 }, keep: 8 });
    const answer = {
      hits: [
        { id: 'm1', channel: { id: OTHER } },
        { id: 'm2', channel: { id: ROOM } },
        { id: 'm3', channel: { id: ROOM } },
        { id: 'p1', channel: null },
        { meetingId: 'x', channelId: ROOM },
        { meetingId: 'y', channelId: OTHER },
      ],
    };
    expect((keepRoomHits(answer, ROOM, 10) as { hits: unknown[] }).hits).toEqual([{ id: 'm2', channel: { id: ROOM } }, { id: 'm3', channel: { id: ROOM } }, { meetingId: 'x', channelId: ROOM }]);
    expect((keepRoomHits(answer, ROOM, 1) as { hits: unknown[] }).hits).toHaveLength(1);
    expect(keepRoomHits(answer, ROOM, 10)).toHaveProperty('note');
  });
  it('keeps nothing when the run has no room recorded, and leaves an answer that is not a list of hits alone', () => {
    expect((keepRoomHits({ hits: [{ id: 'm2', channel: { id: ROOM } }] }, null, 10) as { hits: unknown[] }).hits).toEqual([]);
    const refused = { ok: false, code: 'forbidden', message: 'no' };
    expect(keepRoomHits(refused, ROOM, 10)).toBe(refused);
    expect(keepRoomHits(null, ROOM, 10)).toBeNull();
  });
  // P38-08: what the door logs is what the model was shown, after the hold. A call in one channel logs the meetings of that channel and never one that was held back; a
  // call whose own channel has no hit logs nothing at all (so an empty log, for a room-held search, means "the room had nothing", not "the search was not made").
  it('writes the source log from the hits that are left: a meeting of the call’s channel is a `meeting` line, one of another channel is never logged', () => {
    const sourcesFrom = TOOLS['meetings.search']!.sourcesFrom!;
    const raw = { hits: [{ meetingId: 'standup', channelId: ROOM, atMs: 1 }, { meetingId: 'leads', channelId: OTHER, atMs: 2 }, { meetingId: 'solo', channelId: null, atMs: 3 }] };
    expect(sourcesFrom(keepRoomHits(raw, ROOM, 8))).toEqual([{ sourceType: 'meeting', sourceRef: 'standup', scope: 'channel' }]);
    expect(sourcesFrom(keepRoomHits(raw, OTHER, 8))).toEqual([{ sourceType: 'meeting', sourceRef: 'leads', scope: 'channel' }]);
    // a call whose room has no hit, and a run with no room recorded, log and show nothing
    expect(sourcesFrom(keepRoomHits({ hits: [{ meetingId: 'leads', channelId: OTHER, atMs: 2 }] }, ROOM, 8))).toEqual([]);
    expect(sourcesFrom(keepRoomHits(raw, null, 8))).toEqual([]);
    // messages and files are held the same way
    const messages = { hits: [{ id: 'in', channel: { id: ROOM } }, { id: 'out', channel: { id: OTHER } }] };
    expect(TOOLS['messages.search']!.sourcesFrom!(keepRoomHits(messages, ROOM, 10))).toEqual([{ sourceType: 'message', sourceRef: 'in', scope: 'channel' }]);
    expect(TOOLS['files.search']!.sourcesFrom!(keepRoomHits(messages, ROOM, 10))).toEqual([{ sourceType: 'file', sourceRef: 'in', scope: 'channel' }]);
  });
  it('covers exactly the searches that name a channel', () => {
    expect([...ROOM_SCOPED_READS].sort()).toEqual(['files.search', 'meetings.search', 'messages.search']);
  });
});

describe('the cap of tool calls of one answer in a call', () => {
  it('lets the 8th call through and turns the 9th away, with a sentence that says to answer now', async () => {
    expect(MEETING_RUN_TOOL_CALLS).toBe(8);
    expect(await meetingToolBudgetUsed(ctxWith(7).ctx, inCall)).toBe(false);
    expect(await meetingToolBudgetUsed(ctxWith(8).ctx, inCall)).toBe(true);
    expect(meetingBudgetSentence()).toMatch(/Answer now/);
  });
  it('is not counted for another run, lets a run that ended end, and does not stop a run for a count that failed', async () => {
    const { ctx, asked } = ctxWith(500);
    expect(await meetingToolBudgetUsed(ctx, chat)).toBe(false);
    expect(asked.count).toBe(0);
    await expect(meetingToolBudgetUsed(ctxWith(new RunEndedError('ended')).ctx, inCall)).rejects.toBeInstanceOf(RunEndedError);
    expect(await meetingToolBudgetUsed(ctxWith(new Error('busy')).ctx, inCall)).toBe(false);
  });
});
