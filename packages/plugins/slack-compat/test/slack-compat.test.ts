import { ListMessagesResponse, MintPairingTokenResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';
import { ChatPostMessageResponse } from '../src/routes.ts';

// SPIKE (P5-01): the delivery loop — a public chat.postMessage with a pairing token enqueues, the SYSTEM job lands
// the bot's reply in the channel thread, readable back through the normal API. Queues run in the test server
// (NOTIFY wakes the worker), so every assertion polls.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: World;
let bot: { botId: string; actorId: string };
let token: string;
let channelId: string;
let rootId: string;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out waiting for the spike delivery');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  channelId = await w.channelId('engineering', 'dev');
  bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, (SELECT id FROM app.teams WHERE slug = 'engineering'), 'spikebot', 'agent', 'rules', 'team', repeat('b', 64), 'active')
       RETURNING id`,
      [omar.workspaceId],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(
      `INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`,
      [omar.workspaceId, botId],
    );
    return { botId, actorId: actor.rows[0]!.id };
  });
  const minted = await w.call(omar, 'POST', '/api/teams/engineering/bots/spikebot/pairing-tokens', {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  token = MintPairingTokenResponse.parse(minted.body).token;
  const root = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, {
    channelId,
    body: 'What did the deploy change?',
    threadRootId: null,
  });
  expect(root.status, JSON.stringify(root.body)).toBe(201);
  rootId = (root.body as { id: string }).id;
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const post = (body: unknown): Promise<{ status: number; body: unknown }> => w.call(null, 'POST', '/api/slack-compat/chat.postMessage', body);

describe('slack-compat spike', () => {
  it('a signed-equivalent token delivers the bot reply into the thread', async () => {
    const res = await post({ token, channel: channelId, thread_ts: rootId, text: '[spike P5-01] the deploy changed the loader' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const accepted = ChatPostMessageResponse.parse(res.body);
    expect(accepted.channel).toBe(channelId);

    const reply = await waitFor(async () => {
      const list = await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
      if (list.status !== 200) return undefined;
      return ListMessagesResponse.parse(list.body).items.find((m) => m.threadRootId === rootId && m.authorId === bot.actorId);
    });
    expect(reply.body).toBe('[spike P5-01] the deploy changed the loader');

    const stored = await w.system(async (tx) =>
      (
        await tx.query<{ body_plain: string; meta: unknown }>('SELECT body_plain, meta FROM app.messages WHERE id = $1', [reply.id])
      ).rows[0],
    );
    expect(stored?.meta).toMatchObject({ via: 'slack-compat/spike', deliveryId: accepted.ts });
    const events = await w.system(async (tx) =>
      (
        await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM app.events WHERE type = 'channel.message.posted' AND payload->>'messageId' = $1",
          [reply.id],
        )
      ).rows[0]!.n,
    );
    expect(events).toBe(1);
  });

  it('a forged or revoked token is 401 and lands nothing', async () => {
    expect((await post({ token: 'forged', channel: channelId, text: 'nope' })).status).toBe(401);
    const before = await w.system(async (tx) =>
      (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.messages')).rows[0]!.n,
    );
    await w.call(omar, 'DELETE', '/api/teams/engineering/bots/spikebot/pairing-tokens', {});
    expect((await post({ token, channel: channelId, text: 'nope' })).status).toBe(401);
    const after = await w.system(async (tx) =>
      (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.messages')).rows[0]!.n,
    );
    expect(after).toBe(before);
  });

  it('a disabled bot\'s token is 401 and lands nothing; active again, it delivers', async () => {
    const minted = await w.call(omar, 'POST', '/api/teams/engineering/bots/spikebot/pairing-tokens', {});
    const fresh = MintPairingTokenResponse.parse(minted.body).token;
    const count = () => w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.messages')).rows[0]!.n);
    const setStatus = (status: string) => w.system((tx) => tx.query('UPDATE app.bots SET status = $2 WHERE id = $1', [bot.botId, status]));
    const before = await count();
    await setStatus('disabled');
    try {
      expect((await post({ token: fresh, channel: channelId, text: 'nope' })).status).toBe(401);
    } finally {
      await setStatus('active');
    }
    expect(await count()).toBe(before);
    expect((await post({ token: fresh, channel: channelId, text: 'back again' })).status).toBe(200);
  });
});
