import { createHmac } from 'node:crypto';
import { relaxedRateLimiter, TEAM_IDS } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type World } from '../../channels/test/world.ts';
import { FAKE_SLACK_BOT_TOKEN, FAKE_SLACK_SIGNING_SECRET, startFakeSlack, type FakeSlack } from '../../../../tools/fake-saas/src/providers/slack.ts';
import type { BridgeAccountRef, BridgeRequest } from '../src/adapter.ts';
import { slackAdapter, slackEscape, slackPlain } from '../src/adapters/slack.ts';

// Bundle D, P16-09 (B2): the Slack bridge. First the adapter on its own (signature and replay window, the url check, reading events, hostile text), then end to end against the real server and the
// Slack stand-in with the same acceptance as Telegram: an unlinked person is dropped before anything is stored, a linked person's words land in a joined public channel as them, the channel's words
// go back out once and escaped, and forged, stale, replayed and looping calls leave nothing.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 60_000 });

// --- the adapter on its own ---------------------------------------------------------------------------------------------------------------------------------

const SECRET = 'unit-signing-secret-0001';
const ref = (over: Partial<BridgeAccountRef> = {}): BridgeAccountRef => ({ id: 'a', workspaceId: 'w', provider: 'slack', handle: null, externalAppId: 'A0APP', secrets: { signing_secret: SECRET, bot_token: 'xoxb-unit' }, ...over });
const NOW = 1_700_000_000_000;
const signed = (raw: string, o: { at?: number; secret?: string; drop?: 'sig' | 'stamp' } = {}): BridgeRequest => {
  const stamp = String(Math.floor((o.at ?? NOW) / 1000));
  const sig = `v0=${createHmac('sha256', o.secret ?? SECRET).update(`v0:${stamp}:${raw}`).digest('hex')}`;
  return { method: 'POST', headers: { ...(o.drop === 'stamp' ? {} : { 'x-slack-request-timestamp': stamp }), ...(o.drop === 'sig' ? {} : { 'x-slack-signature': sig }) }, query: {}, rawBody: Buffer.from(raw), now: NOW };
};
const event = (over: Record<string, unknown> = {}, outer: Record<string, unknown> = {}): unknown => ({
  type: 'event_callback',
  event_id: 'Ev1',
  api_app_id: 'A0APP',
  event: { type: 'message', user: 'U0NADIA', channel: 'D0DM', channel_type: 'im', text: 'hello', ts: '1700000000.200000', ...over },
  ...outer,
});

describe('the Slack adapter: signature and replay window', () => {
  const raw = '{"type":"event_callback"}';
  it('accepts the exact v0 signature over the raw body', () => {
    expect(slackAdapter.verify(ref(), signed(raw)).ok).toBe(true);
  });
  it('refuses a wrong secret, a changed body, a missing header and an empty secret', () => {
    expect(slackAdapter.verify(ref(), signed(raw, { secret: 'another-secret-0001' })).ok).toBe(false);
    expect(slackAdapter.verify(ref(), { ...signed(raw), rawBody: Buffer.from(`${raw} `) }).ok).toBe(false);
    expect(slackAdapter.verify(ref(), signed(raw, { drop: 'sig' })).ok).toBe(false);
    expect(slackAdapter.verify(ref(), signed(raw, { drop: 'stamp' })).ok).toBe(false);
    expect(slackAdapter.verify(ref({ secrets: {} }), signed(raw)).ok).toBe(false);
    expect(slackAdapter.verify(ref({ secrets: { signing_secret: '' } }), signed(raw, { secret: '' })).ok).toBe(false);
  });
  it('refuses a call more than five minutes old or ahead, even with a right signature, and keeps one just inside', () => {
    expect(slackAdapter.verify(ref(), signed(raw, { at: NOW - 301_000 })).ok).toBe(false);
    expect(slackAdapter.verify(ref(), signed(raw, { at: NOW + 301_000 })).ok).toBe(false);
    expect(slackAdapter.verify(ref(), signed(raw, { at: NOW - 299_000 })).ok).toBe(true);
    expect(slackAdapter.verify(ref(), signed(raw, { at: NOW + 299_000 })).ok).toBe(true);
  });
  it('refuses a timestamp that is not a plain number, even with a signature made over it', () => {
    for (const stamp of ['abc', '1e12', '-1700000000', '1700000000.5', '', ' 1700000000']) {
      const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${raw}`).digest('hex')}`;
      expect(slackAdapter.verify(ref(), { method: 'POST', headers: { 'x-slack-request-timestamp': stamp, 'x-slack-signature': sig }, query: {}, rawBody: Buffer.from(raw), now: NOW }).ok).toBe(false);
    }
  });
});

