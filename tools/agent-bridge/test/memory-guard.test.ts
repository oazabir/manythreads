import { describe, expect, it } from 'vitest';
import {
  agentNames,
  guardDecision,
  guardThreshold,
  isAgentCmdline,
  MemoryGuard,
  memInfoOf,
  pickVictim,
  procGuardReader,
  statusOf,
  usedOf,
  type GuardInput,
  type GuardProcess,
  type GuardReader,
} from '../src/memory-guard.ts';
import { withGuardKills, type MemoryWatch } from '../src/memory-watch.ts';

// P31-04, the pod guard: a container's out-of-memory kill takes every process (memory.oom.group=1), so the bridge stops the biggest command of a run itself, before the kernel does.
// Nothing here uses real memory or kills a real process: the tree, the files and the kill are fakes.

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// tini (1) -> bridge (10) -> adapter (20) -> claude (21, the agent) -> bash (30) -> tsc (31); the adapter also runs an MCP server (22); codex-acp (40) runs bash (41) directly, which
// runs vitest (42) with a worker (43)
const tree: GuardProcess[] = [
  { pid: 1, ppid: 0, rssBytes: 2 * MIB, name: 'tini', agent: false },
  { pid: 10, ppid: 1, rssBytes: 900 * MIB, name: 'node', agent: false },
  { pid: 20, ppid: 10, rssBytes: 200 * MIB, name: 'node', agent: false },
  { pid: 21, ppid: 20, rssBytes: 1500 * MIB, name: 'claude', agent: true },
  { pid: 22, ppid: 20, rssBytes: 60 * MIB, name: 'node', agent: false },
  { pid: 30, ppid: 21, rssBytes: 4 * MIB, name: 'bash', agent: false },
  { pid: 31, ppid: 30, rssBytes: 1200 * MIB, name: 'node', agent: false },
  { pid: 40, ppid: 10, rssBytes: 100 * MIB, name: 'codex-acp', agent: false },
  { pid: 41, ppid: 40, rssBytes: 3 * MIB, name: 'bash', agent: false },
  { pid: 42, ppid: 41, rssBytes: 300 * MIB, name: 'node', agent: false },
  { pid: 43, ppid: 42, rssBytes: 700 * MIB, name: 'node', agent: false },
  { pid: 50, ppid: 1, rssBytes: 3000 * MIB, name: 'stranger', agent: false },
];

const input = (over: Partial<GuardInput>): GuardInput => ({
  limitBytes: 4 * GIB,
  usedBytes: 3.8 * GIB,
  memAvailableBytes: null,
  memTotalBytes: null,
  processes: () => tree,
  adapters: new Set([20, 40]),
  bridgePid: 10,
  ...over,
});

