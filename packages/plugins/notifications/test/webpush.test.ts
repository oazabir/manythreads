import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, verify } from 'node:crypto';
import { PushPayload } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { PRIVATE_BODY, buildPushPayload, type PushFacts } from '../src/push.ts';
import { encryptPayload, isAllowedPushEndpoint, loadVapid, sendPush, vapidAuthorization } from '../src/webpush.ts';

// P14-09: the signed, encrypted push a browser accepts (RFC 8292 and RFC 8291), and what the push says -- never the text of a private message.

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** A browser's side: a key pair and an auth secret, as `PushSubscription.toJSON().keys` carries them. */
function browser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return { ecdh, sub: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) }, auth };
}

/** What a browser does with a push body (RFC 8291 section 3.4), written separately from the sender. */
function decrypt(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const cipherText = body.subarray(21 + idLen);
  const shared = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipherText.subarray(cipherText.length - 16));
  const plain = Buffer.concat([d.update(cipherText.subarray(0, cipherText.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2); // the last-record delimiter
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

describe('message encryption (RFC 8291)', () => {
  it('reproduces the example of the RFC byte for byte', () => {
    // RFC 8291 appendix A.
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { privateKey: fromB64u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: fromB64u('DGv6ra1nlYgDCS1FRnbzlw') },
    );
    expect(b64u(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('is readable by the browser it is for, and by no one else; each message uses fresh keys', () => {
    const a = browser();
    const b = browser();
    const text = JSON.stringify({ title: 'Nadia in #dev', body: 'héllo ✓' });
    const one = encryptPayload(Buffer.from(text), a.sub);
    const two = encryptPayload(Buffer.from(text), a.sub);
    expect(decrypt(one, a.ecdh, a.auth)).toBe(text);
    expect(one.equals(two)).toBe(false);
    expect(() => decrypt(one, b.ecdh, a.auth)).toThrow();
    expect(one.toString('utf8')).not.toContain('héllo');
  });

  it('refuses a message that does not fit one record, and a bad browser key', () => {
    const a = browser();
    expect(() => encryptPayload(Buffer.alloc(4100), a.sub)).toThrow(/too large/);
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: a.sub.auth })).toThrow();
  });
});

describe('server identity (RFC 8292)', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = pair.privateKey.export({ type: 'sec1', format: 'pem' }).toString();

  it('loads a P-256 key from PEM (also with escaped newlines) and derives the public key', () => {
    const keys = loadVapid(pem, 'mailto:ops@example.org');
    expect(keys).not.toBeNull();
    expect(fromB64u(keys!.publicKey)).toHaveLength(65);
    expect(loadVapid(pem.replace(/\n/g, '\\n'), 'mailto:ops@example.org')?.publicKey).toBe(keys!.publicKey);
  });
  it('does not load nothing, rubbish, or a key on another curve', () => {
    expect(loadVapid(undefined, 's')).toBeNull();
    expect(loadVapid('not a key', 's')).toBeNull();
    const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString();
    expect(loadVapid(other, 's')).toBeNull();
  });
  it('signs a token that the public key verifies, scoped to the push service and good for 12 hours', () => {
    const keys = loadVapid(pem, 'mailto:ops@example.org')!;
    const now = new Date('2026-10-29T10:00:00Z');
    const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(fromB64u(m[2]!).toString('utf8')) as { aud: string; exp: number; sub: string };
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: 'mailto:ops@example.org' });
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(fromB64u(keys.publicKey).subarray(1, 33)), y: b64u(fromB64u(keys.publicKey).subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, fromB64u(m[3]!))).toBe(true);
  });
});

describe('where the server will send', () => {
  it('only to https push services on the list', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://notfcm.googleapis.org/x',
      'ftp://fcm.googleapis.com/x',
      'not a url',
    ]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });
  it('an operator may add a host of their own', () => {
    expect(isAllowedPushEndpoint('https://push.example.org/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://push.example.org/x', ['example.org'])).toBe(true);
  });
});

