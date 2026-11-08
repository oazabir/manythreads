import { MEETING_ROOM_LINES_PER_MINUTE, StartMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { SPEAKER_LINES_PER_MINUTE, WindowCounter, takeRoomLines } from '../src/limits.ts';

// The limits on a room (P15-16): how many lines a minute it takes, and how many people it holds.

const { nadia, rafi, omar, priya } = personas;

describe('lines a minute', () => {
  const retry = (fn: () => void): { status: number; retryAfter: string | undefined } => {
    try {
      fn();
    } catch (e) {
      const err = e as { status: number; headers?: Record<string, string> };
      return { status: err.status, retryAfter: err.headers?.['retry-after'] };
    }
    return { status: 200, retryAfter: undefined };
  };

  it('counts a sliding window, and a refused request is not counted', () => {
    const c = new WindowCounter();
    expect(c.take('k', 3, 5, 0)).toBeNull();
    expect(c.take('k', 3, 5, 10_000)).toBe(50); // 3 + 3 > 5: wait until the first three are a minute old
    expect(c.take('k', 2, 5, 10_000)).toBeNull();
    expect(c.take('k', 1, 5, 59_999)).not.toBeNull();
    expect(c.take('k', 3, 5, 60_001)).toBeNull(); // the first three have left the window
    c.forget(1_000_000);
    expect(c.size()).toBe(0);
  });

  it('refuses one speaker over their share with 429 and a wait, before the room is full', () => {
    const room = 'room-a';
    const t = 1_000_000;
    expect(retry(() => takeRoomLines(room, 'a', SPEAKER_LINES_PER_MINUTE, t))).toMatchObject({ status: 200 });
    const refused = retry(() => takeRoomLines(room, 'a', 1, t + 1000));
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    // another speaker is still served
    expect(retry(() => takeRoomLines(room, 'b', 10, t + 1000)).status).toBe(200);
  });

  it('refuses a room over 1 000 lines a minute, for everybody in it, and takes lines again a minute later', () => {
    const room = 'room-b';
    const t = 5_000_000;
    const speakers = Math.ceil(MEETING_ROOM_LINES_PER_MINUTE / SPEAKER_LINES_PER_MINUTE);
    let taken = 0;
    for (let s = 0; s < speakers; s += 1) {
      const n = Math.min(SPEAKER_LINES_PER_MINUTE, MEETING_ROOM_LINES_PER_MINUTE - taken);
      takeRoomLines(room, `s${s}`, n, t);
      taken += n;
    }
    expect(taken).toBe(MEETING_ROOM_LINES_PER_MINUTE);
    expect(retry(() => takeRoomLines(room, 'fresh', 1, t + 500)).status).toBe(429);
    expect(retry(() => takeRoomLines(room, 'fresh', 1, t + 61_000)).status).toBe(200);
  });
});

let w: World;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];
beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld();
  await ensureChannels(w);
}, 180_000);
afterAll(async () => {
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

describe('people in a room', () => {
  it('takes the number the workspace sets, 25 until it says otherwise, and says so in plain words when full', async () => {
    const channel = await w.channelId('engineering', 'general');
    const started = await w.call(nadia, 'POST', `/api/channels/${channel}/meetings`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const id = StartMeetingResponse.parse(started.body).meeting.id;
    expect((await w.call(omar, 'GET', '/api/workspace/meetings-settings')).body).toMatchObject({ roomCap: 25 });

    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { roomCap: 2 })).status).toBe(200);
    expect((await w.call(rafi, 'POST', `/api/meetings/${id}/join`)).status).toBe(200); // nadia and rafi: two
    const full = await w.call(omar, 'POST', `/api/meetings/${id}/join`);
    expect(full.status).toBe(409);
    expect(JSON.stringify(full.body)).toContain('This voice room is full (2 people)');
    // somebody who is in the room already comes back in
    expect((await w.call(rafi, 'POST', `/api/meetings/${id}/join`)).status).toBe(200);

    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { roomCap: 3 })).status).toBe(200);
    expect((await w.call(omar, 'POST', `/api/meetings/${id}/join`)).status).toBe(200);
    expect((await w.call(priya, 'POST', `/api/meetings/${id}/join`)).status).toBe(409);
    expect((await w.call(omar, 'PUT', '/api/workspace/meetings-settings', { roomCap: 25 })).status).toBe(200);
  });
});
