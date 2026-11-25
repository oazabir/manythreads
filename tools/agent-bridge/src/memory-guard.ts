import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { limitOf, ownCgroupDir, type CgroupFiles } from './memory-watch.ts';

// The pod guard (PLAN P31-04, docs/plans/codex-teams-and-oom.md section 3 "Pod" and correction 8).
//
// In a run pod the container's control group has `memory.oom.group=1`: when the kernel's out-of-memory killer acts there, it kills EVERY process of the container, the bridge
// included, so `oom_score_adj` cannot save the run. So the bridge watches its own group itself, every 500 ms: when the memory the programs hold (anonymous memory, not the page cache a
// build leaves near the limit, plus the memory-backed /dev/shm of an ACP pod) comes within a margin of the limit (`guardThreshold`), it stops the biggest program below a run's adapter
// with SIGKILL, before the kernel stops everything. It never stops the bridge, `tini` (pid 1), an adapter, an agent program (Claude Code, Codex, Hermes) at any depth below an
// adapter, or a program between an adapter and an agent (codex-acp -> `node codex.js` -> the native `codex`). It stops only a program big enough to matter (`victimFloor`): killing
// small commands one after another while the memory is the agent's own helps no one. Under a 1.5 GiB limit it only writes a log line (the margin would leave no room to work). The
// command then ends killed (exit 137) and the frames mark the step "out of memory" like a kill of the kernel (memory-watch.ts `withGuardKills`), counted for the run whose adapter the
// program was below.
//
// With no limit (`memory.max` is "max": a host, or a server whose runs have scopes of their own) it only writes a log line when the machine itself runs short (MemAvailable under 10 %).
// A very fast allocation can still beat a 500 ms look (plan R6).

const MIB = 1024 * 1024;
/** How close to the limit the guard acts: within this much, or 10 % of the limit when that is more, but never more than a quarter of the limit. */
export const GUARD_MARGIN_BYTES = 512 * MIB;
/** Under this limit the guard never stops a program, it only writes a log line: the margin would take most of the room a command has. */
export const GUARD_MIN_LIMIT_BYTES = 1536 * MIB;
/** A program smaller than this is never stopped: it would not give back enough to matter. */
export const GUARD_MIN_VICTIM_BYTES = 64 * MIB;
/** After a kill the memory takes a moment to be given back: no second kill this soon. */
export const GUARD_COOLDOWN_MS = 2000;
export const GUARD_INTERVAL_MS = 500;

/**
 * The memory at which the guard acts, for a limit: `limit - min(max(512 MiB, 10 %), 25 %)`. At 4 GiB that is 3.5 GiB (512 MiB is more than 10 %); at 1.5 GiB it is 1.125 GiB (a
 * quarter); at 8 GiB the limit less 10 %.
 */
export const guardThreshold = (limitBytes: number): number =>
  limitBytes - Math.min(Math.max(GUARD_MARGIN_BYTES, Math.floor(limitBytes / 10)), Math.floor(limitBytes / 4));

/** The smallest program worth stopping when the group holds `usedBytes` over `thresholdBytes`: 64 MiB, or a quarter of what is over when that is more. */
export const victimFloor = (usedBytes: number, thresholdBytes: number): number => Math.max(GUARD_MIN_VICTIM_BYTES, Math.floor((usedBytes - thresholdBytes) / 4));

/** One process as the guard sees it: its parent, its resident memory, and whether it is an agent program (its name or its first words name Claude Code, Codex or Hermes). */
export interface GuardProcess {
  pid: number;
  ppid: number;
  rssBytes: number;
  name: string;
  agent: boolean;
}

export interface GuardInput {
  /** `memory.max` of the bridge's own group; null for "max". */
  limitBytes: number | null;
  /** The anonymous and shared (tmpfs, /dev/shm) memory of the group; null when it cannot be read. */
  usedBytes: number | null;
  /** The machine's `MemAvailable` and `MemTotal` (`/proc/meminfo`), for a group with no limit. */
  memAvailableBytes: number | null;
  memTotalBytes: number | null;
  /** Read only when the group is over the threshold (a walk of /proc every 500 ms would be waste). */
  processes: () => readonly GuardProcess[];
  /** The pids of the runs' adapters (what the bridge started itself). */
  adapters: ReadonlySet<number>;
  /** The bridge's own pid. */
  bridgePid: number;
}

