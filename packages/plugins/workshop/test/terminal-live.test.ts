import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext } from '@manythreads/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_LIMITS, type TerminalServerFrame } from '@manythreads/shared';
import { readTerminalConfig, limitsOf } from '../src/terminal/config.ts';
import { LiveTerminal, type TerminalSink } from '../src/terminal/live.ts';
import type { PtyExit, PtyProcess } from '../src/terminal/pty.ts';
import type { PtyStarter } from '../src/terminal/pty.ts';
import { Recorder } from '../src/terminal/recorder.ts';
import { TerminalService } from '../src/terminal/service.ts';

// P7-09, the limits around one shell, with a scripted shell in place of a real one (the real one is tested in terminal-pty.test.ts). What it proves: each limit ends the shell and
// says why, the shell is ALWAYS killed, the folder is always cleaned, the record is redacted and cut at its size, and a bad frame ends the terminal.

class FakePty implements PtyProcess {
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = 0;
  paused = 0;
  resumed = 0;
  private data: Array<(t: string) => void> = [];
  private exits: Array<(i: PtyExit) => void> = [];
  write(d: string): void {
    this.written.push(d);
  }
  resize(c: number, r: number): void {
    this.sizes.push([c, r]);
  }
  pause(): void {
    this.paused += 1;
  }
  resume(): void {
    this.resumed += 1;
  }
  async kill(): Promise<void> {
    this.killed += 1;
  }
  onData(l: (t: string) => void): void {
    this.data.push(l);
  }
  onExit(l: (i: PtyExit) => void): void {
    this.exits.push(l);
  }
  print(text: string): void {
    for (const l of this.data) l(text);
  }
  exit(info: PtyExit = { code: 0, fatal: null }): void {
    for (const l of this.exits) l(info);
  }
}

class Sink implements TerminalSink {
  frames: TerminalServerFrame[] = [];
  closed: Array<[number, string]> = [];
  send(frame: TerminalServerFrame): void {
    this.frames.push(frame);
  }
  close(code: number, reason: string): void {
    this.closed.push([code, reason]);
  }
}

const config = { idleMs: 60_000, maxMs: 600_000, outputBytesPerSecond: 1_000_000, outputBytesTotal: 1_000_000, inputBytesTotal: 10_000 };
const limits = limitsOf({ ...readTerminalConfig({}), ...config, waitingMs: 60_000 });

function make(over: Partial<typeof config> = {}, redact: (t: string) => Promise<string> = async (t) => t.replace(/sk-[a-z0-9]+/g, '[redacted:key]')) {
  const pty = new FakePty();
  const sink = new Sink();
  const recorder = new Recorder(TERMINAL_LIMITS.transcriptChars, redact);
  let cleaned = 0;
  const live = new LiveTerminal({ config: { ...config, ...over }, limits, pty, sink, recorder, cleanup: async () => void (cleaned += 1), credentialsRevoked: 1 });
  live.start();
  return { pty, sink, recorder, live, cleaned: () => cleaned };
}

