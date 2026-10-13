import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationsConversationStartedEvent,
  ListConversationsResponse,
  ListMessagesResponse,
  OpenConversationResponse,
  eventRegistry,
  type ConversationListItem,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The conversation view's server half, end to end (PLAN P5-16, SPEC §6.2): a person opens their conversation with a bot, the message they
// send is the root of a thread, the router fires the bot's `conversation` trigger with that person as the asker, and the reply lands in the
// thread as the bot. What stands in for Hermes is the same script run.test.ts of runtime-hermes uses: it behaves like
// `hermes chat --oneshot --format stream-json` and echoes the prompt it was handed, so the prompt is checked too.

const { omar, nadia, rafi, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

const FAKE_HERMES = [
  "import { appendFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ homeName: home.slice(home.lastIndexOf('/') + 1), prompt }) + '\\n');",
  "const reply = 'Answering: ' + prompt.replace(/\\s+/g, ' ');",
  "process.stdout.write(JSON.stringify({ type: 'text', text: 'Answering: ' }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

const botMd = (parts: { name: string; triggers: string[]; prompts?: string[] }): string =>
  [
    '---',
    'schema: 1',
    `name: ${parts.name}`,
    'role: Answers questions in the conversation test',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    ...parts.triggers.map((t) => `  - ${t}`),
    ...(parts.prompts ? ['conversation:', '  prompts:', ...parts.prompts.map((p) => `    - "${p}"`)] : []),
    'capabilities:',
    '  native: [messages.post]',
    '---',
    '',
    `# ${parts.name}`,
    '',
    'Soul text of the conversation test.',
    '',
  ].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
let devChannel = '';
const savedEnv: Record<string, string | undefined> = {
  MANYTHREADS_HERMES_BIN: process.env['MANYTHREADS_HERMES_BIN'],
  MANYTHREADS_HERMES_PREFIX: process.env['MANYTHREADS_HERMES_PREFIX'],
  MANYTHREADS_RUNTIME_DIR: process.env['MANYTHREADS_RUNTIME_DIR'],
  MANYTHREADS_LITELLM_URL: process.env['MANYTHREADS_LITELLM_URL'],
  HERMES_FAKE_SPOOL: process.env['HERMES_FAKE_SPOOL'],
};

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const spoolLines = (): Array<{ homeName: string; prompt: string }> =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { homeName: string; prompt: string })
    : [];

interface LoadedBot {
  botId: string;
  actorId: string;
}

async function loadBot(slug: string, md: string): Promise<LoadedBot> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = $1 AND b.status = 'active'`,
          [slug],
        );
        return r.rows[0]?.id ?? null;
      }),
    20_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null),
    5_000,
    `the actor of ${slug}`,
  );
  return { botId, actorId };
}

const open = (who: typeof nadia, slug: string) => w.call(who, 'POST', `/api/teams/engineering/bots/${slug}/conversation`);
const send = async (who: typeof nadia, channelId: string, body: string, threadRootId: string | null = null): Promise<string> => {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};
const list = async (who: typeof nadia, slug: string, query = ''): Promise<ListConversationsResponse> => {
  const res = await w.call(who, 'GET', `/api/teams/engineering/bots/${slug}/conversations${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListConversationsResponse.parse(res.body);
};
const repliesBy = async (who: typeof nadia, channelId: string, rootId: string, authorId: string) => {
  const res = await w.call(who, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId);
};
const runsOf = (botId: string) =>
  w.system(
    async (tx) =>
      (
        await tx.query<{ id: string; status: string; trigger_type: string; asker_id: string | null; thread_id: string | null; channel_id: string | null; reply_root_id: string | null }>(
          'SELECT id, status, trigger_type, asker_id, thread_id, channel_id, reply_root_id FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at, id',
          [botId],
        )
      ).rows,
  );
const eventsOf = (type: string) =>
  w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>('SELECT payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows.map((r) => r.payload));

let brain: LoadedBot;
let quiet: LoadedBot;
let nadiaChannel = '';
let rootId = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'conversations-'));
  spool = join(scratch, 'spool.jsonl');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;

  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  devChannel = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT c.id FROM app.channels c WHERE c.team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND c.name = 'dev'")).rows[0]!.id);
  brain = await loadBot(
    'brain',
    botMd({ name: 'Brain', triggers: ['{ type: conversation }', '{ type: mention }'], prompts: ['What is blocking the release?', 'Where are the 2.4 release notes?'] }),
  );
  // a bot people may only @mention: it has no `conversation` trigger, so a conversation channel with it never wakes it
  quiet = await loadBot('quiet', botMd({ name: 'Quiet', triggers: ['{ type: mention }', '{ type: channel_message }'] }));
}, 240_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('opening a conversation', () => {
  it('makes the person’s own channel once, says what to suggest, and announces the channel', async () => {
    const first = await open(nadia, 'brain');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const body = OpenConversationResponse.parse(first.body);
    expect(body).toMatchObject({
      botId: brain.botId,
      botName: 'Brain',
      created: true,
      prompts: ['What is blocking the release?', 'Where are the 2.4 release notes?'],
      promptSource: 'definition',
    });
    nadiaChannel = body.channelId;

    const again = await open(nadia, 'brain');
    expect(again.status).toBe(200);
    expect(OpenConversationResponse.parse(again.body)).toMatchObject({ channelId: nadiaChannel, created: false });
    // another person's is another channel
    const rafis = OpenConversationResponse.parse((await open(rafi, 'brain')).body);
    expect(rafis.channelId).not.toBe(nadiaChannel);

    const created = (await eventsOf('channel.channel.created')).filter((e) => e['channelId'] === nadiaChannel);
    expect(created).toEqual([expect.objectContaining({ kind: 'bot_conversation', private: true, name: '' })]);
  });

  it('a bot with no prompts of its own shows the platform’s defaults', async () => {
    const body = OpenConversationResponse.parse((await open(nadia, 'quiet')).body);
    expect(body.promptSource).toBe('default');
    expect(body.prompts.length).toBeGreaterThan(0);
  });

  it('is refused to a person of another team, to a guest, and for a bot that does not exist; it is not in the sidebar', async () => {
    expect((await open(sameera, 'brain')).status).toBe(403);
    expect((await open(personas.lena, 'brain')).status).toBe(403);
    expect((await open(nadia, 'no-such-bot')).status).toBe(404);
    // unlisted: the directory of the team holds channels, never a conversation
    const directory = await w.call(nadia, 'GET', '/api/teams/engineering/channels');
    expect(JSON.stringify(directory.body)).not.toContain(nadiaChannel);
    const dms = await w.call(nadia, 'GET', '/api/dms');
    expect(JSON.stringify(dms.body)).not.toContain(nadiaChannel);
  });
});

