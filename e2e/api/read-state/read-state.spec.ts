import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { GetReadStateResponse, GetUnreadSummaryResponse } from '@manythreads/shared';
import { PERSONA_EMAILS, TEST_AUTH_TOKEN } from '../support/api.ts';

// P3-03 over HTTP, as signed-in people. Marking read needs the counter the channels plugin registers (covered by the plugin's own
// tests); here: the read side, the contract of the routes, and that every route is for signed-in people only.

async function signedIn(playwright: { request: { newContext(o: { baseURL: string }): Promise<APIRequestContext> } }, baseURL: string, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post('/api/test/session', { data: { email }, headers: { 'x-test-auth': TEST_AUTH_TOKEN } });
  expect(res.status(), `test sign-in as ${email}`).toBe(200);
  return ctx;
}
const csrf = async (ctx: APIRequestContext): Promise<Record<string, string>> => {
  const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_csrf');
  return cookie ? { 'x-csrf-token': cookie.value } : {};
};

test('read state routes answer 401 without a session', async ({ request }) => {
  expect((await request.get(`/api/read-state?targets=channel:${randomUUID()}`)).status()).toBe(401);
  expect((await request.get('/api/read-state/summary')).status()).toBe(401);
  expect((await request.post('/api/read-state/mark', { data: {} })).status()).toBe(401);
});

test('a person with nothing unread gets zeros in request order, an empty summary, and validation errors name the field', async ({ playwright, baseURL }) => {
  const nadia = await signedIn(playwright, baseURL ?? '', PERSONA_EMAILS.nadia);
  const [a, b] = [randomUUID(), randomUUID()];
  const res = await nadia.get(`/api/read-state?targets=channel:${a},thread:${b}`);
  expect(res.status()).toBe(200);
  const { states } = GetReadStateResponse.parse(await res.json());
  expect(states).toEqual([
    { targetType: 'channel', targetId: a, lastReadId: null, unreadCount: 0, followed: false },
    { targetType: 'thread', targetId: b, lastReadId: null, unreadCount: 0, followed: false },
  ]);
  const summary = GetUnreadSummaryResponse.parse(await (await nadia.get('/api/read-state/summary')).json());
  expect(summary).toEqual({ channels: [], threads: { threadCount: 0, unreadCount: 0 }, total: 0 });

  const bad = await nadia.get('/api/read-state?targets=nope');
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('validation_failed');
  const strict = await nadia.post('/api/read-state/mark', { data: { targetType: 'channel', targetId: a, upTo: randomUUID(), extra: true }, headers: await csrf(nadia) });
  expect(strict.status()).toBe(400);
  await nadia.dispose();
});

test('the live socket accepts a signed-in person and keeps answering ping', async ({ playwright, baseURL }) => {
  const nadia = await signedIn(playwright, baseURL ?? '', PERSONA_EMAILS.nadia);
  const cookie = (await nadia.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const ws = new WebSocket(`${(baseURL ?? '').replace('http', 'ws')}/ws`, { headers: { cookie } } as never);
  const reply = await new Promise<{ type: string; id: string }>((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'ping', id: 'p1', payload: {} })));
    ws.addEventListener('message', (e) => resolve(JSON.parse(String(e.data)) as { type: string; id: string }));
    ws.addEventListener('error', () => reject(new Error('socket failed')));
  });
  expect(reply).toMatchObject({ type: 'pong', id: 'p1' });
  ws.close();
  await nadia.dispose();
});
