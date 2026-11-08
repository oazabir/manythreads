import { personas, type Persona } from '@manythreads/test-utils';
import { expect, test, useIsolatedStack } from '../support/isolated.ts';
import { bridgeUrl, seededOf } from '../../connections/support.ts';

/*
 * Chat apps at the API (PLAN P16-09, decisions D8 and D9), on seed v16: the Telegram account is on and `#support` is joined to a group. Covered: the admin's list and who may use it; credentials
 * go in sealed and come back in no answer, no row and no event; a person's link code (eight digits, shown once); the door refuses an unknown or mismatched account (404), a call without the
 * secret word or with a wrong one (401), and a switched-off account the same way as an unknown one; only a lead of the team makes a code that joins a channel to a chat, and a code is typed
 * as `/connect <digits>`.
 *
 * Written for the integration pass; not run by the coder that wrote it.
 */
const iso = useIsolatedStack({ MANYTHREADS_STACK_SEED: 'connectors', MANYTHREADS_STACK_API_ONLY: '1' });
test.describe.configure({ mode: 'serial' });

const { omar, priya, sameera } = personas;
const as = (p: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: p.actorId, workspaceId: p.workspaceId }) });
const SENTINEL = 'whatsapp-app-secret-SENTINEL-7c1d';

interface Account {
  provider: string;
  status: string;
}

test('the admin sees the four chat apps, Telegram on and the rest not set up; nobody else sees the list', async ({ request }) => {
  const stack = await iso.start();
  const res = await request.get('/api/admin/bridges', { headers: as(omar) });
  expect(res.status()).toBe(200);
  const text = await res.text();
  const { accounts } = JSON.parse(text) as { accounts: Account[] };
  expect(accounts.find((a) => a.provider === 'telegram')?.status).toBe('on');
  expect(accounts.filter((a) => a.provider !== 'telegram')).toEqual([]);
  // the bot token the stand-in gave the server is in no answer
  if (stack.fakeSaas?.telegramBotToken) expect(text).not.toContain(stack.fakeSaas.telegramBotToken);
  for (const who of [priya, sameera]) {
    expect((await request.get('/api/admin/bridges', { headers: as(who) })).status(), who.key).toBe(403);
    expect((await request.put('/api/admin/bridges/whatsapp', { headers: as(who), data: { displayName: 'x' } })).status(), who.key).toBe(403);
  }
});

test('credentials go in sealed: the WhatsApp secret is in no answer, no row and no event afterwards', async ({ request }) => {
  const stack = await iso.start();
  const made = await request.put('/api/admin/bridges/whatsapp', { headers: as(omar), data: { displayName: 'Kahf WhatsApp', externalAppId: '1234567890' } });
  expect(made.status()).toBe(200);
  const put = await request.put('/api/admin/bridges/whatsapp/credentials', { headers: as(omar), data: { botToken: 'whatsapp-access-token-0001', appSecret: SENTINEL, inboundSecret: 'whatsapp-verify-word-0001' } });
  expect(put.status()).toBe(200);
  expect(await put.text()).not.toContain(SENTINEL);
  expect(await (await request.get('/api/admin/bridges', { headers: as(omar) })).text()).not.toContain(SENTINEL);
  expect(await stack.sql(`SELECT 1 FROM app.bridge_accounts WHERE row_to_json(bridge_accounts)::text LIKE '%' || $1 || '%'`, [SENTINEL])).toHaveLength(0);
  expect(await stack.sql(`SELECT 1 FROM app.events WHERE payload::text LIKE '%' || $1 || '%'`, [SENTINEL])).toHaveLength(0);
  expect(await stack.sql(`SELECT 1 FROM app.bridge_secrets`)).not.toHaveLength(0);
  // it can be taken away again
  expect((await request.delete('/api/admin/bridges/whatsapp', { headers: as(omar) })).status()).toBe(200);
});

