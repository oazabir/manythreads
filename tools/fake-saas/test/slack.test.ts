import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_SLACK_BOT_TOKEN, startFakeSlack, type FakeSlack } from '../src/providers/slack.ts';
import { call, startReceiver, type Receiver } from './helpers.ts';

let slack: FakeSlack;
let receiver: Receiver;

beforeEach(async () => {
  slack = await startFakeSlack();
  receiver = await startReceiver();
});
afterEach(async () => {
  await slack.stop();
  await receiver.close();
});

const api = (method: string, body: unknown, token: string = FAKE_SLACK_BOT_TOKEN) => call(`${slack.url}/api/${method}`, { body, token });

describe('the Web API calls the bridge makes', () => {
  it('auth.test answers for the right token and not_authed-style invalid_auth for a wrong one', async () => {
    const ok = await api('auth.test', {});
    expect(ok.json).toMatchObject({ ok: true, user_id: slack.botUserId });
    const bad = await api('auth.test', {}, 'xoxb-nope');
    expect(bad.json).toEqual({ ok: false, error: 'invalid_auth' });
  });

  it('chat.postMessage records the message and checks the channel and the text', async () => {
    const sent = await api('chat.postMessage', { channel: 'C0FAKE001', text: 'hello' });
    expect(sent.json).toMatchObject({ ok: true, channel: 'C0FAKE001' });
    expect(slack.sent.map((m) => m.text)).toEqual(['hello']);
    expect((await api('chat.postMessage', { channel: 'nope', text: 'x' })).json.error).toBe('channel_not_found');
    expect((await api('chat.postMessage', { channel: 'C0FAKE001', text: '' })).json.error).toBe('no_text');
  });

  it('a failure can be scripted: a busy 429 with Retry-After, and an ok:false answer', async () => {
    slack.failNext(429, 1, 7);
    const busy = await api('chat.postMessage', { channel: 'C0FAKE001', text: 'x' });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('7');
    slack.failNextOk('token_revoked');
    expect((await api('chat.postMessage', { channel: 'C0FAKE001', text: 'x' })).json.error).toBe('token_revoked');
    expect((await api('chat.postMessage', { channel: 'C0FAKE001', text: 'fine' })).json.ok).toBe(true);
  });

  it('with strict channels a bot posts only where it was added', async () => {
    const strict = await startFakeSlack({ strictChannels: true });
    try {
      const post = () => call(`${strict.url}/api/chat.postMessage`, { body: { channel: 'C0FAKE002', text: 'x' }, token: strict.botToken });
      expect((await post()).json.error).toBe('not_in_channel');
      strict.addToChannel('C0FAKE002');
      expect((await post()).json.ok).toBe(true);
    } finally {
      await strict.stop();
    }
  });
});

describe('the events it sends', () => {
  it('signs each event, and the wrong, missing, stale and future kinds are marked as such', async () => {
    slack.setCallback(`${receiver.url}/hooks/bridges/slack/a1`);
    for (const signature of [undefined, 'wrong', 'missing', 'stale', 'future'] as const) await slack.slackSend({ user: 'U0PERSON1', channel: 'D0FAKE0001', channelType: 'im', text: 'hi', ...(signature ? { signature } : {}) });
    expect(receiver.received).toHaveLength(5);
    expect(receiver.received[0]!.headers['x-slack-signature']).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(receiver.received[2]!.headers['x-slack-signature']).toBeUndefined();
    const stamp = (i: number): number => Number(receiver.received[i]!.headers['x-slack-request-timestamp']);
    expect(Date.now() / 1000 - stamp(3)).toBeGreaterThan(500);
    expect(stamp(4) - Date.now() / 1000).toBeGreaterThan(500);
    expect(slack.deliveries.map((d) => d.signature)).toEqual(['right', 'wrong', 'missing', 'stale', 'future']);
  });

  it('plays a retry (same event id twice), a bot post, a subtype, and the url check', async () => {
    slack.setCallback(`${receiver.url}/x`);
    receiver.answer = (r) => ({ status: 200, body: r.body.includes('url_verification') ? (JSON.parse(r.body) as { challenge: string }).challenge : '' });
    await slack.slackSend({ user: 'U0PERSON1', channel: 'C0FAKE001', text: 'again', eventId: 'Ev1', repeat: 2 });
    await slack.slackSend({ user: 'U0FAKEBOT1', channel: 'C0FAKE001', text: 'echo', botId: 'B0FAKE0001' });
    await slack.slackSend({ user: 'U0PERSON1', channel: 'C0FAKE001', text: 'edited', subtype: 'message_changed' });
    const bodies = receiver.received.map((r) => JSON.parse(r.body) as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(bodies.filter((b) => b['event_id'] === 'Ev1')).toHaveLength(2);
    expect(bodies[2]!['event']['bot_id']).toBe('B0FAKE0001');
    expect(bodies[3]!['event']['subtype']).toBe('message_changed');
    const check = await slack.slackVerify({ challenge: 'abc123' });
    expect(check).toMatchObject({ status: 200, body: 'abc123' });
  });

  it('refuses to send with no callback address', async () => {
    await expect(slack.slackSend({ user: 'U0PERSON1', channel: 'C0FAKE001', text: 'x' })).rejects.toThrow(/callback/);
  });
});
