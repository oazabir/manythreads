import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';
import { CLASSIFIER_INSTRUCTION } from '../src/gate.ts';

// The run job end to end (PLAN P5-10): a person's mention goes through the outbox subscription, the router decides, the job
// opens a run and starts **one process per run**, the process's reply is posted through `messages.post` as the bot, and the
// run is closed. What stands in for Hermes is a script that behaves like `hermes chat --oneshot --format stream-json`: it
// reads the query on stdin and prints one JSON record per line. That is deliberate — the platform's half is what this file
// checks (the profile a run gets, the prompt on stdin, the argv, the run row, the reply, and the refusals), and none of it
// needs a model.
//
// The stand-in records everything it was handed in a spool file, because the profile directory is removed when the run ends
// (that removal is asserted too). The unit suites pin the profile's bytes; this one pins that those bytes reach a process.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 180_000 });

// The stand-in: `node <script> chat --query-file - ...`, one JSON line per event, the query on stdin.
const FAKE_HERMES = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "const soul = readFileSync(home + '/SOUL.md', 'utf8');",
  "const config = readFileSync(home + '/config.yaml', 'utf8');",
  "const url = /^\\s+url: (.*)$/m.exec(config)?.[1] ?? 'null';",
  "const bearer = /Authorization: (.*)$/m.exec(config)?.[1] ?? 'null';",
  "const record = { argv: process.argv.slice(2), homeName: home.slice(home.lastIndexOf('/') + 1), soul: soul.trim().split('\\n')[0], mcpUrl: JSON.parse(url), bearer: JSON.parse(bearer), prompt, canary: process.env.MANYTHREADS_TEST_CANARY ?? null, envNames: Object.keys(process.env).sort().join(',') };",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify(record) + '\\n');",
  "if (prompt.includes('FAIL-THE-RUN')) {",
  "  process.stdout.write(JSON.stringify({ type: 'text', text: 'half an answ' }) + '\\n');",
  "  process.stdout.write(JSON.stringify({ type: 'result', exit_code: 1, text: 'half an answ', error: 'model fell over' }) + '\\n');",
  '  process.exit(1);',
  '}',
  "const reply = 'Looking at the deploy: ' + prompt.replace(/\\s+/g, ' ');",
  "process.stdout.write(JSON.stringify({ type: 'text', text: 'Looking at the deploy: ' }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 11, output: 7, total: 18 } }) + '\\n');",
  '',
].join('\n');

