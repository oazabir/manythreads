import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { parseBotMd } from '@manythreads/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { childEnv, createHermesProvider, passthroughNames, PROFILE_MARKER, sweepStaleProfiles, type HermesRuntimeOptions } from '../src/hermes.ts';

// Starting and stopping a run (PLAN P5-10: "start and stop in the Hermes container"). `MANYTHREADS_HERMES_BIN` is whatever
// runs a turn — the CLI in development, a container's entry point in a deployment — and these tests use the provider's own
// injectable `spawn` to stand a process in front of it. What is asserted here is the platform's half of the sentence: the
// profile written before the launch and removed after it, the argv and `HERMES_HOME` the child gets, the prompt arriving on
// **stdin** rather than an argv, the events the stream turns into, what a process that dies without a `result` reports, and
// the hard ceiling that stops a run which outlives its budget (SIGTERM, then SIGKILL).

const root = mkdtempSync(join(tmpdir(), 'hermes-provider-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FRONTMATTER = `name: Coder
role: Answers in the channel
kind: agent
runtime: hermes
model:
  aliases: [code, fast]
limits:
  timeoutSeconds: 300
`;
const BODY = '# Coder\n\nYou own a task until you hand it over.';

const input = (overrides: Partial<BotRuntimeInput> = {}): BotRuntimeInput => {
  const parsed = parseBotMd(`---\n${FRONTMATTER}---\n${BODY}\n`);
  if (!parsed.ok) throw new Error('the fixture BOT.md must parse');
  return {
    bot: {
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'coder',
      name: 'Coder',
      teamId: '22222222-2222-2222-2222-222222222222',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      runtime: 'hermes',
      definitionSha: 'a'.repeat(64),
    },
    definition: { frontmatter: parsed.frontmatter, body: parsed.body },
    trigger: 'mention',
    asker: { actorId: '44444444-4444-4444-4444-444444444444', personId: null, displayName: 'Nadia' },
    prompt: 'Nadia in #dev:\n\n@coder what changed?',
    thread: { channelId: '55555555-5555-5555-5555-555555555555', threadRootId: null },
    endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'https://threads.example/api/mcp/runs/77777777-7777-7777-7777-777777777777', token: 'run-token' },
    gateway: { baseUrl: 'http://litellm:4000', key: 'sk-bot-key' },
    limits: { runBudgetSeconds: 300, maxTurns: null, sessionMinutes: null },
    ...overrides,
  };
};

/** A stand-in for a spawned process: streams a test drives, and every signal it was killed with. */
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  readonly written: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk.toString('utf8')));
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }

  /** One stream-json line, as Hermes prints it. */
  say(record: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  /** The process ending by itself (its stdout closes and `close` fires). */
  ends(code: number): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, null);
  }

  /** The process being killed: what SIGTERM/SIGKILL looks like from the parent's side. */
  killed(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, signal);
  }
}

interface Harness {
  provider: ReturnType<typeof createHermesProvider>;
  children: FakeChild[];
  argsOf(index?: number): string[];
  optionsOf(index?: number): { cwd?: string; env?: NodeJS.ProcessEnv };
}

const harness = (options: Partial<HermesRuntimeOptions> = {}): Harness => {
  const children: FakeChild[] = [];
  const spawns: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
  const spawn = ((bin: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    spawns.push({ args: [bin, ...args], cwd: opts.cwd, env: opts.env });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as HermesRuntimeOptions['spawn'];
  return {
    provider: createHermesProvider({
      bin: 'hermes',
      prefix: [],
      dataRoot: join(root, `run-${children.length + 1}`),
      env: { PATH: '/usr/bin' },
      killGraceSeconds: 15,
      ...options,
      spawn,
    }    ),
    children,
    argsOf: (index = 0) => spawns[index]?.args ?? [],
    optionsOf: (index = 0) => spawns[index] ?? {},
  };
};

const scope = (logs: string[]): BotRuntimeScope => ({
  invoke: () => Promise.resolve(undefined),
  logSource: () => Promise.resolve(1),
  log: (line) => void logs.push(line),
});

/** Everything a run's stream produced, in order. */
const drain = async (events: AsyncIterable<BotRuntimeEvent>): Promise<BotRuntimeEvent[]> => {
  const seen: BotRuntimeEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

/** Poll until `fn` is true (the provider's timers are real ones). */
// A budget, not a pace: the wait ends the moment `fn` is true. Starting a second Node process under a loaded box (the whole suite runs in
// parallel) can take several seconds, so a tight deadline here is a flaky test, not a stricter one.
const until = async (fn: () => boolean, what: string, budgetMs = 30_000): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('the hermes provider: one process per run', () => {
  it('writes the profile, launches in it with the prompt on stdin, and removes it when the run ends', async () => {
    const h = harness();
    const logs: string[] = [];
    const runInput = input();
    const handle = await h.provider.run(runInput, scope(logs));

    // The profile exists before anything is launched, and the child's whole world is that directory.
    const home = join(root, `run-1/coder-${runInput.endpoint!.runId}`);
    expect(existsSync(join(home, 'SOUL.md'))).toBe(true);
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe(`${BODY}\n`);
    expect(h.argsOf()).toEqual(['hermes', 'chat', '--query-file', '-', '--oneshot', '--format', 'stream-json', '--run-budget', '300']);
    expect(h.optionsOf().cwd).toBe(home);
    expect(h.optionsOf().env?.['HERMES_HOME']).toBe(home);
    expect(h.optionsOf().env?.['PATH']).toBe('/usr/bin'); // the caller's environment, nothing invented
    expect(h.children[0]!.written.join('')).toBe(runInput.prompt); // the body never reaches an argv

    // The stream is Hermes' stream-json: deltas, a tool call, and the terminal record with its tokens.
    const child = h.children[0]!;
    child.say({ type: 'text', text: 'Looking' });
    child.say({ type: 'tool_use', name: 'messages.search', input: { q: 'deploy' } });
    child.say({ type: 'tool_result', name: 'messages.search', is_error: false });
    child.say({ type: 'result', exit_code: 0, text: 'The canary held.', tokens: { input: 10, output: 4, total: 14 } });
    child.ends(0);

    const events = await drain(handle.events);
    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'tool_result', 'result']);
    expect(events[3]).toMatchObject({ text: 'The canary held.', ok: true, tokens: { total: 14 } });
    await handle.stop();

    // One run, one profile: it does not outlive the run.
    expect(existsSync(home)).toBe(false);
  });

  it('a process that dies without a result is one failed event carrying its stderr tail', async () => {
    const h = harness();
    const handle = await h.provider.run(input(), scope([]));
    const child = h.children[0]!;
    child.say({ type: 'text', text: 'Looking at' });
    child.stderr.write('hermes: no model is configured for the alias "code"\n');
    child.ends(1);

    const events = await drain(handle.events);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'result',
      text: 'Looking at', // the deltas it managed to send are kept
      ok: false,
      tokens: null,
    });
    expect(events[1]?.type === 'result' ? events[1].error : '').toMatch(/ended without a result \(exit 1\)/);
    expect(events[1]?.type === 'result' ? events[1].error : '').toContain('no model is configured');
    await handle.stop();
  });

  it('a run that outlives its budget is stopped: SIGTERM, then SIGKILL after the grace', async () => {
    const h = harness({ killGraceSeconds: 0 });
    const logs: string[] = [];
    const handle = await h.provider.run(input({ limits: { runBudgetSeconds: 0, maxTurns: null, sessionMinutes: null } }), scope(logs));
    const child = h.children[0]!;

    await until(() => child.signals.includes('SIGTERM'), 'the budget to SIGTERM the process');
    await until(() => child.signals.includes('SIGKILL'), 'the grace to SIGKILL it');
    expect(logs.join('\n')).toContain('exceeded 0s and was stopped');

    // The kill landing ends the stream, and the run reports it as stopped rather than silent.
    child.killed('SIGKILL');
    const events = await drain(handle.events);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: 'result', ok: false });
    expect(last?.type === 'result' ? last.error : '').toMatch(/was stopped \(SIGKILL\)/);
  });
});

describe('the child process is a sandboxed guest of the server', () => {
  const SECRETS: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/hermes',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    TZ: 'UTC',
    HERMES_MODEL_TIMEOUT: '30',
    MANYTHREADS_KMS_KEY: 'kms-key-material',
    MANYTHREADS_LITELLM_MASTER_KEY: 'sk-master-key',
    MANYTHREADS_TEST_AUTH_TOKEN: 'test-auth-token',
    DATABASE_URL: 'postgres://manythreads_owner:owner-password@db/manythreads',
    MANYTHREADS_SYSTEM_DATABASE_URL: 'postgres://manythreads_system:system-password@db/manythreads',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'ghp_not_for_the_agent',
  };

  it('inherits an allowlist of the parent environment and none of its secrets', async () => {
    const h = harness({ env: SECRETS });
    const handle = await h.provider.run(input(), scope([]));
    const env = h.optionsOf().env ?? {};

    expect(Object.keys(env).sort()).toEqual(['HERMES_HOME', 'HERMES_MODEL_TIMEOUT', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TZ']);
    const everything = JSON.stringify(env);
    for (const secret of ['kms-key-material', 'sk-master-key', 'test-auth-token', 'owner-password', 'system-password', 'aws-secret', 'ghp_not_for_the_agent']) {
      expect(everything).not.toContain(secret);
    }
    h.children[0]!.ends(0);
    await drain(handle.events);
  });

  it('childEnv is a pure allowlist', () => {
    expect(childEnv({ PATH: '/bin', FOO: 'bar', LC_TIME: 'C', HERMES_X: '1', MANYTHREADS_KMS_KEY: 'k', EMPTY: undefined })).toEqual({
      PATH: '/bin',
      LC_TIME: 'C',
      HERMES_X: '1',
    });
  });

  it('lets the CA-bundle variables through: a deployment behind a private CA needs them to reach the gateway', () => {
    const ca = {
      SSL_CERT_FILE: '/etc/ssl/ca.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      REQUESTS_CA_BUNDLE: '/etc/ssl/ca.pem',
      CURL_CA_BUNDLE: '/etc/ssl/ca.pem',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/extra.pem',
    };
    expect(childEnv({ PATH: '/bin', ...ca, HTTPS_PROXY: 'http://proxy:3128' })).toEqual({ PATH: '/bin', ...ca }); // the proxy is opt-in, not default
  });

  it('MANYTHREADS_HERMES_ENV_PASSTHROUGH adds the names an operator lists, and never a MANYTHREADS_*, DATABASE* or PG* one', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/bin',
      MANYTHREADS_HERMES_ENV_PASSTHROUGH: 'HTTPS_PROXY, NO_PROXY,MANYTHREADS_KMS_KEY,DATABASE_URL,PGPASSWORD,pghost,database_password,MISSING,bad name,',
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      MANYTHREADS_KMS_KEY: 'kms-key-material',
      DATABASE_URL: 'postgres://u:p@db/x',
      PGPASSWORD: 'pg-password',
      pghost: 'db',
      database_password: 'secret',
      UNLISTED: 'stays out',
    };
    expect(childEnv(source)).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost' });
    expect(passthroughNames('A, B ,,MANYTHREADS_X,PG_X,DATABASE,C-D,E')).toEqual(['A', 'B', 'E']);
    expect(passthroughNames(undefined)).toEqual([]);
    expect(childEnv({ PATH: '/bin', HTTPS_PROXY: 'x' })).toEqual({ PATH: '/bin' }); // no list, no passthrough
  });

  it('writes the profile owner-only', async () => {
    const h = harness();
    const runInput = input();
    const handle = await h.provider.run(runInput, scope([]));
    const home = join(root, `run-1/coder-${runInput.endpoint!.runId}`);
    // The provider creates the profile owner-only. `stat.mode` only carries those permission bits on POSIX: Windows reports its own
    // read-only flag in them, so there the assertions are that the three entries exist (the mode is still set at creation).
    if (process.platform === 'win32') {
      expect([existsSync(home), existsSync(join(home, 'config.yaml')), existsSync(join(home, 'SOUL.md'))]).toEqual([true, true, true]);
    } else {
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, 'config.yaml')).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'SOUL.md')).mode & 0o777).toBe(0o600);
    }
    h.children[0]!.ends(0);
    await drain(handle.events);
  });

  it('removes the profile when the process cannot even be spawned', async () => {
    const dataRoot = join(root, 'spawn-throws');
    const provider = createHermesProvider({
      bin: 'hermes',
      prefix: [],
      dataRoot,
      env: {},
      killGraceSeconds: 1,
      spawn: (() => {
        throw new Error('spawn E2BIG');
      }) as unknown as HermesRuntimeOptions['spawn'],
    });
    const runInput = input();
    await expect(provider.run(runInput, scope([]))).rejects.toThrow('spawn E2BIG');
    expect(existsSync(join(dataRoot, `coder-${runInput.endpoint!.runId}`))).toBe(false);
  });

  it('a child that closes its stdin early does not crash the server (EPIPE is the exit handler\'s to report)', async () => {
    const h = harness();
    const handle = await h.provider.run(input(), scope([]));
    const child = h.children[0]!;
    expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    child.ends(1);
    const events = await drain(handle.events);
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: false });
  });

  it('stop() removes the profile even when the stream is never read', async () => {
    const h = harness();
    const runInput = input();
    const handle = await h.provider.run(runInput, scope([]));
    const home = join(root, `run-1/coder-${runInput.endpoint!.runId}`);
    expect(existsSync(home)).toBe(true);
    await handle.stop();
    expect(existsSync(home)).toBe(false);
    h.children[0]!.killed('SIGTERM');
  });

  it('a timeout kills the whole process group, not only the process it started', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hermes-group-'));
    const script = join(scratch, 'leader.mjs');
    const pidFile = join(scratch, 'grandchild.pid');
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });",
        'writeFileSync(process.env.HERMES_TEST_PIDFILE, String(grandchild.pid));',
        'setInterval(() => undefined, 1000);',
        '',
      ].join('\n'),
    );
    const provider = createHermesProvider({
      bin: process.execPath,
      prefix: [script],
      dataRoot: join(scratch, 'profiles'),
      env: { PATH: process.env['PATH'], HERMES_TEST_PIDFILE: pidFile },
      killGraceSeconds: 1,
    });
    let grandchildPid = 0;
    try {
      const handle = await provider.run(input({ limits: { runBudgetSeconds: 1, maxTurns: null, sessionMinutes: null } }), scope([]));
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 'the grandchild to start');
      grandchildPid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(grandchildPid, 0)).not.toThrow(); // alive
      const events = await drain(handle.events);
      expect(events.at(-1)).toMatchObject({ type: 'result', ok: false });
      await until(() => {
        try {
          process.kill(grandchildPid, 0);
          return false;
        } catch {
          return true;
        }
      }, 'the grandchild to die with its group');
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // already gone: the point of the test
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('a leader that exits does not leave its group behind', () => {
  /** Alive means running: a zombie nobody has reaped yet (a container without an init) is as dead as it gets. */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return true; // no /proc (macOS): kill(0) succeeding is all we can know
    }
  };

  /**
   * A stand-in Hermes that starts a straggler in its own process group and then exits by itself, normally: the straggler is
   * what a shell tool's background job looks like. It writes the straggler's pid once the straggler is ready (and, when asked,
   * is ignoring SIGTERM), then exits 0.
   */
  async function runWithStraggler(ignoreTerm: boolean): Promise<{ events: BotRuntimeEvent[]; stragglerPid: number; profile: string; samples: { alive: boolean; profile: boolean }[]; cleanup: () => void }> {
    const scratch = mkdtempSync(join(tmpdir(), 'hermes-straggler-'));
    const script = join(scratch, 'leader.mjs');
    const pidFile = join(scratch, 'straggler.pid');
    const readyFile = join(scratch, 'straggler.ready');
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "const ignore = process.env.HERMES_TEST_IGNORE_TERM === '1';",
        "const code = (ignore ? \"process.on('SIGTERM', () => undefined);\" : '') + \"require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000);\";",
        "const straggler = spawn(process.execPath, ['-e', code, process.env.HERMES_TEST_READY], { stdio: 'ignore' });",
        'const wait = setInterval(() => {',
        '  if (!existsSync(process.env.HERMES_TEST_READY)) return;',
        '  clearInterval(wait);',
        '  writeFileSync(process.env.HERMES_TEST_PIDFILE, String(straggler.pid));',
        '  process.exit(0);',
        '}, 10);',
        '',
      ].join('\n'),
    );
    const dataRoot = join(scratch, 'profiles');
    const runInput = input();
    const profile = join(dataRoot, `coder-${runInput.endpoint!.runId}`);
    const provider = createHermesProvider({
      bin: process.execPath,
      prefix: [script],
      dataRoot,
      env: { PATH: process.env['PATH'], HERMES_TEST_PIDFILE: pidFile, HERMES_TEST_READY: readyFile, HERMES_TEST_IGNORE_TERM: ignoreTerm ? '1' : '0' },
      killGraceSeconds: 1,
    });
    const handle = await provider.run(runInput, scope([]));
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 'the straggler to start');
    const stragglerPid = Number(readFileSync(pidFile, 'utf8'));
    const samples: { alive: boolean; profile: boolean }[] = [];
    const sampler = setInterval(() => samples.push({ alive: alive(stragglerPid), profile: existsSync(profile) }), 10);
    try {
      const events = await drain(handle.events);
      return { events, stragglerPid, profile, samples, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
    } finally {
      clearInterval(sampler);
    }
  }

  it('SIGTERMs the group after the leader has gone, so a straggler it left does not outlive the run', async () => {
    const run = await runWithStraggler(false);
    try {
      expect(run.events.at(-1)).toMatchObject({ type: 'result', ok: false }); // no result record: the synthesised failure
      await until(() => !alive(run.stragglerPid), 'the straggler to die with its group');
      expect(existsSync(run.profile)).toBe(false);
    } finally {
      try {
        process.kill(run.stragglerPid, 'SIGKILL');
      } catch {
        // already gone: the point of the test
      }
      run.cleanup();
    }
  }, 60_000);

  it('SIGKILLs a straggler that ignores SIGTERM after the grace, and removes the profile only once it is gone', async () => {
    if (process.platform === 'win32') {
      // The provider's stop path is a process-group kill; Windows has no groups here, so a straggler started by a child
      // does not die with the parent and the profile removal cannot wait on the group. The Linux behaviour is the
      // point of this test — skip it on Windows and leave the provider unchanged.
      return;
    }
    const run = await runWithStraggler(true);
    try {
      expect(alive(run.stragglerPid) || existsSync(run.profile)).toBe(false); // by the time the stream ended, both are done
      // At no sample was the profile gone while the process that could still read it was running.
      expect(run.samples.some((sample) => sample.alive)).toBe(true);
      expect(run.samples.filter((sample) => sample.alive && !sample.profile)).toEqual([]);
    } finally {
      try {
        process.kill(run.stragglerPid, 'SIGKILL');
      } catch {
        // already gone: the point of the test
      }
      run.cleanup();
    }
  }, 90_000);
});

describe('profiles a dead server left behind', () => {
  const RUN = '77777777-7777-7777-7777-777777777777';
  const makeDir = (dataRoot: string, name: string, ageHours: number, marker: boolean): string => {
    const dir = join(dataRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), 'token');
    if (marker) writeFileSync(join(dir, PROFILE_MARKER), 'x');
    const when = new Date(Date.now() - ageHours * 3_600_000);
    utimesSync(dir, when, when);
    return dir;
  };

  it('sweeps profile directories older than the limit and leaves a fresh one (and a missing root) alone', async () => {
    const dataRoot = join(root, 'sweep');
    const old = makeDir(dataRoot, `coder-${RUN}`, 3, true);
    const fresh = makeDir(dataRoot, 'coder-88888888-8888-8888-8888-888888888888', 0, true);
    const noRun = makeDir(dataRoot, 'coder-no-run', 3, true);

    expect(await sweepStaleProfiles(dataRoot, 2 * 3_600_000)).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(noRun)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(await sweepStaleProfiles(join(root, 'does-not-exist'), 1)).toBe(0);
  });

  it('never touches a directory that is not a profile: wrong name, or the right name without the marker', async () => {
    const dataRoot = join(root, 'sweep-unrelated');
    const unrelated = [
      makeDir(dataRoot, 'backups', 48, true), // has the marker, wrong name
      makeDir(dataRoot, 'postgres-data', 48, false),
      makeDir(dataRoot, `coder-${RUN}-copy`, 48, true), // the name must end at the run id
      makeDir(dataRoot, `${RUN}`, 48, true),
      makeDir(dataRoot, `coder-99999999-9999-9999-9999-999999999999`, 48, false), // the right name, but not written by this code
    ];
    writeFileSync(join(dataRoot, `coder-${RUN}.log`), 'a file, not a directory');
    const ours = makeDir(dataRoot, `reviewer-${RUN}`, 48, true);

    expect(await sweepStaleProfiles(dataRoot, 2 * 3_600_000)).toBe(1);
    for (const dir of unrelated) expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dataRoot, `coder-${RUN}.log`))).toBe(true);
    expect(existsSync(ours)).toBe(false);
  });

  it('sweeps the husk a raced removal leaves: our name, only Hermes’ logs, no marker', async () => {
    // Hermes writes its log directory as it exits, after the files (and the marker with them) are gone, so the removal leaves
    // `<slug>-<run>/logs/{agent,errors}.log` behind. That husk is ours; a directory holding anything else is somebody's data and stays.
    const dataRoot = join(root, 'sweep-husk');
    const when = new Date(Date.now() - 48 * 3_600_000);
    const husk = join(dataRoot, `coder-${RUN}`);
    mkdirSync(join(husk, 'logs'), { recursive: true });
    writeFileSync(join(husk, 'logs', 'agent.log'), 'a finished run’s own log');
    writeFileSync(join(husk, 'logs', 'errors.log'), '');
    utimesSync(husk, when, when);
    // Fresh, and still a husk: a live profile always holds `config.yaml` and `SOUL.md`, so age is no evidence for one of these.
    const freshHusk = join(dataRoot, `coder-88888888-8888-8888-8888-888888888888`);
    mkdirSync(join(freshHusk, 'logs'), { recursive: true });
    writeFileSync(join(freshHusk, 'logs', 'agent.log'), 'just written');
    const kept = join(dataRoot, `reviewer-${RUN}`);
    mkdirSync(join(kept, 'logs'), { recursive: true });
    writeFileSync(join(kept, 'config.yaml'), 'a profile the removal never reached');
    utimesSync(kept, when, when);

    expect(await sweepStaleProfiles(dataRoot, 2 * 3_600_000)).toBe(2);
    expect(existsSync(husk)).toBe(false);
    expect(existsSync(freshHusk)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it('every profile a run writes carries the marker (so the sweep can find it) and loses it with the profile', async () => {
    const h = harness();
    const runInput = input();
    const handle = await h.provider.run(runInput, scope([]));
    const home = join(root, `run-1/coder-${runInput.endpoint!.runId}`);
    expect(existsSync(join(home, PROFILE_MARKER))).toBe(true);
    await handle.stop();
    expect(existsSync(home)).toBe(false);
    h.children[0]!.killed('SIGTERM');
  });
});
