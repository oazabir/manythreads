import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CallStage } from '../src/meetings/CallStage';
import type { CallState } from '../src/meetings/controller';
import type { VideoTile } from '../src/meetings/media';
import {
  MAX_VIDEO_TILES,
  NO_SPEECH,
  SWAP_AFTER_MS,
  arrangeStage,
  gridColumns,
  layoutFor,
  pipDecision,
  stickySlots,
  suggestAudioOnly,
  trackSpeech,
  type ArrangeInput,
  type SlotsInput,
} from '../src/meetings/layout';
import { DEFAULT_PREFS, OLD_STAGE_KEY, PREFS_KEY, loadPrefs, savePrefs, type KeyValue } from '../src/meetings/prefs';

// P17-01: which tiles are large, drawn or past the cap (and how the drawn set sticks); the remembered layout; picture-in-picture; the audio-only suggestion.

const cam = (actorId: string, local = false): VideoTile => ({ key: `${actorId}:camera`, actorId, source: 'camera', local });
const scr = (actorId: string, local = false): VideoTile => ({ key: `${actorId}:screen`, actorId, source: 'screen', local });
const ME = cam('me', true);
const A = cam('a');
const B = cam('b');
const C = cam('c');
const keys = (ts: readonly VideoTile[]): string[] => ts.map((t) => t.key);
const base = (over: Partial<ArrangeInput>): ArrangeInput => ({ layout: 'speaker', videos: [ME, A, B, C], speaking: new Set(), pinned: null, lastSpeaker: null, ...over });
const many = (n: number): VideoTile[] => [ME, ...Array.from({ length: n - 1 }, (_, i) => cam(`p${i + 1}`))];

describe('the speaker layout', () => {
  it('shows the person speaking large; every tile stays in the one list in the room’s order', () => {
    const r = arrangeStage(base({ speaking: new Set(['b']) }));
    expect(r.main?.key).toBe('b:camera');
    expect(keys(r.tiles)).toEqual(['me:camera', 'a:camera', 'b:camera', 'c:camera']);
    expect(r.overflow).toEqual([]);
  });
  it('prefers another person over oneself when both speak, and keeps the last speaker when the room goes quiet', () => {
    expect(arrangeStage(base({ speaking: new Set(['me', 'c']) })).main?.key).toBe('c:camera');
    expect(arrangeStage(base({ lastSpeaker: 'c' })).main?.key).toBe('c:camera');
    expect(arrangeStage(base({})).main?.key).toBe('a:camera');
    expect(arrangeStage(base({ videos: [ME] })).main?.key).toBe('me:camera');
  });
  it('another person’s screen is large over the speaker', () => {
    const r = arrangeStage(base({ videos: [ME, A, scr('b'), B], speaking: new Set(['a']) }));
    expect(r.main?.key).toBe('b:screen');
  });
  it('one’s own screen ranks below another person speaking, above the last speaker and a silent room', () => {
    const videos = [ME, scr('me', true), A, B];
    expect(arrangeStage(base({ videos, speaking: new Set(['a']) })).main?.key).toBe('a:camera');
    expect(arrangeStage(base({ videos, lastSpeaker: 'b' })).main?.key).toBe('me:screen');
    expect(arrangeStage(base({ videos })).main?.key).toBe('me:screen');
  });
  it('a pinned tile stays large over the speaker and a screen; a pin that is gone counts as none', () => {
    const videos = [ME, A, scr('b'), B];
    expect(arrangeStage(base({ videos, pinned: 'a:camera', speaking: new Set(['b']) })).main?.key).toBe('a:camera');
    expect(arrangeStage(base({ videos, pinned: 'z:camera', speaking: new Set(['b']) })).main?.key).toBe('b:screen');
  });
  it('no video, no large tile', () => {
    expect(arrangeStage(base({ videos: [] }))).toEqual({ main: null, tiles: [], overflow: [], focus: null });
  });
});

