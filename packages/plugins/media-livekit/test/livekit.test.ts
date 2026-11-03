import { createHash } from 'node:crypto';
import { MediaNotConfiguredError, MediaTokenRefusedError } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { createLivekitProvider, livekitConfigFromEnv, livekitConfigProblem, signJwt, verifyJwt } from '../src/livekit.ts';

// The LiveKit provider without a LiveKit server (PLAN P15-02): token claims and lifetime, the refusal of a bot's token, the Twirp calls it would make, the signed
// webhook, and the "not configured" state. That the real server accepts these tokens and calls is checked on the live site (docs/spikes/voice.md).

const SECRET = 's'.repeat(40);
const ENV = { MANYTHREADS_LIVEKIT_URL: 'wss://media.example.test', MANYTHREADS_LIVEKIT_API_KEY: 'APIkey1', MANYTHREADS_LIVEKIT_API_SECRET: SECRET };
const NOW = new Date('2026-11-03T10:00:00.000Z');
const nowSec = NOW.getTime() / 1000;
const person = { id: '00000000-0000-7000-8000-0000000d0001', kind: 'person' as const, displayName: 'Omar' };
const claimsOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));

describe('configuration', () => {
  it('is not configured without the three settings, and says which is missing', () => {
    expect(livekitConfigProblem({})).toMatch(/not set up/);
    expect(livekitConfigProblem({ ...ENV, MANYTHREADS_LIVEKIT_API_KEY: '' })).toMatch(/API key/);
    expect(livekitConfigProblem({ ...ENV, MANYTHREADS_LIVEKIT_API_SECRET: 'short' })).toMatch(/too short/);
    expect(livekitConfigProblem({ ...ENV, MANYTHREADS_LIVEKIT_URL: 'nonsense' })).toMatch(/wss:\/\//);
    expect(livekitConfigProblem(ENV)).toBeNull();
  });
  it('derives the server address from the public one, or takes the internal one', () => {
    expect(livekitConfigFromEnv(ENV)?.apiUrl).toBe('https://media.example.test');
    expect(livekitConfigFromEnv({ ...ENV, MANYTHREADS_LIVEKIT_API_URL: 'http://livekit.svc:7880/' })?.apiUrl).toBe('http://livekit.svc:7880');
    expect(livekitConfigFromEnv({})).toBeNull();
  });
  it('every call throws "not configured" and the status says so, without a network call', async () => {
    const p = createLivekitProvider({
      env: () => ({}),
      fetch: (() => {
        throw new Error('no network');
      }) as never,
    });
    expect(p.status()).toMatchObject({ configured: false });
    await expect(p.token(person, 'room', { canPublish: true, canSubscribe: true })).rejects.toBeInstanceOf(MediaNotConfiguredError);
    await expect(p.createRoom({ name: 'r' })).rejects.toBeInstanceOf(MediaNotConfiguredError);
    await expect(p.closeRoom('r')).rejects.toBeInstanceOf(MediaNotConfiguredError);
    await expect(p.kick('r', 'x')).rejects.toBeInstanceOf(MediaNotConfiguredError);
    expect(p.verifyWebhook({ authorization: 'x' }, '{}')).toBeNull();
  });
});

describe('tokens', () => {
  const p = createLivekitProvider({ env: () => ENV, now: () => NOW });
  it('is an HS256 token for one room with audio grants, living ten minutes at most', async () => {
    const t = await p.token(person, 'room-1', { canPublish: true, canSubscribe: true }, { ttlSeconds: 99_999 });
    expect(t.url).toBe('wss://media.example.test');
    expect(t.expiresAt.getTime() - NOW.getTime()).toBe(600_000);
    const claims = verifyJwt(t.token, SECRET, nowSec)!;
    expect(claims).toMatchObject({ iss: 'APIkey1', sub: person.id, name: 'Omar' });
    expect(claims['video']).toMatchObject({ room: 'room-1', roomJoin: true, canPublish: true, canSubscribe: true, hidden: false });
    expect(Number(claims['exp']) - nowSec).toBe(600);
    expect(verifyJwt(t.token, 'x'.repeat(40), nowSec)).toBeNull();
    expect(verifyJwt(t.token, SECRET, nowSec + 601)).toBeNull();
  });
  it('honours a shorter lifetime and never goes below one second', async () => {
    const short = await p.token(person, 'r', { canPublish: true, canSubscribe: true }, { ttlSeconds: 30 });
    expect(short.expiresAt.getTime() - NOW.getTime()).toBe(30_000);
    const zero = await p.token(person, 'r', { canPublish: true, canSubscribe: true }, { ttlSeconds: -5 });
    expect(zero.expiresAt.getTime() - NOW.getTime()).toBe(1000);
  });
  it('never gives a bot a token that can publish; the note-taker gets a hidden, listen-only one', async () => {
    const bot = { id: '00000000-0000-7000-8000-0000000d0099', kind: 'bot' as const, displayName: 'Notes' };
    await expect(p.token(bot, 'r', { canPublish: true, canSubscribe: true })).rejects.toBeInstanceOf(MediaTokenRefusedError);
    await expect(p.token(bot, 'r', { canPublish: false, canSubscribe: true })).rejects.toBeInstanceOf(MediaTokenRefusedError);
    await expect(p.token(person, 'r', { canPublish: true, canSubscribe: true, listenOnly: true })).rejects.toBeInstanceOf(MediaTokenRefusedError);
    const listen = await p.token(bot, 'r', { canPublish: false, canSubscribe: true, listenOnly: true });
    expect(claimsOf(listen.token)['video']).toMatchObject({ canPublish: false, canSubscribe: true, hidden: true, canPublishData: false });
  });
});

describe('the server API', () => {
  const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  const respond = (status: number): typeof fetch =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: String((init.headers as Record<string, string>)['authorization']), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;

  it('creates a room, drops a person and closes a room with short admin tokens', async () => {
    calls.length = 0;
    const p = createLivekitProvider({ env: () => ENV, now: () => NOW, fetch: respond(200) });
    await p.createRoom({ name: 'room-1', maxParticipants: 50 });
    await p.kick('room-1', 'actor-1');
    await p.closeRoom('room-1');
    expect(calls.map((c) => c.url.replace('https://media.example.test/twirp/livekit.RoomService/', ''))).toEqual(['CreateRoom', 'RemoveParticipant', 'DeleteRoom']);
    expect(calls[0]!.body).toMatchObject({ name: 'room-1', max_participants: 50 });
    expect(calls[1]!.body).toEqual({ room: 'room-1', identity: 'actor-1' });
    for (const c of calls) {
      const claims = verifyJwt(c.auth.replace('Bearer ', ''), SECRET, nowSec)!;
      expect(Number(claims['exp']) - nowSec).toBeLessThanOrEqual(60);
    }
    expect(verifyJwt(calls[1]!.auth.replace('Bearer ', ''), SECRET, nowSec)!['video']).toMatchObject({ roomAdmin: true, room: 'room-1' });
  });
  it('treats a room or person that is not there as done, and any other refusal as an error with a plain message', async () => {
    const gone = createLivekitProvider({ env: () => ENV, fetch: respond(404) });
    await expect(gone.closeRoom('r')).resolves.toBeUndefined();
    await expect(gone.kick('r', 'x')).resolves.toBeUndefined();
    const denied = createLivekitProvider({ env: () => ENV, fetch: respond(401) });
    await expect(denied.createRoom({ name: 'r' })).rejects.toThrow('The media server refused our key.');
    const down = createLivekitProvider({
      env: () => ENV,
      fetch: (async () => {
        throw new Error('ECONNREFUSED secret=abc');
      }) as never,
    });
    const err = await down.createRoom({ name: 'r' }).catch((e: Error) => e);
    expect((err as Error).message).toBe('The media server did not answer.');
  });
});

describe('webhooks', () => {
  const p = createLivekitProvider({ env: () => ENV, now: () => NOW });
  const body = JSON.stringify({ event: 'participant_left', id: 'EV_1', createdAt: 1_793_700_000, room: { name: 'room-1' }, participant: { identity: 'actor-1' } });
  const sign = (raw: string, secret = SECRET, extra: Record<string, unknown> = {}): string =>
    signJwt({ iss: 'APIkey1', nbf: nowSec - 5, exp: nowSec + 300, sha256: createHash('sha256').update(raw).digest('base64'), ...extra }, secret);

  it('reads a notice signed with the key and secret', () => {
    expect(p.verifyWebhook({ authorization: sign(body) }, body)).toEqual({ id: 'EV_1', kind: 'participant_left', room: 'room-1', identity: 'actor-1', at: new Date(1_793_700_000_000) });
    expect(p.verifyWebhook({ authorization: sign(body) }, Buffer.from(body))?.room).toBe('room-1');
    const other = JSON.stringify({ event: 'track_published', room: { name: 'r' } });
    expect(p.verifyWebhook({ authorization: sign(other) }, other)?.kind).toBe('other');
  });
  it('refuses a missing header, another secret, another key, an expired token and a body that was changed', () => {
    expect(p.verifyWebhook({}, body)).toBeNull();
    expect(p.verifyWebhook({ authorization: sign(body, 'z'.repeat(40)) }, body)).toBeNull();
    expect(p.verifyWebhook({ authorization: sign(body, SECRET, { iss: 'other' }) }, body)).toBeNull();
    expect(p.verifyWebhook({ authorization: sign(body, SECRET, { exp: nowSec - 10 }) }, body)).toBeNull();
    expect(p.verifyWebhook({ authorization: sign(body) }, body.replace('actor-1', 'actor-2'))).toBeNull();
    expect(p.verifyWebhook({ authorization: 'not.a.jwt' }, body)).toBeNull();
    // an unsigned algorithm is never accepted
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'APIkey1', sha256: createHash('sha256').update(body).digest('base64') })).toString('base64url')}.`;
    expect(p.verifyWebhook({ authorization: none }, body)).toBeNull();
  });
});
