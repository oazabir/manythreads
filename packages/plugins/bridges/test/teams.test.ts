import { createHmac, generateKeyPairSync, createPublicKey, sign as signBytes, type KeyObject } from 'node:crypto';
import { relaxedRateLimiter, TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { FAKE_TEAMS_CLIENT_SECRET, startFakeTeams, type FakeTeams, type TeamsJwtMode } from '../../../../tools/fake-saas/src/providers/teams.ts';
import type { BridgeAccountRef, BridgeRequest } from '../src/adapter.ts';
import { createKeyCache, decodeJwt, kidOf, parseKeySet, verifyJwt, type Jwk } from '../src/adapters/jwt.ts';
import { forgetTeamsKeys, teamsAdapter, teamsChatId, teamsPlain } from '../src/adapters/teams.ts';
import { BridgeSendError } from '../src/door.ts';

// Bundle D, P16-09 (B2, decision D30): the Teams bridge through the Bot Framework. First the token check on its own (RS256, issuer, audience, expiry, key ids, key cache), then the adapter (reading
// activities, the chat name, the Microsoft host list for replies), then end to end against the real server and the Teams stand-in with the same acceptance as Telegram: forged tokens are 401 and leave
// nothing, an unlinked person is dropped before anything is stored, a linked person's words land in a joined public channel as them, and the channel's words go back out once.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 60_000 });

// --- the token check on its own -----------------------------------------------------------------------------------------------------------------------------

const b64 = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
interface Pair {
  kid: string;
  privateKey: KeyObject;
  jwk: Jwk;
}
const pair = (kid: string, bits = 2048): Pair => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const { n, e } = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { kid, privateKey, jwk: { kty: 'RSA', kid, n, e, use: 'sig', endorsements: ['msteams'] } };
};
const NOW = 1_800_000_000_000;
const AUD = '5b2d9c3e-7a41-4c1b-9d57-0f3a6e8b1c24';
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: 'https://api.botframework.com', aud: AUD, iat: NOW / 1000 - 60, nbf: NOW / 1000 - 60, exp: NOW / 1000 + 300, serviceurl: 'https://smba.trafficmanager.net/emea/', ...over });
const mint = (p: Pair, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string => {
  const input = `${b64({ alg: 'RS256', typ: 'JWT', kid: p.kid, ...header })}.${b64(claims(over))}`;
  return `${input}.${signBytes('RSA-SHA256', Buffer.from(input), p.privateKey).toString('base64url')}`;
};

describe('the JWT check', () => {
  const good = pair('k1');
  const other = pair('k2');
  const keys: Record<string, Jwk> = { k1: good.jwk, k2: other.jwk };
  const opts = { keyFor: (kid: string): Jwk | undefined => keys[kid], issuer: 'https://api.botframework.com', audience: AUD, now: NOW, skewMs: 300_000 };
  const check = (token: string, over: Partial<typeof opts> = {}) => verifyJwt(token, { ...opts, ...over });
  const reason = (token: string, over: Partial<typeof opts> = {}): string | null => {
    const r = check(token, over);
    return r.ok ? null : r.reason;
  };

  it('accepts a token the issuer signed for this audience, and hands back its claims and key', () => {
    const r = check(mint(good));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims['serviceurl']).toBe('https://smba.trafficmanager.net/emea/');
      expect(r.key.kid).toBe('k1');
    }
    // the audience is the same text whatever its case, or one of several
    expect(reason(mint(good, { aud: AUD.toUpperCase() }))).toBeNull();
    expect(reason(mint(good, { aud: ['someone-else', AUD] }))).toBeNull();
  });

  it('refuses the wrong issuer and the wrong audience', () => {
    expect(reason(mint(good, { iss: 'https://sts.windows.net/tenant/' }))).toBe('issuer');
    expect(reason(mint(good, { iss: 'https://api.botframework.com/' }))).toBe('issuer');
    expect(reason(mint(good, { iss: undefined }))).toBe('issuer');
    expect(reason(mint(good, { aud: '00000000-0000-4000-8000-000000000000' }))).toBe('audience');
    expect(reason(mint(good, { aud: [] }))).toBe('audience');
    expect(reason(mint(good, { aud: 5 }))).toBe('audience');
    expect(reason(mint(good), { audience: '' })).toBe('audience');
  });

  it('refuses an expired token, a token that is not valid yet, and one with no or odd times', () => {
    expect(reason(mint(good, { exp: NOW / 1000 - 301 }))).toBe('expired');
    expect(reason(mint(good, { exp: NOW / 1000 - 299 }))).toBeNull();
    expect(reason(mint(good, { nbf: NOW / 1000 + 301 }))).toBe('not_yet');
    expect(reason(mint(good, { nbf: NOW / 1000 + 299 }))).toBeNull();
    expect(reason(mint(good, { exp: undefined }))).toBe('claims');
    expect(reason(mint(good, { exp: '9999999999' }))).toBe('claims');
    expect(reason(mint(good, { nbf: 'soon' }))).toBe('claims');
    expect(reason(mint(good, { nbf: undefined }))).toBeNull();
  });

  it('refuses a key id nobody published, and a token signed with another key under a known id', () => {
    expect(reason(mint(good, {}, { kid: 'nobody' }))).toBe('kid');
    expect(reason(mint(good, {}, { kid: undefined }))).toBe('kid');
    expect(reason(mint(good, {}, { kid: 5 }))).toBe('kid');
    expect(reason(mint(good, {}, { kid: 'k2' }))).toBe('signature');
    expect(reason(mint(good, {}), { keyFor: () => undefined })).toBe('kid');
  });

  it('refuses a changed payload and a changed signature', () => {
    const token = mint(good);
    const [h, , s] = token.split('.');
    expect(reason(`${h}.${b64(claims({ aud: 'someone-else' }))}.${s}`)).toBe('signature');
    expect(reason(`${h}.${b64(claims({ exp: NOW / 1000 + 99999 }))}.${s}`)).toBe('signature');
    expect(reason(`${token.slice(0, -4)}AAAA`)).toBe('signature');
    expect(reason(`${token.slice(0, -300)}`)).not.toBeNull();
  });

  it('accepts only RS256: none, HMAC with the public key as the secret, other algorithms and crit are refused before the signature is looked at', () => {
    const body = b64(claims());
    expect(reason(`${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${body}.`)).toBe('malformed');
    expect(reason(`${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${body}.AAAA`)).toBe('algorithm');
    const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.${body}`;
    const secret = createPublicKey({ key: { kty: 'RSA', n: good.jwk.n, e: good.jwk.e }, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
    expect(reason(`${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`)).toBe('algorithm');
    for (const alg of ['RS384', 'RS512', 'PS256', 'ES256', 'rs256', 'RS256 ', undefined, 7]) expect(reason(mint(good, {}, { alg })), String(alg)).toBe('algorithm');
    expect(reason(mint(good, {}, { crit: ['exp'] }))).toBe('algorithm');
  });

  it('refuses a key that is too small, not for signing, or not RSA', () => {
    const small = pair('small', 1024);
    expect(reason(mint(small), { keyFor: () => small.jwk })).toBe('kid');
    expect(reason(mint(good), { keyFor: () => ({ ...good.jwk, use: 'enc' }) })).toBe('kid');
    expect(reason(mint(good), { keyFor: () => ({ ...good.jwk, kty: 'EC' }) })).toBe('kid');
    expect(reason(mint(good), { keyFor: () => ({ ...good.jwk, alg: 'RS512' }) })).toBe('kid');
    expect(reason(mint(good), { keyFor: () => ({ ...good.jwk, n: 'not base64!' }) })).toBe('kid');
  });

  it('refuses anything that is not three base64url parts of the right kinds', () => {
    for (const token of ['', 'a', 'a.b', 'a.b.c.d', '..', 'a..c', '.b.c', 'a.b.', `${b64('{')}.${b64('{}')}.AAAA`, `${b64('[]')}.${b64('{}')}.AAAA`, `${b64({ alg: 'RS256' })}.${b64('[]')}.AAAA`, 'a b.c.d', 'é.é.é', `${'a'.repeat(9000)}.b.c`]) {
      expect(reason(token), token.slice(0, 20)).toBe('malformed');
    }
    expect(decodeJwt(mint(good))).not.toBeNull();
    expect(kidOf(mint(good))).toBe('k1');
    expect(kidOf('nonsense')).toBeNull();
    expect(kidOf(`${b64({ alg: 'RS256' })}.x.y`)).toBeNull();
  });

  it('is fast on hostile input: a megabyte, thousands of dots, deep JSON', () => {
    const t0 = Date.now();
    for (const token of ['a'.repeat(1_000_000), '.'.repeat(1_000_000), `${b64('['.repeat(100_000))}.${b64('{}')}.AAAA`, `${b64({ alg: 'RS256', kid: 'k1', pad: 'x'.repeat(3000) })}.${b64({ a: 'x'.repeat(3000) })}.${'A'.repeat(1300)}`]) check(token);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('reads a published key set and leaves out what is not a key', () => {
    const set = parseKeySet({ keys: [good.jwk, { kty: 'RSA' }, 'x', null, { ...other.jwk, endorsements: ['msteams', 5, 'webchat'] }] });
    expect(set.map((k) => k.kid)).toEqual(['k1', 'k2']);
    expect(set[1]?.endorsements).toEqual(['msteams', 'webchat']);
    expect(parseKeySet(null)).toEqual([]);
    expect(parseKeySet({ keys: 'x' })).toEqual([]);
    expect(parseKeySet({ keys: Array.from({ length: 500 }, (_, i) => ({ ...good.jwk, kid: `k${String(i)}` })) })).toHaveLength(50);
  });
});

describe('the key cache', () => {
  const k = (kid: string): Jwk => ({ kty: 'RSA', kid, n: 'n', e: 'AQAB' });
  const make = (sets: Array<Jwk[] | Error>) => {
    let calls = 0;
    const cache = createKeyCache({
      ttlMs: 24 * 3_600_000,
      missRefreshMs: 60_000,
      staleMs: 7 * 24 * 3_600_000,
      async fetch() {
        const next = sets[Math.min(calls, sets.length - 1)]!;
        calls++;
        if (next instanceof Error) throw next;
        return next;
      },
    });
    return { cache, calls: () => calls };
  };
  const T = 1_000_000_000_000;

  it('fetches once, then serves from memory for a day', async () => {
    const { cache, calls } = make([[k('a')]]);
    expect((await cache.get('a', T))?.kid).toBe('a');
    expect((await cache.get('a', T + 3_600_000))?.kid).toBe('a');
    expect(cache.peek('a', T + 3_600_000)?.kid).toBe('a');
    expect(calls()).toBe(1);
    await cache.get('a', T + 25 * 3_600_000);
    expect(calls()).toBe(2);
  });

  it('looks again for a key id it has not seen, but not more than once a minute', async () => {
    const { cache, calls } = make([[k('a')], [k('a'), k('b')]]);
    await cache.get('a', T);
    expect(await cache.get('b', T + 10_000)).toBeUndefined();
    expect(calls()).toBe(1);
    expect((await cache.get('b', T + 61_000))?.kid).toBe('b');
    expect(calls()).toBe(2);
    // a flood of ids nobody published makes one call a minute, not one each
    for (let i = 0; i < 50; i++) await cache.get(`forged-${String(i)}`, T + 62_000 + i);
    expect(calls()).toBe(2);
    await cache.get('forged-x', T + 130_000);
    expect(calls()).toBe(3);
  });

  it('keeps using what it holds when the issuer cannot be reached, for a week past the day, then stops', async () => {
    const { cache } = make([[k('a')], new Error('down')]);
    await cache.get('a', T);
    expect((await cache.get('a', T + 25 * 3_600_000))?.kid).toBe('a');
    expect((await cache.get('a', T + 6 * 24 * 3_600_000))?.kid).toBe('a');
    expect(await cache.get('a', T + 9 * 24 * 3_600_000)).toBeUndefined();
  });

  it('does not hammer an issuer that is down on the very first try, and shares a fetch under way', async () => {
    const { cache, calls } = make([new Error('down')]);
    expect(await cache.get('a', T)).toBeUndefined();
    for (let i = 0; i < 20; i++) expect(await cache.get('a', T + 1000 + i)).toBeUndefined();
    expect(calls()).toBe(1);
    expect(await cache.get('a', T + 61_000)).toBeUndefined();
    expect(calls()).toBe(2);
    const shared = make([[k('a')]]);
    await Promise.all([shared.cache.get('a', T), shared.cache.get('a', T), shared.cache.get('a', T)]);
    expect(shared.calls()).toBe(1);
  });

  it('ignores an empty key set rather than dropping every key', async () => {
    const { cache } = make([[k('a')], []]);
    await cache.get('a', T);
    await cache.get('zzz', T + 61_000);
    expect(cache.peek('a', T + 61_000)?.kid).toBe('a');
  });
});

// --- the adapter on its own ---------------------------------------------------------------------------------------------------------------------------------

const ref = (over: Partial<BridgeAccountRef> = {}): BridgeAccountRef => ({ id: 'a1', workspaceId: 'w', provider: 'teams', handle: null, externalAppId: AUD, secrets: { bot_token: 'unit-client-secret-0001' }, ...over });
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const activity = (over: Record<string, unknown> = {}, conversation: Record<string, unknown> = {}): unknown => ({
  type: 'message',
  id: '1700000000001',
  timestamp: '2026-11-08T10:00:00.000Z',
  serviceUrl: SERVICE,
  channelId: 'msteams',
  from: { id: '29:1abc', name: 'Nadia Q' },
  conversation: { id: 'a:1personal', conversationType: 'personal', ...conversation },
  recipient: { id: `28:${AUD}`, name: 'Kahf Bot' },
  text: 'hello',
  ...over,
});

describe('the Teams adapter: reading activities', () => {
  it('reads a private message and a channel message, with the chat named by service address and conversation', () => {
    const [dm] = teamsAdapter.parse(ref(), activity());
    expect(dm).toMatchObject({ externalId: '1700000000001', chat: { id: `${SERVICE.replace(/\/$/, '')}|a:1personal`, kind: 'private', title: null }, sender: { id: '29:1abc', label: 'Nadia Q' }, text: 'hello', command: null, at: Date.parse('2026-11-08T10:00:00.000Z') });
    const [ch] = teamsAdapter.parse(ref(), activity({ text: '<at>Kahf Bot</at> hello team' }, { id: '19:abc@thread.tacv2', conversationType: 'channel', name: 'General' }));
    expect(ch).toMatchObject({ chat: { kind: 'group', title: 'General' }, text: 'hello team' });
    expect(teamsAdapter.parse(ref(), activity({}, { id: '19:grp@thread.v2', conversationType: 'groupChat' }))[0]?.chat.kind).toBe('group');
  });

  it('names a reply thread in a channel by the channel', () => {
    const base = teamsAdapter.parse(ref(), activity({}, { id: '19:abc@thread.tacv2', conversationType: 'channel' }))[0]!.chat.id;
    const thread = teamsAdapter.parse(ref(), activity({}, { id: '19:abc@thread.tacv2;messageid=1699999999999', conversationType: 'channel' }))[0]!.chat.id;
    expect(thread).toBe(base);
  });

  it('keeps an activity id from colliding with the same id in another conversation', () => {
    const a = teamsAdapter.parse(ref(), activity())[0]!.updateId;
    const b = teamsAdapter.parse(ref(), activity({}, { id: 'a:2other' }))[0]!.updateId;
    expect(a).not.toBe(b);
    expect(teamsAdapter.parse(ref(), activity())[0]!.updateId).toBe(a);
  });

  it('reads commands after the bot’s own mention, and leaves ordinary talk alone', () => {
    const cmd = (text: string, conversation: Record<string, unknown> = {}) => teamsAdapter.parse(ref(), activity({ text }, conversation))[0]?.command;
    expect(cmd('<at>Kahf Bot</at> connect 1234 5678', { id: '19:c@thread.tacv2', conversationType: 'channel' })).toEqual({ name: 'connect', argument: '1234 5678' });
    expect(cmd('/start 12345678')).toEqual({ name: 'start', argument: '12345678' });
    expect(cmd('!bot Brain')).toEqual({ name: 'bot', argument: 'Brain' });
    expect(cmd('unlink')).toEqual({ name: 'unlink', argument: '' });
    for (const text of ['connect the printer', 'start the build', 'bot status']) expect(cmd(text), text).toBeNull();
  });

  it('does not read a bot, itself, an update that is not a message, or an address outside the Microsoft list', () => {
    expect(teamsAdapter.parse(ref(), activity({ from: { id: '28:other', role: 'bot' } }))).toEqual([]);
    expect(teamsAdapter.parse(ref(), activity({ from: { id: `28:${AUD}` } }))).toEqual([]);
    expect(teamsAdapter.parse(ref(), activity({ type: 'conversationUpdate' }))).toEqual([]);
    expect(teamsAdapter.parse(ref(), activity({ type: 'typing' }))).toEqual([]);
    for (const serviceUrl of ['https://evil.example.com/', 'http://smba.trafficmanager.net/emea/', 'https://smba.trafficmanager.net.evil.example/', 'https://smba.trafficmanager.net@evil.example/', 'https://evil.trafficmanager.net/', 'https://evilbotframework.com/', 'https://smba.trafficmanager.net:8443/', 'https://smba.trafficmanager.net/emea/?x=1', 'https://smba.trafficmanager.net/a b/', 'not a url']) {
      expect(teamsAdapter.parse(ref(), activity({ serviceUrl })), serviceUrl).toEqual([]);
    }
    expect(teamsAdapter.parse(ref(), activity({ serviceUrl: 'https://smba.botframework.com/' }))).toHaveLength(1);
  });

  it('survives every odd shape without throwing', () => {
    for (const hostile of [null, 'x', 5, [], {}, activity({ id: 5 }), activity({ text: null }), activity({ from: null }), activity({ conversation: 'x' }), activity({ id: '' }), activity({ from: { id: 'x'.repeat(300) } }), activity({}, { id: 'x'.repeat(300) })]) {
      expect(() => teamsAdapter.parse(ref(), hostile)).not.toThrow();
      expect(teamsAdapter.parse(ref(), hostile)).toEqual([]);
    }
  });

  it('cleans a hostile display name', () => {
    const [m] = teamsAdapter.parse(ref(), activity({ from: { id: '29:1abc', name: `A${String.fromCharCode(0x202e)}\nB` } }));
    expect(m?.sender.label).toBe('A B');
  });
});

describe('the Teams adapter: text and chat names', () => {
  it('drops the bot’s mention, writes another mention as a plain name, drops markup and decodes entities', () => {
    expect(teamsPlain('<at>Kahf Bot</at> hello', ['Kahf Bot'])).toBe('hello');
    expect(teamsPlain('<at>kahf bot </at>  hello', ['Kahf Bot'])).toBe('hello');
    expect(teamsPlain('ask <at>Alice Q</at> about it', ['Kahf Bot'])).toBe('ask Alice Q about it');
    expect(teamsPlain('a<br>b<br />c<p>d</p>e', [])).toBe('a\nb\ncd\ne');
    expect(teamsPlain('<b>bold</b> &lt;i&gt; &amp; &quot;q&quot;&nbsp;x &#39;', [])).toBe('bold <i> & "q" x \'');
    expect(teamsPlain('&amp;lt;', [])).toBe('&lt;');
  });

  it('is linear on hostile text', () => {
    for (const text of ['<'.repeat(60_000), '<at>'.repeat(20_000), `<at>${'x'.repeat(100_000)}`, '<a '.repeat(30_000), '&'.repeat(60_000), '<at></at>'.repeat(10_000)]) {
      const t0 = Date.now();
      teamsPlain(text, ['Kahf Bot']);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it('makes a chat name only from an address on the list and a plain conversation id, and only when it fits', () => {
    expect(teamsChatId('https://smba.trafficmanager.net/emea/', '19:abc@thread.tacv2;messageid=5')).toBe('https://smba.trafficmanager.net/emea|19:abc@thread.tacv2');
    expect(teamsChatId('https://evil.example/', '19:abc')).toBeNull();
    expect(teamsChatId(SERVICE, 'has a space')).toBeNull();
    expect(teamsChatId(SERVICE, 'has|bar')).toBeNull();
    expect(teamsChatId(SERVICE, '')).toBeNull();
    expect(teamsChatId(SERVICE, 'x'.repeat(190))).toBeNull();
  });
});

describe('the Teams adapter: replies go only to Microsoft’s hosts', () => {
  it('never dials an address that is not on the list, and asks for no token first', async () => {
    const saved = process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
    delete process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('the network must not be used')));
    try {
      for (const to of ['https://evil.example.com/|19:x', 'http://smba.trafficmanager.net/emea/|19:x', 'https://smba.trafficmanager.net.evil.example/|19:x', 'https://smba.trafficmanager.net@evil.example/|19:x', 'https://evil.trafficmanager.net/|19:x', 'nonsense', '|19:x', 'https://smba.trafficmanager.net/emea/|']) {
        await expect(teamsAdapter.send(ref(), to, 'hi'), to).rejects.toBeInstanceOf(BridgeSendError);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (saved !== undefined) process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'] = saved;
    }
  });

  it('asks Microsoft for a token and posts to the region path of the listed address, once the token is held', async () => {
    const saved = process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
    delete process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      urls.push(url);
      expect(init?.redirect).toBe('manual');
      if (url.includes('/oauth2/')) return Promise.resolve(new Response(JSON.stringify({ access_token: 'unit-access-token', expires_in: 3600 }), { status: 200 }));
      expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer unit-access-token');
      return Promise.resolve(new Response(JSON.stringify({ id: 'sent-1' }), { status: 201 }));
    });
    try {
      const account = ref({ id: 'unit-send' });
      expect(await teamsAdapter.send(account, 'https://smba.trafficmanager.net/emea|19:abc@thread.tacv2', 'hi')).toBe('sent-1');
      expect(await teamsAdapter.send(account, 'https://smba.trafficmanager.net/emea|19:abc@thread.tacv2', 'again')).toBe('sent-1');
      expect(urls).toEqual([
        'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
        'https://smba.trafficmanager.net/emea/v3/conversations/19%3Aabc%40thread.tacv2/activities',
        'https://smba.trafficmanager.net/emea/v3/conversations/19%3Aabc%40thread.tacv2/activities',
      ]);
    } finally {
      spy.mockRestore();
      if (saved !== undefined) process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'] = saved;
    }
  });

  it('does not accept a request without the keys it needs, or an app that has no id', () => {
    const req = (headers: Record<string, string>): BridgeRequest => ({ method: 'POST', headers, query: {}, rawBody: Buffer.from('{}'), now: NOW });
    expect(teamsAdapter.verify(ref(), req({})).ok).toBe(false);
    expect(teamsAdapter.verify(ref(), req({ authorization: 'Bearer nonsense' })).ok).toBe(false);
    expect(teamsAdapter.verify(ref({ externalAppId: null }), req({ authorization: `Bearer ${mint(pair('x'))}` })).ok).toBe(false);
    expect(teamsAdapter.verify(ref(), req({ authorization: 'Basic abc' })).ok).toBe(false);
  });

  it('reads only Teams: a call signed for another channel of the same bot (Web Chat, Direct Line) is refused, whatever user id it names', async () => {
    const saved = process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
    delete process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
    forgetTeamsKeys();
    const good = pair('unit-channel-kid');
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ keys: [good.jwk] }), { status: 200 })));
    try {
      const token = mint(good);
      const ask = async (over: Record<string, unknown>): Promise<boolean> => {
        const req: BridgeRequest = { method: 'POST', headers: { authorization: `Bearer ${token}` }, query: {}, rawBody: Buffer.from(JSON.stringify(activity(over))), now: NOW };
        await teamsAdapter.prepare?.(ref(), req);
        return teamsAdapter.verify(ref(), req).ok;
      };
      expect(await ask({})).toBe(true);
      expect(await ask({ channelId: 'webchat' })).toBe(false);
      expect(await ask({ channelId: 'directline', from: { id: '29:1nadia', name: 'x' } })).toBe(false);
    } finally {
      spy.mockRestore();
      forgetTeamsKeys();
      if (saved !== undefined) process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'] = saved;
    }
  });
});

// --- end to end ---------------------------------------------------------------------------------------------------------------------------------------------

let w: World;
let teams: FakeTeams;
let accountId = '';
let dev = '';
const PERSONAL = 'a:1fake-personal-conversation';
const CHANNEL = '19:fakechannel@thread.tacv2';
const hook = (): string => `${w.server.url}/hooks/bridges/teams/${accountId}`;
const count = (sql: string, values: unknown[] = []): Promise<number> => w.system(async (tx) => Number((await tx.query<{ n: string }>(sql, values)).rows[0]!.n));
const messagesIn = (channelId: string): Promise<number> => count('SELECT count(*) AS n FROM app.messages WHERE channel_id = $1', [channelId]);
const runs = (): Promise<number> => count("SELECT (SELECT count(*) FROM app.bot_runs) + (SELECT count(*) FROM app.jobs WHERE queue LIKE 'runtime-hermes.%') AS n");
const sentTo = (conversation: string): string[] => teams.sent.filter((m) => m.conversationId === conversation).map((m) => m.text);
const waitFor = (conversation: string, n: number): Promise<string[]> => eventually(async () => (sentTo(conversation).length >= n ? sentTo(conversation) : undefined), 20_000, `${n} message(s) to ${conversation}`);
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));
const keyFetches = (): number => teams.calls.filter((c) => c.path === '/v1/.well-known/keys').length;
const NADIA = '29:1nadia';
const say = (o: { text: string; from?: string; where?: 'personal' | 'channel'; conversationId?: string; activityId?: string; jwt?: TeamsJwtMode; repeat?: number; serviceUrl?: string; mention?: boolean }) =>
  teams.teamsSend({ text: o.text, fromId: o.from ?? NADIA, conversation: o.where ?? 'personal', ...(o.conversationId ? { conversationId: o.conversationId } : {}), ...(o.activityId ? { activityId: o.activityId } : {}), ...(o.jwt ? { jwt: o.jwt } : {}), ...(o.repeat ? { repeat: o.repeat } : {}), ...(o.serviceUrl ? { serviceUrl: o.serviceUrl } : {}), ...(o.mention !== undefined ? { mention: o.mention } : {}) });

async function codeFor(who: typeof nadia): Promise<string> {
  const res = await w.call<{ code: string }>(who, 'POST', '/api/me/bridges/teams/link-code');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.code;
}

beforeAll(async () => {
  teams = await startFakeTeams();
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  await w.system(async (tx) => {
    for (const [slug, trigger, fill] of [
      ['teamsbot', 'mention', 'e'],
      ['chatbot', 'conversation', 'f'],
    ] as const) {
      const bot = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
         VALUES ($1, $2, $3, $3, '', 'agent', 'hermes', 'team', repeat($4, 64), 'active', $5::jsonb, ARRAY['smart']) RETURNING id`,
        [omar.workspaceId, TEAM_IDS.Engineering, slug, fill, JSON.stringify([{ type: trigger }])],
      );
      const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id]);
      await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, omar.workspaceId]);
    }
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
  await teams?.stop();
  forgetTeamsKeys();
  delete process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'];
});

