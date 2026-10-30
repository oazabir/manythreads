import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotTestResult, BotTestStarted, ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The bot page's Test action against the real server, router and runtime (PLAN P7-11): a lead or workspace admin asks one question; it lands in their own
// conversation with the bot as an ordinary message, is filed as a rehearsal question, the router queues the run as a rehearsal, and the reply comes back
// in the thread. What stands in for Hermes is the script of conversation.test.ts: it echoes the prompt, so the prompt the model was handed is checked too.
// The hold-back itself (what the gateway does with a write) is gateway-mcp's rehearsal.test.ts.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

const FAKE_HERMES = [
  "import { appendFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ prompt }) + '\\n');",
  "const reply = 'Answering: ' + prompt.replace(/\\s+/g, ' ').slice(-200);",
  "process.stdout.write(JSON.stringify({ type: 'text', text: 'Answering: ' }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

const botMd = (parts: { name: string; triggers: string[]; runtimeGrants?: string[] }): string =>
  [
    '---',
    'schema: 1',
    `name: ${parts.name}`,
    'role: Answers questions in the rehearsal test',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    ...parts.triggers.map((t) => `  - ${t}`),
    'capabilities:',
    '  native: [messages.post]',
    ...(parts.runtimeGrants ? [`  runtime: [${parts.runtimeGrants.join(', ')}]`] : []),
    '---',
    '',
    `# ${parts.name}`,
    '',
    'Soul text of the rehearsal test.',
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

const prompts = (): string[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => (JSON.parse(l) as { prompt: string }).prompt)
    : [];

async function loadBot(slug: string, md: string): Promise<string> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  return until(
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
}

const test = (who: typeof omar | typeof nadia | typeof sameera, slug: string, body: unknown) => w.call(who, 'POST', `/api/teams/engineering/bots/${slug}/test`, body);
const result = (who: typeof omar | typeof nadia, slug: string, messageId: string) => w.call(who, 'GET', `/api/teams/engineering/bots/${slug}/test/${messageId}`);
const count = (sql: string, params: unknown[] = []): Promise<number> =>
  w.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0]!.n);
const runsOf = (botId: string) =>
  w.system(
    async (tx) =>
      (await tx.query<{ id: string; status: string; rehearsal: boolean; asker_id: string | null; reply_root_id: string | null }>('SELECT id, status, rehearsal, asker_id, reply_root_id FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at, id', [botId]))
        .rows,
  );
const botReplies = async (who: typeof omar, channelId: string, rootId: string) => {
  const res = await w.call(who, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId !== who.actorId);
};