describe('the grid layout', () => {
  it('is every tile at the same size; a pin marks a tile and never moves it', () => {
    const r = arrangeStage(base({ layout: 'grid', speaking: new Set(['b']) }));
    expect(r.main).toBeNull();
    expect(keys(r.tiles)).toEqual(['me:camera', 'a:camera', 'b:camera', 'c:camera']);
    expect(r.focus?.key).toBe('b:camera');
    expect(keys(arrangeStage(base({ layout: 'grid', pinned: 'c:camera' })).tiles)).toEqual(['me:camera', 'a:camera', 'b:camera', 'c:camera']);
  });
});

describe('at most 16 video tiles', () => {
  it('16 tiles all show', () => {
    const r = arrangeStage(base({ layout: 'grid', videos: many(16) }));
    expect(r.tiles).toHaveLength(16);
    expect(r.overflow).toEqual([]);
  });
  it('past 16, fifteen show and one "+N" tile stands for the rest, in both layouts', () => {
    const videos = many(20);
    for (const layout of ['grid', 'speaker'] as const) {
      const r = arrangeStage(base({ layout, videos }));
      expect(r.tiles).toHaveLength(MAX_VIDEO_TILES - 1);
      expect(r.overflow).toHaveLength(5);
    }
  });
  it('the first choice keeps the pinned, a screen, a person speaking and one’s own camera inside the cap, in the room’s order', () => {
    const videos = [...many(20), scr('p3')];
    const r = arrangeStage(base({ layout: 'grid', videos, pinned: 'p19:camera', speaking: new Set(['p18']) }));
    const shown = keys(r.tiles);
    expect(shown).toEqual(expect.arrayContaining(['p19:camera', 'me:camera', 'p18:camera', 'p3:screen']));
    expect(keys(r.overflow)).toEqual(['p12:camera', 'p13:camera', 'p14:camera', 'p15:camera', 'p16:camera', 'p17:camera']);
    expect(shown.slice(0, 3)).toEqual(['me:camera', 'p1:camera', 'p2:camera']);
  });
});

describe('sticky places past the cap', () => {
  const videos = many(20); // me, p1..p19: drawn me, p1..p14; waiting p15..p19
  const input = (over: Partial<SlotsInput>): SlotsInput => ({ videos, previous: [], required: [], speaking: new Set(), speech: NO_SPEECH, now: 10_000, ...over });
  const first = stickySlots(input({})).slots;

  it('a drawn tile keeps its place; a new tile goes to the end when there is room', () => {
    expect(first).toEqual(['me:camera', ...Array.from({ length: 14 }, (_, i) => `p${i + 1}:camera`)]);
    // one drawn person leaves: the others keep their places and the first waiting person takes the free place at the end
    const left = videos.filter((v) => v.key !== 'p3:camera');
    const next = stickySlots(input({ videos: left, previous: first })).slots;
    expect(next.indexOf('p4:camera')).toBe(first.indexOf('p4:camera') - 1);
    expect(next.at(-1)).toBe('p15:camera');
    // under the cap again: everything is drawn, old places first
    const few = stickySlots(input({ videos: [ME, A, B], previous: ['b:camera', 'me:camera'] })).slots;
    expect(few).toEqual(['b:camera', 'me:camera', 'a:camera']);
  });
  it('a person not drawn takes a place only after speaking for 3 s, in the place of the one silent longest; nobody else moves', () => {
    const heard = new Map([['me', 9_000], ...Array.from({ length: 14 }, (_, i) => [`p${i + 1}`, 5_000 + i * 100] as [string, number])]);
    heard.set('p6', 1_000); // p6 is silent longest
    const speaking = new Set(['p17']);
    const early = stickySlots(input({ previous: first, speaking, speech: { since: new Map([['p17', 9_000]]), heard }, now: 10_000 }));
    expect(early.slots).toEqual(first);
    expect(early.recheckInMs).toBe(SWAP_AFTER_MS - 1_000);
    const later = stickySlots(input({ previous: first, speaking, speech: { since: new Map([['p17', 9_000]]), heard }, now: 9_000 + SWAP_AFTER_MS }));
    const at = first.indexOf('p6:camera');
    expect(later.slots[at]).toBe('p17:camera');
    expect(later.slots.filter((_, i) => i !== at)).toEqual(first.filter((_, i) => i !== at));
    expect(later.recheckInMs).toBeNull();
  });
  it('one’s own camera, a person speaking and the required tiles are never pushed out', () => {
    const heard = new Map<string, number>();
    const pinned = 'p19:camera';
    const r = stickySlots(input({ previous: first, required: [pinned], speaking: new Set(['p1']), speech: { since: new Map([['p1', 0]]), heard } }));
    expect(r.slots).toContain(pinned);
    expect(r.slots).toContain('me:camera');
    expect(r.slots).toContain('p1:camera');
    expect(r.slots).toHaveLength(MAX_VIDEO_TILES - 1);
  });
  it('tracks since when each person speaks and when each was last heard', () => {
    const t1 = trackSpeech(NO_SPEECH, new Set(['a']), 100);
    const t2 = trackSpeech(t1, new Set(['a', 'b']), 200);
    expect(t2.since.get('a')).toBe(100);
    expect(t2.since.get('b')).toBe(200);
    const t3 = trackSpeech(t2, new Set(['b']), 300);
    expect(t3.since.has('a')).toBe(false);
    expect(t3.heard.get('a')).toBe(200);
    expect(t3.heard.get('b')).toBe(300);
  });
});