const key = (d: string): string => JSON.stringify({ t: 'in', d });

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveTerminal', () => {
  it('tells the page it is ready, with the limits and the number of credentials revoked', () => {
    const { sink, live } = make();
    expect(sink.frames[0]).toEqual({ t: 'ready', limits, credentialsRevoked: 1 });
    void live.end('closed');
  });

  it('passes typed keys to the shell and its output to the page and the record', async () => {
    const { pty, sink, live, recorder } = make();
    live.input(key('echo hi\n'));
    pty.print('echo hi\r\nhi\r\n');
    expect(pty.written).toEqual(['echo hi\n']);
    expect(sink.frames.slice(1)).toEqual([{ t: 'out', d: 'echo hi\r\nhi\r\n' }]);
    const end = await live.end('closed');
    expect(end.reason).toBe('closed');
    expect(recorder.text).toBe('echo hi\nhi\n');
    expect(end.bytesIn).toBe(8);
  });

  it('follows the size the page reports', () => {
    const { pty, live } = make();
    live.input(JSON.stringify({ t: 'size', cols: 120, rows: 40 }));
    expect(pty.sizes).toEqual([[120, 40]]);
    void live.end('closed');
  });

  it('kills the shell, cleans the folder and closes the socket on every kind of end', async () => {
    for (const reason of ['closed', 'ended_by_admin', 'session_ended', 'server_stop'] as const) {
      const { pty, sink, live, cleaned } = make();
      const end = await live.end(reason);
      expect(end.reason).toBe(reason);
      expect(pty.killed, reason).toBe(1);
      expect(cleaned(), reason).toBe(1);
      expect(sink.frames.at(-1)).toMatchObject({ t: 'end', reason });
      expect(sink.closed.length, reason).toBe(1);
    }
  });

  it('ends once: the first reason wins and a second end changes nothing', async () => {
    const { pty, live, cleaned } = make();
    const first = live.end('ended_by_admin');
    const second = live.end('idle');
    expect((await first).reason).toBe('ended_by_admin');
    expect((await second).reason).toBe('ended_by_admin');
    expect(pty.killed).toBe(1);
    expect(cleaned()).toBe(1);
  });

  it('ends when nothing was typed for the idle time, and a key resets that clock', async () => {
    vi.useFakeTimers();
    const { pty, live } = make({ idleMs: 1000 });
    await vi.advanceTimersByTimeAsync(800);
    live.input(key('a'));
    await vi.advanceTimersByTimeAsync(800);
    expect(live.isOver).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    const end = await live.ended;
    expect(end.reason).toBe('idle');
    expect(pty.killed).toBe(1);
  });

  it('output alone does not keep a terminal alive', async () => {
    vi.useFakeTimers();
    const { pty, live } = make({ idleMs: 1000 });
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(300);
      pty.print('tick\r\n');
    }
    expect((await live.ended).reason).toBe('idle');
  });

  it('ends at the longest time even when keys keep coming', async () => {
    vi.useFakeTimers();
    const { live } = make({ idleMs: 1000, maxMs: 3000 });
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(500);
      live.input(key('a'));
    }
    expect((await live.ended).reason).toBe('max_duration');
  });

  it('closes a shell that prints more than its total allowance', async () => {
    const { pty, live, sink } = make({ outputBytesTotal: 100 });
    pty.print('x'.repeat(60));
    expect(live.isOver).toBe(false);
    pty.print('x'.repeat(60));
    const end = await live.ended;
    expect(end.reason).toBe('output_limit');
    expect(pty.killed).toBe(1);
    expect(sink.frames.filter((f) => f.t === 'out').length).toBe(1);
  });

  it('slows a shell that prints faster than the rate, and lets it go in the next window', async () => {
    vi.useFakeTimers();
    const { pty, live } = make({ outputBytesPerSecond: 1000 });
    pty.print('x'.repeat(500));
    expect(pty.paused).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(pty.resumed).toBe(1);
    void live.end('closed');
  });

  it('closes a terminal that is sent more than its input allowance', async () => {
    const { pty, live } = make({ inputBytesTotal: 10 });
    live.input(key('123456'));
    live.input(key('789012'));
    expect((await live.ended).reason).toBe('input_limit');
    expect(pty.written).toEqual(['123456']);
  });

  it('ends on a frame that is not valid, and never forwards it', async () => {
    for (const bad of ['not json', JSON.stringify({ t: 'run', d: 'x' }), JSON.stringify({ t: 'in', d: 'x'.repeat(TERMINAL_LIMITS.inputFrameMax + 1) }), JSON.stringify({ t: 'in', d: 'a', extra: true })]) {
      const { pty, live, sink } = make();
      live.input(bad);
      const end = await live.ended;
      expect(end.reason, bad.slice(0, 20)).toBe('error');
      expect(pty.written).toEqual([]);
      expect(sink.closed[0]?.[0]).toBe(1007);
    }
  });

  it('refuses binary frames', async () => {
    const { pty, live, sink } = make();
    live.input(new Uint8Array([1, 2, 3]));
    expect((await live.ended).reason).toBe('error');
    expect(pty.written).toEqual([]);
    expect(sink.closed[0]?.[0]).toBe(1003);
  });

  it('ends with the shell when the shell exits by itself', async () => {
    const { pty, live, sink, cleaned } = make();
    pty.exit({ code: 0, fatal: null });
    expect((await live.ended).reason).toBe('closed');
    expect(cleaned()).toBe(1);
    expect(sink.frames.at(-1)).toMatchObject({ t: 'end', reason: 'closed' });
  });

  it('reports a sandbox that could not be built, in the shell\'s own words', async () => {
    const { pty, live, sink } = make();
    pty.exit({ code: null, fatal: 'unshare: Operation not permitted' });
    expect((await live.ended).reason).toBe('error');
    expect(sink.frames.at(-1)).toMatchObject({ t: 'end', reason: 'error', message: expect.stringContaining('unshare: Operation not permitted') });
  });

  it('records through the redaction: a secret is masked, and a record that cannot be checked is not stored', async () => {
    const masked = make();
    masked.pty.print('key is sk-abc123\r\n');
    await masked.live.end('closed');
    expect(masked.recorder.text).toBe('key is [redacted:key]\n');
    expect(masked.recorder.text).not.toContain('sk-abc123');
    const broken = make({}, async () => {
      throw new Error('guard down');
    });
    broken.pty.print('key is sk-abc123\r\n');
    await broken.live.end('closed');
    expect(broken.recorder.text).not.toContain('sk-abc123');
    expect(broken.recorder.text).toContain('could not be checked for secrets');
  });

  it('cuts the record at its size limit and says so', async () => {
    const pty = new FakePty();
    const sink = new Sink();
    const recorder = new Recorder(100, async (t) => t);
    const live = new LiveTerminal({ config, limits, pty, sink, recorder, cleanup: async () => undefined, credentialsRevoked: 0 });
    live.start();
    for (let i = 0; i < 20; i += 1) pty.print(`line number ${String(i)} of output\r\n`);
    await live.end('closed');
    expect(recorder.truncated).toBe(true);
    expect(recorder.text.length).toBeLessThan(200);
    expect(recorder.text).toContain('size limit');
  });

  it('holds a private key block until it is complete, so it is masked as one piece', async () => {
    const seen: string[] = [];
    const pty = new FakePty();
    const recorder = new Recorder(10_000, async (t) => {
      seen.push(t);
      return t.includes('-----BEGIN') ? '[redacted:private-key]\n' : t;
    });
    const sink = new Sink();
    const live = new LiveTerminal({ config, limits, pty, sink, recorder, cleanup: async () => undefined, credentialsRevoked: 0 });
    live.start();
    pty.print('before\r\n-----BEGIN PRIVATE KEY-----\r\nAAAA\r\n');
    await recorder.flush();
    expect(seen).toEqual(['before\n']);
    pty.print('BBBB\r\n-----END PRIVATE KEY-----\r\nafter\r\n');
    await live.end('closed');
    expect(seen[1]).toContain('-----END PRIVATE KEY-----');
    expect(recorder.text).toBe('before\n[redacted:private-key]\n');
  });
});

