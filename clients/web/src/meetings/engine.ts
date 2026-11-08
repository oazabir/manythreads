/*
 * Where a person's words in a voice room come from (PLAN P15-06). The call controller asks `loadEngine()` for an engine and calls `start(context)` once the person has
 * said yes to "Transcribe my voice" and the room is set to on-device transcription; `stop()` when any of that stops being true.
 *   on-device  the person's OWN microphone track is cut into chunks and written out by the Whisper worker of P14-16 (speech/stream.ts). Nothing leaves the device but
 *              the words: a partial line about once a second, a final line per chunk, sent in batches to `POST /api/meetings/:id/segments` (decision C1).
 *   fake       the test build (VITE_MANYTHREADS_FAKE_ASR=1): listens to nothing; a final line appears only when the page calls `window.__manythreadsSay(text)`.
 *   server     `fallback.ts`: for a device too weak for the first, the person's chunks go to the server as audio (decision C15), only when they chose it.
 * Lines carry times on the meeting clock (decision C3): milliseconds since the room started, measured with the server's own clock through the heartbeat answer, so a
 * device whose clock is wrong still puts its words in the right place. Words from a microphone are hostile input to everything downstream; the server strips them.
 */
import type { MeetingHeartbeatResponse, MeetingSummary, PostMeetingSegmentsRequest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fakeAsrEnabled } from '../speech/fake';
import { hasSpeechPlatform } from '../speech/device';
import { TOO_SLOW_MESSAGE, chooseRecognizer, createLiveTranscriber, createTrackSource } from '../speech/stream';
import type { PcmSource, RecognizerChoice, StreamLine, StreamStatus } from '../speech/stream';
import { fetchMeeting, heartbeatMeeting, postSegments } from './api';

export { TOO_SLOW_MESSAGE };
export type { StreamStatus };

/** What the controller hands over when it starts an engine. Only `meetingId` is needed; the rest is looked up or opened when it is missing. */
export interface EngineContext {
  meetingId: string;
  /** When the room started (`meeting.startedAt`); fetched when missing. */
  startedAt?: string;
  /** The person's own microphone track (the one the room publishes). It is cloned, never stopped or changed. When missing, the engine opens the microphone itself. */
  track?: MediaStreamTrack | null;
  /** The microphone to open when no track is given. */
  inputId?: string | null;
  /** A meeting clock the controller already keeps (fed from its heartbeats); the engine makes its own when missing. */
  clock?: MeetingClock;
  /** Told what the engine is doing: getting the model, listening, "too slow", failed. */
  onStatus?: (status: StreamStatus) => void;
}

export interface TranscribeEngine {
  /** Starts listening to the person's own microphone and sending lines. Returns at once; progress comes through `context.onStatus`. */
  start(context?: EngineContext): void;
  /** Stops listening and sends the lines still waiting. */
  stop(): void;
  /** While muted, nothing is listened to. Optional: an engine that reads the track itself hears a muted track as silence anyway. */
  setMuted?(muted: boolean): void;
}

// ---- the meeting clock -------------------------------------------------------------------------------------------------------------------------

/** Milliseconds since the room started, on the SERVER's clock. */
export class MeetingClock {
  private offset = 0; // server clock minus this device's, in ms
  private bestRtt = Number.POSITIVE_INFINITY;
  private readonly startedAtMs: number;

  constructor(
    startedAt: string,
    private readonly deviceNow: () => number = Date.now,
  ) {
    this.startedAtMs = Date.parse(startedAt);
  }

  /** One round trip: the request left at `sentAt`, the answer (carrying `serverNow`) came at `receivedAt`, both on the device's clock. The server read its clock about half way. */
  observe(serverNow: string, sentAt: number, receivedAt: number): void {
    const server = Date.parse(serverNow);
    const rtt = receivedAt - sentAt;
    if (Number.isNaN(server) || rtt < 0 || rtt > 10_000) return;
    // the quickest round trip is the least wrong one; a slower one only counts once the best is old
    if (rtt > this.bestRtt * 2 + 50) return;
    this.bestRtt = rtt;
    this.offset = server - (sentAt + receivedAt) / 2;
  }