describe('grid columns', () => {
  it('stays near square, at most two columns on a phone and four elsewhere', () => {
    expect(gridColumns(1, false)).toBe(1);
    expect(gridColumns(2, false)).toBe(2);
    expect(gridColumns(5, false)).toBe(3);
    expect(gridColumns(16, false)).toBe(4);
    expect(gridColumns(16, true)).toBe(2);
  });
});

function memory(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe('the remembered layout (kept with the call prefs)', () => {
  it('is Speaker on a phone and Grid elsewhere until the person picks one, then their pick', () => {
    expect(layoutFor(DEFAULT_PREFS, true)).toBe('speaker');
    expect(layoutFor(DEFAULT_PREFS, false)).toBe('grid');
    const s = memory();
    savePrefs(s, { ...DEFAULT_PREFS, layout: 'speaker', pip: false });
    const back = loadPrefs(s);
    expect(back).toMatchObject({ layout: 'speaker', pip: false });
    expect(layoutFor(back, false)).toBe('speaker');
  });
  it('a strange value is the default', () => {
    const s = memory();
    s.data.set(PREFS_KEY, JSON.stringify({ layout: 'mosaic', pip: 'yes' }));
    expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
  });
  it('moves the early build’s own key into the call prefs once, then removes it', () => {
    const s = memory();
    s.data.set(PREFS_KEY, JSON.stringify({ ...DEFAULT_PREFS, sounds: false }));
    s.data.set(OLD_STAGE_KEY, JSON.stringify({ layout: 'speaker', pip: false }));
    expect(loadPrefs(s)).toMatchObject({ sounds: false, layout: 'speaker', pip: false });
    expect(s.data.has(OLD_STAGE_KEY)).toBe(false);
    expect(JSON.parse(s.data.get(PREFS_KEY)!)).toMatchObject({ layout: 'speaker', pip: false });
    // a damaged old value is removed and changes nothing
    s.data.set(OLD_STAGE_KEY, '{nope');
    expect(loadPrefs(s)).toMatchObject({ layout: 'speaker', pip: false });
    expect(s.data.has(OLD_STAGE_KEY)).toBe(false);
  });
  it('blocked storage never throws', () => {
    const blocked: KeyValue = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadPrefs(blocked)).toEqual(DEFAULT_PREFS);
  });
});