describe('sending starts a thread, and the bot answers in it', () => {
  it('the first message is the root; the run is a conversation run for that person; the reply is the bot’s, in the thread', async () => {
    rootId = await send(nadia, nadiaChannel, 'What is blocking the release?');
    const reply = await until(async () => (await repliesBy(nadia, nadiaChannel, rootId, brain.actorId))[0], 40_000, 'the bot to answer in the thread');
    expect(reply.body).toBe('Answering: Nadia: What is blocking the release?');

    const runs = await runsOf(brain.botId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'done',
      trigger_type: 'conversation',
      asker_id: nadia.actorId,
      channel_id: nadiaChannel,
      reply_root_id: rootId,
    });
    // the prompt is the person and the message: a conversation channel has no name to put in front of it
    expect(spoolLines().filter((l) => l.homeName.startsWith('brain-'))).toEqual([expect.objectContaining({ prompt: 'Nadia:\n\nWhat is blocking the release?' })]);
  });

  it('a follow-up in the thread is another conversation run for the same thread', async () => {
    await send(nadia, nadiaChannel, 'And who reviews it?', rootId);
    await until(async () => ((await repliesBy(nadia, nadiaChannel, rootId, brain.actorId)).length >= 2 ? true : null), 40_000, 'the second answer');
    const runs = await runsOf(brain.botId);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ trigger_type: 'conversation', asker_id: nadia.actorId, thread_id: rootId, reply_root_id: rootId });
  });

  it('announces the conversation once, ids only', async () => {
    const started = (await eventsOf('conversations.conversation.started')).filter((e) => e['threadRootId'] === rootId);
    expect(started).toHaveLength(1);
    expect(ConversationsConversationStartedEvent.parse({ type: 'conversations.conversation.started', schemaVersion: 1, ...started[0] })).toMatchObject({
      botId: brain.botId,
      personId: nadia.personId,
      channelId: nadiaChannel,
      threadRootId: rootId,
    });
    expect(JSON.stringify(started[0])).not.toContain('blocking');
    expect(Object.keys(eventRegistry['conversations.conversation.started'])).toEqual(['1']);
  });

  it('a bot with no conversation trigger is not woken by a conversation channel, whatever its other triggers say', async () => {
    const channel = OpenConversationResponse.parse((await open(nadia, 'quiet')).body).channelId;
    const before = spoolLines().length;
    const root = await send(nadia, channel, '@quiet are you there?');
    // the conversation is indexed by the same event the router read: once it is, the router has decided
    await until(async () => ((await list(nadia, 'quiet')).items.some((i) => i.threadRootId === root) ? true : null), 20_000, 'the conversation to be indexed');
    await sleep(2_000);
    expect(await runsOf(quiet.botId)).toEqual([]);
    expect(spoolLines()).toHaveLength(before);
  });
});