  /** Forget how good the best round trip was, so the next reading is taken as it comes (called before a new calibration). */
  reset(): void {
    this.bestRtt = Number.POSITIVE_INFINITY;
  }

  nowMs(): number {
    return Math.max(0, Math.round(this.deviceNow() + this.offset - this.startedAtMs));
  }
}

// ---- sending lines -----------------------------------------------------------------------------------------------------------------------------

export const SEGMENT_BATCH_MS = 250;
const SEGMENT_BATCH_MAX = 20;
const SEGMENT_QUEUE_MAX = 400;
const SEGMENT_RETRIES = 5;
const SEGMENT_TEXT_MAX = 4000;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}
export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type SegmentInput = PostMeetingSegmentsRequest['segments'][number];

export interface LineSender {
  /** A final line is kept until it is sent (and retried); a partial line replaces the partial before it, since only the newest is worth showing. */
  add(line: StreamLine): void;
  /** Sends everything waiting, resolves when it has been sent or given up on. */
  flush(): Promise<void>;
  /** Number of final lines given up on (the server refused them, or too many tries, or the queue was full). */
  readonly dropped: number;
}

export interface LineSenderOptions extends Timers {
  post: (body: PostMeetingSegmentsRequest) => Promise<unknown>;
  /** Makes the id of a line unique for this run of the engine, so a page reload in the middle of a call never reuses one. */
  sessionId: string;
  retryDelayMs?: (attempt: number) => number;
}

const retryable = (e: unknown): boolean => !isApiError(e) || e.status === 0 || e.status === 429 || e.status >= 500;

/** Batches the lines of one person: finals first, at most 20 a request, one request at a time, one partial riding along. */
export function createLineSender(o: LineSenderOptions): LineSender {
  const delay = o.retryDelayMs ?? ((attempt) => Math.min(8000, 500 * 2 ** attempt));
  const finals: SegmentInput[] = [];
  let partial: SegmentInput | null = null;
  let timer: unknown = null;
  let busy: Promise<void> | null = null;
  let dropped = 0;

  const toInput = (line: StreamLine): SegmentInput => {
    const startMs = Math.max(0, Math.round(line.startMs));
    return {
      clientSegId: `${o.sessionId}-${line.id}`,
      startMs,
      endMs: Math.max(startMs, Math.round(line.endMs)),
      text: line.text.slice(0, SEGMENT_TEXT_MAX),
      final: line.final,
      ...(line.lang ? { lang: line.lang } : {}),
    };
  };

  const schedule = (): void => {
    if (timer !== null || busy) return;
    timer = o.setTimeout(() => {
      timer = null;
      void drain();
    }, SEGMENT_BATCH_MS);
  };

  const sendBatch = async (): Promise<void> => {
    const batch = finals.splice(0, SEGMENT_BATCH_MAX);
    // the partial goes along only when there is room; a partial whose final line is in this batch is stale and goes nowhere
    if (partial && batch.some((b) => b.clientSegId === partial?.clientSegId)) partial = null;
    const withPartial = partial && batch.length < SEGMENT_BATCH_MAX ? partial : null;
    if (withPartial) partial = null;
    const segments = withPartial ? [...batch, withPartial] : batch;
    if (segments.length === 0) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await o.post({ segments });
        return;
      } catch (e) {
        if (!retryable(e) || attempt >= SEGMENT_RETRIES) {
          dropped += batch.length;
          return;
        }
        await new Promise<void>((resolve) => void o.setTimeout(resolve, delay(attempt)));
      }
    }
  };

  const drain = (): Promise<void> => {
    if (busy) return busy;
    busy = (async () => {
      try {
        while (finals.length > 0 || partial) await sendBatch();
      } finally {
        busy = null;
      }
    })();
    return busy;
  };

  return {
    add(line) {
      const input = toInput(line);
      if (line.final) {
        if (partial?.clientSegId === input.clientSegId) partial = null;
        finals.push(input);
        if (finals.length > SEGMENT_QUEUE_MAX) {
          finals.shift();
          dropped += 1;
        }
      } else {
        partial = input;
      }
      schedule();
    },
    async flush() {
      if (timer !== null) {
        o.clearTimeout(timer);
        timer = null;
      }
      if (busy) await busy;
      await drain();
    },
    get dropped() {
      return dropped;
    },
  };
}

