import { HttpError, forbidden, json, notFound, route, type LlmTranscriber, type PluginContext, type PluginTx, readWavInfo } from '@manythreads/sdk';
import {
  MEETING_AUDIO_CHUNK_MAX_BYTES,
  MEETING_AUDIO_CHUNK_MAX_MS,
  MEETING_AUDIO_CHUNKS_PER_MINUTE,
  MeetingPathParams,
  type MeetingCaption,
  PostMeetingAudioChunkQuery,
  PostMeetingAudioChunkResponse,
  postMeetingAudioChunkRoute,
} from '@manythreads/shared';
import { pushCaption } from './captions.ts';
import { transcribeLimits } from './config.ts';
import { loadMeeting } from './rows.ts';

// The server fallback for a device too weak to transcribe (PLAN P15-07, decision C15): `POST /api/meetings/:meetingId/audio-chunks`. The body is one 16 kHz mono 16-bit WAV
// (at most 2 MiB and 30 s). The chunk becomes text through the `transcribe` door of the `llm` provider (gateway-llm: pre-call check, spend line, the self-hosted Whisper
// server) and the text is stored as one `server` line of the person who sent it. The bytes are read into memory, sent on and dropped: nothing is written to disk or to blob
// storage (this is asserted in the tests).
//
// Who may send, in the order it is checked (each refusal is a 403 with a plain reason, PLAN criterion 8):
//   * a person (not a bot) who is in the room now, or left it less than two minutes ago (the chunk of their last words may be on its way), in a room that is live or ended
//     less than two minutes ago;
//   * who said yes to being transcribed;
//   * in a room whose transcription is `server`;
//   * where both caps still allow the server (the workspace switch and the team's TEAM.md; the lower wins).
// Everything is checked before the body is read, so a refused sender costs nothing. A line is written by the system role (the policy lets a person write only `device`
// lines), for the speaker the request is authenticated as and nobody else.

const LATE_WINDOW_MS = 120_000;
/** The most a sender may stall between two parts of the body, and the most a whole chunk may take (a 2 MiB body on a slow line). */
const BODY_IDLE_MS = 10_000;
const BODY_TOTAL_MS = 60_000;
const INT4_MAX = 2_147_483_647;
const SEGMENT_TEXT_MAX = 4000;

/** Text from a speech model is hostile input: control characters and bidirectional overrides go, whitespace is folded, the length is capped. One linear pass each. */
export function cleanSpokenText(raw: string): string {
  // C0 (but not tab and newline, folded below), DEL, C1, and U+202A-202E, U+2066-2069 (bidirectional overrides and isolates)
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '');
  const folded = stripped.replace(/\s+/g, ' ').trim();
  return folded.length > SEGMENT_TEXT_MAX ? [...folded].slice(0, SEGMENT_TEXT_MAX).join('') : folded;
}

type ReadableLike = AsyncIterable<Uint8Array> & { iterator?: (options: { destroyOnReturn: boolean }) => AsyncIterator<Uint8Array>; resume?: () => unknown; destroy?: () => unknown };

/**
 * The whole body, or `null` when it is longer than `max`. Does not destroy the socket when it stops early (so the 413 can still be sent; the rest is discarded), and gives
 * up on a sender that stalls or takes too long.
 */
export async function readBodyCapped(source: AsyncIterable<Uint8Array> | undefined, max: number, idleMs = BODY_IDLE_MS, totalMs = BODY_TOTAL_MS): Promise<Uint8Array | null> {
  if (!source) return new Uint8Array(0);
  const src = source as ReadableLike;
  const it = src.iterator ? src.iterator({ destroyOnReturn: false }) : source[Symbol.asyncIterator]();
  const deadline = Date.now() + totalMs;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(408, 'validation_failed', 'The audio took too long to arrive.')), Math.max(Math.min(idleMs, deadline - Date.now()), 0));
    });
    let step: IteratorResult<Uint8Array>;
    try {
      step = await Promise.race([it.next(), stalled]);
    } catch (err) {
      src.destroy?.();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (step.done) break;
    size += step.value.length;
    if (size > max) {
      src.resume?.();
      return null;
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks);
}

interface SenderFacts {
  actorId: string;
  displayName: string;
  consent: 'yes' | 'no' | 'unasked';
  leftAt: Date | null;
}

async function senderOf(tx: PluginTx, meetingId: string): Promise<SenderFacts | null> {
  const who = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!who?.person || !who.actor) throw forbidden('Voice rooms are for people');
  const row = (
    await tx.query<{ display_name: string; consent_transcribe: 'yes' | 'no' | 'unasked'; left_at: Date | null }>(
      'SELECT display_name, consent_transcribe, left_at FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid',
      [meetingId, who.actor],
    )
  ).rows[0];
  return row ? { actorId: who.actor, displayName: row.display_name, consent: row.consent_transcribe, leftAt: row.left_at } : null;
}