test('a person gets an eight-digit link code, and the list of their chat apps never repeats it', async ({ request }) => {
  await iso.start();
  const res = await request.post('/api/me/bridges/telegram/link-code', { headers: as(priya), data: {} });
  expect(res.status()).toBe(200);
  const code = (await res.json()) as { code: string; expiresAt: string; instruction: string };
  expect(code.code).toMatch(/^\d{8}$/);
  expect(Date.parse(code.expiresAt)).toBeGreaterThan(Date.now());
  expect(await (await request.get('/api/me/bridges', { headers: as(priya) })).text()).not.toContain(code.code);
  // a chat app that is not set up has no code to give
  expect([404, 409]).toContain((await request.post('/api/me/bridges/slack/link-code', { headers: as(priya), data: {} })).status());
});

test('the door: an unknown account is 404, a mismatched service is 404, a call without the secret word or with a wrong one is 401', async ({ request }) => {
  const stack = await iso.start();
  const account = seededOf(stack).telegramAccountId;
  const update = { update_id: 90_001, message: { message_id: 1, from: { id: 1, is_bot: false, first_name: 'x' }, chat: { id: 1, type: 'private' }, date: 1, text: 'hello' } };
  expect((await request.post(bridgeUrl(stack, 'telegram', '00000000-0000-4000-8000-000000000777'), { data: update })).status()).toBe(404);
  expect((await request.post(bridgeUrl(stack, 'slack', account), { data: update })).status()).toBe(404);
  expect((await request.post(bridgeUrl(stack, 'telegram', account), { data: update })).status()).toBe(401);
  expect((await request.post(bridgeUrl(stack, 'telegram', account), { data: update, headers: { 'x-telegram-bot-api-secret-token': 'not-the-word' } })).status()).toBe(401);
  // nothing of the refused calls was stored
  expect(await stack.sql(`SELECT 1 FROM app.bridge_messages WHERE provider_update_id = '90001'`)).toHaveLength(0);
});

test('a switched-off account answers its door like an unknown one, and switching it on again restores it', async ({ request }) => {
  const stack = await iso.start();
  const account = seededOf(stack).telegramAccountId;
  const off = await request.post('/api/admin/bridges/telegram/switch', { headers: as(omar), data: { on: false } });
  expect(off.status()).toBe(200);
  const unknown = await request.post(bridgeUrl(stack, 'telegram', '00000000-0000-4000-8000-000000000778'), { data: {} });
  const closed = await request.post(bridgeUrl(stack, 'telegram', account), { data: {} });
  expect(closed.status()).toBe(404);
  expect(await closed.text()).toBe(await unknown.text());
  const on = await request.post('/api/admin/bridges/telegram/switch', { headers: as(omar), data: { on: true } });
  expect(on.status()).toBe(200);
  const accounts = ((await (await request.get('/api/admin/bridges', { headers: as(omar) })).json()) as { accounts: Account[] }).accounts;
  expect(accounts.find((a) => a.provider === 'telegram')?.status).toBe('on');
});

test('only a lead of the team makes the code that joins a channel to a chat, and the command is typed in the chat', async ({ request }) => {
  const stack = await iso.start();
  const channel = seededOf(stack).supportChannelId;
  const listed = await request.get(`/api/channels/${channel}/bridge-links`, { headers: as(sameera) });
  expect(listed.status()).toBe(200);
  const list = (await listed.json()) as { links: unknown[]; accounts: unknown[]; canLink: boolean };
  expect(list.links).toHaveLength(1);
  expect(list.canLink).toBe(false);
  expect([403, 404]).toContain((await request.post(`/api/channels/${channel}/bridge-links/telegram/code`, { headers: as(priya), data: {} })).status());
  expect((await request.post(`/api/channels/${channel}/bridge-links/telegram/code`, { headers: as(sameera), data: {} })).status()).toBe(403);
  const made = await request.post(`/api/channels/${channel}/bridge-links/telegram/code`, { headers: as(omar), data: {} });
  expect(made.status()).toBe(200);
  const code = (await made.json()) as { code: string; command: string };
  expect(code.command).toBe(`/connect ${code.code}`);
});
