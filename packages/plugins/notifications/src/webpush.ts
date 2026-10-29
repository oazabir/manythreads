import { createECDH, createCipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/*
 * Web Push, written against the three standards a browser's push service speaks, with nothing but Node's own crypto:
 *   RFC 8292 (VAPID): the server proves who it is with a short signed token, so a push service accepts messages only from the site the
 *                     person signed up on;
 *   RFC 8291 (message encryption) and RFC 8188 (the `aes128gcm` body): the text is encrypted for the one browser it is for, so the push
 *                     service that carries it (a third party) cannot read it.
 * The server's own signing key lives in a secret (`MANYTHREADS_VAPID_PRIVATE_KEY`, an elliptic-curve P-256 key in PEM form); the public half is
 * derived from it, so there is one secret to keep.
 */

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export interface VapidKeys {
  privateKey: KeyObject;
  /** The public key as the browser wants it: 65 bytes (0x04, x, y) in URL-safe base64. */
  publicKey: string;
  /** Who is sending: a `mailto:` or `https:` address a push service can reach the operator at. */
  subject: string;
}

/** Reads the signing key from its PEM text (newlines may be written as `\n`); null when absent or not a P-256 key. */
export function loadVapid(pem: string | undefined, subject: string): VapidKeys | null {
  const text = (pem ?? '').trim().replace(/\\n/g, '\n');
  if (text === '') return null;
  try {
    const privateKey = createPrivateKey(text);
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
    const publicKey = b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]));
    return { privateKey, publicKey, subject };
  } catch {
    return null;
  }
}

/** The `Authorization` header value for a push service at `endpoint`: `vapid t=<signed token>, k=<public key>`. The token is good for 12 hours. */
export function vapidAuthorization(keys: VapidKeys, endpoint: string, now: Date): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: keys.subject })));
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Push services that carry browser pushes. A browser names its own endpoint, so an address outside this list is never contacted. */
const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

/**
 * May the server send to this endpoint? An https address on the default port, with no user name or password, whose host is a push service
 * (or a sub-domain of one) from the list, or of an operator's own `extraHosts`. This is what keeps a signed-up endpoint from being used to make
 * the server call an internal address.
 */
export function isAllowedPushEndpoint(endpoint: string, extraHosts: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return [...DEFAULT_PUSH_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase()).filter((h) => h !== '')].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface Subscription {
  endpoint: string;
  /** The browser's public key (65 bytes, URL-safe base64). */
  p256dh: string;
  /** The browser's 16-byte secret (URL-safe base64). */
  auth: string;
}

/** One record is 4096 bytes: 86 of them are taken by padding, the tag and the delimiter. */
export const MAX_PLAINTEXT = 4096 - 17 - 1;

/**
 * Encrypts `plaintext` for one browser (RFC 8291, `aes128gcm`): a fresh key pair and salt per message, the shared secret mixed with the
 * browser's `auth` secret, one record. `ephemeral` and `salt` are for tests with the RFC's own numbers.
 */
export function encryptPayload(plaintext: Uint8Array, sub: Pick<Subscription, 'p256dh' | 'auth'>, fixed?: { privateKey?: Buffer; salt?: Buffer }): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large');
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad browser key');
  const ecdh = createECDH('prime256v1');
  if (fixed?.privateKey) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(65, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** What happened to one send. `gone`: the push service says this browser is no longer subscribed (delete it). `retry`: try again later. */
export type PushOutcome = { result: 'sent' } | { result: 'gone'; status: number } | { result: 'retry'; status: number } | { result: 'rejected'; status: number };

export interface SendOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  /** How long the push service may hold the message for a browser that is offline, in seconds. */
  ttl?: number;
  timeoutMs?: number;
}

/** Sends one encrypted message. Never follows a redirect and gives up after `timeoutMs` (default 8 s). */
export async function sendPush(keys: VapidKeys, sub: Subscription, plaintext: Uint8Array, options: SendOptions = {}): Promise<PushOutcome> {
  const doFetch = options.fetchImpl ?? fetch;
  const body = encryptPayload(plaintext, sub);
  let res: Response;
  try {
    res = await doFetch(sub.endpoint, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      headers: {
        Authorization: vapidAuthorization(keys, sub.endpoint, options.now ?? new Date()),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(options.ttl ?? 3600),
        Urgency: 'normal',
      },
      body: new Uint8Array(body),
    });
  } catch {
    return { result: 'retry', status: 0 };
  }
  // The body is not needed; drop it so the connection can be reused.
  void res.body?.cancel().catch(() => undefined);
  if (res.status >= 200 && res.status < 300) return { result: 'sent' };
  if (res.status === 404 || res.status === 410) return { result: 'gone', status: res.status };
  if (res.status === 429 || res.status >= 500) return { result: 'retry', status: res.status };
  return { result: 'rejected', status: res.status };
}
