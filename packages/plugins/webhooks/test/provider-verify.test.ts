import { createHmac } from 'node:crypto';
import { expectLinear } from '@manythreads/test-utils/linear';
import { describe, expect, it } from 'vitest';
// The stand-in's sender signs the way each provider documents; only node:crypto is behind it, so the file is imported as it is. The reference signatures below are written out
// again in this test (a second reading of each scheme), so a mistake shared by the sender and a verifier would still be caught by the documented GitHub vector and by these.
import { WEBHOOK_KINDS, WEBHOOK_PROVIDERS, buildWebhook, type Tamper, type WebhookProvider } from '../../../../tools/fake-saas/src/providers/sender.ts';
import { PROVIDER_READERS, judgeDelivery } from '../src/providers/index.ts';
import { oneLine, trimPayload } from '../src/providers/common.ts';

// P16-10: every work app's verifier and reader, as pure functions. The calls are built by the stand-in sender (tools/fake-saas) with `tamper` variants, and each one must be
// accepted, or refused for the right reason. Documented vectors: GitHub's "Validating webhook deliveries" example.

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const SECRET = 'a-secret-the-test-knows-1234567890';
const URL_ = 'https://manythreads.example/hooks/apps/00000000-0000-7000-8000-000000000001';

const callOf = (provider: WebhookProvider, kind: string, tamper: Tamper = 'none', extra: { title?: string; body?: string } = {}) =>
  buildWebhook({ provider, url: URL_, secret: SECRET, kind, tamper, now: new Date(NOW), ...extra });

const judge = (call: ReturnType<typeof buildWebhook>, provider: WebhookProvider, secret = SECRET, now = NOW) =>
  judgeDelivery(PROVIDER_READERS[provider], { headers: call.headers, rawBody: Buffer.from(call.body), secret, now, method: 'POST', uri: URL_ });