export type GuardDecision =
  | { action: 'none' }
  /** `adapter`: the adapter the program was below (its run counts the kill). */
  | { action: 'kill'; pid: number; name: string; rssBytes: number; usedBytes: number; limitBytes: number; adapter: number }
  /** Over the threshold, but no program below an adapter big enough to stop (the memory is the agent's own, or another program's). */
  | { action: 'nothing-to-stop'; usedBytes: number; limitBytes: number }
  /** Over the threshold of a limit under 1.5 GiB: the guard does not stop programs there, a log line only. */
  | { action: 'watch-only'; usedBytes: number; limitBytes: number }
  /** No limit, and the machine is short of memory: a log line only. */
  | { action: 'low-machine'; availableBytes: number; totalBytes: number };

/** A program the guard may stop, and the adapter it is below. */
export interface GuardVictim extends GuardProcess {
  adapter: number;
}

/**
 * The biggest program below a run's adapter that may be stopped: a descendant of an adapter, never pid 1, the bridge, an adapter itself, an agent program at any depth, or a
 * program on the way from the adapter down to an agent (codex-acp starts `node codex.js`, which starts the native `codex`: all three stay). A program with less resident memory
 * than `minRssBytes` (and never one with none) is not chosen. Ties go to the newer (higher) pid.
 */
export function pickVictim(processes: readonly GuardProcess[], adapters: ReadonlySet<number>, bridgePid: number, minRssBytes = 1): GuardVictim | null {
  const children = new Map<number, GuardProcess[]>();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  let best: GuardVictim | null = null;
  const seen = new Set<number>();
  for (const adapter of adapters) {
    // the adapter's tree, each program with the one above it
    const below: Array<{ p: GuardProcess; parent: number }> = [];
    const queue: Array<{ p: GuardProcess; parent: number }> = (children.get(adapter) ?? []).map((p) => ({ p, parent: adapter }));
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (seen.has(item.p.pid) || adapters.has(item.p.pid)) continue; // another adapter's tree is its own
      seen.add(item.p.pid);
      below.push(item);
      for (const c of children.get(item.p.pid) ?? []) queue.push({ p: c, parent: item.p.pid });
    }
    // an agent and everything above it up to the adapter
    const parentOf = new Map(below.map(({ p, parent }) => [p.pid, parent]));
    const kept = new Set<number>();
    for (const { p } of below) {
      if (!p.agent) continue;
      for (let pid: number | undefined = p.pid; pid !== undefined && pid !== adapter && !kept.has(pid); pid = parentOf.get(pid)) kept.add(pid);
    }
    for (const { p } of below) {
      if (p.pid <= 1 || p.pid === bridgePid || kept.has(p.pid) || p.rssBytes <= 0 || p.rssBytes < minRssBytes) continue;
      if (best === null || p.rssBytes > best.rssBytes || (p.rssBytes === best.rssBytes && p.pid > best.pid)) best = { ...p, adapter };
    }
  }
  return best;
}

/** What the guard does now. Pure: the same reading always gives the same answer. */
export function guardDecision(input: GuardInput): GuardDecision {
  const { limitBytes, usedBytes } = input;
  if (limitBytes === null) {
    const avail = input.memAvailableBytes;
    const total = input.memTotalBytes;
    if (avail !== null && total !== null && total > 0 && avail < total / 10) return { action: 'low-machine', availableBytes: avail, totalBytes: total };
    return { action: 'none' };
  }
  const threshold = guardThreshold(limitBytes);
  if (usedBytes === null || usedBytes < threshold) return { action: 'none' };
  if (limitBytes < GUARD_MIN_LIMIT_BYTES) return { action: 'watch-only', usedBytes, limitBytes };
  const victim = pickVictim(input.processes(), input.adapters, input.bridgePid, victimFloor(usedBytes, threshold));
  if (victim === null) return { action: 'nothing-to-stop', usedBytes, limitBytes };
  return { action: 'kill', pid: victim.pid, name: victim.name, rssBytes: victim.rssBytes, usedBytes, limitBytes, adapter: victim.adapter };
}

// ---- the readers: small parsers (tested) and the thin part that opens the files ---------------------------------------------------------

/**
 * The memory the programs hold, from a `memory.stat` file: `anon` plus `shmem` (an ACP pod's /dev/shm is memory-backed and charged to the group as shmem); with no `anon` line,
 * `memory.current` minus `inactive_file` when both are given.
 */
export function usedOf(memoryStat: string, memoryCurrent: string | null): number | null {
  const anon = /^anon (\d{1,20})$/m.exec(memoryStat);
  const shmem = /^shmem (\d{1,20})$/m.exec(memoryStat);
  if (anon !== null) return Number(anon[1]) + (shmem === null ? 0 : Number(shmem[1]));
  const inactive = /^inactive_file (\d{1,20})$/m.exec(memoryStat);
  const current = memoryCurrent === null ? null : limitOf(memoryCurrent);
  if (current === null) return null;
  return Math.max(0, current - (inactive === null ? 0 : Number(inactive[1])));
}