describe('terminal configuration', () => {
  it('is off unless switched on, and the jail is the default', () => {
    const c = readTerminalConfig({});
    expect(c.enabled).toBe(false);
    expect(c.isolation).toBe('jail');
    expect(c.uid).toBe(65534);
  });

  it('can lower a limit and never raise it', () => {
    const lowered = readTerminalConfig({ MANYTHREADS_TERMINAL_IDLE_SECONDS: '2', MANYTHREADS_TERMINAL_MAX_SECONDS: '5' });
    expect(lowered.idleMs).toBe(2000);
    expect(lowered.maxMs).toBe(5000);
    const raised = readTerminalConfig({ MANYTHREADS_TERMINAL_IDLE_SECONDS: '99999', MANYTHREADS_TERMINAL_MAX_SECONDS: '-1', MANYTHREADS_TERMINAL_OUTPUT_BYTES_TOTAL: 'lots' });
    expect(raised.idleMs).toBe(TERMINAL_LIMITS.idleSeconds * 1000);
    expect(raised.maxMs).toBe(TERMINAL_LIMITS.maxSeconds * 1000);
    expect(raised.outputBytesTotal).toBe(TERMINAL_LIMITS.outputBytesTotal);
  });

  it('only the plain word "none" turns the jail off', () => {
    expect(readTerminalConfig({ MANYTHREADS_TERMINAL_ISOLATION: 'none' }).isolation).toBe('plain');
    for (const v of ['', 'off', 'false', '0', 'NONE', 'jail']) expect(readTerminalConfig({ MANYTHREADS_TERMINAL_ISOLATION: v }).isolation, v).toBe('jail');
  });

  it('only "1" switches the terminal on', () => {
    expect(readTerminalConfig({ MANYTHREADS_TERMINAL_ENABLED: '1' }).enabled).toBe(true);
    for (const v of ['', 'true', 'yes', '0', 'on']) expect(readTerminalConfig({ MANYTHREADS_TERMINAL_ENABLED: v }).enabled, v).toBe(false);
  });
});

