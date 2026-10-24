import { PassThrough } from 'node:stream';
import { RunnerUnavailableError, type BotRuntimeInput, type BotRuntimeScope, type PluginContext, type RunnerDispatch, type RunnerDoor, type RunnerJob } from '@manythreads/sdk';
import { parseBotMd } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { createHermesProvider, type HermesRuntimeOptions } from '../src/hermes.ts';
import { buildScope, type LoadedDefinition, type RunBotRow, type RunPayload } from '../src/run-job.ts';
import { renderConfig } from '../src/profile.ts';

// A bot whose BOT.md says `placement: { runner: <name> }` (SPEC §7.4): the profile is rendered here and sent to the runner, the runner's stdout lines
// come back through the same parser as a local child's, a stop reaches the runner, and a runner that is not there fails the run with the reason.

const RUN = '77777777-7777-7777-7777-777777777777';
const GATEWAY = { baseUrl: `https://threads.example/api/llm/runs/${RUN}`, key: 'run-token' };

const definitionOf = (placement: string): LoadedDefinition => {
  const parsed = parseBotMd(`---\nname: Coder\nrole: Writes code\nkind: agent\nruntime: hermes\nmodel: { aliases: [code] }\n${placement}limits: { timeoutSeconds: 120 }\n---\nBody\n`);
  if (!parsed.ok) throw new Error('the fixture BOT.md must parse');
  return { frontmatter: parsed.frontmatter, body: parsed.body, alias: 'code', holdOnDetection: false, approvers: [] };
};

const input = (placement: string, gateway: BotRuntimeInput['gateway']): BotRuntimeInput => {
  const def = definitionOf(placement);
  return {
    bot: { id: '11111111-1111-1111-1111-111111111111', slug: 'coder', name: 'Coder', teamId: '22222222-2222-2222-2222-222222222222', workspaceId: '33333333-3333-3333-3333-333333333333', runtime: 'hermes', definitionSha: 'a'.repeat(64) },
    definition: { frontmatter: def.frontmatter, body: def.body },
    trigger: 'mention',
    asker: null,
    prompt: 'Nadia in #dev:\n\n@coder what changed?',
    thread: null,
    endpoint: { runId: RUN, url: `https://threads.example/api/mcp/runs/${RUN}`, token: 'run-token' },
    gateway,
    limits: { runBudgetSeconds: 120, maxTurns: null, sessionMinutes: null },
  };
};

const scope = (log: string[] = []): BotRuntimeScope => ({ invoke: async () => ({}), logSource: async () => 0, log: (line) => log.push(line) });

describe('the profile of a run placed on a runner', () => {
  it("points the model at this server's run proxy with the run token, and the MCP endpoint at the public address", () => {
    const ctx = { runtime: { publicUrl: 'https://threads.example', now: () => new Date() } } as unknown as PluginContext;
    const bot = { id: '11111111-1111-1111-1111-111111111111', slug: 'coder', name: 'Coder', runtime: 'hermes', definition_sha: 'a'.repeat(64), team_id: '22222222-2222-2222-2222-222222222222', workspace_id: '33333333-3333-3333-3333-333333333333', status: 'active' } as RunBotRow;
    const payload = { trigger: 'mention', askerActorId: null, channelId: '55555555-5555-5555-5555-555555555555', replyRootId: '66666666-6666-6666-6666-666666666666' } as RunPayload;
    const run = { runId: RUN, botId: bot.id, botActorId: 'x', teamId: bot.team_id, workspaceId: bot.workspace_id, trigger: 'mention', askerActorId: null, expiresAt: '' };
    const provider = createHermesProvider({ bin: 'hermes', prefix: [], dataRoot: '/nowhere', env: {}, killGraceSeconds: 5 });
    const build = (placement: string) =>
      buildScope({ ctx, log: { info() {}, warn() {}, error() {} } as never, bot, definition: definitionOf(placement), payload, prompt: 'p', run, token: 'run-token-secret', provider, gatewayBase: 'http://litellm.cluster:4000', key: 'sk-bot-virtual-key', approvers: [] }).input;

    const onRunner = build('placement: { runner: server-1 }\n');
    expect(onRunner.gateway).toEqual({ baseUrl: `https://threads.example/api/llm/runs/${RUN}`, key: 'run-token-secret' });
    expect(onRunner.endpoint?.url).toBe(`https://threads.example/api/mcp/runs/${RUN}`);
    const yaml = parseYaml(renderConfig(onRunner)) as { providers: { manythreads: { api: string; api_key: string } }; mcp_servers: { manythreads: { url: string } } };
    expect(yaml.providers.manythreads.api).toBe(`https://threads.example/api/llm/runs/${RUN}/v1`);
    expect(yaml.providers.manythreads.api_key).toBe('run-token-secret');
    // the bot's virtual key and the cluster address never reach a profile that leaves the server
    expect(renderConfig(onRunner)).not.toContain('sk-bot-virtual-key');
    expect(renderConfig(onRunner)).not.toContain('litellm.cluster');

    // a run that stays on the server's own host is unchanged: the gateway address and the bot's key
    const local = build('');
    expect(local.gateway).toEqual({ baseUrl: 'http://litellm.cluster:4000', key: 'sk-bot-virtual-key' });
  });
});

