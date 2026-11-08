import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeTelegram, type FakeTelegram } from '../src/providers/telegram.ts';
import { call, startReceiver, type Receiver } from './helpers.ts';

let tg: FakeTelegram;
let receiver: Receiver;
let token: string;

beforeEach(async () => {
  tg = await startFakeTelegram();
  receiver = await startReceiver();
  token = tg.bots[0]!.token;
});
afterEach(async () => {
  await tg.stop();
  await receiver.close();
});

const api = (method: string, body?: unknown, bot = token) => call(`${tg.url}/bot${bot}/${method}`, body === undefined ? {} : { body });

describe('the Bot API envelope and its checks', () => {
  it('a wrong token is 401 Unauthorized on every method, and the refusal is recorded', async () => {
    for (const method of ['getMe', 'setWebhook', 'sendMessage', 'getUpdates', 'deleteWebhook']) {
      const r = await api(method, { chat_id: 1, text: 'x', url: 'http://x.test/' }, '1:wrong-token');
      expect(r.status, method).toBe(401);
      expect(r.json).toEqual({ ok: false, error_code: 401, description: 'Unauthorized' });
    }
    expect(tg.calls.filter((c) => !c.authorized)).toHaveLength(5);
    expect(tg.sent).toHaveLength(0);
  });

  it('getMe answers the bot, an unknown method and a path that is not a bot call are 404', async () => {
    const me = await api('getMe');
    expect(me.json).toMatchObject({ ok: true, result: { id: tg.bots[0]!.id, is_bot: true, username: 'manythreads_fake_bot' } });
    expect((await api('nope')).status).toBe(404);
    expect((await call(`${tg.url}/something`)).status).toBe(404);
  });

  it('parameters may come as a query, a form or JSON', async () => {
    const q = await call(`${tg.url}/bot${token}/sendMessage?chat_id=5&text=from+query`);
    expect(q.json.ok).toBe(true);
    const f = await fetch(`${tg.url}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'chat_id=6&text=from+form' });
    expect(((await f.json()) as { ok: boolean }).ok).toBe(true);
    expect(tg.sent.map((m) => [m.chatId, m.text])).toEqual([
      ['5', 'from query'],
      ['6', 'from form'],
    ]);
    const bad = await fetch(`${tg.url}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });
});

describe('setWebhook and the secret token', () => {
  it('keeps the url and the secret, shows neither the secret nor the token in getWebhookInfo', async () => {
    const set = await api('setWebhook', { url: `${receiver.url}/hooks/bridges/telegram/abc`, secret_token: 'S3cret_token-1', allowed_updates: ['message'] });
    expect(set.json).toEqual({ ok: true, result: true, description: 'Webhook was set' });
    const info = await api('getWebhookInfo');
    expect(info.json.result.url).toBe(`${receiver.url}/hooks/bridges/telegram/abc`);
    expect(info.text).not.toContain('S3cret_token-1');
    expect(info.text).not.toContain(token);
    expect(tg.webhook()).toEqual({ url: `${receiver.url}/hooks/bridges/telegram/abc`, secretToken: 'S3cret_token-1' });
  });

  it('refuses a secret with characters Telegram does not allow, a long one, and a url that is not http(s)', async () => {
    expect((await api('setWebhook', { url: `${receiver.url}/h`, secret_token: 'has space' })).json.description).toContain('secret token contains unallowed characters');
    expect((await api('setWebhook', { url: `${receiver.url}/h`, secret_token: 'a'.repeat(257) })).status).toBe(400);
    expect((await api('setWebhook', { url: 'ftp://x.test/h' })).status).toBe(400);
    expect((await api('setWebhook', { url: 'not a url' })).status).toBe(400);
    expect(tg.webhook()).toBeNull();
  });

  it('deleteWebhook removes it; an empty url does the same', async () => {
    await api('setWebhook', { url: `${receiver.url}/h`, secret_token: 'abc' });
    expect((await api('deleteWebhook')).json.description).toBe('Webhook was deleted');
    expect(tg.webhook()).toBeNull();
    await api('setWebhook', { url: `${receiver.url}/h` });
    await api('setWebhook', { url: '' });
    expect(tg.webhook()).toBeNull();
  });
});

describe('a person writing to the bot', () => {
  it('POSTs the Update to the webhook with the secret token in X-Telegram-Bot-Api-Secret-Token', async () => {
    await api('setWebhook', { url: `${receiver.url}/hook`, secret_token: 'Right_Secret-9' });
    const result = await tg.telegramSend({ fromUserId: 77, username: 'nadia', firstName: 'Nadia', text: 'hello bot' });
    expect(result).toMatchObject({ delivered: true, queued: false, updateId: 1000 });
    expect(result.responses[0]!.status).toBe(200);
    const got = receiver.received[0]!;
    expect(got.method).toBe('POST');
    expect(got.path).toBe('/hook');
    expect(got.headers['x-telegram-bot-api-secret-token']).toBe('Right_Secret-9');
    const update = JSON.parse(got.body) as { update_id: number; message: { text: string; from: { id: number; is_bot: boolean; username: string }; chat: { id: number; type: string } } };
    expect(update.update_id).toBe(1000);
    expect(update.message).toMatchObject({ text: 'hello bot', from: { id: 77, is_bot: false, username: 'nadia' }, chat: { id: 77, type: 'private' } });
    expect(tg.deliveries).toEqual([{ botId: tg.bots[0]!.id, updateId: 1000, status: 200, secretHeader: 'right' }]);
  });

  it('a wrong or missing secret header goes out as asked, and the answer of the bridge comes back', async () => {
    await api('setWebhook', { url: `${receiver.url}/hook`, secret_token: 'Right_Secret-9' });
    receiver.answer = (r) => (r.headers['x-telegram-bot-api-secret-token'] === 'Right_Secret-9' ? { status: 200 } : { status: 401 });
    const wrong = await tg.telegramSend({ fromUserId: 1, text: 'x', secretHeader: 'wrong' });
    const missing = await tg.telegramSend({ fromUserId: 1, text: 'x', secretHeader: 'missing' });
    const right = await tg.telegramSend({ fromUserId: 1, text: 'x' });
    expect([wrong, missing, right].map((r) => r.responses[0]!.status)).toEqual([401, 401, 200]);
    expect(receiver.received[0]!.headers['x-telegram-bot-api-secret-token']).not.toBe('Right_Secret-9');
    expect(receiver.received[1]!.headers['x-telegram-bot-api-secret-token']).toBeUndefined();
    expect(tg.deliveries.map((d) => d.secretHeader)).toEqual(['wrong', 'missing', 'right']);
  });

  it('with no secret set the header is not sent at all', async () => {
    await api('setWebhook', { url: `${receiver.url}/hook` });
    await tg.telegramSend({ fromUserId: 1, text: 'x' });
    expect(receiver.received[0]!.headers['x-telegram-bot-api-secret-token']).toBeUndefined();
    expect(tg.deliveries[0]!.secretHeader).toBe('none-set');
  });

  it('a replay is the same update id posted again; a group message carries a title and a negative chat id; a command carries its entity', async () => {
    await api('setWebhook', { url: `${receiver.url}/hook`, secret_token: 'abc' });
    const first = await tg.telegramSend({ fromUserId: 5, chatType: 'supergroup', chatId: -100123, chatTitle: 'Support chat', text: '/connect 12345678', updateId: 4242, repeat: 2 });
    expect(first.responses).toHaveLength(2);
    expect(receiver.received.map((r) => (JSON.parse(r.body) as { update_id: number }).update_id)).toEqual([4242, 4242]);
    const m = (JSON.parse(receiver.received[0]!.body) as { message: { chat: { id: number; type: string; title: string }; entities: Array<{ type: string; length: number }> } }).message;
    expect(m.chat).toMatchObject({ id: -100123, type: 'supergroup', title: 'Support chat' });
    expect(m.entities).toEqual([{ offset: 0, length: '/connect'.length, type: 'bot_command' }]);
  });

  it('a bridge that cannot be reached is reported as null, not thrown', async () => {
    await api('setWebhook', { url: 'http://127.0.0.1:1/hook' });
    const r = await tg.telegramSend({ fromUserId: 1, text: 'x' });
    expect(r.responses).toEqual([{ status: null, body: '' }]);
  });

  it('with no webhook the update is queued; getUpdates returns it, an offset confirms it, and a webhook makes getUpdates a 409', async () => {
    const queued = await tg.telegramSend({ fromUserId: 3, text: 'one' });
    await tg.telegramSend({ fromUserId: 3, text: 'two' });
    expect(queued).toMatchObject({ delivered: false, queued: true });
    const all = await api('getUpdates');
    expect(all.json.result.map((u: { message: { text: string } }) => u.message.text)).toEqual(['one', 'two']);
    const after = await api('getUpdates', { offset: 1001 });
    expect(after.json.result.map((u: { message: { text: string } }) => u.message.text)).toEqual(['two']);
    await api('setWebhook', { url: `${receiver.url}/h` });
    const conflict = await api('getUpdates');
    expect(conflict.status).toBe(409);
    expect(conflict.json.description).toContain('webhook is active');
  });
});

describe('sendMessage', () => {
  it('records the message and answers the way Telegram does', async () => {
    const r = await api('sendMessage', { chat_id: 77, text: 'Hello from the bot', parse_mode: 'MarkdownV2', reply_to_message_id: 9 });
    expect(r.json).toMatchObject({ ok: true, result: { message_id: 1, from: { is_bot: true }, chat: { id: 77, type: 'private' }, text: 'Hello from the bot' } });
    expect(tg.sent).toMatchObject([{ messageId: 1, botId: tg.bots[0]!.id, chatId: '77', text: 'Hello from the bot', parseMode: 'MarkdownV2', replyToMessageId: 9 }]);
    expect((await api('sendMessage', { chat_id: -1001, text: 'g' })).json.result.chat.type).toBe('supergroup');
  });

  it('refuses a missing chat, a missing or an over-long text', async () => {
    expect((await api('sendMessage', { text: 'x' })).json.description).toBe('Bad Request: chat_id is empty');
    expect((await api('sendMessage', { chat_id: 1 })).json.description).toBe('Bad Request: message text is empty');
    expect((await api('sendMessage', { chat_id: 1, text: 'x'.repeat(4097) })).json.description).toBe('Bad Request: message is too long');
    expect((await api('sendMessage', { chat_id: 1, text: 'x'.repeat(4096) })).json.ok).toBe(true);
    expect(tg.sent).toHaveLength(1);
  });

  it('with strictChats a bot may only write to a chat that wrote to it first', async () => {
    const strict = await startFakeTelegram({ strictChats: true });
    try {
      const url = `${strict.url}/bot${strict.bots[0]!.token}/sendMessage`;
      expect((await call(url, { body: { chat_id: 88, text: 'hi' } })).status).toBe(403);
      await strict.telegramSend({ fromUserId: 88, text: 'start' });
      expect((await call(url, { body: { chat_id: 88, text: 'hi' } })).status).toBe(200);
    } finally {
      await strict.stop();
    }
  });

  it('failNext makes the next calls fail; 429 carries retry_after', async () => {
    tg.failNext(429, 1, { method: 'sendMessage', retryAfter: 7 });
    const limited = await api('sendMessage', { chat_id: 1, text: 'x' });
    expect(limited.status).toBe(429);
    expect(limited.json).toMatchObject({ ok: false, error_code: 429, parameters: { retry_after: 7 } });
    expect((await api('sendMessage', { chat_id: 1, text: 'x' })).status).toBe(200);
    tg.failNext(500, 2);
    expect((await api('getMe')).status).toBe(500);
    expect((await api('getMe')).status).toBe(500);
    expect((await api('getMe')).status).toBe(200);
  });
});

describe('several bots, and what is never kept', () => {
  it('each bot has its own token, webhook and queue', async () => {
    const two = await startFakeTelegram({ bots: [{}, { username: 'second_bot' }] });
    try {
      const [a, b] = two.bots;
      await call(`${two.url}/bot${b!.token}/setWebhook`, { body: { url: `${receiver.url}/second`, secret_token: 'two' } });
      expect(two.webhook(a!.token)).toBeNull();
      expect(two.webhook(b!.token)?.url).toBe(`${receiver.url}/second`);
      await two.telegramSend({ botToken: b!.token, fromUserId: 1, text: 'to second' });
      expect(receiver.received[0]!.path).toBe('/second');
      expect((await call(`${two.url}/bot${b!.token}/getMe`)).json.result.username).toBe('second_bot');
    } finally {
      await two.stop();
    }
  });

  it('reset forgets messages, calls, webhooks and queues but keeps the bots', async () => {
    await api('setWebhook', { url: `${receiver.url}/h`, secret_token: 'abc' });
    await api('sendMessage', { chat_id: 1, text: 'x' });
    tg.reset();
    expect(tg.sent).toHaveLength(0);
    expect(tg.calls).toHaveLength(0);
    expect(tg.webhook()).toBeNull();
    expect((await api('getMe')).status).toBe(200);
  });
});
