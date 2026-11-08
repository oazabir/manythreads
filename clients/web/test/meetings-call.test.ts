import { describe, expect, it } from 'vitest';
import { CallController } from '../src/meetings/controller';
import type { EngineContext, TranscribeEngine } from '../src/meetings/engine';
import { BOT, CHANNEL, MEETING, ME, NADIA, THREAD, apiError, person, rig, settle, transcription } from './meetings-fixtures';

// P15-04 / P15-05: the whole life of a call, against the stand-in server and the in-memory media layer.

async function connected(over: Parameters<typeof rig>[0] = {}, prefs?: Parameters<typeof rig>[1]) {
  const r = rig(over, prefs);
  const c = new CallController(r.deps);
  c.setSelf(ME);
  const opened: string[] = [];
  c.setHooks({ openChat: (root) => void opened.push(root) });
  await c.start(CHANNEL);
  await settle();
  return { ...r, c, opened, media: () => r.adapters[0]! };
}

describe('starting a voice room', () => {
  it('asks the server, connects, opens the microphone and plays the join sound', async () => {
    const t = await connected();
    expect(t.c.getState().phase).toBe('connected');
    expect(t.server.calls[0]).toBe(`start ${CHANNEL}`);
    expect(t.media().state.connected).toBe(true);
    expect(t.media().state.micOn).toBe(true);
    expect(t.media().state.options).toMatchObject({ echoCancellation: true, noiseSuppression: true });
    expect(t.sounds.played).toContain('join');
    expect(t.c.getState().muted).toBe(false);
  });
  it('opens the chat thread beside the call', async () => {
    const t = await connected();
    expect(t.opened).toEqual([THREAD]);
  });
  it('says plainly that voice rooms are not set up when the server answers 409, and starts nothing', async () => {
    const r = rig();
    r.server.failAlways('start', apiError(409, 'Voice rooms are not set up on this server. Ask a workspace admin to connect a media server.'));
    const c = new CallController(r.deps);
    await c.start(CHANNEL);
    expect(c.getState().phase).toBe('not-set-up');
    expect(r.adapters).toHaveLength(0);
    expect(c.getState().meeting).toBeNull();
    c.dismiss();
    expect(c.getState().phase).toBe('idle');
  });
  it('reports a failed connection in words and tells the server the person is not there', async () => {
    const r = rig();
    r.deps.loadAdapter = async () => {
      const { createFakeAdapter } = await import('../src/meetings/fakeAdapter');
      const a = createFakeAdapter();
      a.failNextConnect('The media server did not answer.');
      r.adapters.push(a);
      return a;
    };
    const c = new CallController(r.deps);
    await c.start(CHANNEL);
    await settle();
    expect(c.getState().phase).toBe('failed');
    expect(c.getState().error).toContain('media server');
    expect(r.server.calls.some((x) => x.startsWith('leave'))).toBe(true);
  });
  it('tells a refused microphone to the person, and stays in the room muted', async () => {
    const r = rig();
    r.deps.loadAdapter = async () => {
      const { createFakeAdapter } = await import('../src/meetings/fakeAdapter');
      const a = createFakeAdapter();
      a.refuseMicrophone();
      r.adapters.push(a);
      return a;
    };
    const c = new CallController(r.deps);
    c.setSelf(ME);
    await c.start(CHANNEL);
    await settle();
    expect(c.getState().phase).toBe('connected');
    expect(c.getState().notice).not.toBeNull();
  });
});