/** A runner door whose job a test drives line by line. */
function fakeDoor(): { door: RunnerDoor; jobs: RunnerJob[]; stops: string[]; stdout: PassThrough; exit: (code: number | null, signal?: string | null, tail?: string) => void; calls: { teamId: string; runner: string }[] } {
  const jobs: RunnerJob[] = [];
  const stops: string[] = [];
  const calls: { teamId: string; runner: string }[] = [];
  const stdout = new PassThrough();
  let exit!: (code: number | null, signal?: string | null, tail?: string) => void;
  const exited = new Promise<{ code: number | null; signal: string | null; stderrTail: string }>((resolve) => {
    exit = (code, signal = null, tail = '') => {
      stdout.end();
      resolve({ code, signal, stderrTail: tail });
    };
  });
  const door: RunnerDoor = {
    id: 'runners',
    async dispatch({ teamId, runner, job }): Promise<RunnerDispatch> {
      jobs.push(job);
      calls.push({ teamId, runner });
      const lines = (async function* () {
        let buffer = '';
        for await (const chunk of stdout) {
          buffer += String(chunk);
          let at: number;
          while ((at = buffer.indexOf('\n')) !== -1) {
            yield buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
          }
        }
      })();
      return { lines, exited, stop: async () => { stops.push(job.runId); } };
    },
  };
  return { door, jobs, stops, stdout, exit, calls };
}

const options = (door: RunnerDoor | undefined, extra: Partial<HermesRuntimeOptions> = {}): HermesRuntimeOptions => ({
  bin: '/nonexistent/hermes', prefix: [], dataRoot: '/nonexistent/runtime', env: {}, killGraceSeconds: 1, runners: () => door, ...extra,
});

const drain = async (events: AsyncIterable<unknown>): Promise<Record<string, unknown>[]> => {
  const out: Record<string, unknown>[] = [];
  for await (const e of events) out.push(e as Record<string, unknown>);
  return out;
};

