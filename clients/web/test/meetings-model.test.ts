import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { canOfferServer, canTurnOn, consentChip, consentWord, enginePlan, engineLine, micMayOpen, modeToTurnOn, planConsent, promptCopy, writtenOnServer } from '../src/meetings/consent';
import type { MeetingCaption } from '@manythreads/shared';
import {
  CAPTION_FADE_MS,
  HEARTBEAT_EVERY_MS,
  NOTETAKER_BUSY_TEXT,
  NOTETAKER_NONE_TEXT,
  activeRings,
  canRemoveNotetaker,
  captionHeading,
  captionsEmptyText,
  changeFailure,
  correctionFailure,
  mergeCaptions,
  msClock,
  notetakerBadge,
  notetakerReason,
  planRecordConsent,
  recordingChip,
  recordingReason,
  recordingWaitingOn,
  showsRecordButton,
  visibleCaptions,
  badgeFaces,
  callClock,
  isMuteShortcut,
  isNotConfigured,
  isPushToTalkKey,
  isTypingTarget,
  liveByChannel,
  liveLabel,
  presenceChange,
  rejoinDelay,
  renewDelay,
  rosterOf,
  startFailure,
} from '../src/meetings/model';
import { DEFAULT_PREFS, PREFS_KEY, loadPrefs, savePrefs } from '../src/meetings/prefs';
import { createSounds, toneSequence, type AudioContextLike } from '../src/meetings/sounds';
import { BOT, CHANNEL, ME, NADIA, NOW, RAFI, id, meeting, notetakerBot, person, summary, transcription } from './meetings-fixtures';

// P15-04 / P15-05: the plain rules of the voice-room page, with no browser and no media library.

const err = (status: number, message: string, code: ApiError['code'] = 'conflict') => new ApiError({ code, status, message });

describe('not set up', () => {
  it('knows the server\'s plain 409 and nothing else', () => {
    expect(isNotConfigured(err(409, 'Voice rooms are not set up on this server. Ask a workspace admin to connect a media server.'))).toBe(true);
    expect(isNotConfigured(err(409, 'This voice room has ended'))).toBe(false);
    expect(isNotConfigured(err(500, 'Voice rooms are not set up', 'internal'))).toBe(false);
    expect(isNotConfigured(new Error('not set up'))).toBe(false);
  });
  it('gives a failed start plain words', () => {
    expect(startFailure(err(0, 'x', 'network'))).toMatch(/Could not reach the server/);
    expect(startFailure(err(403, 'x', 'forbidden'))).toMatch(/cannot start or join/);
    expect(startFailure(err(404, 'x', 'not_found'))).toMatch(/not available/);
    expect(startFailure(err(409, 'The room is full.'))).toBe('The room is full.');
    expect(startFailure(new Error('boom'))).toMatch(/Try again/);
  });
});

describe('live rooms in the sidebar', () => {
  it('indexes live rooms by channel and ignores ended ones and rooms with no channel', () => {
    const a = summary([person(ME, 'Omar')]);
    const ended = summary([], { id: id(201) as never, channelId: id(101) as never, state: 'ended' });
    const none = summary([], { id: id(202) as never, channelId: null });
    const map = liveByChannel([a, ended, none]);
    expect([...map.keys()]).toEqual([CHANNEL]);
  });
  it('draws three faces and counts the rest', () => {
    expect(badgeFaces([1, 2, 3, 4, 5])).toEqual({ faces: [1, 2, 3], more: 2 });
    expect(badgeFaces([1])).toEqual({ faces: [1], more: 0 });
  });
  it('says how many are in it for a screen reader', () => {
    expect(liveLabel(summary([]))).toBe('A voice room is open');
    expect(liveLabel(summary([person(ME, 'Omar')]))).toBe('1 person in a voice room');
    expect(liveLabel(summary([person(ME, 'Omar'), person(NADIA, 'Nadia')]), 'conversation')).toBe('2 people in a call');
  });
});