/** `MemAvailable` and `MemTotal` of `/proc/meminfo`, in bytes. */
export function memInfoOf(text: string): { availableBytes: number | null; totalBytes: number | null } {
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d{1,15}) kB$`, 'm').exec(text);
    return m === null ? null : Number(m[1]) * 1024;
  };
  return { availableBytes: kb('MemAvailable'), totalBytes: kb('MemTotal') };
}

/** The name, parent and resident memory of a `/proc/<pid>/status` file; null when a line is missing (a kernel thread has no VmRSS: never a candidate). */
export function statusOf(text: string): { name: string; ppid: number; rssBytes: number } | null {
  const name = /^Name:\t(.{0,64})$/m.exec(text);
  const ppid = /^PPid:\s+(\d{1,10})$/m.exec(text);
  const rss = /^VmRSS:\s+(\d{1,15}) kB$/m.exec(text);
  if (name === null || ppid === null || rss === null) return null;
  return { name: name[1]!, ppid: Number(ppid[1]), rssBytes: Number(rss[1]) * 1024 };
}

/**
 * The base names an agent program goes by: Claude Code, Codex (the native `codex` and the `codex.js` that `node` runs) and Hermes, and the names of the programs this bridge's config
 * points the adapters at.
 */
export const agentNames = (bins: readonly string[]): Set<string> =>
  new Set(['claude', 'codex', 'codex.js', 'hermes', ...bins.map((b) => posix.basename(b)).filter((b) => b !== '' && b !== 'node')]);

/**
 * Whether a `/proc/<pid>/cmdline` (words split by NUL) is an agent program: its program, or the script a runtime runs (`node …/claude`, `node --flag …/codex.js`: the first word
 * after the program that is not an option), has one of the names.
 */
export function isAgentCmdline(cmdline: string, names: ReadonlySet<string>): boolean {
  const words = cmdline.split('\0').filter((w) => w !== '');
  const script = words.slice(1).find((w) => !w.startsWith('-'));
  return [words[0], script].some((w) => w !== undefined && names.has(posix.basename(w)));
}

/** Whether a process is an agent program, by its `/proc/<pid>/status` name (the kernel's short name: the native `codex`, a `claude` that set its title) or its cmdline. */
export const isAgentProcess = (name: string, cmdline: string, names: ReadonlySet<string>): boolean => names.has(name) || isAgentCmdline(cmdline, names);

export interface GuardReader {
  limitBytes(): number | null;
  usedBytes(): number | null;
  memInfo(): { availableBytes: number | null; totalBytes: number | null };
  processes(): GuardProcess[];
}

/** The reader of this machine: the bridge's own cgroup v2 folder and /proc. Null where there is no cgroup v2 to read (macOS, Windows, cgroup v1). */
export function procGuardReader(names: ReadonlySet<string>, files: CgroupFiles = { read: (p) => readFileSync(p, 'utf8') }, list: () => string[] = () => readdirSync('/proc')): GuardReader | null {
  const dir = ownCgroupDir(files);
  if (dir === null) return null;
  const read = (path: string): string | null => {
    try {
      return files.read(path);
    } catch {
      return null;
    }
  };
  if (read(posix.join(dir, 'memory.max')) === null) return null;
  return {
    limitBytes: () => {
      const t = read(posix.join(dir, 'memory.max'));
      return t === null ? null : limitOf(t);
    },
    usedBytes: () => {
      const stat = read(posix.join(dir, 'memory.stat'));
      return stat === null ? null : usedOf(stat, read(posix.join(dir, 'memory.current')));
    },
    memInfo: () => memInfoOf(read('/proc/meminfo') ?? ''),
    processes: () => {
      const out: GuardProcess[] = [];
      let pids: string[];
      try {
        pids = list();
      } catch {
        return out;
      }
      for (const entry of pids) {
        if (!/^\d{1,10}$/.test(entry)) continue;
        const status = read(`/proc/${entry}/status`);
        const s = status === null ? null : statusOf(status);
        if (s === null) continue;
        out.push({ pid: Number(entry), ppid: s.ppid, rssBytes: s.rssBytes, name: s.name, agent: isAgentProcess(s.name, read(`/proc/${entry}/cmdline`) ?? '', names) });
      }
      return out;
    },
  };
}

export interface MemoryGuardOptions {
  reader: GuardReader;
  log: (line: string) => void;
  kill?: (pid: number) => void;
  now?: () => number;
  bridgePid?: number;
}

/** The guard of one bridge: the runs register their adapters, a timer calls `tick`. */
export class MemoryGuard {
  /** Each adapter and what to tell its run when a program below it is stopped. */
  private readonly adapters = new Map<number, (() => void) | undefined>();
  private killed = 0;
  private lastKillAt = -Infinity;
  private lowSaid = false;
  private stuckSaid = false;
  private smallSaid = false;

  constructor(private readonly o: MemoryGuardOptions) {}

  /** `onKill` is called once for every program the guard stops below this adapter: the run counts its own kills, not another run's. */
  adapterStarted(pid: number | undefined, onKill?: () => void): void {
    if (pid !== undefined && Number.isInteger(pid) && pid > 1) this.adapters.set(pid, onKill);
  }

  adapterEnded(pid: number | undefined): void {
    if (pid !== undefined) this.adapters.delete(pid);
  }

  /** How many programs the guard has stopped so far, for every run. */
  kills(): number {
    return this.killed;
  }

  tick(): GuardDecision {
    const now = (this.o.now ?? Date.now)();
    if (now - this.lastKillAt < GUARD_COOLDOWN_MS) return { action: 'none' };
    let decision: GuardDecision;
    try {
      const limitBytes = this.o.reader.limitBytes();
      const info = limitBytes === null ? this.o.reader.memInfo() : { availableBytes: null, totalBytes: null };
      decision = guardDecision({
        limitBytes,
        usedBytes: limitBytes === null ? null : this.o.reader.usedBytes(),
        memAvailableBytes: info.availableBytes,
        memTotalBytes: info.totalBytes,
        processes: () => this.o.reader.processes(),
        adapters: new Set(this.adapters.keys()),
        bridgePid: this.o.bridgePid ?? process.pid,
      });
    } catch {
      return { action: 'none' };
    }
    const mib = (b: number): number => Math.round(b / MIB);
    if (decision.action === 'kill') {
      try {
        (this.o.kill ?? ((pid) => process.kill(pid, 'SIGKILL')))(decision.pid);
      } catch {
        return { action: 'none' }; // gone already
      }
      this.killed += 1;
      this.lastKillAt = now;
      this.stuckSaid = false;
      try {
        this.adapters.get(decision.adapter)?.();
      } catch {
        // a run's counter never ends the guard
      }
      this.o.log(`memory guard: stopped ${decision.name} (pid ${decision.pid}, ${mib(decision.rssBytes)} MiB): the run's programs held ${mib(decision.usedBytes)} of ${mib(decision.limitBytes)} MiB`);
    } else if (decision.action === 'nothing-to-stop') {
      if (!this.stuckSaid) this.o.log(`memory guard: ${mib(decision.usedBytes)} of ${mib(decision.limitBytes)} MiB in use and no command of a run to stop`);
      this.stuckSaid = true;
    } else if (decision.action === 'watch-only') {
      if (!this.smallSaid) this.o.log(`memory guard: ${mib(decision.usedBytes)} of ${mib(decision.limitBytes)} MiB in use; under a ${mib(GUARD_MIN_LIMIT_BYTES)} MiB limit the guard stops no command`);
      this.smallSaid = true;
    } else if (decision.action === 'low-machine') {
      if (!this.lowSaid) this.o.log(`memory guard: this machine has ${mib(decision.availableBytes)} of ${mib(decision.totalBytes)} MiB available`);
      this.lowSaid = true;
    } else {
      this.lowSaid = false;
      this.stuckSaid = false;
      this.smallSaid = false;
    }
    return decision;
  }
}

let current: MemoryGuard | null = null;

/** The running guard of this bridge, or null (not Linux, no cgroup v2, not started). */
export const memoryGuard = (): MemoryGuard | null => current;

/** Starts the guard once for this process (Linux with cgroup v2 only); returns it, or null. */
export function startMemoryGuard(opts: { bins: readonly string[]; log: (line: string) => void; intervalMs?: number; platform?: NodeJS.Platform }): MemoryGuard | null {
  if (current !== null) return current;
  if ((opts.platform ?? process.platform) !== 'linux') return null;
  const reader = procGuardReader(agentNames(opts.bins));
  if (reader === null) return null;
  const guard = new MemoryGuard({ reader, log: opts.log });
  setInterval(() => guard.tick(), opts.intervalMs ?? GUARD_INTERVAL_MS).unref();
  current = guard;
  return guard;
}
