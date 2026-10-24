import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse, ListRunnersResponse, MintRunnerTokenResponse, RevokeRunnerTokensResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startRunnerClient, type RunnerClient } from '../../../runner/src/client.ts';
import type { RunnerConfig } from '../../../runner/src/config.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// A person's @mention of a bot placed on a runner (SPEC §7.4, PLAN P6-06), through the real server, the real database and the real runner
// program — only Hermes is a stand-in (a script that behaves like `hermes chat --oneshot --format stream-json`). The runner is in this
// process, but it speaks the real protocol over a real WebSocket: it presents a bearer token, says hello, receives the job, writes a
// profile on its own disk, runs the stand-in as a child process and returns its stdout lines. What is asserted is the platform's half:
// exactly one reply in the thread, the profile the runner got, the run row, and what happens when the runner is not there.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

const STAND_IN = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8').trim();
  const home = process.env.HERMES_HOME || '';
  const config = readFileSync(home + '/config.yaml', 'utf8');
  appendFileSync(process.env.HERMES_FAKE_SPOOL, JSON.stringify({ cwd: process.cwd(), home, config, prompt, argv: process.argv.slice(2) }) + '\\n');
  if (prompt.includes('PROXY')) {
    // what a real agent does: its model calls go to the api address of its profile, with the key of its profile (rewritten to the test server's port)
    const api = /api: "([^"]+)"/.exec(config)[1].replace('http://localhost:3000', process.env.HERMES_FAKE_SERVER);
    const key = /api_key: "([^"]+)"/.exec(config)[1];
    (async () => {
      const res = await fetch(api + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: 'smart', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      const text = (await res.text()).split(/\\s+/).join(' ');
      const parts = api.split('/'); parts[parts.indexOf('runs') + 1] = '00000000-0000-4000-8000-000000000000';
      const other = await fetch(parts.join('/') + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: '{}' });
      const reply = 'proxy ' + res.status + ' ' + res.headers.get('content-type') + ' ' + text + ' other-run ' + other.status;
      process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 1, output: 1, total: 2 } }) + '\\n');
    })();
    return;
  }
  if (prompt.includes('HANG')) {
    process.on('SIGTERM', () => { writeFileSync(process.env.HERMES_FAKE_SPOOL + '.terminated', 'yes'); process.exit(143); });
    process.stdout.write(JSON.stringify({ type: 'text', text: 'working' }) + '\\n');
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'text', text: 'On the runner: ' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: 'On the runner: ' + prompt.replace(/\\s+/g, ' '), tokens: { input: 4, output: 4, total: 8 } }) + '\\n');
});
`;

const botMd = (name: string, runner: string, extra: string[] = []): string =>
  [
    '---', 'schema: 1', `name: ${name}`, 'role: Answers on a runner', 'kind: agent', 'runtime: hermes',
    'model:', '  aliases: [smart]', 'triggers:', '  - type: mention', 'capabilities:', '  native: [messages.post]', '  runtime: [shell, files]',
    'placement:', `  runner: ${runner}`, ...extra, '---', '', `# ${name}`, '', 'Soul text.', '',
  ].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
let channelId = '';
let runnerId = '';
let token = '';
let client: RunnerClient | null = null;
let upstream: Server | null = null;
/** What the stand-in model gateway was asked: the path and the bearer it saw. */
const upstreamSeen: { url: string; authorization: string | undefined }[] = [];
const logs: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  MANYTHREADS_LITELLM_URL: process.env['MANYTHREADS_LITELLM_URL'],
  MANYTHREADS_LITELLM_MASTER_KEY: process.env['MANYTHREADS_LITELLM_MASTER_KEY'],
  MANYTHREADS_HERMES_KILL_GRACE: process.env['MANYTHREADS_HERMES_KILL_GRACE'],
  MANYTHREADS_RUNTIME_DIR: process.env['MANYTHREADS_RUNTIME_DIR'],
  MANYTHREADS_HERMES_BIN: process.env['MANYTHREADS_HERMES_BIN'],
};

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      const runs = await w.system(async (tx) => (await tx.query(`SELECT status, trigger_type, (SELECT payload->>'reason' FROM app.events e WHERE e.type = 'runners.job.refused' ORDER BY id DESC LIMIT 1) AS reason FROM app.bot_runs ORDER BY started_at DESC LIMIT 3`)).rows).catch(() => []);
      const jobs = await w.system(async (tx) => (await tx.query(`SELECT queue, state, last_error FROM app.jobs ORDER BY created_at DESC LIMIT 4`)).rows).catch((e: unknown) => [String(e)]);
      throw new Error(`timed out waiting for ${what}; runner log: ${logs.slice(-6).join(' | ')}; runs: ${JSON.stringify(runs)}; jobs: ${JSON.stringify(jobs)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const spoolLines = (): Record<string, string>[] =>
  existsSync(spool) ? readFileSync(spool, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : [];

async function loadBot(slug: string, md: string): Promise<{ botId: string; actorId: string }> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = $1 AND b.status = 'active'`, [slug])).rows[0]?.id ?? null),
    15_000, `the loader to load ${slug}`,
  );
  const actorId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null), 5_000, `the actor of ${slug}`);
  return { botId, actorId };
}

