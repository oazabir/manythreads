import { PostMeetingSegmentsRequest, type MeetingHeartbeatResponse } from '@manythreads/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import {
  MeetingClock,
  TOO_SLOW_MESSAGE,
  calibrateClock,
  createFakeLiveEngine,
  createLineSender,
  createLiveEngine,
  engineAvailable,
  loadEngine,
  sayToEngine,
  type EngineDeps,
  type StreamStatus,
} from '../src/meetings/engine';
import { UPLOAD_GAP_MS, UploadError, createFallbackEngine, type FallbackDeps } from '../src/meetings/fallback';
import type { PcmSource, StreamLine } from '../src/speech/stream';
import { FakeClock, MEETING, NOW, id, summary, person, ME, settle } from './meetings-fixtures';

// P15-06 / P15-07 (client): the lines a device sends, the meeting clock, the on-device engine, the test engine and the audio upload fallback.

const RATE = 16_000;
const talk = (ms: number): Float32Array => Float32Array.from({ length: Math.round((ms * RATE) / 1000) }, (_v, i) => 0.25 * Math.sin((2 * Math.PI * 220 * i) / RATE));
const hush = (ms: number): Float32Array => new Float32Array(Math.round((ms * RATE) / 1000));
const cat = (...p: Float32Array[]): Float32Array => {
  const out = new Float32Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

const STARTED = new Date(NOW - 60_000).toISOString(); // the room started a minute ago (on the server's clock)

function line(over: Partial<StreamLine> = {}): StreamLine {
  return { id: 1, text: 'hello', startMs: 100, endMs: 900, final: true, lang: 'en', ...over };
}

afterEach(() => vi.unstubAllEnvs());

describe('MeetingClock', () => {
  it('measures the server offset from a round trip and counts milliseconds since the room started', () => {
    let device = NOW + 5000; // this device runs five seconds fast
    const clock = new MeetingClock(STARTED, () => device);
    // the request left at device NOW+5000, the answer came 200 ms later; the server read its clock in the middle (server time NOW+100)
    clock.observe(new Date(NOW + 100).toISOString(), NOW + 5000, NOW + 5200);
    device = NOW + 5200; // = server NOW + 200
    expect(clock.nowMs()).toBe(60_000 + 200);
  });

  it('prefers the quickest round trip and ignores a nonsense one', () => {
    let device = NOW;
    const clock = new MeetingClock(STARTED, () => device);
    clock.observe(new Date(NOW + 50).toISOString(), NOW, NOW + 100); // a quick trip: offset 0
    clock.observe(new Date(NOW + 4000).toISOString(), NOW, NOW + 3000); // a slow one that disagrees: ignored
    clock.observe('not a date', NOW, NOW + 10);
    clock.observe(new Date(NOW).toISOString(), NOW + 10, NOW); // time ran backwards
    device = NOW + 1000;
    expect(clock.nowMs()).toBe(61_000);
  });

  it('never goes below zero', () => {
    const clock = new MeetingClock(new Date(NOW + 10_000).toISOString(), () => NOW);
    expect(clock.nowMs()).toBe(0);
  });

  it('is calibrated from the heartbeat answer, keeping the best of three readings', async () => {
    let device = NOW;
    const trips = [300, 40, 120];
    const clock = new MeetingClock(STARTED, () => device);
    const heartbeat = vi.fn(async (): Promise<MeetingHeartbeatResponse> => {
      const rtt = trips.shift()!;
      device += rtt;
      return { ok: true, serverNow: new Date(device - rtt / 2 + 2000).toISOString() }; // the server is two seconds ahead
    });
    await calibrateClock(clock, MEETING, { heartbeat, now: () => device });
    expect(heartbeat).toHaveBeenCalledTimes(3);
    expect(clock.nowMs()).toBe(60_000 + (device - NOW) + 2000);
  });
});

describe('the line sender', () => {
  const build = (post: (b: PostMeetingSegmentsRequest) => Promise<unknown>) => {
    const clock = new FakeClock();
    const sender = createLineSender({ post, sessionId: 'abc', setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
    return { clock, sender };
  };

  it('sends what the shared route takes: ids, whole milliseconds, trimmed text, the language', async () => {
    const posts: PostMeetingSegmentsRequest[] = [];
    const { clock, sender } = build(async (b) => void posts.push(b));
    sender.add(line({ id: 7, startMs: 100.4, endMs: 50, text: 'x'.repeat(5000) })); // ends before it starts, too long
    await clock.advance(250);
    expect(posts).toHaveLength(1);
    expect(() => PostMeetingSegmentsRequest.parse(posts[0])).not.toThrow();
    expect(posts[0]!.segments[0]).toMatchObject({ clientSegId: 'abc-7', startMs: 100, endMs: 100, final: true, lang: 'en' });
    expect(posts[0]!.segments[0]!.text).toHaveLength(4000);
  });

  it('batches lines that arrive within a quarter second, at most 20 to a request, finals before the partial', async () => {
    const posts: PostMeetingSegmentsRequest[] = [];
    const { clock, sender } = build(async (b) => void posts.push(b));
    for (let i = 1; i <= 23; i++) sender.add(line({ id: i, text: `line ${i}` }));
    sender.add(line({ id: 24, text: 'still talking', final: false }));
    await clock.advance(250);
    await settle();
    expect(posts.map((p) => p.segments.length)).toEqual([20, 4]);
    expect(posts[0]!.segments.every((s) => s.final)).toBe(true);
    expect(posts[1]!.segments.map((s) => [s.text, s.final])).toEqual([
      ['line 21', true],
      ['line 22', true],
      ['line 23', true],
      ['still talking', false],
    ]);
  });

  it('keeps only the newest partial, and drops it once its final line is there', async () => {
    const posts: PostMeetingSegmentsRequest[] = [];
    const { clock, sender } = build(async (b) => void posts.push(b));
    sender.add(line({ id: 1, text: 'hel', final: false }));
    sender.add(line({ id: 1, text: 'hello th', final: false }));
    await clock.advance(250);
    expect(posts[0]!.segments.map((s) => s.text)).toEqual(['hello th']);
    sender.add(line({ id: 2, text: 'one more', final: false }));
    sender.add(line({ id: 2, text: 'one more thing', final: true }));
    await clock.advance(250);
    expect(posts[1]!.segments.map((s) => [s.text, s.final])).toEqual([['one more thing', true]]);
  });

  it('tries a final line again when the server is busy or gone, and sends it once the server is back', async () => {
    let calls = 0;
    const posts: PostMeetingSegmentsRequest[] = [];
    const { clock, sender } = build(async (b) => {
      calls += 1;
      if (calls <= 2) throw new ApiError({ code: 'internal', status: 503, message: 'down' });
      posts.push(b);
    });
    sender.add(line());
    await clock.advance(250);
    await clock.advance(5000);
    expect(calls).toBe(3);
    expect(posts).toHaveLength(1);
    expect(sender.dropped).toBe(0);
  });

  it('does not try again when the server says no, and counts the lines it gave up on', async () => {
    let calls = 0;
    const { clock, sender } = build(async () => {
      calls += 1;
      throw new ApiError({ code: 'validation_failed', status: 400, message: 'no' });
    });
    sender.add(line());
    await clock.advance(250);
    await clock.advance(20_000);
    expect(calls).toBe(1);
    expect(sender.dropped).toBe(1);
  });

  it('flush sends what is waiting now', async () => {
    const posts: PostMeetingSegmentsRequest[] = [];
    const { clock, sender } = build(async (b) => void posts.push(b));
    sender.add(line());
    await sender.flush();
    expect(posts).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });
});

// ---- engines ------------------------------------------------------------------------------------------------------------------------------

function manualSource() {
  let push: ((s: Float32Array) => void) | null = null;
  const stops = { n: 0 };
  const source: PcmSource = { start: async (onPcm) => void (push = onPcm), stop: () => void (stops.n += 1) };
  return { source, stops, feed: (s: Float32Array) => push?.(s) };
}

function fakeTrack() {
  const track = { readyState: 'live', stopped: 0, cloned: 0 } as unknown as MediaStreamTrack & { stopped: number; cloned: number };
  (track as { stop: () => void }).stop = () => void (track.stopped += 1);
  (track as { clone: () => MediaStreamTrack }).clone = () => {
    track.cloned += 1;
    return track;
  };
  return track;
}

function build(over: Partial<FallbackDeps> = {}) {
  const clock = new FakeClock();
  const src = manualSource();
  const track = fakeTrack();
  const posts: { meetingId: string; body: PostMeetingSegmentsRequest }[] = [];
  const uploads: { meetingId: string; query: Record<string, unknown>; wav: Blob }[] = [];
  const mic = vi.fn(async () => track);
  const deps: FallbackDeps = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    postSegments: async (meetingId, body) => void posts.push({ meetingId, body }),
    // the server's clock runs 3 s ahead of this device's
    heartbeat: async () => ({ ok: true, serverNow: new Date(clock.now + 3000).toISOString() }),
    fetchMeeting: async () => summary([person(ME, 'Omar')], { startedAt: STARTED }),
    now: () => clock.now,
    openMic: mic,
    chooseRecognizer: async () => ({
      ok: true,
      recognizer: { transcribe: async () => ({ text: 'good morning everyone', language: 'en' }) },
    }),
    createSource: () => src.source,
    upload: async (meetingId, query, wav) => {
      uploads.push({ meetingId, query: { ...query }, wav });
      return { text: 'heard', stored: true };
    },
    ...over,
  };
  const statuses: StreamStatus[] = [];
  const onStatus = (s: StreamStatus): void => void statuses.push(s);
  return { clock, src, track, posts, uploads, mic, deps, statuses, onStatus };
}

describe('the on-device engine', () => {
  it('sends the person\'s final lines to the room, with times on the meeting clock', async () => {
    const h = build();
    const engine = createLiveEngine(h.deps);
    engine.start({ meetingId: MEETING, track: h.track, onStatus: h.onStatus });
    await h.clock.advance(0);
    expect(h.track.cloned).toBe(1); // the room's track is cloned, never used or stopped itself
    expect(h.mic).not.toHaveBeenCalled();
    expect(h.statuses).toContainEqual({ kind: 'listening' });
    // 1.2 s of speech then quiet: a partial job, then the final chunk
    h.src.feed(cat(talk(1200), hush(900)));
    await h.clock.advance(1000);
    await h.clock.advance(1000);
    const sent = h.posts.flatMap((p) => p.body.segments);
    const final = sent.find((s) => s.final);
    expect(final).toBeDefined();
    expect(final!.text).toBe('good morning everyone');
    // the device clock reads NOW, the room started 60 s before the server's NOW, the server is 3 s ahead: the line ends about 63 s in
    expect(final!.endMs).toBeGreaterThan(62_000);
    expect(final!.endMs).toBeLessThan(64_500);
    expect(final!.startMs).toBeLessThan(final!.endMs);
    expect(h.posts.every((p) => p.meetingId === MEETING)).toBe(true);
    engine.stop();
    await settle();
    expect(h.track.stopped).toBe(1);
  });

  it('opens the microphone itself when the controller gives no track, with the chosen input', async () => {
    const h = build();
    createLiveEngine(h.deps).start({ meetingId: MEETING, inputId: 'usb-1', startedAt: STARTED });
    await h.clock.advance(0);
    expect(h.mic).toHaveBeenCalledWith('usb-1');
  });

  it('says the device is too slow, and opens no microphone, when the device check fails', async () => {
    const h = build({ chooseRecognizer: async () => ({ ok: false, reason: 'This device is too slow to write out voice messages.', tooWeak: true }) });
    createLiveEngine(h.deps).start({ meetingId: MEETING, track: h.track, onStatus: h.onStatus });
    await h.clock.advance(0);
    expect(h.statuses).toEqual([{ kind: 'too_slow', message: TOO_SLOW_MESSAGE }]);
    expect(TOO_SLOW_MESSAGE).toBe('This device is too slow to transcribe. Ask your admin about server transcription, or join without it.');
    expect(h.track.cloned).toBe(0);
    expect(h.mic).not.toHaveBeenCalled();
  });

  it('says why when the browser cannot do it at all', async () => {
    const h = build({ chooseRecognizer: async () => ({ ok: false, reason: "This browser can't write out voice messages.", tooWeak: false }) });
    createLiveEngine(h.deps).start({ meetingId: MEETING, track: h.track, onStatus: h.onStatus });
    await h.clock.advance(0);
    expect(h.statuses).toEqual([{ kind: 'failed', message: "This browser can't write out voice messages." }]);
  });

  it('says so when the microphone cannot be opened', async () => {
    const h = build({
      openMic: async () => {
        throw new Error('NotAllowedError');
      },
    });
    createLiveEngine(h.deps).start({ meetingId: MEETING, startedAt: STARTED, onStatus: h.onStatus });
    await h.clock.advance(0);
    expect(h.statuses).toEqual([{ kind: 'failed', message: "Couldn't open your microphone for transcription." }]);
  });

  it('lets go of the microphone when stop comes before the engine is up', async () => {
    const h = build();
    const engine = createLiveEngine(h.deps);
    engine.start({ meetingId: MEETING, track: h.track, onStatus: h.onStatus });
    engine.stop(); // before anything has resolved
    await h.clock.advance(0);
    await h.clock.advance(0);
    expect(h.track.stopped).toBe(h.track.cloned);
    expect(h.src.stops.n).toBe(0); // it never started listening
    expect(h.statuses.filter((s) => s.kind === 'listening')).toHaveLength(0);
  });

  it('does nothing without a room, and starting twice does not listen twice', async () => {
    const h = build();
    const engine = createLiveEngine(h.deps);
    engine.start();
    await h.clock.advance(0);
    expect(h.track.cloned).toBe(0);
    engine.start({ meetingId: MEETING, track: h.track });
    engine.start({ meetingId: MEETING, track: h.track });
    await h.clock.advance(0);
    expect(h.track.cloned).toBe(1);
  });

  it('keeps nothing of a muted microphone', async () => {
    const h = build();
    const engine = createLiveEngine(h.deps);
    engine.setMuted?.(true);
    engine.start({ meetingId: MEETING, track: h.track });
    await h.clock.advance(0);
    h.src.feed(cat(talk(1200), hush(900)));
    await h.clock.advance(3000);
    expect(h.posts).toHaveLength(0);
  });
});

describe('the test engine', () => {
  it('sends a final line only when the page says some words', async () => {
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '1');
    const h = build();
    expect(sayToEngine('nobody is listening yet')).toBe(false);
    const engine = createFakeLiveEngine(h.deps);
    engine.start({ meetingId: MEETING, startedAt: STARTED, onStatus: h.onStatus });
    await h.clock.advance(0);
    expect(h.statuses).toContainEqual({ kind: 'listening' });
    expect(h.mic).not.toHaveBeenCalled();
    await h.clock.advance(5000);
    expect(h.posts).toHaveLength(0); // it hears nothing by itself
    expect(sayToEngine('The release is on Friday.')).toBe(true);
    expect(sayToEngine('and Tuesday', { partial: true })).toBe(true);
    await h.clock.advance(300);
    const sent = h.posts.flatMap((p) => p.body.segments);
    expect(sent.map((s) => [s.text, s.final])).toEqual([
      ['The release is on Friday.', true],
      ['and Tuesday', false],
    ]);
    engine.stop();
    await settle();
    expect(sayToEngine('too late')).toBe(false);
  });

  it('is what loadEngine gives in the test build, and the on-device offer is on', async () => {
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '1');
    expect(engineAvailable()).toBe(true);
    expect(await loadEngine()).not.toBeNull();
    expect(await loadEngine('server')).not.toBeNull();
  });

  it('is not offered in a build without it when the browser has no worker', async () => {
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '');
    // this test runs in Node, which has no Worker or AudioContext
    expect(engineAvailable()).toBe(false);
    expect(await loadEngine()).toBeNull();
  });
});

