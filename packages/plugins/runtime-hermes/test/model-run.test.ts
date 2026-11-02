/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';
import { FAILURE_NOTICE } from '../src/failure-notice.ts';

// P19-10, end to end: a bot placed on an LLM gateway runner (`placement.runs_on`) is answered by the platform itself, with no Hermes anywhere. A mention opens a run, the `model` runtime asks the
// runner's alias through the gateway (the proxy here is tools/fake-llm), the tool the model asks for is called through the MCP door as the bot, and the closing text is posted as the reply. The
// spend of every turn lands in the ledger under the bot and the run, and a refusal or the step limit is the one plain notice in the thread.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let fake: FakeLlm;
let channelId = '';
const saved = { url: process.env['MANYTHREADS_LITELLM_URL'], key: process.env['MANYTHREADS_LITELLM_MASTER_KEY'] };

type Messages = Array<{ role: string; content: string }>;
let script: (messages: Messages) => string | { status: number; body: unknown } = () => 'plain answer';

const toolCallAnswer = (name: string, args: unknown, id = 'call_1') => ({
  status: 200,
  body: {
    id: 'chatcmpl-tool',
    model: 'smart',
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 40, completion_tokens: 11, total_tokens: 51 },
  },
});

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const botMd = (name: string, runner: string): string =>
  ['---', 'schema: 1', `name: ${name}`, 'role: Answers from the team notes', 'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'triggers:', '  - type: mention', 'capabilities:', '  native: [messages.post, messages.search]', 'placement:', `  runs_on: ${runner}`, '---', '', `# ${name}`, '', 'You answer from the team notes. Say what you did.', ''].join('\n');

async function loadBot(slug: string, runner = 'brain-model'): Promise<{ botId: string; actorId: string }> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: botMd(slug, runner) }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = $1 AND status = 'active'`, [slug])).rows[0]?.id ?? null), 20_000, `the loader to load ${slug}`);
  const actorId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null), 5_000, `the actor of ${slug}`);
  return { botId, actorId };
}

const post = async (body: string): Promise<string> => {
  const res = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};

const messagesBy = async (rootId: string, authorId: string): Promise<{ id: string; body: string }[]> => {
  const res = await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId);
};

const runsOf = (botId: string) => w.system(async (tx) => (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at, id`, [botId])).rows);
const closedRun = (botId: string) =>
  until(async () => {
    const last = (await runsOf(botId)).at(-1);
    return last && last.status !== 'running' ? last : null;
  }, 30_000, 'the run to close');
const spendOf = (runId: string) =>
  w.system(async (tx) => (await tx.query<{ bot_id: string; alias: string; prompt_tokens: number; completion_tokens: number }>('SELECT bot_id, alias, prompt_tokens, completion_tokens FROM app.llm_spend WHERE run_id = $1 ORDER BY occurred_at, id', [runId])).rows);
const chatCalls = () => fake.state.calls.filter((c) => c.path === '/chat/completions');