describe('in the room', () => {
  it('mutes, unmutes and deafens (deafening also mutes, and undeafening gives the microphone back)', async () => {
    const t = await connected();
    t.c.toggleMute();
    await settle();
    expect(t.c.getState().muted).toBe(true);
    expect(t.media().state.micOn).toBe(false);
    t.c.toggleMute();
    await settle();
    expect(t.media().state.micOn).toBe(true);
    t.c.toggleDeafen();
    await settle();
    expect(t.c.getState().deafened).toBe(true);
    expect(t.media().state.deafened).toBe(true);
    expect(t.media().state.micOn).toBe(false);
    t.c.toggleDeafen();
    await settle();
    expect(t.media().state.deafened).toBe(false);
    expect(t.media().state.micOn).toBe(true);
  });
  it('with push-to-talk the microphone is open only while the key is held', async () => {
    const t = await connected();
    t.c.setPushToTalk(true);
    await settle();
    expect(t.media().state.micOn).toBe(false);
    t.c.talk(true);
    await settle();
    expect(t.media().state.micOn).toBe(true);
    t.c.talk(false);
    await settle();
    expect(t.media().state.micOn).toBe(false);
    expect(t.stored.get('manythreads_call_prefs')).toContain('"pushToTalk":true');
  });
  it('shows who is speaking', async () => {
    const t = await connected();
    t.media().speak([NADIA]);
    expect([...t.c.getState().speaking]).toEqual([NADIA]);
  });
  it('remembers the chosen device', async () => {
    const t = await connected();
    await t.c.pickInput('mic-2');
    expect(t.media().state.inputId).toBe('mic-2');
    expect(t.stored.get('manythreads_call_prefs')).toContain('mic-2');
  });
  it('counts chat messages that arrive while the thread is closed, and clears them when it opens', async () => {
    const t = await connected();
    t.c.setChatOpen(false);
    t.c.noteChatMessage();
    t.c.noteChatMessage();
    expect(t.c.getState().chatUnread).toBe(2);
    t.c.setChatOpen(true);
    expect(t.c.getState().chatUnread).toBe(0);
    t.c.noteChatMessage();
    expect(t.c.getState().chatUnread).toBe(0);
  });
  it('plays a sound when someone joins and when someone leaves', async () => {
    const t = await connected();
    t.sounds.played.length = 0;
    t.server.people = [person(ME, 'Omar'), person(NADIA, 'Nadia')];
    await t.c.refresh();
    expect(t.sounds.played).toEqual(['join']);
    t.server.people = [person(ME, 'Omar')];
    await t.c.refresh();
    expect(t.sounds.played).toEqual(['join', 'leave']);
  });
  it('sends a heartbeat every 30 seconds', async () => {
    const t = await connected();
    const before = t.server.calls.filter((x) => x.startsWith('heartbeat')).length;
    await t.clock.advance(61_000);
    expect(t.server.calls.filter((x) => x.startsWith('heartbeat')).length).toBeGreaterThanOrEqual(before + 2);
  });
  it('renews the token before it ends', async () => {
    const t = await connected();
    await t.clock.advance(520_000);
    expect(t.server.calls.some((x) => x.startsWith('renew'))).toBe(true);
  });
  it('goes quietly when the server says the person is no longer in the room', async () => {
    const t = await connected();
    t.server.failAlways('heartbeat', apiError(404, 'gone', 'not_found'));
    await t.clock.advance(31_000);
    expect(t.c.getState().phase).toBe('idle');
    expect(t.c.getState().notice).not.toBeNull();
    expect(t.media().state.connected).toBe(false);
  });
});

describe('the network', () => {
  it('shows reconnecting when the connection drops and goes back when it returns', async () => {
    const t = await connected();
    t.media().drop();
    expect(t.c.getState().phase).toBe('reconnecting');
    t.media().recover();
    expect(t.c.getState().phase).toBe('connected');
  });
  it('gets back in with a fresh token when the library gives up, and says lost after six failures', async () => {
    const t = await connected();
    t.server.failAlways('join', apiError(500, 'down', 'internal'));
    t.server.failAlways('renew', apiError(500, 'down', 'internal'));
    t.media().lose();
    await t.clock.advance(120_000);
    expect(t.c.getState().phase).toBe('lost');
    t.server.failAlways('join', null);
    t.server.failAlways('renew', null);
    const back = t.c.rejoin();
    await t.clock.advance(1);
    await back;
    expect(t.c.getState().phase).toBe('connected');
  });
});

