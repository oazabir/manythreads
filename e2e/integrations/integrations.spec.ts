import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * Integrations of a channel (PLAN P14-14, docs/plugins/webhooks.md). A lead opens the channel's Integrations dialog and, only through the screen:
 *   1. makes an API token and copies it (shown once), then a script (a plain HTTP call, like curl) uses Slack's Web API with it: posts a message, edits it,
 *      adds a reaction; the answers have Slack's shape and the message is written by the integration (Webhook mark);
 *   2. makes an outgoing webhook that sends messages starting with "deploy" to a receiver, with a signing secret; a person's message is sent, signed, the
 *      receiver's reply appears in the channel once, and that reply (which says "deploy" too) does not send anything again;
 *   3. switches both off and sees the old token and the old hook refused/quiet.
 * The server cannot call a private address (by design), so the stack maps `*.fake.example` to a public number and connects it to this spec's receiver
 * (packages/plugins/webhooks `testReceiverDeps`, NODE_ENV=test only).
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };

interface Hit {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let stack: Stack;
let receiver: Server;
let hits: Hit[] = [];
const answer = '{"text":"deploy started for *prod* @here"}';
let omar: StackApi;
let nadia: StackApi;
let room = '';
let roomName = '';
let token = '';
let signingSecret = '';

async function slack(method: string, body: Record<string, unknown>, bearer: string | null = token): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${stack.origin}/api/slack/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test.beforeAll(async ({ playwright }) => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer);
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const port = (receiver.address() as AddressInfo).port;
  stack = await startStack({ MANYTHREADS_STACK_WEBHOOK_RECEIVER: String(port) });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  roomName = 'integrations-room';
  room = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: roomName })).channel.id;
  await postAs(omar, room, 'Welcome to the room');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
  receiver?.closeAllConnections();
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
});