describe('the admin turns Teams on', () => {
  // the stand-in is pointed at only from here on, so the adapter tests above see the real Microsoft address list
  beforeAll(() => {
    process.env['MANYTHREADS_BRIDGE_TEAMS_FAKE_BASE'] = teams.url;
    forgetTeamsKeys();
  });
  it('takes the application id and the client secret, asks Microsoft for a token to check them, and never gives either back', async () => {
    expect((await w.call(nadia, 'PUT', '/api/admin/bridges/teams', { displayName: 'Kahf Teams' })).status).toBe(403);
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/teams', { displayName: 'Kahf Teams', externalAppId: 'not-a-guid' })).status).toBe(400);
    const made = await w.call<{ account: { id: string } }>(omar, 'PUT', '/api/admin/bridges/teams', { displayName: 'Kahf Teams', externalAppId: teams.appId });
    expect(made.status).toBe(201);
    accountId = made.body.account.id;
    // Teams has no signing secret (Microsoft signs with its own keys), and switching on before the secret is in says what is missing
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/teams/credentials', { signingSecret: 'abcdefghijkl-abcdefghijkl' })).status).toBe(400);
    const early = await w.call<{ account: { status: string; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/teams/switch', { on: true });
    expect(early.body.account.status).toBe('off');
    expect(early.body.account.lastError).toMatch(/client secret/i);
    // a secret Microsoft does not accept
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/teams/credentials', { botToken: 'a-client-secret-that-is-wrong' })).status).toBe(200);
    const wrong = await w.call<{ account: { status: string; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/teams/switch', { on: true });
    expect(wrong.body.account.status).toBe('off');
    expect(wrong.body.account.lastError).toMatch(/did not accept/i);
    expect(JSON.stringify(wrong.body)).not.toContain('a-client-secret-that-is-wrong');
    const put = await w.call(omar, 'PUT', '/api/admin/bridges/teams/credentials', { botToken: FAKE_TEAMS_CLIENT_SECRET });
    expect(put.status).toBe(200);
    const on = await w.call<{ account: { status: string; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/teams/switch', { on: true });
    expect(JSON.stringify(on.body)).toBeTruthy();
    expect(on.body.account?.lastError, JSON.stringify(on.body)).toBeNull();
    expect(on.body.account.status).toBe('on');
    expect(teams.tokenRequests()).toBeGreaterThanOrEqual(1);
    const listed = JSON.stringify((await w.call(omar, 'GET', '/api/admin/bridges')).body);
    expect(listed).not.toContain(FAKE_TEAMS_CLIENT_SECRET);
    teams.setCallback(hook());
  });
});

describe('Microsoft’s token on every call', () => {
  const BROKEN: TeamsJwtMode[] = ['missing', 'wrong-issuer', 'wrong-audience', 'expired', 'not-yet', 'unknown-kid', 'bad-signature', 'alg-none', 'hmac', 'wrong-service-url', 'no-service-url', 'unendorsed'];

  it('a right token is read', async () => {
    const res = await say({ text: 'hello', from: '29:1stranger', conversationId: 'a:1probe' });
    expect(res.responses[0]?.status).toBe(200);
    await waitFor('a:1probe', 1);
  });

  it.each(BROKEN)('a token that is %s is 401 and leaves no row and no reply', async (jwt) => {
    const before = { rows: await count('SELECT count(*) AS n FROM app.bridge_messages'), chats: await count('SELECT count(*) AS n FROM app.bridge_unlinked_chats'), sent: teams.sent.length };
    const res = await say({ text: 'hello', from: '29:1forger', conversationId: 'a:1forger', jwt });
    expect(res.responses[0]?.status, jwt).toBe(401);
    await new Promise((r) => setTimeout(r, 200));
    expect(await count('SELECT count(*) AS n FROM app.bridge_messages')).toBe(before.rows);
    expect(await count('SELECT count(*) AS n FROM app.bridge_unlinked_chats')).toBe(before.chats);
    expect(teams.sent.length).toBe(before.sent);
  });

  it('a flood of key ids nobody published makes at most one new look at Microsoft’s keys a minute', async () => {
    const before = keyFetches();
    for (let i = 0; i < 6; i++) expect((await say({ text: 'x', from: '29:1forger', conversationId: 'a:1forger', jwt: 'unknown-kid' })).responses[0]?.status).toBe(401);
    expect(keyFetches() - before).toBeLessThanOrEqual(1);
  });

  it('an unknown account looks the same as a switched-off one: 404', async () => {
    const res = await fetch(`${w.server.url}/hooks/bridges/teams/00000000-0000-7000-8000-000000000999`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('a sender who is not linked', () => {
  it('stores nothing, starts no run, asks no model, and gets exactly one reply', async () => {
    const before = { messages: await count('SELECT count(*) AS n FROM app.messages'), runs: await runs(), inbound: await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'in'") };
    for (const text of ['@teamsbot please run the deploy', 'hello?', 'anyone there']) expect((await say({ text, from: '29:1stranger2', conversationId: 'a:1stranger2' })).responses[0]?.status).toBe(200);
    await waitFor('a:1stranger2', 1);
    await quiet();
    expect(sentTo('a:1stranger2')).toHaveLength(1);
    expect(sentTo('a:1stranger2')[0]).toMatch(/link/i);
    expect(await count('SELECT count(*) AS n FROM app.messages')).toBe(before.messages);
    expect(await runs()).toBe(before.runs);
    expect(await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'in'")).toBe(before.inbound);
  });
});

describe('linking and the code lockout', () => {
  it('five wrong codes lock the chat, even for the right code afterwards', async () => {
    const good = await codeFor(rafi);
    for (let i = 0; i < 5; i++) await say({ text: `start 0000000${String(i)}`, from: '29:1locked', conversationId: 'a:1locked' });
    await waitFor('a:1locked', 5);
    const before = sentTo('a:1locked').length;
    await say({ text: good, from: '29:1locked', conversationId: 'a:1locked' });
    await waitFor('a:1locked', before + 1);
    expect(sentTo('a:1locked').at(-1)).toMatch(/too many/i);
    expect(await count('SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = $1', ['29:1locked'])).toBe(0);
  });

  it('a code typed alone in a personal chat links a person, once', async () => {
    const code = await codeFor(nadia);
    await say({ text: code, conversationId: PERSONAL });
    expect((await waitFor(PERSONAL, 1))[0]).toMatch(/linked/i);
    const mine = await w.call<{ identities: Array<{ provider: string }> }>(nadia, 'GET', '/api/me/bridges');
    expect(mine.body.identities.map((i) => i.provider)).toContain('teams');
    await say({ text: code, from: '29:1other', conversationId: 'a:1other' });
    await waitFor('a:1other', 1);
    expect(await count('SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = $1', ['29:1other'])).toBe(0);
  });
});

describe('a joined channel', () => {
  it('links with a message that mentions the bot, then a linked person posts as themselves via Teams and a bot mention runs for them', async () => {
    expect((await w.call(nadia, 'POST', `/api/channels/${dev}/bridge-links/teams/code`)).status).toBe(403);
    const made = await w.call<{ code: string; command: string; instruction: string }>(omar, 'POST', `/api/channels/${dev}/bridge-links/teams/code`);
    expect(made.status).toBe(201);
    expect(made.body.command).toBe(`connect ${made.body.code}`);
    expect(made.body.instruction).toMatch(/Teams channel/);
    expect(made.body.instruction).toMatch(/@mention/);
    await say({ text: made.body.command, where: 'channel' });
    expect((await waitFor(CHANNEL, 1))[0]).toMatch(/joined to #dev/i);

    const before = await messagesIn(dev);
    await say({ text: 'Standup notes are in the doc', where: 'channel' });
    const row = await eventually(async () => w.system(async (tx) => (await tx.query<{ author: string; via: string | null; body: string }>("SELECT m.author_id AS author, m.meta #>> '{via,provider}' AS via, m.body FROM app.messages m WHERE m.channel_id = $1 AND m.body LIKE 'Standup notes%'", [dev])).rows[0]));
    expect(row.author).toBe(nadia.actorId);
    expect(row.via).toBe('teams');
    expect(row.body).toBe('Standup notes are in the doc');
    expect(await messagesIn(dev)).toBe(before + 1);

    await say({ text: '@teamsbot what is on today?', where: 'channel' });
    const job = await eventually(
      async () => w.system(async (tx) => (await tx.query<{ asker: string | null; trigger: string }>("SELECT payload->>'askerActorId' AS asker, payload->>'trigger' AS trigger FROM app.jobs WHERE queue = 'runtime-hermes.run' AND payload->>'channelId' = $1 ORDER BY id DESC LIMIT 1", [dev])).rows[0]),
      30_000,
      'a queued run',
    );
    expect(job.asker).toBe(nadia.actorId);
    expect(job.trigger).toBe('mention');
  });

  it('a reply inside a thread of the channel joins the channel as a whole', async () => {
    await say({ text: 'Threaded words', where: 'channel', conversationId: `${CHANNEL};messageid=1699999999999` });
    await eventually(async () => ((await count("SELECT count(*) AS n FROM app.messages WHERE channel_id = $1 AND body = 'Threaded words'", [dev])) === 1 ? true : undefined));
  });

  it('the channel’s next message reaches Teams once, at the region path, and what came in from Teams does not bounce back', async () => {
    const posted = await w.call(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, threadRootId: null, body: 'Release is at five' });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    await eventually(async () => (sentTo(CHANNEL).some((t) => t.includes('Release is at five')) ? true : undefined), 30_000, 'the outbound message');
    await quiet();
    expect(sentTo(CHANNEL).filter((t) => t.includes('Release is at five'))).toHaveLength(1);
    expect(sentTo(CHANNEL).filter((t) => t.includes('Standup notes'))).toHaveLength(0);
    // the reply was posted under the service address's region path, with a token from Microsoft
    expect(teams.calls.some((c) => c.path === `/emea/v3/conversations/${encodeURIComponent(CHANNEL)}/activities` && c.authorized)).toBe(true);
    expect(teams.sent.find((m) => m.text.includes('Release is at five'))?.textFormat).toBe('plain');
  });

  it('a replayed activity id is read once', async () => {
    const before = await messagesIn(dev);
    await say({ text: 'only once please', where: 'channel', activityId: 'replay-1', repeat: 3 });
    await eventually(async () => ((await messagesIn(dev)) > before ? true : undefined));
    await quiet();
    expect(await messagesIn(dev)).toBe(before + 1);
  });

  it('an unlinked person in a joined channel is dropped, not posted', async () => {
    const before = await messagesIn(dev);
    await say({ text: 'let me in', where: 'channel', from: '29:1intruder' });
    await quiet();
    expect(await messagesIn(dev)).toBe(before);
    expect(await count("SELECT count(*) AS n FROM app.messages WHERE body LIKE 'let me in%'")).toBe(0);
  });

  it('treats the text as hostile: control characters, markup and @channel are defused', async () => {
    await say({ text: `hey ${String.fromCharCode(0x202e)}@channel${String.fromCharCode(7)} <at>Alice Q</at> &lt;b&gt; look`, where: 'channel' });
    const body = await eventually(async () => w.system(async (tx) => (await tx.query<{ body: string }>("SELECT body FROM app.messages WHERE channel_id = $1 AND body LIKE 'hey %' ORDER BY created_at DESC LIMIT 1", [dev])).rows[0]?.body));
    expect(body).not.toContain(String.fromCharCode(0x202e));
    expect(body).not.toContain(String.fromCharCode(7));
    expect(body).not.toContain('@channel');
    expect(body).toContain('Alice Q <b> look');
    expect(body).not.toContain('<at>');
  });

  it('an address outside the Microsoft list is never dialled and nothing is stored', async () => {
    const before = { messages: await count('SELECT count(*) AS n FROM app.messages'), rows: await count('SELECT count(*) AS n FROM app.bridge_messages'), calls: teams.calls.length, sent: teams.sent.length };
    // the token is right and names that address, so the call itself is read; the chat it came from cannot be answered, so it is not kept
    for (const serviceUrl of ['https://evil.example.com/', 'https://smba.trafficmanager.net.evil.example/', 'http://smba.trafficmanager.net/emea/']) {
      expect((await say({ text: 'hello', serviceUrl, conversationId: 'a:1evil' })).responses[0]?.status).toBe(200);
    }
    await quiet();
    expect(await count('SELECT count(*) AS n FROM app.messages')).toBe(before.messages);
    expect(await count('SELECT count(*) AS n FROM app.bridge_messages')).toBe(before.rows);
    expect(teams.sent.length).toBe(before.sent);
    expect(teams.calls.slice(before.calls).filter((c) => c.path.includes('/v3/'))).toHaveLength(0);
  });
});

describe('a personal chat with the bot', () => {
  it('a linked person’s message goes to their conversation with a bot, as them', async () => {
    await say({ text: 'What is blocking the release?', conversationId: PERSONAL });
    const post = await eventually(async () => w.system(async (tx) => (await tx.query<{ author_id: string; via: string | null }>("SELECT author_id, meta #>> '{via,provider}' AS via FROM app.messages WHERE body = 'What is blocking the release?'")).rows[0]));
    expect(post.author_id).toBe(nadia.actorId);
    expect(post.via).toBe('teams');
  });
});

describe('when Microsoft or Teams changes', () => {
  it('a busy connector (429, then a server error) is tried again and the message arrives once', async () => {
    teams.failNext(429, 1, 1);
    const posted = await w.call(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, threadRootId: null, body: 'After the rate limit' });
    expect(posted.status).toBeLessThan(300);
    await eventually(async () => (sentTo(CHANNEL).some((t) => t.includes('After the rate limit')) ? true : undefined), 60_000, 'the retried message');
    await quiet();
    expect(sentTo(CHANNEL).filter((t) => t.includes('After the rate limit'))).toHaveLength(1);
  });

  it('Microsoft rotating its signing keys is followed once the held keys are forgotten', async () => {
    teams.rotateKeys();
    // the old key is gone from the published set; what is held still works until it is looked at again
    forgetTeamsKeys();
    const res = await say({ text: 'after rotation', from: '29:1stranger3', conversationId: 'a:1stranger3' });
    expect(res.responses[0]?.status).toBe(200);
    await waitFor('a:1stranger3', 1);
  });
});