describe('leaving', () => {
  it('leaves, closes the media, plays the leave sound and tells the server', async () => {
    const t = await connected();
    await t.c.leave();
    expect(t.c.getState().phase).toBe('idle');
    expect(t.server.calls).toContain(`leave ${MEETING}`);
    expect(t.media().state.connected).toBe(false);
    expect(t.sounds.played).toContain('leave');
  });
  it('ends the room for everyone', async () => {
    const t = await connected();
    await t.c.endForAll();
    expect(t.server.calls).toContain(`end ${MEETING}`);
    expect(t.c.getState().phase).toBe('idle');
  });
});

describe('consent before the microphone (P15-05)', () => {
  it('opens the microphone at once when transcription is off', async () => {
    const t = await connected();
    expect(t.c.getState().consent.kind).toBe('none');
    expect(t.media().state.micOn).toBe(true);
  });
  it('keeps the microphone closed for a late joiner until they answer', async () => {
    const t = await connected({ room: { transcription: 'on_device' } });
    t.server.transcriptionState = transcription({ mode: 'on_device', turnedOnBy: { actorId: NADIA as never, displayName: 'Nadia' } });
    await t.c.refresh();
    await settle();
    expect(t.c.getState().consent.kind).toBe('ask');
    expect(t.c.getState().waitingForConsent).toBe(true);
    expect(t.media().state.micOn).toBe(false);
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    expect(t.server.calls).toContain('consent yes');
    expect(t.media().state.micOn).toBe(true);
    expect(t.c.getState().waitingForConsent).toBe(false);
  });
  it('does not let a refresh that was already running put the question back after the answer', async () => {
    const t = await connected({ room: { transcription: 'on_device' } });
    t.server.transcriptionState = transcription({ mode: 'on_device', turnedOnBy: { actorId: NADIA as never, displayName: 'Nadia' } });
    await t.c.refresh();
    await settle();
    expect(t.c.getState().consent.kind).toBe('ask');
    // a refresh reads the room (nobody has answered yet) and waits; meanwhile the person answers and the room asks to be read again
    const read = t.server.get;
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    t.server.get = async (id) => {
      const seen = await read(id);
      if (first) {
        first = false;
        await held;
      }
      return seen;
    };
    const running = t.c.refresh();
    await settle();
    await t.c.answerConsent('yes', { remember: false });
    const again = t.c.refresh();
    release();
    await Promise.all([running, again]);
    await settle();
    expect(t.c.getState().consent.kind).toBe('settled');
    expect(t.c.getState().waitingForConsent).toBe(false);
  });
  it('keeps the answer as the personal default when asked to remember', async () => {
    const t = await connected({ room: { transcription: 'on_device' } });
    t.server.transcriptionState = transcription({ mode: 'on_device', turnedOnBy: { actorId: NADIA as never, displayName: 'Nadia' } });
    await t.c.refresh();
    await t.c.answerConsent('no', { remember: true });
    expect(t.c.getState().prefs.transcribeDefault).toBe('no');
    expect(t.stored.get('manythreads_call_prefs')).toContain('"transcribeDefault":"no"');
  });
  it('sends the remembered answer by itself, without asking', async () => {
    const t = await connected({ room: { transcription: 'on_device' } }, { ...(await import('../src/meetings/prefs')).DEFAULT_PREFS, transcribeDefault: 'yes' });
    t.server.transcriptionState = transcription({ mode: 'on_device', turnedOnBy: { actorId: NADIA as never, displayName: 'Nadia' } });
    await t.c.refresh();
    await settle();
    expect(t.server.calls).toContain('consent yes');
    expect(t.media().state.micOn).toBe(true);
  });
  it('turns transcription on for the room and asks everybody again', async () => {
    const t = await connected();
    await t.c.turnTranscription('on_device');
    expect(t.server.calls).toContain('setTranscription on_device');
    expect(t.c.getState().transcription?.mode).toBe('on_device');
  });
});

// ---- Bundle C: the engine, captions, the note-taker, recording (P15-08, P15-18, P15-15) ---------------------------------------------------------------------------

