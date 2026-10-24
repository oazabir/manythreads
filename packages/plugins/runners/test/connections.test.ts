import type { PluginContext, PluginSocket, RunnerDispatch } from '@manythreads/sdk';
import { RunnerUnavailableError } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { LineChannel } from '../src/channel.ts';
import { ConnectionRegistry, serveRunnerSocket } from '../src/connections.ts';
import { createRunnerDoor } from '../src/door.ts';
import { bearerRunnerToken, hashRunnerToken, newRunnerToken } from '../src/tokens.ts';

// The server's half of the runner protocol without a database or a network: a fake socket and a fake transaction. What is pinned here is what an
// integration run cannot show cheaply: the stop frame reaching the runner, a long line joined from its pieces, a full runner, a replaced
// connection, a late frame, and the token helpers.

const TEAM = '22222222-2222-4222-8222-222222222222';
const RUNNER = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';
const RUN = '55555555-5555-4555-8555-555555555555';
const TOKEN = newRunnerToken();

class FakeSocket implements PluginSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private onMessage: ((d: string | Uint8Array) => void) | undefined;
  private onClose: (() => void) | undefined;
  send(data: string | Uint8Array): void {
    this.sent.push(JSON.parse(String(data)) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    this.onClose?.();
  }
  on(event: 'message' | 'close' | 'error', listener: never): void {
    if (event === 'message') this.onMessage = listener;
    if (event === 'close') this.onClose = listener;
  }
  /** What the runner says. */
  say(frame: unknown): void {
    this.onMessage?.(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }
  async nextSent(type: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const found = this.sent.find((f) => f['type'] === type);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${type} frame; sent: ${JSON.stringify(this.sent)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

interface Harness {
  ctx: PluginContext;
  registry: ConnectionRegistry;
  queries: string[];
  events: Record<string, unknown>[];
  live: { value: boolean };
}

function harness(): Harness {
  const queries: string[] = [];
  const events: Record<string, unknown>[] = [];
  const live = { value: true };
  const tx = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('FROM app.runner_tokens k')) {
        return { rows: [{ token_id: 'tok-1', runner_id: RUNNER, name: 'host-1', team_id: TEAM, slug: 'engineering', workspace_id: WS }] };
      }
      if (sql.includes('FROM app.runner_tokens WHERE id')) return { rows: live.value ? [{ '?column?': 1 }] : [] };
      if (sql.includes('FROM app.teams t LEFT JOIN app.runners')) return { rows: [{ workspace_id: WS, runner_id: null, last_seen_at: null }] };
      if (sql.includes('SELECT workspace_id FROM app.teams')) return { rows: [{ workspace_id: WS }] };
      return { rows: [] };
    },
  };
  const ctx = {
    db: { system: async (fn: (t: typeof tx) => unknown) => fn(tx) },
    audit: { emit: async (_tx: unknown, event: Record<string, unknown>) => void events.push(event) },
    runtime: { publicUrl: 'http://x', now: () => new Date('2026-01-01T00:00:00Z') },
  } as unknown as PluginContext;
  return { ctx, registry: new ConnectionRegistry(), queries, events, live };
}

const hello = (maxJobs = 2) => ({ type: 'hello', protocol: 1, version: '0.1.0', host: 'box', capabilities: ['docker', 'hermes'], maxJobs });

async function connect(h: Harness, token: string | null = TOKEN): Promise<FakeSocket> {
  const socket = new FakeSocket();
  const serving = serveRunnerSocket(h.ctx, h.registry, socket, {
    params: {}, query: {}, body: undefined, ip: '127.0.0.1', caller: null,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
  // a runner says hello the moment the socket opens, before the token has been looked up
  socket.say(hello());
  await serving;
  return socket;
}

const job = (runId = RUN) => ({
  runId, profile: { home: `coder-${runId}`, files: { 'config.yaml': 'a: 1' } }, prompt: 'hi', runBudgetSeconds: 60, maxTurns: null, killGraceSeconds: 5,
});

describe('connecting', () => {
  it('holds a hello that arrives before the token is resolved, then welcomes the runner and records it', async () => {
    const h = harness();
    const socket = await connect(h);
    const welcome = await socket.nextSent('welcome');
    expect(welcome).toMatchObject({ type: 'welcome', runnerId: RUNNER, name: 'host-1', teamSlug: 'engineering', heartbeatSeconds: 20 });
    expect(h.registry.get(TEAM, 'host-1')).toBeDefined();
    expect(h.queries.some((q) => q.startsWith("UPDATE app.runners SET status = 'online'"))).toBe(true);
    expect(h.events.map((e) => e['type'])).toEqual(['runners.runner.connected']);
    expect(h.events[0]).toMatchObject({ name: 'host-1', capabilities: ['docker', 'hermes'], maxJobs: 2 });
  });

  it('closes a socket without a runner token (1008) and registers nothing', async () => {
    const h = harness();
    const socket = await connect(h, null);
    expect(socket.closed).toEqual({ code: 1008, reason: 'unauthorized' });
    expect(h.registry.get(TEAM, 'host-1')).toBeUndefined();
  });

  it('closes on a frame that is not valid, on a second hello, and on a frame before hello', async () => {
    for (const bad of ['not json', { type: 'nope' }, { type: 'heartbeat', running: -1 }, { type: 'job' }]) {
      const h = harness();
      const socket = await connect(h);
      socket.say(bad);
      expect(socket.closed?.code, JSON.stringify(bad)).toBe(1008);
    }
    const h = harness();
    const socket = await connect(h);
    socket.say(hello());
    expect(socket.closed).toMatchObject({ code: 1008, reason: 'hello twice' });
    // a frame other than hello first
    const h2 = harness();
    const s2 = new FakeSocket();
    const serving = serveRunnerSocket(h2.ctx, h2.registry, s2, { params: {}, query: {}, body: undefined, ip: 'x', caller: null, headers: { authorization: `Bearer ${TOKEN}` } });
    s2.say({ type: 'heartbeat', running: 0 });
    await serving;
    expect(s2.closed).toMatchObject({ code: 1008, reason: 'hello first' });
  });

  it('a newer connection of the same runner replaces the old one, which is closed', async () => {
    const h = harness();
    const first = await connect(h);
    await first.nextSent('welcome');
    const second = await connect(h);
    await second.nextSent('welcome');
    expect(first.closed).toMatchObject({ code: 4000 });
    expect(h.registry.get(TEAM, 'host-1')).toBeDefined();
    expect(second.closed).toBeNull();
    // the old connection going away does not mark the runner offline behind the new one
    expect(h.queries.filter((q) => q.startsWith("UPDATE app.runners SET status = 'offline'"))).toHaveLength(0);
  });

  it('a heartbeat with a revoked token ends the connection', async () => {
    const h = harness();
    const socket = await connect(h);
    await socket.nextSent('welcome');
    socket.say({ type: 'heartbeat', running: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.closed).toBeNull();
    h.live.value = false;
    socket.say({ type: 'heartbeat', running: 0 });
    await new Promise((r) => setTimeout(r, 30));
    expect(socket.closed).toMatchObject({ code: 1008, reason: 'token revoked' });
    expect(h.registry.get(TEAM, 'host-1')).toBeUndefined();
    expect(h.queries.some((q) => q.startsWith("UPDATE app.runners SET status = 'offline'"))).toBe(true);
  });
});

describe('the runner door', () => {
  const dispatchOn = async (h: Harness, socket: FakeSocket, runId = RUN): Promise<RunnerDispatch> => {
    await socket.nextSent('welcome');
    return createRunnerDoor(h.ctx, h.registry).dispatch({ teamId: TEAM, runner: 'host-1', job: job(runId) });
  };

  it('sends the job frame (prompt as data) and a stop frame once', async () => {
    const h = harness();
    const socket = await connect(h);
    const dispatch = await dispatchOn(h, socket);
    const frame = await socket.nextSent('job');
    expect(frame).toMatchObject({ jobId: RUN, runId: RUN, prompt: 'hi', runBudgetSeconds: 60, killGraceSeconds: 5 });
    await dispatch.stop();
    await dispatch.stop();
    expect(socket.sent.filter((f) => f['type'] === 'stop')).toEqual([{ type: 'stop', jobId: RUN }]);
  });

  it('delivers lines in order, joins the pieces of a long line, and ends with the exit', async () => {
    const h = harness();
    const socket = await connect(h);
    const dispatch = await dispatchOn(h, socket);
    socket.say({ type: 'line', jobId: RUN, line: 'one' });
    socket.say({ type: 'line', jobId: RUN, line: 'ab', more: true });
    socket.say({ type: 'line', jobId: RUN, line: 'cd', more: true });
    socket.say({ type: 'line', jobId: RUN, line: 'ef' });
    socket.say({ type: 'exit', jobId: RUN, code: 3, signal: null, stderrTail: 'boom' });
    const lines: string[] = [];
    for await (const line of dispatch.lines) lines.push(line);
    expect(lines).toEqual(['one', 'abcdef']);
    expect(await dispatch.exited).toEqual({ code: 3, signal: null, stderrTail: 'boom' });
    // a late frame of a finished job is ignored, and a stop after the end sends nothing
    socket.say({ type: 'line', jobId: RUN, line: 'late' });
    await dispatch.stop();
    expect(socket.sent.some((f) => f['type'] === 'stop')).toBe(false);
  });

  it('a connection that drops ends the job like a killed process, with the reason', async () => {
    const h = harness();
    const socket = await connect(h);
    const dispatch = await dispatchOn(h, socket);
    socket.say({ type: 'line', jobId: RUN, line: 'half' });
    socket.close(1006, 'gone');
    const lines: string[] = [];
    for await (const line of dispatch.lines) lines.push(line);
    expect(lines).toEqual(['half']);
    const exit = await dispatch.exited;
    expect(exit.code).toBeNull();
    expect(exit.stderrTail).toContain('disconnected');
  });

  it('refuses at once, with a reason and an event, when the runner is not connected, unknown, or full', async () => {
    const h = harness();
    const door = createRunnerDoor(h.ctx, h.registry);
    const err = await door.dispatch({ teamId: TEAM, runner: 'nobody', job: job() }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerUnavailableError);
    expect((err as RunnerUnavailableError).reason).toContain('no runner called "nobody"');
    expect(h.events.at(-1)).toMatchObject({ type: 'runners.job.refused', runner: 'nobody', runId: RUN, teamId: TEAM });

    const socket = new FakeSocket();
    const serving = serveRunnerSocket(h.ctx, h.registry, socket, { params: {}, query: {}, body: undefined, ip: 'x', caller: null, headers: { authorization: `Bearer ${TOKEN}` } });
    socket.say(hello(1));
    await serving;
    await socket.nextSent('welcome');
    await door.dispatch({ teamId: TEAM, runner: 'host-1', job: job() });
    const full = await door.dispatch({ teamId: TEAM, runner: 'host-1', job: job('66666666-6666-4666-8666-666666666666') }).then(() => null, (e: unknown) => e);
    expect((full as RunnerUnavailableError).reason).toContain('is full');
    // a runner of another team with the same name is not reachable through this team's id
    const other = await door.dispatch({ teamId: '99999999-9999-4999-8999-999999999999', runner: 'host-1', job: job('77777777-7777-4777-8777-777777777777') }).then(() => null, (e: unknown) => e);
    expect(other).toBeInstanceOf(RunnerUnavailableError);
  });
});

describe('failures that must not take the server down or hold a job forever', () => {
  it('a database error while resolving the token closes the socket 1011 instead of rejecting', async () => {
    const h = harness();
    (h.ctx.db as unknown as { system: () => Promise<never> }).system = () => Promise.reject(new Error('db down'));
    const socket = new FakeSocket();
    await expect(
      serveRunnerSocket(h.ctx, h.registry, socket, { params: {}, query: {}, body: undefined, ip: 'x', caller: null, headers: { authorization: `Bearer ${TOKEN}` } }),
    ).resolves.toBeUndefined();
    expect(socket.closed).toEqual({ code: 1011, reason: 'internal' });
  });

  it('a database error while opening the connection closes it 1011 and leaves nothing registered', async () => {
    const h = harness();
    const real = h.ctx.db.system.bind(h.ctx.db);
    let calls = 0;
    (h.ctx.db as unknown as { system: typeof real }).system = ((fn: never) => (++calls === 1 ? real(fn) : Promise.reject(new Error('db down')))) as typeof real;
    const socket = await connect(h);
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.closed).toMatchObject({ code: 1011 });
    expect(h.registry.get(TEAM, 'host-1')).toBeUndefined();
  });

  it('is not reachable until the welcome is sent: a dispatch before then is refused, not sent to a runner that would drop it', async () => {
    const h = harness();
    // hold the connect-time database write so the hello is in flight
    const real = h.ctx.db.system.bind(h.ctx.db);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    (h.ctx.db as unknown as { system: typeof real }).system = (async (fn: never) => { if (++calls === 2) await gate; return real(fn); }) as typeof real;
    const socket = await connect(h);
    const door = createRunnerDoor(h.ctx, h.registry);
    const early = await door.dispatch({ teamId: TEAM, runner: 'host-1', job: job() }).then(() => null, (e: unknown) => e);
    expect(early).toBeInstanceOf(RunnerUnavailableError);
    expect(socket.sent.some((f) => f['type'] === 'job')).toBe(false);
    release();
    await socket.nextSent('welcome');
    await door.dispatch({ teamId: TEAM, runner: 'host-1', job: job() });
    expect(socket.sent.filter((f) => f['type'] === 'job')).toHaveLength(1);
  });

  it('a runner that heartbeats but never exits after a stop is given up on after the grace: the job fails and the slot is freed', async () => {
    const h = harness();
    const socket = await connect(h);
    await socket.nextSent('welcome');
    const door = createRunnerDoor(h.ctx, h.registry, { backstopExtraMs: 50 });
    const dispatch = await door.dispatch({ teamId: TEAM, runner: 'host-1', job: { ...job(), killGraceSeconds: 0 } });
    const beats = setInterval(() => socket.say({ type: 'heartbeat', running: 1 }), 10);
    await dispatch.stop();
    const exit = await dispatch.exited;
    clearInterval(beats);
    expect(exit.code).toBeNull();
    expect(exit.stderrTail).toContain('did not report');
    for await (const line of dispatch.lines) void line; // the line stream ended too
    expect(h.registry.get(TEAM, 'host-1')!.jobs.size).toBe(0);
    expect(socket.sent.filter((f) => f['type'] === 'stop')).toHaveLength(1);
  });

  it('a real exit before the backstop cancels it', async () => {
    const h = harness();
    const socket = await connect(h);
    await socket.nextSent('welcome');
    const door = createRunnerDoor(h.ctx, h.registry, { backstopExtraMs: 100 });
    const dispatch = await door.dispatch({ teamId: TEAM, runner: 'host-1', job: { ...job(), killGraceSeconds: 0 } });
    await dispatch.stop();
    socket.say({ type: 'exit', jobId: RUN, code: 143, signal: null, stderrTail: 'terminated' });
    expect(await dispatch.exited).toEqual({ code: 143, signal: null, stderrTail: 'terminated' });
    await new Promise((r) => setTimeout(r, 200));
    expect((await dispatch.exited).stderrTail).toBe('terminated');
  });

  it('output the reader does not take is capped: the job is stopped and failed rather than held in memory', async () => {
    const h = harness();
    const socket = await connect(h);
    await socket.nextSent('welcome');
    const door = createRunnerDoor(h.ctx, h.registry, { maxQueuedChars: 100 });
    const dispatch = await door.dispatch({ teamId: TEAM, runner: 'host-1', job: job() });
    for (let i = 0; i < 5; i += 1) socket.say({ type: 'line', jobId: RUN, line: 'x'.repeat(40) });
    const exit = await dispatch.exited;
    expect(exit.stderrTail).toContain('more output than the server will hold');
    expect(socket.sent.filter((f) => f['type'] === 'stop')).toEqual([{ type: 'stop', jobId: RUN }]);
    expect(h.registry.get(TEAM, 'host-1')!.jobs.size).toBe(0);
  });

  it('after a line grows past its limit the rest of that line is skipped, not delivered as a line of its own', async () => {
    const h = harness();
    const socket = await connect(h);
    await socket.nextSent('welcome');
    const door = createRunnerDoor(h.ctx, h.registry);
    const dispatch = await door.dispatch({ teamId: TEAM, runner: 'host-1', job: job() });
    const piece = 'y'.repeat(2_000_000);
    for (let i = 0; i < 5; i += 1) socket.say({ type: 'line', jobId: RUN, line: piece.slice(0, 24_000), more: true });
    // push the line past RUNNER_MAX_LINE_CHARS (8 MiB) with big pieces, then finish it
    for (let i = 0; i < 400; i += 1) socket.say({ type: 'line', jobId: RUN, line: 'z'.repeat(24_000), more: true });
    socket.say({ type: 'line', jobId: RUN, line: 'TAIL-OF-THE-BAD-LINE' });
    socket.say({ type: 'line', jobId: RUN, line: 'next line' });
    socket.say({ type: 'exit', jobId: RUN, code: 0, signal: null, stderrTail: '' });
    const lines: string[] = [];
    for await (const line of dispatch.lines) lines.push(line);
    expect(lines).toEqual(['next line']);
  });
});

describe('tokens and channel', () => {
  it('a runner token is mtr_ plus 256 bits, hashed with sha256, and read only from a Bearer header', () => {
    expect(TOKEN).toMatch(/^mtr_[A-Za-z0-9_-]{43}$/);
    expect(hashRunnerToken(TOKEN)).toHaveLength(32);
    expect(hashRunnerToken(TOKEN).equals(hashRunnerToken(TOKEN))).toBe(true);
    expect(newRunnerToken()).not.toBe(TOKEN);
    expect(bearerRunnerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerRunnerToken(`Bearer   ${TOKEN}  `)).toBe(TOKEN);
    for (const bad of [undefined, '', TOKEN, `Basic ${TOKEN}`, 'Bearer sk-abc', 'Bearer mtr_short', `Bearer ${TOKEN} extra`]) expect(bearerRunnerToken(bad), String(bad)).toBeNull();
  });

  it('LineChannel delivers queued lines after the end and then finishes', async () => {
    const channel = new LineChannel();
    const iterator = channel[Symbol.asyncIterator]();
    const pending = iterator.next();
    channel.push('a');
    expect(await pending).toEqual({ value: 'a', done: false });
    channel.push('b');
    channel.end();
    channel.push('ignored');
    expect(await iterator.next()).toEqual({ value: 'b', done: false });
    expect((await iterator.next()).done).toBe(true);
  });
});