// ---- what an engine stands on -----------------------------------------------------------------------------------------------------------------

export interface EngineDeps extends Timers {
  postSegments: (meetingId: string, body: PostMeetingSegmentsRequest) => Promise<unknown>;
  heartbeat: (meetingId: string, speaking: boolean) => Promise<MeetingHeartbeatResponse>;
  fetchMeeting: (meetingId: string) => Promise<MeetingSummary>;
  /** The device clock in ms since 1970. */
  now: () => number;
  /** Opens the person's microphone when the controller gave no track. */
  openMic: (inputId: string | null) => Promise<MediaStreamTrack>;
  /** The recognizer for this device (Whisper in the worker), or the reason there is none. */
  chooseRecognizer: () => Promise<RecognizerChoice>;
  /** 16 kHz samples from a track. */
  createSource: (track: MediaStreamTrack) => PcmSource;
}

export const MIC_FAILED_MESSAGE = "Couldn't open your microphone for transcription.";

const openBrowserMic = async (inputId: string | null): Promise<MediaStreamTrack> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(inputId ? { deviceId: { exact: inputId } } : {}) },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('no microphone');
  return track;
};

export const defaultEngineDeps = (): EngineDeps => ({
  ...realTimers,
  postSegments: (meetingId, body) => postSegments(meetingId, body),
  heartbeat: (meetingId, speaking) => heartbeatMeeting(meetingId, speaking),
  fetchMeeting: (meetingId) => fetchMeeting(meetingId),
  now: () => Date.now(),
  openMic: openBrowserMic,
  chooseRecognizer,
  createSource: (track) => createTrackSource(track),
});

const CALIBRATION_ROUND_TRIPS = 3;
const RECALIBRATE_MS = 5 * 60_000;

/** Reads the server's clock a few times and keeps the quickest reading. */
export async function calibrateClock(clock: MeetingClock, meetingId: string, deps: Pick<EngineDeps, 'heartbeat' | 'now'>): Promise<void> {
  clock.reset();
  for (let i = 0; i < CALIBRATION_ROUND_TRIPS; i++) {
    const sentAt = deps.now();
    try {
      const res = await deps.heartbeat(meetingId, false);
      clock.observe(res.serverNow, sentAt, deps.now());
    } catch {
      return; // the clock stays as it was; lines are still sent, only their times may be off by the device's error
    }
  }
}

/** A clock for a meeting: the controller's when it gave one, else made from `startedAt` (fetched when missing) and calibrated. Null when the room cannot be read. */
export async function makeClock(ctx: EngineContext, deps: EngineDeps): Promise<MeetingClock | null> {
  if (ctx.clock) return ctx.clock;
  let startedAt = ctx.startedAt;
  if (!startedAt) {
    try {
      startedAt = (await deps.fetchMeeting(ctx.meetingId)).meeting.startedAt;
    } catch {
      return null;
    }
  }
  const clock = new MeetingClock(startedAt, deps.now);
  await calibrateClock(clock, ctx.meetingId, deps);
  return clock;
}