let brain = '';
let quiet = '';
let shelled = '';
let startedId = '';
let startedChannel = '';

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'rehearsal-'));
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
  brain = await loadBot('brain', botMd({ name: 'Brain', triggers: ['{ type: conversation }'] }));
  quiet = await loadBot('quiet', botMd({ name: 'Quiet', triggers: ['{ type: mention }'] }));
  shelled = await loadBot('shelled', botMd({ name: 'Shelled', triggers: ['{ type: conversation }'], runtimeGrants: ['shell'] }));
}, 240_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('who may start a test, and for what', () => {
  it('a plain member is refused (403), an unknown bot is 404, and a person outside the team cannot tell the team is there', async () => {
    const member = await test(nadia, 'brain', { question: 'Hello?' });
    expect(member.status, JSON.stringify(member.body)).toBe(403);
    const unknown = await test(omar, 'no-such-bot', { question: 'Hello?' });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);
    const outsider = await test(sameera, 'brain', { question: 'Hello?' });
    expect([403, 404]).toContain(outsider.status);
    expect(await count("SELECT 1 FROM app.rehearsal_questions")).toBe(0);
    expect(await count("SELECT 1 FROM app.channels WHERE kind = 'bot_conversation' AND bot_id = $1", [brain])).toBe(0);
  });

  it('the body is the question and nothing else: no flag, no channel, no asker, no empty text', async () => {
    for (const body of [{}, { question: '   ' }, { question: 'Hi', rehearsal: true }, { question: 'Hi', channelId: devChannel }, { question: 'x'.repeat(2001) }]) {
      const res = await test(omar, 'brain', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body as { error: { code: string } }).toMatchObject({ error: { code: 'validation_failed' } });
    }
    expect(await count('SELECT 1 FROM app.rehearsal_questions')).toBe(0);
  });

  it('a bot with no conversation trigger has nothing to test (409), and nothing is posted', async () => {
    const res = await test(omar, 'quiet', { question: 'Hello?' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body as { error: { code: string } }).toMatchObject({ error: { code: 'bot_has_no_conversation_trigger' } });
    expect(await count('SELECT 1 FROM app.rehearsal_questions WHERE bot_id = $1', [quiet])).toBe(0);
  });

  it('a bot allowed a shell in its own process is refused (409): a rehearsal cannot hold that back', async () => {
    const res = await test(omar, 'shelled', { question: 'Hello?' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect((res.body as { error: { message: string } }).error.message).toContain('shell');
    expect(await count('SELECT 1 FROM app.rehearsal_questions WHERE bot_id = $1', [shelled])).toBe(0);
    expect(await count("SELECT 1 FROM app.bot_runs WHERE bot_id = $1", [shelled])).toBe(0);
  });
});

describe('a test of a bot', () => {
  it('posts the question in the lead’s own conversation, files it, and runs the bot as a rehearsal for the person who asked', async () => {
    const res = await test(omar, 'brain', { question: '  What is blocking the release?  ' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const started = BotTestStarted.parse(res.body);
    startedId = started.messageId;
    startedChannel = started.channelId;
    expect(started.botName).toBe('Brain');

    const stored = await w.system(async (tx) => (await tx.query<{ channel_id: string; author_id: string; body: string; kind: string }>(
      'SELECT m.channel_id, m.author_id, m.body, c.kind FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1', [startedId])).rows[0]);
    expect(stored).toMatchObject({ channel_id: startedChannel, author_id: omar.actorId, body: 'What is blocking the release?', kind: 'bot_conversation' });
    // the question is in that one private channel and in no other
    expect(await count('SELECT 1 FROM app.messages WHERE body = $1 AND channel_id <> $2', ['What is blocking the release?', startedChannel])).toBe(0);
    expect(await count('SELECT 1 FROM app.messages WHERE channel_id = $1', [devChannel])).toBe(0);

    const run = await until(async () => (await runsOf(brain)).find((r) => r.reply_root_id === startedId && r.status !== 'running') ?? null, 60_000, 'the rehearsal run to end');
    expect(run).toMatchObject({ status: 'done', rehearsal: true, asker_id: omar.actorId });
    const reply = await until(async () => (await botReplies(omar, startedChannel, startedId))[0] ?? null, 20_000, 'the bot’s reply');
    expect(reply.body).toContain('Answering:');
    // the model was told this is a rehearsal and what it means
    expect(prompts().filter((p) => p.startsWith('REHEARSAL.'))).toHaveLength(1);
  });

  it('the result says the run answered, lists no held-back writes, and says there is no knowledge to answer from', async () => {
    const res = await result(omar, 'brain', startedId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = BotTestResult.parse(res.body);
    expect(body).toMatchObject({ messageId: startedId, channelId: startedChannel, status: 'answered', intercepted: [], interceptedMore: false, knowledge: 'none' });
  });

  it('the result is the asker’s alone, and a message that was never a test is not found', async () => {
    expect((await result(nadia, 'brain', startedId)).status).toBe(404);
    expect((await result(omar, 'quiet', startedId)).status).toBe(404);
    expect((await result(omar, 'brain', '00000000-0000-7000-8000-000000000999')).status).toBe(404);
  });

  it('the conversation goes on as an ordinary one: the next message is not a rehearsal and its prompt carries no note', async () => {
    const before = prompts().length;
    const sent = await w.call(omar, 'POST', `/api/channels/${startedChannel}/messages`, { channelId: startedChannel, body: 'And after that?', threadRootId: null });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const id = (sent.body as { id: string }).id;
    const run = await until(async () => (await runsOf(brain)).find((r) => r.reply_root_id === id && r.status !== 'running') ?? null, 60_000, 'the normal run to end');
    expect(run.rehearsal).toBe(false);
    const fresh = prompts().slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).not.toContain('REHEARSAL.');
  });

  it('a second test is refused while one is still running', async () => {
    // a rehearsal run left open for this person and bot (as a slow model would leave it)
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.bot_runs (workspace_id, team_id, bot_id, trigger_type, asker_id, status, rehearsal) SELECT b.workspace_id, b.team_id, b.id, 'conversation', $2, 'running', true FROM app.bots b WHERE b.id = $1`,
        [brain, omar.actorId],
      ),
    );
    const res = await test(omar, 'brain', { question: 'One more?' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    await w.system((tx) => tx.query("UPDATE app.bot_runs SET status = 'stopped', ended_at = now() WHERE bot_id = $1 AND status = 'running'", [brain]));
  });

  it('two presses at the same moment make one test: the question counts as running before the router has opened its run', async () => {
    // another lead (the route allows ten a minute per person, and the tests above have used most of Omar's)
    const setRole = (role: string) => w.system((tx) => tx.query("UPDATE app.team_members SET role = $2 WHERE actor_id = $1 AND team_id = (SELECT id FROM app.teams WHERE slug = 'engineering')", [nadia.actorId, role]));
    await setRole('lead');
    try {
      const both = await Promise.all([test(nadia, 'brain', { question: 'First at once?' }), test(nadia, 'brain', { question: 'Second at once?' })]);
      expect(both.map((r) => r.status).sort(), JSON.stringify(both.map((r) => r.body))).toEqual([201, 409]);
      const started = BotTestStarted.parse(both.find((r) => r.status === 201)!.body);
      expect(await count("SELECT 1 FROM app.rehearsal_questions q JOIN app.messages m ON m.id = q.message_id WHERE q.bot_id = $1 AND m.body LIKE '% at once?'", [brain])).toBe(1);
      // let that run end, so the world does not close on it half done
      await until(async () => (await runsOf(brain)).find((r) => r.reply_root_id === started.messageId && r.status !== 'running') ?? null, 60_000, 'the rehearsal run to end');
    } finally {
      await setRole('member');
    }
  });
});
