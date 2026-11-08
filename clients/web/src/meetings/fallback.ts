/*
 * The server fallback (PLAN P15-07, client side). A device too weak to write out speech itself can, when the person chose "server" and the room allows it (the workspace
 * switch and the team's TEAM.md), send its own microphone to the server in short chunks. The page cuts the chunks exactly as the on-device engine does (speech/vad.ts), wraps
 * each in a 16 kHz mono WAV and POSTs it to `/api/meetings/:id/audio-chunks`; the server writes it out, stores the line as the person's and throws the audio away.
 * This is the ONLY place a room's audio leaves the page, and only the person's own, only after they said yes, only in server mode: the controller starts this engine
 * under those three conditions and stops it the moment one stops being true.
 */
import { PostMeetingAudioChunkResponse, postMeetingAudioChunkRoute, ErrorEnvelope, type PostMeetingAudioChunkQuery } from '@manythreads/shared';
import { ApiError, CSRF_HEADER, buildPath, readCsrfCookie } from '../api/client';
import { STREAM_SAMPLE_RATE, encodeWav16, wavFromPcm16 } from '../speech/stream';
import { createStreamingSegmenter, type StreamChunk } from '../speech/vad';
import { fakeAsrEnabled } from '../speech/fake';
import {
  MIC_FAILED_MESSAGE,
  defaultEngineDeps,
  makeClock,
  newSessionId,
  ownTrack,
  runStatus,
  setSayTarget,
  type EngineContext,
  type EngineDeps,
  type Run,
  type SayFn,
  type StreamStatus,
  type TranscribeEngine,
} from './engine';

/** What is sent about a chunk (the shared query shape, with the numbers already numbers). */
export type ChunkQuery = Omit<PostMeetingAudioChunkQuery, 'lang'> & { lang?: string };

/** Sends one WAV. Rejects with an `ApiError` (status 0 for a network failure); a 429 carries `retryAfterMs`. */
export type ChunkUploader = (meetingId: string, query: ChunkQuery, wav: Blob) => Promise<PostMeetingAudioChunkResponse>;

export class UploadError extends ApiError {
  readonly retryAfterMs: number | null;
  constructor(init: ConstructorParameters<typeof ApiError>[0], retryAfterMs: number | null) {
    super(init);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The real upload: `fetch` with the same cookie and CSRF header as every other call (the shared `call` sends JSON, a WAV body is bytes). */
export const uploadChunk: ChunkUploader = async (meetingId, query, wav) => {
  const q = new URLSearchParams({ clientSegId: query.clientSegId, startMs: String(query.startMs), durationMs: String(query.durationMs) });
  if (query.lang) q.set('lang', query.lang);
  const headers: Record<string, string> = { 'content-type': 'audio/wav', accept: 'application/json' };
  const csrf = readCsrfCookie(typeof document === 'undefined' ? undefined : document.cookie);
  if (csrf) headers[CSRF_HEADER] = csrf;
  let res: Response;
  try {
    res = await fetch(`${buildPath(postMeetingAudioChunkRoute.path, { meetingId })}?${q.toString()}`, { method: postMeetingAudioChunkRoute.method, headers, credentials: 'include', body: wav });
  } catch (e) {
    throw new UploadError({ code: 'network', status: 0, message: e instanceof Error ? e.message : 'Network error' }, null);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const env = ErrorEnvelope.safeParse(body);
    const after = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(after) && after > 0 ? Math.min(60, after) * 1000 : null;
    throw new UploadError(
      env.success ? { code: env.data.error.code, message: env.data.error.message, status: res.status } : { code: res.status === 401 ? 'unauthenticated' : 'internal', message: `Request failed (${res.status})`, status: res.status },
      retryAfterMs,
    );
  }
  const out = PostMeetingAudioChunkResponse.safeParse(body);
  if (!out.success) throw new UploadError({ code: 'bad_response', status: res.status, message: 'The server sent a response this app does not understand.' }, null);
  return out.data;
};

export interface FallbackDeps extends EngineDeps {
  upload: ChunkUploader;
}

export const defaultFallbackDeps = (): FallbackDeps => ({ ...defaultEngineDeps(), upload: uploadChunk });

/** At least this long between two uploads, so a talkative person stays under the server's 120 a minute. */
export const UPLOAD_GAP_MS = 400;
/** Chunks waiting to go; past this the oldest are dropped (the person is minutes behind: the network is gone). */
export const UPLOAD_QUEUE_MAX = 60;
const UPLOAD_RETRIES = 5;
const DRAIN_ON_STOP_MS = 20_000;
export const NOT_ALLOWED_MESSAGE = "Server transcription isn't available for you in this room right now.";

interface Waiting {
  wav: Blob;
  query: ChunkQuery;
}

export function createFallbackEngine(deps: FallbackDeps = defaultFallbackDeps()): TranscribeEngine {
  let run: Run | null = null;
  let muted = false;
  let current: { setMuted(m: boolean): void } | null = null;

  /** One person's upload queue: serial, spaced, retried; a refusal ends the whole thing with a plain sentence. */
  const createUploader = (ctx: EngineContext, status: (s: StreamStatus) => void, onFatal: () => void) => {
    const queue: Waiting[] = [];
    let busy: Promise<void> | null = null;
    let dead = false;
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => void deps.setTimeout(resolve, ms));

    const sendOne = async (w: Waiting): Promise<void> => {
      for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt++) {
        try {
          await deps.upload(ctx.meetingId, w.query, w.wav);
          return;
        } catch (e) {
          const err = e instanceof UploadError ? e : null;
          const code = e instanceof ApiError ? e.status : 0;
          if (code === 403 || code === 401) {
            dead = true;
            status({ kind: 'failed', message: e instanceof ApiError && e.message !== '' ? e.message : NOT_ALLOWED_MESSAGE });
            onFatal();
            return;
          }
          const retry = code === 0 || code === 429 || code >= 500;
          if (!retry || attempt >= UPLOAD_RETRIES) return; // refused (the room ended, the chunk was bad) or given up on: this chunk is lost, the next may go
          await sleep(err?.retryAfterMs ?? Math.min(8000, 500 * 2 ** attempt));
        }
      }
    };

    const drain = (): Promise<void> => {
      if (busy) return busy;
      busy = (async () => {
        try {
          while (queue.length > 0 && !dead) {
            const w = queue.shift()!;
            await sendOne(w);
            if (queue.length > 0) await sleep(UPLOAD_GAP_MS);
          }
        } finally {
          busy = null;
        }
      })();
      return busy;
    };

    return {
      add(w: Waiting): void {
        if (dead) return;
        queue.push(w);
        while (queue.length > UPLOAD_QUEUE_MAX) queue.shift();
        void drain();
      },
      /** Throws away every chunk waiting and sends no more (the person took their yes back). A chunk already on the wire cannot be called back. */
      discard(): void {
        dead = true;
        queue.length = 0;
      },
      /** Resolves when the queue is empty, or after `limitMs` (the person is leaving; a stuck network must not hold the page). */
      async finish(limitMs: number): Promise<void> {
        const done = drain();
        await Promise.race([done, sleep(limitMs)]);
        queue.length = 0;
      },
    };
  };