test('a member does not get the Integrations button; a lead does, with three tabs', async ({ browser, playwright }) => {
  const member = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${roomName}`);
  try {
    await expect(member.page.getByText('Welcome to the room')).toBeVisible(T);   // the channel has loaded
    await expect(member.page.getByTestId('webhooks-open')).toHaveCount(0);
  } finally {
    await member.context.close();
  }
  const lead = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${roomName}`);
  try {
    await lead.page.getByTestId('webhooks-open').click();
    const dialog = lead.page.getByTestId('webhooks-dialog');
    await expect(dialog.getByRole('heading', { name: `Integrations for #${roomName}` })).toBeVisible(T);
    await expect(dialog.getByRole('tab')).toHaveText(['Incoming webhooks', 'Outgoing webhooks', 'API tokens']);
    await expect(dialog.getByRole('tab', { name: 'Incoming webhooks' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByTestId('webhooks-empty')).toBeVisible(T);
  } finally {
    await lead.context.close();
  }
});

test('the lead makes an API token on screen; a script posts, edits and reacts with it', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${roomName}`);
  try {
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-tokens').click();
    await expect(page.getByTestId('tokens-empty')).toBeVisible(T);
    await page.getByTestId('token-name').fill('Deploy script');
    await page.getByTestId('token-create').click();
    const box = page.getByTestId('token-secret');
    await expect(box).toBeVisible(T);
    token = ((await box.textContent()) ?? '').trim();
    expect(token).toMatch(/^mtat_[A-Za-z0-9_-]{43}$/);
    await expect(page.getByTestId('token-curl')).toContainText('/api/slack/chat.postMessage');
    await expect(page.getByTestId('token-curl')).toContainText(room);
    await page.getByRole('button', { name: 'I have copied it' }).click();
    await expect(page.getByTestId('token-reveal')).toHaveCount(0);
    await expect(page.getByTestId('token-row')).toContainText('Deploy script');
    await expect(page.getByTestId('token-row')).toContainText('Never used yet');
    // the secret is not shown again: reload and open the dialog
    await page.reload();
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-tokens').click();
    await expect(page.getByTestId('token-row')).toContainText('Deploy script');
    await expect(page.getByTestId('token-secret')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // the script
    const who = await slack('auth.test', {});
    expect(who).toMatchObject({ status: 200, json: { ok: true, user: 'Deploy script' } });
    const posted = await slack('chat.postMessage', { channel: room, text: 'Build *42* finished, see <https://ci.example.com/42|the run> @here' });
    expect(posted.json).toMatchObject({ ok: true, channel: room });
    const ts = String(posted.json['ts']);
    expect(ts).toMatch(/^\d{10}\.\d{6}$/);
    const message = page.locator('[data-testid="message"]', { hasText: 'Build 42 finished' });
    await expect(message).toBeVisible(T);
    await expect(message).toContainText('Deploy script');
    await expect(message).toContainText('Webhook');
    await expect(message.getByRole('link', { name: 'the run' })).toHaveAttribute('href', 'https://ci.example.com/42');

    const updated = await slack('chat.update', { channel: room, ts, text: 'Build **42** passed' });
    expect(updated.json).toMatchObject({ ok: true, ts });
    await expect(page.locator('[data-testid="message"]', { hasText: 'Build 42 passed' })).toBeVisible(T);
    expect((await slack('reactions.add', { channel: room, timestamp: ts, name: 'tada' })).json).toEqual({ ok: true });
    await expect(page.locator('[data-testid="message"]', { hasText: 'Build 42 passed' })).toContainText('🎉', T);

    // what it may not do
    const mine = await postAs(nadia, room, 'a person wrote this');
    const theirs = await omar.get<{ items: Array<{ id: string }> }>(`/api/channels/${room}/messages?limit=50`);
    expect(theirs.items.some((m) => m.id === mine.id)).toBe(true);
    const tsOfPerson = await slack('chat.update', { channel: room, ts: '1700000000.000000', text: 'x' });
    expect(tsOfPerson.json).toEqual({ ok: false, error: 'message_not_found' });
    expect((await slack('chat.postMessage', { channel: '#nowhere', text: 'x' })).json).toEqual({ ok: false, error: 'channel_not_found' });
    expect((await slack('chat.postMessage', { channel: room, text: 'x' }, 'mtat_wrongwrongwrongwrongwrongwrongwrongwrong123')).json).toEqual({ ok: false, error: 'invalid_auth' });
    expect((await slack('chat.postMessage', { channel: room, text: 'x' }, null)).json).toEqual({ ok: false, error: 'not_authed' });

    // the list shows its use
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-tokens').click();
    await expect(page.getByTestId('token-row')).toContainText('calls so far', T);
  } finally {
    await context.close();
  }
});

test('the lead makes an outgoing webhook; a person\'s "deploy" message is sent signed and the reply shows once', async ({ browser, playwright }) => {
  hits = [];
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${roomName}`);
  try {
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-outgoing').click();
    await expect(page.getByTestId('outgoing-empty')).toBeVisible(T);

    // an address inside a network is refused with a sentence
    await page.getByTestId('outgoing-name').fill('Deploy bot');
    await page.getByTestId('outgoing-url').fill('http://127.0.0.1/hook');
    await page.getByTestId('outgoing-words').fill('deploy');
    await page.getByTestId('outgoing-create').click();
    await expect(page.getByTestId('outgoing-note')).toContainText(/private network|local/i, T);

    await page.getByTestId('outgoing-url').fill('http://receiver.fake.example/in');
    await page.getByTestId('outgoing-words').fill('deploy, !ship');
    await page.getByTestId('outgoing-create').click();
    const row = page.getByTestId('outgoing-row');
    await expect(row).toContainText('Deploy bot', T);
    await expect(row).toContainText('Nothing sent yet');
    await expect(row).toContainText('!ship');

    await row.getByTestId('outgoing-signing').click();
    const secretBox = page.getByTestId('outgoing-signing-value');
    await expect(secretBox).toBeVisible(T);
    signingSecret = ((await secretBox.textContent()) ?? '').trim();
    expect(signingSecret).toMatch(/^mtos_/);
    await page.getByRole('button', { name: 'I have copied it' }).click();
    await expect(row).toContainText('Signed');

    // "Send test call" reaches the receiver and posts nothing in the channel
    await row.getByTestId('outgoing-test').click();
    await expect(page.getByTestId('outgoing-note')).toContainText('The test reached', T);
    expect(hits).toHaveLength(1);
    hits = [];
    await page.keyboard.press('Escape');

    // a person writes in the channel
    await postAs(nadia, room, 'we should deploy later');   // does not start with the word: nothing is sent
    await postAs(nadia, room, 'deploy the api to prod');
    const reply = page.locator('[data-testid="message"]', { hasText: 'deploy started for prod' });
    await expect(reply).toBeVisible(T);
    await expect(reply).toContainText('Deploy bot');
    await expect(reply).toContainText('Webhook');
    // the reply's "@here" is broken with a zero-width space (Playwright's text matching strips it, so read the raw text)
    const raw = (await reply.first().textContent()) ?? '';
    expect(raw).not.toContain('@here');
    expect(raw).toContain('@​here');
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hits).toHaveLength(1);   // the reply says "deploy" too and did not send anything
    await expect(page.locator('[data-testid="message"]', { hasText: 'deploy started for prod' })).toHaveCount(1);

    const hit = hits[0]!;
    const payload = JSON.parse(hit.body) as Record<string, string>;
    expect(payload).toMatchObject({ text: 'deploy the api to prod', trigger_word: 'deploy', channel_id: room, channel_name: roomName });
    const stamp = String(hit.headers['x-manythreads-request-timestamp']);
    expect(hit.headers['x-manythreads-signature']).toBe(`v0=${createHmac('sha256', signingSecret).update(`v0:${stamp}:${hit.body}`).digest('hex')}`);

    // the screen tells what happened
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-outgoing').click();
    await expect(page.getByTestId('outgoing-row')).toContainText('Last message sent', T);
  } finally {
    await context.close();
  }
});

test('a hook can be paused and a pause sends nothing; on a phone the dialog does not scroll sideways', async ({ browser, playwright }) => {
  hits = [];
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${roomName}`, { viewport: PHONE, mobile: true });
  try {
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-outgoing').click();
    await expect(page.getByTestId('outgoing-row')).toBeVisible(T);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('outgoing-toggle').click();
    await expect(page.getByTestId('outgoing-row')).toContainText('Paused', T);
    await page.getByTestId('integrations-tab-tokens').click();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
    await postAs(nadia, room, 'deploy while paused');
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hits).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test('switching off: the token is refused at once and the hook is gone from the list', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${roomName}`);
  try {
    await page.getByTestId('webhooks-open').click();
    await page.getByTestId('integrations-tab-tokens').click();
    await page.getByTestId('token-revoke').click();
    await page.getByTestId('token-revoke-confirm').click();
    await expect(page.getByTestId('tokens-empty')).toBeVisible(T);
    expect((await slack('chat.postMessage', { channel: room, text: 'after revoke' })).json).toEqual({ ok: false, error: 'invalid_auth' });

    await page.getByTestId('integrations-tab-outgoing').click();
    await page.getByTestId('outgoing-revoke').click();
    await page.getByTestId('outgoing-revoke-confirm').click();
    await expect(page.getByTestId('outgoing-empty')).toBeVisible(T);
    hits = [];
    await postAs(nadia, room, 'deploy after the hook is gone');
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hits).toHaveLength(0);
  } finally {
    await context.close();
  }
});
