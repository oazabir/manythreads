import { MEETING_CAPTION_PUSH, MEETING_CHANGED_PUSH, MEETING_RINGING_PUSH } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { LiveRoomsStore, type LiveDeps } from '../src/meetings/store';
import { CHANNEL, FakeClock, ME, MEETING, NADIA, THREAD, id, person, settle, summary } from './meetings-fixtures';

// P15-04: what the page knows about live rooms and ringing calls.

function build(rooms = [summary([person(ME, 'Omar')])]) {
  const clock = new FakeClock();
  const log = { ringing: false, started: 0, notices: [] as string[], changed: [] as string[], captions: [] as Array<[string, number]>, chat: 0, fetches: 0 };
  const state = { rooms, fail: false, hidden: false, current: null as { meetingId: string; threadRootId: string | null } | null };
  const deps: LiveDeps = {
    fetchLive: async () => {
      log.fetches += 1;
      if (state.fail) throw new Error('offline');
      return { meetings: state.rooms };
    },
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    onRoomChanged: (m) => void log.changed.push(m),
    currentRoom: () => state.current,
    onChatMessage: () => void (log.chat += 1),
    onCaptions: (m, captions) => void log.captions.push([m, captions.length]),
    selfActor: () => ME,
    sounds: {
      startRing: () => {
        log.ringing = true;
        log.started += 1;
      },
      stopRing: () => {
        log.ringing = false;
      },
    },
    notify: (title) => void log.notices.push(title),
    hidden: () => state.hidden,
  };
  return { store: new LiveRoomsStore(deps), clock, log, state };
}

const ringing = { meetingId: MEETING, channelId: CHANNEL, callerActorId: NADIA, callerName: 'Nadia', ringSeconds: 30 } as unknown as Parameters<LiveRoomsStore['addRing']>[0];

describe('live rooms', () => {
  it('lists the live rooms by channel', async () => {
    const t = build();
    await t.store.refresh();
    const s = t.store.snapshot();
    expect(s.status).toBe('ok');
    expect(s.byChannel.get(CHANNEL)?.present).toHaveLength(1);
  });
  it('shows no badges and no error when the server has no voice rooms or is offline', async () => {
    const t = build();
    t.state.fail = true;
    await t.store.refresh();
    expect(t.store.snapshot().status).toBe('absent');
    expect(t.store.snapshot().rooms).toEqual([]);
    t.state.fail = false;
    await t.store.refresh();
    t.state.fail = true;
    await t.store.refresh();
    expect(t.store.snapshot().status).toBe('ok');
  });
  it('asks again when a push says a room changed, and tells the call', async () => {
    const t = build();
    await t.store.refresh();
    const before = t.log.fetches;
    t.store.handlePush({ type: MEETING_CHANGED_PUSH, payload: { meetingId: MEETING, channelId: CHANNEL, state: 'live' } } as never);
    await settle();
    expect(t.log.fetches).toBe(before + 1);
    expect(t.log.changed).toEqual([MEETING]);
  });
  it('asks again every half minute, so a lost push heals', async () => {
    const t = build();
    t.store.start();
    await settle();
    const before = t.log.fetches;
    await t.clock.advance(61_000);
    expect(t.log.fetches).toBeGreaterThanOrEqual(before + 2);
    t.store.stop();
  });
  it('counts a chat message in the call\'s thread from someone else', () => {
    const t = build();
    t.state.current = { meetingId: MEETING, threadRootId: THREAD };
    const post = (author: string, root: string) => t.store.handlePush({ type: 'message.posted', payload: { threadRootId: root, message: { authorId: author } } } as never);
    post(NADIA, THREAD);
    post(ME, THREAD);
    post(NADIA, id(999));
    expect(t.log.chat).toBe(1);
  });
});

describe('a call ringing', () => {
  it('rings for thirty seconds and then stops by itself', async () => {
    const t = build();
    t.store.handlePush({ type: MEETING_RINGING_PUSH, payload: ringing } as never);
    await settle();
    expect(t.log.ringing).toBe(true);
    expect(t.store.snapshot().rings).toHaveLength(1);
    await t.clock.advance(29_000);
    expect(t.log.ringing).toBe(true);
    await t.clock.advance(2_000);
    expect(t.log.ringing).toBe(false);
    expect(t.store.snapshot().rings).toHaveLength(0);
  });
  it('stops when answered or declined and does not ring again for the same call', async () => {
    const t = build();
    t.store.addRing(ringing);
    t.store.stopRinging(MEETING);
    expect(t.log.ringing).toBe(false);
    t.store.addRing(ringing);
    expect(t.log.ringing).toBe(false);
    expect(t.log.started).toBe(1);
  });
  it('keeps a ring that arrived while the live list was being fetched', async () => {
    const t = build([]);
    const pending = t.store.refresh();
    t.store.addRing(ringing);
    await pending;
    await settle();
    expect(t.store.snapshot().rings).toHaveLength(1);
  });
  it('drops a ring once the room is no longer live', async () => {
    const t = build();
    t.store.addRing(ringing);
    await settle();
    await t.clock.advance(1000);
    t.state.rooms = [];
    await t.store.refresh();
    expect(t.store.snapshot().rings).toHaveLength(0);
    expect(t.log.ringing).toBe(false);
  });
  it('shows a system notice when the tab is hidden', () => {
    const t = build();
    t.state.hidden = true;
    t.store.addRing(ringing);
    expect(t.log.notices).toEqual(['Nadia is calling you']);
  });
});

describe('live captions (P15-08)', () => {
  const caption = { kind: 'speech', speakerId: NADIA, speakerName: 'Nadia', startMs: 0, endMs: 900, text: 'Shall we ship?', final: true, catchingUp: false, askerName: null };
  it('hands the captions of a push to the call', () => {
    const t = build();
    t.store.handlePush({ type: MEETING_CAPTION_PUSH, payload: { meetingId: MEETING, captions: [caption, { ...caption, text: 'Yes.' }] } } as never);
    expect(t.log.captions).toEqual([[MEETING, 2]]);
  });
  it('ignores a push that is not shaped like captions', () => {
    const t = build();
    t.store.handlePush({ type: MEETING_CAPTION_PUSH, payload: { meetingId: MEETING, captions: [] } } as never);
    t.store.handlePush({ type: MEETING_CAPTION_PUSH, payload: { nonsense: true } } as never);
    expect(t.log.captions).toEqual([]);
  });
});
