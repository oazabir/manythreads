import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { claudeToolFlags } from '../src/drivers/claude-code.ts';
import { RunManager } from '../src/runs.ts';
import { SessionStore, sessionUuid } from '../src/sessions.ts';
import { alive, auth, events, getRun, harness, KEY, start, waitFor, type Harness } from './support.ts';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const mcp = { url: 'https://example.test/mcp', token: 'run-token-SECRET-12345' };

describe('auth and limits', () => {
  it('refuses a missing or wrong key, on every route', async () => {
    for (const headers of [{} as Record<string, string>, { authorization: 'Bearer nope' }, { authorization: KEY }]) {
      expect((await fetch(`${h.bridge.url}/health`, { headers })).status).toBe(401);
      expect((await fetch(`${h.bridge.url}/p/default/v1/runs`, { method: 'POST', headers, body: '{}' })).status).toBe(401);
    }
    expect((await fetch(`${h.bridge.url}/health`, { headers: auth })).status).toBe(200);
  });

  it("answers the server's connection check (/v1/models), for the bridge and for a profile", async () => {
    expect((await fetch(`${h.bridge.url}/v1/models`)).status).toBe(401);
    for (const path of ['/v1/models', '/p/default/v1/models', '/p/mt-coder/v1/models']) {
      const res = await fetch(`${h.bridge.url}${path}`, { headers: auth });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: Array<{ id: string }> }).data[0]?.id).toBe('claude-code');
    }
  });

  it('refuses to start without a usable key', async () => {
    const { startBridge } = await import('../src/server.ts');
    await expect(startBridge({ config: h.config, apiKey: '', stateDir: h.dir })).rejects.toThrow(/at least 16/);
  });

  it('rejects a body over 1 MB and a malformed one', async () => {
    const big = await start(h, { input: 'x'.repeat(1024 * 1024 + 10) });
    expect(big.status).toBe(413);
    expect((await start(h, { nope: 1 })).status).toBe(400);
  });

  it('answers 429 with retry-after at the concurrency limit', async () => {
    await h.close();
    h = await harness({ maxConcurrentRuns: 1 });
    const first = await start(h, { input: 'SLOW' });
    expect(first.status).toBe(202);
    const second = await start(h, { input: 'hi' });
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    await fetch(`${h.bridge.url}/p/default/v1/runs/${((await first.json()) as { run_id: string }).run_id}/stop`, { method: 'POST', headers: auth });
  });
});

