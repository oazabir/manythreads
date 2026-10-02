import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { eventRegistry, parseEvent, type EventType } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type Persona, type World } from '../world.ts';

const { omar, nadia, rafi } = personas;

// Event contract tests (pnpm test:events): every event the channels plugin emits is stored in the shape its registered schema
// accepts, as the acting person, with the right team column; a refused request emits nothing.

const EMITTED = [
  'channel.channel.created',
  'channel.channel.updated',
  'channel.channel.archived',
  'channel.member.added',
  'channel.member.removed',
  'channel.message.posted',
  'channel.message.edited',
  'channel.message.deleted',
  'channel.reaction.changed',
] as const satisfies readonly EventType[];

let w: World;
let before: string | null = null;
let teamId = '';
let created = '';
let msg = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  before = await w.system(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null);
  teamId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  const call = async <T>(who: Persona, method: string, path: string, body?: unknown): Promise<T> => {
    const res = await w.call<T>(who, method, path, body);
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  created = (await call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'events-private', private: true })).channel.id;
  await call(omar, 'PATCH', `/api/channels/${created}`, { purpose: 'audit trail' });
  await call(omar, 'POST', `/api/channels/${created}/members`, { personId: rafi.personId });
  await call(rafi, 'POST', `/api/channels/${created}/leave`);
  await call(omar, 'POST', `/api/channels/${created}/archive`);
  await call(omar, 'POST', `/api/channels/${created}/unarchive`);
  const dev = await w.channelId('engineering', 'dev');
  await call(nadia, 'POST', `/api/channels/${dev}/join`);
  msg = (await call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'hello', threadRootId: null })).id;
  await call(nadia, 'PATCH', `/api/channels/${dev}/messages/${msg}`, { body: 'hello again' });
  await call(rafi, 'POST', `/api/channels/${dev}/messages/${msg}/reactions`, { emoji: '👍' });
  await call(rafi, 'DELETE', `/api/channels/${dev}/messages/${msg}/reactions/${encodeURIComponent('👍')}`);
  await call(nadia, 'DELETE', `/api/channels/${dev}/messages/${msg}`);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const stored = (types: readonly string[] = EMITTED): Promise<EventRow[]> =>
  w.system(async (tx) => {
    const res = await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
       WHERE ($1::uuid IS NULL OR id > $1::uuid) AND type = ANY($2::text[]) ORDER BY id`,
      [before, [...types]],
    );
    return res.rows;
  });

describe('channel events', () => {
  it('registers every event the plugin declares, at schema version 1, and the manifest lists exactly them', async () => {
    for (const type of EMITTED) expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    const plugin = (await import('../../src/index.ts')).default;
    expect([...plugin.manifest.events.emits].sort()).toEqual([...EMITTED].sort());
  });

  it('every stored event parses against its registered schema', async () => {
    const rows = await stored();
    expect(rows.length).toBe(12);   // nine types; archive twice, a member added twice, a reaction added and taken back
    for (const row of rows) expect(parseEvent(eventToRaw(row)).type).toBe(row.type);
  });

  it('all nine types were emitted, as the acting person, in the team of the channel', async () => {
    const rows = await stored();
    expect([...new Set(rows.map((r) => r.type))].sort()).toEqual([...EMITTED].sort());
    const actors: Record<string, string> = {
      'channel.channel.created': omar.actorId,
      'channel.channel.updated': omar.actorId,
      'channel.channel.archived': omar.actorId,
      'channel.message.posted': nadia.actorId,
      'channel.message.edited': nadia.actorId,
      'channel.message.deleted': nadia.actorId,
    };
    for (const row of rows) {
      expect(row.workspace_id).toBe(omar.workspaceId);
      expect(row.team_id).toBe(teamId);
      const expected = actors[row.type];
      if (expected) expect(row.actor_id, row.type).toBe(expected);
    }
  });

  it('payloads say what an audit needs and never carry message text', async () => {
    const rows = await stored();
    const of = (type: string) => rows.filter((r) => r.type === type).map((r) => r.payload as Record<string, unknown>);
    expect(of('channel.channel.created')[0]).toMatchObject({ channelId: created, name: 'events-private', kind: 'channel', private: true });
    expect(of('channel.channel.updated')[0]).toMatchObject({ channelId: created, changes: { purpose: 'audit trail' } });
    expect(of('channel.channel.archived').map((p) => p['archived'])).toEqual([true, false]);
    expect(of('channel.member.added').map((p) => [p['personId'], p['self']])).toEqual([[rafi.personId, false], [nadia.personId, true]]);
    expect(of('channel.member.removed')[0]).toMatchObject({ personId: rafi.personId, self: true });
    expect(of('channel.message.posted')[0]).toMatchObject({ messageId: msg, authorId: nadia.actorId, threadRootId: null });
    expect(of('channel.message.edited')[0]).toMatchObject({ messageId: msg, editorId: nadia.actorId });
    expect(of('channel.message.deleted')[0]).toMatchObject({ messageId: msg, deletedBy: nadia.actorId });
    expect(of('channel.reaction.changed').map((p) => [p['emoji'], p['added']])).toEqual([['👍', true], ['👍', false]]);
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/hello/);
  });

  it('a refused request emits nothing', async () => {
    const n = (await stored()).length;
    const dev = await w.channelId('engineering', 'dev');
    expect((await w.call(rafi, 'POST', '/api/teams/engineering/channels', { name: 'nope' })).status).toBe(403);
    expect((await w.call(personas.sameera, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'x', threadRootId: null })).status).toBe(403);
    expect((await w.call(rafi, 'PATCH', `/api/channels/${dev}/messages/${msg}`, { body: 'x' })).status).toBe(403);
    expect((await w.call(omar, 'POST', `/api/channels/${dev}/join`)).status).toBe(200);   // an admin may join a public channel
    expect((await stored()).length).toBe(n + 1);
  });
});
