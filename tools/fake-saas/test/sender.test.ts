import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WEBHOOK_KINDS, WEBHOOK_PROVIDERS, buildWebhook, sendWebhook, type Tamper, type WebhookProvider } from '../src/providers/sender.ts';
import { startReceiver, type Receiver } from './helpers.ts';

/*
 * The sender is checked against references written HERE, from each provider's documentation, and not against the sender's own code or the verifiers the webhooks
 * plugin will have: `reference(provider)` below knows only the header names, the recipe and the time window of the provider. A verifier written later is tested
 * against the same truth.
 */

const SECRET = 'whsec-test-secret-0001';
const NOW = new Date('2026-11-08T12:00:00.000Z');
const URL_ = 'https://manythreads.example/hooks/apps/6f1d2c3e-0000-4000-8000-000000000001';
const MINUTE = 60_000;

const hmacHex = (alg: string, key: string, text: string): string => createHmac(alg, key).update(text, 'utf8').digest('hex');
const hmacB64 = (key: string, text: string): string => createHmac('sha256', key).update(text, 'utf8').digest('base64');

interface Verdict {
  /** The proof matches the body under the secret. */
  signed: boolean;
  /** How old the provider's own timestamp says the call is, in milliseconds (null: the provider sends none). */
  ageMs: number | null;
}

/** What a receiver that follows the provider's documentation concludes about a call. */
function reference(provider: WebhookProvider, secret: string, headers: Record<string, string>, body: string, now: Date, url: string): Verdict {
  const h = (name: string): string | undefined => headers[name.toLowerCase()];
  switch (provider) {
    case 'github': // https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
      return { signed: h('X-Hub-Signature-256') === `sha256=${hmacHex('sha256', secret, body)}`, ageMs: null };
    case 'gitlab': // https://docs.gitlab.com/user/project/integrations/webhooks/#validate-payloads-by-using-a-secret-token
      return { signed: h('X-Gitlab-Token') === secret, ageMs: null };
    case 'jira': // https://developer.atlassian.com/cloud/jira/platform/webhooks/#secure-admin-webhooks
      return { signed: h('X-Hub-Signature') === `sha256=${hmacHex('sha256', secret, body)}`, ageMs: null };
    case 'linear': {
      // https://linear.app/developers/webhooks#securing-webhooks
      const stamp = (JSON.parse(body) as { webhookTimestamp?: number }).webhookTimestamp;
      return { signed: h('Linear-Signature') === hmacHex('sha256', secret, body), ageMs: typeof stamp === 'number' ? now.getTime() - stamp : null };
    }
    case 'zendesk': {
      // https://developer.zendesk.com/documentation/webhooks/verifying/
      const stamp = h('X-Zendesk-Webhook-Signature-Timestamp') ?? '';
      return { signed: h('X-Zendesk-Webhook-Signature') === hmacB64(secret, stamp + body), ageMs: now.getTime() - Date.parse(stamp) };
    }
    case 'intercom': // https://developers.intercom.com/docs/webhooks/webhook-notifications#signed-notifications
      return { signed: h('X-Hub-Signature') === `sha1=${hmacHex('sha1', secret, body)}`, ageMs: null };
    case 'hubspot': {
      // https://developers.hubspot.com/docs/api/webhooks/validating-requests (v3: method + uri + body + timestamp)
      const stamp = h('X-HubSpot-Request-Timestamp') ?? '';
      return { signed: h('X-HubSpot-Signature-v3') === hmacB64(secret, `POST${url}${body}${stamp}`), ageMs: now.getTime() - Number(stamp) };
    }
    case 'asana': // https://developers.asana.com/docs/webhooks-guide (X-Hook-Signature after the handshake)
      return { signed: h('X-Hook-Signature') === hmacHex('sha256', secret, body), ageMs: null };
    case 'generic': {
      // our own: Slack's recipe with our header names (v0:<seconds>:<body>)
      const stamp = h('X-Manythreads-Request-Timestamp') ?? '';
      return { signed: h('X-Manythreads-Signature') === `v0=${hmacHex('sha256', secret, `v0:${stamp}:${body}`)}`, ageMs: now.getTime() - Number(stamp) * 1000 };
    }
  }
}

