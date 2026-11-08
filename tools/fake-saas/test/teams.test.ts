import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_TEAMS_CLIENT_SECRET, startFakeTeams, TEAMS_ISSUER, type FakeTeams, type TeamsJwtMode } from '../src/providers/teams.ts';
import { call, startReceiver, type Receiver } from './helpers.ts';

let teams: FakeTeams;
let receiver: Receiver;

beforeEach(async () => {
  teams = await startFakeTeams();
  receiver = await startReceiver();
});
afterEach(async () => {
  await teams.stop();
  await receiver.close();
});

const token = async (secret: string = FAKE_TEAMS_CLIENT_SECRET, id: string = teams.appId) =>
  fetch(`${teams.url}/botframework.com/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'https://api.botframework.com/.default' }).toString(),
  });
const claimsOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
const headerOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
const bearerOf = (i: number): string => /^Bearer (.+)$/.exec(receiver.received[i]!.headers['authorization'] ?? '')?.[1] ?? '';

describe('the hosts the bridge talks to', () => {
  it('publishes its signing keys with endorsements, and an openid document that points at them', async () => {
    const keys = await call(`${teams.url}/v1/.well-known/keys`);
    expect(keys.json.keys[0]).toMatchObject({ kty: 'RSA', use: 'sig', kid: teams.kid(), endorsements: expect.arrayContaining(['msteams']) });
    expect(typeof keys.json.keys[0].n).toBe('string');
    expect(keys.json.keys[0].d).toBeUndefined();
    const doc = await call(`${teams.url}/v1/.well-known/openidconfiguration`);
    expect(doc.json.jwks_uri).toBe(`${teams.url}/v1/.well-known/keys`);
  });

  it('gives an access token for the right id and secret and 401 for a wrong secret', async () => {
    const ok = await token();
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { access_token: string }).access_token).toMatch(/^fake-teams-access-/);
    expect((await token('wrong')).status).toBe(401);
    expect(teams.tokenRequests()).toBe(1);
  });

  it('takes an activity only with a token it gave, records it, and can be told to fail', async () => {
    const path = `${teams.url}/emea/v3/conversations/${encodeURIComponent('19:abc@thread.tacv2')}/activities`;
    const body = { type: 'message', text: 'hello', textFormat: 'plain' };
    expect((await call(path, { body, token: 'nope' })).status).toBe(401);
    const bearer = ((await (await token()).json()) as { access_token: string }).access_token;
    const sent = await call(path, { body, token: bearer });
    expect(sent.status).toBe(201);
    expect(teams.sent).toMatchObject([{ conversationId: '19:abc@thread.tacv2', text: 'hello', textFormat: 'plain' }]);
    teams.failNext(429, 1, 3);
    const busy = await call(path, { body, token: bearer });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('3');
    expect((await call(path, { body: { type: 'message', text: '' }, token: bearer })).status).toBe(400);
  });
});

describe('the activities it sends', () => {
  it('a right token has the issuer, the audience, the service address and a published key id', async () => {
    teams.setCallback(`${receiver.url}/hooks/bridges/teams/a1`);
    await teams.teamsSend({ text: 'hi', fromId: '29:1abc' });
    const jwt = bearerOf(0);
    expect(claimsOf(jwt)).toMatchObject({ iss: TEAMS_ISSUER, aud: teams.appId, serviceurl: `${teams.url}/emea/` });
    expect(headerOf(jwt)).toMatchObject({ alg: 'RS256', kid: teams.kid() });
    const activity = JSON.parse(receiver.received[0]!.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(activity).toMatchObject({ type: 'message', text: 'hi', from: { id: '29:1abc' }, recipient: { id: `28:${teams.appId}` }, conversation: { conversationType: 'personal' } });
  });

  it('a channel message mentions the bot', async () => {
    teams.setCallback(`${receiver.url}/x`);
    await teams.teamsSend({ text: 'connect 12345678', fromId: '29:1abc', conversation: 'channel' });
    const activity = JSON.parse(receiver.received[0]!.body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(activity.conversation.conversationType).toBe('channel');
    expect(activity.text).toMatch(/^<at>.+<\/at> connect 12345678$/);
    expect(activity.entities[0]).toMatchObject({ type: 'mention' });
  });

  it('every broken mode makes a token that differs in exactly the way it names', async () => {
    teams.setCallback(`${receiver.url}/x`);
    const modes: TeamsJwtMode[] = ['wrong-issuer', 'wrong-audience', 'expired', 'not-yet', 'unknown-kid', 'bad-signature', 'alg-none', 'hmac', 'wrong-service-url', 'no-service-url', 'unendorsed', 'missing'];
    for (const jwt of modes) await teams.teamsSend({ text: 'x', fromId: '29:1abc', jwt });
    const at = (m: TeamsJwtMode): string => bearerOf(modes.indexOf(m));
    expect(claimsOf(at('wrong-issuer'))['iss']).not.toBe(TEAMS_ISSUER);
    expect(claimsOf(at('wrong-audience'))['aud']).not.toBe(teams.appId);
    expect(Number(claimsOf(at('expired'))['exp'])).toBeLessThan(Date.now() / 1000 - 600);
    expect(Number(claimsOf(at('not-yet'))['nbf'])).toBeGreaterThan(Date.now() / 1000 + 600);
    expect(headerOf(at('unknown-kid'))['kid']).not.toBe(teams.kid());
    expect(headerOf(at('alg-none'))['alg']).toBe('none');
    expect(headerOf(at('hmac'))['alg']).toBe('HS256');
    expect(claimsOf(at('wrong-service-url'))['serviceurl']).not.toBe(`${teams.url}/emea/`);
    expect(claimsOf(at('no-service-url'))['serviceurl']).toBeUndefined();
    expect(receiver.received[modes.indexOf('missing')]!.headers['authorization']).toBeUndefined();
    expect(teams.deliveries.map((d) => d.jwt)).toEqual(modes);
  });

  it('plays a service address of the caller’s choosing, a repeat, and rotated keys', async () => {
    teams.setCallback(`${receiver.url}/x`);
    await teams.teamsSend({ text: 'x', fromId: '29:1abc', serviceUrl: 'https://evil.example.com/', activityId: 'act-1', repeat: 2 });
    expect(receiver.received).toHaveLength(2);
    expect(claimsOf(bearerOf(0))['serviceurl']).toBe('https://evil.example.com/');
    const before = teams.kid();
    teams.rotateKeys();
    expect(teams.kid()).not.toBe(before);
    const keys = await call(`${teams.url}/v1/.well-known/keys`);
    expect(keys.json.keys.map((k: { kid: string }) => k.kid)).not.toContain(before);
  });

  it('refuses to send with no callback address', async () => {
    await expect(teams.teamsSend({ text: 'x', fromId: '29:1abc' })).rejects.toThrow(/callback/);
  });
});
