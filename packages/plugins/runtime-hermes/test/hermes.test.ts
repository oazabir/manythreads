import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { parseBotMd } from '@manythreads/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createHermesProvider, type HermesRuntimeOptions } from '../src/hermes.ts';

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
    endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'https://threads.example/api/mcp/runs/run-token', token: 'run-token' },
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
const until = async (fn: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
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
