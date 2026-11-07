import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChatDeleteResponse,
  ChatFeedbackResponse,
  ChatModelsResponse,
  ChatPatchResponse,
  ChatSendResponse,
  ChatThreadState,
  ListConversationsResponse,
  ListMessagesResponse,
  OpenConversationResponse,
  RunStopResponse,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

const { omar, nadia, rafi, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

// The Chat screen's server half, end to end (PLAN P20-16): the model menu, sending with a model pick, the state of a conversation with its variants,
// naming, pinning and searching, Regenerate keeping the earlier answer, thumbs, deleting with the way back, and Stop. What stands in for Hermes is the
// script run of conversation.test.ts: it answers at once, so what is checked of Stop is who may press it and what it says for a run that has ended.

const FAKE_HERMES = [
  "import { appendFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ homeName: home.slice(home.lastIndexOf('/') + 1), prompt }) + '\\n');",
  "const reply = 'Answering: ' + prompt.replace(/\\s+/g, ' ');",
  "if (prompt.includes('SLOW')) { process.stdout.write(JSON.stringify({ type: 'text', text: 'Working on ' }) + '\\n'); process.stdout.write(JSON.stringify({ type: 'text', text: 'it' }) + '\\n'); await new Promise((resolve) => setTimeout(resolve, 120000)); }",
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
    '  aliases: [smart, fast]',
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

const BASE = '/api/teams/engineering/bots/brain';
let brain: LoadedBot;
let channelId = '';
let root = '';
let secondRoot = '';
let replyOfRoot = '';

const post = (who: typeof nadia, path: string, body?: unknown) => w.call(who, 'POST', `${BASE}${path}`, body);
const patch = (who: typeof nadia, thread: string, body: unknown) => w.call(who, 'PATCH', `${BASE}/conversations/${thread}`, body);
const state = async (who: typeof nadia, thread: string) => w.call(who, 'GET', `${BASE}/conversations/${thread}/state`);
const stateOf = async (who: typeof nadia, thread: string): Promise<ChatThreadState> => {
  const res = await state(who, thread);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ChatThreadState.parse(res.body);
};
const send = async (who: typeof nadia, body: Record<string, unknown>) => w.call(who, 'POST', `${BASE}/conversations/send`, { threadRootId: null, ...body });
const list = async (who: typeof nadia, query = ''): Promise<ListConversationsResponse> => {
  const res = await w.call(who, 'GET', `${BASE}/conversations?scope=mine${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListConversationsResponse.parse(res.body);
};
const botReplies = async (who: typeof nadia, thread: string) => {
  const res = await w.call(who, 'GET', `/api/channels/${channelId}/messages?threadRootId=${thread}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === brain.actorId);
};
const waitForReplies = (thread: string, count: number) =>
  until(async () => ((await botReplies(nadia, thread)).length >= count ? await botReplies(nadia, thread) : null), 60_000, `${String(count)} answers in ${thread}`);
const waitForVariants = (thread: string, turn: string, count: number) =>
  until(
    async () => {
      const s = await stateOf(nadia, thread);
      const t = s.turns.find((x) => x.turnMessageId === turn);
      return t && t.variants.length >= count ? s : null;
    },
    60_000,
    `${String(count)} variants of the turn`,
  );
const eventsOf = (type: string) =>
  w.system(async (tx) => (await tx.query<{ team_id: string | null; payload: Record<string, unknown> }>('SELECT team_id, payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows);

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'conversations-chat-'));
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
  brain = await loadBot('brain', botMd({ name: 'Brain', triggers: ['{ type: conversation }'] }));
  const opened = await w.call(nadia, 'POST', `${BASE}/conversation`);
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  channelId = OpenConversationResponse.parse(opened.body).channelId;
}, 240_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('the model menu', () => {
  it('lists the aliases of the definition in order, the first as the default, none available until the workspace binds a model', async () => {
    const res = await w.call(nadia, 'GET', `${BASE}/conversations/models`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const menu = ChatModelsResponse.parse(res.body).models;
    expect(menu.map((m) => m.alias)).toEqual(['smart', 'fast']);
    expect(menu.map((m) => m.isDefault)).toEqual([true, false]);
    expect(menu.every((m) => !m.available && m.reason !== null)).toBe(true);
    expect(JSON.stringify(menu)).not.toMatch(/gpt|claude|anthropic|openai/i);
  });

  it('is the person’s own to read: a person of another team is refused, an unknown bot is not found', async () => {
    expect((await w.call(sameera, 'GET', `${BASE}/conversations/models`)).status).toBe(403);
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/bots/nobody/conversations/models')).status).toBe(404);
  });
});

describe('sending', () => {
  it('starts a conversation, the bot answers as variant 1 of the turn, and the title is the first words', async () => {
    const res = await send(nadia, { body: 'Plan the release notes' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = ChatSendResponse.parse(res.body);
    expect(sent.channelId).toBe(channelId);
    root = sent.messageId;
    const reply = (await waitForReplies(root, 1))[0]!;
    replyOfRoot = reply.id;
    const s = await waitForVariants(root, root, 1);
    expect(s.turns).toEqual([{ turnMessageId: root, variants: [expect.objectContaining({ messageId: replyOfRoot, variantNo: 1, chosen: true, stopped: false })] }]);
    expect(s).toMatchObject({ threadRootId: root, channelId, botId: brain.botId, title: 'Plan the release notes', pinned: false, liveRunId: null });
    const item = (await list(nadia)).items.find((i) => i.threadRootId === root)!;
    expect(item).toMatchObject({ title: 'Plan the release notes', titleSource: null, pinned: false, modelAlias: null });
  });

  it('records on the run which message it answers and the model that answered (the bot’s first when none was picked)', async () => {
    const run = await w.system(async (tx) => (await tx.query<{ turn_message_id: string | null; model_alias: string | null; stopped_by_asker: boolean }>('SELECT turn_message_id, model_alias, stopped_by_asker FROM app.bot_runs WHERE bot_id = $1 AND reply_root_id = $2', [brain.botId, root])).rows);
    expect(run).toEqual([{ turn_message_id: root, model_alias: 'smart', stopped_by_asker: false }]);
  });

  it('refuses a model the definition does not list, and one the workspace has no model for, with one plain sentence', async () => {
    const unlisted = await send(nadia, { body: 'x', modelAlias: 'code' });
    expect(unlisted.status).toBe(422);
    expect(JSON.stringify(unlisted.body)).toContain('cannot use that model');
    const unbound = await send(nadia, { body: 'x', modelAlias: 'smart' });
    expect(unbound.status).toBe(422);
    expect(JSON.stringify(unbound.body)).toContain('Ask an admin');
    // nothing was posted by either
    expect((await list(nadia)).items).toHaveLength(1);
  });

  it('takes a model the definition lists once the workspace binds it, and the run answers with it', async () => {
    await w.system((tx) => tx.query("INSERT INTO app.llm_aliases (workspace_id, alias, model) SELECT id, 'fast', 'test-model' FROM app.workspaces"));
    const menu = ChatModelsResponse.parse((await w.call(nadia, 'GET', `${BASE}/conversations/models`)).body).models;
    expect(menu.find((m) => m.alias === 'fast')).toMatchObject({ available: true, reason: null });
    expect(menu.find((m) => m.alias === 'smart')).toMatchObject({ available: false });
    const res = await send(nadia, { body: 'Quick one', modelAlias: 'fast' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    secondRoot = ChatSendResponse.parse(res.body).messageId;
    await waitForReplies(secondRoot, 1);
    const runs = await until(
      async () => {
        const rows = (await w.system(async (tx) => (await tx.query<{ status: string; model_alias: string | null }>('SELECT status, model_alias FROM app.bot_runs WHERE bot_id = $1 AND reply_root_id = $2', [brain.botId, secondRoot])).rows));
        return rows.length === 1 && rows[0]!.status === 'done' ? rows : null;
      },
      40_000,
      'the run to close',
    );
    expect(runs[0]!.model_alias).toBe('fast');
    expect((await stateOf(nadia, secondRoot)).modelAlias).toBe('fast');
    expect((await list(nadia)).items.find((i) => i.threadRootId === secondRoot)).toMatchObject({ modelAlias: 'fast' });
  });

  it('answers the next message of a conversation with the model it was last given, though the message names none (a reloaded page forgets its pick)', async () => {
    const res = await send(nadia, { body: 'Same again, please', threadRootId: secondRoot });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const next = ChatSendResponse.parse(res.body).messageId;
    const run = await until(
      async () => {
        const rows = (await w.system(async (tx) => (await tx.query<{ status: string; model_alias: string | null }>('SELECT status, model_alias FROM app.bot_runs WHERE bot_id = $1 AND turn_message_id = $2', [brain.botId, next])).rows));
        return rows.length === 1 && rows[0]!.status === 'done' ? rows[0]! : null;
      },
      40_000,
      'the run to close',
    );
    expect(run.model_alias).toBe('fast');
  });

  it('continues a conversation: the next turn is another turn of the same thread, and another person’s thread is not found', async () => {
    const res = await send(nadia, { body: 'And the week before?', threadRootId: root });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const second = ChatSendResponse.parse(res.body).messageId;
    const s = await waitForVariants(root, second, 1);
    expect(s.turns.map((t) => t.turnMessageId)).toEqual([root, second]);
    expect((await send(rafi, { body: 'let me in', threadRootId: root })).status).toBe(404);
    expect((await send(nadia, { body: 'x', threadRootId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });
});

describe('naming, pinning and searching', () => {
  it('renames a conversation (manual from then on), pins it, and finds it by words in the title or the thread', async () => {
    const res = await patch(nadia, root, { title: '  Release plan  ', pinned: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ChatPatchResponse.parse(res.body)).toMatchObject({ title: 'Release plan', titleSource: 'manual', pinned: true });
    const item = (await list(nadia)).items.find((i) => i.threadRootId === root)!;
    expect(item).toMatchObject({ title: 'Release plan', titleSource: 'manual', pinned: true });
    expect((await list(nadia, '&pinned=only')).items.map((i) => i.threadRootId)).toEqual([root]);
    expect((await list(nadia, '&pinned=without')).items.map((i) => i.threadRootId)).toEqual([secondRoot]);
    expect((await list(nadia, '&q=release')).items.map((i) => i.threadRootId)).toEqual([root]);
    // a word of a message in the thread, not of the title
    expect((await list(nadia, '&q=week%20before')).items.map((i) => i.threadRootId)).toEqual([root]);
    expect((await list(nadia, '&q=zebra')).items).toEqual([]);
    // unpin
    expect(ChatPatchResponse.parse((await patch(nadia, root, { pinned: false })).body)).toMatchObject({ pinned: false, title: 'Release plan' });
  });

  it('refuses an empty change, an empty or too long title, and a model the definition does not list', async () => {
    expect((await patch(nadia, root, {})).status).toBe(400);
    expect((await patch(nadia, root, { title: '   ' })).status).toBe(400);
    expect((await patch(nadia, root, { title: 'x'.repeat(81) })).status).toBe(400);
    expect((await patch(nadia, root, { modelAlias: 'code' })).status).toBe(422);
  });

  it('is the person’s own: nobody else can read, rename or delete it', async () => {
    expect((await state(rafi, root)).status).toBe(404);
    expect((await patch(rafi, root, { title: 'Mine now' })).status).toBe(404);
    expect((await w.call(rafi, 'DELETE', `${BASE}/conversations/${root}`)).status).toBe(404);
    expect((await stateOf(nadia, root)).title).toBe('Release plan');
  });

  it('announces a rename with ids only', async () => {
    const renamed = (await eventsOf('conversations.conversation.renamed')).filter((e) => e.payload['threadRootId'] === root);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]!.payload).toMatchObject({ botId: brain.botId, personId: nadia.personId, source: 'manual' });
    expect(JSON.stringify(renamed[0]!.payload)).not.toContain('Release');
    expect(renamed[0]!.team_id).toBeNull();
  });
});

describe('another answer to the same message', () => {
  it('keeps the earlier answer as a variant, makes the new one the chosen, and lets the person switch back', async () => {
    const res = await post(nadia, `/conversations/${root}/turns/${root}/regenerate`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const s = await waitForVariants(root, root, 2);
    const turn = s.turns.find((t) => t.turnMessageId === root)!;
    expect(turn.variants.map((v) => v.variantNo)).toEqual([1, 2]);
    expect(turn.variants.map((v) => v.chosen)).toEqual([false, true]);
    expect(turn.variants[0]!.messageId).toBe(replyOfRoot);
    const switched = await w.call(nadia, 'PUT', `${BASE}/conversations/${root}/turns/${root}/variant`, { messageId: replyOfRoot });
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect((await stateOf(nadia, root)).turns.find((t) => t.turnMessageId === root)!.variants.map((v) => v.chosen)).toEqual([true, false]);
    // the announcement carries ids only
    const events = (await eventsOf('conversations.turn.regenerated')).filter((e) => e.payload['threadRootId'] === root);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ turnMessageId: root, modelAlias: null });
    expect(events[0]!.team_id).toBeNull();
  });

  it('refuses a message that is not the person’s own in this thread, a stranger, and an answer that is not of the turn', async () => {
    expect((await post(nadia, `/conversations/${root}/turns/${replyOfRoot}/regenerate`, {})).status).toBe(404);
    expect((await post(rafi, `/conversations/${root}/turns/${root}/regenerate`, {})).status).toBe(404);
    const wrong = await w.call(nadia, 'PUT', `${BASE}/conversations/${root}/turns/${root}/variant`, { messageId: root });
    expect(wrong.status).toBe(404);
  });

  it('refuses a model with no model behind it for the new answer, as sending does', async () => {
    const res = await post(nadia, `/conversations/${secondRoot}/turns/${secondRoot}/regenerate`, { modelAlias: 'smart' });
    expect(res.status).toBe(422);
  });
});

describe('thumbs', () => {
  it('are kept for the person, change, and are taken back; the event has the vote and no reason', async () => {
    const up = await w.call(nadia, 'PUT', `${BASE}/conversations/messages/${replyOfRoot}/feedback`, { vote: 'up', reason: 'clear and short' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(ChatFeedbackResponse.parse(up.body)).toMatchObject({ messageId: replyOfRoot, vote: 'up', reason: 'clear and short' });
    expect((await stateOf(nadia, root)).feedback).toEqual([{ messageId: replyOfRoot, vote: 'up', reason: 'clear and short' }]);
    await w.call(nadia, 'PUT', `${BASE}/conversations/messages/${replyOfRoot}/feedback`, { vote: 'down' });
    expect((await stateOf(nadia, root)).feedback).toEqual([{ messageId: replyOfRoot, vote: 'down', reason: '' }]);
    const gone = await w.call(nadia, 'PUT', `${BASE}/conversations/messages/${replyOfRoot}/feedback`, { vote: null });
    expect(gone.status).toBe(200);
    expect((await stateOf(nadia, root)).feedback).toEqual([]);
    const events = (await eventsOf('conversations.feedback.given')).filter((e) => e.payload['messageId'] === replyOfRoot);
    expect(events.map((e) => e.payload['vote'])).toEqual(['up', 'down', 'none']);
    expect(JSON.stringify(events)).not.toContain('clear and short');
    expect(events.every((e) => e.team_id === null)).toBe(true);
  });

  it('can only be given on an answer of the person’s own conversation, and the reason is short', async () => {
    expect((await w.call(rafi, 'PUT', `${BASE}/conversations/messages/${replyOfRoot}/feedback`, { vote: 'up' })).status).toBe(404);
    expect((await w.call(nadia, 'PUT', `${BASE}/conversations/messages/${root}/feedback`, { vote: 'up' })).status).toBe(404);
    expect((await w.call(nadia, 'PUT', `${BASE}/conversations/messages/${replyOfRoot}/feedback`, { vote: 'up', reason: 'x'.repeat(141) })).status).toBe(400);
  });
});

describe('Stop', () => {
  it('says nothing was stopped for a run that has ended, and is the asker’s alone', async () => {
    const runId = (await w.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.bot_runs WHERE bot_id = $1 AND reply_root_id = $2 LIMIT 1', [brain.botId, root])).rows[0]!.id));
    const mine = await w.call(nadia, 'POST', `/api/runs/${runId}/stop`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(RunStopResponse.parse(mine.body)).toEqual({ stopped: false });
    expect((await w.call(rafi, 'POST', `/api/runs/${runId}/stop`)).status).toBe(404);
    expect((await w.call(omar, 'POST', `/api/runs/${runId}/stop`)).status).toBe(404);
    expect((await w.call(nadia, 'POST', '/api/runs/00000000-0000-4000-8000-000000000000/stop')).status).toBe(404);
  });
});

describe('Stop on a run that is writing', () => {
  it('stops the run, keeps what was written as the answer, and marks it as stopped by the asker', async () => {
    const res = await send(nadia, { body: 'SLOW please' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const slowRoot = ChatSendResponse.parse(res.body).messageId;
    // the state names the live run while it is answering
    // (the conversation is indexed a moment after the send, so the state is not there for the very first polls)
    const live = await until(
      async () => {
        const r = await state(nadia, slowRoot);
        return r.status === 200 ? ChatThreadState.parse(r.body).liveRunId : null;
      },
      60_000,
      'the run to be live',
    );
    expect((await w.call(rafi, 'POST', `/api/runs/${live}/stop`)).status).toBe(404);
    // the first words are written before the run can be stopped; stop retries until the process has started
    const stopped = await until(
      async () => {
        const r = RunStopResponse.parse((await w.call(nadia, 'POST', `/api/runs/${live}/stop`)).body);
        return r.stopped ? r : null;
      },
      30_000,
      'the stop to take',
    );
    expect(stopped).toEqual({ stopped: true });
    const replies = await waitForReplies(slowRoot, 1);
    expect(replies[0]!.body).toBe('Working on it');
    const s = await waitForVariants(slowRoot, slowRoot, 1);
    expect(s.turns[0]!.variants[0]).toMatchObject({ stopped: true, runId: live });
    expect(s.liveRunId).toBeNull();
    const run = await w.system(async (tx) => (await tx.query<{ status: string; stopped_by_asker: boolean }>('SELECT status, stopped_by_asker FROM app.bot_runs WHERE id = $1', [live])).rows[0]);
    expect(run).toEqual({ status: 'done', stopped_by_asker: true });
    // a second press finds nothing to stop
    expect(RunStopResponse.parse((await w.call(nadia, 'POST', `/api/runs/${live}/stop`)).body)).toEqual({ stopped: false });
    await w.call(nadia, 'DELETE', `${BASE}/conversations/${slowRoot}`);
  });
});

describe('deleting', () => {
  it('takes a conversation out of every list, keeps a way back for 30 seconds, and brings it back whole', async () => {
    const gone = await w.call(nadia, 'DELETE', `${BASE}/conversations/${secondRoot}`);
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    const body = ChatDeleteResponse.parse(gone.body);
    expect(new Date(body.undoUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await list(nadia)).items.map((i) => i.threadRootId)).toEqual([root]);
    expect((await state(nadia, secondRoot)).status).toBe(404);
    expect((await patch(nadia, secondRoot, { title: 'still here?' })).status).toBe(404);
    expect((await w.call(nadia, 'DELETE', `${BASE}/conversations/${secondRoot}`)).status).toBe(404);
    const back = await post(nadia, `/conversations/${secondRoot}/restore`);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await list(nadia)).items.map((i) => i.threadRootId).sort()).toEqual([root, secondRoot].sort());
    expect((await stateOf(nadia, secondRoot)).threadRootId).toBe(secondRoot);
  });

  it('refuses to bring it back after the 30 seconds, and a restore of a conversation that is not deleted', async () => {
    expect((await post(nadia, `/conversations/${secondRoot}/restore`)).status).toBe(410);
    await w.call(nadia, 'DELETE', `${BASE}/conversations/${secondRoot}`);
    await w.system((tx) => tx.query("UPDATE app.conversations SET deleted_at = now() - interval '31 seconds' WHERE thread_root_id = $1", [secondRoot]));
    const late = await post(nadia, `/conversations/${secondRoot}/restore`);
    expect(late.status).toBe(410);
    expect(JSON.stringify(late.body)).toContain('too late');
    expect((await list(nadia)).items.map((i) => i.threadRootId)).toEqual([root]);
  });
});
