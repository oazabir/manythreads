import { describe, expect, it } from 'vitest';
import { Capture, TAIL_BARS, type CaptureDeps, type RecorderLike, type StreamLike, type TrackLike } from '../src/channels/voice/capture';
import { ALLOWED_TEXT, BLOCKED_TEXT, LOST_TEXT, TOO_SHORT_TEXT } from '../src/channels/voice/support';

/** A microphone, a recorder and a clock that the test drives by hand. */
function rig(opts: { deny?: boolean; level?: number } = {}) {
  let clock = 0;
  let tick: (() => void) | null = null;
  const track: TrackLike & { stopped: boolean } = { stopped: false, onended: null, stop() { this.stopped = true; } };
  const stream: StreamLike = { getTracks: () => [track] };
  let release: ((s: StreamLike) => void) | null = null;
  const recorder: RecorderLike & { started: boolean; paused: number; resumed: number } = {
    started: false,
    state: 'inactive',
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    paused: 0,
    resumed: 0,
    start() {
      this.state = 'recording';
      this.started = true;
    },
    pause() {
      this.state = 'paused';
      this.paused += 1;
    },
    resume() {
      this.state = 'recording';
      this.resumed += 1;
    },
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(40)]) });
      this.onstop?.();
    },
  };
  const deps: CaptureDeps = {
    openMic: () =>
      opts.deny
        ? Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
        : new Promise((res) => {
            release = res;
          }),
    makeRecorder: () => recorder,
    makeLevelReader: () => ({ read: () => opts.level ?? 0.5, close: () => undefined }),
    pickMime: () => 'audio/webm;codecs=opus',
    now: () => clock,
    every: (fn) => {
      tick = fn;
      return () => {
        tick = null;
      };
    },
  };
  const cap = new Capture(deps);
  const answer = async (): Promise<void> => {
    release?.(stream);
    await Promise.resolve();
    await Promise.resolve();
  };
  const advance = (ms: number): void => {
    clock += ms;
    tick?.();
  };
  return { cap, track, recorder, answer, advance, running: () => tick !== null };
}

/** Starts a recording on the rig and waits for the recording state. */
async function recording(opts: Parameters<typeof rig>[0] = {}) {
  const r = rig(opts);
  const started = r.cap.start();
  await r.answer();
  await started;
  return r;
}