describe('the lists', () => {
  it('Mine: the thread, its newest message and who wrote it; nobody else’s', async () => {
    const mine = await list(nadia, 'brain');
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({
      threadRootId: rootId,
      channelId: nadiaChannel,
      source: 'conversation',
      channelName: null,
      personId: nadia.personId,
      mine: true,
      visibility: 'private',
      title: 'What is blocking the release?',
      lastAuthor: 'bot',
      replyCount: 3,
      sharedTo: null,
    });
    expect(mine.items[0]!.preview).toContain('Answering: Nadia: And who reviews it?');
    expect(mine.nextCursor).toBeNull();
    // Rafi talked to Brain too, and has nothing of Nadia's; the admin has nothing at all
    expect((await list(rafi, 'brain')).items).toEqual([]);
    expect((await list(omar, 'brain')).items).toEqual([]);
  });

  it('is private by default: nobody else can open the channel, read its messages or its thread', async () => {
    for (const who of [rafi, omar]) {
      expect((await w.call(who, 'GET', `/api/channels/${nadiaChannel}`)).status, who.key).toBe(403);
      expect((await w.call(who, 'GET', `/api/channels/${nadiaChannel}/messages?limit=20`)).status, who.key).toBe(403);
      expect((await w.call(who, 'GET', `/api/channels/${nadiaChannel}/messages/${rootId}`)).status, who.key).toBe(403);
      expect((await w.call(who, 'POST', `/api/channels/${nadiaChannel}/messages`, { channelId: nadiaChannel, body: 'hi', threadRootId: rootId })).status, who.key).toBe(403);
      const thread = await w.call(who, 'GET', `/api/threads/${rootId}`);
      expect([403, 404], who.key).toContain(thread.status);
    }
    // search does not find it either
    const found = await w.call(rafi, 'GET', '/api/search?q=blocking');
    expect(JSON.stringify(found.body)).not.toContain(rootId);
    // the Threads inbox of a person is theirs
    const inbox = await w.call(rafi, 'GET', '/api/teams/engineering/threads?tab=mine');
    expect(JSON.stringify(inbox.body)).not.toContain(rootId);
  });

  it('Shared: what the team may list; somebody else’s is read through the copy, never the private thread', async () => {
    // P5-17 will do this (post a masked copy, set the visibility); here the data model is the subject, so it is arranged as the system
    const copyText = 'Shared with the team: what is blocking the release';
    const copyRoot = await send(nadia, devChannel, copyText);
    await w.system((tx) =>
      tx.query(
        `UPDATE app.conversations SET visibility = 'shared', shared_to = $2, shared_root_id = $3, shared_by = $4, shared_at = now() WHERE thread_root_id = $1`,
        [rootId, devChannel, copyRoot, nadia.actorId],
      ),
    );
    const rafis = await list(rafi, 'brain', '?scope=shared');
    expect(rafis.items).toHaveLength(1);
    expect(rafis.items[0]).toMatchObject({
      threadRootId: copyRoot,
      channelId: devChannel,
      personId: nadia.personId,
      mine: false,
      visibility: 'shared',
      title: copyText,
      sharedTo: { channelId: devChannel, name: 'dev', rootId: copyRoot },
    });
    expect((await list(nadia, 'brain', '?scope=shared')).items[0]).toMatchObject({ threadRootId: rootId, mine: true, visibility: 'shared' });
    expect((await list(omar, 'brain', '?scope=shared')).items).toHaveLength(1);
    // a person of another team cannot even ask
    expect((await w.call(sameera, 'GET', '/api/teams/engineering/bots/brain/conversations?scope=shared')).status).toBe(403);
    // and the private thread is still Nadia's
    expect((await w.call(rafi, 'GET', `/api/channels/${nadiaChannel}/messages?limit=20`)).status).toBe(403);
    // a shared conversation whose copy the reader cannot read has no title: nothing of the private thread is on the index row
    await w.system((tx) => tx.query(`UPDATE app.conversations SET shared_root_id = NULL, shared_to = NULL WHERE thread_root_id = $1`, [rootId]));
    const bare = (await list(rafi, 'brain', '?scope=shared')).items[0]!;
    expect(bare).toMatchObject({ title: '', preview: '', sharedTo: null, mine: false });
    await w.system((tx) => tx.query(`UPDATE app.conversations SET visibility = 'private', shared_at = NULL, shared_by = NULL WHERE thread_root_id = $1`, [rootId]));
    expect((await list(rafi, 'brain', '?scope=shared')).items).toEqual([]);
  });

  it('Channel mentions: threads where the person named the bot in a channel and it was asked — theirs only', async () => {
    const mention = await send(nadia, devChannel, '@brain do we have the QA batch 7 numbers?');
    await until(async () => (await repliesBy(nadia, devChannel, mention, brain.actorId))[0], 40_000, 'the bot to answer the mention');
    const mine = await list(nadia, 'brain', '?scope=mentions');
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({
      threadRootId: mention,
      channelId: devChannel,
      source: 'mention',
      channelName: 'dev',
      mine: true,
      visibility: null,
      title: '@brain do we have the QA batch 7 numbers?',
      lastAuthor: 'bot',
      replyCount: 1,
    });
    // a mention is a thread of a public channel, so it is not a conversation of the Mine list, and it is nobody else's
    expect((await list(nadia, 'brain')).items.map((i) => i.threadRootId)).not.toContain(mention);
    expect((await list(rafi, 'brain', '?scope=mentions')).items).toEqual([]);
    const run = (await runsOf(brain.botId)).find((r) => r.reply_root_id === mention);
    expect(run).toMatchObject({ trigger_type: 'mention', asker_id: nadia.actorId, channel_id: devChannel });
  });

  it('pages newest first with a cursor, and refuses a cursor that is not one', async () => {
    const channel = OpenConversationResponse.parse((await open(nadia, 'quiet')).body).channelId;
    const roots: string[] = [];
    for (const text of ['first question', 'second question', 'third question']) roots.push(await send(nadia, channel, text));
    await until(async () => ((await list(nadia, 'quiet')).items.length >= 4 ? true : null), 20_000, 'every conversation to be indexed');
    const page1 = await list(nadia, 'quiet', '?limit=2');
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await list(nadia, 'quiet', `?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    const seen = [...page1.items, ...page2.items].map((i: ConversationListItem) => i.threadRootId);
    expect(new Set(seen).size).toBe(seen.length);
    // newest first: the last thing sent leads
    expect(page1.items[0]!.threadRootId).toBe(roots[2]);
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/bots/quiet/conversations?cursor=nonsense')).status).toBe(400);
  });
});
