import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { fileContentUrl } from '../../api/endpoints';
import { clampPosition, nextSpeed } from './playerFormat';
import { clearPosition, loadPosition, loadSpeed, savePosition, saveSpeed } from './resume';

/*
 * Playing voice messages (P14-17). One audio element serves the whole page, so only one clip ever plays: starting another stops the first
 * (and keeps its place). The clip's bytes are fetched once, with the sign-in cookie, into a Blob and played from a blob URL, because a
 * browser recording has no length in its header and the download route has no byte ranges; the length therefore comes from the message
 * (`meta.voice.durationMs`), never from the element. The few latest clips stay in memory so a second press is instant.
 * A row that scrolls out of the list does not stop its clip: the store is outside React and the row finds it again when it comes back.
 */

export type PlayStatus = 'idle' | 'loading' | 'ready' | 'error';
export type PlayState = { fileId: string | null; status: PlayStatus; playing: boolean; positionMs: number; speed: number };

const KEEP_BLOBS = 3;

let state: PlayState = { fileId: null, status: 'idle', playing: false, positionMs: 0, speed: loadSpeed() };
const listeners = new Set<() => void>();
const blobs = new Map<string, string>(); // file id to blob URL, oldest first
let audio: HTMLAudioElement | null = null;
let durationMs = 0; // the length of the clip in the element, from the message
let token = 0; // bumped for every load, so a late answer for an earlier clip is ignored
let frame = 0;
let lastSaved = 0;

function set(patch: Partial<PlayState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = 'auto';
  a.preservesPitch = true;
  a.addEventListener('ended', () => {
    stopTicking();
    if (state.fileId) clearPosition(state.fileId);
    set({ playing: false, positionMs: 0 });
    a.currentTime = 0;
  });
  a.addEventListener('pause', () => {
    // the browser paused it (headphones pulled, another app took the sound)
    if (state.playing && !a.ended) {
      stopTicking();
      remember();
      set({ playing: false });
    }
  });
  a.addEventListener('error', () => {
    if (state.status === 'ready' || state.status === 'loading') {
      stopTicking();
      set({ status: 'error', playing: false });
    }
  });
  audio = a;
  return a;
}

function remember(): void {
  if (state.fileId && state.status === 'ready') savePosition(state.fileId, state.positionMs, durationMs);
}

function tick(): void {
  frame = requestAnimationFrame(tick);
  const a = audio;
  if (!a || !state.playing) return;
  const ms = clampPosition(a.currentTime * 1000, durationMs);
  if (ms !== state.positionMs) set({ positionMs: ms });
  const now = Date.now();
  if (now - lastSaved > 2_000) {
    lastSaved = now;
    remember();
  }
}
function startTicking(): void {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(tick);
}
function stopTicking(): void {
  cancelAnimationFrame(frame);
}

function keepBlob(fileId: string, url: string): void {
  blobs.delete(fileId);
  blobs.set(fileId, url);
  while (blobs.size > KEEP_BLOBS) {
    const [oldest, oldUrl] = blobs.entries().next().value as [string, string];
    if (oldest === state.fileId) break;
    blobs.delete(oldest);
    URL.revokeObjectURL(oldUrl);
  }
}