type Spy = { engine: TranscribeEngine; started: EngineContext[]; stops: number; muted: boolean[]; modes: Array<string | undefined> };
function spyEngine(t: { deps: { loadEngine: (mode?: 'on_device' | 'server') => Promise<TranscribeEngine | null> } }): Spy {
  const spy: Spy = { started: [], stops: 0, muted: [], modes: [], engine: null as never };
  spy.engine = {
    start: (ctx) => void (ctx && spy.started.push(ctx)),
    stop: () => void (spy.stops += 1),
    setMuted: (m) => void spy.muted.push(m),
  };
  t.deps.loadEngine = async (mode) => {
    spy.modes.push(mode);
    return spy.engine;
  };
  return spy;
}

async function turnOn(t: Awaited<ReturnType<typeof connected>>, mode: 'on_device' | 'server', allowed: Array<'on_device' | 'server'> = ['on_device', 'server']) {
  t.server.room = { ...t.server.room, transcription: mode };
  t.server.transcriptionState = transcription({ mode, allowed, turnedOnBy: { actorId: NADIA as never, displayName: 'Nadia' } });
  await t.c.refresh();
  await settle();
}

describe('the transcription engine on the call (P15-06 wiring)', () => {
  it('does not start before the person says yes, then starts with the room, its start time and the microphone choice', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'on_device');
    expect(spy.modes).toEqual([]);
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    expect(spy.modes).toEqual(['on_device']);
    expect(spy.started).toHaveLength(1);
    expect(spy.started[0]).toMatchObject({ meetingId: MEETING, startedAt: '2026-11-03T10:00:00.000Z', inputId: null });
    expect(t.c.getState().engine.kind).toBe('loading');
  });
  it('shows what the engine reports: listening, too slow', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'on_device');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    spy.started[0]!.onStatus?.({ kind: 'loading', fraction: 0.5 });
    expect(t.c.getState().engine).toEqual({ kind: 'loading', fraction: 0.5 });
    spy.started[0]!.onStatus?.({ kind: 'listening' });
    expect(t.c.getState().engine.kind).toBe('listening');
    spy.started[0]!.onStatus?.({ kind: 'too_slow', message: 'This device is too slow to transcribe.' });
    expect(t.c.getState().engine).toEqual({ kind: 'too_slow', message: 'This device is too slow to transcribe.' });
  });
  it('tells the engine when the person mutes, and when they unmute', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'on_device');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    spy.muted.length = 0;
    t.c.toggleMute();
    await settle();
    expect(spy.muted.at(-1)).toBe(true);
    t.c.toggleMute();
    await settle();
    expect(spy.muted.at(-1)).toBe(false);
  });
  it('stops the engine when the person says no, and sends that answer from "Join without transcription"', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'on_device');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    await t.c.joinWithoutTranscription();
    await settle();
    expect(t.server.calls).toContain('consent no');
    expect(spy.stops).toBe(1);
    expect(t.c.getState().engine.kind).toBe('off');
  });
  it('stops the engine when transcription is turned off or the person leaves', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'on_device');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    await t.c.leave();
    expect(spy.stops).toBe(1);
    expect(t.c.getState().engine.kind).toBe('off');
  });
  it('runs the server engine in a room set to the server, when no note-taker listens', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'server');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    expect(spy.modes).toEqual(['server']);
  });
  it('runs no engine on the device while a note-taker listens on the server', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    await turnOn(t, 'server');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    expect(spy.started).toHaveLength(1);
    await t.c.addNotetaker(BOT);
    await settle();
    expect(spy.stops).toBe(1);
    // everybody is asked again; after a yes the note-taker listens and the device stays quiet
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    expect(spy.started).toHaveLength(1);
  });
  it('says plainly when there is no engine in this browser', async () => {
    const t = await connected();
    await turnOn(t, 'on_device');
    await t.c.answerConsent('yes', { remember: false });
    await settle();
    expect(t.c.getState().engine.kind).toBe('failed');
  });
  it('does not start an engine that was replaced while it loaded', async () => {
    const t = await connected();
    const spy = spyEngine(t);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    t.deps.loadEngine = async () => {
      await gate;
      return spy.engine;
    };
    await turnOn(t, 'on_device');
    const answering = t.c.answerConsent('yes', { remember: false });
    await settle();
    const changing = t.c.answerConsent('no', { remember: false });
    await settle();
    release();
    await Promise.all([answering, changing]);
    await settle();
    expect(spy.started).toHaveLength(0);
    expect(spy.stops).toBe(1);
  });
  it('moves the room to the server (off, then server) when this device is too slow and the server is allowed', async () => {
    const t = await connected();
    spyEngine(t);
    await turnOn(t, 'on_device');
    await t.c.switchToServer();
    expect(t.server.calls.filter((x) => x.startsWith('setTranscription'))).toEqual(['setTranscription off', 'setTranscription server']);
    expect(t.c.getState().transcription?.mode).toBe('server');
  });
  it('does not offer the server when it is not allowed', async () => {
    const t = await connected();
    spyEngine(t);
    await turnOn(t, 'on_device', ['on_device']);
    await t.c.switchToServer();
    expect(t.server.calls.some((x) => x.startsWith('setTranscription'))).toBe(false);
  });
});