describe('sending', () => {
  const keys = loadVapid(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' }).toString(), 'mailto:a@b.c')!;
  const b = browser();
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', ...b.sub };
  const answer = (status: number): typeof fetch => (async () => new Response(null, { status })) as typeof fetch;

  it('posts the encrypted body with the headers a push service expects and does not follow redirects', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush(keys, sub, Buffer.from('{"v":1}'), { fetchImpl })).toEqual({ result: 'sent' });
    const headers = seen!.init.headers as Record<string, string>;
    expect(seen!.url).toBe(sub.endpoint);
    expect(seen!.init.redirect).toBe('manual');
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers['Authorization']).toMatch(/^vapid t=.+, k=.+$/);
    expect(decrypt(Buffer.from(seen!.init.body as Uint8Array), b.ecdh, b.auth)).toBe('{"v":1}');
  });
  it('tells a browser that is gone from one worth retrying and from a refusal', async () => {
    expect(await sendPush(keys, sub, Buffer.from('x'), { fetchImpl: answer(410) })).toEqual({ result: 'gone', status: 410 });
    expect(await sendPush(keys, sub, Buffer.from('x'), { fetchImpl: answer(404) })).toEqual({ result: 'gone', status: 404 });
    expect(await sendPush(keys, sub, Buffer.from('x'), { fetchImpl: answer(503) })).toEqual({ result: 'retry', status: 503 });
    expect(await sendPush(keys, sub, Buffer.from('x'), { fetchImpl: answer(429) })).toEqual({ result: 'retry', status: 429 });
    expect(await sendPush(keys, sub, Buffer.from('x'), { fetchImpl: answer(400) })).toEqual({ result: 'rejected', status: 400 });
    expect(await sendPush(keys, sub, Buffer.from('x'), { fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch })).toEqual({ result: 'retry', status: 0 });
  });
});

describe('what a push says', () => {
  const base: PushFacts = {
    notificationId: '0198f000-0000-7000-8000-000000000001',
    kind: 'mention',
    keyword: null,
    actorName: 'Nadia Hassan',
    preview: 'the staging password is hunter2',
    channelId: '0198f000-0000-7000-8000-0000000000aa',
    channelKind: 'channel',
    channelName: 'dev',
    channelPrivate: false,
    messageId: '0198f000-0000-7000-8000-0000000000bb',
    threadRootId: null,
  };

  it('names the channel and the sender; a public channel also shows the text', () => {
    const p = buildPushPayload(base);
    expect(p.title).toBe('Nadia Hassan mentioned you in #dev');
    expect(p.body).toBe('the staging password is hunter2');
    expect(p.url).toBe(`/open?channel=${base.channelId}&message=${base.messageId}`);
    expect(PushPayload.safeParse(p).success).toBe(true);
  });
  it('never carries the text of a private channel: the body is a fixed line, whatever the kind', () => {
    for (const kind of ['mention', 'reply', 'message'] as const) {
      const p = buildPushPayload({ ...base, kind, channelPrivate: true, channelName: 'secret-launch' });
      expect(p.body).toBe(PRIVATE_BODY);
      expect(JSON.stringify(p)).not.toContain('hunter2');
      // the private channel's name stays off the lock screen too
      expect(JSON.stringify(p)).not.toContain('secret-launch');
      expect(p.title).toContain('Nadia Hassan');
    }
  });
  it('never carries the text of a direct message, and has no channel name to show', () => {
    const p = buildPushPayload({ ...base, kind: 'dm', channelKind: 'dm', channelName: '', channelPrivate: true });
    expect(p.title).toBe('Nadia Hassan sent you a message');
    expect(JSON.stringify(p)).not.toContain('hunter2');
    expect(p.body).toBe(PRIVATE_BODY);
    // a mention inside a direct message is private too
    expect(buildPushPayload({ ...base, kind: 'mention', channelKind: 'dm', channelName: '', channelPrivate: true }).body).toBe(PRIVATE_BODY);
  });
  it('says which keyword matched, opens the thread for a reply, and keeps a long text and name within bounds', () => {
    expect(buildPushPayload({ ...base, keyword: 'deploy' }).title).toBe('Nadia Hassan wrote “deploy” in #dev');
    expect(buildPushPayload({ ...base, kind: 'reply', threadRootId: '0198f000-0000-7000-8000-0000000000cc' }).url).toContain('&root=0198f000-0000-7000-8000-0000000000cc');
    const long = buildPushPayload({ ...base, preview: 'x'.repeat(5000), actorName: 'N'.repeat(5000), channelName: 'c'.repeat(500) });
    expect(long.body.length).toBeLessThanOrEqual(200);
    expect(long.title.length).toBeLessThanOrEqual(200);
  });
});
