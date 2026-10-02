import { ChannelMessage, GetThreadResponse, ListMessagesResponse } from '@manythreads/shared';
import { createAppPool, withActor } from '@manythreads/kernel';
import { personaActor, personas, type Persona } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, type ApiResult, type World } from './world.ts';

const { omar, nadia, rafi, sameera, lena } = personas;

let w: World;
let appPool: pg.Pool;
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  appPool = createAppPool(w.server.db.appUrl, 2);
}, 180_000);
afterAll(async () => {
  await appPool?.end();
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const post = (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<ApiResult> =>
  w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
const grantLena = (channelId: string): Promise<void> =>
  w.system(async (tx) => {
    await tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`,
      [lena.workspaceId, channelId, lena.personId],
    );
  });
const authorsAs = (who: Persona, ids: string[]): Promise<Array<{ actor_id: string; display_name: string; kind: string }>> =>
  withActor(personaActor(who), async (tx) => (await tx.query<{ actor_id: string; display_name: string; kind: string }>('SELECT * FROM app.message_authors($1::uuid[])', [ids])).rows, { pool: appPool });

describe('author names on messages (app.message_authors)', () => {
  it('lists and threads carry the author name, kind and actor id, also for a guest who has no roster', async () => {
    const releases = await w.channelId('engineering', 'releases');
    await grantLena(releases);
    const root = ok<{ id: string }>(await post(nadia, releases, 'Release 2.4 is out'), 201);
    ok(await post(omar, releases, 'Thanks for shipping it', root.id), 201);

    for (const reader of [rafi, lena]) {
      const list = ListMessagesResponse.parse(ok(await w.call(reader, 'GET', `/api/channels/${releases}/messages`)));
      const first = list.items.find((m) => m.id === root.id);
      expect(first?.author).toEqual({ actorId: nadia.actorId, displayName: nadia.name, kind: 'person' });
    }
    const thread = GetThreadResponse.parse(ok(await w.call(lena, 'GET', `/api/threads/${root.id}`)));
    expect(thread.root.author?.displayName).toBe(nadia.name);
    expect(thread.replies.items[0]?.author).toEqual({ actorId: omar.actorId, displayName: omar.name, kind: 'person' });

    const one = ChannelMessage.parse(ok(await w.call(lena, 'GET', `/api/channels/${releases}/messages/${root.id}`)));
    expect(one.author?.displayName).toBe(nadia.name);
  });

  it('answers names only for the authors of messages the caller can read', async () => {
    const dev = await w.channelId('engineering', 'dev');
    const releases = await w.channelId('engineering', 'releases');
    const secret = ok<{ id: string }>(await post(nadia, dev, 'engineering only'), 201);
    const open = ok<{ id: string }>(await post(rafi, releases, 'visible to the guest'), 201);

    // Lena reads #releases only: Rafi's name is hers to see, Nadia's message in #dev is not, so Nadia's name is not either
    const asLena = await authorsAs(lena, [secret.id, open.id]);
    expect(asLena.map((r) => r.display_name)).toEqual([rafi.name]);
    // Sameera is on another team: nothing of Engineering
    expect(await authorsAs(sameera, [secret.id, open.id])).toEqual([]);
    // an actor id, a made-up id and an empty list reveal nothing
    expect(await authorsAs(lena, [nadia.actorId, '00000000-0000-7000-8000-00000000dead'])).toEqual([]);
    expect(await authorsAs(lena, [])).toEqual([]);
    // a member of the channel gets the name
    expect((await authorsAs(rafi, [secret.id])).map((r) => r.display_name)).toEqual([nadia.name]);
  });

  it('a private channel and a direct message name their authors to their members only', async () => {
    const created = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'authors-private', private: true }), 201);
    const priv = created.channel.id;
    const m = ok<{ id: string }>(await post(omar, priv, 'leads only'), 201);
    expect((await authorsAs(omar, [m.id])).map((r) => r.display_name)).toEqual([omar.name]);
    expect(await authorsAs(nadia, [m.id])).toEqual([]);
    expect(await authorsAs(lena, [m.id])).toEqual([]);
  });
});