const KIND: Record<WebhookProvider, string> = {
  github: 'issue.created',
  gitlab: 'issue.created',
  jira: 'issue.updated',
  linear: 'issue.created',
  zendesk: 'ticket.created',
  intercom: 'conversation.created',
  hubspot: 'ticket.created',
  asana: 'task.created',
  generic: 'ticket.created',
};

const build = (provider: WebhookProvider, tamper: Tamper = 'none') => buildWebhook({ provider, url: URL_, secret: SECRET, kind: KIND[provider], tamper, now: NOW });
const lowerHeaders = (headers: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
const verdict = (provider: WebhookProvider, built: ReturnType<typeof build>): Verdict => reference(provider, SECRET, lowerHeaders(built.headers), built.body, NOW, built.url);

describe('documented test vectors', () => {
  it('GitHub: the published example signs to the published value', () => {
    // from GitHub's "Validating webhook deliveries": secret "It's a Secret to Everybody", payload "Hello, World!"
    const built = buildWebhook({ provider: 'github', url: URL_, secret: "It's a Secret to Everybody", kind: 'push', body: 'Hello, World!' });
    expect(built.headers['x-hub-signature-256']).toBe('sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17');
  });

  it("Slack's published v0 example is what the generic scheme computes (same recipe, our header names)", () => {
    // from Slack's "Verifying requests from Slack": signing secret, timestamp and body of the published example
    const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    const built = buildWebhook({ provider: 'generic', url: URL_, secret: '8f742231b10e8888abcd99yyyzzz85a5', kind: 'x', body, now: new Date(1531420618 * 1000) });
    expect(built.headers['x-manythreads-request-timestamp']).toBe('1531420618');
    expect(built.headers['x-manythreads-signature']).toBe('v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503');
  });
});

describe('every provider signs its own way', () => {
  it.each(WEBHOOK_PROVIDERS)('%s: an untampered call verifies against the reference and is fresh', (provider) => {
    const built = build(provider);
    const v = verdict(provider, built);
    expect(v.signed).toBe(true);
    if (v.ageMs !== null) expect(Math.abs(v.ageMs)).toBeLessThan(MINUTE);
    expect(built.repeat).toBe(1);
    expect(built.method).toBe('POST');
    expect(() => JSON.parse(built.body)).not.toThrow();
  });

  it.each(WEBHOOK_PROVIDERS)('%s: a signature made with another secret does not verify', (provider) => {
    expect(verdict(provider, build(provider, 'signature')).signed).toBe(false);
  });

  it.each(WEBHOOK_PROVIDERS.filter((p) => p !== 'gitlab'))('%s: a body changed after signing does not verify', (provider) => {
    const built = build(provider, 'body');
    expect(verdict(provider, built).signed).toBe(false);
    expect(() => JSON.parse(built.body)).not.toThrow();
  });

  it('gitlab: the token is not a signature over the body, so a changed body still carries the token (the door cannot tell; the replay window is the defence)', () => {
    expect(verdict('gitlab', build('gitlab', 'body')).signed).toBe(true);
  });

  it.each(WEBHOOK_PROVIDERS)('%s: unsigned carries no proof at all', (provider) => {
    const built = build(provider, 'unsigned');
    expect(verdict(provider, built).signed).toBe(false);
    expect(Object.keys(built.headers).filter((k) => /signature|token|hook-secret/i.test(k) && !/event-uuid/i.test(k))).toEqual([]);
  });

  it.each(['linear', 'zendesk', 'hubspot', 'generic'] as const)('%s: stale is correctly signed but its own timestamp is 10 minutes old', (provider) => {
    const v = verdict(provider, build(provider, 'stale'));
    expect(v.signed).toBe(true);
    expect(v.ageMs).toBe(10 * MINUTE);
  });

  it.each(['github', 'gitlab', 'jira', 'intercom', 'asana'] as const)('%s: stale (no timestamp in the proof) is correctly signed and the event itself is 8 days old', (provider) => {
    const built = build(provider, 'stale');
    expect(verdict(provider, built).signed).toBe(true);
    const times = [...built.body.matchAll(/"(?:created_at|updated_at|timestamp|created)":\s*("[^"]+"|\d+)/g)].map((m) => {
      const raw = JSON.parse(m[1]!) as string | number;
      return typeof raw === 'number' ? (raw < 1e11 ? raw * 1000 : raw) : Date.parse(raw);
    });
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(NOW.getTime() - t).toBe(8 * 24 * 60 * MINUTE);
  });

  it('replay posts the same call twice with the same delivery id', () => {
    const built = build('github', 'replay');
    expect(built.repeat).toBe(2);
    expect(built.headers['x-github-delivery']).toBe(built.deliveryId);
    expect(verdict('github', built).signed).toBe(true);
  });

  it('the headers each provider names for its event and its delivery are there', () => {
    expect(build('github').headers['x-github-event']).toBe('issues');
    expect(build('github').headers['x-github-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    expect(build('gitlab').headers['x-gitlab-event']).toBe('Issue Hook');
    expect(build('jira').headers['x-atlassian-webhook-identifier']).toMatch(/^[0-9a-f-]{36}$/);
    expect(build('linear').headers['linear-delivery']).toMatch(/^[0-9a-f-]{36}$/);
    expect(build('zendesk').headers['x-zendesk-webhook-invocation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const zd = JSON.parse(build('zendesk').body) as { type: string; detail: { subject: string } };
    expect(zd.type).toBe('zen:event-type:ticket.created');
    expect(zd.detail.subject).toBe('Printer on fire');
    expect((JSON.parse(build('intercom').body) as { topic: string }).topic).toBe('conversation.user.created');
    expect(Array.isArray(JSON.parse(build('hubspot').body))).toBe(true);
  });

  it('the Zendesk timestamp is ISO 8601 to the second and HubSpot signs the address it was given', () => {
    expect(build('zendesk').headers['x-zendesk-webhook-signature-timestamp']).toBe('2026-11-08T12:00:00Z');
    const a = buildWebhook({ provider: 'hubspot', url: `${URL_}`, secret: SECRET, kind: 'contact.created', now: NOW, deliveryId: 'aaaaaaaa-0000-4000-8000-000000000000' });
    const b = buildWebhook({ provider: 'hubspot', url: `${URL_}x`, secret: SECRET, kind: 'contact.created', now: NOW, deliveryId: 'aaaaaaaa-0000-4000-8000-000000000000' });
    expect(a.headers['x-hubspot-signature-v3']).not.toBe(b.headers['x-hubspot-signature-v3']);
  });

  it('an unknown kind or provider is refused with the list of known ones', () => {
    expect(() => buildWebhook({ provider: 'zendesk', url: URL_, secret: SECRET, kind: 'nope' })).toThrow(/ticket\.created/);
    expect(() => buildWebhook({ provider: 'nope' as WebhookProvider, url: URL_, secret: SECRET, kind: 'x' })).toThrow(/unknown provider/);
    expect(() => buildWebhook({ provider: 'github', url: URL_, secret: SECRET, kind: 'push', tamper: 'nope' as Tamper })).toThrow(/unknown tamper/);
  });

  it('every kind of every provider builds and its title travels', () => {
    for (const provider of WEBHOOK_PROVIDERS) {
      for (const kind of provider === 'generic' ? ['anything.at.all'] : WEBHOOK_KINDS[provider]) {
        const built = buildWebhook({ provider, url: URL_, secret: SECRET, kind, title: 'Needle title', now: NOW });
        expect(() => JSON.parse(built.body)).not.toThrow();
        if (kind !== 'handshake' && kind !== 'push' && !(provider === 'intercom' && kind === 'contact.created')) expect(built.body, `${provider} ${kind}`).toContain('Needle title');
        if (kind !== 'handshake') expect(verdict(provider, built).signed, `${provider} ${kind}`).toBe(true);
      }
    }
  });

  it('padBytes makes a body of at least that size, still signed', () => {
    for (const provider of WEBHOOK_PROVIDERS) {
      const built = buildWebhook({ provider, url: URL_, secret: SECRET, kind: KIND[provider], now: NOW, padBytes: 1_500_000 });
      expect(Buffer.byteLength(built.body)).toBeGreaterThanOrEqual(1_500_000);
      expect(verdict(provider, built).signed).toBe(true);
    }
  });
});

describe('Asana: handshake, then signed events', () => {
  it('the handshake carries X-Hook-Secret and no signature; the events are signed with that secret', () => {
    const hs = buildWebhook({ provider: 'asana', url: URL_, secret: 'hook-secret-1', kind: 'handshake', now: NOW });
    expect(hs.headers['x-hook-secret']).toBe('hook-secret-1');
    expect(hs.headers['x-hook-signature']).toBeUndefined();
    const ev = buildWebhook({ provider: 'asana', url: URL_, secret: 'hook-secret-1', kind: 'task.created', now: NOW });
    expect(ev.headers['x-hook-signature']).toBe(createHmac('sha256', 'hook-secret-1').update(ev.body).digest('hex'));
    expect(ev.headers['x-hook-secret']).toBeUndefined();
  });
});

describe('over a real socket', () => {
  let receiver: Receiver | undefined;
  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
  });

  it('posts the call and returns the answer; the receiver sees the bytes that were signed', async () => {
    receiver = await startReceiver();
    receiver.answer = () => ({ status: 200, body: '{"ok":true}' });
    const result = await sendWebhook({ provider: 'zendesk', url: `${receiver.url}/hooks/apps/x`, secret: SECRET, kind: 'ticket.created' });
    expect(result.responses.map((r) => r.status)).toEqual([200]);
    const got = receiver.received[0]!;
    expect(got.method).toBe('POST');
    expect(got.path).toBe('/hooks/apps/x');
    const v = reference('zendesk', SECRET, got.headers, got.body, new Date(), `${receiver.url}/hooks/apps/x`);
    expect(v.signed).toBe(true);
    expect(Math.abs(v.ageMs!)).toBeLessThan(MINUTE);
  });

  it('replay posts two identical calls', async () => {
    receiver = await startReceiver();
    const result = await sendWebhook({ provider: 'github', url: `${receiver.url}/h`, secret: SECRET, kind: 'push', tamper: 'replay' });
    expect(result.responses).toHaveLength(2);
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[0]!.body).toBe(receiver.received[1]!.body);
    expect(receiver.received[0]!.headers['x-github-delivery']).toBe(receiver.received[1]!.headers['x-github-delivery']);
  });

  it('the Asana handshake can be answered by echoing the header, and the answer headers come back', async () => {
    receiver = await startReceiver();
    receiver.answer = (r) => ({ status: 200, headers: { 'x-hook-secret': r.headers['x-hook-secret'] ?? '' } });
    const result = await sendWebhook({ provider: 'asana', url: `${receiver.url}/h`, secret: 'hs-9', kind: 'handshake' });
    expect(result.responses[0]!.headers['x-hook-secret']).toBe('hs-9');
  });

  it('does not follow redirects and cuts a long answer', async () => {
    receiver = await startReceiver();
    receiver.answer = () => ({ status: 302, headers: { location: 'http://127.0.0.1:1/' }, body: 'y'.repeat(5000) });
    const result = await sendWebhook({ provider: 'generic', url: `${receiver.url}/h`, secret: SECRET, kind: 'a.b' });
    expect(result.responses[0]!.status).toBe(302);
    expect(result.responses[0]!.body.length).toBe(2048);
    expect(receiver.received).toHaveLength(1);
  });

  it('the result never carries the secret', async () => {
    receiver = await startReceiver();
    const result = await sendWebhook({ provider: 'gitlab', url: `${receiver.url}/h`, secret: 'topsecret-gitlab-token', kind: 'push', tamper: 'unsigned' });
    expect(JSON.stringify(result)).not.toContain('topsecret-gitlab-token');
  });
});