describe('picture-in-picture', () => {
  const on = { hidden: true, supported: true, enabled: true, active: false, focus: A, videos: [ME, A, B] };
  it('a hidden tab puts the focus video into the floating window when it is someone else’s', () => {
    expect(pipDecision(on)).toEqual({ kind: 'enter', key: 'a:camera' });
  });
  it('never one’s own camera or screen: another person’s screen, else camera, else nothing', () => {
    expect(pipDecision({ ...on, focus: scr('me', true), videos: [ME, scr('me', true), A, scr('b')] })).toEqual({ kind: 'enter', key: 'b:screen' });
    expect(pipDecision({ ...on, focus: ME, videos: [ME, B] })).toEqual({ kind: 'enter', key: 'b:camera' });
    expect(pipDecision({ ...on, focus: ME, videos: [ME, scr('me', true)] })).toEqual({ kind: 'none' });
  });
  it('not when the browser cannot, the person turned it off, there is no video, or it is already open', () => {
    expect(pipDecision({ ...on, supported: false })).toEqual({ kind: 'none' });
    expect(pipDecision({ ...on, enabled: false })).toEqual({ kind: 'none' });
    expect(pipDecision({ ...on, focus: null, videos: [] })).toEqual({ kind: 'none' });
    expect(pipDecision({ ...on, active: true })).toEqual({ kind: 'none' });
  });
  it('the tab back closes the window this page opened, and only that', () => {
    expect(pipDecision({ ...on, hidden: false, active: true })).toEqual({ kind: 'exit' });
    expect(pipDecision({ ...on, hidden: false })).toEqual({ kind: 'none' });
  });
});

describe('the audio-only suggestion', () => {
  const weak = { quality: 'poor' as const, audioOnly: false, dismissed: false, videoCount: 2 };
  it('is offered on a poor or lost connection with video in the call', () => {
    expect(suggestAudioOnly(weak)).toBe(true);
    expect(suggestAudioOnly({ ...weak, quality: 'lost' })).toBe(true);
  });
  it('not on a good connection, when it is on already, after Not now, or with no video', () => {
    expect(suggestAudioOnly({ ...weak, quality: 'good' })).toBe(false);
    expect(suggestAudioOnly({ ...weak, quality: 'excellent' })).toBe(false);
    expect(suggestAudioOnly({ ...weak, quality: 'unknown' })).toBe(false);
    expect(suggestAudioOnly({ ...weak, audioOnly: true })).toBe(false);
    expect(suggestAudioOnly({ ...weak, dismissed: true })).toBe(false);
    expect(suggestAudioOnly({ ...weak, videoCount: 0 })).toBe(false);
  });
});

describe('the stage as drawn (no browser)', () => {
  const draw = (videos: VideoTile[], layout: 'grid' | 'speaker', speaking: string[] = []): string =>
    renderToStaticMarkup(createElement(CallStage, { call: { videos, speaking: new Set(speaking), present: [], prefs: { ...DEFAULT_PREFS, layout } } as unknown as CallState }));

  it('draws the grid with a layout switch, a pin on each tile and a "+N" tile past sixteen', () => {
    const html = draw(many(20), 'grid');
    expect(html).toContain('data-layout="grid"');
    expect(html).toContain('data-testid="stage-layout-grid"');
    expect(html).toContain('data-testid="stage-layout-speaker"');
    expect(html.match(/data-testid="stage-tile"/g)).toHaveLength(15);
    expect(html.match(/data-testid="stage-pin"/g)).toHaveLength(15);
    expect(html).toContain('data-testid="stage-overflow"');
    expect(html).toContain('+5');
  });
  it('draws Speaker as the same one list, the person speaking marked large', () => {
    const html = draw([ME, A, B], 'speaker', ['b']);
    expect(html).toContain('data-layout="speaker"');
    expect(html).toMatch(/data-key="b:camera" data-big="true"/);
    expect(html.match(/data-testid="stage-tiles"/g)).toHaveLength(1);
    expect(html).not.toContain('stage-overflow');
  });
});