describe('captions on the call', () => {
  const caption = (over = {}) => ({ kind: 'speech', speakerId: NADIA, speakerName: 'Nadia', startMs: 0, endMs: 900, text: 'Shall we ship?', final: true, catchingUp: false, askerName: null, ...over }) as never;
  it('keeps the captions of the room the person is in, and nobody else\'s', async () => {
    const t = await connected();
    t.c.noteCaptions(MEETING, [caption()]);
    expect(t.c.getState().captions.map((l) => l.text)).toEqual(['Shall we ship?']);
    t.c.noteCaptions('00000000-0000-7000-8000-000000000999', [caption({ text: 'elsewhere' })]);
    expect(t.c.getState().captions).toHaveLength(1);
  });
  it('forgets them when the person leaves', async () => {
    const t = await connected();
    t.c.noteCaptions(MEETING, [caption()]);
    await t.c.leave();
    expect(t.c.getState().captions).toEqual([]);
  });
  it('reads the lines so far and saves a correction of the person\'s own line', async () => {
    const t = await connected();
    t.room.lines = [
      { segmentId: 'seg-1' as never, speakerId: ME as never, speakerName: 'Omar', startMs: 1000, endMs: 2000, text: 'Shall we shipp?', transcribed: true, editable: true },
      { segmentId: null, speakerId: NADIA as never, speakerName: 'Nadia', startMs: 3000, endMs: 4000, text: 'Nadia spoke (not transcribed)', transcribed: false, editable: false },
    ];
    await t.c.loadHistory();
    expect(t.c.getState().history.status).toBe('ok');
    expect(t.c.getState().history.lines).toHaveLength(2);
    await t.c.correctLine('seg-1', 'Shall we ship?');
    expect(t.server.calls).toContain('correct seg-1');
    expect(t.c.getState().history.lines[0]!.text).toBe('Shall we ship?');
  });
  it('says the history could not be read, and passes a refused correction on', async () => {
    const t = await connected();
    t.room.failAlways('transcript', apiError(500, 'down', 'internal'));
    await t.c.loadHistory();
    expect(t.c.getState().history.status).toBe('failed');
    t.room.failAlways('correct', apiError(403, 'Too late', 'forbidden'));
    await expect(t.c.correctLine('seg-1', 'x')).rejects.toMatchObject({ status: 403 });
  });
});

