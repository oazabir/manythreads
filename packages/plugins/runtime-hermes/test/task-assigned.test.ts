import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The `task_assigned` trigger end to end (PLAN P6-02, P6-03): a card handed to a bot whose BOT.md lists the trigger starts exactly one run
// of that bot, whose prompt carries the card and the note and whose reply lands in the card's thread. The stand-in for Hermes is a script
// that records the prompt it read on stdin; the platform's half (events, the outbox, the router, the job, the reply) is what runs.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

// The stand-in: `node <script> chat ...`, the query on stdin; it records what it was handed and answers with the prompt it read.
const FAKE_HERMES = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "const record = { homeName: home.slice(home.lastIndexOf('/') + 1), prompt };",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify(record) + '\\n');",
  "const reply = 'On it: ' + prompt.split('\\n')[0];",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

/** One definition, with the pieces a test takes away named as parameters. */
const botMd = (parts: { name: string; model?: string; capabilities?: string; triggers?: string[]; handover?: string[]; extra?: string[] }): string =>
  [
    '---',
    'schema: 1',
    `name: ${parts.name}`,
    'role: Answers a mention in the run test',
    'kind: agent',
    'runtime: hermes',
    ...(parts.model ? ['model:', `  aliases: [${parts.model}]`] : []),
    'triggers:',
    ...(parts.triggers ?? ['  - type: mention']),
    ...(parts.handover ? ['handover:', `  mayTag: [${parts.handover.join(', ')}]`] : []),
    ...(parts.capabilities ? ['capabilities:', `  native: [${parts.capabilities}]`] : []),
    ...(parts.extra ?? []),
    '---',
    '',
    `# ${parts.name}`,
    '',
    'Soul text of the run test. Everything below the fence is prose.',
    '',
  ].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
let profilesDir = '';
let channelId = '';
const savedEnv: Record<string, string | undefined> = {
  MANYTHREADS_HERMES_BIN: process.env['MANYTHREADS_HERMES_BIN'],
  MANYTHREADS_HERMES_PREFIX: process.env['MANYTHREADS_HERMES_PREFIX'],
  MANYTHREADS_RUNTIME_DIR: process.env['MANYTHREADS_RUNTIME_DIR'],
  MANYTHREADS_LITELLM_URL: process.env['MANYTHREADS_LITELLM_URL'],
  MANYTHREADS_TEST_CANARY: process.env['MANYTHREADS_TEST_CANARY'],
  HERMES_FAKE_SPOOL: process.env['HERMES_FAKE_SPOOL'],
};

/** Poll until `fn` answers something; the throw is the failure (the loader, the router or the job never got there). */
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const spoolLines = (): Record<string, string>[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, string>)
    : [];

interface LoadedBot {
  botId: string;
  actorId: string;
}

/** Commit a BOT.md and wait for the loader to put the bot on the roster, active, with its actor. */
async function loadBot(slug: string, md: string): Promise<LoadedBot> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);

  const row = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = $1 AND b.status = 'active'`,
          [slug],
        );
        return r.rows[0]?.id ?? null;
      }),
    15_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [row]);
        return r.rows[0]?.id ?? null;
      }),
    5_000,
    `the actor of ${slug}`,
  );
  return { botId: row, actorId };
}


/** The messages one bot wrote in the thread `rootId`, as nadia reads them back. */
const messagesBy = async (rootId: string, authorId: string, channel: string = channelId): Promise<{ id: string; body: string }[]> => {
  const res = await w.call(omar, 'GET', `/api/channels/${channel}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId);
};

/** Prove a negative by waiting: a sleep is a nap, so negatives below wait on the reply that proves the router decided. */
const quiet = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The newest run of a bot, as the run table has it. */
const runOf = (
  botId: string,
): Promise<{ id: string; status: string; trigger_type: string; asker_id: string | null; thread_id: string | null; delegation_depth: number } | undefined> =>
  w.system(async (tx) =>
    (
      await tx.query<{ id: string; status: string; trigger_type: string; asker_id: string | null; thread_id: string | null; delegation_depth: number }>(
        `SELECT id, status, trigger_type, asker_id, thread_id, delegation_depth FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
        [botId],
      )
    ).rows[0],
  );

/** Every run of a bot, oldest first. */
const runsOf = (
  botId: string,
): Promise<{ id: string; status: string; trigger_type: string; asker_id: string | null; delegation_depth: number }[]> =>
  w.system(async (tx) =>
    (
      await tx.query<{ id: string; status: string; trigger_type: string; asker_id: string | null; delegation_depth: number }>(
        `SELECT id, status, trigger_type, asker_id, delegation_depth FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at, id`,
        [botId],
      )
    ).rows,
  );

/** Whether the router queued a run for this bot on this message: the absence a negative asserts, with a positive control. */
const jobsFor = (botId: string, messageId: string): Promise<number> =>
  w.system(async (tx) =>
    (
      await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key = $1`,
        [`runtime-hermes:${botId}:${messageId}`],
      )
    ).rows[0]!.n,
  );

