import type { PluginContext } from '@manythreads/sdk';
import { MEETING_CAPTION_PUSH, MEETING_CAPTION_WINDOW_MS, MeetingCaptionPush, type MeetingCaption } from '@manythreads/shared';

// Work package S1 (P15-08, decision C2): live captions. The captions of a room are coalesced in process memory and pushed to the people present as `MEETING_CAPTION_PUSH`, at most
// four pushes a second per room however many people speak or listen. `pushCaption` is what the routes, the note-taker's listener (S4) and the questions (S5) call, so the
// coalescer is one for the room.

/** The most captions one push carries (the same bound the push schema has). */
const PUSH_MAX = 50;

type Pending = { captions: MeetingCaption[] };

export type CaptionSink = (meetingId: string, captions: MeetingCaption[]) => void | Promise<void>;

export interface CoalescerClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: CoalescerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Room = { pending: Pending; timer: unknown | null; lastFlushAt: number };

/**
 * Gathers the captions of each room and hands them to the sink at most once per window. The first caption after a quiet spell is sent at once; the ones that come in
 * the window after it wait for the window's end and go together, so a room sees at most `1000 / windowMs` pushes a second. A newer partial line of a speaker replaces that speaker's
 * waiting partial, and a final line replaces the partials it finishes. A caption of kind `answer` is always kept.
 */
export class CaptionCoalescer {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly sink: CaptionSink,
    private readonly windowMs: number = MEETING_CAPTION_WINDOW_MS,
    private readonly clock: CoalescerClock = realClock,
  ) {}

  push(meetingId: string, caption: MeetingCaption): void {
    let room = this.rooms.get(meetingId);
    if (!room) {
      room = { pending: { captions: [] }, timer: null, lastFlushAt: Number.NEGATIVE_INFINITY };
      this.rooms.set(meetingId, room);
    }
    this.merge(room.pending, caption);
    if (room.timer === null) {
      const wait = Math.max(0, room.lastFlushAt + this.windowMs - this.clock.now());
      room.timer = this.clock.setTimer(() => this.flush(meetingId), wait);
    }
  }

  /** How many rooms hold captions or a timer right now (the test reads it to see that idle rooms are forgotten). */
  size(): number {
    return this.rooms.size;
  }

  private merge(pending: Pending, caption: MeetingCaption): void {
    if (caption.kind === 'speech') {
      // A newer line of the same speaker supersedes that speaker's waiting partials, final or not.
      pending.captions = pending.captions.filter((c) => !(c.kind === 'speech' && c.speakerId === caption.speakerId && !c.final));
    }
    pending.captions.push(caption);
    while (pending.captions.length > PUSH_MAX) {
      const partial = pending.captions.findIndex((c) => !c.final && c.kind === 'speech');
      pending.captions.splice(partial >= 0 ? partial : 0, 1);
    }
  }

  private flush(meetingId: string): void {
    const room = this.rooms.get(meetingId);
    if (!room) return;
    room.timer = null;
    const captions = room.pending.captions;
    room.pending = { captions: [] };
    if (captions.length === 0) {
      this.rooms.delete(meetingId);
      return;
    }
    room.lastFlushAt = this.clock.now();
    // Quiet after this push: keep the room's stamp for one more window so the next caption still waits its turn, then forget the room.
    this.clock.setTimer(() => {
      const r = this.rooms.get(meetingId);
      if (r && r.timer === null && r.pending.captions.length === 0 && this.clock.now() - r.lastFlushAt >= this.windowMs) this.rooms.delete(meetingId);
    }, this.windowMs);
    try {
      const out = this.sink(meetingId, captions);
      if (out && typeof (out as Promise<void>).catch === 'function') (out as Promise<void>).catch(() => undefined);
    } catch {
      // A failed push loses captions, never the transcript: the lines are already stored.
    }
  }
}

// ---- the coalescer bound to the plugin ----------------------------------------------------------------------------------------------------

type PluginState = { coalescer: CaptionCoalescer; workspaces: Map<string, string> };

const states = new WeakMap<PluginContext, PluginState>();

function stateOf(ctx: PluginContext): PluginState {
  let state = states.get(ctx);
  if (state) return state;
  const workspaces = new Map<string, string>();
  const sink: CaptionSink = async (meetingId, captions) => {
    let workspaceId = workspaces.get(meetingId);
    if (!workspaceId) {
      workspaceId = await ctx.db.system(async (tx) => (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.meetings WHERE id = $1::uuid', [meetingId])).rows[0]?.workspace_id);
      if (!workspaceId) return;
      if (workspaces.size > 2000) workspaces.clear();
      workspaces.set(meetingId, workspaceId);
    }
    await ctx.db.system(
      async (tx) => {
        const here = await tx.query<{ person_id: string }>('SELECT person_id FROM app.meeting_participants WHERE meeting_id = $1::uuid AND left_at IS NULL', [meetingId]);
        const ids = here.rows.map((r) => r.person_id);
        if (ids.length === 0) return;
        await ctx.realtime.pushToPeople(tx, ids, MEETING_CAPTION_PUSH, MeetingCaptionPush.parse({ meetingId, captions }));
      },
      { workspaceId },
    );
  };
  state = { coalescer: new CaptionCoalescer(sink), workspaces };
  states.set(ctx, state);
  return state;
}

export function registerCaptions(ctx: PluginContext): void {
  stateOf(ctx);
}

/**
 * Puts a caption on the screens of the people in the room, coalesced per room (see `CaptionCoalescer`): it returns at once and the push follows within a quarter of a second.
 * `workspaceId` is optional: a caller that has it saves one lookup, otherwise it is read from the meeting row.
 */
export async function pushCaption(ctx: PluginContext, meetingId: string, caption: MeetingCaption, workspaceId?: string): Promise<void> {
  const state = stateOf(ctx);
  if (workspaceId && !state.workspaces.has(meetingId)) {
    if (state.workspaces.size > 2000) state.workspaces.clear();
    state.workspaces.set(meetingId, workspaceId);
  }
  state.coalescer.push(meetingId, caption);
}