/** One definition, with the pieces a test takes away named as parameters. */
const botMd = (parts: { name: string; model?: string; capabilities?: string; extra?: string[] }): string =>
  [
    '---',
    'schema: 1',
    `name: ${parts.name}`,
    'role: Answers a mention in the run test',
    'kind: agent',
    'runtime: hermes',
    ...(parts.model ? ['model:', `  aliases: [${parts.model}]`] : []),
    'triggers:',
    '  - type: mention',
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

/** Post a message as nadia in #dev and answer its id. */
async function post(body: string): Promise<string> {
  const res = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

/** The messages one bot wrote in the thread `rootId`, as nadia reads them back. */
const messagesBy = async (rootId: string, authorId: string): Promise<{ id: string; body: string }[]> => {
  const res = await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId);
};

/** The newest run of a bot, as the run table has it. */
const runOf = (
  botId: string,
): Promise<{ id: string; status: string; trigger_type: string; asker_id: string | null; thread_id: string | null } | undefined> =>
  w.system(async (tx) =>
    (
      await tx.query<{ id: string; status: string; trigger_type: string; asker_id: string | null; thread_id: string | null }>(
        `SELECT id, status, trigger_type, asker_id, thread_id FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
        [botId],
      )
    ).rows[0],
  );

/**
 * The stand-in's records for one run: one line per process, so its length is "how many processes this run started".
 * The profile home is the absolute directory the child got in `HERMES_HOME`; its name is the bot's slug and the run id.
 */
const callsOf = (slug: string, runId: string): Record<string, string>[] =>
  spoolLines().filter((line) => line['homeName'] === `${slug}-${runId}`);

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runtime-hermes-run-'));
  spool = join(scratch, 'spool.jsonl');
  profilesDir = join(scratch, 'profiles');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');

  // The provider reads these when the plugin registers, so they must be set before the server starts. `MANYTHREADS_HERMES_PREFIX`
  // is split on spaces, so the stand-in's path must not contain one (`mkdtemp` under the OS temp dir does not, in this setup).
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = profilesDir;
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  // A secret-looking variable in the server's environment: the child must not see it (MISTAKES: child process env inheritance).
  process.env['MANYTHREADS_TEST_CANARY'] = 'canary-secret-value';
  process.env['HERMES_FAKE_SPOOL'] = spool;

  w = await createRepoWorld();
  // The template channels appear when a member asks for the team's directory.
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`,
    );
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

describe('a hermes run, end to end', () => {
  it('a mention starts one process with the run profile, and its reply lands in the thread as the bot', async () => {
    const bot = await loadBot('hermes-test-bot', botMd({ name: 'HermesTestBot', model: 'smart', capabilities: 'messages.post' }));

    const rootId = await post('@hermes-test-bot what changed in the deploy?');
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the run to answer in the thread');

    // The reply is the stand-in's answer, and it repeated the prompt it was handed: who asked, where, and what was said.
    expect(reply.body).toBe('Looking at the deploy: Nadia in #dev: @hermes-test-bot what changed in the deploy?');

    // One run row, opened for the mention, closed done, in no thread (the message was not inside one).
    const run = await until(() => runOf(bot.botId), 15_000, 'the run row');
    expect(run).toMatchObject({ status: 'done', trigger_type: 'mention', asker_id: nadia.actorId, thread_id: null });

    // One process for one run: the argv the runtime builds, the definition's body as SOUL.md, and the run's own MCP
    // endpoint — and nothing else, because renderConfig writes nothing else.
    expect(callsOf('hermes-test-bot', run!.id)).toHaveLength(1);
    const call = callsOf('hermes-test-bot', run!.id)[0]!;
    expect(call['argv']).toEqual(['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json']);
    expect(call['soul']).toBe('# HermesTestBot');
    // The URL names the run and holds no credential; the run's token is the Authorization header of the same profile.
    expect(call['mcpUrl']).toBe(`http://localhost:3000/api/mcp/runs/${run!.id}`);
    expect(call['bearer']).toMatch(/^Bearer [A-Za-z0-9_-]{20,}$/);
    expect(call['mcpUrl']).not.toContain(String(call['bearer']).slice('Bearer '.length));
    // The child got an allowlisted environment: the server's canary secret is not in it, HERMES_HOME and the spool var are.
    expect(call['canary']).toBeNull();
    expect(call['envNames']).toContain('HERMES_HOME');
    expect(call['envNames']).not.toMatch(/MANYTHREADS_|DATABASE_URL|KMS/);
    expect(call['prompt']).toBe('Nadia in #dev:\n\n@hermes-test-bot what changed in the deploy?');

    // The profile is one per run and it does not outlive the run.
    expect(existsSync(join(profilesDir, `hermes-test-bot-${run!.id}`))).toBe(false);
  });

  it('a definition that never asked for messages.post runs, and its reply is refused', async () => {
    const bot = await loadBot('hermes-no-grant', botMd({ name: 'HermesNoGrant', model: 'smart' }));

    const rootId = await post('@hermes-no-grant what changed in the deploy?');
    const run = await until(async () => {
      const row = await runOf(bot.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the refused run row');

    // The process ran and answered; the platform refused the one call that would have made it visible, so the run failed
    // and the channel holds no message from the bot. This is the broker's allowlist doing its job at the runtime's door.
    expect(run.status).toBe('failed');
    expect(callsOf('hermes-no-grant', run.id)).toHaveLength(1);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
  });

  it('a definition that names no model fails the run and starts no process', async () => {
    const bot = await loadBot('hermes-no-model', botMd({ name: 'HermesNoModel', capabilities: 'messages.post' }));
    const before = spoolLines().length;

    const rootId = await post('@hermes-no-model are you there?');
    const run = await until(async () => {
      const row = await runOf(bot.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the failed run row');

    expect(run.status).toBe('failed');
    expect(spoolLines()).toHaveLength(before);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
  });
});

describe('a hermes run, the details', () => {
  it('an alias outside the gateway\'s closed set fails the run with that reason and starts no process', async () => {
    const bot = await loadBot('hermes-bad-alias', botMd({ name: 'HermesBadAlias', model: 'not-an-alias', capabilities: 'messages.post' }));
    const before = spoolLines().length;
    await post('@hermes-bad-alias hello');
    const run = await until(async () => {
      const row = await runOf(bot.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the failed run row');
    expect(run.status).toBe('failed');
    expect(spoolLines()).toHaveLength(before);
  });

  it('a failed run posts nothing: the half-answer a dying process printed is not a reply', async () => {
    const bot = await loadBot('hermes-fails', botMd({ name: 'HermesFails', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post('@hermes-fails FAIL-THE-RUN please');
    const run = await until(async () => {
      const row = await runOf(bot.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the failed run row');
    expect(run.status).toBe('failed');
    expect(callsOf('hermes-fails', run.id)).toHaveLength(1);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
  });

  it('the prompt that reaches the model is the gateway\'s redacted text, not the raw one', async () => {
    const bot = await loadBot('hermes-dlp', botMd({ name: 'HermesDlp', model: 'smart', capabilities: 'messages.post' }));
    const secret = `sk-proj-${'Ab3dEf6hIj'.repeat(8)}`; // a long project key: the hook must catch what a short pattern misses
    const rootId = await post(`@hermes-dlp please use ${secret} to deploy`);
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the run to answer').catch(async (err: unknown) => {
      throw new Error(`${String(err)} — run: ${JSON.stringify(await runOf(bot.botId))}`);
    });
    const run = (await runOf(bot.botId))!;
    const call = callsOf('hermes-dlp', run.id)[0]!;
    expect(call['prompt']).not.toContain('sk-proj-');
    expect(call['prompt']).toContain('[redacted:api-key]');
    expect(reply.body).not.toContain('sk-proj-');
  });

  it('a rules bot runs end to end: no model, no gateway, its declared step posts in the thread as the bot', async () => {
    const md = [
      '---',
      'schema: 1',
      'name: RulesCounter',
      'role: Answers with its declared steps',
      'kind: automation',
      'runtime: rules',
      'triggers:',
      '  - type: mention',
      'capabilities:',
      '  native: [messages.post]',
      '---',
      '',
      '# RulesCounter',
      '',
      'No prose is rendered for a rules bot.',
      '',
    ].join('\n');
    const bot = await loadBot('rules-counter', md);
    const before = spoolLines().length;

    const rootId = await post('@rules-counter go');
    const run = await until(async () => {
      const row = await runOf(bot.botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the rules run row');

    expect(run.status).toBe('done');
    // the step's argument is the trigger's message (the shape messages.post takes), posted as the bot
    const posted = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 15_000, 'the rule to post');
    expect(posted.body).toBe('Nadia in #dev:\n\n@rules-counter go');
    expect(spoolLines()).toHaveLength(before); // no Hermes process for a rules bot
  });
});

describe('a run that waits for a person (PLAN P5-20)', () => {
  interface ApprovalRow {
    id: string;
    source: string;
    tool: string;
    status: string;
    outcome: string;
    requester_id: string;
    channel_id: string | null;
    thread_root_id: string | null;
    args_preview: Record<string, unknown>;
    approver_scope: { roles: string[]; leads: boolean };
  }
  const approvalsOf = (botId: string): Promise<ApprovalRow[]> =>
    w.system(
      async (tx) =>
        (
          await tx.query<ApprovalRow>(
            `SELECT id, source, tool, status, outcome, requester_id, channel_id, thread_root_id, args_preview, approver_scope
               FROM app.approvals WHERE bot_id = $1 ORDER BY id`,
            [botId],
          )
        ).rows,
    );
  const finished = (botId: string) =>
    until(async () => {
      const row = await runOf(botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the run to end');
  const decide = (who: typeof rafi, id: string, verb: 'approve' | 'deny') =>
    w.call(who, 'POST', `/api/teams/engineering/approvals/${id}/${verb}`, { note: '' });

  it('a finding the bot asked to have held stops the run before the call, files an approval with only the redacted text, and approving sends the original once', async () => {
    const bot = await loadBot(
      'hermes-hold',
      botMd({
        name: 'HermesHold',
        model: 'smart',
        capabilities: 'messages.post',
        extra: ['guard:', '  rules: ["dlp:require_approval"]', 'approvals:', '  approvers: ["role:on-call"]'],
      }),
    );
    const before = spoolLines().length;
    const secret = `sk-proj-${'Ab3dEf6hIj'.repeat(8)}`;
    const rootId = await post(`@hermes-hold please use ${secret} to deploy`);

    // the run ended at the question: stopped, no process, no reply
    const held = await finished(bot.botId);
    expect(held.status).toBe('stopped');
    expect(spoolLines()).toHaveLength(before);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);

    const [approval] = await approvalsOf(bot.botId);
    expect(approval).toMatchObject({
      source: 'dlp',
      tool: 'llm.call',
      status: 'pending',
      requester_id: nadia.actorId,
      channel_id: channelId,
      thread_root_id: rootId,
    });
    expect(approval!.approver_scope).toEqual({ roles: ['role:on-call'], people: [], leads: false });
    // what an approver is shown is the rule that fired and the redacted message — the secret is nowhere a person can read it
    expect(approval!.args_preview['rules']).toEqual(['api-key']);
    expect(String(approval!.args_preview['message'])).toContain('[redacted:api-key]');
    expect(JSON.stringify(approval!.args_preview)).not.toContain('sk-proj-');

    // the person who asked cannot release their own message; the on-call person can
    expect((await decide(nadia, approval!.id, 'approve')).status).toBe(403);
    expect((await decide(rafi, approval!.id, 'approve')).status).toBe(200);

    // a new run goes to the model with the message as written, once; its reply lands in the same thread
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the approved run to answer');
    expect(reply.body).toContain(secret);
    const second = await until(async () => {
      const row = await runOf(bot.botId);
      return row && row.id !== held.id && row.status !== 'running' ? row : null;
    }, 30_000, 'the approved run to end');
    expect(second.status).toBe('done');
    expect(callsOf('hermes-hold', second.id)).toHaveLength(1);
    expect(callsOf('hermes-hold', second.id)[0]!['prompt']).toContain(secret);
    expect(spoolLines()).toHaveLength(before + 1);
    expect((await approvalsOf(bot.botId))[0]).toMatchObject({ status: 'approved', outcome: 'ran' });
    // taking it back is once: the held run never starts again
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(spoolLines()).toHaveLength(before + 1);
  });

  it('a denied hold ends it: nothing is sent', async () => {
    const bot = await loadBot(
      'hermes-hold-deny',
      botMd({ name: 'HermesHoldDeny', model: 'smart', capabilities: 'messages.post', extra: ['guard:', '  rules: ["dlp:require_approval"]'] }),
    );
    const before = spoolLines().length;
    const rootId = await post(`@hermes-hold-deny the password is hunter2 and the key is sk-proj-${'Qw3rTy6uIo'.repeat(8)}`);
    expect((await finished(bot.botId)).status).toBe('stopped');
    const [approval] = await approvalsOf(bot.botId);
    expect(approval!.approver_scope).toEqual({ roles: [], people: [], leads: true });
    expect((await decide(omar, approval!.id, 'deny')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(spoolLines()).toHaveLength(before);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
    expect((await approvalsOf(bot.botId))[0]).toMatchObject({ status: 'denied', outcome: 'none' });
  });

  it('a grant flagged needsApproval stops the run at that call; approving makes the call once, as the bot, in the thread', async () => {
    const md = [
      '---',
      'schema: 1',
      'name: RulesAsk',
      'role: Posts only when a person says so',
      'kind: automation',
      'runtime: rules',
      'triggers:',
      '  - type: mention',
      'capabilities:',
      '  native: [messages.post]',
      'approvals:',
      '  needsApproval: [messages.post]',
      '  approvers: ["role:on-call"]',
      '---',
      '',
      '# RulesAsk',
      '',
      'No prose is rendered for a rules bot.',
      '',
    ].join('\n');
    const bot = await loadBot('rules-ask', md);
    const rootId = await post('@rules-ask go');

    expect((await finished(bot.botId)).status).toBe('stopped');
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]); // the call was not made
    const [approval] = await approvalsOf(bot.botId);
    expect(approval).toMatchObject({ source: 'grant', tool: 'messages.post', status: 'pending', requester_id: nadia.actorId, thread_root_id: rootId });

    expect((await decide(nadia, approval!.id, 'approve')).status).toBe(403);
    expect((await decide(rafi, approval!.id, 'approve')).status).toBe(200);
    const posted = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the approved call to post');
    expect(posted.body).toBe('Nadia in #dev:\n\n@rules-ask go');
    await until(async () => ((await approvalsOf(bot.botId))[0]?.outcome === 'ran' ? true : null), 15_000, 'the approval to record that it ran');
    expect(await messagesBy(rootId, bot.actorId)).toHaveLength(1); // once
  });
  // The gate (PLAN P5-11): the bot's `guard.gate` list, then a classifier on the `local` alias, before any model call. The classifier here is the
  // fake LLM proxy answering what a test scripts, reached through the real gateway-llm plugin (pre-call check, ledger and all).
  describe('the gate (PLAN P5-11)', () => {
    let fake: FakeLlm;
    let classifierSays: (system: string, user: string) => string | { status: number; body: unknown } = () => 'NO';
    const classifierCalls = () => fake.state.calls.filter((call) => call.path === '/chat/completions');
    const sent = (call: { body: unknown }): { model: string; messages: { role: string; content: string }[] } =>
      call.body as { model: string; messages: { role: string; content: string }[] };
    const gateBot = (name: string, gate: string[]) =>
      botMd({
        name,
        model: 'smart',
        capabilities: 'messages.post',
        extra: ['guard:', `  gate: [${gate.map((g) => `'${g}'`).join(', ')}]`, 'approvals:', '  approvers: ["role:on-call"]'],
      });
    const gateEvents = (botId: string) =>
      w.system(
        async (tx) =>
          (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'runtime.gate.held' AND payload->>'botId' = $1 ORDER BY id`, [botId])).rows.map(
            (r) => r.payload,
          ),
      );
    const bindLocal = (): Promise<void> =>
      w.system(async (tx) => {
        const provider = (
          await tx.query<{ id: string }>(
            `INSERT INTO app.llm_providers (workspace_id, name, kind, api_base) VALUES ($1, 'gate-local', 'ollama', 'http://localhost:11434')
               ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET enabled = true RETURNING id`,
            [personas.omar.workspaceId],
          )
        ).rows[0]!;
        await tx.query(
          `INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model) VALUES ($1, 'local', $2, 'ollama/gate-test')
             ON CONFLICT (workspace_id, alias) DO UPDATE SET provider_id = EXCLUDED.provider_id`,
          [personas.omar.workspaceId, provider.id],
        );
      });
    const unbindLocal = (): Promise<void> =>
      w.system(async (tx) => {
        await tx.query(`DELETE FROM app.llm_aliases WHERE workspace_id = $1 AND alias = 'local'`, [personas.omar.workspaceId]);
      });

    beforeAll(async () => {
      fake = await startFakeLlm({
        completion: ({ messages }) => classifierSays(messages.find((m) => m.role === 'system')?.content ?? '', messages.find((m) => m.role === 'user')?.content ?? ''),
      });
      process.env['MANYTHREADS_LITELLM_URL'] = fake.url;
      await bindLocal();
    });
    afterAll(async () => {
      process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
      await fake?.close();
    });

    it('a phrase on the list holds the message before any model: no process, no classifier, a pending approval with the matching entry and the redacted text', async () => {
      const bot = await loadBot('gate-phrase', gateBot('GatePhrase', ['credential rotation', '/drop\\s+table/i']));
      const before = spoolLines().length;
      const calls = classifierCalls().length;
      const secret = `sk-proj-${'Zx3dEf6hIj'.repeat(8)}`;
      const rootId = await post(`@gate-phrase please start the Credential-Rotation, the old key is ${secret}`);

      expect((await finished(bot.botId)).status).toBe('stopped');
      expect(spoolLines()).toHaveLength(before); // Hermes never started: the model was not called
      expect(classifierCalls()).toHaveLength(calls); // stage one answered; the classifier was not asked
      expect(await messagesBy(rootId, bot.actorId)).toEqual([]);

      const [approval] = await approvalsOf(bot.botId);
      expect(approval).toMatchObject({ source: 'dlp', tool: 'llm.gate', status: 'pending', requester_id: nadia.actorId, thread_root_id: rootId });
      expect(approval!.approver_scope).toEqual({ roles: ['role:on-call'], people: [], leads: false });
      expect(approval!.args_preview).toMatchObject({ stage: 'exact', entry: 'credential rotation' });
      expect(String(approval!.args_preview['message'])).toContain('[redacted:api-key]');
      expect(JSON.stringify(approval!.args_preview)).not.toContain('sk-proj-');

      // the audit event names the stage and the entry, and carries no message text
      const [event] = await gateEvents(bot.botId);
      expect(event).toMatchObject({ stage: 'exact', entry: 'credential rotation', approvalId: approval!.id, botId: bot.botId });
      expect(JSON.stringify(event)).not.toContain('sk-proj-');

      // the asker cannot release it; the on-call person can, and the message then goes to the model once, past the gate
      expect((await decide(nadia, approval!.id, 'approve')).status).toBe(403);
      expect((await decide(rafi, approval!.id, 'approve')).status).toBe(200);
      const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the released run to answer');
      expect(reply.body).toContain('Credential-Rotation');
      expect(spoolLines()).toHaveLength(before + 1);
      expect(classifierCalls()).toHaveLength(calls); // the released run is not asked again
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(spoolLines()).toHaveLength(before + 1);
      expect((await gateEvents(bot.botId)).length).toBe(1);
    });

    it('a pattern on the list holds it too (stage regex), and a denied hold sends nothing', async () => {
      const bot = await loadBot('gate-regex', gateBot('GateRegex', ['/drop\\s+table\\b/i']));
      const before = spoolLines().length;
      const rootId = await post('@gate-regex please DROP   TABLE customers');
      expect((await finished(bot.botId)).status).toBe('stopped');
      const [approval] = await approvalsOf(bot.botId);
      expect(approval!.args_preview).toMatchObject({ stage: 'regex', entry: '/drop\\s+table\\b/i' });
      // a pattern-only list has no topic to give a classifier, so none was asked
      expect((await decide(rafi, approval!.id, 'deny')).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(spoolLines()).toHaveLength(before);
      expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
      expect((await approvalsOf(bot.botId))[0]).toMatchObject({ status: 'denied' });
    });

    it('the classifier sees only the message: one system instruction with the topics, the message as the user turn, nothing else; YES holds it', async () => {
      const bot = await loadBot('gate-ai', gateBot('GateAi', ['credential rotation', 'licence change']));
      const before = spoolLines().length;
      const calls = classifierCalls().length;
      classifierSays = () => 'YES.';
      const body = '@gate-ai could we roll the keys on the deploy account this week?';
      await post(body);

      expect((await finished(bot.botId)).status).toBe('stopped');
      expect(spoolLines()).toHaveLength(before);
      const made = classifierCalls().slice(calls);
      expect(made).toHaveLength(1);
      const request = sent(made[0]!);
      expect(request.model).toBe('local');
      expect(request.messages.map((m) => m.role)).toEqual(['system', 'user']); // no history, no tools, nothing else
      expect(request.messages[0]!.content).toBe(`${CLASSIFIER_INSTRUCTION}\n\nForbidden topics:\n- credential rotation\n- licence change`);
      expect(request.messages[1]!.content).toBe(body); // the message as written: not the author, the channel or the prompt wrapper
      const [approval] = await approvalsOf(bot.botId);
      expect(approval!.args_preview).toMatchObject({ stage: 'classifier' });
      expect(approval!.args_preview['entry']).toBeUndefined();
      // the platform's own call is on the ledger, attributed to the bot
      const ledger = await w.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.llm_spend WHERE bot_id = $1 AND alias = 'local'`, [bot.botId])).rows[0]!.n);
      expect(ledger).toBe(1);
    });

    it('a NO from the classifier lets the run go on to the model', async () => {
      const bot = await loadBot('gate-pass', gateBot('GatePass', ['credential rotation']));
      const before = spoolLines().length;
      const calls = classifierCalls().length;
      classifierSays = () => 'No';
      const rootId = await post('@gate-pass what changed in the deploy?');
      const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the run to answer');
      expect(reply.body).toContain('what changed in the deploy?');
      expect(classifierCalls().length).toBe(calls + 1);
      expect(spoolLines()).toHaveLength(before + 1);
      expect(await approvalsOf(bot.botId)).toEqual([]);
      expect(await gateEvents(bot.botId)).toEqual([]);
    });

    it('fails closed: a classifier that errors, an answer that is not a plain YES or NO, and a `local` alias nobody bound all hold the message', async () => {
      const bot = await loadBot('gate-closed', gateBot('GateClosed', ['credential rotation']));
      const before = spoolLines().length;
      const stages: unknown[] = [];

      classifierSays = () => ({ status: 500, body: { error: { message: 'model is loading' } } });
      await post('@gate-closed how is the weather?');
      await until(async () => ((await approvalsOf(bot.botId)).length === 1 ? true : null), 30_000, 'the first hold');

      classifierSays = () => 'I am not sure. It might be.';
      await post('@gate-closed and tomorrow?');
      await until(async () => ((await approvalsOf(bot.botId)).length === 2 ? true : null), 30_000, 'the second hold');

      await unbindLocal();
      try {
        classifierSays = () => 'NO';
        await post('@gate-closed and the day after?');
        await until(async () => ((await approvalsOf(bot.botId)).length === 3 ? true : null), 30_000, 'the third hold');
      } finally {
        await bindLocal();
      }

      for (const approval of await approvalsOf(bot.botId)) {
        expect(approval).toMatchObject({ source: 'dlp', tool: 'llm.gate', status: 'pending' });
        stages.push(approval.args_preview['stage']);
      }
      expect(stages).toEqual(['classifier_unavailable', 'classifier_unavailable', 'classifier_unavailable']);
      expect(spoolLines()).toHaveLength(before); // no model was called for any of them
      expect((await gateEvents(bot.botId)).map((e) => e['stage'])).toEqual(['classifier_unavailable', 'classifier_unavailable', 'classifier_unavailable']);
    });

    it('a bot with no gate list is never asked about: no classifier call, the run goes straight on', async () => {
      const bot = await loadBot('gate-none', botMd({ name: 'GateNone', model: 'smart', capabilities: 'messages.post' }));
      const calls = classifierCalls().length;
      const rootId = await post('@gate-none credential rotation, please');
      await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the run to answer');
      expect(classifierCalls().length).toBe(calls);
    });
  });
});