describe('the note-taker on the call (P15-18)', () => {
  it('reads the bots that may be added and the one in the room', async () => {
    const t = await connected();
    expect(t.c.getState().notetakers?.bots).toHaveLength(1);
    expect(t.c.getState().notetakers?.current).toBeNull();
  });
  it('shows nothing when the server has no note-taker', async () => {
    const r = rig();
    r.room.failAlways('notetakers', apiError(404, 'Not found', 'not_found'));
    const c = new CallController(r.deps);
    c.setSelf(ME);
    await c.start(CHANNEL);
    await settle();
    expect(c.getState().notetakers).toBeNull();
    expect(c.getState().phase).toBe('connected');
  });
  it('adds one: the room moves to the server and the person is asked again before the microphone opens', async () => {
    const t = await connected();
    await t.c.addNotetaker(BOT);
    await settle();
    expect(t.server.calls).toContain(`addNotetaker ${BOT}`);
    expect(t.c.getState().notetakers?.current?.bot.name).toBe('Note-taker');
    expect(t.c.getState().transcription?.mode).toBe('server');
    expect(t.c.getState().consent.kind).toBe('ask');
    expect(t.c.getState().waitingForConsent).toBe(true);
  });
  it('says the server\'s reason when adding is refused', async () => {
    const t = await connected();
    t.room.failAlways('addNotetaker', apiError(409, 'The note-taker is busy, try again in a minute.'));
    await t.c.addNotetaker(BOT);
    expect(t.c.getState().notice).toBe('The note-taker is busy, try again in a minute.');
    expect(t.c.getState().notetakers?.current).toBeNull();
  });
  it('takes it out, and says plainly when the person may not', async () => {
    const t = await connected();
    await t.c.addNotetaker(BOT);
    await t.c.removeNotetaker();
    expect(t.server.calls).toContain(`removeNotetaker ${MEETING}`);
    expect(t.c.getState().notetakers?.current).toBeNull();
    await t.c.addNotetaker(BOT);
    t.room.failAlways('removeNotetaker', apiError(403, 'Forbidden', 'forbidden'));
    await t.c.removeNotetaker();
    expect(t.c.getState().notice).toMatch(/Only the person who started the call or a team lead/);
  });
});

describe('recording on the call (P15-15)', () => {
  it('reads the recording state, and asks nothing while it is off', async () => {
    const t = await connected();
    expect(t.c.getState().recording?.cap).toBe('on');
    expect(t.c.getState().recordConsent).toBe('none');
  });
  it('shows nothing when the server has no recording', async () => {
    const r = rig();
    r.room.failAlways('recording', apiError(501, 'Not built yet', 'internal'));
    const c = new CallController(r.deps);
    c.setSelf(ME);
    await c.start(CHANNEL);
    await settle();
    expect(c.getState().recording).toBeNull();
    expect(c.getState().recordConsent).toBe('none');
  });
  it('turns it on, asks the person, and starts only once everybody said yes', async () => {
    const t = await connected({ people: [person(ME, 'Omar'), person(NADIA, 'Nadia')] });
    await t.c.setRecording(true);
    expect(t.server.calls).toContain('setRecording true');
    expect(t.c.getState().recording?.on).toBe(true);
    expect(t.c.getState().recordConsent).toBe('ask');
    await t.c.answerRecordConsent('yes');
    expect(t.server.calls).toContain('recordConsent yes');
    expect(t.c.getState().recordConsent).toBe('settled');
    // Nadia has not answered: nothing is being recorded
    expect(t.c.getState().recording?.recording).toBe(false);
  });
  it('keeps the microphone as it is: a recording question never blocks the voice', async () => {
    const t = await connected();
    await t.c.setRecording(true);
    expect(t.media().state.micOn).toBe(true);
  });
  it('says why when turning it on is refused', async () => {
    const t = await connected();
    t.room.failAlways('setRecording', apiError(409, 'Recording needs a free listener.'));
    await t.c.setRecording(true);
    expect(t.c.getState().notice).toBe('Recording needs a free listener.');
    expect(t.c.getState().recording?.on).toBe(false);
  });
  it('passes a failed answer on so the prompt can say so', async () => {
    const t = await connected();
    await t.c.setRecording(true);
    t.room.failAlways('recordConsent', apiError(500, 'down', 'internal'));
    await expect(t.c.answerRecordConsent('no')).rejects.toMatchObject({ status: 500 });
  });
  it('lets a person say a plain sentence above the controls', async () => {
    const t = await connected();
    t.c.notify('Recording is switched off.');
    expect(t.c.getState().notice).toBe('Recording is switched off.');
  });
});
