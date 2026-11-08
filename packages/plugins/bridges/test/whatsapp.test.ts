import { withActor, type Actor } from '@manythreads/kernel';
import type { MessageProvider, PluginTx } from '@manythreads/sdk';
import { relaxedRateLimiter, TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { FAKE_WHATSAPP_APP_SECRET, FAKE_WHATSAPP_VERIFY_TOKEN, startFakeWhatsapp, type FakeWhatsapp } from '../../../../tools/fake-saas/src/providers/whatsapp.ts';

// Bundle D, P16-09: WhatsApp direct chats against the real server and the Cloud API stand-in. Meta only lets a business write to a person within 24 hours of the person's last message:
// inside the window the bot's answer goes out at once; outside it the answer waits and goes out when the person writes again.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 60_000 });

const NUMBER = '4915100001';
let w: World;
let wa: FakeWhatsapp;
let accountId = '';
let bot = { id: '', actor: '' };
let channelId = '';
let runId = '';
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));
const count = (sql: string, values: unknown[] = []): Promise<number> => w.system(async (tx) => Number((await tx.query<{ n: string }>(sql, values)).rows[0]!.n));
const sentTo = (to: string): string[] => wa.sent.filter((m) => m.to === to).map((m) => m.text);

/** The bot answers in the person's conversation, as a bot (with a run of its own, as the message door requires). */
async function botSays(body: string): Promise<void> {
  const provider = w.server.host.registries.providers.messages.values()[0] as MessageProvider;
  const actor = { kind: 'bot', id: bot.actor, workspaceId: omar.workspaceId, runId } as unknown as Actor;
  await withActor(actor, (tx) => provider.post(tx as unknown as PluginTx, { channelId, body }), { pool: w.server.pools.app });
}

beforeAll(async () => {
  wa = await startFakeWhatsapp();
  process.env['MANYTHREADS_BRIDGE_WHATSAPP_FAKE_BASE'] = wa.url;
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  await w.system(async (tx) => {
    const b = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, 'chatbot', 'Chatbot', '', 'agent', 'hermes', 'team', repeat('b', 64), 'active', '[{"type":"conversation"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering],
    );
    const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, b.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, a.rows[0]!.id, omar.workspaceId]);
    bot = { id: b.rows[0]!.id, actor: a.rows[0]!.id };
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
  await wa?.stop();
  delete process.env['MANYTHREADS_BRIDGE_WHATSAPP_FAKE_BASE'];
});

