import type { VideoTile } from './media';
import type { StageLayout } from './prefs';

/*
 * How the call's stage lays its video out (PLAN P17-01), as plain functions the stage and the tests share. Grid: equal tiles. Speaker: one large tile (the tile
 * pinned, else another person's shared screen, else another person speaking, else one's own screen, else whoever spoke last) and a strip of the others. At most
 * 16 video tiles are drawn; past that one "+N" tile names the rest. The drawn set is sticky: a drawn tile keeps its place, a new tile is added at the end, and
 * a person who is not drawn takes a place only after speaking for 3 seconds, in the place of the drawn person silent the longest (the others do not move).
 * Also here: the picture-in-picture decision and the rule that suggests audio only on a weak connection.
 */

export type { StageLayout };

/** At most this many video tiles are drawn at once, the large one included. */
export const MAX_VIDEO_TILES = 16;
/** How long a person who is not drawn must speak before taking a drawn place. */
export const SWAP_AFTER_MS = 3_000;

const cameraOf = (videos: readonly VideoTile[], actorId: string | null): VideoTile | undefined =>
  actorId === null ? undefined : videos.find((v) => v.actorId === actorId && v.source === 'camera' && !v.local);

/**
 * The tile that stands for the call: the pin; else another person's shared screen; else the camera of another person speaking; else one's own shared screen;
 * else the last other person heard; else another person's camera; else one's own camera.
 */
export function focusTile(videos: readonly VideoTile[], speaking: ReadonlySet<string>, pinned: string | null, lastSpeaker: string | null): VideoTile | null {
  const pin = pinned === null ? undefined : videos.find((v) => v.key === pinned);
  if (pin) return pin;
  const remote = videos.filter((v) => !v.local);
  return (
    remote.find((v) => v.source === 'screen') ??
    remote.find((v) => v.source === 'camera' && speaking.has(v.actorId)) ??
    videos.find((v) => v.local && v.source === 'screen') ??
    cameraOf(videos, lastSpeaker) ??
    remote.find((v) => v.source === 'camera') ??
    videos[0] ??
    null
  );
}

// ---- who has been speaking, for the sticky choice -------------------------------------------------------------------------------------------------------

/** Since when each person has been speaking without a break, and when each was last heard (ms). */
export type SpeechTrack = { since: ReadonlyMap<string, number>; heard: ReadonlyMap<string, number> };
export const NO_SPEECH: SpeechTrack = { since: new Map(), heard: new Map() };

/** The track after the speakers changed (or time passed): people speaking keep their start, new ones start now, the rest stop. */
export function trackSpeech(prev: SpeechTrack, speaking: ReadonlySet<string>, now: number): SpeechTrack {
  const since = new Map<string, number>();
  const heard = new Map(prev.heard);
  for (const id of speaking) {
    since.set(id, prev.since.get(id) ?? now);
    heard.set(id, now);
  }
  return { since, heard };
}

export type SlotsInput = {
  videos: readonly VideoTile[];
  /** The keys drawn last time, in their places. Empty the first time. */
  previous: readonly string[];
  /** Tiles that must be drawn (the pin and the focus). */
  required: readonly string[];
  speaking: ReadonlySet<string>;
  speech: SpeechTrack;
  now: number;
  cap?: number;
};

/** The keys drawn, in their places, and in how many ms to look again (a person not drawn is speaking but not yet for 3 s), or null. */
export function stickySlots(input: SlotsInput): { slots: string[]; recheckInMs: number | null } {
  const cap = Math.max(1, input.cap ?? MAX_VIDEO_TILES);
  const { videos, speaking, speech, now } = input;
  const byKey = new Map(videos.map((v) => [v.key, v]));
  const room = videos.length > cap ? cap - 1 : cap;
  const required = new Set(input.required.filter((k) => byKey.has(k)));
  // tiles that are never pushed out: the pin and focus, a screen, one's own camera, anyone speaking now
  const kept = (k: string): boolean => {
    const v = byKey.get(k);
    return !v || required.has(k) || v.source === 'screen' || v.local || speaking.has(v.actorId);
  };
  const rank = (v: VideoTile): number => (required.has(v.key) ? 0 : v.source === 'screen' ? 1 : speaking.has(v.actorId) ? 2 : v.local ? 3 : 4);
  const first = input.previous.length === 0;
  let slots = input.previous.filter((k) => byKey.has(k));
  const drawn = new Set(slots);
  // fill free places with the most important tiles not drawn, at the end
  const waiting = videos.map((v, i) => ({ v, i })).filter((x) => !drawn.has(x.v.key)).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i);
  for (const { v } of waiting) {
    if (slots.length >= room) break;
    slots.push(v.key);
  }
  // the first time, the room's order
  if (first) {
    const order = new Map(videos.map((v, i) => [v.key, i]));
    slots.sort((a, b) => order.get(a)! - order.get(b)!);
  }
  // fewer places than drawn tiles (more people came): the last-placed that may go, go
  for (let i = slots.length - 1; slots.length > room && i >= 0; i -= 1) if (!kept(slots[i]!)) slots.splice(i, 1);
  /** The place of the drawn tile silent the longest that may give way; ties go to the later place. */
  const victim = (): number => {
    let at = -1;
    let quiet = Infinity;
    slots.forEach((k, i) => {
      if (kept(k)) return;
      const t = speech.heard.get(byKey.get(k)!.actorId) ?? -Infinity;
      if (t <= quiet) {
        quiet = t;
        at = i;
      }
    });
    return at;
  };
  const swapIn = (key: string): void => {
    const at = victim();
    if (at >= 0) slots[at] = key;
  };
  for (const k of required) if (!slots.includes(k)) swapIn(k);
  let recheck: number | null = null;
  const undrawnSpeakers = videos
    .filter((v) => v.source === 'camera' && !slots.includes(v.key) && speech.since.has(v.actorId) && speaking.has(v.actorId))
    .sort((a, b) => speech.since.get(a.actorId)! - speech.since.get(b.actorId)!);
  for (const v of undrawnSpeakers) {
    const long = now - speech.since.get(v.actorId)!;
    if (long >= SWAP_AFTER_MS) swapIn(v.key);
    else recheck = Math.min(recheck ?? Infinity, SWAP_AFTER_MS - long);
  }
  slots = slots.slice(0, room);
  return { slots, recheckInMs: recheck };
}