export function registerAudioRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...postMeetingAudioChunkRoute,
    rawBody: true,
    schema: { query: PostMeetingAudioChunkQuery, response: PostMeetingAudioChunkResponse },
    rateLimit: { limit: MEETING_AUDIO_CHUNKS_PER_MINUTE, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const query = PostMeetingAudioChunkQuery.parse(req.query);
      if (query.startMs > INT4_MAX - MEETING_AUDIO_CHUNK_MAX_MS) throw new HttpError(400, 'validation_failed', 'startMs is too large');
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const now = ctx.runtime.now().getTime();

      // ---- who may send (everything before the body is read) --------------------------------------------------------------------
      const sender = await senderOf(tx, m.id);
      if (!sender) throw forbidden('You are not in this voice room.');
      const roomOpen = m.state === 'live' || (m.ended_at !== null && now - m.ended_at.getTime() <= LATE_WINDOW_MS);
      if (!roomOpen) throw new HttpError(409, 'conflict', 'This voice room has ended.');
      if (sender.leftAt !== null && now - sender.leftAt.getTime() > LATE_WINDOW_MS) throw forbidden('You are not in this voice room.');
      if (sender.consent !== 'yes') throw forbidden('Your voice is not transcribed: you have not said yes to it.');
      if (m.transcription !== 'server') throw forbidden('This room does not transcribe on the server.');
      const limits = await transcribeLimits(ctx, tx, m.team_id);
      if (!limits.allowed.includes('server')) throw forbidden(limits.reason ?? 'Transcription on the server is not allowed here.');

      // ---- a chunk sent twice is answered from the first time, with no second transcription and no second line --------------------
      const again = (
        await tx.query<{ text: string }>('SELECT text FROM app.meeting_segments WHERE meeting_id = $1::uuid AND speaker_id = $2::uuid AND client_seg_id = $3', [m.id, sender.actorId, query.clientSegId])
      ).rows[0];
      if (again) return json(PostMeetingAudioChunkResponse.parse({ text: again.text, stored: true }));

      const transcriber = ctx.providers.get<LlmTranscriber>('llm');
      if (!transcriber || typeof transcriber.transcribe !== 'function') throw new HttpError(503, 'internal', 'Transcription on the server is not set up.');

      // ---- the body: one WAV, at most 2 MiB, held in memory only ------------------------------------------------------------------
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MEETING_AUDIO_CHUNK_MAX_BYTES) {
        (req.stream as ReadableLike | undefined)?.resume?.();
        throw new HttpError(413, 'validation_failed', 'The audio is larger than 2 MB.');
      }
      const wav = await readBodyCapped(req.stream, MEETING_AUDIO_CHUNK_MAX_BYTES);
      if (wav === null) throw new HttpError(413, 'validation_failed', 'The audio is larger than 2 MB.');
      const info = readWavInfo(wav);
      if (!info.ok) throw new HttpError(400, 'validation_failed', info.reason);
      if (info.durationMs > MEETING_AUDIO_CHUNK_MAX_MS + 250) throw new HttpError(400, 'validation_failed', 'The audio is longer than 30 seconds.');

      // ---- text: its own transaction as the system actor (the pre-call check and the spend line are the gateway's) ------------------
      const heard = await ctx.db.system((sys) => transcriber.transcribe(sys, { workspaceId: m.workspace_id, teamId: m.team_id, meetingId: m.id, actorId: sender.actorId, wav, durationMs: info.durationMs, ...(query.lang ? { lang: query.lang } : {}) }), {
        workspaceId: m.workspace_id,
      });
      if (heard.outcome === 'unavailable') throw new HttpError(503, 'internal', heard.reason);
      if (heard.outcome === 'refused') throw new HttpError(409, 'conflict', heard.reason);
      const text = cleanSpokenText(heard.text);
      if (text === '') return json(PostMeetingAudioChunkResponse.parse({ text: '', stored: false }));

      // ---- the line: the speaker is the caller, never somebody the request names -----------------------------------------------------
      const endMs = query.startMs + info.durationMs;
      const stored = await ctx.db.system(
        async (sys) =>
          (
            await sys.query<{ id: string }>(
              `INSERT INTO app.meeting_segments (meeting_id, speaker_id, start_ms, end_ms, text, final, source, lang, client_seg_id)
               VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, 'server', $6, $7)
               ON CONFLICT (meeting_id, speaker_id, client_seg_id) DO NOTHING RETURNING id`,
              [m.id, sender.actorId, query.startMs, endMs, text, heard.lang ?? query.lang ?? null, query.clientSegId],
            )
          ).rows.length > 0,
        { workspaceId: m.workspace_id },
      );
      if (stored) {
        try {
          await pushCaption(ctx, m.id, { kind: 'speech', speakerId: sender.actorId as MeetingCaption['speakerId'], speakerName: sender.displayName, startMs: query.startMs, endMs, text, final: true, catchingUp: false, askerName: null });
        } catch {
          // the line is stored; a caption that cannot be pushed is only late news (the room reads the transcript)
        }
      }
      return json(PostMeetingAudioChunkResponse.parse({ text, stored: true }));
    }),
  });
}