/** A short random word that makes this run's line ids its own. */
export function newSessionId(): string {
  const bytes = new Uint8Array(5);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

/** Gets the person's own microphone as a track this engine may stop: a clone of the given one, else a fresh one. Null (and a status) when it cannot. */
export async function ownTrack(ctx: EngineContext, deps: EngineDeps): Promise<MediaStreamTrack | null> {
  try {
    if (ctx.track && ctx.track.readyState === 'live') return ctx.track.clone();
    return await deps.openMic(ctx.inputId ?? null);
  } catch {
    ctx.onStatus?.({ kind: 'failed', message: MIC_FAILED_MESSAGE });
    return null;
  }
}

// ---- the on-device engine ---------------------------------------------------------------------------------------------------------------------

/** One run of an engine, from `start()` to `stop()`. `onStop` is set once the run is far enough along to need undoing. */
export interface Run {
  cancelled: boolean;
  onStop?: () => Promise<void>;
}

/** The status callback of a run: silent once the run was stopped. */
export const runStatus =
  (run: Run, ctx: EngineContext) =>
  (s: StreamStatus): void => {
    if (!run.cancelled) ctx.onStatus?.(s);
  };

export function createLiveEngine(deps: EngineDeps = defaultEngineDeps()): TranscribeEngine {
  let run: Run | null = null;
  let muted = false;
  let current: { setMuted(m: boolean): void } | null = null;

  const begin = async (ctx: EngineContext, mine: Run): Promise<void> => {
    const status = runStatus(mine, ctx);
    const choice = await deps.chooseRecognizer();
    if (mine.cancelled) return;
    if (!choice.ok) {
      status(choice.tooWeak ? { kind: 'too_slow', message: TOO_SLOW_MESSAGE } : { kind: 'failed', message: choice.reason });
      return;
    }
    const clock = await makeClock(ctx, deps);
    if (mine.cancelled) return;
    if (!clock) {
      status({ kind: 'failed', message: "Couldn't reach the room to start transcribing." });
      return;
    }
    const track = await ownTrack({ ...ctx, onStatus: status }, deps);
    if (!track) return;
    if (mine.cancelled) {
      track.stop();
      return;
    }
    const sender = createLineSender({ post: (body) => deps.postSegments(ctx.meetingId, body), sessionId: newSessionId(), setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
    let recalibrate: unknown = null;
    const release = async (): Promise<void> => {
      if (recalibrate !== null) deps.clearTimeout(recalibrate);
      recalibrate = null;
      track.stop();
      await sender.flush();
    };
    const transcriber = createLiveTranscriber({
      source: deps.createSource(track),
      recognizer: choice.recognizer,
      now: () => clock.nowMs(),
      onLine: (line) => sender.add(line),
      onStatus: (s) => {
        status(s);
        // a transcriber that gave up (too slow, the model failed) has already stopped listening: let go of the microphone and send what it had
        if (s.kind === 'too_slow' || s.kind === 'failed') void release();
      },
    });
    current = transcriber;
    mine.onStop = async () => {
      current = null;
      await transcriber.stop();
      await release();
    };
    transcriber.setMuted(muted);
    try {
      await transcriber.start();
    } catch {
      status({ kind: 'failed', message: MIC_FAILED_MESSAGE });
      await release();
      return;
    }
    if (!ctx.clock) {
      // the clock is read again now and then, so a long call does not slide
      const again = (): void => {
        recalibrate = deps.setTimeout(() => {
          if (mine.cancelled) return;
          void calibrateClock(clock, ctx.meetingId, deps).finally(again);
        }, RECALIBRATE_MS);
      };
      again();
    }
    if (mine.cancelled) await mine.onStop();
  };

  return {
    start(context) {
      if (run || !context) return; // without a room there is nothing to attach lines to
      const mine: Run = { cancelled: false };
      run = mine;
      void begin(context, mine).catch(() => runStatus(mine, context)({ kind: 'failed', message: MIC_FAILED_MESSAGE }));
    },
    stop() {
      const mine = run;
      run = null;
      if (!mine) return;
      mine.cancelled = true;
      current = null;
      void mine.onStop?.();
    },
    setMuted(m) {
      muted = m;
      current?.setMuted(m);
    },
  };
}

// ---- the test engine ---------------------------------------------------------------------------------------------------------------------------

/** The page's door for browser tests, defined only in the fake build: `window.__manythreadsSay(text)` is "the person said this". Returns false when no engine is listening. */
export type SayFn = (text: string, options?: { partial?: boolean }) => boolean;
declare global {
  interface Window {
    __manythreadsSay?: SayFn;
  }
}

let saying: SayFn | null = null;
/** The engine that is listening makes itself the target of `__manythreadsSay`; the returned function removes it again (only if it is still the target). */
export function setSayTarget(fn: SayFn): () => void {
  saying = fn;
  return () => {
    if (saying === fn) saying = null;
  };
}
/** What `window.__manythreadsSay` does: hands the words to the engine that is listening. */
export const sayToEngine: SayFn = (text, options) => saying?.(text, options) ?? false;
if (fakeAsrEnabled() && typeof window !== 'undefined') window.__manythreadsSay = sayToEngine;

/** How long a fake spoken line is taken to have lasted. */
export const FAKE_LINE_MS = 1500;

/** Listens to nothing. A final line is made only when the page calls `window.__manythreadsSay`, so a spec chooses the words and when they are said. */
export function createFakeLiveEngine(deps: EngineDeps = defaultEngineDeps()): TranscribeEngine {
  let run: Run | null = null;
  return {
    start(context) {
      if (run || !context) return;
      const mine: Run = { cancelled: false };
      run = mine;
      const status = runStatus(mine, context);
      void (async () => {
        const clock = await makeClock(context, deps);
        if (mine.cancelled) return;
        if (!clock) {
          status({ kind: 'failed', message: "Couldn't reach the room to start transcribing." });
          return;
        }
        const sender = createLineSender({ post: (body) => deps.postSegments(context.meetingId, body), sessionId: newSessionId(), setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
        let n = 0;
        const say: SayFn = (text, options) => {
          const end = clock.nowMs();
          n += 1;
          sender.add({ id: n, text, startMs: Math.max(0, end - FAKE_LINE_MS), endMs: end, final: options?.partial !== true, lang: 'en' });
          return true;
        };
        const untarget = setSayTarget(say);
        mine.onStop = async () => {
          untarget();
          await sender.flush();
        };
        status({ kind: 'listening' });
        if (mine.cancelled) await mine.onStop();
      })();
    },
    stop() {
      const mine = run;
      run = null;
      if (!mine) return;
      mine.cancelled = true;
      void mine.onStop?.();
    },
  };
}

// ---- what the page asks ----------------------------------------------------------------------------------------------------------------------

/**
 * Whether the page may offer "Transcribe" at all: the test build, or a browser that has what the on-device engine stands on (a worker and audio). Whether THIS device is
 * fast enough is not known here; `checkDevice()` says, and a device that turns out too slow is told so when the engine starts.
 */
export const engineAvailable = (): boolean => fakeAsrEnabled() || hasSpeechPlatform();

export type DeviceCheck = { ok: true } | { ok: false; message: string };

/** Whether this device can write out speech itself (the fake build always can). When not, `message` is the plain sentence to show, and the page offers the server where the room allows. */
export async function checkDevice(deps: Pick<EngineDeps, 'chooseRecognizer'> = defaultEngineDeps()): Promise<DeviceCheck> {
  if (fakeAsrEnabled()) return { ok: true };
  if (!hasSpeechPlatform()) return { ok: false, message: TOO_SLOW_MESSAGE };
  const choice = await deps.chooseRecognizer();
  return choice.ok ? { ok: true } : { ok: false, message: choice.tooWeak ? TOO_SLOW_MESSAGE : choice.reason };
}

export type EngineMode = 'on_device' | 'server';

/** The engine for the person's device and the room's mode, or null when there is none. `on_device` is the default. */
export async function loadEngine(mode: EngineMode = 'on_device'): Promise<TranscribeEngine | null> {
  if (mode === 'server') return (await import('./fallback')).createFallbackEngine();
  if (fakeAsrEnabled()) return createFakeLiveEngine();
  if (!engineAvailable()) return null;
  return createLiveEngine();
}
