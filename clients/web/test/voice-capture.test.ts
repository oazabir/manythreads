import { describe, expect, it } from 'vitest';
import { Capture, type CaptureDeps, type RecorderLike, type StreamLike, type TrackLike } from '../src/channels/voice/capture';
import { ALLOWED_TEXT, BLOCKED_TEXT, LOST_TEXT, TOO_SHORT_TEXT } from '../src/channels/voice/support';

/** A microphone, a recorder and a clock that the test drives by hand. */
function rig(opts: { deny?: boolean; level?: number } = {}) {
  let clock = 0;
  let tick: (() => void) | null = null;
  const track: TrackLike & { stopped: boolean } = { stopped: false, onended: null, stop() { this.stopped = true; } };
  const stream: StreamLike = { getTracks: () => [track] };
  const urls: string[] = [];
  const revoked: string[] = [];
  let release: ((s: StreamLike) => void) | null = null;
  const recorder: RecorderLike & { started: boolean } = {
    started: false,
    state: 'inactive',
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start() {
      this.state = 'recording';
      this.started = true;
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
    makeUrl: () => {
      const u = `blob:clip-${urls.length}`;
      urls.push(u);
      return u;
    },
    revokeUrl: (u) => void revoked.push(u),
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
  return { cap, track, recorder, urls, revoked, answer, advance, running: () => tick !== null };
}

describe('voice capture', () => {
  it('asks for the microphone, records, and keeps a clip for the preview', async () => {
    const r = rig();
    const started = r.cap.start();
    expect(r.cap.state.phase).toBe('asking');
    await r.answer();
    await started;
    expect(r.cap.state.phase).toBe('recording');
    expect(r.cap.announcement).toBe('Recording');
    r.advance(1_000);
    r.advance(1_500);
    expect(r.cap.meter.get()).toEqual({ elapsedMs: 2_500, level: 0.5 });
    r.cap.stop();
    expect(r.cap.state.phase).toBe('preview');
    if (r.cap.state.phase !== 'preview') return;
    expect(r.cap.state.clip.mime).toBe('audio/webm');
    expect(r.cap.state.clip.durationMs).toBe(2_500);
    expect(r.cap.state.clip.limited).toBe(false);
    expect(r.cap.state.clip.peaks).toEqual([255, 255]);
    expect(r.cap.announcement).toBe('Recording stopped, 0:02');
    expect(r.track.stopped).toBe(true);
    expect(r.running()).toBe(false);
  });

  it('says how to allow the microphone when the browser refuses', async () => {
    const r = rig({ deny: true });
    await r.cap.start();
    expect(r.cap.state).toEqual({ phase: 'error', message: BLOCKED_TEXT });
    r.cap.discard();
    expect(r.cap.state.phase).toBe('idle');
  });

  it('cancel keeps nothing and lets the microphone go', async () => {
    const r = rig();
    const started = r.cap.start();
    await r.answer();
    await started;
    r.advance(3_000);
    r.cap.cancel();
    expect(r.cap.state.phase).toBe('idle');
    expect(r.cap.announcement).toBe('Recording cancelled');
    expect(r.track.stopped).toBe(true);
    expect(r.urls).toEqual([]);
  });

  it('a recording under half a second is refused with a plain sentence', async () => {
    const r = rig();
    const started = r.cap.start();
    await r.answer();
    await started;
    r.advance(200);
    r.cap.stop();
    expect(r.cap.state).toEqual({ phase: 'error', message: TOO_SHORT_TEXT });
  });

  it('stops by itself at five minutes and says so', async () => {
    const r = rig();
    const started = r.cap.start();
    await r.answer();
    await started;
    r.advance(240_000);
    expect(r.cap.announcement).toBe('One minute left');
    r.advance(40_000);
    expect(r.cap.announcement).toBe('30 seconds left');
    r.advance(60_000);
    expect(r.cap.state.phase).toBe('preview');
    if (r.cap.state.phase !== 'preview') return;
    expect(r.cap.state.clip.durationMs).toBe(300_000);
    expect(r.cap.state.clip.limited).toBe(true);
    expect(r.cap.announcement).toContain('limit');
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

  it('discard frees the clip, and a second recording can start', async () => {
    const r = rig();
    let started = r.cap.start();
    await r.answer();
    await started;
    r.advance(2_000);
    r.cap.stop();
    expect(r.urls).toHaveLength(1);
    r.cap.discard('Voice message discarded');
    expect(r.revoked).toEqual(['blob:clip-0']);
    expect(r.cap.state.phase).toBe('idle');
    started = r.cap.start();
    await r.answer();
    await started;
    expect(r.cap.state.phase).toBe('recording');
  });

  it('a lost microphone keeps what was recorded, or says it was lost when nothing was', async () => {
    const r = rig();
    const started = r.cap.start();
    await r.answer();
    await started;
    r.track.onended?.();
    expect(r.cap.state).toEqual({ phase: 'error', message: LOST_TEXT });
  });

  it('reset drops a recording and a waiting clip without a word', async () => {
    const r = rig();
    const started = r.cap.start();
    await r.answer();
    await started;
    r.advance(2_000);
    r.cap.reset();
    expect(r.cap.state.phase).toBe('idle');
    expect(r.track.stopped).toBe(true);
    expect(r.urls).toEqual([]);
  });
});