export type ArrangeInput = {
  layout: StageLayout;
  videos: readonly VideoTile[];
  /** Actor ids heard speaking right now. */
  speaking: ReadonlySet<string>;
  /** The tile key the person pinned, or null. A key that is no longer in `videos` counts as no pin. */
  pinned: string | null;
  /** The other person who spoke last (kept by the stage), so the large tile does not jump back when the room goes quiet. */
  lastSpeaker: string | null;
  /** The keys drawn (from `stickySlots`), in their places; left out, they are chosen afresh. */
  slots?: readonly string[];
  cap?: number;
};

export type Arrangement = {
  /** Speaker layout: the large tile (it is also in `tiles`). Grid: null. */
  main: VideoTile | null;
  /** Every tile drawn, in its place. The stage draws them as one list, so a tile never loses its video when the layout or the large tile changes. */
  tiles: VideoTile[];
  /** The video tiles not drawn because of the cap, for the "+N" tile. */
  overflow: VideoTile[];
  /** The tile that best stands for the call now: the large one in Speaker. */
  focus: VideoTile | null;
};

/** Which tiles are drawn, and which one is large. */
export function arrangeStage(input: ArrangeInput): Arrangement {
  const { videos, speaking, layout } = input;
  const pinned = input.pinned !== null && videos.some((v) => v.key === input.pinned) ? input.pinned : null;
  const focus = focusTile(videos, speaking, pinned, input.lastSpeaker);
  const required = [pinned, focus?.key].filter((k): k is string => typeof k === 'string');
  const slots =
    input.slots ?? stickySlots({ videos, previous: [], required, speaking, speech: NO_SPEECH, now: 0, ...(input.cap !== undefined ? { cap: input.cap } : {}) }).slots;
  const byKey = new Map(videos.map((v) => [v.key, v]));
  const tiles = slots.map((k) => byKey.get(k)).filter((v): v is VideoTile => v !== undefined);
  const shown = new Set(tiles.map((t) => t.key));
  const overflow = videos.filter((v) => !shown.has(v.key));
  return { main: layout === 'speaker' && focus && shown.has(focus.key) ? focus : null, tiles, overflow, focus };
}

/** How many columns a grid of `n` tiles takes: near square, at most 2 on a phone and 4 elsewhere. */
export function gridColumns(n: number, narrow: boolean): number {
  if (n <= 1) return 1;
  return Math.min(narrow ? 2 : 4, Math.ceil(Math.sqrt(n)));
}

/** The layout shown: the person's own choice, else Speaker on a phone and Grid on a wider screen. */
export const layoutFor = (prefs: { layout: StageLayout | null }, narrow: boolean): StageLayout => prefs.layout ?? (narrow ? 'speaker' : 'grid');

// ---- picture-in-picture --------------------------------------------------------------------------------------------------------------------------------

export type PipInput = {
  /** The tab is hidden (`document.visibilityState === 'hidden'`). */
  hidden: boolean;
  /** The browser can do it (`document.pictureInPictureEnabled`). */
  supported: boolean;
  /** The person has not turned it off. */
  enabled: boolean;
  /** This page put a video into picture-in-picture and it is still there. */
  active: boolean;
  focus: VideoTile | null;
  /** Every tile drawn, for another person's video when the focus is one's own. */
  videos: readonly VideoTile[];
};

export type PipAction = { kind: 'enter'; key: string } | { kind: 'exit' } | { kind: 'none' };

/**
 * What to do with picture-in-picture when the tab is hidden or shown again. The window shows another person's video, never one's own camera or screen: the focus
 * when it is someone else's, else another person's screen or camera, else nothing.
 */
export function pipDecision(i: PipInput): PipAction {
  if (!i.hidden) return i.active ? { kind: 'exit' } : { kind: 'none' };
  if (i.active || !i.supported || !i.enabled) return { kind: 'none' };
  const pick = i.focus && !i.focus.local ? i.focus : (i.videos.find((v) => !v.local && v.source === 'screen') ?? i.videos.find((v) => !v.local));
  return pick ? { kind: 'enter', key: pick.key } : { kind: 'none' };
}

// ---- audio only on a weak connection ----------------------------------------------------------------------------------------------------------------------

/** The media library's word for this person's own connection. */
export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

/** Suggest audio only (never switch by itself) when the connection is weak, there is video to drop, it is not on yet and the person has not said "not now" in this call. */
export function suggestAudioOnly(i: { quality: ConnectionQuality; audioOnly: boolean; dismissed: boolean; videoCount: number }): boolean {
  return (i.quality === 'poor' || i.quality === 'lost') && !i.audioOnly && !i.dismissed && i.videoCount > 0;
}
