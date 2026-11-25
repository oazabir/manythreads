import { RunEndedError, type BotRunHandle, type PluginContext } from '@manythreads/sdk';

// A run that answers a question in a live call (trigger `meeting_question`: the note-taker's, or Brain's from the Ask panel; P15-24, P17-06). Everyone in the call reads
// the answer, so the meetings plugin throws an answer away when the run read anything outside the channels every person present may read (`readStayedInside`,
// runtime-hermes). Checked only afterwards, a search across the asker's whole team made almost every answer useless (live, 2026-11-25: Brain searched 60 times for eight
// minutes and its answer was thrown away). So the door holds such a run BEFORE it reads:
//   - only the tools that can answer inside the room are offered: searches of messages, files and meetings, the team's memory and knowledge bases;
//   - a search of messages, files or meetings answers only hits of the call's own channel (recorded on the run, `bot_runs.channel_id`); a run with none gets no hits;
//   - at most `MEETING_RUN_TOOL_CALLS` tool calls, then the model is told to answer with what it has.

export const isMeetingAnswerRun = (run: Pick<BotRunHandle, 'trigger'>): boolean => run.trigger === 'meeting_question';

/** The tools a run in a call may call. */
export const MEETING_RUN_TOOLS: ReadonlySet<string> = new Set(['messages.search', 'files.search', 'meetings.search', 'memory.recall', 'knowledge.search']);
/** The searches whose hits are held to the call's own channel. */
export const ROOM_SCOPED_READS: ReadonlySet<string> = new Set(['messages.search', 'files.search', 'meetings.search']);
/** Tool calls one answer in a call may make. */
export const MEETING_RUN_TOOL_CALLS = 8;

export const meetingToolSentence = (tool: string): string =>
  `In a call you can only search this call's channel, the team's memory and its knowledge bases; ${tool} is not available here. Answer with what you have.`;
export const meetingBudgetSentence = (): string =>
  `You have used the ${MEETING_RUN_TOOL_CALLS} searches one answer in a call may make. Answer now with what you found, or say in one sentence that you could not find it.`;

/** A refusal for a tool a run in a call is not offered; null for a tool it may call, and for any other run. */
export function meetingRunRefusal(run: Pick<BotRunHandle, 'trigger'>, tool: string): { code: 'not_available'; message: string } | null {
  if (!isMeetingAnswerRun(run) || MEETING_RUN_TOOLS.has(tool)) return null;
  return { code: 'not_available', message: meetingToolSentence(tool) };
}

/** True when a run in a call has made its tool calls (counted from the run's own decision lines). A count that fails does not stop the run; a run that ended does. */
export async function meetingToolBudgetUsed(ctx: PluginContext, run: BotRunHandle): Promise<boolean> {
  if (!isMeetingAnswerRun(run)) return false;
  try {
    const n = await ctx.runs.asBot(run, async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.run_decisions WHERE run_id = app.run_id() AND kind = 'tool'")).rows[0]?.n ?? 0));
    return n >= MEETING_RUN_TOOL_CALLS;
  } catch (err) {
    if (err instanceof RunEndedError) throw err;
    return false;
  }
}

/** The call's own channel, as the run's row records it (read as the system: a workspace bot cannot read its own row). Null when none is recorded. */
export async function roomChannelOf(ctx: PluginContext, run: BotRunHandle): Promise<string | null> {
  return ctx.db.system(
    async (sys) => (await sys.query<{ channel_id: string | null }>('SELECT channel_id::text AS channel_id FROM app.bot_runs WHERE id = $1::uuid', [run.runId])).rows[0]?.channel_id ?? null,
    { workspaceId: run.workspaceId },
  );
}

/** Most hits a search is asked for when its hits are then held to one channel: what is left is cut back to what the model asked for. */
const WIDE_LIMIT: Readonly<Record<string, number>> = { 'messages.search': 50, 'files.search': 50, 'meetings.search': 20 };
const DEFAULT_LIMIT: Readonly<Record<string, number>> = { 'messages.search': 10, 'files.search': 10, 'meetings.search': 8 };

/** The input of a room-held search: as many hits as the tool gives, so the call's channel still has some after the others are left out. */
export function widenForRoom(tool: string, input: Record<string, unknown>): { input: Record<string, unknown>; keep: number } {
  const asked = typeof input['limit'] === 'number' && Number.isInteger(input['limit']) && input['limit'] > 0 ? input['limit'] : (DEFAULT_LIMIT[tool] ?? 10);
  return { input: { ...input, limit: WIDE_LIMIT[tool] ?? asked }, keep: Math.min(asked, WIDE_LIMIT[tool] ?? asked) };
}

/** The channel a hit is in: `channel.id` (messages, files) or `channelId` (meetings); null for a hit with none (a team page, a file of the team's repo). */
function channelOfHit(hit: unknown): string | null {
  if (hit === null || typeof hit !== 'object') return null;
  const h = hit as { channel?: { id?: unknown } | null; channelId?: unknown };
  if (h.channel !== null && typeof h.channel === 'object' && typeof h.channel.id === 'string') return h.channel.id;
  return typeof h.channelId === 'string' ? h.channelId : null;
}

/** The answer of a room-held search with only the hits of `room` (none when `room` is null), at most `keep` of them. Any other answer passes as it is. */
export function keepRoomHits(result: unknown, room: string | null, keep: number): unknown {
  if (result === null || typeof result !== 'object' || !Array.isArray((result as { hits?: unknown }).hits)) return result;
  const hits = (result as { hits: unknown[] }).hits;
  const kept = room === null ? [] : hits.filter((h) => channelOfHit(h) === room).slice(0, keep);
  return { ...(result as Record<string, unknown>), hits: kept, ...(kept.length < hits.length ? { note: 'Only hits of this call’s own channel are shown: everyone in the call reads the answer.' } : {}) };
}
