import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.ts';
import type { Driver, DriverJob } from '../src/drivers/types.ts';
import { RunManager, type Run } from '../src/runs.ts';
import { SessionStore } from '../src/sessions.ts';
import { waitFor } from './support.ts';

// The run manager's own part of the ACP review: the budget clock while questions wait, and a stop said more than once.

let dir: string;
let manager: RunManager | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-runs-'));
});
afterEach(() => {
  manager?.close();
  manager = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const request = (budgetSeconds: number | null) =>
  ({ input: 'x', sessionId: null, instructions: null, manythreads: { tools: [], mcp: null, model: { alias: null, effort: null }, budgetSeconds, maxTurns: null } }) as never;

function managerWith(driver: Driver, over: Record<string, unknown> = {}): RunManager {
  const config = parseConfig({ profiles: { default: { agent: 'claude-code', workdir: join(dir, 'work') } }, killGraceSeconds: 1, budgetGraceSeconds: 1, ...over });
  manager = new RunManager({ config, sessions: new SessionStore(join(dir, 'state')), log: () => undefined, tmpRoot: dir, drivers: { 'claude-code': driver } });
  return manager;
}

describe('holdBudget', () => {
  it('two questions that overlap give back the time that was left when the first began, not what a stopped clock reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let job!: DriverJob;
    const gotJob = new Promise<void>((resolve) => {
      managerWith({
        async run(j) {
          job = j;
          resolve();
          while (!j.stopped()) await new Promise((r) => setTimeout(r, 1000));
          return { ok: false, error: 'stopped' };
        },
      });
    });
    const { run } = manager!.create('default', request(100), 'x', null);
    await vi.advanceTimersByTimeAsync(0);
    await gotJob;

    await vi.advanceTimersByTimeAsync(10_000);
    const releaseA = job.holdBudget(); // 91 s of the 101 are left: that is what is given back
    await vi.advanceTimersByTimeAsync(30_000);
    const releaseB = job.holdBudget(); // overlaps A: it must not read the clock again (it would find 61 s)
    await vi.advanceTimersByTimeAsync(30_000);
    releaseA(); // B still waits: the clock stays off
    await vi.advanceTimersByTimeAsync(500_000);
    expect(run.status).toBe('running');
    releaseB(); // the last answer: the clock starts again with what the first question found
    await vi.advanceTimersByTimeAsync(80_000);
    expect(run.status).toBe('running');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('budget exceeded');
  });

  it('a release called twice counts once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let job!: DriverJob;
    const gotJob = new Promise<void>((resolve) => {
      managerWith({
        async run(j) {
          job = j;
          resolve();
          while (!j.stopped()) await new Promise((r) => setTimeout(r, 1000));
          return { ok: false, error: 'stopped' };
        },
      });
    });
    const { run } = manager!.create('default', request(100), 'x', null);
    await vi.advanceTimersByTimeAsync(0);
    await gotJob;
    const a = job.holdBudget();
    const b = job.holdBudget();
    a();
    a();
    await vi.advanceTimersByTimeAsync(500_000);
    expect(run.status).toBe('running'); // b still holds
    b();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('budget exceeded');
  });
});

describe('a stop said again', () => {
  it('does not push back the kill of a process that ignores the first', async () => {
    const stubborn = join(dir, 'stubborn.mjs');
    writeFileSync(stubborn, "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000);");
    let up = false;
    managerWith({
      async run(job) {
        job.onStop(() => undefined, 0); // a graceful driver: it does not signal the child itself
        const child = job.start(process.execPath, [stubborn], { cwd: job.profile.workdir, env: job.baseEnv(), stdin: '', onLine: (l) => (up = up || l.includes('up')) });
        const end = await child.done;
        return { ok: false, error: String(end.signal) };
      },
    });
    const { run } = manager!.create('default', request(null), 'x', null) as { run: Run };
    await waitFor(() => up);
    const t = Date.now();
    manager!.stop(run);
    await new Promise((r) => setTimeout(r, 500));
    manager!.stop(run);
    await new Promise((r) => setTimeout(r, 300));
    manager!.stop(run);
    await waitFor(() => run.status !== 'running', 8000);
    // killGraceSeconds is 1: the kill is at about 1 s after the FIRST stop, not after the last
    expect(Date.now() - t).toBeLessThan(1700);
    expect(run.status).toBe('cancelled');
  });
});