/**
 * The stand-in's records for one run: one line per process, so its length is "how many processes this run started".
 * The profile home is the absolute directory the child got in `HERMES_HOME`; its name is the bot's slug and the run id.
 */
const callsOf = (slug: string, runId: string): Record<string, string>[] =>
  spoolLines().filter((line) => line['homeName'] === `${slug}-${runId}`);


beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runtime-hermes-tasks-'));
  spool = join(scratch, 'spool.jsonl');
  profilesDir = join(scratch, 'profiles');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = profilesDir;
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;
  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => {
    const r = await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`);
    return r.rows[0]?.id ?? '';
  });
  expect(channelId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

const asBot = (bot: LoadedBot) => ({ kind: 'bot' as const, actorId: bot.actorId, workspaceId: personas.omar.workspaceId });
const TASKS = '/api/teams/engineering/tasks';

/** A card the bot creates and claims (it hands over only a card it owns), as the Orchestrator would. */
async function cardOwnedBy(bot: LoadedBot, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await w.call<{ task: { id: string } }>(asBot(bot), 'POST', TASKS, { title, kind: 'content', description: 'Describe the rota fix.', branch: 'fix/rota', ...extra });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.task.id;
  const claimed = await w.call(asBot(bot), 'POST', `${TASKS}/${id}/claim`);
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
  return id;
}

const handoff = (from: LoadedBot, taskId: string, to: string, note: string, strict = false, extra: Record<string, unknown> = {}) =>
  w.call<{ pendingApproval: boolean; approvalId: string | null; task: { threadRootId: string | null } }>(asBot(from), 'POST', `${TASKS}/${taskId}/handoff`, { toBotSlug: to, mode: 'bot', note, strict, ...extra });

/** The kinds of lines a card's history holds, oldest first. */
const historyOf = async (taskId: string): Promise<{ type: string; data: Record<string, unknown> }[]> =>
  ((await w.call<{ items: { type: string; data: Record<string, unknown> }[] }>(omar, 'GET', `${TASKS}/${taskId}/events`)).body.items);

/** Every message of a channel (top level and replies are listed separately by the API; the thread query reads a root's replies). */
const bodiesIn = async (channel: string, rootId: string | null): Promise<{ id: string; authorId: string; body: string }[]> => {
  const res = await w.call(omar, 'GET', `/api/channels/${channel}/messages?limit=100${rootId ? `&threadRootId=${rootId}` : ''}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items;
};

const threadRootOf = async (taskId: string): Promise<string> => {
  const res = await w.call<{ task: { threadRootId: string | null } }>(omar, 'GET', `${TASKS}/${taskId}`);
  return res.body.task.threadRootId ?? '';
};

/** The channel a card's thread lives in. */
const channelOfRoot = (rootId: string): Promise<string> =>
  w.system(async (tx) => (await tx.query<{ channel_id: string }>(`SELECT channel_id FROM app.messages WHERE id = $1`, [rootId])).rows[0]?.channel_id ?? '');