describe('time', () => {
  it('shows the length of a call', () => {
    expect(callClock('2026-11-03T10:00:00.000Z', NOW)).toBe('0:00');
    expect(callClock('2026-11-03T10:00:00.000Z', NOW + 245_000)).toBe('4:05');
    expect(callClock('2026-11-03T10:00:00.000Z', NOW + 3_729_000)).toBe('1:02:09');
    expect(callClock('2026-11-03T10:00:00.000Z', NOW - 5000)).toBe('0:00');
    expect(callClock('nonsense', NOW)).toBe('0:00');
  });
  it('renews the token 90 seconds before it ends, never sooner than 5 seconds from now', () => {
    expect(renewDelay(new Date(NOW + 600_000).toISOString(), NOW)).toBe(510_000);
    expect(renewDelay(new Date(NOW + 60_000).toISOString(), NOW)).toBe(5_000);
    expect(renewDelay('bad', NOW)).toBe(5_000);
  });
  it('waits longer between tries to get back in, up to 15 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(rejoinDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
  it('tells the server it is still there twice a minute', () => {
    expect(HEARTBEAT_EVERY_MS).toBe(30_000);
  });
});

describe('the keyboard', () => {
  const key = (over: Partial<Parameters<typeof isMuteShortcut>[0]>) => ({ key: ' ', code: 'Space', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });
  it('mutes with Ctrl+Shift+Space or Cmd+Shift+Space only', () => {
    expect(isMuteShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isMuteShortcut(key({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isMuteShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isMuteShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isMuteShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isMuteShortcut(key({ ctrlKey: true, shiftKey: true, code: 'KeyM', key: 'M' }))).toBe(false);
  });
  it('talks on a bare Space, not while typing and not on a button', () => {
    expect(isPushToTalkKey(key({}), { tagName: 'DIV' })).toBe(true);
    expect(isPushToTalkKey(key({}), null)).toBe(true);
    expect(isPushToTalkKey(key({}), { tagName: 'TEXTAREA' })).toBe(false);
    expect(isPushToTalkKey(key({}), { tagName: 'INPUT' })).toBe(false);
    expect(isPushToTalkKey(key({}), { tagName: 'DIV', isContentEditable: true })).toBe(false);
    expect(isPushToTalkKey(key({}), { tagName: 'DIV', getAttribute: () => 'textbox' })).toBe(false);
    expect(isPushToTalkKey(key({}), { tagName: 'BUTTON' })).toBe(false);
    expect(isPushToTalkKey(key({ ctrlKey: true }), { tagName: 'DIV' })).toBe(false);
    expect(isPushToTalkKey(key({ code: 'KeyA', key: 'a' }), { tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

describe('the roster', () => {
  it('puts me first, then whoever is speaking, and leaves out people who left', () => {
    const rows = rosterOf([person(NADIA, 'Nadia'), person(RAFI, 'Rafi'), person(ME, 'Omar'), person(id(4), 'Gone', { leftAt: '2026-11-03T10:01:00.000Z' })], new Set([RAFI]), ME);
    expect(rows.map((r) => [r.name, r.me, r.speaking])).toEqual([
      ['Omar', true, false],
      ['Rafi', false, true],
      ['Nadia', false, false],
    ]);
  });
  it('finds who came and who went, never me', () => {
    expect(presenceChange([ME, NADIA], [ME, RAFI], ME)).toEqual({ joined: [RAFI], left: [NADIA] });
    expect(presenceChange([NADIA], [NADIA, ME], ME)).toEqual({ joined: [], left: [] });
  });
});

describe('ringing', () => {
  const ring = (n: number, until: number) => ({ meetingId: id(n), channelId: CHANNEL, callerActorId: NADIA, callerName: 'Nadia', until });
  it('keeps a call for its thirty seconds, drops one past it or already answered', () => {
    const rings = [ring(1, NOW + 1000), ring(2, NOW - 1), ring(3, NOW + 5000)];
    expect(activeRings(rings, NOW, new Set([id(3)])).map((r) => r.meetingId)).toEqual([id(1)]);
  });
});

describe('consent: what the page asks and shows', () => {
  const on = transcription({ mode: 'on_device', turnedOnBy: { actorId: NADIA as never, displayName: 'Nadia' } });
  it('asks nothing while transcription is off', () => {
    expect(planConsent(null, 'unasked', 'ask')).toEqual({ kind: 'none' });
    expect(planConsent(transcription(), 'unasked', 'yes')).toEqual({ kind: 'none' });
  });
  it('asks a person who has not answered, naming who turned it on', () => {
    expect(planConsent(on, 'unasked', 'ask')).toEqual({ kind: 'ask', by: 'Nadia' });
  });
  it('sends the saved default for a person who kept one, and respects an answer already given', () => {
    expect(planConsent(on, 'unasked', 'no')).toEqual({ kind: 'apply', answer: 'no' });
    expect(planConsent(on, 'unasked', 'yes')).toEqual({ kind: 'apply', answer: 'yes' });
    expect(planConsent(on, 'no', 'yes')).toEqual({ kind: 'settled', answer: 'no' });
    expect(planConsent(on, 'yes', 'ask')).toEqual({ kind: 'settled', answer: 'yes' });
  });
  it('uses a saved yes only when the person\'s own device writes the words down; a saved no always holds', () => {
    expect(planConsent(on, 'unasked', 'yes', true)).toEqual({ kind: 'ask', by: 'Nadia' });
    expect(planConsent(on, 'unasked', 'no', true)).toEqual({ kind: 'apply', answer: 'no' });
    expect(writtenOnServer(transcription({ mode: 'server' }), false)).toBe(true);
    expect(writtenOnServer(on, true)).toBe(true);
    expect(writtenOnServer(on, false)).toBe(false);
    expect(writtenOnServer(null, false)).toBe(false);
  });
  it('opens the microphone only when nothing is left to ask', () => {
    expect(micMayOpen({ kind: 'none' })).toBe(true);
    expect(micMayOpen({ kind: 'settled', answer: 'no' })).toBe(true);
    expect(micMayOpen({ kind: 'ask', by: null })).toBe(false);
    expect(micMayOpen({ kind: 'apply', answer: 'yes' })).toBe(false);
  });
  it('keeps a chip on screen for every state while it is on, and none when it is off', () => {
    expect(consentChip(transcription(), 'yes')).toBeNull();
    expect(consentChip(on, 'yes')).toMatchObject({ label: 'Transcribing', tone: 'on' });
    expect(consentChip(on, 'no')).toMatchObject({ label: 'Not transcribing you', tone: 'off' });
    expect(consentChip(on, 'unasked')).toMatchObject({ label: 'Transcription on', tone: 'wait' });
    expect(consentChip(on, 'yes')?.title).toContain('Nadia turned on transcription');
  });
  it('words the prompt in plain terms for each mode', () => {
    expect(promptCopy('Nadia', 'on_device').body).toContain('Nadia turned on transcription');
    expect(promptCopy('Nadia', 'on_device').body).toContain('your sound stays on your device');
    expect(promptCopy(null, 'server').body).toContain('sent to this server');
    expect(promptCopy(null, 'server').body).toContain('Someone turned on');
    expect(consentWord('yes')).toBe('transcribed');
    expect(consentWord('unasked')).toBe('not answered yet');
  });
  it('offers to turn it on only when something is allowed', () => {
    expect(canTurnOn(transcription({ allowed: ['on_device'] }))).toBe(true);
    expect(canTurnOn(transcription({ allowed: [] }))).toBe(false);
    expect(canTurnOn(on)).toBe(false);
    expect(canTurnOn(null)).toBe(false);
    expect(modeToTurnOn({ allowed: ['on_device', 'server'] })).toBe('on_device');
    expect(modeToTurnOn({ allowed: ['server'] })).toBe('server');
    expect(modeToTurnOn({ allowed: [] })).toBeNull();
  });
});

describe('what a person chose is kept in this browser', () => {
  const store = (initial?: string) => {
    const map = new Map<string, string>(initial === undefined ? [] : [[PREFS_KEY, initial]]);
    return { map, kv: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) } };
  };
  it('starts from the defaults and round-trips', () => {
    const { kv } = store();
    expect(loadPrefs(kv)).toEqual(DEFAULT_PREFS);
    savePrefs(kv, { ...DEFAULT_PREFS, pushToTalk: true, inputId: 'mic-2', transcribeDefault: 'no' });
    expect(loadPrefs(kv)).toMatchObject({ pushToTalk: true, inputId: 'mic-2', transcribeDefault: 'no' });
  });
  it('treats damaged storage as the defaults and never throws', () => {
    expect(loadPrefs(store('{not json').kv)).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(store(JSON.stringify({ transcribeDefault: 'sure', inputId: 5, pushToTalk: 'yes' })).kv)).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs({ getItem: () => null, setItem: () => { throw new Error('full'); } }, DEFAULT_PREFS)).not.toThrow();
    expect(() => loadPrefs({ getItem: () => { throw new Error('blocked'); }, setItem: () => undefined })).not.toThrow();
  });
});

describe('sounds', () => {
  const ctx = (state: string): AudioContextLike & { started: number[]; resumed: number } => {
    const started: number[] = [];
    const c = {
      currentTime: 10,
      state,
      destination: {},
      started,
      resumed: 0,
      resume: async () => void (c.resumed += 1),
      createOscillator: () => ({ type: '', frequency: { value: 0 }, connect: () => undefined, start: (at: number) => void started.push(at), stop: () => undefined }),
      createGain: () => ({ gain: { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined }),
    };
    return c;
  };
  const timers = () => {
    const t = { fns: [] as Array<() => void>, cleared: 0 };
    return { t, impl: { setInterval: (f: () => void) => (t.fns.push(f), t.fns.length), clearInterval: () => void (t.cleared += 1) } };
  };
  it('joining rises and leaving falls', () => {
    const [a, b] = toneSequence('join');
    expect(b!.hz).toBeGreaterThan(a!.hz);
    const [c, d] = toneSequence('leave');
    expect(d!.hz).toBeLessThan(c!.hz);
    expect(toneSequence('ring').length).toBeGreaterThan(2);
  });
  it('plays the notes of a sound when allowed and running', () => {
    const c = ctx('running');
    createSounds({ context: () => c, enabled: () => true }).play('join');
    expect(c.started).toEqual([10, 10.11]);
  });
  it('plays nothing when switched off, when there is no audio, or while the browser still blocks it', () => {
    const off = ctx('running');
    createSounds({ context: () => off, enabled: () => false }).play('join');
    expect(off.started).toEqual([]);
    expect(() => createSounds({ context: () => null, enabled: () => true }).play('join')).not.toThrow();
    const blocked = ctx('suspended');
    createSounds({ context: () => blocked, enabled: () => true }).play('join');
    expect(blocked.started).toEqual([]);
    expect(blocked.resumed).toBe(1);
  });
  it('rings again and again until told to stop, once', () => {
    const c = ctx('running');
    const { t, impl } = timers();
    const s = createSounds({ context: () => c, enabled: () => true }, impl);
    s.startRing();
    s.startRing();
    expect(t.fns).toHaveLength(1);
    const first = c.started.length;
    t.fns[0]!();
    expect(c.started.length).toBe(first * 2);
    s.stopRing();
    s.stopRing();
    expect(t.cleared).toBe(1);
  });
});

// ---- Bundle C: captions, the note-taker, recording (P15-08, P15-18, P15-15) ----------------------------------------------------------------------------------
const cap = (over: Partial<MeetingCaption> = {}): MeetingCaption =>
  ({ kind: 'speech', speakerId: NADIA, speakerName: 'Nadia', startMs: 0, endMs: 1000, text: 'hello', final: false, catchingUp: false, askerName: null, ...over }) as MeetingCaption;

describe('captions', () => {
  it('replaces a speaker\'s growing partial line and keeps its key', () => {
    const a = mergeCaptions([], [cap({ text: 'hel' })], 1000);
    const b = mergeCaptions(a, [cap({ text: 'hello wor' })], 1500);
    expect(b).toHaveLength(1);
    expect(b[0]!.text).toBe('hello wor');
    expect(b[0]!.key).toBe(a[0]!.key);
    const c = mergeCaptions(b, [cap({ text: 'hello world', final: true })], 2000);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ text: 'hello world', final: true, key: a[0]!.key });
  });
  it('keeps each speaker\'s partial apart and starts a new line after a final one', () => {
    const a = mergeCaptions([], [cap({ text: 'one', final: true }), cap({ speakerId: RAFI as never, speakerName: 'Rafi', text: 'two' })], 1000);
    expect(a.map((l) => l.text)).toEqual(['one', 'two']);
    const b = mergeCaptions(a, [cap({ text: 'three' })], 2000);
    expect(b.map((l) => l.text)).toEqual(['one', 'two', 'three']);
  });
  it('does not add a final line twice, and ignores an empty line', () => {
    const a = mergeCaptions([], [cap({ text: 'same', final: true })], 1000);
    expect(mergeCaptions(a, [cap({ text: 'same', final: true })], 2000)).toHaveLength(1);
    expect(mergeCaptions(a, [cap({ text: '   ' })], 2000)).toHaveLength(1);
  });
  it('remembers only the newest lines', () => {
    let lines = mergeCaptions([], [], 0);
    for (let i = 0; i < 10; i++) lines = mergeCaptions(lines, [cap({ text: `line ${i}`, final: true, startMs: i, endMs: i + 1 })], i, 4);
    expect(lines.map((l) => l.text)).toEqual(['line 6', 'line 7', 'line 8', 'line 9']);
  });
  it('shows the latest two lines and lets them fade', () => {
    let lines = mergeCaptions([], [cap({ text: 'a', final: true, startMs: 1, endMs: 2 })], 1000);
    lines = mergeCaptions(lines, [cap({ text: 'b', final: true, startMs: 3, endMs: 4 })], 2000);
    lines = mergeCaptions(lines, [cap({ text: 'c', final: true, startMs: 5, endMs: 6 })], 3000);
    expect(visibleCaptions(lines, 3500).map((l) => l.text)).toEqual(['b', 'c']);
    expect(visibleCaptions(lines, 2000 + CAPTION_FADE_MS + 100).map((l) => l.text)).toEqual(['c']);
    expect(visibleCaptions(lines, 3000 + CAPTION_FADE_MS + 100)).toEqual([]);
  });
  it('names the speaker, "You" for the person themselves, and the asker for a note-taker answer', () => {
    expect(captionHeading({ kind: 'speech', speakerId: NADIA, speakerName: 'Nadia', askerName: null }, ME)).toBe('Nadia');
    expect(captionHeading({ kind: 'speech', speakerId: ME, speakerName: 'Omar', askerName: null }, ME)).toBe('You');
    expect(captionHeading({ kind: 'answer', speakerId: BOT, speakerName: 'Note-taker', askerName: 'Rafi' }, ME)).toBe('Note-taker answered Rafi');
    expect(captionHeading({ kind: 'answer', speakerId: BOT, speakerName: 'Note-taker', askerName: null }, ME)).toBe('Note-taker answered');
  });
  it('carries "catching up" through', () => {
    expect(mergeCaptions([], [cap({ catchingUp: true, final: true })], 1)[0]!.catchingUp).toBe(true);
  });
  it('writes times and says what is empty', () => {
    expect(msClock(0)).toBe('0:00');
    expect(msClock(65_000)).toBe('1:05');
    expect(msClock(3_723_000)).toBe('1:02:03');
    expect(captionsEmptyText(false, false)).toMatch(/when transcription is on/);
    expect(captionsEmptyText(true, true)).toMatch(/note-taker is listening/);
  });
  it('says why a correction was refused', () => {
    expect(correctionFailure(err(403, 'x', 'forbidden'))).toMatch(/24 hours/);
    expect(correctionFailure(err(404, 'x', 'not_found'))).toMatch(/not there/);
    expect(correctionFailure(err(0, 'x', 'network'))).toMatch(/Could not reach/);
    expect(correctionFailure(new Error('x'))).toMatch(/Try again/);
  });
});

describe('the note-taker', () => {
  it('says whether it is listening or still joining', () => {
    expect(notetakerBadge({ listening: true })).toBe('Note-taker · listening');
    expect(notetakerBadge({ listening: false })).toBe('Note-taker · joining');
  });
  it('gives the reason adding is off, and none when it may be used', () => {
    const base = { bots: [notetakerBot()], current: null, canAdd: true, reason: null };
    expect(notetakerReason(base)).toBeNull();
    expect(notetakerReason({ ...base, canAdd: false, reason: 'Your admin switched it off.' })).toBe('Your admin switched it off.');
    expect(notetakerReason({ ...base, canAdd: false })).toBe(NOTETAKER_BUSY_TEXT);
    expect(notetakerReason({ ...base, bots: [] })).toBe(NOTETAKER_NONE_TEXT);
    expect(notetakerReason(null)).toBe(NOTETAKER_BUSY_TEXT);
    expect(notetakerReason({ ...base, canAdd: false, current: { bot: notetakerBot(), listening: true } })).toBeNull();
  });
  it('lets the starter, the organizer or a lead take it out, and nobody else', () => {
    const m = { organizerId: NADIA as never, startedBy: RAFI as never };
    expect(canRemoveNotetaker(m, NADIA, false)).toBe(true);
    expect(canRemoveNotetaker(m, RAFI, false)).toBe(true);
    expect(canRemoveNotetaker(m, ME, false)).toBe(false);
    expect(canRemoveNotetaker(m, ME, true)).toBe(true);
    expect(canRemoveNotetaker(m, null, false)).toBe(false);
  });
  it('words the consent question around the note-taker, and the chip names it', () => {
    const c = promptCopy('Nadia', 'server', 'Note-taker');
    expect(c.title).toMatch(/note-taker/i);
    expect(c.body).toMatch(/only writes down people who say yes/);
    expect(c.body).toMatch(/If you say no/);
    expect(promptCopy('Nadia', 'server').title).toBe('Transcribe my voice?');
    const chip = consentChip(transcription({ mode: 'server' }), 'unasked', 'Note-taker');
    expect(chip?.title).toMatch(/by the note-taker Note-taker/);
  });
  it('writes the room\'s words on the device only when this person said yes and no note-taker listens on the server', () => {
    const on = { mode: 'on_device' as const };
    const server = { mode: 'server' as const };
    expect(enginePlan(on, 'yes', false)).toBe('on_device');
    expect(enginePlan(on, 'no', false)).toBe('none');
    expect(enginePlan(on, 'unasked', false)).toBe('none');
    expect(enginePlan(on, undefined, false)).toBe('none');
    expect(enginePlan(server, 'yes', false)).toBe('server');
    expect(enginePlan(server, 'yes', true)).toBe('none');
    expect(enginePlan({ mode: 'off' }, 'yes', false)).toBe('none');
    expect(enginePlan(null, 'yes', false)).toBe('none');
  });
  it('offers the server only from the device mode when it is allowed', () => {
    expect(canOfferServer({ mode: 'on_device', allowed: ['on_device', 'server'] })).toBe(true);
    expect(canOfferServer({ mode: 'on_device', allowed: ['on_device'] })).toBe(false);
    expect(canOfferServer({ mode: 'server', allowed: ['on_device', 'server'] })).toBe(false);
    expect(canOfferServer(null)).toBe(false);
  });
  it('turns an engine status into one plain line', () => {
    expect(engineLine({ kind: 'off' })).toBeNull();
    expect(engineLine({ kind: 'listening' })).toBeNull();
    expect(engineLine({ kind: 'loading', fraction: 0.42 })).toMatch(/42%/);
    expect(engineLine({ kind: 'too_slow', message: 'Too slow.' })).toBe('Too slow.');
    expect(engineLine({ kind: 'failed', message: 'Nope.' })).toBe('Nope.');
  });
  it('words a refused change in the server\'s own plain message', () => {
    expect(changeFailure(err(409, 'The note-taker is busy, try again in a minute.'), 'add the note-taker')).toBe('The note-taker is busy, try again in a minute.');
    expect(changeFailure(err(500, 'boom', 'internal'), 'add the note-taker')).toBe('Could not add the note-taker. Try again.');
    expect(changeFailure(new Error('x'), 'turn recording on')).toBe('Could not turn recording on. Try again.');
  });
});

describe('recording', () => {
  const rec = (over = {}) => ({ cap: 'on' as const, on: false, recording: false, yourConsent: 'unasked' as const, reason: null, ...over });
  it('draws the button only where the workspace allows recording, or while it is on', () => {
    expect(showsRecordButton(null)).toBe(false);
    expect(showsRecordButton(rec({ cap: 'off' }))).toBe(false);
    expect(showsRecordButton(rec({ cap: 'off', on: true }))).toBe(true);
    expect(showsRecordButton(rec())).toBe(true);
  });
  it('says why recording cannot be turned on', () => {
    expect(recordingReason(rec({ cap: 'off' }))).toMatch(/workspace admin/);
    expect(recordingReason(rec({ reason: 'No listener is free.' }))).toBe('No listener is free.');
    expect(recordingReason(rec())).toBeNull();
    expect(recordingReason(null)).toBeNull();
  });
  it('shows no chip while off, "Recording" while sound is saved and who it waits for otherwise', () => {
    const people = [person(ME, 'Omar', { consentRecord: 'yes' }), person(NADIA, 'Nadia'), person(RAFI, 'Rafi', { consentRecord: 'no' }), person(id(4), 'Gone', { leftAt: '2026-11-03T10:05:00.000Z' })];
    expect(recordingChip(null, people)).toBeNull();
    expect(recordingChip(rec(), people)).toBeNull();
    expect(recordingChip(rec({ on: true, recording: true }), people)).toMatchObject({ label: 'Recording', tone: 'rec' });
    expect(recordingChip(rec({ on: true }), people)).toMatchObject({ label: 'Recording: waiting for 2 people', tone: 'wait' });
    expect(recordingChip(rec({ on: true }), [people[0]!, people[1]!])).toMatchObject({ label: 'Recording: waiting for 1 person' });
    expect(recordingChip(rec({ on: true }), [people[0]!])?.label).toBe('Recording: getting ready');
    expect(recordingWaitingOn(people)).toBe(2);
  });
  it('asks "Record my voice?" only while recording is on and the person has not answered', () => {
    expect(planRecordConsent(null)).toBe('none');
    expect(planRecordConsent(rec())).toBe('none');
    expect(planRecordConsent(rec({ on: true }))).toBe('ask');
    expect(planRecordConsent(rec({ on: true, yourConsent: 'yes' }))).toBe('settled');
    expect(planRecordConsent(rec({ on: true, yourConsent: 'no' }))).toBe('settled');
  });
});

describe('fixtures', () => {
  it('make a live room', () => {
    expect(meeting().state).toBe('live');
  });
});