describe('voice capture', () => {
  it('lets go of the microphone and the level reader when starting the recorder fails', async () => {
    const r = rig();
    let closed = 0;
    const deps = (r.cap as unknown as { deps: CaptureDeps }).deps;
    deps.makeLevelReader = () => ({ read: () => 0, close: () => void (closed += 1) });
    r.recorder.start = () => {
      throw new Error('cannot start');
    };
    const started = r.cap.start();
    await r.answer();
    await started;
    expect(r.cap.state.phase).toBe('error');
    expect(r.track.stopped).toBe(true);
    expect(closed).toBe(1);
  });

  it('asks for the microphone, records, and hands the clip over with take()', async () => {
    const r = rig();
    const started = r.cap.start();
    expect(r.cap.state.phase).toBe('asking');
    await r.answer();
    await started;
    expect(r.cap.state).toEqual({ phase: 'recording', paused: false, limited: false, lost: false });
    expect(r.cap.announcement).toBe('Recording');
    r.advance(1_000);
    r.advance(1_500);
    expect(r.cap.meter.get()).toMatchObject({ elapsedMs: 2_500, level: 0.5, total: 2, tail: [0.5, 0.5] });
    const clip = await r.cap.take();
    expect(clip).not.toBeNull();
    expect(clip?.mime).toBe('audio/webm');
    expect(clip?.durationMs).toBe(2_500);
    expect(clip?.limited).toBe(false);
    expect(clip?.peaks).toEqual([255, 255]);
    // there is no preview: the recorder is idle again at once, the microphone is let go
    expect(r.cap.state.phase).toBe('idle');
    expect(r.cap.announcement).toBe('Sending the voice message');
    expect(r.track.stopped).toBe(true);
    expect(r.running()).toBe(false);
  });

  it('pauses and resumes: paused time is not counted and nothing is read while paused', async () => {
    const r = await recording();
    r.advance(2_000);
    r.cap.pause();
    expect(r.cap.state).toEqual({ phase: 'recording', paused: true, limited: false, lost: false });
    expect(r.recorder.paused).toBe(1);
    expect(r.cap.announcement).toBe('Recording paused, 0:02');
    expect(r.running()).toBe(false);
    // time passes while paused: the clock stands still and the meter takes no reading
    r.advance(30_000);
    expect(r.cap.meter.get()).toMatchObject({ elapsedMs: 2_000, level: 0, total: 1 });
    r.cap.resume();
    expect(r.cap.state).toEqual({ phase: 'recording', paused: false, limited: false, lost: false });
    expect(r.recorder.resumed).toBe(1);
    expect(r.cap.announcement).toBe('Recording resumed');
    r.advance(1_000);
    expect(r.cap.meter.get().elapsedMs).toBe(3_000);
    const clip = await r.cap.take();
    expect(clip?.durationMs).toBe(3_000);
  });

  it('keeps pause and resume to what makes sense', async () => {
    const r = await recording();
    r.cap.resume(); // not paused: nothing happens
    expect(r.recorder.resumed).toBe(0);
    r.advance(1_000);
    r.cap.pause();
    r.cap.pause(); // twice is once
    expect(r.recorder.paused).toBe(1);
    const idle = new Capture((r.cap as unknown as { deps: CaptureDeps }).deps);
    idle.pause();
    idle.resume();
    expect(idle.state.phase).toBe('idle');
  });

  it('Send works while paused, and the paused stretch is not in the clip length', async () => {
    const r = await recording();
    r.advance(1_000);
    r.advance(1_000);
    r.cap.pause();
    r.advance(60_000);
    const clip = await r.cap.take();
    expect(clip?.durationMs).toBe(2_000);
    expect(r.recorder.state).toBe('inactive');
    expect(r.track.stopped).toBe(true);
  });

  it('keeps the newest readings for the live waveform, at most TAIL_BARS', async () => {
    const r = await recording();
    for (let i = 0; i < TAIL_BARS + 10; i++) r.advance(80);
    const m = r.cap.meter.get();
    expect(m.tail).toHaveLength(TAIL_BARS);
    expect(m.total).toBe(TAIL_BARS + 10);
  });

  it('says how to allow the microphone when the browser refuses', async () => {
    const r = rig({ deny: true });
    await r.cap.start();
    expect(r.cap.state).toEqual({ phase: 'error', message: BLOCKED_TEXT });
    r.cap.discard();
    expect(r.cap.state.phase).toBe('idle');
  });

  it('cancel (the trash button, Esc) keeps nothing, lets the microphone go and settles take() with null', async () => {
    const r = await recording();
    r.advance(3_000);
    r.cap.cancel();
    expect(r.cap.state.phase).toBe('idle');
    expect(r.cap.announcement).toBe('Recording deleted');
    expect(r.track.stopped).toBe(true);
    expect(await r.cap.take()).toBeNull();
  });

  it('cancel works while paused too', async () => {
    const r = await recording();
    r.advance(3_000);
    r.cap.pause();
    r.cap.cancel();
    expect(r.cap.state.phase).toBe('idle');
    expect(r.track.stopped).toBe(true);
  });

  it('a recording under half a second is refused with a plain sentence, and take() gives null', async () => {
    const r = await recording();
    r.advance(200);
    expect(await r.cap.take()).toBeNull();
    expect(r.cap.state).toEqual({ phase: 'error', message: TOO_SHORT_TEXT });
  });

  it('at five minutes the recording pauses by itself and waits for Send or Delete', async () => {
    const r = await recording();
    r.advance(240_000);
    expect(r.cap.announcement).toBe('One minute left');
    r.advance(40_000);
    expect(r.cap.announcement).toBe('30 seconds left');
    r.advance(60_000);
    expect(r.cap.state).toEqual({ phase: 'recording', paused: true, limited: true, lost: false });
    expect(r.cap.announcement).toBe('Recording stopped at the limit, 5:00');
    expect(r.recorder.paused).toBe(1);
    expect(r.running()).toBe(false);
    // it cannot be resumed past the limit
    r.cap.resume();
    expect(r.cap.state).toMatchObject({ paused: true, limited: true });
    expect(r.recorder.resumed).toBe(0);
    const clip = await r.cap.take();
    expect(clip?.durationMs).toBe(300_000);
    expect(clip?.limited).toBe(true);
  });

  it('a press released before the answer comes records nothing and frees the microphone', async () => {
    const r = rig();
    const started = r.cap.start();
    r.cap.releaseWhileAsking();
    expect(r.cap.state).toEqual({ phase: 'error', message: ALLOWED_TEXT });
    await r.answer();
    await started;
    expect(r.recorder.started).toBe(false);
    expect(r.track.stopped).toBe(true);
    expect(r.cap.state.phase).toBe('error');
  });

  it('cancel while asking is ignored when the answer comes', async () => {
    const r = rig();
    const started = r.cap.start();
    r.cap.cancel();
    await r.answer();
    await started;
    expect(r.cap.state.phase).toBe('idle');
    expect(r.recorder.started).toBe(false);
  });

  it('a second recording can start after the first one was sent', async () => {
    const r = await recording();
    r.advance(2_000);
    await r.cap.take();
    const started = r.cap.start();
    await r.answer();
    await started;
    expect(r.cap.state.phase).toBe('recording');
  });

  it('a lost microphone with too little recorded says so', async () => {
    const r = await recording();
    r.track.onended?.();
    expect(r.cap.state).toEqual({ phase: 'error', message: LOST_TEXT });
  });

  it('a lost microphone keeps what was recorded: it waits for Send or Delete and cannot be resumed', async () => {
    const r = await recording();
    r.advance(2_000);
    r.track.onended?.();
    expect(r.cap.state).toEqual({ phase: 'recording', paused: true, limited: false, lost: true });
    expect(r.cap.announcement).toContain('can still be sent');
    r.cap.resume();
    expect(r.cap.state).toMatchObject({ lost: true, paused: true });
    const clip = await r.cap.take();
    expect(clip?.durationMs).toBe(2_000);
    expect(r.cap.state.phase).toBe('idle');
  });

  it('reset drops a recording without a word', async () => {
    const r = await recording();
    r.advance(2_000);
    r.cap.reset();
    expect(r.cap.state.phase).toBe('idle');
    expect(r.track.stopped).toBe(true);
  });

  it('dispose lets go of everything and settles a waiting take()', async () => {
    const r = await recording();
    r.advance(2_000);
    r.cap.dispose();
    expect(r.track.stopped).toBe(true);
    expect(r.recorder.state).toBe('inactive');
    expect(r.cap.state.phase).toBe('idle');
  });

  /** Makes the recorder stop the way a browser does: `stop` answers at once, the `stop` event comes later. */
  function slowStop(r: Awaited<ReturnType<typeof recording>>): () => void {
    let finish: () => void = () => undefined;
    r.recorder.stop = function stop() {
      r.recorder.state = 'inactive';
      finish = () => {
        r.recorder.ondataavailable?.({ data: new Blob([new Uint8Array(40)]) });
        r.recorder.onstop?.();
      };
    };
    return () => finish();
  }

  it('a second take() while the first is closing gives the same answer, and the clip is not cut short', async () => {
    const r = await recording();
    r.advance(2_000);
    const stop = slowStop(r);
    const first = r.cap.take();
    expect(r.cap.isEnding).toBe(true);
    r.advance(0);
    const second = r.cap.take();
    expect(second).toBe(first);
    stop();
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(a?.durationMs).toBe(2_000);
    expect(r.cap.isEnding).toBe(false);
    expect(r.cap.state.phase).toBe('idle');
  });

  it('cancel() after take() changes nothing, and take() after cancel() does nothing', async () => {
    const r = await recording();
    r.advance(2_000);
    let stop = slowStop(r);
    const sent = r.cap.take();
    r.cap.cancel();
    stop();
    expect((await sent)?.durationMs).toBe(2_000);

    const again = await recording();
    again.advance(2_000);
    stop = slowStop(again);
    again.cap.cancel();
    expect(again.cap.isEnding).toBe(true);
    const late = again.cap.take();
    stop();
    expect(await late).toBeNull();
    expect(again.cap.state.phase).toBe('idle');
    expect(again.cap.announcement).toBe('Recording deleted');
  });

  it('a recorder that cannot pause: canPause is false, and nothing changes when pause is asked', async () => {
    const r = await recording();
    expect(r.cap.canPause).toBe(true);
    (r.recorder as unknown as { pause?: unknown }).pause = undefined;
    expect(r.cap.canPause).toBe(false);
    r.cap.pause();
    expect(r.cap.state).toEqual({ phase: 'recording', paused: false, limited: false, lost: false });
    expect(r.running()).toBe(true);
    expect(r.cap.announcement).toContain('Could not pause');
  });

  it('a pause that throws keeps the recording going and says so; a resume that throws keeps it paused and says so', async () => {
    const r = await recording();
    r.advance(1_000);
    const pause = r.recorder.pause;
    r.recorder.pause = () => {
      throw new Error('InvalidStateError');
    };
    r.cap.pause();
    expect(r.cap.state).toEqual({ phase: 'recording', paused: false, limited: false, lost: false });
    expect(r.running()).toBe(true);
    expect(r.cap.announcement).toBe('Could not pause the recording. It is still recording.');
    r.recorder.pause = pause;
    r.cap.pause();
    expect(r.cap.state).toMatchObject({ paused: true });
    r.recorder.resume = () => {
      throw new Error('InvalidStateError');
    };
    r.cap.resume();
    expect(r.cap.state).toMatchObject({ paused: true });
    expect(r.running()).toBe(false);
    expect(r.cap.announcement).toBe('Could not resume the recording. It is still paused.');
  });

  it('dispose clears what was collected', async () => {
    const r = await recording();
    r.advance(2_000);
    r.cap.dispose();
    const held = r.cap as unknown as { chunks: unknown[]; readings: unknown[]; tail: unknown[] };
    expect([held.chunks.length, held.readings.length, held.tail.length]).toEqual([0, 0, 0]);
  });
});