/** The card announcements and reply counts in a card's thread, with a positive control: nothing is proved by silence alone. */
const taskJobs = (botId: string): Promise<number> =>
  w.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1`, [`runtime-hermes:${botId}:task-%`])).rows[0]!.n);

const finished = (botId: string) =>
  until(async () => {
    const row = await runOf(botId);
    return row && row.status !== 'running' ? row : null;
  }, 30_000, 'the run to end');

describe('the task_assigned trigger', () => {
  it('a handover to a bot that lists the trigger starts one run: the card and the note on stdin, the reply in the card thread, no second run from the announcement', async () => {
    const orch = await loadBot('ta-orch', botMd({ name: 'TaOrch', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder'] }));
    // It lists `mention` too, so the @mention in the announcement WOULD wake it if the router did not skip that message.
    const coder = await loadBot('ta-coder', botMd({ name: 'TaCoder', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: mention', '  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Fix the rota');

    const moved = await handoff(orch, taskId, 'ta-coder', 'Please fix the rota page and run the tests');
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const run = await until(async () => {
      const row = await runOf(coder.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the coder run').catch(async (err: unknown) => {
      const dbg = await w.system(async (tx) => (await tx.query(`SELECT subscriber, attempts, done_at IS NOT NULL AS done, dead_at IS NOT NULL AS dead, last_error FROM app.outbox WHERE last_error IS NOT NULL OR dead_at IS NOT NULL`)).rows);
      throw new Error(`${String(err)} ${JSON.stringify(dbg)}`);
    });
    expect(run).toMatchObject({ status: 'done', trigger_type: 'task_assigned', asker_id: null, delegation_depth: 0 });

    // exactly one process, and what it read carries the card id, its facts and the note
    const calls = callsOf('ta-coder', run.id);
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!['prompt']!;
    expect(prompt.split('\n')[0]).toBe(`TaOrch handed you card ${taskId} in #general:`);
    expect(prompt).toContain('Please fix the rota page and run the tests');
    expect(prompt).toContain(`- id: ${taskId}`);
    expect(prompt).toContain('Title: Fix the rota');
    expect(prompt).toContain('- kind: content');
    expect(prompt).toContain('<<<BEGIN TEXT FROM TAORCH>>>');
    expect(prompt).toContain('- state: in_progress');
    expect(prompt).toContain('- branch: fix/rota');
    expect(prompt).toContain('Describe the rota fix.');

    // the card's thread: the announcement is the root (written by the sender), the coder's reply sits under it
    const rootId = await threadRootOf(taskId);
    expect(rootId).not.toBe('');
    const threadChannel = await channelOfRoot(rootId);
    const rootMessages = await w.call(omar, 'GET', `/api/channels/${threadChannel}/messages?limit=50`);
    const root = ListMessagesResponse.parse(rootMessages.body).items.find((m) => m.id === rootId);
    expect(root).toMatchObject({ authorId: orch.actorId, body: 'TaOrch → @ta-coder: Please fix the rota page and run the tests' });
    const reply = await until(async () => (await messagesBy(rootId, coder.actorId, await channelOfRoot(rootId)))[0], 30_000, 'the coder reply in the card thread');
    expect(reply.body).toContain(`TaOrch handed you card ${taskId}`);

    // the @mention in the announcement started nothing of its own: no mention job, one run, one process
    expect(await jobsFor(coder.botId, rootId)).toBe(0);
    expect(await taskJobs(coder.botId)).toBe(1);
    await quiet(3000);
    expect(await runsOf(coder.botId)).toHaveLength(1);
    expect(spoolLines().filter((l) => l['homeName']?.startsWith('ta-coder-'))).toHaveLength(1);
    // the orchestrator lists no task_assigned: handing the card away woke nobody else
    expect(await runsOf(orch.botId)).toEqual([]);
  });

  it('a bot whose definition has no task_assigned trigger is not woken (its mention trigger does not count)', async () => {
    const orch = await loadBot('ta-orch2', botMd({ name: 'TaOrch2', model: 'smart', capabilities: 'messages.post', handover: ['ta-plain'] }));
    const plain = await loadBot('ta-plain', botMd({ name: 'TaPlain', model: 'smart', capabilities: 'messages.post' }));
    const taskId = await cardOwnedBy(orch, 'Plain card');
    expect((await handoff(orch, taskId, 'ta-plain', 'for you')).status).toBe(200);
    // the card thread exists (the announcement was posted); nothing woke the bot, even though the announcement names it
    expect(await threadRootOf(taskId)).not.toBe('');
    await quiet(4000);
    expect(await taskJobs(plain.botId)).toBe(0);
    expect(await runsOf(plain.botId)).toEqual([]);
  });

  it('a strict handover wakes the new owner only after the approval applies it', async () => {
    const orch = await loadBot('ta-orch3', botMd({ name: 'TaOrch3', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder3'] }));
    const coder = await loadBot('ta-coder3', botMd({ name: 'TaCoder3', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Strict card');

    const pending = await handoff(orch, taskId, 'ta-coder3', 'after sign-off', true);
    expect(pending.status, JSON.stringify(pending.body)).toBe(202);
    await quiet(4000);
    expect(await taskJobs(coder.botId)).toBe(0);
    expect(await runsOf(coder.botId)).toEqual([]);

    const approved = await w.call(omar, 'POST', `/api/teams/engineering/approvals/${pending.body.approvalId}/approve`, { note: 'go' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const run = await until(async () => {
      const row = await runOf(coder.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the coder run after approval');
    expect(run).toMatchObject({ status: 'done', trigger_type: 'task_assigned' });
    expect(callsOf('ta-coder3', run.id)[0]!['prompt']).toContain(`TaOrch3 handed you card ${taskId}`);
    // the thread was opened when the handover was filed; the reply is in it
    const rootId = await threadRootOf(taskId);
    expect(await until(async () => (await messagesBy(rootId, coder.actorId, await channelOfRoot(rootId)))[0], 30_000, 'the reply')).toBeTruthy();
    await quiet(3000);
    expect(await runsOf(coder.botId)).toHaveLength(1);
  });

  it('a card the Orchestrator created reaches done: its creator is woken when it lists the trigger, once, and never by its own completion', async () => {
    const orch = await loadBot('ta-orch4', botMd({ name: 'TaOrch4', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder4'], triggers: ['  - type: task_assigned'] }));
    const coder = await loadBot('ta-coder4', botMd({ name: 'TaCoder4', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Creator card');
    expect((await handoff(orch, taskId, 'ta-coder4', 'build it')).status).toBe(200);
    await finished(coder.botId);
    expect(await runsOf(orch.botId)).toEqual([]);

    const done = await w.call(asBot(coder), 'POST', `${TASKS}/${taskId}/complete`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const run = await finished(orch.botId);
    expect(run).toMatchObject({ status: 'done', trigger_type: 'task_assigned' });
    expect(callsOf('ta-orch4', run.id)[0]!['prompt']!.split('\n')[0]).toBe(`TaCoder4 finished card ${taskId} in #general, which you created:`);
    await quiet(3000);
    expect(await runsOf(orch.botId)).toHaveLength(1);
    expect(await runsOf(coder.botId)).toHaveLength(1);
  });

  it('five cards finished together wake their creator three times and say why for the other two; no run counts as a mention hop', async () => {
    const orch = await loadBot('ta-orch9', botMd({ name: 'TaOrch9', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder9'], triggers: ['  - type: task_assigned'] }));
    const coder = await loadBot('ta-coder9', botMd({ name: 'TaCoder9', model: 'smart', capabilities: 'messages.post' }));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await cardOwnedBy(orch, `Burst card ${i}`);
      expect((await handoff(orch, id, 'ta-coder9', 'go')).status).toBe(200);
      ids.push(id);
    }
    const done = await Promise.all(ids.map((id) => w.call(asBot(coder), 'POST', `${TASKS}/${id}/complete`, {})));
    for (const d of done) expect(d.status, JSON.stringify(d.body)).toBe(200);
    const limited = await until(async () => {
      let n = 0;
      for (const id of ids) n += (await historyOf(id)).filter((e) => e.type === 'not_woken' && e.data['reason'] === 'wake_limit').length;
      return n >= 2 ? n : null;
    }, 30_000, 'the wake_limit lines');
    expect(limited).toBe(2);
    await quiet(3000);
    const runs = await runsOf(orch.botId);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.trigger_type === 'task_assigned' && r.delegation_depth === 0)).toBe(true);
  });

  it('a claim by the bot itself never wakes it, and a handover to oneself is refused', async () => {
    const solo = await loadBot('ta-solo', botMd({ name: 'TaSolo', model: 'smart', capabilities: 'messages.post', handover: ['ta-solo'], triggers: ['  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(solo, 'Solo card');
    const self = await handoff(solo, taskId, 'ta-solo', 'to myself');
    expect(self.status).toBe(409);
    await quiet(3000);
    expect(await runsOf(solo.botId)).toEqual([]);
    expect(await taskJobs(solo.botId)).toBe(0);
  });
});

describe('where the card is announced, and what is on the record when nobody can be woken', () => {
  it('a handover asked for inside a thread is announced in that thread, and the new owner answers there', async () => {
    const orch = await loadBot('ta-orch5', botMd({ name: 'TaOrch5', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder5'] }));
    const coder = await loadBot('ta-coder5', botMd({ name: 'TaCoder5', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Thread card');
    const kickoff = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'kickoff for the thread card', threadRootId: null });
    expect(kickoff.status).toBe(201);
    const rootId = kickoff.body.id;

    const moved = await handoff(orch, taskId, 'ta-coder5', 'in the thread please', false, { channelId, threadRootId: rootId });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await threadRootOf(taskId)).toBe(rootId);
    const card = (await bodiesIn(channelId, rootId)).find((m) => m.authorId === orch.actorId);
    expect(card?.body).toBe('TaOrch5 → @ta-coder5: in the thread please');
    const reply = await until(async () => (await messagesBy(rootId, coder.actorId, channelId))[0], 30_000, 'the reply in the origin thread');
    expect(reply.body).toContain(`TaOrch5 handed you card ${taskId} in #dev`);
    expect(await runsOf(coder.botId)).toHaveLength(1);
    // and nothing was posted at the top of any other channel for this card
    expect(await channelOfRoot(rootId)).toBe(channelId);
  });

  it('an orchestrator message that names the new owner in the card thread wakes it again once its handover run has ended (it owns the card but is idle)', async () => {
    const orch = await loadBot('ta-orch10', botMd({ name: 'TaOrch10', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder10'] }));
    const coder = await loadBot('ta-coder10', botMd({ name: 'TaCoder10', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: mention', '  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Dup card');
    const kickoff = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'kickoff for the dup card', threadRootId: null });
    const rootId = kickoff.body.id;
    expect((await handoff(orch, taskId, 'ta-coder10', 'go', false, { channelId, threadRootId: rootId })).status).toBe(200);
    await until(async () => (await messagesBy(rootId, coder.actorId, channelId))[0], 30_000, 'the handover run to reply');
    await finished(coder.botId);

    // the orchestrator's prose in the same thread names the coder, who still owns the card but is idle: the mention is the only thing that wakes it
    // (while its handover run is still going the mention starts nothing: the delegation test in run.test.ts)
    const prose = await w.call(asBot(orch), 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'Tester next: @ta-coder10 please check it', threadRootId: rootId });
    expect(prose.status, JSON.stringify(prose.body)).toBe(201);
    await until(async () => ((await runsOf(coder.botId)).length >= 2 ? true : null), 30_000, 'the idle owner to be woken');
  });

  describe('a prose @mention of a bot by another bot', () => {
    const setup = async (n: string) => {
      const orch = await loadBot(`ta-orch${n}`, botMd({ name: `TaOrch${n}`, model: 'smart', capabilities: 'messages.post', handover: [`ta-coder${n}`] }));
      const coder = await loadBot(`ta-coder${n}`, botMd({ name: `TaCoder${n}`, model: 'smart', capabilities: 'messages.post', triggers: ['  - type: mention', '  - type: task_assigned'] }));
      const kick = async (text: string): Promise<string> => (await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: text, threadRootId: null })).body.id;
      const prose = async (rootId: string, slug: string): Promise<void> => {
        const res = await w.call(asBot(orch), 'POST', `/api/channels/${channelId}/messages`, { channelId, body: `Also, @${slug} please look`, threadRootId: rootId });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      };
      return { orch, coder, kick, prose };
    };
    const runCount = async (botId: string, n: number): Promise<void> => {
      await until(async () => ((await runsOf(botId)).length >= n ? true : null), 30_000, `${n} runs`);
    };

    it('a queued run in the thread and no card: the mention still gets its own run (it may carry a new instruction)', async () => {
      const { coder, kick, prose } = await setup('11');
      const rootId = await kick('thread without a card');
      await prose(rootId, 'ta-coder11');
      await prose(rootId, 'ta-coder11');
      await runCount(coder.botId, 2);
    });

    it('a card the bot already finished does not block the mention', async () => {
      const { orch, coder, kick, prose } = await setup('12');
      const taskId = await cardOwnedBy(orch, 'Done card');
      const rootId = await kick('thread of a done card');
      expect((await handoff(orch, taskId, 'ta-coder12', 'go', false, { channelId, threadRootId: rootId })).status).toBe(200);
      await finished(coder.botId);
      expect((await w.call(asBot(coder), 'POST', `${TASKS}/${taskId}/complete`, {})).status).toBe(200);
      await prose(rootId, 'ta-coder12');
      await runCount(coder.botId, 2);
    });

    it('a card the bot owns in another thread does not block the mention here', async () => {
      const { orch, coder, kick, prose } = await setup('13');
      const taskId = await cardOwnedBy(orch, 'Other-thread card');
      const cardRoot = await kick('the card thread');
      expect((await handoff(orch, taskId, 'ta-coder13', 'go', false, { channelId, threadRootId: cardRoot })).status).toBe(200);
      await finished(coder.botId);
      const otherRoot = await kick('another thread');
      await prose(otherRoot, 'ta-coder13');
      await runCount(coder.botId, 2);
    });
  });

  it('a handover asked for in a private channel puts nothing of it in a public one: a short card with no note, and the note reaches only the new owner', async () => {
    const orch = await loadBot('ta-orch6', botMd({ name: 'TaOrch6', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder6'] }));
    const coder = await loadBot('ta-coder6', botMd({ name: 'TaCoder6', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: task_assigned'] }));
    const created = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'ta-private', private: true });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const privateId = created.body.channel.id;
    const secretRoot = await w.call<{ id: string }>(omar, 'POST', `/api/channels/${privateId}/messages`, { channelId: privateId, body: 'private planning', threadRootId: null });
    expect(secretRoot.status).toBe(201);
    const taskId = await cardOwnedBy(orch, 'Private card');

    // a lead (a person) hands the bot's card over from inside the private thread
    const moved = await w.call(omar, 'POST', `${TASKS}/${taskId}/handoff`, { toBotSlug: 'ta-coder6', mode: 'bot', note: 'SECRET-NOTE-9431', channelId: privateId, threadRootId: secretRoot.body.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const rootId = await threadRootOf(taskId);
    const home = await channelOfRoot(rootId);
    expect(home).not.toBe(privateId);
    const publicRoot = (await bodiesIn(home, null)).find((m) => m.id === rootId);
    expect(publicRoot?.body).toMatch(/^.+ handed “Private card” to @ta-coder6$/);
    // no public message anywhere carries the note
    for (const id of [channelId, home]) {
      expect((await bodiesIn(id, null)).filter((m) => m.body.includes('SECRET-NOTE-9431'))).toEqual([]);
    }
    expect((await bodiesIn(privateId, null)).map((m) => m.body)).toEqual(['private planning']);
    // the new owner, a bot of the team, is woken in the public thread and was handed the note in its prompt
    const run = await until(async () => {
      const row = await runOf(coder.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the coder run');
    expect(callsOf('ta-coder6', run.id)[0]!['prompt']).toContain('SECRET-NOTE-9431');
    expect(run).toMatchObject({ trigger_type: 'task_assigned', asker_id: omar.actorId });
  });

  it('a delivery of the same assignment event again, after its run finished, starts nothing', async () => {
    const orch = await loadBot('ta-orch7', botMd({ name: 'TaOrch7', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder7'] }));
    const coder = await loadBot('ta-coder7', botMd({ name: 'TaCoder7', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Twice card');
    const moved = await handoff(orch, taskId, 'ta-coder7', 'once only');
    expect(moved.status).toBe(200);
    await finished(coder.botId);
    // put the delivered outbox rows of that event back, as a crash between "handled" and "marked done" would
    const again = await w.system(async (tx) =>
      (
        await tx.query(
          `UPDATE app.outbox o SET done_at = NULL, available_at = now(), attempts = 0
             FROM app.events e
            WHERE o.event_id = e.id AND e.type = 'tasks.task.handed_off' AND e.payload ->> 'taskId' = $1`,
          [taskId],
        )
      ).rowCount,
    );
    expect(again).toBeGreaterThan(0);
    await quiet(5000);
    expect(await runsOf(coder.botId)).toHaveLength(1);
    expect(spoolLines().filter((l) => l['homeName']?.startsWith('ta-coder7-'))).toHaveLength(1);
  });

  it('a team with no public channel: the handover stands, and the card history says the owner was not woken (and why)', async () => {
    const orch = await loadBot('ta-orch8', botMd({ name: 'TaOrch8', model: 'smart', capabilities: 'messages.post', handover: ['ta-coder8'] }));
    const coder = await loadBot('ta-coder8', botMd({ name: 'TaCoder8', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: task_assigned'] }));
    const taskId = await cardOwnedBy(orch, 'Nowhere card');
    await w.system((tx) => tx.query(`UPDATE app.channels SET archived_at = now() WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND kind = 'channel'`));
    const moved = await handoff(orch, taskId, 'ta-coder8', 'nowhere to say it');
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const reasons = await until(async () => {
      const lines = (await historyOf(taskId)).filter((e) => e.type === 'not_woken').map((e) => e.data['reason']);
      return lines.length >= 2 ? lines : null;
    }, 30_000, 'the not_woken lines');
    expect(reasons).toEqual(expect.arrayContaining(['no_channel', 'no_thread']));
    expect(await runsOf(coder.botId)).toEqual([]);
    expect((await historyOf(taskId)).map((e) => e.type)).toContain('handed_off');
  });
});

