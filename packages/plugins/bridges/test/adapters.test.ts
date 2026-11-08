import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BridgeAccountRef, BridgeRequest } from '../src/adapter.ts';
import { telegramAdapter } from '../src/adapters/telegram.ts';
import { whatsappAdapter } from '../src/adapters/whatsapp.ts';
import { BRIDGE_BASES, BRIDGE_HOST_PATTERNS, bridgeCall, BridgeSendError, failureOf, fakeBase, originFor } from '../src/door.ts';

const ref = (over: Partial<BridgeAccountRef> = {}): BridgeAccountRef => ({ id: 'a', workspaceId: 'w', provider: 'telegram', handle: null, externalAppId: null, secrets: {}, ...over });
const req = (headers: Record<string, string>, rawBody = '{}', query: Record<string, string> = {}): BridgeRequest => ({ method: 'POST', headers, query, rawBody: Buffer.from(rawBody), now: Date.now() });

describe('the Telegram adapter', () => {
  const account = ref({ secrets: { inbound_secret: 'right-secret-word' } });

  it('accepts only the exact secret header', () => {
    expect(telegramAdapter.verify(account, req({ 'x-telegram-bot-api-secret-token': 'right-secret-word' })).ok).toBe(true);
    expect(telegramAdapter.verify(account, req({ 'x-telegram-bot-api-secret-token': 'right-secret-wor' })).ok).toBe(false);
    expect(telegramAdapter.verify(account, req({})).ok).toBe(false);
    expect(telegramAdapter.verify(ref(), req({ 'x-telegram-bot-api-secret-token': '' })).ok).toBe(false);
  });

  const update = (message: unknown, id: unknown = 7): unknown => ({ update_id: id, message });
  const base = { message_id: 3, date: 1_700_000_000, from: { id: 42, is_bot: false, username: 'nadia' }, chat: { id: 42, type: 'private' }, text: 'hello' };

  it('reads a private message and a group message', () => {
    const [m] = telegramAdapter.parse(account, update(base));
    expect(m).toMatchObject({ updateId: '7', externalId: '3', chat: { id: '42', kind: 'private' }, sender: { id: '42', label: '@nadia' }, text: 'hello', command: null });
    const [g] = telegramAdapter.parse(account, update({ ...base, chat: { id: -100, type: 'supergroup', title: 'Team' } }));
    expect(g?.chat).toEqual({ id: '-100', kind: 'group', title: 'Team' });
  });

  it('reads commands, with a bot name suffix, and keeps the argument', () => {
    expect(telegramAdapter.parse(account, update({ ...base, text: '/start 12345678' }))[0]?.command).toEqual({ name: 'start', argument: '12345678' });
    expect(telegramAdapter.parse(account, update({ ...base, text: '/connect@kahf_bot 87654321' }))[0]?.command).toEqual({ name: 'connect', argument: '87654321' });
    expect(telegramAdapter.parse(account, update({ ...base, text: '/other thing' }))[0]?.command).toBeNull();
  });

  it('ignores bots, other chat kinds, no text and every odd shape without throwing', () => {
    expect(telegramAdapter.parse(account, update({ ...base, from: { id: 1, is_bot: true } }))).toEqual([]);
    expect(telegramAdapter.parse(account, update({ ...base, chat: { id: 1, type: 'channel' } }))).toEqual([]);
    expect(telegramAdapter.parse(account, update({ ...base, text: undefined }))).toEqual([]);
    for (const hostile of [null, 'x', 5, [], {}, { update_id: 'x' }, { update_id: 1, message: 'x' }, update(base, {}), update({ ...base, chat: null })]) {
      expect(() => telegramAdapter.parse(account, hostile)).not.toThrow();
      expect(telegramAdapter.parse(account, hostile)).toEqual([]);
    }
  });

  it('cleans a hostile display name', () => {
    const [m] = telegramAdapter.parse(account, update({ ...base, from: { id: 42, first_name: `A${String.fromCharCode(0x202e)}\nB` } }));
    expect(m?.sender.label).toBe('A B');
  });
});

