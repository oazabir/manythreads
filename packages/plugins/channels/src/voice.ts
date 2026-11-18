import { randomUUID } from 'node:crypto';
import {
  BlobNotFoundError,
  HttpError,
  VOICE_CLIP_MAX_BYTES,
  type BlobStorage,
  type ClipInTx,
  type LlmClipResult,
  type LlmClipTranscriber,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import { VoiceMeta, toPlainText, type ChannelMessage } from '@manythreads/shared';
import { z } from 'zod';
import { conflict, forbidden, notFound } from './http.ts';
import { audience, findChannelMessage, pushMessage, requireChannel, requirePost, type Deps } from './service.ts';
import { VOICE_MAX_ATTEMPTS, VOICE_QUEUE, transcribedRangeMs, transcriptBody, voiceTranscriptsOn } from './voice-rules.ts';

export { VOICE_MAX_ATTEMPTS, VOICE_QUEUE } from './voice-rules.ts';
const VOICE_CONCURRENCY = 2;
const MISSING_CLIP = 'The recording is no longer stored.';
const NO_WORDS = 'No words were heard in the first 20 seconds.';
const NO_TRANSCRIBER = 'Speech to text is not set up on this server.';

// Voice messages on the server (P32-02 to P32-04, decision D13). A voice message is posted at once with a stand-in line as its body and
// `meta.voice.transcript = 'pending'`; a background job reads the clip, asks the speech model for the first 20 seconds and writes the words into the body.
//
// This file holds the job (`registerVoiceJob`, `transcribeVoiceMessage`): three steps, with no database transaction open while the model works, and the
// compare-and-set writes that end it (`writeServerText`, `writeFailure`, `writeNone`): each one changes the message only if it is still `pending` and not
// deleted, so a delete or an author's edit that happened meanwhile wins and the late answer is dropped. The posting rules are in `voice-rules.ts`.

// ---- The job -----------------------------------------------------------------------------------------------------------------------------------------

const Payload = z.object({ workspaceId: z.uuid(), messageId: z.uuid() });

/** Test hook, on globalThis because the server loads this file by its own path and a test may import it by another (two module instances). Honoured only outside production. */
const HOOK = Symbol.for('manythreads.channels.voice.hook');
export interface VoiceHook {
  /** Stands in for the `llm` provider's clip door. */
  transcriber?: Pick<LlmClipTranscriber, 'transcribeClip' | 'clipStatus'>;
}
export function voiceHook(): VoiceHook {
  if (process.env['NODE_ENV'] === 'production') return {};
  return (globalThis as unknown as Record<symbol, VoiceHook | undefined>)[HOOK] ?? {};
}
export const VOICE_HOOK = HOOK;

export const clipTranscriberOf = (ctx: PluginContext): Pick<LlmClipTranscriber, 'transcribeClip' | 'clipStatus'> | undefined =>
  voiceHook().transcriber ?? ctx.providers.get<LlmClipTranscriber>('llm') ?? undefined;

interface Looked {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  author_id: string;
  team_id: string | null;
  deleted: boolean;
  voice: unknown;
  switch_on: boolean;
  blob_key: string | null;
  mime: string | null;
  [key: string]: unknown;
}

/** Step 1: the message, its clip and the switch, in one short transaction. */
async function look(tx: PluginTx, workspaceId: string, messageId: string): Promise<Looked | undefined> {
  return (
    await tx.query<Looked>(
      `SELECT m.id, m.channel_id, m.thread_root_id, m.author_id, c.team_id, (m.deleted_at IS NOT NULL) AS deleted, m.meta -> 'voice' AS voice,
              (coalesce(w.settings ->> 'voiceTranscripts', 'true') <> 'false') AS switch_on, f.blob_key, f.mime
         FROM app.messages m
         JOIN app.channels c ON c.id = m.channel_id
         JOIN app.workspaces w ON w.id = m.workspace_id
         LEFT JOIN app.files f ON f.id = CASE WHEN m.meta -> 'voice' ->> 'fileId' ~ '^[0-9a-f-]{36}$' THEN (m.meta -> 'voice' ->> 'fileId')::uuid END
        WHERE m.id = $1::uuid AND m.workspace_id = $2::uuid`,
      [messageId, workspaceId],
    )
  ).rows[0];
}

/** The clip's bytes from storage, at most one more than the door takes (so an over-large clip is seen as such without holding all of it). */
async function readClip(storage: BlobStorage, blobKey: string): Promise<Uint8Array | null> {
  let stream: AsyncIterable<Uint8Array>;
  try {
    stream = await storage.get(blobKey);
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream) {
    parts.push(part);
    total += part.byteLength;
    if (total > VOICE_CLIP_MAX_BYTES) break;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

type Written = { messageId: string; channelId: string; threadRootId: string | null; authorId: string; teamId: string | null; durationMs: number };

/** After a compare-and-set write that took: tell the readers (a `message.edited` push with no edited mark) and write the event. */
async function announce(deps: Deps, tx: PluginTx, workspaceId: string, w: Written, state: 'server' | 'failed' | 'none', endMs: number | null): Promise<void> {
  const message = await findChannelMessage(tx, w.channelId, w.messageId);
  if (message) await pushMessage(deps, tx, await audience(tx, w.channelId), 'message.edited', message);
  await deps.ctx.events.emit(tx, {
    type: 'channel.message.transcribed',
    schemaVersion: 1,
    workspaceId,
    channelId: w.channelId,
    teamId: w.teamId,
    messageId: w.messageId,
    authorId: w.authorId,
    threadRootId: w.threadRootId,
    state,
    transcriptEndMs: endMs,
  });
}

const UPDATE_PENDING_WHERE = `WHERE m.id = $1::uuid AND m.workspace_id = $2::uuid AND m.deleted_at IS NULL AND m.meta -> 'voice' ->> 'transcript' = 'pending'`;

/** Compare-and-set: the words become the body, but only if the message is still pending and live. `edited_at` stays as it is: no edited mark. */
async function writeServerText(deps: Deps, tx: PluginTx, workspaceId: string, w: Written, text: string): Promise<boolean> {
  const endMs = transcribedRangeMs(w.durationMs);
  const body = transcriptBody(text, w.durationMs);
  const res = await tx.query(
    `UPDATE app.messages m SET body = $3, body_plain = $4,
            meta = jsonb_set(m.meta, '{voice}', (m.meta -> 'voice') - 'transcriptNote' - 'transcriptRetry' || jsonb_build_object('transcript', 'server', 'transcriptEndMs', $5::int))
      ${UPDATE_PENDING_WHERE} RETURNING m.id`,
    [w.messageId, workspaceId, body, toPlainText(body), endMs],
  );
  if (res.rows.length === 0) return false;
  await announce(deps, tx, workspaceId, w, 'server', endMs);
  return true;
}

async function writeFailure(deps: Deps, tx: PluginTx, workspaceId: string, w: Written, note: string, retry: boolean): Promise<boolean> {
  const res = await tx.query(
    `UPDATE app.messages m SET meta = jsonb_set(m.meta, '{voice}', (m.meta -> 'voice') - 'transcriptEndMs' - 'transcriptRetry'
              || jsonb_build_object('transcript', 'failed', 'transcriptNote', $3::text) || CASE WHEN $4::boolean THEN '{"transcriptRetry": true}'::jsonb ELSE '{}'::jsonb END)
      ${UPDATE_PENDING_WHERE} RETURNING m.id`,
    [w.messageId, workspaceId, note.slice(0, 200), retry],
  );
  if (res.rows.length === 0) return false;
  await announce(deps, tx, workspaceId, w, 'failed', null);
  return true;
}

/** The switch was turned off after the post: the message becomes a plain voice message with no transcript. */
async function writeNone(deps: Deps, tx: PluginTx, workspaceId: string, w: Written): Promise<boolean> {
  const res = await tx.query(
    `UPDATE app.messages m SET meta = jsonb_set(m.meta, '{voice}', (m.meta -> 'voice') - 'transcriptEndMs' - 'transcriptNote' - 'transcriptRetry' || '{"transcript": "none"}'::jsonb)
      ${UPDATE_PENDING_WHERE} RETURNING m.id`,
    [w.messageId, workspaceId],
  );
  if (res.rows.length === 0) return false;
  await announce(deps, tx, workspaceId, w, 'none', null);
  return true;
}

/**
 * One run of the job for one message. `inTx` opens a short system transaction scoped to the workspace; nothing here holds one while the clip is read or
 * the model works. `attempt` and `maxAttempts` decide whether a model that was only unavailable is thrown (the queue tries again) or written as `failed`.
 */
export async function transcribeVoiceMessage(
  deps: Deps,
  inTx: ClipInTx,
  payload: Record<string, unknown>,
  attempt: number,
  maxAttempts: number = VOICE_MAX_ATTEMPTS,
): Promise<void> {
  const { ctx } = deps;
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) return;
  const { workspaceId, messageId } = parsed.data;

  // 1. one short transaction: what is there, and whether it is still wanted
  const row = await inTx((tx) => look(tx, workspaceId, messageId));
  if (!row || row.deleted) return;
  const voice = VoiceMeta.safeParse(row.voice);
  if (!voice.success || voice.data.transcript !== 'pending') return; // an author's edit (or an earlier run) got there first
  const meta = voice.data;
  const w: Written = { messageId, channelId: row.channel_id, threadRootId: row.thread_root_id, authorId: row.author_id, teamId: row.team_id, durationMs: meta.durationMs };
  if (!row.switch_on) {
    await inTx((tx) => writeNone(deps, tx, workspaceId, w));
    return;
  }
  const failNow = async (note: string, retry: boolean): Promise<void> => void (await inTx((tx) => writeFailure(deps, tx, workspaceId, w, note, retry)));
  const transcriber = clipTranscriberOf(ctx);
  if (!transcriber) return failNow(NO_TRANSCRIBER, false);

  // 2. the clip, with no transaction open
  const storage = ctx.providers.get<BlobStorage>('storage');
  if (!storage || !row.blob_key) return failNow(MISSING_CLIP, false);
  const clip = await readClip(storage, row.blob_key);
  if (clip === null) return failNow(MISSING_CLIP, false);

  // 3. the model (the door opens its own short transactions and holds none across the call)
  const answer: LlmClipResult = await transcriber.transcribeClip(
    { workspaceId, teamId: row.team_id, messageId, actorId: row.author_id, clip, contentType: row.mime ?? 'application/octet-stream', durationMs: meta.durationMs },
    inTx,
  );
  switch (answer.outcome) {
    case 'text': {
      if (answer.text.trim() === '') return failNow(NO_WORDS, false);
      await inTx((tx) => writeServerText(deps, tx, workspaceId, w, answer.text));
      return;
    }
    case 'refused':
      return failNow(answer.reason, false);
    case 'unavailable':
      // may pass: the queue tries again; the last attempt says so on the message, with "Try again" offered
      if (attempt < maxAttempts) throw new Error(`speech model unavailable: ${answer.reason}`);
      return failNow(answer.reason, true);
  }
}

export function registerVoiceJob(deps: Deps): void {
  deps.ctx.jobs.register(
    VOICE_QUEUE,
    async (payload, _unusable, job) => {
      await transcribeVoiceMessage(deps, (fn) => job.transaction(fn), payload, job.attempt);
    },
    // detached: the speech model takes seconds and no transaction is held meanwhile; two at once (the speech pod takes one at a time and queues a few)
    { detached: true, concurrency: VOICE_CONCURRENCY, maxAttempts: VOICE_MAX_ATTEMPTS },
  );
}

// ---- Asking again ------------------------------------------------------------------------------------------------------------------------------------

/** At most this many asks for one message in an hour (in process memory, per replica; never in the database). */
export const RETRIES_PER_HOUR = 3;
const HOUR_MS = 3_600_000;
export interface RetryBudget {
  take(messageId: string): void;
  reset(): void;
}
export function createRetryBudget(now: () => number = Date.now): RetryBudget {
  const stamps = new Map<string, number[]>();
  return {
    take(messageId) {
      const t = now();
      const fresh = (stamps.get(messageId) ?? []).filter((at) => at > t - HOUR_MS);
      if (fresh.length >= RETRIES_PER_HOUR) {
        const wait = Math.max(1, Math.ceil(((fresh[0] ?? t) + HOUR_MS - t) / 1000));
        throw new HttpError(429, 'rate_limited', 'You asked for this transcript too often: 3 times an hour at most. Try again later.', { 'retry-after': String(wait) });
      }
      fresh.push(t);
      stamps.set(messageId, fresh);
      // a long-running server must not keep every message id it ever saw
      if (stamps.size > 5000) for (const [id, list] of stamps) if (list.every((at) => at <= t - HOUR_MS)) stamps.delete(id);
    },
    reset: () => stamps.clear(),
  };
}
export const retryBudget: RetryBudget = createRetryBudget();

/**
 * The author asks for the transcript again (`POST /api/messages/:messageId/voice/transcribe`): the message must be `failed` with a retry on offer, the
 * workspace switch must be on and the speech model set up. The message goes back to `pending` through `app.voice_transcript_retry` (the guard on `messages`
 * lets a caller change nothing in `meta`), a new job is queued, and the readers get the message again (the "Writing the transcript" state).
 */
export async function retryVoiceTranscript(deps: Deps, tx: PluginTx, messageId: string, budget: RetryBudget = retryBudget): Promise<ChannelMessage> {
  const { ctx } = deps;
  const row = (
    await tx.query<{ channel_id: string; author_id: string; deleted: boolean; voice: unknown }>(
      "SELECT channel_id, author_id, (deleted_at IS NOT NULL) AS deleted, meta -> 'voice' AS voice FROM app.messages WHERE id = $1::uuid",
      [messageId],
    )
  ).rows[0];
  if (!row) throw notFound('No such message');
  if (row.author_id !== tx.actor.id) throw forbidden('Only the person who sent a voice message can ask for its transcript again');
  if (row.deleted) throw conflict('That message was deleted');
  const voice = VoiceMeta.safeParse(row.voice);
  if (!voice.success || voice.data.transcript !== 'failed' || voice.data.transcriptRetry !== true) throw conflict('There is no transcript to try again for this message');
  const channel = await requireChannel(tx, row.channel_id);
  await requirePost(tx, channel);
  if (!(await voiceTranscriptsOn(tx))) throw conflict('Transcripts of voice messages are switched off for this workspace');
  const transcriber = clipTranscriberOf(ctx);
  const status = transcriber ? await transcriber.clipStatus(tx, tx.actor.workspaceId) : ({ ready: false, reason: NO_TRANSCRIBER } as const);
  if (!status.ready) throw conflict(status.reason);
  budget.take(messageId);
  const flipped = (await tx.query<{ ok: boolean }>('SELECT app.voice_transcript_retry($1::uuid) AS ok', [messageId])).rows[0]?.ok === true;
  if (!flipped) throw conflict('There is no transcript to try again for this message');
  await ctx.jobs.enqueue(tx, VOICE_QUEUE, { workspaceId: tx.actor.workspaceId, messageId }, { dedupeKey: `voice:${messageId}:retry:${randomUUID()}` });
  const message = (await findChannelMessage(tx, row.channel_id, messageId))!;
  await pushMessage(deps, tx, await audience(tx, row.channel_id), 'message.edited', message);
  return message;
}
