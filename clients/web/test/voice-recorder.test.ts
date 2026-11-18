// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureDeps, RecordedClip, RecorderLike, StreamLike, TrackLike } from '../src/channels/voice/capture';
import { Recorder, RecorderNotice } from '../src/channels/voice/Recorder';
import { useRecorder } from '../src/channels/voice/useRecorder';
import { TOO_SHORT_TEXT } from '../src/channels/voice/support';

// P32-05: the recording bar. A fake microphone, recorder and clock stand behind the real hook, so the bar is the one the composer draws.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let clock = 0;
let tick: (() => void) | null = null;
let track: TrackLike & { stopped: boolean };
let recorder: RecorderLike & { paused: number; resumed: number };
const sent: RecordedClip[] = [];
const focused = vi.fn();

function makeDeps(): CaptureDeps {
  track = { stopped: false, onended: null, stop() { this.stopped = true; } };
  const stream: StreamLike = { getTracks: () => [track] };
  recorder = {
    state: 'inactive',
    mimeType: 'audio/webm;codecs=opus',
    ondataavailable: null,
    onstop: null,
    onerror: null,
    paused: 0,
    resumed: 0,
    start() { this.state = 'recording'; },
    pause() { this.state = 'paused'; this.paused += 1; },
    resume() { this.state = 'recording'; this.resumed += 1; },
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(40)]) });
      this.onstop?.();
    },
  };
  return {
    openMic: () => Promise.resolve(stream),
    makeRecorder: () => recorder,
    makeLevelReader: () => ({ read: () => 0.5, close: () => undefined }),
    pickMime: () => 'audio/webm;codecs=opus',
    now: () => clock,
    every: (fn) => {
      tick = fn;
      return () => { tick = null; };
    },
  };
}

function Harness({ deps }: { deps: CaptureDeps }) {
  const rec = useRecorder(deps);
  return createElement('div', null, createElement(RecorderNotice, { rec }), createElement(Recorder, { rec, showMic: true, onSendClip: (c: RecordedClip) => sent.push(c), returnFocus: focused }));
}

const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  return el;
};
const press = (el: Element, type: string, x = 100): void => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 }));
const advance = async (ms: number): Promise<void> => {
  await act(async () => {
    clock += ms;
    tick?.();
  });
};
/** A quick tap on the mic: the recording starts and goes on. */
async function tapStart(): Promise<void> {
  await act(async () => {
    press(must('voice-mic'), 'pointerdown');
  });
  await act(async () => {
    press(must('voice-mic'), 'pointerup');
  });
}

beforeEach(() => {
  clock = 0;
  tick = null;
  sent.length = 0;
  focused.mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness, { deps: makeDeps() }));
  });
}