describe('the server fallback', () => {
  it('uploads each chunk of the person\'s own microphone as a 16 kHz mono WAV, with its times and a unique id', async () => {
    const h = build();
    const engine = createFallbackEngine(h.deps);
    engine.start({ meetingId: MEETING, track: h.track, onStatus: h.onStatus });
    await h.clock.advance(0);
    expect(h.statuses).toContainEqual({ kind: 'listening' });
    h.src.feed(cat(talk(1500), hush(900), talk(800), hush(900)));
    await h.clock.advance(0);
    await h.clock.advance(UPLOAD_GAP_MS + 100);
    expect(h.uploads).toHaveLength(2);
    const [a, b] = h.uploads;
    expect(a!.meetingId).toBe(MEETING);
    expect(a!.query['clientSegId']).not.toBe(b!.query['clientSegId']);
    expect(String(a!.query['clientSegId'])).toMatch(/^[A-Za-z0-9_.:-]+$/);
    expect(a!.query['durationMs']).toBeGreaterThan(1400);
    expect(a!.query['durationMs']).toBeLessThanOrEqual(30_000);
    expect(b!.query['startMs'] as number).toBeGreaterThan((a!.query['startMs'] as number) + 1400);
    expect(a!.query['startMs'] as number).toBeGreaterThan(58_000); // meeting clock: the room started a minute ago, and this audio ended about 63 s in
    const bytes = new Uint8Array(await a!.wav.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(16_000);
    expect(a!.wav.type).toBe('audio/wav');
    // nothing but audio goes through this route: no lines are posted from here
    expect(h.posts).toHaveLength(0);
    engine.stop();
    await settle();
    expect(h.track.stopped).toBe(1);
  });

  it('waits for the server to say when to come back after "slow down", then sends the same chunk', async () => {
    let calls = 0;
    const h = build({
      upload: async (meetingId, query, wav) => {
        calls += 1;
        if (calls === 1) throw new UploadError({ code: 'rate_limited', status: 429, message: 'slow down' }, 7000);
        h.uploads.push({ meetingId, query: { ...query }, wav });
        return { text: 'ok', stored: true };
      },
    });
    createFallbackEngine(h.deps).start({ meetingId: MEETING, track: h.track });
    await h.clock.advance(0);
    h.src.feed(cat(talk(1000), hush(900)));
    await h.clock.advance(0);
    expect(calls).toBe(1);
    await h.clock.advance(6000);
    expect(calls).toBe(1);
    await h.clock.advance(1500);
    expect(calls).toBe(2);
    expect(h.uploads).toHaveLength(1);
  });

  it('stops for good, with the server\'s sentence, when the server will not take this person\'s audio', async () => {
    const h = build({
      upload: async () => {
        throw new ApiError({ code: 'forbidden', status: 403, message: 'This room is not set to server transcription.' });
      },
    });
    createFallbackEngine(h.deps).start({ meetingId: MEETING, track: h.track, onStatus: h.onStatus });
    await h.clock.advance(0);
    h.src.feed(cat(talk(1000), hush(900)));
    await h.clock.advance(0);
    await h.clock.advance(100);
    expect(h.statuses).toContainEqual({ kind: 'failed', message: 'This room is not set to server transcription.' });
    expect(h.src.stops.n).toBeGreaterThanOrEqual(1);
    expect(h.track.stopped).toBe(1);
  });

  it('records nothing while muted', async () => {
    const h = build();
    const engine = createFallbackEngine(h.deps);
    engine.start({ meetingId: MEETING, track: h.track });
    await h.clock.advance(0);
    engine.setMuted?.(true);
    h.src.feed(cat(talk(1500), hush(900)));
    await h.clock.advance(1000);
    expect(h.uploads).toHaveLength(0);
  });

  it('sends the last chunk when the person leaves', async () => {
    const h = build();
    const engine = createFallbackEngine(h.deps);
    engine.start({ meetingId: MEETING, track: h.track });
    await h.clock.advance(0);
    h.src.feed(talk(1500)); // still talking
    expect(h.uploads).toHaveLength(0);
    engine.stop();
    await h.clock.advance(0);
    await h.clock.advance(100);
    expect(h.uploads).toHaveLength(1);
    expect(h.track.stopped).toBe(1);
  });

  it('in the test build, "said" words go up as a WAV that carries them for the fake server', async () => {
    vi.stubEnv('VITE_MANYTHREADS_FAKE_ASR', '1');
    const h = build();
    createFallbackEngine(h.deps).start({ meetingId: MEETING, startedAt: STARTED });
    await h.clock.advance(0);
    expect(h.mic).not.toHaveBeenCalled();
    expect(sayToEngine('Ship it on Friday.')).toBe(true);
    await h.clock.advance(100);
    expect(h.uploads).toHaveLength(1);
    const text = new TextDecoder().decode(new Uint8Array(await h.uploads[0]!.wav.arrayBuffer()).subarray(44));
    expect(text).toContain('FAKEASR:Ship it on Friday.');
    expect(h.uploads[0]!.query['durationMs']).toBe(1500);
  });
});

// keep the unused fixture imports honest
void id;
void ({} as EngineDeps);