async function post(body: string): Promise<string> {
  const res = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

const messagesBy = async (rootId: string, authorId: string): Promise<{ id: string; body: string }[]> => {
  const res = await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId);
};

const finishedRun = (botId: string) =>
  until(
    () => w.system(async (tx) => (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM app.bot_runs WHERE bot_id = $1 AND status <> 'running' ORDER BY started_at DESC LIMIT 1`, [botId])).rows[0] ?? null),
    40_000, 'the run to finish',
  );

const refusals = (): Promise<{ runner: string; reason: string; runId: string }[]> =>
  w.system(async (tx) =>
    (await tx.query<{ payload: { runner: string; reason: string; runId: string } }>(`SELECT payload FROM app.events WHERE type = 'runners.job.refused' ORDER BY id`)).rows.map((r) => r.payload),
  );

const runnerStatus = (): Promise<string | undefined> =>
  w.system(async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.runners WHERE id = $1', [runnerId])).rows[0]?.status);

/** Registering a runner row marks it online (the tasks plugin's door), so "connected" is the hello having been processed: the capabilities it advertised are stored. */
const runnerConnected = async (): Promise<boolean> =>
  (await runnerStatus()) === 'online' && (await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT jsonb_array_length(capabilities) AS n FROM app.runners WHERE id = $1", [runnerId])).rows[0]?.n)) === 2;

function startClient(): RunnerClient {
  const config: RunnerConfig = {
    server: w.server.url, tokenFile: '/unused', name: 'host-1', hermesBin: join(scratch, 'fake-hermes'), hermesHome: join(scratch, 'hermes-home'),
    workspaceRoot: join(scratch, 'workspaces'), maxJobs: 2, terminal: 'docker', sandboxImage: 'manythreads/runner-sandbox:1', extraCapabilities: [],
  };
  return startRunnerClient({
    config, token, log: (l) => logs.push(l), backoffMs: () => 200,
    capabilities: async () => ['docker', 'hermes'],
    jobDeps: { removeContainers: async () => undefined, env: { PATH: process.env['PATH'], HERMES_FAKE_SPOOL: spool, HERMES_FAKE_SERVER: w.server.url }, uid: 1000 },
  });
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runners-e2e-'));
  spool = join(scratch, 'spool.jsonl');
  writeFileSync(join(scratch, 'fake-hermes'), STAND_IN, { mode: 0o755 });
  chmodSync(join(scratch, 'fake-hermes'), 0o755);
  // A stand-in for LiteLLM: answers a chat call with two server-sent events and anything else (the config pushes) with an empty object.
  upstream = createServer((req, res) => {
    upstreamSeen.push({ url: req.url ?? '', authorization: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  process.env['MANYTHREADS_LITELLM_MASTER_KEY'] = 'sk-master-for-the-test';
  process.env['MANYTHREADS_LITELLM_URL'] = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  process.env['MANYTHREADS_HERMES_KILL_GRACE'] = '1';
  // a server that would have started Hermes itself must fail loudly if a runner-placed run ever fell back to it
  process.env['MANYTHREADS_HERMES_BIN'] = join(scratch, 'must-not-run-on-the-server');
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'server-runtime');

  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`)).rows[0]?.id ?? '');
  expect(channelId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await client?.stop();
  await w?.close();
  await new Promise((resolve) => (upstream ? upstream.close(resolve) : resolve(null)));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('the runner credential', () => {
  it('a team lead registers a runner and mints a token that is shown once; a member may not', async () => {
    const registered = await w.call<{ runner: { id: string } }>(omar, 'POST', '/api/teams/engineering/runners', { name: 'host-1', capabilities: [] });
    expect(registered.status).toBe(201);
    runnerId = registered.body.runner.id;

    const denied = await w.call(nadia, 'POST', `/api/teams/engineering/runners/${runnerId}/token`);
    expect(denied.status).toBe(403);

    const minted = await w.call(omar, 'POST', `/api/teams/engineering/runners/${runnerId}/token`);
    expect(minted.status).toBe(201);
    const body = MintRunnerTokenResponse.parse(minted.body);
    token = body.token;
    expect(token).toMatch(/^mtr_[A-Za-z0-9_-]{40,}$/);

    // only the hash is stored
    const rows = await w.system(async (tx) => (await tx.query<{ token_hash: Buffer }>('SELECT token_hash FROM app.runner_tokens WHERE runner_id = $1', [runnerId])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.length).toBe(32);
    expect(JSON.stringify(rows)).not.toContain(token);
    // the mint is audited, without the token
    const minted_events = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'runners.token.minted'`)).rows);
    expect(minted_events).toHaveLength(1);
    expect(minted_events[0]!.payload).toMatchObject({ runnerId, actorId: omar.actorId });
    expect(JSON.stringify(minted_events)).not.toContain(token);
    // another team's runner id answers like an unknown one
    expect((await w.call(omar, 'POST', `/api/teams/design/runners/${runnerId}/token`)).status).toBe(404);
  });

  it('refuses a socket with no token, a wrong one, or one that is not shaped like a runner token', async () => {
    for (const header of [undefined, 'Bearer mtr_' + 'a'.repeat(43), 'Bearer sk-not-a-runner-token-aaaaaaaaaaaaaaaaaaaa', 'Basic abc']) {
      const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
        const ws = new WebSocket(`${w.server.url.replace(/^http/, 'ws')}/api/runners/connect`, { headers: header ? { authorization: header } : {} });
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('error', () => undefined);
      });
      expect(closed, String(header)).toEqual({ code: 1008, reason: 'unauthorized' });
    }
  });
});

describe('a bot placed on a runner', () => {
  it('a mention is run on the runner and answered exactly once in the thread', async () => {
    const bot = await loadBot('runner-bot', botMd('RunnerBot', 'host-1'));
    client = startClient();
    await until(runnerConnected, 15_000, 'the runner to be connected');

    // the roster shows it online with what it advertised
    const roster = ListRunnersResponse.parse((await w.call(omar, 'GET', '/api/teams/engineering/runners')).body);
    expect(roster.items.find((r) => r.name === 'host-1')).toMatchObject({ status: 'online', capabilities: ['docker', 'hermes'] });

    const rootId = await post('@runner-bot what changed on the runner?');
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 40_000, 'the reply');
    expect(reply.body).toBe('On the runner: Nadia in #dev: @runner-bot what changed on the runner?');
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('done');
    // exactly one reply, one process, on the runner's machine
    await new Promise((r) => setTimeout(r, 500));
    expect(await messagesBy(rootId, bot.actorId)).toHaveLength(1);
    const calls = spoolLines().filter((l) => l['home']!.endsWith(`runner-bot-${run.id}`));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;

    // it ran in the runner's own profile directory and the team's workspace, never the server's
    expect(call['home']).toBe(join(scratch, 'hermes-home', 'profiles', `runner-bot-${run.id}`));
    expect(call['cwd']).toBe(join(scratch, 'workspaces', 'engineering'));
    expect(existsSync(join(scratch, 'server-runtime'))).toBe(false);
    expect(call['argv']).toEqual(['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json', '--run-budget', '600'].slice(0, call['argv']!.length));
    expect(call['prompt']).toBe('Nadia in #dev:\n\n@runner-bot what changed on the runner?');

    // the profile: the model goes through the server's run proxy on the public address with the run token, not the bot's key or the cluster address
    const config = call['config']!;
    expect(config).toContain(`api: "http://localhost:3000/api/llm/runs/${run.id}/v1"`);
    expect(config).toContain(`url: "http://localhost:3000/api/mcp/runs/${run.id}"`);
    const bearer = /Authorization: "Bearer ([^"]+)"/.exec(config)![1]!;
    expect(config).toContain(`api_key: "${bearer}"`);
    expect(config).not.toContain(process.env['MANYTHREADS_LITELLM_URL']!);
    // the definition's grant is the tool list: shell and files, nothing else
    expect(config).toContain('cli: ["terminal", "file"]');
    expect(config).toMatch(/disabled_toolsets: \[[^\]]*"browser"/);
    // and the runner's own policy follows the server's text
    expect(config).toMatch(/runner policy[^\n]*\nterminal:\n {2}backend: "docker"\n {2}cwd: "\."/);
    // the profile is gone once the run has ended
    expect(existsSync(call['home']!)).toBe(false);
  });

  it("the agent's model calls go through the server's run proxy: the bot's key reaches the gateway, the run token does not, and the token dies with the run", async () => {
    // the workspace binds the `smart` alias to a provider, so a bot that loads now is minted a virtual key
    const base = process.env['MANYTHREADS_LITELLM_URL']!;
    const provider = await w.call<{ provider: { id: string } }>(omar, 'POST', '/api/workspace/llm/providers', { name: 'stand-in', kind: 'openai_compatible', apiKey: 'sk-provider-key', apiBase: base });
    expect(provider.status, JSON.stringify(provider.body)).toBe(201);
    expect((await w.call(omar, 'PUT', '/api/workspace/llm/aliases/smart', { providerId: provider.body.provider.id, model: 'stand-in-model' })).status).toBe(200);
    const bot = await loadBot('proxy-bot', botMd('ProxyBot', 'host-1'));
    await until(() => w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.llm_keys WHERE bot_id = $1 AND secret_id IS NOT NULL AND revoked_at IS NULL`, [bot.botId])).rows.length > 0), 20_000, "the bot's virtual key");
    const rootId = await post('@proxy-bot PROXY please');
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 40_000, 'the reply');
    // the stream came through the server unchanged, under the run's own id; another run's id with the same token is refused
    expect(reply.body).toContain('proxy 200 text/event-stream');
    expect(reply.body).toContain('"content":"hello"');
    expect(reply.body).toContain('[DONE]');
    expect(reply.body).toMatch(/other-run 401$/);
    const run = await finishedRun(bot.botId);
    const call = spoolLines().find((l) => l['home']!.endsWith(`proxy-bot-${run.id}`))!;
    const runToken = /api_key: "([^"]+)"/.exec(call['config']!)![1]!;
    const chat = upstreamSeen.filter((c) => c.url === '/v1/chat/completions');
    expect(chat).toHaveLength(1);
    expect(chat[0]!.authorization).toMatch(/^Bearer /);
    expect(chat[0]!.authorization).not.toContain(runToken);
    // once the run has ended the same token opens nothing
    const after = await fetch(`${w.server.url}/api/llm/runs/${run.id}/v1/models`, { headers: { authorization: `Bearer ${runToken}` } });
    expect(after.status).toBe(401);
    expect(upstreamSeen.filter((c) => c.url === '/v1/models')).toHaveLength(0);
  });

  it('a run whose runner is not connected fails with the reason, posts only the offline notice; the reason is recorded', async () => {
    const bot = await loadBot('ghost-bot', botMd('GhostBot', 'ghost'));
    const before = spoolLines().length;
    const rootId = await post('@ghost-bot are you there?');
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('failed');
    // no answer, no half answer: the one line is the notice, naming the runner as the cause and nothing from the error
    expect((await messagesBy(rootId, bot.actorId)).map((m) => m.body)).toEqual(["I couldn't answer: this team's runner is offline. Try again once it is back."]);
    expect(spoolLines()).toHaveLength(before);
    const refused = (await refusals()).find((r) => r.runId === run.id);
    expect(refused).toMatchObject({ runner: 'ghost' });
    expect(refused!.reason).toContain('no runner called "ghost"');
  });

  it('a revoked token ends the connection; the runner is offline and the next run fails with that reason', async () => {
    const bot = (await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'runner-bot'`)).rows[0]))!;
    const revoked = await w.call(omar, 'DELETE', `/api/teams/engineering/runners/${runnerId}/token`);
    expect(revoked.status).toBe(200);
    expect(RevokeRunnerTokensResponse.parse(revoked.body)).toEqual({ revoked: 1 });
    const audited = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'runners.token.revoked'`)).rows);
    expect(audited[0]!.payload).toMatchObject({ runnerId, actorId: omar.actorId, revoked: 1 });
    await until(async () => (await runnerStatus()) === 'offline', 15_000, 'the runner to go offline');

    const since = new Date();
    await post('@runner-bot anyone home?');
    const run = await until(
      () => w.system(async (tx) => (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM app.bot_runs WHERE bot_id = $1 AND started_at > $2 AND status <> 'running' LIMIT 1`, [bot.id, since])).rows[0]),
      40_000, 'the second run to finish',
    );
    expect(run.status).toBe('failed');
    const refused = (await refusals()).find((r) => r.runId === run.id);
    expect(refused!.reason).toContain('is not connected to this server');
    // the runner program keeps retrying with its revoked token and is refused each time; it must not be online again
    await new Promise((r) => setTimeout(r, 700));
    expect(await runnerStatus()).toBe('offline');
  });

  it('a new token brings the runner back, and a run that outlives its budget is stopped on the runner', async () => {
    await client?.stop();
    const minted = MintRunnerTokenResponse.parse((await w.call(omar, 'POST', `/api/teams/engineering/runners/${runnerId}/token`)).body);
    token = minted.token;
    client = startClient();
    await until(runnerConnected, 15_000, 'the runner to be back');

    const bot = await loadBot('hang-bot', botMd('HangBot', 'host-1', ['limits:', '  timeoutSeconds: 1']));
    await post('@hang-bot HANG please');
    const run = await finishedRun(bot.botId);
    expect(run.status).toBe('failed');
    // the process on the runner received the stop (its SIGTERM handler wrote the flag), and the profile is gone
    expect(existsSync(`${spool}.terminated`)).toBe(true);
    const call = spoolLines().find((l) => l['home']!.endsWith(`hang-bot-${run.id}`))!;
    expect(existsSync(call['home']!)).toBe(false);
  });
});
