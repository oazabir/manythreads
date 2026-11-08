import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_WHATSAPP_APP_SECRET, FAKE_WHATSAPP_VERIFY_TOKEN, startFakeWhatsapp, type FakeWhatsapp } from '../src/providers/whatsapp.ts';
import { call, startReceiver, type Receiver } from './helpers.ts';

let wa: FakeWhatsapp;
let receiver: Receiver;
let id: string;
let token: string;

beforeEach(async () => {
  wa = await startFakeWhatsapp();
  receiver = await startReceiver();
  id = wa.numbers[0]!.phoneNumberId;
  token = wa.numbers[0]!.token;
});
afterEach(async () => {
  await wa.stop();
  await receiver.close();
});

const post = (body: unknown, bearer = token, number = id) => call(`${wa.url}/v21.0/${number}/messages`, { body, headers: { authorization: `Bearer ${bearer}` } });
const text = (to: string, body: string) => ({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body } });

describe('the Graph API calls the bridge makes', () => {
  it('answers the number for a right token and 401 OAuthException for a wrong one', async () => {
    const ok = await call(`${wa.url}/v21.0/${id}?fields=display_phone_number`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.json).toMatchObject({ id, display_phone_number: wa.numbers[0]!.displayNumber });
    const bad = await call(`${wa.url}/v21.0/${id}?fields=display_phone_number`, { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    expect(bad.json.error.type).toBe('OAuthException');
    expect(wa.calls.some((c) => !c.authorized)).toBe(true);
  });

  it('a text to a person who wrote in the last 24 hours is sent; one who did not is refused with 131047', async () => {
    wa.setCallback(`${receiver.url}/hooks/bridges/whatsapp/a1`);
    expect((await post(text('15550001111', 'hello'))).status).toBe(400);
    await wa.whatsappSend({ fromNumber: '15550001111', text: 'hi' });
    const sent = await post(text('15550001111', 'hello'));
    expect(sent.status).toBe(200);
    expect(sent.json.messages[0].id).toMatch(/^wamid\./);
    expect(wa.sent.map((m) => m.text)).toEqual(['hello']);
    wa.closeWindow('15550001111');
    const late = await post(text('15550001111', 'again'));
    expect(late.status).toBe(400);
    expect(late.json.error.code).toBe(131047);
  });

  it('checks the shape: product, a number, a text of at most 4096 characters', async () => {
    wa.setCallback(`${receiver.url}/x`);
    await wa.whatsappSend({ fromNumber: '15550002222', text: 'hi' });
    expect((await post({ ...text('15550002222', 'x'), messaging_product: 'sms' })).status).toBe(400);
    expect((await post(text('not-a-number', 'x'))).status).toBe(400);
    expect((await post(text('15550002222', ''))).status).toBe(400);
    expect((await post(text('15550002222', 'x'.repeat(4097)))).status).toBe(400);
    expect((await post(text('15550002222', 'x'.repeat(4096)))).status).toBe(200);
  });

  it('a failure can be scripted', async () => {
    wa.failNext(500);
    expect((await call(`${wa.url}/v21.0/${id}?fields=display_phone_number`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(500);
    expect((await call(`${wa.url}/v21.0/${id}?fields=display_phone_number`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('a person writing to the number', () => {
  it('posts the Cloud API payload signed with the app secret', async () => {
    wa.setCallback(`${receiver.url}/hooks/bridges/whatsapp/a1`);
    const r = await wa.whatsappSend({ fromNumber: '15550003333', name: 'Nadia', text: 'hello there', messageId: 'wamid.X1' });
    expect(r.responses[0]!.status).toBe(200);
    const got = receiver.received[0]!;
    expect(got.headers['x-hub-signature-256']).toBe(`sha256=${createHmac('sha256', FAKE_WHATSAPP_APP_SECRET).update(got.body).digest('hex')}`);
    const value = JSON.parse(got.body).entry[0].changes[0].value;
    expect(value.metadata.phone_number_id).toBe(id);
    expect(value.contacts[0]).toEqual({ profile: { name: 'Nadia' }, wa_id: '15550003333' });
    expect(value.messages[0]).toMatchObject({ from: '15550003333', id: 'wamid.X1', type: 'text', text: { body: 'hello there' } });
  });

  it('can sign wrongly, send no signature, and send the same message twice', async () => {
    wa.setCallback(`${receiver.url}/x`);
    await wa.whatsappSend({ fromNumber: '15550004444', text: 'a', signature: 'wrong' });
    await wa.whatsappSend({ fromNumber: '15550004444', text: 'b', signature: 'missing' });
    expect(receiver.received[1]!.headers['x-hub-signature-256']).toBeUndefined();
    const twice = await wa.whatsappSend({ fromNumber: '15550004444', text: 'c', repeat: 2, messageId: 'wamid.SAME' });
    expect(twice.responses).toHaveLength(2);
    expect(wa.deliveries.map((d) => d.signature)).toEqual(['wrong', 'missing', 'right', 'right']);
    expect(receiver.received.filter((r) => r.body.includes('wamid.SAME'))).toHaveLength(2);
  });

  it('the one-time URL check sends the verify word and a challenge; a wrong word is sent on request', async () => {
    receiver.answer = (r) => ({ status: 200, body: new URL(r.path, 'http://x').searchParams.get('hub.challenge') ?? '' });
    wa.setCallback(`${receiver.url}/hooks/bridges/whatsapp/a1`);
    const r = await wa.whatsappVerify();
    expect(r).toEqual({ status: 200, body: '1158201444' });
    const q = new URL(receiver.received[0]!.path, 'http://x').searchParams;
    expect(q.get('hub.mode')).toBe('subscribe');
    expect(q.get('hub.verify_token')).toBe(FAKE_WHATSAPP_VERIFY_TOKEN);
    await wa.whatsappVerify({ token: 'wrong' });
    expect(new URL(receiver.received[1]!.path, 'http://x').searchParams.get('hub.verify_token')).toBe('wrong');
  });

  it('state() never shows the access token or the app secret', async () => {
    const { whatsappModule } = await import('../src/providers/whatsapp.ts');
    const handle = await whatsappModule.start({ host: '127.0.0.1', publicHost: '127.0.0.1', port: 0, seedKey: 'k', seedGrants: [], accounts: undefined, clientId: undefined, clientSecret: undefined, options: undefined });
    try {
      const api = handle.api as FakeWhatsapp;
      expect(JSON.stringify(handle.state())).not.toContain(api.numbers[0]!.token);
      expect(JSON.stringify(handle.state())).not.toContain(FAKE_WHATSAPP_APP_SECRET);
      expect(handle.env()['MANYTHREADS_BRIDGE_WHATSAPP_FAKE_BASE']).toBe(api.url);
    } finally {
      await handle.stop();
    }
  });
});
