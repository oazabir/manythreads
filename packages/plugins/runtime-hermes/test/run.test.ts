import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// The run job end to end (PLAN P5-10): a person's mention goes through the outbox subscription, the router decides, the job
// opens a run and starts **one process per run**, the process's reply is posted through `messages.post` as the bot, and the
// run is closed. What stands in for Hermes is a script that behaves like `hermes chat --oneshot --format stream-json`: it
// reads the query on stdin and prints one JSON record per line. That is deliberate — the platform's half is what this file
// checks (the profile a run gets, the prompt on stdin, the argv, the run row, the reply, and the refusals), and none of it
// needs a model.
//
// The stand-in records everything it was handed in a spool file, because the profile directory is removed when the run ends
// (that removal is asserted too). The unit suites pin the profile's bytes; this one pins that those bytes reach a process.

const { omar, nadia } = personas;
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
const botMd = (parts: { name: string; model?: string; capabilities?: string }): string =>
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