async function blobUrl(fileId: string): Promise<string> {
  const have = blobs.get(fileId);
  if (have) return have;
  const res = await fetch(fileContentUrl(fileId), { credentials: 'include' });
  if (!res.ok) throw new Error(`The clip could not be fetched (${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  keepBlob(fileId, url);
  return url;
}

/** A recording without a length reports `Infinity`; jumping far past the end makes the browser work the real length out, so seeking works. */
function settleLength(a: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(a.duration)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      a.removeEventListener('timeupdate', done);
      a.removeEventListener('durationchange', check);
      resolve();
    };
    const check = (): void => {
      if (Number.isFinite(a.duration)) done();
    };
    a.addEventListener('timeupdate', done);
    a.addEventListener('durationchange', check);
    a.currentTime = 1e7;
    setTimeout(done, 1_500);
  });
}

function pauseNow(): void {
  if (audio && state.playing) {
    state = { ...state, playing: false }; // before pause(), so the element's own pause event is not taken for the browser's
    audio.pause();
  }
  stopTicking();
  remember();
  set({ playing: false });
}

async function open(fileId: string, lengthMs: number, startMs: number): Promise<void> {
  if (state.fileId !== null && state.fileId !== fileId) pauseNow();
  const mine = ++token;
  durationMs = lengthMs;
  set({ fileId, status: 'loading', playing: false, positionMs: startMs });
  try {
    const url = await blobUrl(fileId);
    if (mine !== token) return;
    const a = element();
    a.src = url;
    await new Promise<void>((resolve, reject) => {
      const ok = (): void => (a.removeEventListener('error', bad), resolve());
      const bad = (): void => (a.removeEventListener('loadedmetadata', ok), reject(new Error('The clip could not be read.')));
      a.addEventListener('loadedmetadata', ok, { once: true });
      a.addEventListener('error', bad, { once: true });
    });
    if (mine !== token) return;
    await settleLength(a);
    if (mine !== token) return;
    a.currentTime = startMs / 1000;
    a.playbackRate = state.speed;
    set({ status: 'ready' });
    await a.play();
    if (mine !== token) return;
    lastSaved = Date.now();
    set({ playing: true });
    startTicking();
  } catch (e) {
    if (mine !== token) return;
    // a refused play() (the browser wants a press first) leaves the clip loaded and paused; anything else is a failure to load
    if (e instanceof DOMException && e.name === 'NotAllowedError') set({ status: 'ready', playing: false });
    else set({ status: 'error', playing: false });
  }
}

/** Plays the clip, or pauses it when it is the one playing. `startMs` is where a clip that is not loaded yet starts. */
export function toggleClip(fileId: string, lengthMs: number, startMs: number): void {
  if (state.fileId === fileId && state.status === 'ready' && audio) {
    if (state.playing) return pauseNow();
    audio.playbackRate = state.speed;
    void audio.play().then(() => {
      lastSaved = Date.now();
      set({ playing: true });
      startTicking();
    }, () => set({ status: 'error', playing: false }));
    return;
  }
  if (state.fileId === fileId && state.status === 'loading') return;
  void open(fileId, lengthMs, startMs);
}

/** Moves the clip that is loaded; returns false when it is not the loaded one (the row then keeps the position itself). */
export function seekClip(fileId: string, lengthMs: number, ms: number): boolean {
  if (state.fileId !== fileId || state.status !== 'ready' || !audio) return false;
  const at = clampPosition(ms, lengthMs);
  audio.currentTime = at / 1000;
  set({ positionMs: at });
  savePosition(fileId, at, lengthMs);
  return true;
}

/** Stops whatever plays (for sign-out and for tests). */
export function stopAllPlayback(): void {
  token += 1;
  pauseNow();
  set({ fileId: null, status: 'idle', positionMs: 0 });
}

function cycleSpeed(): void {
  const speed = nextSpeed(state.speed);
  saveSpeed(speed);
  if (audio) audio.playbackRate = speed;
  set({ speed });
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

// what a clip that is not the loaded one reports: one frozen value per speed, so the snapshot is stable and the row does not redraw for another clip
const idle = new Map<number, PlayState>();
function idleFor(speed: number): PlayState {
  let v = idle.get(speed);
  if (!v) {
    v = { fileId: null, status: 'idle', playing: false, positionMs: 0, speed };
    idle.set(speed, v);
  }
  return v;
}

export type Playback = {
  /** Is this the clip the page has loaded (playing or paused)? */
  active: boolean;
  status: PlayStatus;
  playing: boolean;
  positionMs: number;
  speed: number;
  toggle: () => void;
  seek: (ms: number) => void;
  cycleSpeed: () => void;
};

/** One clip's playback for one row: its place, whether it plays, and the controls. Many rows may use the same clip. */
export function usePlayback(fileId: string, lengthMs: number): Playback {
  const snap = useSyncExternalStore(subscribe, () => (state.fileId === fileId ? state : idleFor(state.speed)));
  const active = snap.fileId === fileId;
  // where the clip rests while it is not the loaded one: the place the reader left it, read again when another clip takes over
  const [rest, setRest] = useState(() => loadPosition(fileId));
  useEffect(() => {
    if (!active) setRest(loadPosition(fileId));
  }, [active, fileId]);
  const positionMs = active ? snap.positionMs : rest;
  const toggle = useCallback(() => toggleClip(fileId, lengthMs, state.fileId === fileId ? state.positionMs : rest), [fileId, lengthMs, rest]);
  const seek = useCallback(
    (ms: number) => {
      if (seekClip(fileId, lengthMs, ms)) return;
      const at = clampPosition(ms, lengthMs);
      savePosition(fileId, at, lengthMs);
      setRest(at);
    },
    [fileId, lengthMs],
  );
  return { active, status: snap.status, playing: snap.playing, positionMs, speed: snap.speed, toggle, seek, cycleSpeed };
}
