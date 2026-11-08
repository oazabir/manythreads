import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { actorOf, closePerson, enterRoom, lastMeeting, meetingsStack, openAs, statusOf, type Person } from './support.ts';

/**
 * A person who loses access to a channel in the middle of a call (PLAN P15-17, §3 criterion on the kick). Omar makes a private room with Nadia and Rafi; they
 * are in a voice room there. Omar takes Rafi out of the channel: the server drops him from the room within 5 seconds (the participant row closes), his page says so, Nadia's call bar shows one face, and his join and his new token are refused.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const ROOM = 'kick-room';
const DROP_BUDGET_MS = 5_000;

let stack: Stack;
let omar: StackApi;
let channelId = '';
let rafiPersonId = '';
let nadia: Person | undefined;
let rafi: Person | undefined;
let meetingId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
  channelId = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: ROOM, private: true })).channel.id;
  for (const who of ['nadia', 'rafi'] as const) {
    const api = await apiOn(playwright, stack, who);
    const me = await api.get<{ person: { id: string } }>('/api/session');
    if (who === 'rafi') rafiPersonId = me.person.id;
    await omar.post(`/api/channels/${channelId}/members`, { personId: me.person.id });
    await api.ctx.dispose();
  }
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Rafi is taken out of the channel in the middle of the call and is dropped within 5 seconds', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${ROOM}`);
  await enterRoom(nadia);
  meetingId = (await lastMeeting(stack, ROOM)).id;
  rafi = await openAs(browser, playwright, stack, 'rafi', `/t/engineering/c/${ROOM}`);
  await enterRoom(rafi);
  await expect(nadia.page.getByTestId('call-face')).toHaveCount(2);

  const present = async (): Promise<number> =>
    (await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.meeting_participants WHERE meeting_id = $1 AND actor_id = $2 AND left_at IS NULL`, [meetingId, actorOf('rafi')]))[0]!.n === '1' ? 1 : 0;
  expect(await present()).toBe(1);

  const started = Date.now();
  const res = await omar.ctx.delete(`/api/channels/${channelId}/members/${rafiPersonId}`, { headers: await omar.headers() });
  expect(res.status(), await res.text()).toBeLessThan(300);
  await expect.poll(present, { timeout: DROP_BUDGET_MS, intervals: [100, 200, 250] }).toBe(0);
  const took = Date.now() - started;
  expect(took, `dropped after ${took} ms`).toBeLessThanOrEqual(DROP_BUDGET_MS);
  console.log(`kick: Rafi dropped from the room ${took} ms after the removal`);

});

test('the pages follow: Rafi is told, Nadia sees one face', async () => {
  await expect(nadia!.page.getByTestId('call-face')).toHaveCount(1, { timeout: 15_000 });
  await expect(rafi!.page.getByTestId('call-dock')).toBeHidden({ timeout: 60_000 });
});

test('his join and his new token are refused, and he cannot see the room', async () => {
  const api = rafi!.api;
  // PLAN §3 criterion 4: his token cannot rejoin. The room is gone from his point of view (404, as for a room that never was), not "forbidden".
  expect(await statusOf(api, 'POST', `/api/meetings/${meetingId}/join`), 'rejoin').toBe(404);
  expect(await statusOf(api, 'POST', `/api/meetings/${meetingId}/token`), 'new token').toBe(404);
  expect([403, 404]).toContain(await statusOf(api, 'POST', `/api/meetings/${meetingId}/heartbeat`, { speaking: false }));
  expect(await statusOf(api, 'GET', `/api/meetings/${meetingId}`)).toBe(404);
  expect([403, 404]).toContain(await statusOf(api, 'POST', `/api/channels/${channelId}/meetings`, {}));
  // Nadia is still in it
  expect(await statusOf(nadia!.api, 'GET', `/api/meetings/${meetingId}`)).toBe(200);
});
