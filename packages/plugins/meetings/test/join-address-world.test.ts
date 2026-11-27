import { lastFakeMedia } from '@manythreads/plugin-media-fake';
import { FAKE_MEDIA_URL } from '@manythreads/sdk';
import { JoinMeetingResponse, RenewMeetingTokenResponse, StartMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// The media address a join hands out, through the real server (PLAN P38-11): the same-origin path form follows the host the request came in on, and a header the
// server does not trust (x-forwarded-host with no trusted proxy) changes nothing. The cases of the address itself are in sdk/test/media-address.test.ts.

const { nadia, rafi } = personas;
let w: World;
let general: string;
const originalProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];

beforeAll(async () => {
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  w = await createWorld();
  await ensureChannels(w);
  general = await w.channelId('engineering', 'general');
}, 180_000);
afterAll(async () => {
  lastFakeMedia().setUrl(FAKE_MEDIA_URL);
  await w?.close();
  if (originalProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
  else process.env['MANYTHREADS_MEDIA_PROVIDER'] = originalProvider;
});

const as = (who: typeof nadia, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  fetch(`${w.server.url}${path}`, {
    method,
    headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as unknown }));

describe('the media address of a join', () => {
  it('the path form of the site follows the host the page was opened on (start, join, renew)', async () => {
    // the test server's own address is http://localhost:3000; the request comes in on 127.0.0.1 and a port
    lastFakeMedia().setUrl('ws://localhost:3000/livekit');
    const origin = new URL(w.server.url);
    const started = StartMeetingResponse.parse((await as(nadia, 'POST', `/api/channels/${general}/meetings`, {}, {})).body);
    expect(started.join.url).toBe(`ws://${origin.host}/livekit`);
    const joined = JoinMeetingResponse.parse((await as(rafi, 'POST', `/api/meetings/${started.meeting.id}/join`)).body);
    expect(joined.join.url).toBe(`ws://${origin.host}/livekit`);
    const renewed = RenewMeetingTokenResponse.parse((await as(rafi, 'POST', `/api/meetings/${started.meeting.id}/token`)).body);
    expect(renewed.join.url).toBe(`ws://${origin.host}/livekit`);
  });

  it('a forwarded host the server does not trust is ignored', async () => {
    const origin = new URL(w.server.url);
    const res = await as(rafi, 'POST', `/api/channels/${general}/meetings`, { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, {});
    expect(StartMeetingResponse.parse(res.body).join.url).toBe(`ws://${origin.host}/livekit`);
  });

  it('a media server of its own is handed out as configured', async () => {
    lastFakeMedia().setUrl('wss://media.example.org');
    const res = await as(rafi, 'POST', `/api/channels/${general}/meetings`, {}, {});
    expect(StartMeetingResponse.parse(res.body).join.url).toBe('wss://media.example.org');
  });
});