describe('the documented vector', () => {
  it('GitHub: secret "It\'s a Secret to Everybody", body "Hello, World!"', () => {
    const rawBody = Buffer.from('Hello, World!');
    const headers = { 'x-hub-signature-256': 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17' };
    const input = { headers, rawBody, secret: "It's a Secret to Everybody", now: NOW, method: 'POST', uri: URL_ };
    expect(PROVIDER_READERS.github.verify(input)).toEqual({ ok: true });
    expect(PROVIDER_READERS.github.verify({ ...input, rawBody: Buffer.from('Hello, World?') })).toEqual({ ok: false, reason: 'bad_signature' });
    // upper-case hex is accepted, a short or non-hex value is not
    expect(PROVIDER_READERS.github.verify({ ...input, headers: { 'x-hub-signature-256': headers['x-hub-signature-256'].toUpperCase().replace('SHA256=', 'sha256=') } })).toEqual({ ok: true });
    expect(PROVIDER_READERS.github.verify({ ...input, headers: { 'x-hub-signature-256': 'sha256=757107ea' } })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(PROVIDER_READERS.github.verify({ ...input, headers: { 'x-hub-signature-256': `sha256=${'z'.repeat(64)}` } })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('the schemes, written out again', () => {
  const hex = (alg: 'sha256' | 'sha1', text: string): string => createHmac(alg, SECRET).update(text).digest('hex');
  const b64 = (text: string): string => createHmac('sha256', SECRET).update(text).digest('base64');
  const verify = (provider: WebhookProvider, headers: Record<string, string>, body: string, uri = URL_) =>
    PROVIDER_READERS[provider].verify({ headers, rawBody: Buffer.from(body), secret: SECRET, now: NOW, method: 'POST', uri });
  const body = JSON.stringify({ webhookTimestamp: NOW, type: 'Issue', action: 'create' });

  it('Jira: sha256= of the body in X-Hub-Signature', () => {
    expect(verify('jira', { 'x-hub-signature': `sha256=${hex('sha256', body)}` }, body)).toEqual({ ok: true });
  });
  it('Intercom: sha1= of the body in X-Hub-Signature', () => {
    expect(verify('intercom', { 'x-hub-signature': `sha1=${hex('sha1', body)}` }, body)).toEqual({ ok: true });
    expect(verify('intercom', { 'x-hub-signature': `sha256=${hex('sha256', body)}` }, body)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('Linear: the bare hex of the body, and the body\'s own timestamp within a minute', () => {
    expect(verify('linear', { 'linear-signature': hex('sha256', body) }, body)).toEqual({ ok: true });
    const old = JSON.stringify({ webhookTimestamp: NOW - 61_000 });
    expect(verify('linear', { 'linear-signature': hex('sha256', old) }, old)).toEqual({ ok: false, reason: 'stale' });
    const none = JSON.stringify({ type: 'Issue' });
    expect(verify('linear', { 'linear-signature': hex('sha256', none) }, none)).toEqual({ ok: false, reason: 'stale' });
  });
  it('Zendesk: base64 of timestamp + body, timestamp within five minutes', () => {
    const stamp = new Date(NOW - 60_000).toISOString();
    expect(verify('zendesk', { 'x-zendesk-webhook-signature-timestamp': stamp, 'x-zendesk-webhook-signature': b64(stamp + body) }, body)).toEqual({ ok: true });
    const old = new Date(NOW - 6 * 60_000).toISOString();
    expect(verify('zendesk', { 'x-zendesk-webhook-signature-timestamp': old, 'x-zendesk-webhook-signature': b64(old + body) }, body)).toEqual({ ok: false, reason: 'stale' });
    // the timestamp is part of what is signed: a fresh stamp on an old signature fails
    expect(verify('zendesk', { 'x-zendesk-webhook-signature-timestamp': stamp, 'x-zendesk-webhook-signature': b64(old + body) }, body)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('HubSpot v3: method + address + body + timestamp', () => {
    const stamp = String(NOW - 1000);
    expect(verify('hubspot', { 'x-hubspot-request-timestamp': stamp, 'x-hubspot-signature-v3': b64(`POST${URL_}${body}${stamp}`) }, body)).toEqual({ ok: true });
    expect(verify('hubspot', { 'x-hubspot-request-timestamp': stamp, 'x-hubspot-signature-v3': b64(`POST${URL_}${body}${stamp}`) }, body, `${URL_}x`)).toEqual({ ok: false, reason: 'bad_signature' });
    const old = String(NOW - 6 * 60_000);
    expect(verify('hubspot', { 'x-hubspot-request-timestamp': old, 'x-hubspot-signature-v3': b64(`POST${URL_}${body}${old}`) }, body)).toEqual({ ok: false, reason: 'stale' });
  });
  it('Asana: hex of the body under the handshake secret', () => {
    expect(verify('asana', { 'x-hook-signature': hex('sha256', body) }, body)).toEqual({ ok: true });
  });
  it('generic: v0 of "v0:<seconds>:<body>"', () => {
    const stamp = String(Math.floor(NOW / 1000));
    expect(verify('generic', { 'x-manythreads-request-timestamp': stamp, 'x-manythreads-signature': `v0=${hex('sha256', `v0:${stamp}:${body}`)}` }, body)).toEqual({ ok: true });
    const old = String(Math.floor(NOW / 1000) - 601);
    expect(verify('generic', { 'x-manythreads-request-timestamp': old, 'x-manythreads-signature': `v0=${hex('sha256', `v0:${old}:${body}`)}` }, body)).toEqual({ ok: false, reason: 'stale' });
  });
  it('GitLab: the token itself, compared whole', () => {
    expect(verify('gitlab', { 'x-gitlab-token': SECRET }, body)).toEqual({ ok: true });
    expect(verify('gitlab', { 'x-gitlab-token': `${SECRET} ` }, body)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verify('gitlab', { 'x-gitlab-token': SECRET.slice(0, -1) }, body)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

/** Every kind the stand-in sends for a provider, except the one-time handshake. */
const CASES = WEBHOOK_PROVIDERS.flatMap((provider) => {
  const kinds = provider === 'generic' ? ['build.failed'] : WEBHOOK_KINDS[provider].filter((k) => k !== 'handshake');
  return kinds.map((kind) => [provider, kind] as const);
});

describe('what the stand-in sends is accepted and read', () => {
  it.each(CASES)('%s %s', (provider, kind) => {
    const call = callOf(provider, kind, 'none', { title: 'Printer on fire' });
    const judged = judge(call, provider);
    expect(judged.ok, JSON.stringify(judged)).toBe(true);
    if (!judged.ok) return;
    const reader = PROVIDER_READERS[provider];
    const read = reader.normalise({ headers: call.headers, body: judged.body });
    expect(read, 'the event is understood').not.toBeNull();
    expect(read?.kind).toBe(kind);
    expect(read?.title.length).toBeGreaterThan(0);
    if (kind !== 'contact.created' || provider === 'hubspot') expect(read?.title).toContain('Printer on fire');
    expect(read?.title.length).toBeLessThanOrEqual(200);
    expect(read?.actor.length).toBeLessThanOrEqual(80);
    if (read?.url) expect(read.url).toMatch(/^https?:\/\//);
    // the delivery key is the one the stand-in put in the call, where the app sends one
    const key = reader.deliveryKey(call.headers, judged.body);
    if (['github', 'gitlab', 'jira', 'linear', 'zendesk', 'generic'].includes(provider)) expect(key).toBe(call.deliveryId);
    if (provider === 'intercom') expect(key).toBe(`notif_${call.deliveryId}`);
  });
});

describe('tampered and old calls are refused for the right reason', () => {
  it.each(WEBHOOK_PROVIDERS)('%s', (provider) => {
    const kind = provider === 'generic' ? 'build.failed' : WEBHOOK_KINDS[provider].filter((k) => k !== 'handshake')[0]!;
    for (const tamper of ['signature', 'body', 'unsigned'] as const) {
      const judged = judge(callOf(provider, kind, tamper), provider);
      // GitLab's proof is the token alone and does not cover the body (its documentation says so), so a changed body is only caught by the apps that sign it
      if (provider === 'gitlab' && tamper === 'body') {
        expect(judged.ok).toBe(true);
        continue;
      }
      expect(judged, `${provider} ${tamper}`).toEqual({ ok: false, reason: 'bad_signature' });
    }
    // right call, wrong secret held by the receiver
    expect(judge(callOf(provider, kind), provider, 'another-secret-entirely')).toEqual({ ok: false, reason: 'bad_signature' });
    // stale: the provider's own timestamp 10 minutes old, or the event itself 8 days old
    expect(judge(callOf(provider, kind, 'stale'), provider), `${provider} stale`).toEqual({ ok: false, reason: 'stale' });
  });

  it('a signed body that is not JSON is a bad body, never an event', () => {
    const call = callOf('github', 'issue.created', 'none', { body: 'this is not json' });
    // the stand-in signs the text it is given, so the signature holds and the body is the problem
    expect(judge(call, 'github')).toEqual({ ok: false, reason: 'bad_body' });
  });

  it('the stand-in\'s replay is the same call twice: both verify, the door\'s dedupe is what stops the second', () => {
    const call = callOf('zendesk', 'ticket.created', 'replay');
    expect(call.repeat).toBe(2);
    expect(judge(call, 'zendesk').ok).toBe(true);
    const reader = PROVIDER_READERS.zendesk;
    const body = JSON.parse(call.body) as unknown;
    expect(reader.deliveryKey(call.headers, body)).toBe(call.deliveryId);
  });
});

describe('what the readers leave alone', () => {
  const read = (provider: WebhookProvider, headers: Record<string, string>, body: unknown) => PROVIDER_READERS[provider].normalise({ headers, body });

  it('events the platform does not use are ignored, not refused', () => {
    expect(read('github', { 'x-github-event': 'ping' }, { zen: 'Keep it logically awesome.' })).toBeNull();
    expect(read('github', { 'x-github-event': 'issue_comment' }, { action: 'deleted', issue: { number: 1 } })).toBeNull();
    expect(read('asana', {}, { events: [] })).toBeNull();
    expect(read('jira', {}, { webhookEvent: 'jira:version_released' })).toBeNull();
    expect(read('linear', {}, { type: 'Project', action: 'create' })).toBeNull();
    expect(read('zendesk', {}, { type: 'something.else' })).toBeNull();
    expect(read('generic', {}, { kind: 'Not A Kind!' })).toBeNull();
    expect(read('hubspot', {}, [])).toBeNull();
    expect(read('gitlab', {}, 'not an object')).toBeNull();
  });

  it('a merged pull request and an edited issue get their own kinds', () => {
    const pr = { action: 'closed', number: 7, pull_request: { number: 7, title: 'Fix', merged: true, html_url: 'https://github.com/o/r/pull/7' }, repository: { full_name: 'o/r' }, sender: { login: 'dana' } };
    expect(read('github', { 'x-github-event': 'pull_request' }, pr)?.kind).toBe('pull_request.merged');
    expect(read('github', { 'x-github-event': 'issues' }, { action: 'labeled', issue: { number: 1, title: 'x' }, repository: { full_name: 'o/r' } })?.kind).toBe('issue.updated');
  });

  it('a link that is not http or https is dropped', () => {
    const e = read('generic', {}, { kind: 'a.b', title: 'x', url: 'javascript:alert(1)' });
    expect(e?.url).toBeNull();
    expect(read('generic', {}, { kind: 'a.b', title: 'x', url: 'https://ok.example/a' })?.url).toBe('https://ok.example/a');
  });

  it('a batch from HubSpot or Asana says how many more came with it', () => {
    const hub = read('hubspot', {}, [{ eventId: 1, subscriptionType: 'ticket.creation', objectId: 5, portalId: 9, propertyValue: 'Broken' }, { eventId: 2 }]);
    expect(hub?.kind).toBe('ticket.created');
    expect(hub?.title).toContain('and 1 more');
    const asana = read('asana', {}, { events: [{ action: 'added', resource: { gid: '5', resource_type: 'task', name: 'T' } }, { action: 'changed', resource: { gid: '6', resource_type: 'task' } }] });
    expect(asana?.kind).toBe('task.created');
    expect(asana?.title).toContain('and 1 more');
  });

  it('outside text is made one line, with control and bidirectional characters gone, and cut', () => {
    const hostile = ['a\n', String.fromCharCode(0x202e), 'b'.repeat(500), String.fromCharCode(0), String.fromCharCode(0x200b), 'c'].join('');
    const line = oneLine(hostile, 200);
    expect(line.length).toBeLessThanOrEqual(200);
    for (const ch of line) expect(ch.charCodeAt(0), 'a hidden character survived').toBeGreaterThan(31);
    expect(line).not.toContain(String.fromCharCode(0x202e));
    expect(line).not.toContain(String.fromCharCode(0x200b));
    const e = read('generic', {}, { kind: 'a.b', title: hostile, actor: hostile });
    expect(e?.title.length).toBeLessThanOrEqual(200);
    expect(e?.actor.length).toBeLessThanOrEqual(80);
  });
});

describe('the payload kept with an event', () => {
  it('is cut to a safe size and never carries a key that touches a prototype', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) wide[`k${i}`] = 'x'.repeat(5000);
    wide['__proto__'] = { polluted: true };
    wide['nested'] = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
    const trimmed = trimPayload(JSON.parse(JSON.stringify(wide).replace('"__proto__"', '"__proto__"'))) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(trimmed))).toBeLessThan(48_001);
    expect(Object.keys(trimmed)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
  it('holds only text Postgres jsonb takes: no NUL, no lone surrogate, also after a cut through an emoji', () => {
    const body = { text: `${'x'.repeat(1999)}\u{1F600}tail`, nul: 'a\u0000b', lone: 'a\ud800b\udc00c', 'k\u0000ey': 'v' };
    const trimmed = JSON.stringify(trimPayload(body));
    const back = JSON.parse(trimmed) as Record<string, string>;
    for (const text of [...Object.keys(back), ...Object.values(back)]) {
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
      expect(text).not.toContain('\u0000');
    }
    expect(back['nul']).toBe('ab');
    expect(back['key']).toBe('v');
    expect(back['lone']).toBe('a\ufffdb\ufffdc');
    expect(back['text']!.startsWith('x'.repeat(1999))).toBe(true);
  });
  it('keeps a small payload as it was', () => {
    expect(trimPayload({ a: 1, b: ['x'], c: { d: null } })).toEqual({ a: 1, b: ['x'], c: { d: null } });
  });
});

describe('hostile bodies cost time in proportion to their size', () => {
  const pad = (n: number): { call: ReturnType<typeof buildWebhook>; bytes: Buffer } => {
    const call = buildWebhook({ provider: 'zendesk', url: URL_, secret: SECRET, kind: 'ticket.created', now: new Date(NOW), body: JSON.stringify({ type: 'zen:event-type:ticket.created', pad: 'x'.repeat(n) }) });
    return { call, bytes: Buffer.from(call.body) };
  };
  for (const provider of WEBHOOK_PROVIDERS) {
    it(`${provider}: verify and read a 1 MB body`, () => {
      expectLinear(
        (n) => {
          // a body of n bytes that is hostile in the ways a regular expression would suffer: long runs, nested brackets, many spaces
          const filler = `${'a '.repeat(n / 4)}${'['.repeat(n / 8)}${'"\\'.repeat(n / 16)}`.slice(0, n);
          const kind = provider === 'generic' ? 'a.b' : WEBHOOK_KINDS[provider].filter((k) => k !== 'handshake')[0]!;
          const base = buildWebhook({ provider, url: URL_, secret: SECRET, kind, now: new Date(NOW) });
          const text = JSON.stringify({ ...(JSON.parse(base.body) as Record<string, unknown>), pad: filler });
          const signed = buildWebhook({ provider, url: URL_, secret: SECRET, kind, now: new Date(NOW), body: text });
          return { headers: signed.headers, rawBody: Buffer.from(text) };
        },
        (input) => {
          const reader = PROVIDER_READERS[provider];
          const verdict = reader.verify({ ...input, secret: SECRET, now: NOW, method: 'POST', uri: URL_ });
          if (verdict.ok) {
            const body = JSON.parse(input.rawBody.toString('utf8')) as unknown;
            reader.normalise({ headers: input.headers, body });
            trimPayload(body);
          }
          return verdict;
        },
        { n: 256 * 1024, factor: 4, label: `${provider} 1 MB body`, ceilingMs: 1500 },
      );
    });
  }
  it('a wrong signature on a 1 MB body is refused without parsing it', () => {
    const { call, bytes } = pad(1024 * 1024 - 200);
    const started = performance.now();
    const judged = judgeDelivery(PROVIDER_READERS.zendesk, { headers: { ...call.headers, 'x-zendesk-webhook-signature': 'AAAA' }, rawBody: bytes, secret: SECRET, now: NOW, method: 'POST', uri: URL_ });
    expect(judged).toEqual({ ok: false, reason: 'bad_signature' });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
