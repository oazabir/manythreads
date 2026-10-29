import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeLlm, type FakeLlm } from '../../../../tools/fake-llm/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';
import { FAILURE_NOTICE } from '../src/failure-notice.ts';
import { CLASSIFIER_INSTRUCTION, wrapMessage } from '../src/gate.ts';

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
  "const chain = prompt.match(/chain ([a-z0-9._-]+( +[a-z0-9._-]+)*)/i);",
  "if (chain) {",
  "  const parts = chain[1].split(/ +/);",
  "  const target = parts[0];",
  "  const rest = parts.slice(1);",
  "  const handoff = rest.length > 0 ? '@' + target + ' please continue chain ' + rest.join(' ') : '@' + target + ' please continue';",
  "  process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: handoff, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  "  process.exit(0);",
  "}",
  "if (prompt.includes('TOOL-POST')) {",
  "  const origin = /origin=(\\S+)/.exec(prompt)?.[1] ?? '';",
  "  const args = { body: 'Full answer posted by the tool' };",
  "  const channel = /channel=([0-9a-f-]{36})/.exec(prompt)?.[1];",
  "  const thread = /thread=([0-9a-f-]{36})/.exec(prompt)?.[1];",
  "  if (prompt.includes('with-channel') || channel) args.channelId = channel ?? /channelid=([0-9a-f-]{36})/.exec(prompt)?.[1];",
  "  if (thread) args.threadRootId = thread;",
  "  const res = await fetch(origin + new URL(JSON.parse(url)).pathname, { method: 'POST', headers: { 'content-type': 'application/json', authorization: JSON.parse(bearer) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'messages.post', arguments: args } }) });",
  "  const answer = await res.text();",
  "  if (prompt.includes('THEN-TIME-OUT')) {",
  "    process.stdout.write(JSON.stringify({ type: 'result', exit_code: 1, text: '', error: 'the run was stopped (SIGTERM)' }) + '\\n');",
  "    process.exit(1);",
  "  }",
  "  process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: 'Done - the final text, ' + (res.ok ? 'tool ok' : 'tool failed ' + answer), tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  "  process.exit(0);",
  "}",
  "if (prompt.includes('FAIL-GATEWAY')) {",
  "  process.stdout.write(JSON.stringify({ type: 'result', exit_code: 1, text: '', error: 'Error code: 401 - Invalid proxy server token passed. key sk-AbCdEf12 hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 at http://litellm.internal:4000/v1' }) + '\\n');",
  '  process.exit(1);',
  '}',
  "if (prompt.includes('SLEEP-FOREVER')) {",
  '  setInterval(() => undefined, 1000);',
  '  await new Promise(() => undefined);',
  '}',
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