describe('the Slack adapter: the url check', () => {
  it('echoes a plain challenge, and only for url_verification', () => {
    expect(slackAdapter.handshake?.(ref(), { type: 'url_verification', challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' })).toBe('3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P');
    expect(slackAdapter.handshake?.(ref(), { type: 'event_callback', challenge: 'abc' })).toBeNull();
    expect(slackAdapter.handshake?.(ref(), { type: 'url_verification', challenge: '<script>alert(1)</script>' })).toBeNull();
    expect(slackAdapter.handshake?.(ref(), { type: 'url_verification', challenge: 'x'.repeat(201) })).toBeNull();
    expect(slackAdapter.handshake?.(ref(), { type: 'url_verification' })).toBeNull();
    for (const odd of [null, 4, 'x', [], {}]) expect(slackAdapter.handshake?.(ref(), odd)).toBeNull();
  });
});

describe('the Slack adapter: reading events', () => {
  it('reads a direct message and a channel message', () => {
    const [dm] = slackAdapter.parse(ref(), event());
    expect(dm).toMatchObject({ updateId: 'Ev1', externalId: '1700000000.200000', chat: { id: 'D0DM', kind: 'private', title: null }, sender: { id: 'U0NADIA' }, text: 'hello', command: null, at: 1_700_000_000_200 });
    const [ch] = slackAdapter.parse(ref(), event({ channel: 'C0ROOM', channel_type: 'channel' }));
    expect(ch?.chat).toEqual({ id: 'C0ROOM', kind: 'group', title: null });
    for (const channel_type of ['group', 'mpim']) expect(slackAdapter.parse(ref(), event({ channel: 'G0X', channel_type }))[0]?.chat.kind).toBe('group');
  });

  it('does not read a bot’s post (the bridge’s own come back this way), a subtype, or a call for another app', () => {
    expect(slackAdapter.parse(ref(), event({ bot_id: 'B0X' }))).toEqual([]);
    expect(slackAdapter.parse(ref(), event({ subtype: 'bot_message' }))).toEqual([]);
    for (const subtype of ['message_changed', 'message_deleted', 'channel_join', 'file_share', 'thread_broadcast']) expect(slackAdapter.parse(ref(), event({ subtype }))).toEqual([]);
    expect(slackAdapter.parse(ref(), event({}, { api_app_id: 'A0OTHER' }))).toEqual([]);
    expect(slackAdapter.parse(ref({ externalAppId: null }), event({}, { api_app_id: 'A0OTHER' }))).toHaveLength(1);
    expect(slackAdapter.parse(ref(), event({ type: 'app_mention' }))).toEqual([]);
    expect(slackAdapter.parse(ref(), { type: 'app_rate_limited' })).toEqual([]);
  });

  it('reads commands: plain words, with a bot mention first, and with a slash or a bang', () => {
    expect(slackAdapter.parse(ref(), event({ text: '12345678' }))[0]?.command).toBeNull();
    expect(slackAdapter.parse(ref(), event({ text: 'start 12345678' }))[0]?.command).toEqual({ name: 'start', argument: '12345678' });
    expect(slackAdapter.parse(ref(), event({ channel: 'C0ROOM', channel_type: 'channel', text: '<@U0BOT> connect 1234 5678' }))[0]?.command).toEqual({ name: 'connect', argument: '1234 5678' });
    expect(slackAdapter.parse(ref(), event({ text: '!bot Brain' }))[0]?.command).toEqual({ name: 'bot', argument: 'Brain' });
    expect(slackAdapter.parse(ref(), event({ text: 'unlink' }))[0]?.command).toEqual({ name: 'unlink', argument: '' });
    // ordinary talk is never a command
    for (const text of ['start the deploy', 'connect the printer', 'bot status', 'please unlink it', 'connect 12']) expect(slackAdapter.parse(ref(), event({ text }))[0]?.command).toBeNull();
    // and `unlink` or `bot` alone in a channel is just a word
    expect(slackAdapter.parse(ref(), event({ channel: 'C0ROOM', channel_type: 'channel', text: 'bot' }))[0]?.command).toBeNull();
  });

  it('turns Slack’s markup into plain words and never into an @name', () => {
    expect(slackPlain('Fish &amp; chips &lt;3 &gt; 2')).toBe('Fish & chips <3 > 2');
    expect(slackPlain('see <https://example.com/a?b=1&amp;c=2|the page> and <https://example.org> or <mailto:a@b.example|mail>')).toBe('see the page (https://example.com/a?b=1&c=2) and https://example.org or mail (mailto:a@b.example)');
    expect(slackPlain('hi <@U0X1> and <@U0X2|alice>')).toBe('hi (a Slack user) and (a Slack user)');
    expect(slackPlain('in <#C0X|general> and <#C0Y>')).toBe('in general and a Slack channel');
    expect(slackPlain('<!here> <!channel> <!everyone> <!subteam^S0X|@devs>')).toBe('here channel everyone devs');
    // a literal angle bracket arrives escaped, so it is text, not a tag
    expect(slackPlain('&lt;@U0X&gt;')).toBe('<@U0X>');
  });

  it('reads the sender as an id and a label that holds nothing from the message', () => {
    const [m] = slackAdapter.parse(ref(), event());
    expect(m?.sender).toEqual({ id: 'U0NADIA', label: 'Slack member U0NADIA' });
  });

  it('survives every odd shape without throwing', () => {
    for (const hostile of [null, 'x', 5, [], {}, { type: 'event_callback' }, { type: 'event_callback', event_id: 'E', event: 'x' }, event({ user: 5 }), event({ channel: 'lower' }), event({ text: null }), event({ user: 'a b' }), event({ channel: 'C'.repeat(500) })]) {
      expect(() => slackAdapter.parse(ref(), hostile)).not.toThrow();
      expect(slackAdapter.parse(ref(), hostile)).toEqual([]);
    }
  });

  it('is linear on hostile text: tens of thousands of brackets and entities', () => {
    for (const text of ['<'.repeat(60_000), '<@'.repeat(30_000), '&'.repeat(60_000), '&amp;'.repeat(12_000), `<${'a'.repeat(1990)}|${'<'.repeat(30_000)}`, '<a|'.repeat(20_000)]) {
      const t0 = Date.now();
      slackAdapter.parse(ref(), event({ text }));
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it('escapes what it sends: a name or message can never become a mention or a link', () => {
    expect(slackEscape('Omar: <!channel> see <https://evil.example|here> & <@U0X>')).toBe('Omar: &lt;!channel&gt; see &lt;https://evil.example|here&gt; &amp; &lt;@U0X&gt;');
  });
});

// --- end to end ---------------------------------------------------------------------------------------------------------------------------------------------

let w: World;
let slack: FakeSlack;
let accountId = '';
let dev = '';
const CHANNEL = 'C0JOINED1';
const hook = (): string => `${w.server.url}/hooks/bridges/slack/${accountId}`;
const count = (sql: string, values: unknown[] = []): Promise<number> => w.system(async (tx) => Number((await tx.query<{ n: string }>(sql, values)).rows[0]!.n));
const messagesIn = (channelId: string): Promise<number> => count('SELECT count(*) AS n FROM app.messages WHERE channel_id = $1', [channelId]);
const runs = (): Promise<number> => count("SELECT (SELECT count(*) FROM app.bot_runs) + (SELECT count(*) FROM app.jobs WHERE queue LIKE 'runtime-hermes.%') AS n");
const sentTo = (channel: string): string[] => slack.sent.filter((m) => m.channel === channel).map((m) => m.text);
const waitFor = (channel: string, n: number): Promise<string[]> => eventually(async () => (sentTo(channel).length >= n ? sentTo(channel) : undefined), 20_000, `${n} message(s) to ${channel}`);
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 1500));
const say = (o: { user: string; channel: string; text: string; eventId?: string; signature?: 'wrong' | 'missing' | 'stale' | 'future'; botId?: string; subtype?: string; repeat?: number }) =>
  slack.slackSend({ ...o, ...(o.channel.startsWith('D') ? { channelType: 'im' as const } : {}) });

async function codeFor(who: typeof nadia): Promise<string> {
  const res = await w.call<{ code: string }>(who, 'POST', '/api/me/bridges/slack/link-code');
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.code;
}

beforeAll(async () => {
  slack = await startFakeSlack({ strictChannels: true });
  process.env['MANYTHREADS_BRIDGE_SLACK_FAKE_BASE'] = slack.url;
  w = await createWorld({ limiter: relaxedRateLimiter() });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  await w.system(async (tx) => {
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, 'slackbot', 'slackbot', '', 'agent', 'hermes', 'team', repeat('c', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering],
    );
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, bot.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, actor.rows[0]!.id, omar.workspaceId]);
    // a bot to talk to in a direct chat
    const chat = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases)
       VALUES ($1, $2, 'chatbot', 'Chatbot', '', 'agent', 'hermes', 'team', repeat('d', 64), 'active', '[{"type":"conversation"}]'::jsonb, ARRAY['smart']) RETURNING id`,
      [omar.workspaceId, TEAM_IDS.Engineering],
    );
    const chatActor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, chat.rows[0]!.id]);
    await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')", [TEAM_IDS.Engineering, chatActor.rows[0]!.id, omar.workspaceId]);
  });
}, 180_000);
afterAll(async () => {
  await w?.close();
  await slack?.stop();
  delete process.env['MANYTHREADS_BRIDGE_SLACK_FAKE_BASE'];
});

describe('the admin turns Slack on', () => {
  it('takes the bot token and the signing secret, checks the token, and never gives either back', async () => {
    expect((await w.call(nadia, 'PUT', '/api/admin/bridges/slack', { displayName: 'Kahf Slack' })).status).toBe(403);
    const made = await w.call<{ account: { id: string } }>(omar, 'PUT', '/api/admin/bridges/slack', { displayName: 'Kahf Slack', externalAppId: slack.appId });
    expect(made.status).toBe(201);
    accountId = made.body.account.id;
    // a token that is not a Slack bot token, and a credential that does not belong to Slack, are refused
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/slack/credentials', { botToken: 'not-a-slack-token-at-all' })).status).toBe(400);
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/slack/credentials', { appSecret: 'whatsapp-style-secret' })).status).toBe(400);
    // switching on before both are in says what is missing
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/slack/credentials', { botToken: FAKE_SLACK_BOT_TOKEN })).status).toBe(200);
    const early = await w.call<{ account: { status: string; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/slack/switch', { on: true });
    expect(early.body.account.status).toBe('off');
    expect(early.body.account.lastError).toMatch(/signing secret/i);
    const put = await w.call(omar, 'PUT', '/api/admin/bridges/slack/credentials', { signingSecret: FAKE_SLACK_SIGNING_SECRET });
    expect(put.status).toBe(200);
    const on = await w.call<{ account: { status: string; handle: string | null; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/slack/switch', { on: true });
    expect(on.body.account.lastError).toBeNull();
    expect(on.body.account.status).toBe('on');
    expect(on.body.account.handle).toBe('@manythreads_fake_bot');
    expect(slack.calls.some((c) => c.method === 'auth.test' && c.authorized)).toBe(true);
    const listed = JSON.stringify((await w.call(omar, 'GET', '/api/admin/bridges')).body);
    expect(listed).not.toContain(FAKE_SLACK_BOT_TOKEN);
    expect(listed).not.toContain(FAKE_SLACK_SIGNING_SECRET);
    slack.setCallback(hook());
  });

  it('a token Slack refuses leaves it off with a plain sentence', async () => {
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/slack/credentials', { botToken: 'xoxb-a-token-slack-does-not-know' })).status).toBe(200);
    const bad = await w.call<{ account: { status: string; lastError: string | null } }>(omar, 'POST', '/api/admin/bridges/slack/switch', { on: true });
    expect(bad.body.account.status).toBe('off');
    expect(bad.body.account.lastError).toMatch(/token/i);
    expect(JSON.stringify(bad.body)).not.toContain('xoxb-a-token');
    expect((await w.call(omar, 'PUT', '/api/admin/bridges/slack/credentials', { botToken: FAKE_SLACK_BOT_TOKEN })).status).toBe(200);
    const on = await w.call<{ account: { status: string } }>(omar, 'POST', '/api/admin/bridges/slack/switch', { on: true });
    expect(on.body.account.status).toBe('on');
  });
});

describe('Slack’s own checks of the address', () => {
  it('answers the url check with the challenge, and only when it is signed and fresh', async () => {
    const ok = await slack.slackVerify({ challenge: 'chal-0123456789' });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe('chal-0123456789');
    for (const signature of ['wrong', 'missing', 'stale', 'future'] as const) {
      const bad = await slack.slackVerify({ signature });
      expect(bad.status, signature).toBe(401);
      expect(bad.body).not.toContain('chal');
    }
  });

  it('a forged, stale, early or unsigned event is 401 and leaves no row and no reply', async () => {
    const before = await count('SELECT count(*) AS n FROM app.bridge_messages');
    for (const signature of ['wrong', 'missing', 'stale', 'future'] as const) {
      const res = await say({ user: 'U0FORGER', channel: 'D0FORGER', text: 'hi', signature });
      expect(res.responses[0]?.status, signature).toBe(401);
    }
    expect(await count('SELECT count(*) AS n FROM app.bridge_messages')).toBe(before);
    expect(sentTo('D0FORGER')).toHaveLength(0);
  });

  it('an unknown account looks the same as a switched-off one: 404', async () => {
    const res = await fetch(`${w.server.url}/hooks/bridges/slack/00000000-0000-7000-8000-000000000999`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
  });
});

describe('a sender who is not linked', () => {
  it('stores nothing, starts no run, asks no model, and gets exactly one reply', async () => {
    const before = { messages: await count('SELECT count(*) AS n FROM app.messages'), runs: await runs(), inbound: await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'in'") };
    for (const text of ['<@U0BOT> please run the deploy', 'hello?', 'anyone there']) expect((await say({ user: 'U0STRANGER', channel: 'D0STRANGER', text })).responses[0]?.status).toBe(200);
    await waitFor('D0STRANGER', 1);
    await quiet();
    expect(sentTo('D0STRANGER')).toHaveLength(1);
    expect(sentTo('D0STRANGER')[0]).toMatch(/link/i);
    expect(await count('SELECT count(*) AS n FROM app.messages')).toBe(before.messages);
    expect(await runs()).toBe(before.runs);
    expect(await count("SELECT count(*) AS n FROM app.bridge_messages WHERE direction = 'in'")).toBe(before.inbound);
    expect(await count("SELECT count(*) AS n FROM app.bridge_unlinked_chats WHERE external_chat_id = 'D0STRANGER'")).toBe(1);
  });
});

describe('linking and the code lockout', () => {
  it('five wrong codes lock the chat, even for the right code afterwards', async () => {
    const good = await codeFor(rafi);
    for (let i = 0; i < 5; i++) await say({ user: 'U0LOCKED', channel: 'D0LOCKED', text: `start 0000000${String(i)}` });
    await waitFor('D0LOCKED', 5);
    const before = sentTo('D0LOCKED').length;
    await say({ user: 'U0LOCKED', channel: 'D0LOCKED', text: good });
    await waitFor('D0LOCKED', before + 1);
    expect(sentTo('D0LOCKED').at(-1)).toMatch(/too many/i);
    expect(await count('SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = $1', ['U0LOCKED'])).toBe(0);
  });

  it('a code typed alone in a direct chat links a person, once', async () => {
    const code = await codeFor(nadia);
    await say({ user: 'U0NADIA', channel: 'D0NADIA', text: code });
    expect((await waitFor('D0NADIA', 1))[0]).toMatch(/linked/i);
    const mine = await w.call<{ identities: Array<{ provider: string }> }>(nadia, 'GET', '/api/me/bridges');
    expect(mine.body.identities.map((i) => i.provider)).toContain('slack');
    await say({ user: 'U0OTHER', channel: 'D0OTHER', text: code });
    await waitFor('D0OTHER', 1);
    expect(await count('SELECT count(*) AS n FROM app.bridge_identities WHERE external_user_id = $1', ['U0OTHER'])).toBe(0);
  });
});

describe('a joined channel', () => {
  it('links with the plain word connect (Slack keeps / for its own commands), then a linked person posts as themselves via Slack and a bot mention runs for them', async () => {
    expect((await w.call(nadia, 'POST', `/api/channels/${dev}/bridge-links/slack/code`)).status).toBe(403);
    const made = await w.call<{ code: string; command: string; instruction: string }>(omar, 'POST', `/api/channels/${dev}/bridge-links/slack/code`);
    expect(made.status).toBe(201);
    expect(made.body.command).toBe(`connect ${made.body.code}`);
    expect(made.body.instruction).toMatch(/Slack channel/);
    await say({ user: 'U0NADIA', channel: CHANNEL, text: `<@U0BOT> ${made.body.command}` });
    expect((await waitFor(CHANNEL, 1))[0]).toMatch(/joined to #dev/i);

    const before = await messagesIn(dev);
    await say({ user: 'U0NADIA', channel: CHANNEL, text: 'Standup notes are in the doc &amp; here: <https://docs.example/standup|the page>' });
    const row = await eventually(async () => w.system(async (tx) => (await tx.query<{ author: string; via: string | null; body: string }>("SELECT m.author_id AS author, m.meta #>> '{via,provider}' AS via, m.body FROM app.messages m WHERE m.channel_id = $1 AND m.body LIKE 'Standup notes%'", [dev])).rows[0]));
    expect(row.author).toBe(nadia.actorId);
    expect(row.via).toBe('slack');
    expect(row.body).toBe('Standup notes are in the doc & here: the page (https://docs.example/standup)');
    expect(await messagesIn(dev)).toBe(before + 1);

    await say({ user: 'U0NADIA', channel: CHANNEL, text: '@slackbot what is on today?' });
    const job = await eventually(
      async () => w.system(async (tx) => (await tx.query<{ asker: string | null; trigger: string }>("SELECT payload->>'askerActorId' AS asker, payload->>'trigger' AS trigger FROM app.jobs WHERE queue = 'runtime-hermes.run' AND payload->>'channelId' = $1 ORDER BY id DESC LIMIT 1", [dev])).rows[0]),
      30_000,
      'a queued run',
    );
    expect(job.asker).toBe(nadia.actorId);
    expect(job.trigger).toBe('mention');
  });

  it('the channel’s next message reaches Slack once and escaped, and what came in from Slack does not bounce back', async () => {
    const posted = await w.call(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, threadRootId: null, body: 'Release <!channel> is at five & <@U0X> knows' });
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300);
    await eventually(async () => (sentTo(CHANNEL).some((t) => t.includes('Release')) ? true : undefined), 30_000, 'the outbound message');
    await quiet();
    const out = sentTo(CHANNEL).filter((t) => t.includes('Release'));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('&lt;!channel&gt; is at five &amp; &lt;@U0X&gt; knows');
    expect(out[0]).not.toContain('<!channel>');
    expect(sentTo(CHANNEL).filter((t) => t.includes('Standup notes'))).toHaveLength(0);
  });

  it('the bridge’s own post coming back as an event (it carries a bot id) is not posted again', async () => {
    const before = await messagesIn(dev);
    const echo = slack.sent.at(-1)!;
    await say({ user: slack.botUserId, channel: CHANNEL, text: echo.text, botId: 'B0FAKE0001' });
    await say({ user: slack.botUserId, channel: CHANNEL, text: echo.text, subtype: 'bot_message' });
    await quiet();
    expect(await messagesIn(dev)).toBe(before);
  });

  it('a replayed event id is read once', async () => {
    const before = await messagesIn(dev);
    await say({ user: 'U0NADIA', channel: CHANNEL, text: 'only once please', eventId: 'EvREPLAY1', repeat: 3 });
    await eventually(async () => ((await messagesIn(dev)) > before ? true : undefined));
    await quiet();
    expect(await messagesIn(dev)).toBe(before + 1);
  });

  it('an unlinked person in a joined channel is dropped, not posted', async () => {
    const before = await messagesIn(dev);
    await say({ user: 'U0INTRUDER', channel: CHANNEL, text: 'let me in' });
    await quiet();
    expect(await messagesIn(dev)).toBe(before);
    expect(await count("SELECT count(*) AS n FROM app.messages WHERE body LIKE 'let me in%'")).toBe(0);
  });

  it('treats the text as hostile: control characters and @channel are defused', async () => {
    await say({ user: 'U0NADIA', channel: CHANNEL, text: `hey ${String.fromCharCode(0x202e)}<!channel>${String.fromCharCode(7)} @here look` });
    const body = await eventually(async () => w.system(async (tx) => (await tx.query<{ body: string }>("SELECT body FROM app.messages WHERE channel_id = $1 AND body LIKE 'hey %' ORDER BY created_at DESC LIMIT 1", [dev])).rows[0]?.body));
    expect(body).not.toContain(String.fromCharCode(0x202e));
    expect(body).not.toContain(String.fromCharCode(7));
    expect(body).not.toMatch(/@(channel|here)\b/);
  });
});

describe('a direct chat with the bot', () => {
  it('a linked person’s message goes to their conversation with a bot, as them', async () => {
    await say({ user: 'U0NADIA', channel: 'D0NADIA', text: 'What is blocking the release?' });
    const post = await eventually(async () => w.system(async (tx) => (await tx.query<{ author_id: string; via: string | null }>("SELECT author_id, meta #>> '{via,provider}' AS via FROM app.messages WHERE body = 'What is blocking the release?'")).rows[0]));
    expect(post.author_id).toBe(nadia.actorId);
    expect(post.via).toBe('slack');
  });
});

describe('when Slack fails', () => {
  it('a busy Slack (HTTP 429, then ok:false ratelimited) is tried again and the message arrives once', async () => {
    slack.failNext(429, 1, 1);
    const posted = await w.call(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, threadRootId: null, body: 'After the rate limit' });
    expect(posted.status).toBeLessThan(300);
    await eventually(async () => (sentTo(CHANNEL).some((t) => t.includes('After the rate limit')) ? true : undefined), 60_000, 'the retried message');
    await quiet();
    expect(sentTo(CHANNEL).filter((t) => t.includes('After the rate limit'))).toHaveLength(1);
  });

  it('a token Slack no longer accepts puts the account in attention', async () => {
    slack.failNextOk('token_revoked', 3);
    await w.call(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, threadRootId: null, body: 'Nobody will hear this' });
    await eventually(async () => ((await count("SELECT count(*) AS n FROM app.bridge_accounts WHERE id = $1 AND status = 'attention'", [accountId])) === 1 ? true : undefined), 60_000, 'attention');
    expect(sentTo(CHANNEL).some((t) => t.includes('Nobody will hear this'))).toBe(false);
  });
});