describe('WhatsApp', () => {
  it('is switched on with the number id, the app secret and the verify word, and answers Meta’s URL check', async () => {
    const number = wa.numbers[0]!;
    const made = await w.call<{ account: { id: string } }>(omar, 'PUT', '/api/admin/bridges/whatsapp', { displayName: 'Kahf WhatsApp', externalAppId: number.phoneNumberId });
    expect(made.status).toBe(201);
    accountId = made.body.account.id;
    const put = await w.call(omar, 'PUT', '/api/admin/bridges/whatsapp/credentials', { botToken: number.token, appSecret: FAKE_WHATSAPP_APP_SECRET, inboundSecret: FAKE_WHATSAPP_VERIFY_TOKEN });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(number.token);
    const on = await w.call<{ account: { status: string; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/whatsapp/switch', { on: true });
    expect(on.body.account.lastError).toBeNull();
    expect(on.body.account.status).toBe('on');
    wa.setCallback(`${w.server.url}/hooks/bridges/whatsapp/${accountId}`);
    const ok = await wa.whatsappVerify();
    expect(ok.status).toBe(200);
    const bad = await wa.whatsappVerify({ token: 'wrong-word' });
    expect(bad.status).not.toBe(200);
  });

  it('a wrong or missing signature is 401 and leaves nothing', async () => {
    const before = await count('SELECT count(*) AS n FROM app.bridge_messages');
    for (const signature of ['wrong', 'missing'] as const) {
      const res = await wa.whatsappSend({ fromNumber: '4915100777', text: 'hi', signature });
      expect(res.responses[0]?.status).toBe(401);
    }
    expect(await count('SELECT count(*) AS n FROM app.bridge_messages')).toBe(before);
  });

  it('an unlinked number gets one reply and nothing is stored or asked of a bot', async () => {
    const before = { messages: await count('SELECT count(*) AS n FROM app.messages'), jobs: await count("SELECT count(*) AS n FROM app.jobs WHERE queue LIKE 'runtime-hermes.%'") };
    await wa.whatsappSend({ fromNumber: '4915100002', text: 'hello bot' });
    await wa.whatsappSend({ fromNumber: '4915100002', text: 'hello again' });
    await eventually(async () => (sentTo('4915100002').length >= 1 ? true : undefined));
    await quiet();
    expect(sentTo('4915100002')).toHaveLength(1);
    expect(await count('SELECT count(*) AS n FROM app.messages')).toBe(before.messages);
    expect(await count("SELECT count(*) AS n FROM app.jobs WHERE queue LIKE 'runtime-hermes.%'")).toBe(before.jobs);
  });

  it('links a person with a code typed as the whole message', async () => {
    const res = await w.call<{ code: string }>(nadia, 'POST', '/api/me/bridges/whatsapp/link-code');
    expect(res.status).toBe(201);
    await wa.whatsappSend({ fromNumber: NUMBER, text: res.body.code });
    await eventually(async () => (sentTo(NUMBER).some((t) => /linked/i.test(t)) ? true : undefined));
    const mine = await w.call<{ identities: Array<{ provider: string }> }>(nadia, 'GET', '/api/me/bridges');
    expect(mine.body.identities.map((i) => i.provider)).toContain('whatsapp');
  });

  it('inside the 24 hour window the bot’s answer goes out at once, once', async () => {
    await wa.whatsappSend({ fromNumber: NUMBER, text: 'What is blocking the release?' });
    const post = await eventually(async () =>
      w.system(async (tx) => (await tx.query<{ channel_id: string; author_id: string; via: string | null }>("SELECT channel_id, author_id, meta #>> '{via,provider}' AS via FROM app.messages WHERE body = 'What is blocking the release?'")).rows[0]),
    );
    expect(post.author_id).toBe(nadia.actorId);
    expect(post.via).toBe('whatsapp');
    channelId = post.channel_id;
    runId = (
      await w.system(async (tx) =>
        (
          await tx.query<{ id: string }>(`INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status) VALUES ($1, $2, $3, 'conversation', $4, $5, 'running') RETURNING id`, [omar.workspaceId, bot.id, TEAM_IDS.Engineering, nadia.actorId, channelId])
        ).rows[0]!.id,
      )
    );
    // the person's own message is not sent back to them
    await botSays('The migration is waiting for review.');
    await eventually(async () => (sentTo(NUMBER).includes('The migration is waiting for review.') ? true : undefined), 30_000, 'the answer');
    await quiet();
    expect(sentTo(NUMBER).filter((t) => t === 'The migration is waiting for review.')).toHaveLength(1);
    expect(sentTo(NUMBER).some((t) => t.includes('What is blocking'))).toBe(false);
  });

  it('outside the window the answer waits, and goes out when the person writes again', async () => {
    await w.system(async (tx) => void (await tx.query("UPDATE app.bridge_dm_sessions SET last_inbound_at = now() - interval '25 hours' WHERE account_id = $1", [accountId])));
    wa.closeWindow(NUMBER);
    const sentBefore = wa.sent.length;
    await botSays('Here is the follow-up you asked for.');
    await eventually(async () => ((await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'out' AND status = 'waiting'")) === 1 ? true : undefined), 30_000, 'a waiting answer');
    await quiet();
    expect(wa.sent.length).toBe(sentBefore);
    // the person writes: the window is open again and the waiting answer goes out
    await wa.whatsappSend({ fromNumber: NUMBER, text: 'Are you there?' });
    await eventually(async () => (sentTo(NUMBER).includes('Here is the follow-up you asked for.') ? true : undefined), 30_000, 'the released answer');
    await quiet();
    expect(sentTo(NUMBER).filter((t) => t === 'Here is the follow-up you asked for.')).toHaveLength(1);
    expect(await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'out' AND status = 'waiting'")).toBe(0);
  });

  it('a replayed message id is read once', async () => {
    const before = await count("SELECT count(*) AS n FROM app.messages WHERE body = 'once only'");
    await wa.whatsappSend({ fromNumber: NUMBER, text: 'once only', messageId: 'wamid.REPLAY1', repeat: 3 });
    await eventually(async () => ((await count("SELECT count(*) AS n FROM app.messages WHERE body = 'once only'")) > before ? true : undefined));
    await quiet();
    expect(await count("SELECT count(*) AS n FROM app.messages WHERE body = 'once only'")).toBe(before + 1);
  });

  it('switching it off tells the admin’s page and stops reading calls', async () => {
    const off = await w.call<{ account: { status: string } }>(omar, 'POST', '/api/admin/bridges/whatsapp/switch', { on: false });
    expect(off.body.account.status).toBe('off');
    const res = await wa.whatsappSend({ fromNumber: NUMBER, text: 'anyone?' });
    expect(res.responses[0]?.status).toBe(404);
  });
});
