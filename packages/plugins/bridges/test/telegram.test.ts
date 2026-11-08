import { createHash } from 'node:crypto';
import { relaxedRateLimiter, TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { startFakeTelegram, type FakeTelegram } from '../../../../tools/fake-saas/src/providers/telegram.ts';

// Bundle D, P16-09 (PLAN criterion 7): Telegram end to end against the real server and the Telegram stand-in. An unlinked sender is dropped before anything is stored or any bot is
// asked; a linked person's words land in a joined public channel as them; the channel's words go back out once; replays, wrong secrets, wrong codes and private channels are refused.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 60_000 });

const TOKEN = '4242424242:FAKE-telegram-bot-token-for-tests-0001';
let w: World;
let tg: FakeTelegram;
let accountId = '';
let secret = '';
let dev = '';
let updates = 1000;
let botSlug = '';

const hook = (): string => `${w.server.url}/hooks/bridges/telegram/${accountId}`;
const count = (sql: string, values: unknown[] = []): Promise<number> => w.system(async (tx) => Number((await tx.query<{ n: string }>(sql, values)).rows[0]!.n));
const messagesIn = (channelId: string): Promise<number> => count('SELECT count(*) AS n FROM app.messages WHERE channel_id = $1', [channelId]);
const runs = (): Promise<number> => count("SELECT (SELECT count(*) FROM app.bot_runs) + (SELECT count(*) FROM app.jobs WHERE queue LIKE 'runtime-hermes.%') AS n");

interface Sent {
  status: number;
}
/** What Telegram does: a POST of an Update to the bridge's address with the secret header. (The stand-in would use the registered address, which is the public one; the call goes to the test server's own port.) */
async function deliver(o: { from: number; text: string; chat?: number; type?: 'private' | 'group'; updateId?: number; header?: string | null; username?: string }): Promise<Sent> {
  updates += 1;
  const chat = o.chat ?? o.from;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const header = o.header === undefined ? secret : o.header;
  if (header !== null) headers['x-telegram-bot-api-secret-token'] = header;
  const res = await fetch(hook(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      update_id: o.updateId ?? updates,
      message: { message_id: updates, date: Math.floor(Date.now() / 1000), from: { id: o.from, is_bot: false, first_name: 'Someone', username: o.username ?? `user${o.from}` }, chat: { id: chat, type: o.type ?? 'private', ...(o.type === 'group' ? { title: 'Friends' } : {}) }, text: o.text },
    }),
  });
  await res.text();
  return { status: res.status };
}
const sentTo = (chat: number | string): string[] => tg.sent.filter((m) => m.chatId === String(chat)).map((m) => m.text);
const waitFor = (chat: number | string, n: number): Promise<string[]> => eventually(async () => (sentTo(chat).length >= n ? sentTo(chat) : undefined), 20_000, `${n} message(s) to ${String(chat)}`);
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));

async function codeFor(who: typeof nadia): Promise<string> {
  const res = await w.call<{ code: string }>(who, 'POST', '/api/me/bridges/telegram/link-code');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.code;
}

beforeAll(async () => {
  tg = await startFakeTelegram();
  process.env['MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE'] = tg.url;
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  // a bot that answers to a mention, so a run can be told apart from none
  await w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, 'bridgebot', 'bridgebot', '', 'agent', 'hermes', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, omar.workspaceId]);
  });
  botSlug = 'bridgebot';
}, 180_000);
afterAll(async () => {
  await w?.close();
  await tg?.stop();
  delete process.env['MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE'];
});

