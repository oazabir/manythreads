import { randomUUID } from 'node:crypto';
import { ReactorsResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

// P21-02: who reacted with one emoji — the whole count and the first twenty people, oldest first.

const { omar, nadia, rafi, sameera, lena } = personas;

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok<{ id: string }>(await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const react = (who: Persona, channelId: string, id: string, emoji: string) =>
  w.call(who, 'POST', `/api/channels/${channelId}/messages/${id}/reactions`, { emoji });
const reactors = (who: Persona | null, channelId: string, id: string, emoji: string) =>
  w.call(who, 'GET', `/api/channels/${channelId}/messages/${id}/reactions/${encodeURIComponent(emoji)}`);

describe('who reacted (reactorsRoute)', () => {
  it('lists the people who used the emoji, oldest first, with the whole count', async () => {
    const id = await post(nadia, dev, 'react to me');
    ok(await react(rafi, dev, id, '👍'));
    ok(await react(nadia, dev, id, '👍'));
    ok(await react(omar, dev, id, '👍'));
    ok(await react(omar, dev, id, '🎉'));
    const res = ReactorsResponse.parse(ok(await reactors(nadia, dev, id, '👍')));
    expect(res.count).toBe(3);
    expect(res.reactors.map((r) => r.actorId)).toEqual([rafi.actorId, nadia.actorId, omar.actorId]);
    const other = ReactorsResponse.parse(ok(await reactors(nadia, dev, id, '🎉')));
    expect(other).toEqual({ reactors: [{ actorId: omar.actorId }], count: 1 });
  });

  it('answers an emoji nobody used with an empty list and a zero count', async () => {
    const id = await post(nadia, dev, 'nobody reacted');
    expect(ReactorsResponse.parse(ok(await reactors(rafi, dev, id, '🔥')))).toEqual({ reactors: [], count: 0 });
  });

  it('returns at most twenty people but counts all of them, the earliest twenty first', async () => {
    const id = await post(nadia, dev, 'popular');
    const ids = Array.from({ length: 23 }, () => randomUUID());
    await w.system(async (tx) => {
      for (const [i, actor] of ids.entries()) {
        await tx.query(
          `INSERT INTO app.message_reactions (message_id, actor_id, emoji, created_at) VALUES ($1, $2, '👍', now() + ($3 || ' seconds')::interval)`,
          [id, actor, String(i)],
        );
      }
    });
    const res = ReactorsResponse.parse(ok(await reactors(nadia, dev, id, '👍')));
    expect(res.count).toBe(23);
    expect(res.reactors).toHaveLength(20);
    expect(res.reactors.map((r) => r.actorId)).toEqual(ids.slice(0, 20));
  });

  it('takes an emoji sent as a percent-encoded path segment, and a custom :name: too', async () => {
    const id = await post(nadia, dev, 'encoding');
    ok(await react(rafi, dev, id, '👍🏽'));
    ok(await react(rafi, dev, id, ':tada:'));
    expect(ReactorsResponse.parse(ok(await reactors(nadia, dev, id, '👍🏽'))).count).toBe(1);
    expect(ReactorsResponse.parse(ok(await reactors(nadia, dev, id, ':tada:'))).count).toBe(1);
    expect(ReactorsResponse.parse(ok(await reactors(nadia, dev, id, '👍'))).count).toBe(0);
  });

  it('404 for a message that does not exist, or that is in another channel', async () => {
    const id = await post(nadia, dev, 'here');
    expect((await reactors(nadia, dev, randomUUID(), '👍')).status).toBe(404);
    const releases = await w.channelId('engineering', 'releases');
    expect((await reactors(nadia, releases, id, '👍')).status).toBe(404);
  });

  it('refuses a person outside the team, a guest without a grant and a caller who is not signed in', async () => {
    const id = await post(nadia, dev, 'closed door');
    ok(await react(nadia, dev, id, '👍'));
    expect((await reactors(sameera, dev, id, '👍')).status).toBe(403);
    expect((await reactors(lena, dev, id, '👍')).status).toBe(403);
    expect((await reactors(null, dev, id, '👍')).status).toBe(401);
  });

  it('keeps a private channel private: a non-member gets 403 and learns nothing', async () => {
    const ch = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'reactors-private', private: true }), 201).channel.id;
    const id = await post(omar, ch, 'secret');
    ok(await react(omar, ch, id, '👍'));
    expect(ReactorsResponse.parse(ok(await reactors(omar, ch, id, '👍'))).count).toBe(1);
    const denied = await reactors(rafi, ch, id, '👍');
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toContain(omar.actorId);
  });
});