describe('the WhatsApp adapter', () => {
  const account = ref({ provider: 'whatsapp', externalAppId: '1234567890', secrets: { app_secret: 'app-secret-0001', inbound_secret: 'verify-word' } });
  const body = (messages: unknown[], numberId = '1234567890'): string => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: numberId }, contacts: [{ wa_id: '4915112345', profile: { name: 'Ann' } }], messages } }] }] });
  const sign = (raw: string, secret = 'app-secret-0001'): string => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('checks the signature over the raw bytes', () => {
    const raw = body([]);
    expect(whatsappAdapter.verify(account, req({ 'x-hub-signature-256': sign(raw) }, raw)).ok).toBe(true);
    expect(whatsappAdapter.verify(account, req({ 'x-hub-signature-256': sign(raw, 'other-secret') }, raw)).ok).toBe(false);
    expect(whatsappAdapter.verify(account, req({ 'x-hub-signature-256': sign(raw) }, `${raw} `)).ok).toBe(false);
    expect(whatsappAdapter.verify(account, req({}, raw)).ok).toBe(false);
    expect(whatsappAdapter.verify(ref({ provider: 'whatsapp' }), req({ 'x-hub-signature-256': sign(raw) }, raw)).ok).toBe(false);
  });

  it('answers the URL check only for the right word and a plain challenge', () => {
    const q = (o: Record<string, string>): BridgeRequest => ({ ...req({}), method: 'GET', query: o });
    expect(whatsappAdapter.challenge?.(account, q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-word', 'hub.challenge': '1158201444' }))).toBe('1158201444');
    expect(whatsappAdapter.challenge?.(account, q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }))).toBeNull();
    expect(whatsappAdapter.challenge?.(account, q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-word', 'hub.challenge': '<script>' }))).toBeNull();
  });

  it('reads text messages from direct chats, and only for its own number', () => {
    const msg = { id: 'wamid.1', from: '4915112345', type: 'text', timestamp: '1700000000', text: { body: '/start 12345678' } };
    const [m] = whatsappAdapter.parse(account, JSON.parse(body([msg])));
    expect(m).toMatchObject({ updateId: 'wamid.1', chat: { id: '4915112345', kind: 'private' }, sender: { id: '4915112345', label: 'Ann' }, command: { name: 'start', argument: '12345678' } });
    expect(whatsappAdapter.parse(account, JSON.parse(body([msg], '999')))).toEqual([]);
  });

  it('skips media, bad numbers and odd shapes without throwing', () => {
    const odd = [{ id: 'x', from: '4915112345', type: 'image' }, { id: 'y', from: 'abc', type: 'text', text: { body: 'hi' } }, { from: '4915112345', type: 'text', text: { body: 'hi' } }, 5, null];
    expect(whatsappAdapter.parse(account, JSON.parse(body(odd)))).toEqual([]);
    for (const hostile of [null, 3, 'x', [], { entry: 'x' }, { entry: [null, { changes: 'x' }] }]) expect(whatsappAdapter.parse(account, hostile)).toEqual([]);
  });
});

describe('the one outbound door', () => {
  it('has a constant host per service, and a token never decides it', () => {
    expect(BRIDGE_BASES.telegram).toBe('https://api.telegram.org');
    expect(BRIDGE_BASES.whatsapp).toBe('https://graph.facebook.com');
    expect(originFor('telegram', null, {})).toBe('https://api.telegram.org');
  });

  it('honours a fake base outside production only, and only as a plain origin', () => {
    expect(fakeBase('telegram', { MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000');
    expect(fakeBase('telegram', { NODE_ENV: 'production', MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE: 'http://127.0.0.1:9000' })).toBeNull();
    expect(fakeBase('telegram', { MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE: 'http://127.0.0.1:9000/path' })).toBeNull();
    expect(fakeBase('telegram', { MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE: 'file:///etc' })).toBeNull();
    expect(fakeBase('telegram', {})).toBeNull();
  });

  it('takes a service address from a payload only when it is on the service list', () => {
    expect(originFor('teams', 'https://smba.trafficmanager.net/emea/', {})).toBe('https://smba.trafficmanager.net');
    expect(originFor('teams', 'https://evil.example.com/', {})).toBeNull();
    expect(originFor('teams', 'http://smba.trafficmanager.net/', {})).toBeNull();
    expect(originFor('teams', 'https://user:pw@smba.trafficmanager.net/', {})).toBeNull();
    expect(originFor('teams', 'https://smba.trafficmanager.net:8443/', {})).toBeNull();
    expect(originFor('telegram', 'https://api.telegram.org/', {})).toBeNull();
    expect(BRIDGE_HOST_PATTERNS.telegram).toBeUndefined();
  });

  it('refuses a path that could change the host', async () => {
    await expect(bridgeCall({ provider: 'telegram', path: '//evil.example.com/x' }, {})).rejects.toBeInstanceOf(BridgeSendError);
    await expect(bridgeCall({ provider: 'telegram', path: 'x' }, {})).rejects.toBeInstanceOf(BridgeSendError);
  });

  it('maps a service answer to a retry rule', () => {
    expect(failureOf(401, null, 'x')).toMatchObject({ retry: false, attention: true });
    expect(failureOf(429, 7, 'x')).toMatchObject({ retry: true, retryAfterMs: 7000 });
    expect(failureOf(500, null, 'x').retry).toBe(true);
    expect(failureOf(400, null, 'x').retry).toBe(false);
  });
});