describe('the recording bar', () => {
  it('replaces the mic with one bar: delete, a red dot and the time, the waveform, pause and send', async () => {
    await mount();
    expect(q('voice-recording')).toBeNull();
    await tapStart();
    const bar = must('voice-recording');
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('Recording a voice message');
    expect(bar.getAttribute('data-state')).toBe('recording');
    // the order, left to right
    const order = [...bar.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'));
    expect(order).toEqual(['voice-delete', 'voice-timer', 'voice-wave', 'voice-pause', 'voice-send']);
    expect(bar.querySelector('.vr-dot')).not.toBeNull();
    expect(must('voice-delete').getAttribute('aria-label')).toBe('Delete recording');
    expect(must('voice-pause').getAttribute('aria-label')).toBe('Pause recording');
    expect(must('voice-send').getAttribute('aria-label')).toBe('Send voice message');
    // the mic button is out of the way while the bar has its own controls, and the keyboard lands on Pause
    expect(must('voice-mic').hidden).toBe(true);
    expect(document.activeElement).toBe(must('voice-pause'));
    expect(must('voice-live').textContent).toBe('Recording');
    // the bar describes where the words come from
    expect(host.querySelector('#vr-about')?.textContent).toContain('transcript');
  });

  it('shows the time, and it grows with the recording', async () => {
    await mount();
    await tapStart();
    expect(must('voice-timer').textContent).toBe('0:00');
    await advance(2_000);
    await advance(5_000);
    expect(must('voice-timer').textContent).toBe('0:07');
    // the wave has bars, the newest at the right
    expect(must('voice-wave').children.length).toBeGreaterThan(100);
  });

  it('pauses and resumes: paused time is left out of the time, the dot goes grey and the button changes its name', async () => {
    await mount();
    await tapStart();
    await advance(3_000);
    await act(async () => must('voice-pause').click());
    expect(must('voice-recording').getAttribute('data-state')).toBe('paused');
    expect(recorder.paused).toBe(1);
    expect(must('voice-pause').getAttribute('aria-label')).toBe('Resume recording');
    expect(must('voice-live').textContent).toBe('Recording paused, 0:03');
    expect(must('voice-timer').textContent).toBe('0:03');
    await advance(60_000);
    expect(must('voice-timer').textContent).toBe('0:03');
    await act(async () => must('voice-pause').click());
    expect(must('voice-recording').getAttribute('data-state')).toBe('recording');
    expect(recorder.resumed).toBe(1);
    await advance(2_000);
    expect(must('voice-timer').textContent).toBe('0:05');
  });

  it('Send hands the clip over at once, with no preview, and puts the cursor back in the text box', async () => {
    await mount();
    await tapStart();
    await advance(4_000);
    await act(async () => must('voice-send').click());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.durationMs).toBe(4_000);
    expect(sent[0]?.mime).toBe('audio/webm');
    expect(q('voice-recording')).toBeNull();
    expect(q('voice-preview')).toBeNull();
    expect(focused).toHaveBeenCalled();
    expect(track.stopped).toBe(true);
    // the mic is back
    expect(must('voice-mic').hidden).toBe(false);
  });

  it('Send works while paused, and the clip leaves out the pause', async () => {
    await mount();
    await tapStart();
    await advance(2_000);
    await act(async () => must('voice-pause').click());
    await advance(40_000);
    await act(async () => must('voice-send').click());
    expect(sent.map((c) => c.durationMs)).toEqual([2_000]);
  });

  it('Delete throws the recording away: nothing is sent, the microphone is let go, the cursor goes back', async () => {
    await mount();
    await tapStart();
    await advance(3_000);
    await act(async () => must('voice-delete').click());
    expect(sent).toEqual([]);
    expect(q('voice-recording')).toBeNull();
    expect(track.stopped).toBe(true);
    expect(focused).toHaveBeenCalled();
    expect(must('voice-live').textContent).toBe('Recording deleted');
  });

  it('Esc deletes the recording and puts the cursor back in the text box; Esc inside a dialog does not', async () => {
    await mount();
    await tapStart();
    await advance(3_000);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const field = document.createElement('input');
    dialog.append(field);
    document.body.append(dialog);
    await act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(q('voice-recording')).not.toBeNull();
    dialog.remove();
    await act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(q('voice-recording')).toBeNull();
    expect(sent).toEqual([]);
    expect(focused).toHaveBeenCalled();
    expect(track.stopped).toBe(true);
  });

  it('a recording that is too short is not sent and says so', async () => {
    await mount();
    await tapStart();
    await advance(200);
    await act(async () => must('voice-send').click());
    expect(sent).toEqual([]);
    expect(must('voice-error').textContent).toContain(TOO_SHORT_TEXT);
  });

  it('at five minutes it pauses by itself, Resume is off, and Send or Delete are left', async () => {
    await mount();
    await tapStart();
    for (let i = 0; i < 5; i++) await advance(60_000);
    expect(must('voice-recording').getAttribute('data-state')).toBe('paused');
    expect(must('voice-timer').textContent).toBe('5:00');
    expect((must('voice-pause') as HTMLButtonElement).disabled).toBe(true);
    expect(must('voice-limit').textContent).toBe('Voice messages stop at 5 minutes.');
    await act(async () => must('voice-send').click());
    expect(sent[0]?.durationMs).toBe(300_000);
    expect(sent[0]?.limited).toBe(true);
  });

  it('under reduced motion the waveform does not scroll', async () => {
    (window as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined });
    await mount();
    await tapStart();
    await advance(1_000);
    expect(must('voice-wave').classList.contains('still')).toBe(true);
    expect(must('voice-wave').children).toHaveLength(48);
  });
});

describe('hold to record', () => {
  it('shows the hold bar while the finger is down, and releasing after a long press sends', async () => {
    await mount();
    await act(async () => {
      press(must('voice-mic'), 'pointerdown');
    });
    await advance(1_500);
    // the hold bar: no buttons of its own, the hint, the mic under the finger
    expect(must('voice-recording').classList.contains('holding')).toBe(true);
    expect(q('voice-delete')).toBeNull();
    expect(q('voice-send')).toBeNull();
    expect(must('voice-hint').textContent).toBe('Slide left to cancel');
    expect(must('voice-mic').hidden).toBe(false);
    await act(async () => {
      press(must('voice-mic'), 'pointerup');
    });
    expect(sent.map((c) => c.durationMs)).toEqual([1_500]);
    expect(q('voice-recording')).toBeNull();
  });

  it('sliding left past the limit cancels: the bar says release to cancel, and nothing is sent', async () => {
    await mount();
    await act(async () => {
      press(must('voice-mic'), 'pointerdown', 300);
    });
    await advance(1_500);
    await act(async () => {
      press(must('voice-mic'), 'pointermove', 150);
    });
    expect(must('voice-hint').textContent).toBe('Release to cancel');
    await act(async () => {
      press(must('voice-mic'), 'pointerup', 150);
    });
    expect(sent).toEqual([]);
    expect(q('voice-recording')).toBeNull();
    expect(track.stopped).toBe(true);
  });

  it('a short press is a tap: the recording goes on and the bar gets its own buttons', async () => {
    await mount();
    await tapStart();
    await advance(1_000);
    expect(must('voice-recording').classList.contains('holding')).toBe(false);
    expect(must('voice-send')).not.toBeNull();
    expect(sent).toEqual([]);
  });
});
