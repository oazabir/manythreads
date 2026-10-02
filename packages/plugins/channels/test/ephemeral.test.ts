import {
  HeartbeatResponse,
  ListPresenceResponse,
  ListTypingResponse,
  PRESENCE_TTL_SECONDS,
  TYPING_TTL_SECONDS,
  TypingResponse,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, sameera, lena } = personas;

let w: World;
let dev = '';
let releases = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const beat = (who: Persona, status?: string): Promise<ApiResult> => w.call(who, 'POST', '/api/presence', status ? { status } : {});
const present = async (who: Persona): Promise<string[]> =>
  ListPresenceResponse.parse(ok(await w.call(who, 'GET', '/api/presence'))).people.map((p) => p.personId).sort();
const typing = (who: Persona, channelId: string, body: unknown = {}): Promise<ApiResult> => w.call(who, 'POST', `/api/channels/${channelId}/typing`, body);
const typists = async (who: Persona, channelId: string): Promise<string[]> =>
  ListTypingResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/typing`))).typing.map((t) => t.personId);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('presence (UNLOGGED table, heartbeat every 30 s, offline after 90 s)', () => {
  it('the table is unlogged', async () => {
    const rows = await w.system(async (tx) => (await tx.query<{ relname: string; relpersistence: string }>(
      "SELECT relname, relpersistence FROM pg_class WHERE relname IN ('presence', 'typing') AND relnamespace = 'app'::regnamespace ORDER BY relname")).rows);
    expect(rows).toEqual([{ relname: 'presence', relpersistence: 'u' }, { relname: 'typing', relpersistence: 'u' }]);
  });

  it('a heartbeat marks the person online until it ages out; the status can change', async () => {
    const first = HeartbeatResponse.parse(ok(await beat(nadia)));
    expect(first.status).toBe('online');
    expect(Date.parse(first.expiresAt) - Date.parse(first.seenAt)).toBe(PRESENCE_TTL_SECONDS * 1000);
    ok(await beat(rafi, 'away'));
    expect(await present(omar)).toEqual([nadia.personId, rafi.personId].sort());
    const list = ListPresenceResponse.parse(ok(await w.call(omar, 'GET', '/api/presence')));
    expect(list.people.find((p) => p.personId === rafi.personId)?.status).toBe('away');
    expect(HeartbeatResponse.parse(ok(await beat(rafi))).status).toBe('online');
    // One row per person however often they beat.
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.presence WHERE person_id = $1', [rafi.personId])).rows.length)).toBe(1);
  });

  it('a heartbeat older than 90 seconds is offline (the expiry filter, no reaper needed)', async () => {
    await w.system((tx) => tx.query("UPDATE app.presence SET seen_at = now() - interval '91 seconds' WHERE person_id = $1", [rafi.personId]));
    expect(await present(omar)).toEqual([nadia.personId]);
    await w.system((tx) => tx.query("UPDATE app.presence SET seen_at = now() - interval '89 seconds' WHERE person_id = $1", [rafi.personId]));
    expect(await present(omar)).toEqual([nadia.personId, rafi.personId].sort());
  });

  it('a guest sees only themself; members see the guest', async () => {
    ok(await beat(lena));
    expect(await present(lena)).toEqual([lena.personId]);
    expect(await present(nadia)).toContain(lena.personId);
  });

  it('rejects a bad status or body and a request without sign-in', async () => {
    expect((await beat(nadia, 'busy')).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/presence', { status: 'online', other: 1 })).status).toBe(400);
    expect((await w.call(null, 'POST', '/api/presence', {})).status).toBe(401);
    expect((await w.call(null, 'GET', '/api/presence')).status).toBe(401);
  });
});

describe('typing (UNLOGGED table, expires after 5 s)', () => {
  it('shows the person typing to the others in the channel until it expires', async () => {
    const res = TypingResponse.parse(ok(await typing(nadia, dev)));
    expect(Date.parse(res.expiresAt) - Date.now()).toBeGreaterThan((TYPING_TTL_SECONDS - 2) * 1000);
    expect(Date.parse(res.expiresAt) - Date.now()).toBeLessThanOrEqual(TYPING_TTL_SECONDS * 1000 + 500);
    expect(await typists(rafi, dev)).toEqual([nadia.personId]);
    expect(await typists(nadia, dev)).toEqual([]);                 // not yourself
    await sleep(TYPING_TTL_SECONDS * 1000 + 300);
    expect(await typists(rafi, dev)).toEqual([]);                  // expired: nobody deleted anything
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.typing WHERE person_id = $1', [nadia.personId])).rows.length)).toBe(1);
  }, 20_000);

  it('repeating extends it; the next request of the channel sweeps rows that expired; sending a message ends it', async () => {
    ok(await typing(nadia, dev));
    ok(await typing(nadia, dev, { threadRootId: null }));
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.typing WHERE channel_id = $1', [dev])).rows.length)).toBe(1);
    await w.system((tx) => tx.query("UPDATE app.typing SET expires_at = now() - interval '1 minute' WHERE channel_id = $1", [dev]));
    ok(await typing(rafi, dev));
    expect(await w.system(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.typing WHERE channel_id = $1', [dev])).rows.map((r) => r.person_id))).toEqual([rafi.personId]);
    ok(await typing(nadia, dev));
    expect(await typists(rafi, dev)).toEqual([nadia.personId]);
    ok(await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'sent', threadRootId: null }), 201);
    expect(await typists(rafi, dev)).toEqual([]);
  });

  it('is only for people who can post in a channel they can see: 403 elsewhere, 409 when archived, 400 for a bad body', async () => {
    expect((await typing(sameera, dev)).status).toBe(403);                     // another team's channel
    expect((await w.call(sameera, 'GET', `/api/channels/${dev}/typing`)).status).toBe(403);
    await w.system((tx) => tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`, [lena.workspaceId, releases, lena.personId]));
    expect((await typing(lena, releases)).status).toBe(403);                   // read grant only: she cannot post
    expect((await w.call(lena, 'GET', `/api/channels/${releases}/typing`)).status).toBe(200);
    expect((await typing(nadia, dev, { threadRootId: 'nope' })).status).toBe(400);
    expect((await typing(nadia, dev, { extra: 1 })).status).toBe(400);
    expect((await w.call(null, 'POST', `/api/channels/${dev}/typing`, {})).status).toBe(401);
    const archived = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'typing-archived' }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${archived}/archive`));
    expect((await typing(omar, archived)).status).toBe(409);
  });

  it('a typing row of a private channel is read only by its members', async () => {
    const priv = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'typing-private', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId }));
    ok(await typing(omar, priv));
    expect(await typists(rafi, priv)).toEqual([omar.personId]);
    expect((await w.call(nadia, 'GET', `/api/channels/${priv}/typing`)).status).toBe(403);
    expect((await typing(nadia, priv)).status).toBe(403);
  });
});
