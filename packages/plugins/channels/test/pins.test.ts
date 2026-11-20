import { ChannelMessage, GetThreadResponse, ListMessagesResponse, ListPinsResponse, MAX_CHANNEL_PINS } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

// P31-07: pin and unpin a message, the channel's pinned list. Whoever can post pins and unpins; whoever can read sees the pins; one event per real change.

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
const post = async (who: Persona, channelId: string, body: string, threadRootId: string | null = null): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId }), 201).id;
const pin = (who: Persona, ch: string, id: string) => w.call(who, 'PUT', `/api/channels/${ch}/messages/${id}/pin`);
const unpin = (who: Persona, ch: string, id: string) => w.call(who, 'DELETE', `/api/channels/${ch}/messages/${id}/pin`);
const pins = async (who: Persona, ch: string): Promise<ChannelMessage[]> => ListPinsResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${ch}/pins`))).items;
const privateChannel = async (name: string): Promise<string> =>
  ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name, private: true }), 201).channel.id;
const events = (messageId: string) =>
  w.system(async (tx) =>
    (await tx.query<{ payload: Record<string, unknown>; actor_id: string }>("SELECT payload, actor_id FROM app.events WHERE type = 'channel.message.pin_changed' AND payload->>'messageId' = $1 ORDER BY id", [messageId])).rows,
  );

describe('pinning a message', () => {
  it('a member pins and unpins; the list, the feed and the message say so; a repeat changes nothing', async () => {
    const id = await post(nadia, dev, 'The release checklist lives here');
    expect(ok<{ pinned: boolean; changed: boolean }>(await pin(rafi, dev, id))).toEqual({ pinned: true, changed: true });
    expect(ok<{ pinned: boolean; changed: boolean }>(await pin(nadia, dev, id))).toEqual({ pinned: true, changed: false });

    const listed = await pins(nadia, dev);
    expect(listed[0]).toMatchObject({ id, body: 'The release checklist lives here', pinned: { by: rafi.actorId } });
    const feed = ListMessagesResponse.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages`))).items;
    expect(feed.find((m) => m.id === id)?.pinned?.by).toBe(rafi.actorId);
    expect(ChannelMessage.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages/${id}`))).pinned?.by).toBe(rafi.actorId);

    expect(ok<{ pinned: boolean; changed: boolean }>(await unpin(nadia, dev, id))).toEqual({ pinned: false, changed: true });
    expect(ok<{ pinned: boolean; changed: boolean }>(await unpin(nadia, dev, id))).toEqual({ pinned: false, changed: false });
    expect((await pins(nadia, dev)).map((m) => m.id)).not.toContain(id);
    expect(ChannelMessage.parse(ok(await w.call(nadia, 'GET', `/api/channels/${dev}/messages/${id}`))).pinned).toBeUndefined();

    // one event per real change, as the actor, with ids and the state only
    const rows = await events(id);
    expect(rows.map((r) => [r.payload['pinned'], r.actor_id])).toEqual([[true, rafi.actorId], [false, nadia.actorId]]);
    expect(rows[0]!.payload).toMatchObject({ channelId: dev, messageId: id, threadRootId: null, actorId: rafi.actorId });
    expect(JSON.stringify(rows)).not.toMatch(/checklist/);
  });

  it('the newest pin comes first, a thread reply can be pinned and shows pinned in its thread', async () => {
    const root = await post(nadia, dev, 'pin order root');
    const reply = await post(rafi, dev, 'pin order reply', root);
    ok(await pin(nadia, dev, root));
    ok(await pin(nadia, dev, reply));
    const ids: string[] = (await pins(rafi, dev)).map((m) => m.id);
    expect(ids.indexOf(reply)).toBeLessThan(ids.indexOf(root));
    expect((await pins(rafi, dev)).find((m) => m.id === reply)?.threadRootId).toBe(root);
    const thread = GetThreadResponse.parse(ok(await w.call(rafi, 'GET', `/api/threads/${root}`)));
    expect(thread.root.pinned?.by).toBe(nadia.actorId);
    expect(thread.replies.items.find((m) => m.id === reply)?.pinned?.by).toBe(nadia.actorId);
  });

  it('a deleted message leaves the list and cannot be pinned again', async () => {
    const id = await post(nadia, dev, 'soon gone');
    ok(await pin(nadia, dev, id));
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    expect((await pins(nadia, dev)).map((m) => m.id)).not.toContain(id);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_pins WHERE message_id = $1', [id])).rows.length)).toBe(0);
    expect((await pin(nadia, dev, id)).status).toBe(409);
  });

  it('an unknown message is 404, and a message of another channel is not found through this one', async () => {
    expect((await pin(nadia, dev, '00000000-0000-7000-8000-000000000099')).status).toBe(404);
    const elsewhere = await post(nadia, releases, 'in releases');
    expect((await pin(nadia, dev, elsewhere)).status).toBe(404);
  });
});

describe('who may pin', () => {
  it('a private channel: a non-member reads no pins and cannot pin (403); the table shows them nothing', async () => {
    const ch = await privateChannel('pins-private');
    const id = await post(omar, ch, 'leads only');
    ok(await pin(omar, ch, id));
    expect((await w.call(nadia, 'GET', `/api/channels/${ch}/pins`)).status).toBe(403);
    expect((await pin(nadia, ch, id)).status).toBe(403);
    expect((await unpin(nadia, ch, id)).status).toBe(403);
    expect((await w.call(null, 'GET', `/api/channels/${ch}/pins`)).status).toBe(401);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.message_pins WHERE message_id = $1', [id])).rows.length)).toBe(1);
  });

  it('someone outside the team cannot read or pin; a guest with a read grant reads the pins but cannot pin', async () => {
    const id = await post(nadia, releases, 'the release notes');
    ok(await pin(nadia, releases, id));
    expect((await w.call(sameera, 'GET', `/api/channels/${releases}/pins`)).status).toBe(403);
    expect((await pin(sameera, releases, id)).status).toBe(403);
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
         VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`,
        [lena.workspaceId, releases, lena.personId],
      ),
    );
    expect((await pins(lena, releases)).map((m) => m.id)).toContain(id);
    expect((await unpin(lena, releases, id)).status).toBe(403);
    expect((await pins(nadia, releases)).map((m) => m.id)).toContain(id);
  });

  it('an archived channel keeps its pins and refuses changes', async () => {
    const ch = await privateChannel('pins-archived');
    const id = await post(omar, ch, 'kept');
    ok(await pin(omar, ch, id));
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/archive`));
    expect((await unpin(omar, ch, id)).status).toBe(409);
    expect((await pins(omar, ch)).map((m) => m.id)).toEqual([id]);
  });

  it('two pins at once at 99 leave 100: the second one counts after the first (the channel lock)', async () => {
    const ch = await privateChannel('pins-race');
    const ids = await w.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain)
           SELECT $1, $2, $3, 'r' || g, 'r' || g FROM generate_series(1, $4::int) g RETURNING id`,
          [omar.workspaceId, ch, omar.actorId, MAX_CHANNEL_PINS + 1],
        )
      ).rows.map((r) => r.id),
    );
    await w.system((tx) =>
      tx.query('INSERT INTO app.message_pins (message_id, workspace_id, channel_id, pinned_by) SELECT unnest($1::uuid[]), $2, $3, $4', [ids.slice(0, MAX_CHANNEL_PINS - 1), omar.workspaceId, ch, omar.actorId]),
    );
    const [a, b] = await Promise.all([pin(omar, ch, ids[MAX_CHANNEL_PINS - 1]!), pin(omar, ch, ids[MAX_CHANNEL_PINS]!)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.message_pins WHERE channel_id = $1', [ch])).rows[0]!.n)).toBe(MAX_CHANNEL_PINS);
  });

  it('a pin waits for the channel lock, so two pins never count side by side', async () => {
    const ch = await privateChannel('pins-lock');
    const id = await post(omar, ch, 'waits for the lock');
    let answered = false;
    let request: Promise<ApiResult> | undefined;
    await w.system(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`channels:pins:${ch}`]);
      request = pin(omar, ch, id).then((r) => ((answered = true), r));
      await new Promise((r) => setTimeout(r, 600));
      expect(answered, 'the pin went through while another transaction held the channel lock').toBe(false);
    });
    expect((await request!).status).toBe(200);
  });

  it(`a channel keeps at most ${MAX_CHANNEL_PINS} pins`, async () => {
    const ch = await privateChannel('pins-cap');
    const ids = await w.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain)
           SELECT $1, $2, $3, 'm' || g, 'm' || g FROM generate_series(1, $4::int) g RETURNING id`,
          [omar.workspaceId, ch, omar.actorId, MAX_CHANNEL_PINS + 1],
        )
      ).rows.map((r) => r.id),
    );
    await w.system((tx) =>
      tx.query('INSERT INTO app.message_pins (message_id, workspace_id, channel_id, pinned_by) SELECT unnest($1::uuid[]), $2, $3, $4', [ids.slice(0, MAX_CHANNEL_PINS), omar.workspaceId, ch, omar.actorId]),
    );
    const res = await pin(omar, ch, ids[MAX_CHANNEL_PINS]!);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/at most 100 pinned/);
    expect(await pins(omar, ch)).toHaveLength(MAX_CHANNEL_PINS);
  });
});