beforeAll(async () => {
  fake = await startFakeLlm({ masterKey: 'sk-fake', completion: ({ messages }) => script(messages) });
  process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-fake';
  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`)).rows[0]?.id ?? '');
  expect(channelId).not.toBe('');
  // The workspace binds the `smart` alias, and an admin makes an LLM gateway runner on it for every team.
  const provider = await w.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'OpenAI', kind: 'openai', apiKey: 'sk-provider-secret-0001' });
  expect(provider.status, JSON.stringify(provider.body)).toBe(201);
  const bound = await w.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId: provider.body.provider.id, model: 'gpt-4o', fallbacks: [] });
  expect(bound.status, JSON.stringify(bound.body)).toBe(200);
  const runner = await w.call<{ runner: any }>(omar, 'POST', '/api/admin/bot-runners', { name: 'brain-model', label: 'Brain model', kind: 'llm_gateway', modelAlias: 'smart', teams: { all: true } });
  expect(runner.status, JSON.stringify(runner.body)).toBe(201);
  expect(runner.body.runner).toMatchObject({ kind: 'llm_gateway', modelAlias: 'smart' });
}, 180_000);

afterAll(async () => {
  await w?.close();
  await fake?.close();
  for (const [name, value] of [['MANYTHREADS_LITELLM_URL', saved.url], ['MANYTHREADS_LITELLM_MASTER_KEY', saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('a bot on an LLM gateway runner', () => {
  it('calls a tool the model asks for as the bot, uses its result, posts the closing text as the reply, and the spend lands under the bot and the run', async () => {
    const bot = await loadBot('brain-one');
    script = (messages) => (messages.some((m) => m.role === 'tool') ? 'Done: I searched and checked it.' : toolCallAnswer('messages_search', { query: 'pricing' }));
    const before = chatCalls().length;

    const rootId = await post('@brain-one please note this');
    const run = await closedRun(bot.botId);
    expect(run.status).toBe('done');

    // the closing text is the reply, posted as the bot
    const posted = (await messagesBy(rootId, bot.actorId)).map((m) => m.body);
    expect(posted).toEqual(['Done: I searched and checked it.']);

    // two turns went to the proxy with the master key, the first offering the tool under a name a provider accepts, with BOT.md body as the system text
    const calls = chatCalls().slice(before);
    expect(calls).toHaveLength(2);
    const first = calls[0]!.body as { model: string; tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string }>; metadata: Record<string, string> };
    expect(first.model).toBe('smart');
    expect(first.tools.map((t) => t.function.name)).toContain('messages_search');
    expect(first.tools.map((t) => t.function.name)).not.toContain('messages.post');
    expect(first.tools.every((t) => /^[a-zA-Z0-9_-]+$/.test(t.function.name))).toBe(true);
    expect(first.messages[0]).toMatchObject({ role: 'system' });
    expect(first.messages[0]!.content).toContain('You answer from the team notes. Say what you did.');
    expect(first.metadata).toMatchObject({ manythreads_bot: bot.botId, manythreads_run: run.id });
    // the second turn carries the tool's answer
    const second = calls[1]!.body as { messages: Array<{ role: string; content: string | null; tool_call_id?: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    // the tool ran through the MCP door as the bot: its answer is the search's own, not a refusal, and it is tied to the call the model made
    expect(second.messages[3]!.tool_call_id).toBe('call_1');
    expect(second.messages[3]!.content).toBeTruthy();
    expect(second.messages[3]!.content).not.toMatch(/forbidden|unknown_tool|not_granted/);

    // one spend line per turn, under the bot and the run
    const spend = await spendOf(run.id);
    expect(spend).toHaveLength(2);
    expect(spend.every((s) => s.bot_id === bot.botId && s.alias === 'smart')).toBe(true);
    expect(spend[0]).toMatchObject({ prompt_tokens: 40, completion_tokens: 11 });
  });

  it('a bot that answers without a tool posts the text and nothing else', async () => {
    const bot = await loadBot('brain-two');
    script = () => 'Plain reply, no tools.';
    const rootId = await post('@brain-two hello');
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the reply');
    expect(reply.body).toBe('Plain reply, no tools.');
    expect((await closedRun(bot.botId)).status).toBe('done');
  });

  it('a spent budget is the run\'s plain failure in the thread, nothing is sent to the model, and no spend line is written', async () => {
    const bot = await loadBot('brain-budget');
    await w.system(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'bot', $2, 1)`, [omar.workspaceId, bot.botId]);
      await tx.query(`INSERT INTO app.llm_spend (workspace_id, bot_id, alias, cost_usd) VALUES ($1, $2, 'smart', 2)`, [omar.workspaceId, bot.botId]);
    });
    script = () => 'never asked';
    const before = chatCalls().length;
    const rootId = await post('@brain-budget are you there?');
    const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the failure notice');
    expect(notice.body).toBe(FAILURE_NOTICE.limit);
    const run = await closedRun(bot.botId);
    expect(run.status).toBe('failed');
    expect(chatCalls()).toHaveLength(before);
    expect(await spendOf(run.id)).toHaveLength(0);
  });

  it('a model that keeps asking for tools is stopped at the step limit with the plain notice', async () => {
    const bot = await loadBot('brain-steps');
    script = () => toolCallAnswer('messages_search', { query: 'again' });
    const before = chatCalls().length;
    const rootId = await post('@brain-steps loop forever');
    const notice = await until(async () => (await messagesBy(rootId, bot.actorId)).find((m) => m.body === FAILURE_NOTICE.steps), 60_000, 'the step-limit notice');
    expect(notice.body).toBe(FAILURE_NOTICE.steps);
    expect((await closedRun(bot.botId)).status).toBe('failed');
    expect(chatCalls().length - before).toBe(12);
  });

  it('a secret in the prompt is redacted on the first turn and is not sent again in clear text on the next one', async () => {
    const bot = await loadBot('brain-secret');
    const secret = 'sk-abcdefghijklmnopqrstuvwx';
    script = (messages) => (messages.some((m) => m.role === 'tool') ? 'Done.' : toolCallAnswer('messages_search', { query: 'pricing' }));
    const before = chatCalls().length;
    const rootId = await post(`@brain-secret my key is ${secret}, please search`);
    expect((await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the reply')).body).toBe('Done.');
    const calls = chatCalls().slice(before);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(JSON.stringify(c.body), 'no turn carries the secret').not.toContain(secret);
    expect(JSON.stringify(calls[1]!.body)).toContain('[redacted:api-key]');
  });

  it('an answer the model cut off at its length limit is the plain notice, never posted as if it were complete', async () => {
    const bot = await loadBot('brain-long');
    script = () => ({
      status: 200,
      body: { id: 'x', model: 'smart', choices: [{ message: { role: 'assistant', content: 'The decision was to' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 256 } },
    });
    const rootId = await post('@brain-long write a very long essay');
    const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the failure notice');
    expect(notice.body).toBe(FAILURE_NOTICE.too_long);
    expect((await closedRun(bot.botId)).status).toBe('failed');
  });

  it('an alias that is not bound is the gateway notice, not a crash', async () => {
    await w.system((tx) => tx.query(`UPDATE app.bot_runners SET model_alias = 'fast' WHERE name = 'brain-model'`));
    try {
      const bot = await loadBot('brain-unbound');
      script = () => 'never asked';
      const before = chatCalls().length;
      const rootId = await post('@brain-unbound hello');
      const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the failure notice');
      expect(notice.body).toBe(FAILURE_NOTICE.gateway);
      expect(chatCalls()).toHaveLength(before);
    } finally {
      await w.system((tx) => tx.query(`UPDATE app.bot_runners SET model_alias = 'smart' WHERE name = 'brain-model'`));
    }
  });

  it('a runner an admin has switched off turns the run away in the runner\'s own words', async () => {
    const bot = await loadBot('brain-off');
    await w.system((tx) => tx.query(`UPDATE app.bot_runners SET enabled = false WHERE name = 'brain-model'`));
    try {
      script = () => 'never asked';
      const before = chatCalls().length;
      const rootId = await post('@brain-off hello');
      const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the failure notice');
      expect(notice.body).toContain('switched off');
      expect(chatCalls()).toHaveLength(before);
    } finally {
      await w.system((tx) => tx.query(`UPDATE app.bot_runners SET enabled = true WHERE name = 'brain-model'`));
    }
  });
});
