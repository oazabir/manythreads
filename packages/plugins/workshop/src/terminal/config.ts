import { randomInt } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_LIMITS, type TerminalLimitsShape } from '@manythreads/shared';
import type { PtyMode } from './pty.ts';

// How the terminal is switched on and how far it is allowed to go (PLAN P7-09). Everything here comes from the server's environment, never from a request.
//
//   MANYTHREADS_TERMINAL_ENABLED=1        the terminal exists at all. Off by default: a shell on the server's machine is something an operator chooses.
//   MANYTHREADS_TERMINAL_ISOLATION=jail   (default) the shell runs in its own world: own processes, no network, own files. Needs the root user on Linux with the namespace calls.
//                                         `none` runs the shell as an unprivileged user in a folder of its own on the machine's real file system, with NO network, file or process
//                                         isolation; for a machine that is itself a throwaway (a test box). It needs the root user too (to drop to another user), and the terminal
//                                         refuses to start when the server is not root: a non-root server would run the shell as ITSELF and the shell could read its secrets.
//   MANYTHREADS_TERMINAL_UID / _GID       the user the shell runs as. Not set (the default): every terminal gets a user number of its own in 60000-64999, so the per-user process
//                                         limit is the terminal's alone and no other service on the machine can be starved by it. Set: that one fixed user (it must not be root).
//   MANYTHREADS_TERMINAL_ROOT             where the per-terminal folders are made. Default: a folder in the temporary directory named after the server's user number; it must be
//                                         a real folder owned by the server's user that nobody else can write to, or the terminal is not available. Point it somewhere private in production.
//   MANYTHREADS_TERMINAL_IDLE_SECONDS / _MAX_SECONDS / _OUTPUT_BYTES_PER_SECOND / _OUTPUT_BYTES_TOTAL / _INPUT_BYTES_TOTAL
//                                         can LOWER a limit (the tests do); a value above the built-in limit is ignored.

export interface TerminalConfig {
  enabled: boolean;
  isolation: PtyMode;
  /** The fixed user of the shell (default 65534). */
  uid: number;
  gid: number;
  /** True when no user was set in the environment: each terminal gets its own number (see `pickIds`). */
  ownUser: boolean;
  root: string;
  idleMs: number;
  maxMs: number;
  waitingMs: number;
  outputBytesPerSecond: number;
  outputBytesTotal: number;
  inputBytesTotal: number;
  transcriptChars: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/** A number from the environment that may only lower the built-in limit. */
function lowered(env: Env, name: string, builtIn: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return builtIn;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < builtIn ? n : builtIn;
}

function idNumber(env: Env, name: string, fallback: number): number {
  const n = Number(env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readTerminalConfig(env: Env = process.env): TerminalConfig {
  const isolation: PtyMode = env['MANYTHREADS_TERMINAL_ISOLATION'] === 'none' ? 'plain' : 'jail';
  return {
    enabled: env['MANYTHREADS_TERMINAL_ENABLED'] === '1',
    isolation,
    uid: idNumber(env, 'MANYTHREADS_TERMINAL_UID', 65534),
    gid: idNumber(env, 'MANYTHREADS_TERMINAL_GID', 65534),
    ownUser: env['MANYTHREADS_TERMINAL_UID'] === undefined && env['MANYTHREADS_TERMINAL_GID'] === undefined,
    root: env['MANYTHREADS_TERMINAL_ROOT'] || join(tmpdir(), `manythreads-terminal-${String(typeof process.geteuid === 'function' ? process.geteuid() : 0)}`),
    idleMs: lowered(env, 'MANYTHREADS_TERMINAL_IDLE_SECONDS', TERMINAL_LIMITS.idleSeconds) * 1000,
    maxMs: lowered(env, 'MANYTHREADS_TERMINAL_MAX_SECONDS', TERMINAL_LIMITS.maxSeconds) * 1000,
    waitingMs: lowered(env, 'MANYTHREADS_TERMINAL_WAITING_SECONDS', TERMINAL_LIMITS.waitingSeconds) * 1000,
    outputBytesPerSecond: Math.floor(lowered(env, 'MANYTHREADS_TERMINAL_OUTPUT_BYTES_PER_SECOND', TERMINAL_LIMITS.outputBytesPerSecond)),
    outputBytesTotal: Math.floor(lowered(env, 'MANYTHREADS_TERMINAL_OUTPUT_BYTES_TOTAL', TERMINAL_LIMITS.outputBytesTotal)),
    inputBytesTotal: Math.floor(lowered(env, 'MANYTHREADS_TERMINAL_INPUT_BYTES_TOTAL', TERMINAL_LIMITS.inputBytesTotal)),
    transcriptChars: TERMINAL_LIMITS.transcriptChars,
  };
}

/** The limits as the page and the record show them (seconds, whole numbers). */
export function limitsOf(config: TerminalConfig): TerminalLimitsShape {
  return {
    idleSeconds: Math.max(1, Math.round(config.idleMs / 1000)),
    maxSeconds: Math.max(1, Math.round(config.maxMs / 1000)),
    outputBytesPerSecond: config.outputBytesPerSecond,
    outputBytesTotal: config.outputBytesTotal,
    inputBytesTotal: config.inputBytesTotal,
    transcriptChars: config.transcriptChars,
  };
}

/** The user and group of one terminal's shell: the fixed ones from the environment, or a number of its own that no other running terminal has (so the per-user process limit is that terminal's alone). */
export function pickIds(config: Pick<TerminalConfig, 'uid' | 'gid' | 'ownUser'>, taken: ReadonlySet<number>): { uid: number; gid: number } {
  if (!config.ownUser) return { uid: config.uid, gid: config.gid };
  for (let i = 0; i < 200; i += 1) {
    const n = 60_000 + randomInt(0, 5000);
    if (!taken.has(n)) return { uid: n, gid: n };
  }
  return { uid: config.uid, gid: config.gid };
}