describe('a run', () => {
  it('maps stream-json to the gateway events, in order, with seq and ids', async () => {
    const res = await start(h, { input: 'hello', instructions: 'You are Bot.', manythreads: { tools: ['files'], mcp } });
    expect(res.status).toBe(202);
    const { run_id } = (await res.json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(evs.map((e) => e.data['event'])).toEqual(['message.delta', 'tool.started', 'tool.completed', 'tool.started', 'tool.completed', 'message.delta', 'run.completed']);
    expect(evs.map((e) => e.data['seq'])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(evs.map((e) => e.id)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(evs.every((e) => e.data['run_id'] === run_id)).toBe(true);
    expect(evs[1]!.data).toMatchObject({ tool: 'Read', preview: '{"file_path":"a.txt"}' });
    expect(evs[2]!.data).toMatchObject({ tool: 'Read', error: false });
    expect(evs[4]!.data).toMatchObject({ tool: 'mcp__manythreads__post', error: true });
    expect(evs[6]!.data).toMatchObject({ output: 'Looking. Done.', usage: { input_tokens: 110, output_tokens: 5, total_tokens: 115 } });
    expect(await getRun(h, run_id)).toMatchObject({ status: 'completed', output: 'Looking. Done.' });
  });

  it('turns an error result into run.failed, and a crash into the last stderr line without the token', async () => {
    const a = (await (await start(h, { input: 'ERRORRESULT' })).json()) as { run_id: string };
    const ea = await events(h, a.run_id);
    expect(ea.at(-1)!.data).toMatchObject({ event: 'run.failed', error: 'Credit balance is too low' });

    const b = (await (await start(h, { input: 'CRASH', manythreads: { mcp } })).json()) as { run_id: string };
    const eb = await events(h, b.run_id);
    const last = eb.at(-1)!.data;
    expect(last['event']).toBe('run.failed');
    expect(String(last['error'])).toContain('boom with token');
    expect(JSON.stringify(eb)).not.toContain('SECRET');
  });

  it('reports a missing CLI as a failure, not a hang', async () => {
    await h.close();
    h = await harness({ bin: { claude: '/nonexistent/claude' } });
    const { run_id } = (await (await start(h, { input: 'hi' })).json()) as { run_id: string };
    expect((await events(h, run_id)).at(-1)!.data).toMatchObject({ event: 'run.failed' });
  });

  it('keeps run ids private to their profile', async () => {
    const { run_id } = (await (await start(h, { input: 'hi' })).json()) as { run_id: string };
    const res = await fetch(`${h.bridge.url}/p/other/v1/runs/${run_id}`, { headers: auth });
    expect(res.status).toBe(404);
    await events(h, run_id);
  });
});

describe('idempotency and resume', () => {
  it('returns the same run for the same key and body, and 409 for another body', async () => {
    const body = { input: 'hello' };
    const a = (await (await start(h, body, { 'idempotency-key': 'k1' })).json()) as { run_id: string };
    const b = (await (await start(h, body, { 'idempotency-key': 'k1' })).json()) as { run_id: string };
    expect(b.run_id).toBe(a.run_id);
    expect((await start(h, { input: 'different' }, { 'idempotency-key': 'k1' })).status).toBe(409);
    await events(h, a.run_id);
    expect(h.calls()).toHaveLength(1);
  });

  it('resumes the event stream after last_seq or last-event-id', async () => {
    const { run_id } = (await (await start(h, { input: 'hello' })).json()) as { run_id: string };
    const all = await events(h, run_id);
    const tail = await events(h, run_id, '?last_seq=4');
    expect(tail.map((e) => e.data['seq'])).toEqual([5, 6]);
    const res = await fetch(`${h.bridge.url}/p/default/v1/runs/${run_id}/events`, { headers: { ...auth, 'last-event-id': '5' } });
    expect(await res.text()).toContain('"event":"run.completed"');
    expect(all).toHaveLength(7);
    const partial = await events(h, run_id, '', 'default', 3);
    expect(partial).toHaveLength(3);
  });
});

describe('what the CLI is given', () => {
  it('maps tool grants to --tools and --allowedTools, with no bypass flags', async () => {
    const cases: Array<[string[], string, string[]]> = [
      [[], '', ['mcp__manythreads__*']],
      [['files'], 'Read,Edit,Write,Glob,Grep,NotebookEdit', ['Read', 'mcp__manythreads__*']],
      [['shell', 'web', 'browser', 'vision'], 'Bash,WebFetch,WebSearch', ['Bash', 'WebSearch']],
    ];
    for (const [grants, tools, allowedHas] of cases) {
      const { run_id } = (await (await start(h, { input: `g ${grants.join('+')}`, manythreads: { tools: grants, mcp } })).json()) as { run_id: string };
      await events(h, run_id);
      const call = h.calls().at(-1)!;
      const argv = call['argv'] as string[];
      expect(argv[argv.indexOf('--tools') + 1]).toBe(tools);
      const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
      for (const a of allowedHas) expect(allowed).toContain(a);
      for (const bad of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']) expect(argv).not.toContain(bad);
      expect(argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--restricted', '--strict-mcp-config', '--model', 'sonnet']));
    }
  });

  it("appends the profile's note about this machine after BOT.md", async () => {
    const { withProfileInstructions } = await import('../src/runs.ts');
    const base = { input: 'x', sessionId: null, instructions: 'BOT.md body', manythreads: { tools: [], mcp: null, model: { alias: null, effort: null }, budgetSeconds: null, maxTurns: null } } as never;
    expect((withProfileInstructions(base, 'Repos are in /srv/repos.') as { instructions: string }).instructions).toBe('BOT.md body\n\n## Where you run\n\nRepos are in /srv/repos.');
    expect(withProfileInstructions(base, undefined)).toBe(base);
    expect((withProfileInstructions({ ...(base as object), instructions: null } as never, 'Note.') as { instructions: string }).instructions).toBe('## Where you run\n\nNote.');
    const { parseConfig } = await import('../src/config.ts');
    expect(() => parseConfig({ profiles: { default: { agent: 'claude-code', workdir: '/w', instructions: 5 } } } as never)).toThrow(/instructions/);
  });

  it('keeps the prompt on stdin and the token out of argv, writing a 0600 mcp file that holds a reference', async () => {
    const { run_id } = (await (await start(h, { input: 'the secret prompt text', instructions: 'BOT.md body', manythreads: { mcp } })).json()) as { run_id: string };
    await events(h, run_id);
    const call = h.calls()[0]!;
    const argv = call['argv'] as string[];
    expect(call['stdin']).toBe('the secret prompt text');
    expect(argv.join(' ')).not.toContain('secret prompt');
    expect(argv.join(' ')).not.toContain(mcp.token);
    expect(call['token']).toBe(mcp.token);
    expect(call['hasBridgeKey']).toBe(false);
    expect(call['mcpMode']).toBe(0o600);
    expect(JSON.parse(call['mcp'] as string)).toEqual({
      mcpServers: { manythreads: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer ${MANYTHREADS_RUN_TOKEN}' } } },
    });
    expect(call['instructions']).toBe('BOT.md body');
    expect(call['cwd']).toContain('work');
    // the per-run folder is gone afterwards
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(h.dir).filter((n) => n.startsWith('agent-bridge-run-'))).toEqual([]);
  });

  it('can put the token in the 0600 file instead (mcpTokenInFile)', async () => {
    await h.close();
    h = await harness({ mcpTokenInFile: true });
    const { run_id } = (await (await start(h, { input: 'hi', manythreads: { mcp } })).json()) as { run_id: string };
    await events(h, run_id);
    const call = h.calls()[0]!;
    expect(call['token']).toBeNull();
    expect(call['mcp']).toContain(mcp.token);
    expect((call['argv'] as string[]).join(' ')).not.toContain(mcp.token);
  });

  it('maps model aliases and effort', async () => {
    await h.close();
    h = await harness({ profiles: { default: { agent: 'claude-code', workdir: join(tmpDirFor(), 'w'), model: 'm0', modelAliases: { fast: 'm-fast' }, passEnv: ['FAKE_CLI_DIR'] } } });
    const { run_id } = (await (await start(h, { input: 'hi', manythreads: { model: { alias: 'fast', effort: 'high' } } })).json()) as { run_id: string };
    await events(h, run_id);
    const argv = h.calls()[0]!['argv'] as string[];
    expect(argv[argv.indexOf('--model') + 1]).toBe('m-fast');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
  });
});

const tmpDirFor = (): string => process.env['FAKE_CLI_DIR']!;

describe('sessions', () => {
  it('starts with --session-id, then resumes with --resume, with a stable uuid', async () => {
    const uuid = sessionUuid('default', 'bot:thread-1');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionUuid('default', 'bot:thread-1')).toBe(uuid);
    expect(sessionUuid('other', 'bot:thread-1')).not.toBe(uuid);
    for (let i = 0; i < 2; i++) {
      const { run_id } = (await (await start(h, { input: `turn ${i}`, session_id: 'bot:thread-1' })).json()) as { run_id: string };
      await events(h, run_id);
    }
    const [first, second] = h.calls().map((c) => c['argv'] as string[]);
    expect(first!.slice(first!.indexOf('--session-id'), first!.indexOf('--session-id') + 2)).toEqual(['--session-id', uuid]);
    expect(second).toContain('--resume');
    expect(second![second!.indexOf('--resume') + 1]).toBe(uuid);
    expect(JSON.parse(readFileSync(join(h.dir, 'state', 'sessions.json'), 'utf8'))).toHaveProperty(`claude:${uuid}`);
  });

  it('retries once with --session-id when Claude Code has no such session', async () => {
    const uuid = sessionUuid('default', 'gone');
    const { SessionStore } = await import('../src/sessions.ts');
    // the bridge knows the session (written to its state file), the CLI does not: restart the bridge on that state
    new SessionStore(join(h.dir, 'state')).set(`claude:${uuid}`, 'x');
    await h.bridge.close();
    const { startBridge } = await import('../src/server.ts');
    h.bridge = await startBridge({ config: h.config, apiKey: KEY, stateDir: join(h.dir, 'state'), port: 0, log: () => undefined, tmpRoot: h.dir });
    const { run_id } = (await (await start(h, { input: 'hi', session_id: 'gone' })).json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(evs.at(-1)!.data['event']).toBe('run.completed');
    const argvs = h.calls().map((c) => c['argv'] as string[]);
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).toContain('--resume');
    expect(argvs[1]).toContain('--session-id');
  });
});

describe('stop and budget', () => {
  it('stop kills the whole process group (SIGKILL after the grace) and ends with run.cancelled', async () => {
    const { run_id } = (await (await start(h, { input: 'TRAP please' })).json()) as { run_id: string };
    await waitFor(() => h.calls().length === 1 && existsPid('child.pid'));
    const child = Number(readFileSync(join(h.dir, 'child.pid'), 'utf8'));
    const self = Number(readFileSync(join(h.dir, 'self.pid'), 'utf8'));
    expect(alive(child) && alive(self)).toBe(true);
    const stopped = await fetch(`${h.bridge.url}/p/default/v1/runs/${run_id}/stop`, { method: 'POST', headers: auth });
    expect(stopped.status).toBe(200);
    const evs = await events(h, run_id);
    expect(evs.at(-1)!.data['event']).toBe('run.cancelled');
    await waitFor(() => !alive(child) && !alive(self));
    expect(await getRun(h, run_id)).toMatchObject({ status: 'cancelled' });
  });

  it('kills a run at its budget and says so', async () => {
    const { run_id } = (await (await start(h, { input: 'SLOW', manythreads: { budgetSeconds: 0.3 } })).json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(evs.at(-1)!.data).toMatchObject({ event: 'run.failed', error: 'budget exceeded' });
    const child = Number(readFileSync(join(h.dir, 'child.pid'), 'utf8'));
    await waitFor(() => !alive(child));
  });

  it('fails a run that goes past its turn limit', async () => {
    const { run_id } = (await (await start(h, { input: 'hello', manythreads: { maxTurns: 1 } })).json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(evs.at(-1)!.data).toMatchObject({ event: 'run.failed', error: 'turn limit exceeded' });
  });
});

function existsPid(name: string): boolean {
  try {
    readFileSync(join(process.env['FAKE_CLI_DIR']!, name), 'utf8');
    return true;
  } catch {
    return false;
  }
}

describe('child environment, output, leftovers and hostile input', () => {
  it('hands the child only the allowlist, the profile env and passEnv', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_should_not_reach_child';
    process.env['PASSED_VAR'] = 'yes';
    const h2 = await harness({
      profiles: { default: { agent: 'claude-code', workdir: join(h.dir, 'w2'), passEnv: ['FAKE_CLI_DIR', 'PASSED_VAR'], env: { KUBECONFIG: '/home/bridge/.kube/deployer' } } },
    });
    try {
      const { run_id } = (await (await start(h2, { input: 'hello' })).json()) as { run_id: string };
      await events(h2, run_id);
      const call = h2.calls().at(-1)!;
      expect(call['githubToken']).toBeNull();
      expect(call['envKeys']).not.toContain('GITHUB_TOKEN');
      expect(call['envKeys']).not.toContain('AGENT_BRIDGE_API_KEY');
      expect(call['kube']).toBe('/home/bridge/.kube/deployer');
      expect(call['passed']).toBe('yes');
      expect(call['envKeys']).toContain('PATH');
    } finally {
      delete process.env['GITHUB_TOKEN'];
      delete process.env['PASSED_VAR'];
      await h2.close();
    }
  });

  it('refuses reserved names in env and passEnv', () => {
    const base = { agent: 'codex', workdir: '/x' };
    expect(() => parseConfig({ profiles: { a: { ...base, env: { MANYTHREADS_RUN_TOKEN: 'x' } } } })).toThrow(/env/);
    expect(() => parseConfig({ profiles: { a: { ...base, passEnv: ['AGENT_BRIDGE_API_KEY'] } } })).toThrow(/passEnv/);
    expect(() => parseConfig({ profiles: { a: { ...base, passEnv: ['bad name'] } } })).toThrow(/passEnv/);
  });

  it('redacts the run token from the final output', async () => {
    const { run_id } = (await (await start(h, { input: 'ECHOTOKEN', manythreads: { mcp } })).json()) as { run_id: string };
    const evs = await events(h, run_id);
    const done = evs.at(-1)!.data;
    expect(done['event']).toBe('run.completed');
    expect(done['output']).toBe('Done. token=[hidden]');
    expect(JSON.stringify(await getRun(h, run_id))).not.toContain(mcp.token);
  });

  it('kills what a tool left running once the run ends normally', async () => {
    const { run_id } = (await (await start(h, { input: 'BGPROC' })).json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(evs.at(-1)!.data['event']).toBe('run.completed');
    const bg = Number(readFileSync(join(h.dir, 'bg.pid'), 'utf8'));
    await waitFor(() => !alive(bg));
  });

  it('arms the kill timer for a child that starts after a stop was requested', async () => {
    const fake = join(h.dir, 'late.mjs');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(fake, "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);");
    const manager = new RunManager({
      config: h.config,
      sessions: new SessionStore(join(h.dir, 'state2')),
      log: () => undefined,
      tmpRoot: h.dir,
      drivers: {
        'claude-code': {
          async run(job) {
            while (!job.stopped()) await new Promise((r) => setTimeout(r, 10));
            const child = job.start(process.execPath, [fake], { cwd: job.profile.workdir, env: job.baseEnv(), stdin: '', onLine: () => undefined });
            const end = await child.done;
            return { ok: false, error: String(end.signal) };
          },
        },
      },
    });
    const { run } = manager.create('default', { input: 'x', sessionId: null, instructions: null, manythreads: { tools: [], mcp: null, model: { alias: null, effort: null }, budgetSeconds: null, maxTurns: null } } as never, 'x', null);
    manager.stop(run);
    await waitFor(() => run.status !== 'running');
    expect(run.status).toBe('cancelled');
    manager.close();
  });

  it('ignores a tool grant named like an Object property', () => {
    expect(claudeToolFlags(['constructor', '__proto__', 'toString', 'files']).tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit']);
  });
});

describe('server hardening', () => {
  it('answers 429 after too many failed sign-ins from one address, then ignores even a good key', async () => {
    const h2 = await harness({}, 'claude-code', { authFailLimit: 5 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await fetch(`${h2.bridge.url}/health`, { headers: { authorization: 'Bearer wrong' } })).status);
      expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
      expect((await fetch(`${h2.bridge.url}/health`, { headers: auth })).status).toBe(429);
    } finally {
      await h2.close();
    }
  });

  it('drops a connection that is slow to send its headers', async () => {
    const h2 = await harness({}, 'claude-code', { headersTimeoutMs: 300 });
    try {
      const sock = net.connect(h2.bridge.port, '127.0.0.1');
      sock.write('GET /health HTTP/1.1\r\nhost: x\r\n'); // never finished
      const closed = await new Promise<boolean>((resolve) => {
        sock.on('close', () => resolve(true));
        sock.on('data', () => undefined);
        setTimeout(() => resolve(false), 4000);
      });
      expect(closed).toBe(true);
    } finally {
      await h2.close();
    }
  });

  it('answers 408 when a request body never arrives, but leaves event streams open', async () => {
    const h2 = await harness({}, 'claude-code', { bodyTimeoutMs: 300 });
    try {
      const sock = net.connect(h2.bridge.port, '127.0.0.1');
      sock.write(`POST /p/default/v1/runs HTTP/1.1\r\nhost: x\r\nauthorization: Bearer ${KEY}\r\ncontent-length: 50\r\ncontent-type: application/json\r\n\r\n{`);
      let text = '';
      sock.on('data', (d) => (text += String(d)));
      await waitFor(() => text.includes('408'));
      sock.destroy();
      const { run_id } = (await (await start(h2, { input: 'SLOW' })).json()) as { run_id: string };
      const frames = await events(h2, run_id, '', 'default', 1); // stays open past the body timeout
      expect(frames.length).toBe(1);
      await new Promise((r) => setTimeout(r, 500));
      await fetch(`${h2.bridge.url}/p/default/v1/runs/${run_id}/stop`, { method: 'POST', headers: auth });
    } finally {
      await h2.close();
    }
  });
});