  const begin = async (ctx: EngineContext, mine: Run): Promise<void> => {
    const status = runStatus(mine, ctx);
    const clock = await makeClock(ctx, deps);
    if (mine.cancelled) return;
    if (!clock) {
      status({ kind: 'failed', message: "Couldn't reach the room to start transcribing." });
      return;
    }
    const sessionId = newSessionId();
    let n = 0;
    let stopFn: () => void = () => undefined;
    const uploader = createUploader(ctx, status, () => stopFn());

    const send = (samples: Float32Array | Int16Array, startMs: number): void => {
      const durationMs = Math.min(30_000, Math.max(1, Math.round((samples.length * 1000) / STREAM_SAMPLE_RATE)));
      n += 1;
      const wav = samples instanceof Int16Array ? wavFromPcm16(samples) : encodeWav16(samples);
      uploader.add({ wav, query: { clientSegId: `${sessionId}-${n}`, startMs: Math.max(0, Math.round(startMs)), durationMs } });
    };

    if (fakeAsrEnabled()) {
      // the test build listens to nothing: the page says what was said, and it goes up as a WAV the fake server transcriber reads back
      const say: SayFn = (text, options) => {
        if (options?.partial) return true; // the server takes no partial lines
        const ms = 1500;
        const payload = new TextEncoder().encode(`FAKEASR:${text}`);
        const pcm = new Int16Array(Math.max(Math.ceil(payload.length / 2), Math.round((ms * STREAM_SAMPLE_RATE) / 1000)));
        new Uint8Array(pcm.buffer).set(payload, 0);
        send(pcm, clock.nowMs() - ms);
        return true;
      };
      const untarget = setSayTarget(say);
      mine.onStop = async () => {
        untarget();
        if (mine.discard) uploader.discard();
        else await uploader.finish(DRAIN_ON_STOP_MS);
      };
      status({ kind: 'listening' });
      if (mine.cancelled) await mine.onStop();
      return;
    }

    const track = await ownTrack({ ...ctx, onStatus: status }, deps);
    if (!track) return;
    if (mine.cancelled) {
      track.stop();
      return;
    }
    // where the end of the samples pushed so far sits on the meeting clock (see stream.ts: re-set at every block, so the audio clock never drifts from the meeting's)
    let anchorMs = 0;
    let anchorPos = 0;
    const msOf = (sample: number): number => anchorMs - ((anchorPos - sample) * 1000) / STREAM_SAMPLE_RATE;
    const onChunk = (chunk: StreamChunk): void => send(chunk.samples, msOf(chunk.startSample));
    const segmenter = createStreamingSegmenter({ onChunk });
    const source = deps.createSource(track);
    let live = true;
    const end = async (): Promise<void> => {
      if (!live) return;
      live = false;
      source.stop();
      track.stop();
      if (mine.discard) {
        // the person took their yes back: the sound still in the chunk being spoken is not cut and sent
        uploader.discard();
        return;
      }
      segmenter.flush();
      await uploader.finish(DRAIN_ON_STOP_MS);
    };
    stopFn = () => void end();
    current = {
      setMuted(m) {
        if (m) segmenter.flush();
      },
    };
    mine.onStop = end;
    try {
      await source.start((block) => {
        if (!live || muted) return;
        anchorMs = clock.nowMs();
        anchorPos = segmenter.position + block.length;
        segmenter.push(block);
      });
    } catch {
      status({ kind: 'failed', message: MIC_FAILED_MESSAGE });
      await end();
      return;
    }
    status({ kind: 'listening' });
    if (mine.cancelled) await end();
  };

  return {
    start(context) {
      if (run || !context) return;
      const mine: Run = { cancelled: false };
      run = mine;
      void begin(context, mine).catch(() => runStatus(mine, context)({ kind: 'failed', message: MIC_FAILED_MESSAGE }));
    },
    stop(options) {
      const mine = run;
      run = null;
      if (!mine) return;
      mine.cancelled = true;
      if (options?.discard) mine.discard = true;
      current = null;
      void mine.onStop?.();
    },
    setMuted(m) {
      muted = m;
      current?.setMuted(m);
    },
  };
}