/** Post a message as nadia in #dev and answer its id. */
async function post(body: string, channel: string = channelId): Promise<string> {
  const res = await w.call(nadia, 'POST', `/api/channels/${channel}/messages`, { channelId: channel, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

/** The messages one bot wrote in the thread `rootId`, as nadia reads them back. */
const messagesBy = async (rootId: string, authorId: string, channel: string = channelId): Promise<{ id: string; body: string }[]> => {
  const res = await w.call(nadia, 'GET', `/api/channels/${channel}/messages?threadRootId=${rootId}&limit=50`);
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
    // (the row exists as soon as the run opens: wait for it to close, or the status read below is the one of a run still going)
    const run = await until(
      async () => {
        const row = await runOf(bot.botId);
        return row && row.status !== 'running' ? row : null;
      },
      15_000,
      'the run to close',
    );
    expect(run).toMatchObject({ status: 'done', trigger_type: 'mention', asker_id: nadia.actorId, thread_id: null });

    // One process for one run: the argv the runtime builds, the definition's body as SOUL.md, and the run's own MCP
    // endpoint — and nothing else, because renderConfig writes nothing else.
    expect(callsOf('hermes-test-bot', run!.id)).toHaveLength(1);
    const call = callsOf('hermes-test-bot', run!.id)[0]!;
    expect(call['argv']).toEqual(['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json']);
    expect(call['soul']).toBe('# HermesTestBot');
    // The URL names the run and holds no credential; the run's token is the Authorization header of the same profile.
    expect(call['mcpUrl']).toBe(`http://localhost:3000/mcp`);
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

  it('a reply sent "also to the channel" wakes the bot it names once: the copy in the channel starts no second run', async () => {
    const bot = await loadBot('also-copy-bot', botMd({ name: 'AlsoCopyBot', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post('a thread about the deploy');
    const replied = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, {
      channelId,
      body: '@also-copy-bot please summarise this',
      threadRootId: rootId,
      alsoToChannel: true,
    });
    expect(replied.status, JSON.stringify(replied.body)).toBe(201);
    const replyId = (replied.body as { id: string }).id;
    // the reply in the thread wakes the bot (the positive control: the router has decided about this message and its copy)
    await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the bot to answer in the thread');
    expect(await jobsFor(bot.botId, replyId)).toBe(1);
    const copy = ListMessagesResponse.parse((await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?limit=20`)).body).items.find(
      (m) => m.alsoSentFromThread === rootId,
    );
    expect(copy?.body).toBe('@also-copy-bot please summarise this');
    await quiet(3000);
    expect(await jobsFor(bot.botId, copy!.id)).toBe(0);
    expect((await runsOf(bot.botId)).length).toBe(1);
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
    // it was granted messages.post, so the asker is told (a reason category only)
    expect((await messagesBy(rootId, bot.actorId)).map((m) => m.body)).toEqual([FAILURE_NOTICE.other]);
  });
});

describe('a run that posts with messages.post lands in its own thread and is not answered twice', () => {
  const botFor = (slug: string): Promise<LoadedBot> => loadBot(slug, botMd({ name: slug, model: 'smart', capabilities: 'messages.post' }));
  const ask = (slug: string, extra: string, channel: string = channelId): Promise<string> => post(`@${slug} TOOL-POST origin=${w.server.url} ${extra}`, channel);
  const settled = (botId: string) =>
    until(async () => {
      const row = await runOf(botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the run to close');
  /** Every top-level and threaded message of one bot in the channel, newest last. */
  const inChannel = async (authorId: string, channel: string = channelId): Promise<{ body: string; threadRootId: string | null }[]> => {
    const res = await w.call(nadia, 'GET', `/api/channels/${channel}/messages?limit=100`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId).map((m) => ({ body: m.body, threadRootId: m.threadRootId }));
  };

  it('a post with no thread goes into the thread the run was asked in, and the final text is not posted as well', async () => {
    const bot = await botFor('tool-thread-bot');
    const rootId = await ask('tool-thread-bot', `channel=${channelId}`);
    await settled(bot.botId);
    const said = await messagesBy(rootId, bot.actorId);
    expect(said.map((m) => m.body)).toEqual(['Full answer posted by the tool']);
    // nothing from this bot at the top level of the channel
    expect((await inChannel(bot.actorId)).filter((m) => m.threadRootId === null)).toEqual([]);
  });

  it('a post that leaves out the channel as well is the same', async () => {
    const bot = await botFor('tool-nochannel-bot');
    const rootId = await ask('tool-nochannel-bot', '');
    await settled(bot.botId);
    expect((await messagesBy(rootId, bot.actorId)).map((m) => m.body)).toEqual(['Full answer posted by the tool']);
  });

  it('an explicit thread wins over the run\'s own for the tool post, and the asker\'s thread still gets the final text', async () => {
    const bot = await botFor('tool-explicit-bot');
    const other = await post('another thread, started by a person');
    const rootId = await ask('tool-explicit-bot', `channel=${channelId} thread=${other}`);
    await settled(bot.botId);
    expect((await messagesBy(other, bot.actorId)).map((m) => m.body)).toEqual(['Full answer posted by the tool']);
    // the run posted into another thread, so the asker's own thread is still unanswered: the final text goes there
    expect((await messagesBy(rootId, bot.actorId)).map((m) => m.body)).toEqual(['Done - the final text, tool ok']);
  });

  it('a post into another channel is left where it was put, and the final text still answers in the thread', async () => {
    const bot = await botFor('tool-elsewhere-bot');
    const otherChannel = await w.system(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id
          WHERE t.slug = 'engineering' AND c.kind = 'channel' AND NOT c.private AND c.id <> $1 AND c.archived_at IS NULL ORDER BY c.name LIMIT 1`,
        [channelId],
      );
      return r.rows[0]?.id ?? '';
    });
    expect(otherChannel).not.toBe('');
    const rootId = await ask('tool-elsewhere-bot', `channel=${otherChannel}`);
    await settled(bot.botId);
    expect((await inChannel(bot.actorId, otherChannel)).map((m) => [m.body, m.threadRootId])).toEqual([['Full answer posted by the tool', null]]);
    expect((await messagesBy(rootId, bot.actorId)).map((m) => m.body)).toEqual(['Done - the final text, tool ok']);
  });

  it('a run that posts nothing has its final text posted, as before', async () => {
    const bot = await botFor('tool-silent-bot');
    const rootId = await post('@tool-silent-bot what changed?');
    await settled(bot.botId);
    expect((await messagesBy(rootId, bot.actorId)).map((m) => m.body)).toEqual(['Looking at the deploy: Nadia in #dev: @tool-silent-bot what changed?']);
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
    // no half answer: the one message is the notice, and it carries none of the error text
    const said = await messagesBy(rootId, bot.actorId);
    expect(said.map((m) => m.body)).toEqual([FAILURE_NOTICE.other]);
    expect(said[0]!.body).not.toMatch(/half an answ|fell over/);
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

describe('a run that ends without an answer tells the asker why (a category, never the error)', () => {
  const finishedRun = (botId: string) =>
    until(async () => {
      const row = await runOf(botId);
      return row && row.status !== 'running' ? row : null;
    }, 60_000, 'the run to end');
  /** The meta of every message the bot wrote in the thread: where the run id and the category are kept. */
  const metaOf = (botActorId: string, rootId: string): Promise<Record<string, unknown>[]> =>
    w.system(async (tx) =>
      (await tx.query<{ meta: Record<string, unknown> }>(`SELECT meta FROM app.messages WHERE author_id = $1 AND thread_root_id = $2 ORDER BY id`, [botActorId, rootId])).rows.map((r) => r.meta),
    );

  it('a refused model call says the gateway refused it, hides the key, hash and address, names the run only in meta, and asks the gateway to re-check the key', async () => {
    const bot = await loadBot('notice-gateway', botMd({ name: 'NoticeGateway', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post('@notice-gateway FAIL-GATEWAY please');
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('failed');
    const said = await until(async () => {
      const rows = await messagesBy(rootId, bot.actorId);
      return rows.length > 0 ? rows : null;
    }, 30_000, 'the notice');
    expect(said.map((m) => m.body)).toEqual([FAILURE_NOTICE.gateway]);
    expect(said[0]!.body).not.toMatch(/sk-|9f86d0|litellm|401|token|http/i);
    expect(said[0]!.body).not.toContain(run.id);
    expect(await metaOf(bot.actorId, rootId)).toEqual([{ runId: run.id, runFailure: 'gateway' }]);
    // the proxy refusing the key queues a check of that key at the gateway, for this bot
    const queued = await w.system(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'gateway-llm.sync-key' AND dedupe_key = $1`, [`recheck:${bot.botId}`])).rows[0]!.n,
    );
    expect(queued).toBe(1);
  });

  it('a run that ran out of time says so', async () => {
    const bot = await loadBot('notice-timeout', botMd({ name: 'NoticeTimeout', model: 'smart', capabilities: 'messages.post', extra: ['limits:', '  timeoutSeconds: 1'] }));
    const rootId = await post('@notice-timeout SLEEP-FOREVER');
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('failed');
    const said = await until(async () => {
      const rows = await messagesBy(rootId, bot.actorId);
      return rows.length > 0 ? rows : null;
    }, 30_000, 'the notice');
    expect(said.map((m) => m.body)).toEqual([FAILURE_NOTICE.timeout]);
    expect(await metaOf(bot.actorId, rootId)).toEqual([{ runId: run.id, runFailure: 'timeout' }]);
  });

  it('a run that posted its answer and was then stopped adds no failure notice under it', async () => {
    const bot = await loadBot('notice-posted', botMd({ name: 'NoticePosted', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post(`@notice-posted TOOL-POST THEN-TIME-OUT origin=${w.server.url}`);
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('failed');
    await until(async () => (await messagesBy(rootId, bot.actorId)).length > 0, 30_000, 'the posted answer');
    await quiet(1000);
    const said = await messagesBy(rootId, bot.actorId);
    expect(said.map((m) => m.body)).toEqual(['Full answer posted by the tool']);
    expect(await metaOf(bot.actorId, rootId)).toEqual([{ runId: run.id }]);
  });

  it('a bot placed on a runner that is not there says the runner is offline', async () => {
    const bot = await loadBot('notice-runner', botMd({ name: 'NoticeRunner', model: 'smart', capabilities: 'messages.post', extra: ['placement:', '  runner: nowhere'] }));
    const rootId = await post('@notice-runner hello');
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('failed');
    const said = await until(async () => {
      const rows = await messagesBy(rootId, bot.actorId);
      return rows.length > 0 ? rows : null;
    }, 30_000, 'the notice');
    expect(said.map((m) => m.body)).toEqual([FAILURE_NOTICE.runner_offline]);
    expect(await metaOf(bot.actorId, rootId)).toEqual([{ runId: run.id, runFailure: 'runner_offline' }]);
  });

  it('a call a budget stops before it is sent says a limit stopped it', async () => {
    const bot = await loadBot('notice-limit', botMd({ name: 'NoticeLimit', model: 'smart', capabilities: 'messages.post' }));
    await w.system(async (tx) => {
      await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'bot', $2, 0)`, [personas.omar.workspaceId, bot.botId]);
    });
    const before = spoolLines().length;
    const rootId = await post('@notice-limit what changed?');
    expect((await finishedRun(bot.botId)).status).toBe('stopped');
    const said = await until(async () => {
      const rows = await messagesBy(rootId, bot.actorId);
      return rows.length > 0 ? rows : null;
    }, 30_000, 'the notice');
    expect(said.map((m) => m.body)).toEqual([FAILURE_NOTICE.limit]);
    expect(spoolLines()).toHaveLength(before);
  });

  it('a bot never granted messages.post stays silent, failed run or not', async () => {
    const bot = await loadBot('notice-silent', botMd({ name: 'NoticeSilent', model: 'smart' }));
    const rootId = await post('@notice-silent FAIL-GATEWAY');
    expect((await finishedRun(bot.botId)).status).toBe('failed');
    await quiet(500);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
  });

  it('a run a person is already asked about posts no second line: the approval card is the notice', async () => {
    const bot = await loadBot(
      'notice-card',
      botMd({ name: 'NoticeCard', model: 'smart', capabilities: 'messages.post', extra: ['guard:', '  rules: ["dlp:require_approval"]', 'approvals:', '  approvers: ["role:on-call"]'] }),
    );
    const rootId = await post(`@notice-card please use sk-proj-${'Ab3dEf6hIj'.repeat(8)} to deploy`);
    expect((await finishedRun(bot.botId)).status).toBe('stopped');
    await quiet(500);
    expect(await messagesBy(rootId, bot.actorId)).toEqual([]);
  });

  it('leaves exactly one notice for a failed run, found again by its run id in the meta (the guard a retried job relies on)', async () => {
    const bot = await loadBot('notice-once', botMd({ name: 'NoticeOnce', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post('@notice-once FAIL-GATEWAY');
    const run = await finishedRun(bot.botId);
    await until(async () => (await messagesBy(rootId, bot.actorId)).length > 0, 30_000, 'the notice');
    // postFailureNotice looks for a notice carrying this run id before it posts, so a retried job finds this one and adds nothing
    const again = await w.system(async (tx) =>
      (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.messages WHERE thread_root_id = $1 AND meta ->> 'runId' = $2 AND meta ? 'runFailure'`, [rootId, run.id])).rows[0]!.n,
    );
    expect(again).toBe(1);
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
      // the message as written (not the author, the channel or the prompt wrapper), between delimiters, with the answer rule restated after it
      expect(request.messages[1]!.content).toBe(wrapMessage(body));
      expect(request.messages[1]!.content).toContain(body);
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

    it('a classifier that would leave the box is never used: `local` bound to a hosted model holds the message, and nothing is sent to it', async () => {
      const bot = await loadBot('gate-remote', gateBot('GateRemote', ['credential rotation']));
      const before = spoolLines().length;
      const calls = classifierCalls().length;
      await w.system(async (tx) => {
        await tx.query(`UPDATE app.llm_aliases SET provider_id = NULL, model = 'openai/gpt-4o' WHERE workspace_id = $1 AND alias = 'local'`, [personas.omar.workspaceId]);
      });
      try {
        classifierSays = () => 'NO'; // a remote model that would happily wave it through
        await post('@gate-remote what is on the roadmap?');
        expect((await finished(bot.botId)).status).toBe('stopped');
      } finally {
        await bindLocal();
        await w.system(async (tx) => {
          await tx.query(`UPDATE app.llm_aliases SET model = 'ollama/gate-test' WHERE workspace_id = $1 AND alias = 'local'`, [personas.omar.workspaceId]);
        });
      }
      expect(classifierCalls()).toHaveLength(calls); // not one byte reached the proxy
      expect(spoolLines()).toHaveLength(before);
      const [approval] = await approvalsOf(bot.botId);
      expect(approval!.args_preview).toMatchObject({ stage: 'classifier_unavailable' });
      expect(String(approval!.args_preview['reason'])).toContain('not a model inside this deployment');
    });

    it('a budget the bot has spent stops the run without a card, and the thread says so instead of staying silent', async () => {
      const bot = await loadBot('gate-budget', gateBot('GateBudget', ['credential rotation']));
      const before = spoolLines().length;
      await w.system(async (tx) => {
        await tx.query(`INSERT INTO app.llm_limits (workspace_id, scope, bot_id, limit_usd) VALUES ($1, 'bot', $2, 0)`, [personas.omar.workspaceId, bot.botId]);
      });
      classifierSays = () => 'NO';
      const rootId = await post('@gate-budget what is on the roadmap?');
      expect((await finished(bot.botId)).status).toBe('stopped');
      expect(await approvalsOf(bot.botId)).toEqual([]); // nobody to ask: the run's own call would hit the same wall
      expect(spoolLines()).toHaveLength(before);
      const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the notice in the thread');
      expect(notice.body).toMatch(/budget or rate limit/);
      expect(notice.body).not.toMatch(/\$|credential/); // no figures, no gate entry
    });

    it('a hold nobody in the conversation could decide stops the run and says so in the thread, instead of failing it', async () => {
      // the asker's own 1:1 conversation with the bot: the gate holds, but nobody in it but Nadia (who asked) could
      // decide — the on-call approver is not in it. The filing refusal used to abort the run's transaction, so the
      // audit line, the notice and the close all failed with "current transaction is aborted" and the run ended failed.
      const bot = await loadBot(
        'gate-alone',
        botMd({
          name: 'GateAlone',
          model: 'smart',
          capabilities: 'messages.post',
          extra: ['guard:', "  gate: ['credential rotation']", 'approvals:', '  approvers: ["role:on-call"]'],
        }).replace('  - type: mention', '  - type: conversation'),
      );
      const before = spoolLines().length;
      const opened = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/gate-alone/conversation');
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const alone = opened.body.channelId;
      const posted = await w.call(nadia, 'POST', `/api/channels/${alone}/messages`, {
        channelId: alone,
        body: 'please start the credential rotation',
        threadRootId: null,
      });
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      const rootId = (posted.body as { id: string }).id;

      const run = await finished(bot.botId);
      expect(run).toMatchObject({ status: 'stopped', trigger_type: 'conversation' });
      expect(spoolLines()).toHaveLength(before); // Hermes never started: the model was not called
      expect(await approvalsOf(bot.botId)).toEqual([]); // nothing filed: nobody could decide it
      const read = await w.call(nadia, 'GET', `/api/channels/${alone}/messages?threadRootId=${rootId}&limit=50`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      const notice = ListMessagesResponse.parse(read.body).items.filter((m) => m.authorId === bot.actorId)[0];
      expect(notice?.body).toMatch(/Held by this bot's gate/);
      const [event] = await gateEvents(bot.botId);
      expect(event).toMatchObject({ stage: 'exact', entry: 'credential rotation', approvalId: null });
    });

    it('a runtime that makes no model call is not gated: a rules bot with a gate list still runs', async () => {
      const md = [
        '---',
        'schema: 1',
        'name: RulesGated',
        'role: Answers with its declared steps',
        'kind: automation',
        'runtime: rules',
        'triggers:',
        '  - type: mention',
        'capabilities:',
        '  native: [messages.post]',
        'guard:',
        "  gate: ['credential rotation']",
        '---',
        '',
        '# RulesGated',
        '',
        'No prose is rendered for a rules bot.',
        '',
      ].join('\n');
      const bot = await loadBot('rules-gated', md);
      const calls = classifierCalls().length;
      const rootId = await post('@rules-gated credential rotation');
      const posted = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the rule to post');
      expect(posted.body).toContain('credential rotation');
      expect(classifierCalls()).toHaveLength(calls);
      expect(await approvalsOf(bot.botId)).toEqual([]);
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

describe('bot-to-bot delegation in team channels', () => {
  const finished = (botId: string) =>
    until(async () => {
      const row = await runOf(botId);
      return row && row.status !== 'running' ? row : null;
    }, 30_000, 'the run to end');

  it('a bot-authored @mention the author may tag opens a run for the target in the same thread, with no person asker', async () => {
    const orch = await loadBot('dlg-orch', botMd({ name: 'DlgOrch', model: 'smart', capabilities: 'messages.post', handover: ['dlg-coder'] }));
    const coder = await loadBot('dlg-coder', botMd({ name: 'DlgCoder', model: 'smart', capabilities: 'messages.post' }));
    const before = spoolLines().length;

    const rootId = await post('@dlg-orch start chain dlg-coder');
    // the person's run answers first, handing off with a mention of the coder
    const handoff = await until(async () => (await messagesBy(rootId, orch.actorId))[0], 30_000, 'the orchestrator to hand off');
    expect(handoff.body).toBe('@dlg-coder please continue');
    // the mention wakes the coder: its own run, in the same thread, answering the bot's message
    const reply = await until(async () => (await messagesBy(rootId, coder.actorId))[0], 30_000, 'the coder to pick up');
    expect(reply.body).toContain('@dlg-coder please continue');
    const run = await finished(coder.botId);
    expect(run).toMatchObject({ status: 'done', trigger_type: 'mention', asker_id: null, delegation_depth: 1 });
    expect(callsOf('dlg-coder', run!.id)).toHaveLength(1);
    expect(callsOf('dlg-coder', run!.id)[0]!['prompt']).toContain('DlgOrch in #dev:');
    // and the chain stops there: the coder's echo names only itself, which never wakes itself
    expect(spoolLines()).toHaveLength(before + 2);
    expect((await finished(orch.botId)).status).toBe('done');
    await quiet(4000);
    expect(spoolLines()).toHaveLength(before + 2);
    expect(await runsOf(orch.botId)).toHaveLength(1);
  });

  it('without a handover grant the mention wakes nobody', async () => {
    const orch = await loadBot('dlg-orch2', botMd({ name: 'DlgOrch2', model: 'smart', capabilities: 'messages.post' }));
    const coder = await loadBot('dlg-coder2', botMd({ name: 'DlgCoder2', model: 'smart', capabilities: 'messages.post' }));

    const rootId = await post('@dlg-orch2 start chain dlg-coder2');
    // the reply proves the router saw the bot-authored message and decided: no job for the coder is the decision
    const handoff = await until(async () => (await messagesBy(rootId, orch.actorId))[0], 30_000, 'the orchestrator to answer');
    expect(handoff.body).toBe('@dlg-coder2 please continue');
    expect(await jobsFor(coder.botId, handoff.id)).toBe(0);
    expect((await finished(orch.botId)).status).toBe('done');
    await quiet(4000);
    expect(await runsOf(coder.botId)).toEqual([]);
  });

  it('a bot mention never trips a channel_message trigger', async () => {
    const orch = await loadBot('dlg-orch3', botMd({ name: 'DlgOrch3', model: 'smart', capabilities: 'messages.post', handover: ['dlg-chanonly'] }));
    const chan = await loadBot(
      'dlg-chanonly',
      botMd({ name: 'DlgChanonly', model: 'smart', capabilities: 'messages.post', triggers: ['  - type: channel_message'] }),
    );

    const rootId = await post('@dlg-orch3 start chain dlg-chanonly');
    const handoff = await until(async () => (await messagesBy(rootId, orch.actorId))[0], 30_000, 'the orchestrator to answer');
    expect(handoff.body).toBe('@dlg-chanonly please continue');
    expect(await jobsFor(chan.botId, handoff.id)).toBe(0);
    expect((await finished(orch.botId)).status).toBe('done');
    // the person's own message did wake it through channel_message (the person path is untouched): one run, depth zero —
    // and nothing off the bot's mention. Its reply answers the person's message through the stand-in's handoff branch.
    const reply = await until(async () => (await messagesBy(rootId, chan.actorId))[0], 30_000, 'the channel bot to answer the person');
    expect(reply.body).toBe('@dlg-chanonly please continue');
    expect(await runsOf(chan.botId)).toMatchObject([{ status: 'done', trigger_type: 'channel_message', asker_id: nadia.actorId, delegation_depth: 0 }]);
    await quiet(4000);
  });

  it('a chain three deep runs, and the fourth mention is an ordinary message', async () => {
    const orch = await loadBot(
      'dlg-chain-orch',
      botMd({ name: 'DlgChainOrch', model: 'smart', capabilities: 'messages.post', handover: ['dlg-chain-coder', 'dlg-chain-extra'] }),
    );
    const coder = await loadBot(
      'dlg-chain-coder',
      botMd({ name: 'DlgChainCoder', model: 'smart', capabilities: 'messages.post', handover: ['dlg-chain-tester'] }),
    );
    const tester = await loadBot(
      'dlg-chain-tester',
      botMd({ name: 'DlgChainTester', model: 'smart', capabilities: 'messages.post', handover: ['dlg-chain-orch'] }),
    );
    const extra = await loadBot('dlg-chain-extra', botMd({ name: 'DlgChainExtra', model: 'smart', capabilities: 'messages.post' }));

    const rootId = await post('@dlg-chain-orch start chain dlg-chain-coder dlg-chain-tester dlg-chain-orch dlg-chain-extra');
    // three hops, each answering in the same thread: coder, tester, then the orchestrator again (each reply is authored
    // by the run that wrote it, so each hop is awaited on its author's messages)
    const first = await until(
      async () => (await messagesBy(rootId, orch.actorId)).filter((m) => m.body.startsWith('@dlg-chain-coder'))[0],
      30_000,
      'the orchestrator to hand to the coder',
    );
    expect(first.body).toBe('@dlg-chain-coder please continue chain dlg-chain-tester dlg-chain-orch dlg-chain-extra');
    const second = await until(async () => (await messagesBy(rootId, coder.actorId))[0], 30_000, 'the coder to pick up');
    expect(second.body).toBe('@dlg-chain-tester please continue chain dlg-chain-orch dlg-chain-extra');
    const third = await until(async () => (await messagesBy(rootId, tester.actorId))[0], 30_000, 'the tester to pick up');
    expect(third.body).toBe('@dlg-chain-orch please continue chain dlg-chain-extra');
    // the depth-three run still answers (its own reply is allowed); what must not happen is a fifth run off that reply
    const fourth = await until(
      async () => (await messagesBy(rootId, orch.actorId)).filter((m) => m.body === '@dlg-chain-extra please continue')[0],
      30_000,
      'the orchestrator to answer a second time',
    );
    expect(fourth.body).toBe('@dlg-chain-extra please continue');
    // the fourth hop would be depth four: the mention is an ordinary message and no fifth process starts.
    // Counted by process home, not the shared spool file: a straggler from another test must not fail this one, and a
    // fifth chain process (the loop the cap exists to stop) may not hide in the total.
    await quiet(6000);
    // a run nobody asked at depth 0 is the short one opened only to write the cap notice (when the author's own run had already ended)
    const orchRuns = (await runsOf(orch.botId)).filter((r) => !(r.asker_id === null && r.delegation_depth === 0));
    expect(orchRuns.map((r) => r.delegation_depth)).toEqual([0, 3]);
    expect(orchRuns.every((r) => r.status === 'done')).toBe(true);
    const coderRuns = await runsOf(coder.botId);
    expect(coderRuns).toMatchObject([{ status: 'done', asker_id: null, delegation_depth: 1 }]);
    const testerRuns = await runsOf(tester.botId);
    expect(testerRuns).toMatchObject([{ status: 'done', asker_id: null, delegation_depth: 2 }]);
    expect(await runsOf(extra.botId)).toEqual([]);
    // the dropped mention left one line in the thread, written by its author and naming the limit and the target
    const notices = (await messagesBy(rootId, orch.actorId)).filter((m) => m.body.includes('was not woken'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toBe(
      "`@dlg-chain-extra` was not woken by that mention: the bot-to-bot chain in this thread has reached its limit of 3. A person's mention or a card handover will wake it.",
    );
    // the same event delivered a second time (the outbox is at-least-once) posts nothing more
    await w.system((tx) => tx.query(`UPDATE app.outbox SET done_at = NULL, claimed_until = NULL, available_at = now() WHERE event_id = (SELECT id FROM app.events WHERE type = 'channel.message.posted' AND payload ->> 'messageId' = $1)`, [fourth.id]));
    await until(
      async () =>
        (await w.system((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.outbox o JOIN app.events e ON e.id = o.event_id WHERE e.payload ->> 'messageId' = $1 AND o.done_at IS NULL`, [fourth.id]))).rows[0]!.n === 0,
      30_000,
      'the replayed event to be delivered again',
    );
    expect((await messagesBy(rootId, orch.actorId)).filter((m) => m.body.includes('was not woken'))).toHaveLength(1);
    const homes = new Set(
      spoolLines()
        .map((l) => String(l['homeName'] ?? ''))
        .filter((h) => h.startsWith('dlg-chain-')),
    );
    expect(homes).toEqual(
      new Set([`dlg-chain-orch-${orchRuns[0]!.id}`, `dlg-chain-orch-${orchRuns[1]!.id}`, `dlg-chain-coder-${coderRuns[0]!.id}`, `dlg-chain-tester-${testerRuns[0]!.id}`]),
    );
  });

  /** A card in `thread`, owned by the bot and not done: what a handover leaves behind. */
  const giveCard = (bot: LoadedBot, thread: string): Promise<void> =>
    w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.tasks (workspace_id, team_id, title, state, kind, branch, owner_id, created_by, thread_root_id)
         SELECT b.workspace_id, b.team_id, 'Deploy the change', 'in_progress', 'ops', 'main', $2::uuid, $2::uuid, $3::uuid FROM app.bots b WHERE b.id = $1::uuid`,
        [bot.botId, bot.actorId, thread],
      );
    }).then(() => undefined);

  it('a mention wakes a bot that owns a card in the thread but is idle (its handover run has ended)', async () => {
    const orch = await loadBot('dlg-idle-orch', botMd({ name: 'DlgIdleOrch', model: 'smart', capabilities: 'messages.post', handover: ['dlg-idle-coder'] }));
    const coder = await loadBot('dlg-idle-coder', botMd({ name: 'DlgIdleCoder', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post('@dlg-idle-orch start chain dlg-idle-coder');
    await giveCard(coder, rootId);
    await until(async () => (await messagesBy(rootId, orch.actorId))[0], 30_000, 'the orchestrator to hand off');
    const reply = await until(async () => (await messagesBy(rootId, coder.actorId))[0], 30_000, 'the idle owner to be woken');
    expect(reply.body).toContain('@dlg-idle-coder please continue');
    expect(await finished(coder.botId)).toMatchObject({ status: 'done', trigger_type: 'mention', delegation_depth: 1 });
  });

  it('a mention starts no second run for a card owner whose handover run is still running', async () => {
    const orch = await loadBot('dlg-busy-orch', botMd({ name: 'DlgBusyOrch', model: 'smart', capabilities: 'messages.post', handover: ['dlg-busy-coder'] }));
    const coder = await loadBot('dlg-busy-coder', botMd({ name: 'DlgBusyCoder', model: 'smart', capabilities: 'messages.post' }));
    const rootId = await post('@dlg-busy-orch start chain dlg-busy-coder');
    await giveCard(coder, rootId);
    // the run the handover started, still open in this thread
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, reply_root_id)
         SELECT b.workspace_id, b.id, b.team_id, 'task_assigned', 'running', $2::uuid FROM app.bots b WHERE b.id = $1::uuid`,
        [coder.botId, rootId],
      ),
    );
    const handoff = await until(async () => (await messagesBy(rootId, orch.actorId))[0], 30_000, 'the orchestrator to hand off');
    expect((await finished(orch.botId)).status).toBe('done');
    await quiet(3000);
    expect(await jobsFor(coder.botId, handoff.id)).toBe(0);
    expect(await messagesBy(rootId, coder.actorId)).toEqual([]);
    await w.system((tx) => tx.query(`UPDATE app.bot_runs SET status = 'stopped', ended_at = now() WHERE bot_id = $1::uuid AND ended_at IS NULL`, [coder.botId]));
  });

  it('a bot-authored mention inside a 1:1 conversation wakes nobody', async () => {
    const orch = await loadBot(
      'dlg-conv-orch',
      botMd({
        name: 'DlgConvOrch',
        model: 'smart',
        capabilities: 'messages.post',
        triggers: ['  - type: conversation', '  - type: mention'],
        handover: ['dlg-conv-coder'],
      }),
    );
    const coder = await loadBot('dlg-conv-coder', botMd({ name: 'DlgConvCoder', model: 'smart', capabilities: 'messages.post' }));
    const opened = await w.call<{ channelId: string }>(nadia, 'POST', '/api/teams/engineering/bots/dlg-conv-orch/conversation');
    expect([200, 201]).toContain(opened.status);
    const alone = opened.body.channelId;
    const rootId = await post('@dlg-conv-orch start chain dlg-conv-coder', alone);
    // the orchestrator answers in the 1:1; its mention of the coder must not wake it there
    const handoff = await until(async () => (await messagesBy(rootId, orch.actorId, alone))[0], 30_000, 'the orchestrator to answer');
    expect(handoff.body).toBe('@dlg-conv-coder please continue');
    expect(await jobsFor(coder.botId, handoff.id)).toBe(0);
    await quiet(4000);
    expect(await runsOf(coder.botId)).toEqual([]);
    expect((await finished(orch.botId)).status).toBe('done');
  });
});
