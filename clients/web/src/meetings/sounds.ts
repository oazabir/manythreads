/*
 * Join, leave and ring sounds (PLAN P15-04): short tones made with the browser's audio API, no sound files. `toneSequence` is the plain part (which notes, when);
 * `createSounds` plays them through a context it is given, so a test hears nothing and sees what was asked. A browser keeps audio silent until the person has
 * touched the page: a sound that cannot start yet is dropped, never queued.
 */

export type Sound = 'join' | 'leave' | 'ring' | 'mute' | 'unmute';
export type Tone = { hz: number; at: number; length: number; gain: number };

/** Seconds from the start of the sound. */
export function toneSequence(kind: Sound): Tone[] {
  switch (kind) {
    case 'join':
      return [
        { hz: 523, at: 0, length: 0.11, gain: 0.08 },
        { hz: 784, at: 0.11, length: 0.16, gain: 0.08 },
      ];
    case 'leave':
      return [
        { hz: 784, at: 0, length: 0.11, gain: 0.07 },
        { hz: 523, at: 0.11, length: 0.16, gain: 0.07 },
      ];
    case 'mute':
      return [{ hz: 440, at: 0, length: 0.07, gain: 0.05 }];
    case 'unmute':
      return [{ hz: 660, at: 0, length: 0.07, gain: 0.05 }];
    case 'ring':
      // two short double-beeps; the page repeats the whole thing about every 2 seconds while it rings
      return [
        { hz: 660, at: 0, length: 0.18, gain: 0.1 },
        { hz: 880, at: 0.22, length: 0.18, gain: 0.1 },
        { hz: 660, at: 0.7, length: 0.18, gain: 0.1 },
        { hz: 880, at: 0.92, length: 0.18, gain: 0.1 },
      ];
  }
}

export const RING_REPEAT_MS = 2_400;

/** The part of the browser's audio context the sounds use, so a test can stand in. */
export type AudioContextLike = {
  currentTime: number;
  state: string;
  destination: unknown;
  resume(): Promise<void>;
  createOscillator(): { type: string; frequency: { value: number }; connect(n: unknown): void; start(at: number): void; stop(at: number): void };
  createGain(): { gain: { value: number; setValueAtTime(v: number, at: number): void; linearRampToValueAtTime(v: number, at: number): void }; connect(n: unknown): void };
};

export type SoundsDeps = {
  /** The context, made on first use; null when the browser has none. */
  context: () => AudioContextLike | null;
  /** Whether the person wants sounds (their setting). */
  enabled: () => boolean;
};

export type Sounds = {
  play(kind: Sound): void;
  /** Rings until `stopRing`. */
  startRing(): void;
  stopRing(): void;
};

export function createSounds(deps: SoundsDeps, timers: { setInterval: (f: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void } = { setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (h) => globalThis.clearInterval(h as number) }): Sounds {
  let ringing: unknown = null;
  const play = (kind: Sound): void => {
    if (!deps.enabled()) return;
    const ctx = deps.context();
    if (!ctx) return;
    // blocked until the person has used the page: say nothing rather than play late
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    if (ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    for (const tone of toneSequence(kind)) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.hz;
      g.gain.setValueAtTime(0, t0 + tone.at);
      g.gain.linearRampToValueAtTime(tone.gain, t0 + tone.at + 0.01);
      g.gain.linearRampToValueAtTime(0, t0 + tone.at + tone.length);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t0 + tone.at);
      osc.stop(t0 + tone.at + tone.length + 0.02);
    }
  };
  return {
    play,
    startRing() {
      if (ringing !== null) return;
      play('ring');
      ringing = timers.setInterval(() => play('ring'), RING_REPEAT_MS);
    },
    stopRing() {
      if (ringing === null) return;
      timers.clearInterval(ringing);
      ringing = null;
    },
  };
}

/** One audio context for the page, made when first needed. */
let shared: AudioContextLike | null | undefined;
export function browserAudioContext(): AudioContextLike | null {
  if (shared !== undefined) return shared;
  try {
    const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext ?? (globalThis as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
    shared = Ctor ? new Ctor() : null;
  } catch {
    shared = null;
  }
  return shared;
}