describe('when the guard acts', () => {
  it('at the limit less 10 % or 512 MiB, whichever is more (3.5 GiB of 4 GiB; 1.5 GiB of 2 GiB)', () => {
    expect(guardThreshold(4 * GIB)).toBe(3.5 * GIB);
    expect(guardThreshold(2 * GIB)).toBe(1.5 * GIB);
    expect(guardThreshold(8 * GIB)).toBe(8 * GIB - Math.floor((8 * GIB) / 10));
  });

  it('does nothing under the threshold, and does not even walk the processes', () => {
    let walked = false;
    expect(guardDecision(input({ usedBytes: 3 * GIB, processes: () => ((walked = true), tree) }))).toEqual({ action: 'none' });
    expect(walked).toBe(false);
    expect(guardDecision(input({ usedBytes: null }))).toEqual({ action: 'none' });
  });

  it('stops the biggest program below an adapter: never tini, the bridge, an adapter or the agent the adapter started, never a process outside the runs', () => {
    const d = guardDecision(input({}));
    expect(d).toMatchObject({ action: 'kill', pid: 31, rssBytes: 1200 * MIB });
    // without tsc, the vitest worker (a grandchild of Codex's adapter) is next; the stranger (3 GB, not below any adapter) is never chosen
    const rest = tree.filter((p) => p.pid !== 31);
    expect(pickVictim(rest, new Set([20, 40]), 10)?.pid).toBe(43);
    // only the agent and the adapters are left: nothing to stop
    const only = tree.filter((p) => [1, 10, 20, 21, 40, 50].includes(p.pid));
    expect(guardDecision(input({ processes: () => only }))).toMatchObject({ action: 'nothing-to-stop' });
  });

  it('a direct child of an adapter that is not an agent program may be stopped (a command Codex runs itself)', () => {
    const procs: GuardProcess[] = [
      { pid: 40, ppid: 10, rssBytes: 100 * MIB, name: 'codex-acp', agent: false },
      { pid: 44, ppid: 40, rssBytes: 2500 * MIB, name: 'node', agent: false },
      { pid: 45, ppid: 40, rssBytes: 900 * MIB, name: 'codex', agent: true },
    ];
    expect(pickVictim(procs, new Set([40]), 10)?.pid).toBe(44);
  });

  it('never chooses pid 1, the bridge or another adapter, even when one sits below an adapter', () => {
    const procs: GuardProcess[] = [
      { pid: 20, ppid: 10, rssBytes: 100 * MIB, name: 'node', agent: false },
      { pid: 10, ppid: 20, rssBytes: 900 * MIB, name: 'node', agent: false },
      { pid: 25, ppid: 20, rssBytes: 900 * MIB, name: 'node', agent: false },
      { pid: 26, ppid: 25, rssBytes: 0, name: 'zombie', agent: false },
    ];
    expect(pickVictim(procs, new Set([20, 25]), 10)).toBeNull();
  });

  it('with no limit it only says when the machine is short of memory', () => {
    expect(guardDecision(input({ limitBytes: null, memAvailableBytes: 1 * GIB, memTotalBytes: 16 * GIB }))).toEqual({ action: 'low-machine', availableBytes: 1 * GIB, totalBytes: 16 * GIB });
    expect(guardDecision(input({ limitBytes: null, memAvailableBytes: 6 * GIB, memTotalBytes: 16 * GIB }))).toEqual({ action: 'none' });
    expect(guardDecision(input({ limitBytes: null }))).toEqual({ action: 'none' });
  });
});

describe('what the guard reads', () => {
  it('anonymous memory from memory.stat, not the page cache; else current minus inactive_file', () => {
    expect(usedOf('anon 3221225472\nfile 900000000\ninactive_file 800000000\n', '4000000000\n')).toBe(3221225472);
    expect(usedOf('file 900\ninactive_file 800\n', '4000\n')).toBe(3200);
    expect(usedOf('file 900\n', null)).toBeNull();
    expect(usedOf('', 'max\n')).toBeNull();
  });

  it('MemAvailable and MemTotal in bytes', () => {
    expect(memInfoOf('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    6000000 kB\n')).toEqual({ availableBytes: 6000000 * 1024, totalBytes: 16000000 * 1024 });
    expect(memInfoOf('nothing')).toEqual({ availableBytes: null, totalBytes: null });
  });

  it('name, parent and resident memory of a status file; a kernel thread (no VmRSS) is left out', () => {
    expect(statusOf('Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t31\nPPid:\t30\nVmRSS:\t  1228800 kB\n')).toEqual({ name: 'node', ppid: 30, rssBytes: 1228800 * 1024 });
    expect(statusOf('Name:\tkthreadd\nPPid:\t0\n')).toBeNull();
  });

  it('an agent program by its program or the script a runtime runs', () => {
    const names = agentNames(['/opt/tools/bin/claude', 'codex']);
    expect(names.has('node')).toBe(false);
    expect(isAgentCmdline('/opt/tools/bin/claude\0--print\0', names)).toBe(true);
    expect(isAgentCmdline('node\0/usr/lib/node_modules/x/bin/codex\0exec\0', names)).toBe(true);
    expect(isAgentCmdline('node\0/work/node_modules/.bin/vitest\0run\0', names)).toBe(false);
    expect(isAgentCmdline('bash\0-c\0claude --version\0', names)).toBe(false);
    expect(isAgentCmdline('', names)).toBe(false);
  });

  it('reads its own cgroup and /proc through the files it is given; none without cgroup v2', () => {
    const files: Record<string, string> = {
      '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/memory.max': '4294967296\n',
      '/sys/fs/cgroup/memory.stat': 'anon 4000000000\n',
      '/sys/fs/cgroup/memory.current': '4100000000\n',
      '/proc/meminfo': 'MemTotal: 100 kB\nMemAvailable: 50 kB\n',
      '/proc/31/status': 'Name:\tnode\nPPid:\t30\nVmRSS:\t100 kB\n',
      '/proc/31/cmdline': 'node\0tsc\0',
    };
    const read = { read: (p: string): string => {
      const t = files[p];
      if (t === undefined) throw new Error('ENOENT');
      return t;
    } };
    const reader = procGuardReader(agentNames([]), read, () => ['self', '31', '32'])!;
    expect(reader.limitBytes()).toBe(4294967296);
    expect(reader.usedBytes()).toBe(4000000000);
    expect(reader.memInfo()).toEqual({ availableBytes: 50 * 1024, totalBytes: 100 * 1024 });
    expect(reader.processes()).toEqual([{ pid: 31, ppid: 30, rssBytes: 100 * 1024, name: 'node', agent: false }]);
    expect(procGuardReader(agentNames([]), { read: (p) => (p === '/proc/self/cgroup' ? '12:memory:/x\n' : '') })).toBeNull();
  });
});

