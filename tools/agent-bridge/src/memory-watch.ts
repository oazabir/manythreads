import { closeSync, constants, openSync, readFileSync, writeSync } from 'node:fs';
import { posix } from 'node:path';

// A run that survives a command running out of memory (PLAN P31-04, docs/plans/codex-teams-and-oom.md section 3).
//
// Two halves, both Linux only (macOS and Windows have no such kernel killer, so both are no-ops there):
//  * the run's programs get the kernel's highest out-of-memory weight (`oom_score_adj` 1000), so when memory runs out the kernel stops the biggest program of a run
//    (a whole-repository typecheck, a test runner) and not the bridge, the live site's database or another team's run. The bridge's own weight is never touched.
//  * the count of processes the kernel killed for memory in the bridge's control group (cgroup v2 `memory.events`, `oom_kill`) is read when a command step starts
//    and when it ends; a rise in between, with a command that ended killed (exit 137 or SIGKILL) or simply failed when the agent does not say how, means that
//    command ran out of memory. The frames then mark the step and tell the thread (`run.notice`).

/** A run's programs are the first the kernel stops when the machine runs out of memory, before the live site's database or the bridge (P31-04). */
export const RUN_OOM_SCORE = 1000;

export interface OomScoreWriter {
  write(path: string, text: string): void;
}

const procWriter: OomScoreWriter = {
  write: (path, text) => {
    const fd = openSync(path, constants.O_WRONLY);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * Gives a program the bridge just started the run's out-of-memory weight. Called right after `spawn` returns, in the same tick: the program has only just been
 * exec'd and cannot have started a child of its own yet, and every child it starts later inherits the weight. Raising one's own child's weight needs no privilege.
 * Never throws (a machine that refuses the write runs the program as before); false when nothing was written. Never called for the bridge's own pid.
 */
export function raiseOomScore(pid: number, value: number = RUN_OOM_SCORE, writer: OomScoreWriter = procWriter, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    writer.write(`/proc/${pid}/oom_score_adj`, String(value));
    return true;
  } catch {
    return false;
  }
}

/** What the bridge reads of its own control group: how many processes the kernel killed for memory so far, and the group's memory limit. Null: not known here. */
export interface MemoryWatch {
  oomKills(): number | null;
  limitBytes(): number | null;
}

export interface CgroupFiles {
  read(path: string): string;
}

const sysFiles: CgroupFiles = { read: (path) => readFileSync(path, 'utf8') };

/** The cgroup v2 folder of this process (`0::/system.slice/x.service` is `/sys/fs/cgroup/system.slice/x.service`); null on cgroup v1 or when unreadable. */
export function ownCgroupDir(files: CgroupFiles = sysFiles): string | null {
  let text: string;
  try {
    text = files.read('/proc/self/cgroup');
  } catch {
    return null;
  }
  const line = text.split('\n').find((l) => l.startsWith('0::'));
  if (line === undefined) return null;
  const rel = line.slice(3).trim();
  if (!rel.startsWith('/') || rel.split('/').includes('..')) return null;
  return posix.join('/sys/fs/cgroup', rel);
}

/** The `oom_kill` count of a `memory.events` file; null when the line is missing. */
export function oomKillsOf(text: string): number | null {
  const m = /^oom_kill (\d{1,12})$/m.exec(text);
  return m === null ? null : Number(m[1]);
}

/** A `memory.max` value in bytes; null for `max` (no limit) or anything else. */
export function limitOf(text: string): number | null {
  const t = text.trim();
  return /^\d{1,20}$/.test(t) ? Number(t) : null;
}

/** The watch of the bridge's own control group (the systemd unit on a server or host, the container in a pod); null where there is none to read (not Linux, cgroup v1). */
export function cgroupMemoryWatch(files: CgroupFiles = sysFiles, platform: NodeJS.Platform = process.platform): MemoryWatch | null {
  if (platform !== 'linux') return null;
  const dir = ownCgroupDir(files);
  if (dir === null) return null;
  const read = <T>(name: string, parse: (text: string) => T | null): T | null => {
    try {
      return parse(files.read(posix.join(dir, name)));
    } catch {
      return null;
    }
  };
  if (read('memory.events', oomKillsOf) === null) return null; // no memory controller here
  return { oomKills: () => read('memory.events', oomKillsOf), limitBytes: () => read('memory.max', limitOf) };
}

/** How a command step ended, as far as the adapter says: an exit code and a signal name, each null when not said. */
export interface ExitSign {
  code: number | null;
  signal: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exitCode = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= -255 && v <= 1024 ? v : null);
const signalName = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z0-9]{1,12}$/.test(v) ? v : typeof v === 'number' && Number.isInteger(v) ? String(v) : null);

/**
 * The exit of a command step, read by name and kept as two short values (nothing of the output leaves; frames.ts THE RULE): Codex sends `_meta.terminal_exit`
 * (`exit_code`, `signal`) or `rawOutput.exit_code`; Claude's failed Bash step has a `rawOutput` text that starts "Exit code <n>", and only that number is read.
 */
export function exitSignOf(raw: unknown): ExitSign | null {
  if (!isRecord(raw)) return null;
  const meta = raw['_meta'];
  if (isRecord(meta) && isRecord(meta['terminal_exit'])) {
    const t = meta['terminal_exit'];
    const sign = { code: exitCode(t['exit_code']), signal: signalName(t['signal']) };
    if (sign.code !== null || sign.signal !== null) return sign;
  }
  const out = raw['rawOutput'];
  if (isRecord(out)) {
    const code = exitCode(out['exit_code']);
    if (code !== null) return { code, signal: null };
  }
  if (typeof out === 'string') {
    const m = /^Exit code (\d{1,3})\b/.exec(out.slice(0, 32));
    if (m !== null) return { code: Number(m[1]), signal: null };
  }
  return null;
}

/** Killed by SIGKILL, the kernel's out-of-memory signal: exit code 137 (128 + 9) from a shell, or the signal itself. */
export const killedBySigkill = (sign: ExitSign): boolean => sign.code === 137 || sign.signal === 'SIGKILL' || sign.signal === 'KILL' || sign.signal === '9';

/**
 * Whether a command step ran out of memory: the kernel killed a process of the bridge's group while the step ran (`before` < `after`), and the step ended killed,
 * or failed with no exit said. A rise with a step that ended normally, or with an exit other than a kill, was some other program (another run's, say).
 */
export function ranOutOfMemory(before: number | null, after: number | null, failed: boolean, sign: ExitSign | null): boolean {
  if (before === null || after === null || after <= before) return false;
  if (sign !== null && (sign.code !== null || sign.signal !== null)) return killedBySigkill(sign);
  return failed;
}
