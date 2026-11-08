import { invalid, type PluginContext, type PluginEvent, type PluginTx } from '@manythreads/sdk';
import { ChannelMessagePostedEvent, MEETING_LATE_LINE_SECONDS, MEETING_SEGMENT_TEXT_MAX, VoiceMeta, type MeetingConsent, type MeetingSegmentInput } from '@manythreads/shared';
import { pushCaption } from './captions.ts';
import { comparableText, stripHostileText } from './limits.ts';
import { noteQuestions } from './questions.ts';

// Work package S1 (P15-08, P15-14): taking lines into the transcript. Lines come from three places: a device (the route in routes-transcript.ts), the server's own
// transcriber (S3, S4) and a voice message posted in the call's thread. All three end in `takeSegments`, so the same rules apply to each:
//   - the words are cleaned of control and bidirectional characters (limits.ts) before anything else;
//   - a speaker who has not said yes to "Transcribe my voice" leaves only the times of their speaking: the line is stored without its words and is never shown as a caption;
//   - a partial line (the engine may still change it) is only ever a caption, never stored;
//   - a final line that repeats what another device of the same speaker already sent (same words, the times overlapping by half or more of the shorter) is dropped;
//   - a line sent twice (same `clientSegId`) is stored once.

const INT_MAX = 2_147_483_647;

/** How far before a batch the stored lines are searched for a repeat: a line spoken that long before cannot overlap one starting now. */
const REPEAT_LOOK_BACK_MS = 300_000;

export interface SegmentRoom {
  id: string;
  workspaceId: string;
}

export interface SegmentSpeaker {
  actorId: string;
  displayName: string;
  consent: MeetingConsent;
}

export interface TakeResult {
  stored: number;
  duplicates: number;
  captioned: number;
  blanked: boolean;
}

interface Span {
  startMs: number;
  endMs: number;
  key: string;
}

/** True when two stretches of speech are the same words heard twice: the overlap is half or more of the shorter stretch, and the words are the same once folded. */
export function isRepeat(a: Span, b: Span): boolean {
  if (a.key === '' || a.key !== b.key) return false;
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  if (overlap < 0) return false;
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return overlap >= shorter * 0.5;
}

/**
 * Takes a batch of lines of one speaker into a room. `tx` is the caller's transaction for a device (the database policies then apply too) or a system transaction for the
 * server's own lines. Returns what happened to each line, in counts.
 */
export async function takeSegments(
  ctx: PluginContext,
  tx: PluginTx,
  room: SegmentRoom,
  speaker: SegmentSpeaker,
  lines: readonly MeetingSegmentInput[],
  source: 'device' | 'server',
  options: { catchingUp?: boolean } = {},
): Promise<TakeResult> {
  const yes = speaker.consent === 'yes';
  const result: TakeResult = { stored: 0, duplicates: 0, captioned: 0, blanked: !yes };
  for (const l of lines) {
    if (l.startMs > INT_MAX || l.endMs > INT_MAX) throw invalid('A line is longer than a voice room can be');
  }
  const caption = (l: MeetingSegmentInput, text: string, final: boolean) =>
    pushCaption(
      ctx,
      room.id,
      { kind: 'speech', speakerId: speaker.actorId as never, speakerName: speaker.displayName, startMs: l.startMs, endMs: l.endMs, text, final, catchingUp: options.catchingUp ?? false, askerName: null },
      room.workspaceId,
    );

  // partial lines: a caption for a speaker who said yes, nothing at all for anyone else
  const finals: { input: MeetingSegmentInput; text: string }[] = [];
  for (const l of lines) {
    const text = stripHostileText(l.text).slice(0, MEETING_SEGMENT_TEXT_MAX);
    if (!l.final) {
      if (yes && text !== '') {
        await caption(l, text, false);
        result.captioned += 1;
      }
      continue;
    }
    if (yes && text === '') continue; // nothing was said
    finals.push({ input: l, text: yes ? text : '' });
  }
  if (finals.length === 0) return result;

  // repeats of what another device of this speaker already sent (only words that are kept can repeat)
  let keep = finals;
  if (yes) {
    const minStart = Math.min(...finals.map((f) => f.input.startMs));
    const maxEnd = Math.max(...finals.map((f) => f.input.endMs));
    const stored = await tx.query<{ start_ms: number; end_ms: number; text: string }>(
      `SELECT start_ms, end_ms, text FROM app.meeting_segments
        WHERE meeting_id = $1::uuid AND speaker_id = $2::uuid AND final AND text <> ''
          AND start_ms >= $3::int AND start_ms <= $4::int AND end_ms >= $5::int
        LIMIT 500`,
      [room.id, speaker.actorId, Math.max(0, minStart - REPEAT_LOOK_BACK_MS), maxEnd, minStart],
    );
    const seen: Span[] = stored.rows.map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, key: comparableText(r.text) }));
    keep = [];
    for (const f of finals) {
      const span: Span = { startMs: f.input.startMs, endMs: f.input.endMs, key: comparableText(f.text) };
      // the same `clientSegId` is the database's to decide (it is stored once); a repeat from another device is dropped here
      if (seen.some((s) => isRepeat(s, span))) {
        result.duplicates += 1;
        continue;
      }
      seen.push(span);
      keep.push(f);
    }
    if (keep.length === 0) return result;
  }

  const inserted = await tx.query<{ client_seg_id: string }>(
    `INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, final, source, lang, client_seg_id)
     SELECT $1::uuid, $2::uuid, t.start_ms, t.end_ms, t.text, true, $3, t.lang, t.client_seg_id
       FROM unnest($4::int[], $5::int[], $6::text[], $7::text[], $8::text[]) AS t(start_ms, end_ms, text, lang, client_seg_id)
     ON CONFLICT ON CONSTRAINT meeting_segments_client_seg DO NOTHING
     RETURNING client_seg_id`,
    [room.id, speaker.actorId, source, keep.map((f) => f.input.startMs), keep.map((f) => f.input.endMs), keep.map((f) => f.text), keep.map((f) => f.input.lang ?? null), keep.map((f) => f.input.clientSegId)],
  );
  const taken = new Set(inserted.rows.map((r) => r.client_seg_id));
  result.stored = taken.size;
  result.duplicates += keep.length - taken.size;
  if (yes) {
    for (const f of keep) if (taken.has(f.input.clientSegId)) await caption(f.input, f.text, true);
    // a line that names the room's note-taker may be a question for it (questions.ts, P15-24); only the words of a speaker who said yes are ever looked at
    await noteQuestions(
      ctx,
      tx,
      room,
      speaker,
      keep.filter((f) => taken.has(f.input.clientSegId)).map((f) => ({ clientSegId: f.input.clientSegId, text: f.text, endMs: f.input.endMs })),
    );
  }
  return result;
}