describe('the guard of one bridge', () => {
  const fakeReader = (over: Partial<GuardReader> = {}): GuardReader => ({
    limitBytes: () => 4 * GIB,
    usedBytes: () => 3.9 * GIB,
    memInfo: () => ({ availableBytes: null, totalBytes: null }),
    processes: () => tree,
    ...over,
  });

  it('stops the command, counts it, waits before a second kill and writes one plain log line', () => {
    const killed: number[] = [];
    const lines: string[] = [];
    let now = 1000;
    const guard = new MemoryGuard({ reader: fakeReader(), log: (l) => lines.push(l), kill: (pid) => killed.push(pid), now: () => now, bridgePid: 10 });
    guard.adapterStarted(20);
    guard.adapterStarted(40);
    expect(guard.tick()).toMatchObject({ action: 'kill', pid: 31 });
    expect(killed).toEqual([31]);
    expect(guard.kills()).toBe(1);
    expect(lines[0]).toMatch(/^memory guard: stopped node \(pid 31, 1200 MiB\)/);
    now += 500;
    expect(guard.tick()).toEqual({ action: 'none' }); // the memory is being given back
    now += 2000;
    guard.tick();
    expect(killed).toHaveLength(2);
  });

  it('an adapter that ended is no longer watched; a process already gone is not counted', () => {
    const killed: number[] = [];
    const guard = new MemoryGuard({ reader: fakeReader(), log: () => undefined, kill: (pid) => killed.push(pid), bridgePid: 10 });
    guard.adapterStarted(20);
    guard.adapterEnded(20);
    expect(guard.tick()).toMatchObject({ action: 'nothing-to-stop' });
    expect(killed).toEqual([]);
    const gone = new MemoryGuard({ reader: fakeReader(), log: () => undefined, kill: () => { throw new Error('ESRCH'); }, bridgePid: 10 });
    gone.adapterStarted(20);
    expect(gone.tick()).toEqual({ action: 'none' });
    expect(gone.kills()).toBe(0);
  });

  it('says a short machine once, not every half second', () => {
    const lines: string[] = [];
    let avail = 1 * GIB;
    const guard = new MemoryGuard({ reader: fakeReader({ limitBytes: () => null, memInfo: () => ({ availableBytes: avail, totalBytes: 16 * GIB }) }), log: (l) => lines.push(l), kill: () => undefined });
    guard.tick();
    guard.tick();
    expect(lines).toHaveLength(1);
    avail = 8 * GIB;
    guard.tick();
    avail = 1 * GIB;
    guard.tick();
    expect(lines).toHaveLength(2);
  });

  it('a reader that throws makes the guard do nothing (it never ends the bridge)', () => {
    const guard = new MemoryGuard({ reader: fakeReader({ limitBytes: () => { throw new Error('EIO'); } }), log: () => undefined, kill: () => undefined });
    expect(guard.tick()).toEqual({ action: 'none' });
  });

  it('the frames count a guard kill like the kernel\'s', () => {
    let kernel = 2;
    let guard = 0;
    const base: MemoryWatch = { oomKills: () => kernel, limitBytes: () => 4 * GIB };
    const w = withGuardKills(base, () => guard)!;
    expect(w.oomKills()).toBe(2);
    guard = 1;
    expect(w.oomKills()).toBe(3);
    kernel = 3;
    expect(w.oomKills()).toBe(4);
    expect(w.limitBytes()).toBe(4 * GIB);
    expect(withGuardKills(null, () => 1)).toBeNull();
    expect(withGuardKills({ oomKills: () => null, limitBytes: () => null }, () => 1)!.oomKills()).toBeNull();
  });
});