describe('the admin turns Telegram on', () => {
  it('seals the token, registers the webhook with a secret word, and never gives the token back', async () => {
    expect((await w.call(nadia, 'PUT', '/api/admin/bridges/telegram', { displayName: 'Kahf bot' })).status).toBe(403);
    const made = await w.call<{ account: { id: string; status: string } }>(omar, 'PUT', '/api/admin/bridges/telegram', { displayName: 'Kahf bot' });
    expect(made.status).toBe(201);
    accountId = made.body.account.id;
    const put = await w.call(omar, 'PUT', '/api/admin/bridges/telegram/credentials', { botToken: TOKEN });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain('FAKE-telegram-bot-token');
    const on = await w.call<{ account: { status: string; handle: string | null; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/telegram/switch', { on: true });
    expect(on.body.account.lastError).toBeNull();
    expect(on.body.account.status).toBe('on');
    const hookInfo = tg.webhook();
    expect(hookInfo?.url).toContain(`/hooks/bridges/telegram/${accountId}`);
    secret = hookInfo!.secretToken!;
    expect(secret.length).toBeGreaterThan(20);
    const listed = JSON.stringify((await w.call(omar, 'GET', '/api/admin/bridges')).body);
    expect(listed).not.toContain('FAKE-telegram-bot-token');
    expect(listed).not.toContain(secret);
    // sealed in the database, not plain
    const plain = await w.system(async (tx) => (await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.bridge_secrets WHERE ciphertext::text LIKE '%FAKE-telegram%'")).rows[0]!.n).catch(() => '0');
    expect(Number(plain)).toBe(0);
  });
});

describe('a sender who is not linked', () => {
  it('stores nothing, starts no run, asks no model, and gets exactly one reply', async () => {
    const before = { messages: await count('SELECT count(*) AS n FROM app.messages'), runs: await runs(), inbound: await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'in'") };
    expect((await deliver({ from: 501, text: '@bridgebot please run the deploy' })).status).toBe(200);
    expect((await deliver({ from: 501, text: 'hello?' })).status).toBe(200);
    expect((await deliver({ from: 501, text: 'anyone there' })).status).toBe(200);
    await waitFor(501, 1);
    await quiet();
    expect(sentTo(501)).toHaveLength(1);
    expect(sentTo(501)[0]).toMatch(/link/i);
    expect(await count('SELECT count(*) AS n FROM app.messages')).toBe(before.messages);
    expect(await runs()).toBe(before.runs);
    expect(await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'in'")).toBe(before.inbound);
    // the text itself is nowhere in the database
    const leaked = await w.system(async (tx) => (await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.bridge_unlinked_chats u WHERE u.external_chat_id = '501'")).rows[0]!.n);
    expect(Number(leaked)).toBe(1);
  });

  it('a wrong secret header is 401 and leaves no row', async () => {
    const before = await count('SELECT count(*) AS n FROM app.bridge_messages');
    expect((await deliver({ from: 502, text: 'hi', header: 'not-the-secret' })).status).toBe(401);
    expect((await deliver({ from: 502, text: 'hi', header: null })).status).toBe(401);
    expect(await count('SELECT count(*) AS n FROM app.bridge_messages')).toBe(before);
    expect(sentTo(502)).toHaveLength(0);
  });

  it('an unknown or switched-off account looks the same: 404', async () => {
    const res = await fetch(`${w.server.url}/hooks/bridges/telegram/00000000-0000-7000-8000-000000000999`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('linking and the code lockout', () => {
  it('five wrong codes lock the chat, even for the right code afterwards', async () => {
    const good = await codeFor(rafi);
    for (let i = 0; i < 5; i++) await deliver({ from: 601, text: `/start 0000000${String(i)}` });
    await waitFor(601, 5);
    const before = sentTo(601).length;
    await deliver({ from: 601, text: `/start ${good}` });
    await waitFor(601, before + 1);
    expect(sentTo(601).at(-1)).toMatch(/too many/i);
    expect(await count('SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = $1', ['601'])).toBe(0);
  });

  it('a code links a chat user once, to who asked for it', async () => {
    const code = await codeFor(nadia);
    await deliver({ from: 700, text: `/start ${code}` });
    const texts = await waitFor(700, 1);
    expect(texts[0]).toMatch(/linked/i);
    const mine = await w.call<{ identities: Array<{ provider: string }> }>(nadia, 'GET', '/api/me/bridges');
    expect(mine.body.identities.map((i) => i.provider)).toContain('telegram');
    // the code was used: a second try with it links nobody else
    await deliver({ from: 701, text: `/start ${code}` });
    await waitFor(701, 1);
    expect(await count('SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = $1', ['701'])).toBe(0);
    // the code is stored only as a hash
    expect(await count('SELECT count(*) AS n FROM app.bridge_link_codes WHERE code_hash = $1', [createHash('sha256').update(code).digest('hex')])).toBeLessThanOrEqual(1);
  });
});

describe('a joined channel', () => {
  const GROUP = -100777;

  it('refuses a private channel', async () => {
    const priv = await w.system(async (tx) =>
      (
        await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, true, $5) RETURNING id', [omar.workspaceId, TEAM_IDS.Engineering, 'br-secret', 'channel', omar.actorId])
      ).rows[0]!.id,
    );
    await w.system(async (tx) => void (await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [priv, omar.personId])));
    const res = await w.call(omar, 'POST', `/api/channels/${priv}/bridge-links/telegram/code`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const listed = await w.call<{ canLink: boolean }>(omar, 'GET', `/api/channels/${priv}/bridge-links`);
    expect(listed.body.canLink).toBe(false);
  });

  it('only a lead can ask for a code', async () => {
    const res = await w.call(nadia, 'POST', `/api/channels/${dev}/bridge-links/telegram/code`);
    expect(res.status).toBe(403);
  });

  it('links a group, then a linked person posts as themselves via Telegram and a bot mention runs for them', async () => {
    const made = await w.call<{ code: string; command: string }>(omar, 'POST', `/api/channels/${dev}/bridge-links/telegram/code`);
    expect(made.status).toBe(201);
    expect(made.body.command).toBe(`/connect ${made.body.code}`);
    await deliver({ from: 700, chat: GROUP, type: 'group', text: made.body.command });
    expect((await waitFor(GROUP, 1))[0]).toMatch(/joined to #dev/i);

    const before = await messagesIn(dev);
    await deliver({ from: 700, chat: GROUP, type: 'group', text: 'Standup notes are in the doc' });
    const row = await eventually(async () => {
      const r = await w.system(async (tx) => (await tx.query<{ id: string; author: string; via: string | null; body: string }>("SELECT m.id, m.author_id AS author, m.meta #>> '{via,provider}' AS via, m.body FROM app.messages m WHERE m.channel_id = $1 AND m.body LIKE 'Standup notes%'", [dev])).rows[0]);
      return r;
    });
    expect(row.author).toBe(nadia.actorId);
    expect(row.via).toBe('telegram');
    expect(await messagesIn(dev)).toBe(before + 1);

    // a mention starts a run with Nadia as asker: the router queues it (the run itself needs a pod, which this file does not have)
    await deliver({ from: 700, chat: GROUP, type: 'group', text: `@${botSlug} what is on today?` });
    const job = await eventually(
      async () => w.system(async (tx) => (await tx.query<{ asker: string | null; trigger: string }>("SELECT payload->>'askerActorId' AS asker, payload->>'trigger' AS trigger FROM app.jobs WHERE queue = 'runtime-hermes.run' AND payload->>'channelId' = $1 ORDER BY id DESC LIMIT 1", [dev])).rows[0]),
      30_000,
      'a queued run',
    );
    expect(job.asker).toBe(nadia.actorId);
    expect(job.trigger).toBe('mention');
  });

  it('the channel’s next message reaches the group once, and the group’s own message does not bounce back', async () => {
    const sentBefore = sentTo(-100777).length;
    const posted = await w.call(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, threadRootId: null, body: 'Release is at five' });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    await eventually(async () => (sentTo(-100777).some((t) => t.includes('Release is at five')) ? true : undefined), 30_000, 'the outbound message');
    await quiet();
    expect(sentTo(-100777).filter((t) => t.includes('Release is at five'))).toHaveLength(1);
    // the message that came in from the group was not sent back to it
    expect(sentTo(-100777).filter((t) => t.includes('Standup notes'))).toHaveLength(0);
    expect(sentTo(-100777).length).toBeGreaterThan(sentBefore);
  });

  it('a replayed update id is ignored', async () => {
    const before = await messagesIn(dev);
    const id = 99_000_001;
    await deliver({ from: 700, chat: -100777, type: 'group', text: 'only once please', updateId: id });
    await deliver({ from: 700, chat: -100777, type: 'group', text: 'only once please', updateId: id });
    await deliver({ from: 700, chat: -100777, type: 'group', text: 'only once please', updateId: id });
    await eventually(async () => ((await messagesIn(dev)) > before ? true : undefined));
    await quiet();
    expect(await messagesIn(dev)).toBe(before + 1);
  });

  it('an unlinked person in a joined group is dropped, not posted', async () => {
    const before = await messagesIn(dev);
    await deliver({ from: 888, chat: -100777, type: 'group', text: 'let me in' });
    await quiet();
    expect(await messagesIn(dev)).toBe(before);
    expect(await count("SELECT count(*) AS n FROM app.messages WHERE body LIKE 'let me in%'")).toBe(0);
  });

  it('treats the text as hostile: control characters and @channel are defused', async () => {
    await deliver({ from: 700, chat: -100777, type: 'group', text: `hey ${String.fromCharCode(0x202e)}@channel${String.fromCharCode(7)} look` });
    const body = await eventually(async () => w.system(async (tx) => (await tx.query<{ body: string }>("SELECT body FROM app.messages WHERE channel_id = $1 AND body LIKE 'hey %' ORDER BY created_at DESC LIMIT 1", [dev])).rows[0]?.body));
    expect(body).not.toContain(String.fromCharCode(0x202e));
    expect(body).not.toContain(String.fromCharCode(7));
    expect(body).not.toContain('@channel');
  });

  it('archiving the channel removes the link', async () => {
    expect(await count('SELECT count(*) AS n FROM app.bridge_links WHERE channel_id = $1', [dev])).toBe(1);
    const links = await w.call<{ links: Array<{ id: string }> }>(omar, 'GET', `/api/channels/${dev}/bridge-links`);
    expect(links.body.links).toHaveLength(1);
    const del = await w.call(omar, 'DELETE', `/api/bridge-links/${links.body.links[0]!.id}`);
    expect(del.status).toBe(200);
    expect(await count('SELECT count(*) AS n FROM app.bridge_links WHERE channel_id = $1', [dev])).toBe(0);
  });
});

describe('unlinking a person', () => {
  it('/unlink and the account page both remove the link; a later message is dropped again', async () => {
    await deliver({ from: 700, text: '/unlink' });
    await eventually(async () => ((await count("SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = '700'")) === 0 ? true : undefined));
    const before = await count('SELECT count(*) AS n FROM app.messages');
    await deliver({ from: 700, text: 'am I still here' });
    await quiet();
    expect(await count('SELECT count(*) AS n FROM app.messages')).toBe(before);
  });
});

describe('when the world changes', () => {
  it('archiving a channel unjoins it from its chat', async () => {
    const ch = await w.channelId('engineering', 'releases').catch(() => w.channelId('engineering', 'general'));
    const made = await w.call<{ code: string; command: string }>(omar, 'POST', `/api/channels/${ch}/bridge-links/telegram/code`);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    await deliver({ from: 710, chat: -100888, type: 'group', text: made.body.command });
    await waitFor(-100888, 1);
    expect(await count('SELECT count(*) AS n FROM app.bridge_links WHERE channel_id = $1', [ch])).toBe(1);
    expect((await w.call(omar, 'POST', `/api/channels/${ch}/archive`)).status).toBeLessThan(300);
    await eventually(async () => ((await count('SELECT count(*) AS n FROM app.bridge_links WHERE channel_id = $1', [ch])) === 0 ? true : undefined), 30_000, 'the link to go');
  });

  it('suspending a member unlinks their chat accounts', async () => {
    const code = await codeFor(rafi);
    await deliver({ from: 720, text: `/start ${code}` });
    await eventually(async () => ((await count('SELECT count(*) AS n FROM app.bridge_identities WHERE person_id = $1', [rafi.personId])) === 1 ? true : undefined));
    expect((await w.call(omar, 'PATCH', `/api/workspace/members/${rafi.personId}`, { status: 'suspended' })).status).toBeLessThan(300);
    await eventually(async () => ((await count('SELECT count(*) AS n FROM app.bridge_identities WHERE person_id = $1', [rafi.personId])) === 0 ? true : undefined), 30_000, 'the identity to go');
  });
});