describe('whether a terminal can be opened (availability)', () => {
  // A pretend data-loss guard and a pretend sandbox: the question is what the service asks of each before it says "yes".
  const guard = (over: Partial<{ hooks: number; ran: string[]; outcome: string; reason: string | null }> = {}) =>
    ({ db: { system: async (fn: (tx: unknown) => unknown) => fn({}) }, hooks: { runPreEgress: async () => ({ hooks: 1, ran: ['guardrails-dlp'], outcome: 'allow', text: 'probe\n', reason: null, ...over }) } }) as unknown as PluginContext;
  /** A starter whose shell, told to `exit`, ends the way the test says. */
  const shell = (end: PtyExit): { starter: PtyStarter; started: () => number } => {
    let started = 0;
    return {
      started: () => started,
      starter: {
        start: () => {
          started += 1;
          const pty = new FakePty();
          pty.write = () => queueMicrotask(() => pty.exit(end));
          return pty;
        },
      },
    };
  };
  let root = '';
  const withRoot = async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), 'mt-avail-'));
    vi.stubEnv('MANYTHREADS_TERMINAL_ENABLED', '1');
    vi.stubEnv('MANYTHREADS_TERMINAL_ROOT', root);
  };
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('says yes when the guard is loaded and the sandbox shell exits cleanly', async () => {
    await withRoot();
    const s = shell({ code: 0, fatal: null });
    expect(await new TerminalService(guard(), s.starter).availability('w')).toEqual({ available: true, reason: null });
    expect(s.started()).toBe(1);
  });

  it('says no, in plain words, and starts no shell when the data-loss guard is not loaded (or did not run)', async () => {
    await withRoot();
    for (const over of [{ hooks: 0, ran: [] }, { ran: ['something-else'] }, { outcome: 'block' }, { reason: 'error' }]) {
      const s = shell({ code: 0, fatal: null });
      const state = await new TerminalService(guard(over), s.starter).availability('w');
      expect(state.available, JSON.stringify(over)).toBe(false);
      expect(state.reason).toMatch(/data-loss guard/);
      expect(s.started()).toBe(0);
    }
    // and a guard that throws is the same answer
    const throwing = { db: { system: async () => Promise.reject(new Error('down')) } } as unknown as PluginContext;
    expect((await new TerminalService(throwing, shell({ code: 0, fatal: null }).starter).availability('w')).available).toBe(false);
  });

  it('says no when the probe shell fails without saying why: the exit code must be 0', async () => {
    await withRoot();
    for (const end of [{ code: 3, fatal: null }, { code: null, fatal: null }, { code: 137, fatal: null }] as PtyExit[]) {
      const state = await new TerminalService(guard(), shell(end).starter).availability('w');
      expect(state.available, JSON.stringify(end)).toBe(false);
      expect(state.reason).toMatch(/cannot be built/);
    }
  });

  it('says no with the words for a missing root user when the helper reports it', async () => {
    await withRoot();
    const state = await new TerminalService(guard(), shell({ code: 1, fatal: 'plain mode needs the root user' }).starter).availability('w');
    expect(state.available).toBe(false);
    expect(state.reason).toMatch(/root user/);
  });

  it('does not need the guard to load the Workshop: only the terminal does', async () => {
    const { default: plugin } = await import('../src/index.ts');
    expect(plugin.manifest.dependsOn).not.toContain('guardrails-dlp');
  });

  it('says it is switched off before it asks anything', async () => {
    const s = shell({ code: 0, fatal: null });
    vi.stubEnv('MANYTHREADS_TERMINAL_ENABLED', '0');
    const state = await new TerminalService(guard(), s.starter).availability('w');
    expect(state).toMatchObject({ available: false });
    expect(state.reason).toMatch(/switched off/);
    expect(s.started()).toBe(0);
  });
});