describe('the hermes provider with a runner', () => {
  it('sends the rendered profile and the prompt as data, and reads the runner\'s lines like a local child\'s', async () => {
    const f = fakeDoor();
    const provider = createHermesProvider(options(f.door));
    const handle = await provider.run(input('placement: { runner: server-1 }\n', GATEWAY), scope());

    expect(f.calls).toEqual([{ teamId: '22222222-2222-2222-2222-222222222222', runner: 'server-1' }]);
    const job = f.jobs[0]!;
    expect(job.runId).toBe(RUN);
    expect(job.prompt).toBe('Nadia in #dev:\n\n@coder what changed?');
    expect(job.runBudgetSeconds).toBe(120);
    expect(job.profile.home).toBe(`coder-${RUN}`);
    expect(Object.keys(job.profile.files).sort()).toEqual(['SOUL.md', 'config.yaml']);
    // the prompt is in the job, not in any file of the profile
    expect(JSON.stringify(job.profile.files)).not.toContain('what changed');

    const collected = drain(handle.events);
    f.stdout.write('{"type":"text","text":"Looking "}\n');
    f.stdout.write('{"type":"tool_use","name":"terminal","input":{"command":"ls"}}\n');
    f.stdout.write('{"type":"tool_result","name":"terminal","output":"x","is_error":false}\n');
    f.stdout.write('{"type":"result","exit_code":0,"text":"Looking at it","tokens":{"input":3,"output":4,"total":7}}\n');
    f.exit(0);
    const events = await collected;
    expect(events.map((e) => e['type'])).toEqual(['text', 'tool', 'tool_result', 'result']);
    expect(events[3]).toMatchObject({ type: 'result', text: 'Looking at it', ok: true });
  });

  it('a runner that dies without a result fails the run with the reason it gave', async () => {
    const f = fakeDoor();
    const handle = await createHermesProvider(options(f.door)).run(input('placement: { runner: server-1 }\n', GATEWAY), scope());
    const collected = drain(handle.events);
    f.stdout.write('{"type":"text","text":"half"}\n');
    f.exit(null, null, 'the runner "server-1" disconnected (closed)');
    const events = await collected;
    const result = events.at(-1)!;
    expect(result).toMatchObject({ type: 'result', ok: false });
    expect(String(result['error'])).toContain('the runner "server-1" disconnected');
  });

  it('a stop reaches the runner, once', async () => {
    const f = fakeDoor();
    const handle = await createHermesProvider(options(f.door)).run(input('placement: { runner: server-1 }\n', GATEWAY), scope());
    const collected = drain(handle.events);
    await handle.stop();
    await handle.stop();
    expect(f.stops).toEqual([RUN]);
    f.exit(null, 'SIGTERM');
    const events = await collected;
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false });
    expect(String(events.at(-1)!['error'])).toContain('stopped (SIGTERM)');
    expect(f.stops).toEqual([RUN]);
  });

  it('a run that outlives its budget is stopped on the runner by the platform\'s own ceiling', async () => {
    const f = fakeDoor();
    const log: string[] = [];
    // budget 120 s in the definition; shrink it through the input's limits so the test does not wait
    const quick = { ...input('placement: { runner: server-1 }\n', GATEWAY), limits: { runBudgetSeconds: 0, maxTurns: null, sessionMinutes: null } };
    const handle = await createHermesProvider(options(f.door, { killGraceSeconds: 1 })).run(quick, scope(log));
    const collected = drain(handle.events);
    const deadline = Date.now() + 5000;
    while (f.stops.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(f.stops).toEqual([RUN]);
    expect(log.join('\n')).toContain('exceeded');
    f.exit(null, 'SIGTERM');
    await collected;
  });

  it('a run the runner stopped at its own budget (exit 143, before the platform ceiling) is a timeout, not "other"', async () => {
    const f = fakeDoor();
    const quick = { ...input('placement: { runner: server-1 }\n', GATEWAY), limits: { runBudgetSeconds: 0, maxTurns: null, sessionMinutes: null } };
    const handle = await createHermesProvider(options(f.door, { killGraceSeconds: 30 })).run(quick, scope());
    const collected = drain(handle.events);
    f.exit(143, null, '');
    const result = (await collected).at(-1)!;
    expect(result).toMatchObject({ type: 'result', ok: false, failure: 'timeout' });
    await handle.stop();
  });

  it('a runner that is not there fails the run at once, with the reason, and starts nothing', async () => {
    const door: RunnerDoor = {
      id: 'runners',
      dispatch: async () => {
        throw new RunnerUnavailableError('the runner "server-1" is not connected to this server (never seen)');
      },
    };
    const log: string[] = [];
    const handle = await createHermesProvider(options(door)).run(input('placement: { runner: server-1 }\n', GATEWAY), scope(log));
    const events = await drain(handle.events);
    expect(events).toEqual([{ type: 'result', text: '', ok: false, error: 'the runner "server-1" is not connected to this server (never seen)', failure: 'runner_offline', tokens: null }]);
    expect(log.join('\n')).toContain('was not started');
  });

  it('no runners service at all fails the run with that reason', async () => {
    const handle = await createHermesProvider(options(undefined)).run(input('placement: { runner: server-1 }\n', GATEWAY), scope());
    const events = await drain(handle.events);
    expect(String(events[0]!['error'])).toContain('no runners service');
  });

  it('a bot without a runner placement is not sent anywhere', async () => {
    const f = fakeDoor();
    const provider = createHermesProvider(options(f.door, { bin: '/nonexistent/hermes', dataRoot: '/tmp/never-written-by-this-test' }));
    // the local path would try to write a profile and start a process: it is the door that must stay untouched
    await provider.run(input('', GATEWAY), scope()).catch(() => undefined);
    expect(f.calls).toEqual([]);
  });
});