// ---- a voice message in the call's thread becomes a line (P15-14) -----------------------------------------------------------------------------

interface VoiceRoomRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  started_at: Date;
}

/**
 * A voice message posted in the thread of a call, while the call runs or in the two minutes after it, is the words its author said into their phone: it becomes a line of the
 * transcript, but only when the author said yes to "Transcribe my voice" in that call (the same rule as a line from a device) and only when the call is being transcribed. Safe
 * to run twice for one message (the line carries the message id as its `clientSegId`). Returns true when a line was stored.
 */
export async function takeVoiceMessage(ctx: PluginContext, tx: PluginTx, event: ChannelMessagePostedEvent): Promise<boolean> {
  if (!event.threadRootId) return false;
  const room = (
    await tx.query<VoiceRoomRow>(
      `SELECT id, workspace_id, channel_id, started_at FROM app.meetings
        WHERE thread_root_id = $1::uuid AND transcription <> 'off'
          AND (state = 'live' OR ended_at > now() - make_interval(secs => $2::int))
        ORDER BY started_at DESC LIMIT 1`,
      [event.threadRootId, MEETING_LATE_LINE_SECONDS],
    )
  ).rows[0];
  if (!room || room.channel_id !== event.channelId) return false;

  const message = (
    await tx.query<{ body_plain: string; meta: unknown; created_at: Date; author_id: string }>(
      'SELECT body_plain, meta, created_at, author_id FROM app.messages WHERE id = $1::uuid AND deleted_at IS NULL',
      [event.messageId],
    )
  ).rows[0];
  if (!message || message.author_id !== event.authorId) return false;
  const voice = VoiceMeta.safeParse((message.meta as { voice?: unknown } | null)?.voice);
  if (!voice.success || voice.data.transcript === 'none') return false;

  const who = (
    await tx.query<{ display_name: string; consent_transcribe: MeetingConsent }>(
      'SELECT display_name, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid',
      [room.id, event.authorId],
    )
  ).rows[0];
  if (!who || who.consent_transcribe !== 'yes') return false;

  const text = stripHostileText(message.body_plain).slice(0, MEETING_SEGMENT_TEXT_MAX);
  if (text === '') return false;
  const endMs = Math.min(INT_MAX, Math.max(0, message.created_at.getTime() - room.started_at.getTime()));
  const startMs = Math.max(0, endMs - voice.data.durationMs);
  const done = await takeSegments(
    ctx,
    tx,
    { id: room.id, workspaceId: room.workspace_id },
    { actorId: event.authorId, displayName: who.display_name, consent: 'yes' },
    [{ clientSegId: `voice:${event.messageId}`, startMs, endMs, text, final: true, lang: voice.data.language }],
    'device',
  );
  return done.stored > 0;
}

export function registerSegments(ctx: PluginContext): void {
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx) => {
    const event = ChannelMessagePostedEvent.safeParse(raw);
    if (!event.success) return;
    await takeVoiceMessage(ctx, tx, event.data);
  });
}
