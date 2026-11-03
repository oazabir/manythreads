import { describe, expect, it } from 'vitest';
import { CallController } from '../src/meetings/controller';
import { CHANNEL, MEETING, ME, NADIA, THREAD, apiError, person, rig, settle, transcription } from './meetings-fixtures';

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
