import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Frames } from '../src/acp/frames.ts';
import { cgroupMemoryWatch, exitSignOf, limitOf, oomKillsOf, ownCgroupDir, raiseOomScore, ranOutOfMemory, RUN_OOM_SCORE, type CgroupFiles, type MemoryWatch } from '../src/memory-watch.ts';
import { startChild } from '../src/process.ts';
import { RUN_OOM_SCORE as HELPER_OOM_SCORE } from '../src/team-helper.ts';

// P31-04: a run's programs carry the kernel's highest out-of-memory weight, and a command the kernel killed for memory is marked and told to the thread. Nothing here uses real
// memory: the kill is a fake counter and a fake exit.

const linux = process.platform === 'linux';
const oomOf = (pid: number): number => Number(readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim());

describe('the out-of-memory weight of a run', () => {
  it('the helper and the bridge use the one value, 1000', () => {
    expect(RUN_OOM_SCORE).toBe(1000);
    expect(HELPER_OOM_SCORE).toBe(RUN_OOM_SCORE);
  });

  it('writes the child\'s own file, never on another platform, never for the bridge itself or pid 1, and never throws', () => {
    const writes: [string, string][] = [];
    const writer = { write: (path: string, text: string) => void writes.push([path, text]) };
    expect(raiseOomScore(4242, 1000, writer, 'linux')).toBe(true);
    expect(writes).toEqual([['/proc/4242/oom_score_adj', '1000']]);
    expect(raiseOomScore(4242, 1000, writer, 'darwin')).toBe(false);
    expect(raiseOomScore(4242, 1000, writer, 'win32')).toBe(false);
    expect(raiseOomScore(process.pid, 1000, writer, 'linux')).toBe(false);
    expect(raiseOomScore(1, 1000, writer, 'linux')).toBe(false);
    expect(writes).toHaveLength(1);
    const refusing = { write: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    expect(raiseOomScore(4242, 1000, refusing, 'linux')).toBe(false);
  });

  it.skipIf(!linux)('a started program and the child it starts later carry 1000; the bridge keeps its own weight (Linux)', async () => {
    const before = oomOf(process.pid);
    const lines: string[] = [];
    // the shell waits a moment before it starts its own child, so the child is started after the weight was written, as an agent's commands are
    const child = startChild('/bin/sh', ['-c', 'sleep 0.3; sleep 30 & echo "$!"; wait'], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdin: '', onLine: (l) => lines.push(l), oomScore: RUN_OOM_SCORE });
    try {
      for (let i = 0; i < 50 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      const grandchild = Number(lines[0]);
      expect(Number.isInteger(grandchild) && grandchild > 1).toBe(true);
      expect(oomOf(grandchild)).toBe(1000);
      expect(oomOf(process.pid)).toBe(before);
    } finally {
      child.signal('SIGKILL');
      await child.done;
    }
  });

  it.skipIf(!linux)('a program started without the option keeps the bridge\'s weight (a sign-in helper, a repo sync) (Linux)', async () => {
    const lines: string[] = [];
    const child = startChild('/bin/sh', ['-c', 'cat /proc/self/oom_score_adj'], { cwd: '/', env: { PATH: '/usr/bin:/bin' }, stdin: '', onLine: (l) => lines.push(l) });
    await child.done;
    expect(Number(lines[0])).toBe(oomOf(process.pid));
  });
});

describe('reading the kernel\'s kill count', () => {
  const files = (map: Record<string, string>): CgroupFiles => ({
    read: (path) => {
      const v = map[path];
      if (v === undefined) throw Object.assign(new Error(`no ${path}`), { code: 'ENOENT' });
      return v;
    },
  });
  const unit = {
    '/proc/self/cgroup': '0::/system.slice/manythreads-bridge.service\n',
    '/sys/fs/cgroup/system.slice/manythreads-bridge.service/memory.events': 'low 0\nhigh 0\nmax 4\noom 1\noom_kill 2\noom_group_kill 0\n',
    '/sys/fs/cgroup/system.slice/manythreads-bridge.service/memory.max': 'max\n',
  };

  it('reads the bridge\'s own group: the kill count, and no limit for `max`', () => {
    const w = cgroupMemoryWatch(files(unit), 'linux');
    expect(w?.oomKills()).toBe(2);
    expect(w?.limitBytes()).toBeNull();
  });

  it('a pod\'s container is the root of its own namespace (`0::/`), with a number for its limit', () => {
    const w = cgroupMemoryWatch(files({ '/proc/self/cgroup': '0::/\n', '/sys/fs/cgroup/memory.events': 'oom_kill 0\n', '/sys/fs/cgroup/memory.max': '4294967296\n' }), 'linux');
    expect(w?.oomKills()).toBe(0);
    expect(w?.limitBytes()).toBe(4294967296);
  });

  it('none on macOS, Windows, cgroup v1, a group without the memory controller, or a path that climbs out', () => {
    expect(cgroupMemoryWatch(files(unit), 'darwin')).toBeNull();
    expect(cgroupMemoryWatch(files(unit), 'win32')).toBeNull();
    expect(cgroupMemoryWatch(files({ '/proc/self/cgroup': '12:memory:/user.slice\n' }), 'linux')).toBeNull();
    expect(cgroupMemoryWatch(files({ '/proc/self/cgroup': '0::/a\n' }), 'linux')).toBeNull();
    expect(ownCgroupDir(files({ '/proc/self/cgroup': '0::/a/../../etc\n' }))).toBeNull();
    expect(cgroupMemoryWatch(files({}), 'linux')).toBeNull();
  });

  it('parses only the lines it knows', () => {
    expect(oomKillsOf('oom 3\noom_kill 7\n')).toBe(7);
    expect(oomKillsOf('oom_group_kill 1\n')).toBeNull();
    expect(limitOf('max')).toBeNull();
    expect(limitOf('536870912\n')).toBe(536870912);
  });
});

describe('how a command ended', () => {
  it('Codex says it in `_meta.terminal_exit` or `rawOutput.exit_code`; Claude in the first words of its text', () => {
    expect(exitSignOf({ _meta: { terminal_exit: { exit_code: 137, signal: null } } })).toEqual({ code: 137, signal: null });
    expect(exitSignOf({ _meta: { terminal_exit: { exit_code: null, signal: 'SIGKILL' } } })).toEqual({ code: null, signal: 'SIGKILL' });
    expect(exitSignOf({ rawOutput: { exit_code: 0 } })).toEqual({ code: 0, signal: null });
    expect(exitSignOf({ rawOutput: 'Exit code 137\nKilled' })).toEqual({ code: 137, signal: null });
    expect(exitSignOf({ rawOutput: 'the output said Exit code 137' })).toBeNull();
    expect(exitSignOf({ status: 'failed' })).toBeNull();
  });

  it('a command ran out of memory only when the count rose while it ran and it ended killed, or failed with no exit said', () => {
    const killed = { code: 137, signal: null };
    expect(ranOutOfMemory(0, 1, true, killed)).toBe(true);
    expect(ranOutOfMemory(0, 1, false, { code: null, signal: 'SIGKILL' })).toBe(true);
    expect(ranOutOfMemory(0, 1, true, null)).toBe(true);
    expect(ranOutOfMemory(0, 1, false, null)).toBe(false);
    expect(ranOutOfMemory(0, 1, true, { code: 1, signal: null })).toBe(false); // another program was killed; this one failed its own way
    expect(ranOutOfMemory(1, 1, true, killed)).toBe(false); // a kill with no rise (a timeout, a person's stop)
    expect(ranOutOfMemory(null, 1, true, killed)).toBe(false);
    expect(ranOutOfMemory(0, null, true, killed)).toBe(false);
  });
});

describe('frames: a command the kernel killed for memory (simulated)', () => {
  type Out = { event: string; [k: string]: unknown };
  const fake = (limit: number | null = 4 * 1024 ** 3): MemoryWatch & { kill(): void } => {
    let kills = 5;
    return { oomKills: () => kills, limitBytes: () => limit, kill: () => void (kills += 1) };
  };
  const frames = (memory: MemoryWatch | null): { out: Out[]; f: Frames } => {
    const out: Out[] = [];
    return { out, f: new Frames({ cwd: '/work/eng/coder', secrets: [], emit: (event, fields) => out.push({ event, ...fields }), memory }) };
  };
  const start = (f: Frames, id: string, title = 'pnpm -r typecheck'): void => f.update({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'in_progress' });
  const end = (f: Frames, id: string, extra: Record<string, unknown>): void => f.update({ sessionUpdate: 'tool_call_update', toolCallId: id, ...extra });
  const of = (out: Out[], event: string): Out[] => out.filter((o) => o.event === event);

  it('Codex: exit 137 after a kill marks the step and sends one notice with the step\'s title and the limit, nothing of the output', () => {
    const m = fake();
    const { out, f } = frames(m);
    start(f, 'exec-1');
    m.kill();
    end(f, 'exec-1', { status: 'completed', rawOutput: { exit_code: 137 }, _meta: { terminal_output_delta: { data: 'secret build output' }, terminal_exit: { exit_code: 137, signal: null } } });
    expect(of(out, 'tool.completed')).toEqual([expect.objectContaining({ step_id: 'exec-1', error: true, reason: 'out_of_memory' })]);
    expect(of(out, 'run.notice')).toEqual([{ event: 'run.notice', kind: 'out_of_memory', step_id: 'exec-1', title: 'Running pnpm', limit_mib: 4096 }]);
    expect(JSON.stringify(out)).not.toContain('secret build output');
  });

  it('an exit said in an earlier update than the one that ends the step still counts', () => {
    const m = fake();
    const { out, f } = frames(m);
    start(f, 'exec-2');
    m.kill();
    end(f, 'exec-2', { _meta: { terminal_exit: { exit_code: 137, signal: null } } });
    end(f, 'exec-2', { status: 'completed' });
    expect(of(out, 'tool.completed')[0]).toMatchObject({ error: true, reason: 'out_of_memory' });
    expect(of(out, 'run.notice')).toHaveLength(1);
  });

  it('Claude: a failed Bash step whose text starts "Exit code 137" after a kill; no limit known says none', () => {
    const m = fake(null);
    const { out, f } = frames(m);
    start(f, 'toolu_1', 'npx vitest run');
    m.kill();
    end(f, 'toolu_1', { status: 'failed', rawOutput: 'Exit code 137\nKilled' });
    expect(of(out, 'tool.completed')[0]).toMatchObject({ error: true, reason: 'out_of_memory' });
    expect(of(out, 'run.notice')[0]).toEqual({ event: 'run.notice', kind: 'out_of_memory', step_id: 'toolu_1', title: 'Running npx' });
  });

  it('no notice for a command that failed its own way, one that ended well, a kill with no rise, a step that is not a command, or a bridge with no watch', () => {
    const m = fake();
    const { out, f } = frames(m);
    start(f, 'a');
    m.kill();
    end(f, 'a', { status: 'failed', rawOutput: 'Exit code 1\nerror TS2322' });
    start(f, 'b');
    m.kill();
    end(f, 'b', { status: 'completed', _meta: { terminal_exit: { exit_code: 0, signal: null } } });
    start(f, 'c');
    end(f, 'c', { status: 'failed', rawOutput: 'Exit code 137' });
    f.update({ sessionUpdate: 'tool_call', toolCallId: 'd', title: 'Read package.json', kind: 'read', status: 'in_progress' });
    m.kill();
    end(f, 'd', { status: 'failed' });
    expect(of(out, 'run.notice')).toEqual([]);
    expect(of(out, 'tool.completed').map((c) => c['reason'])).toEqual([undefined, undefined, undefined, undefined]);
    const none = frames(null);
    start(none.f, 'e');
    end(none.f, 'e', { status: 'failed', rawOutput: 'Exit code 137' });
    expect(of(none.out, 'run.notice')).toEqual([]);
    expect(of(none.out, 'tool.completed')[0]).toMatchObject({ error: true });
  });

  it('at most three notices in a run; every killed step is still marked', () => {
    const m = fake();
    const { out, f } = frames(m);
    for (let i = 0; i < 5; i++) {
      start(f, `s${i}`);
      m.kill();
      end(f, `s${i}`, { status: 'failed', rawOutput: 'Exit code 137' });
    }
    expect(of(out, 'run.notice')).toHaveLength(3);
    expect(of(out, 'tool.completed').every((c) => c['reason'] === 'out_of_memory')).toBe(true);
  });

  it('a watch that throws never breaks the run\'s frames', () => {
    const { out, f } = frames({ oomKills: () => { throw new Error('gone'); }, limitBytes: () => null });
    start(f, 'x');
    end(f, 'x', { status: 'failed', rawOutput: 'Exit code 137' });
    expect(of(out, 'tool.completed')).toHaveLength(1);
    expect(of(out, 'run.notice')).toEqual([]);
  });
});
