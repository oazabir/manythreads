import { spawn } from 'node:child_process';
import { redact } from '../process.ts';

// A program that insists on a terminal (Claude's `--cli auth login`), run under a pseudo-terminal made by the `script` tool (util-linux on Linux, BSD `script` on macOS), which
// every common server image has. No native module is added to the bridge: it has no dependency that makes a pty, and `script` was measured to work for the login
// (docs/spikes/acp-measured.md, "Sign-in and sign-out"). The terminal is made 500 columns wide so a long sign-in address is printed on one line.

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Called with what the program printed, as plain text (colour and cursor codes removed). Never logged by the bridge. */
  onText: (text: string) => void;
}

export interface PtyHandle {
  /** Type a line (the pasted code). False when the program no longer reads. */
  writeLine(text: string): boolean;
  signal(sig: NodeJS.Signals): void;
  /** Ends when the program does. `spawnError` is set when `script` itself is missing. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CSI sequences (colours, cursor moves), OSC sequences (window titles), and the carriage returns a terminal adds. Linear: no nested quantifiers.
const ANSI = new RegExp(`${ESC}\\[[0-9;?]{0,20}[ -/]{0,4}[@-~]|${ESC}\\][^${BEL}${ESC}]{0,2000}(?:${BEL}|${ESC}\\\\)|${ESC}[()][A-Za-z0-9]|\\r`, 'g');

export const plainText = (raw: string): string => raw.replace(ANSI, '');

/** One argument for a POSIX shell: single quotes, and a quote inside closed and reopened. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether this machine can run a program under a pseudo-terminal this way. */
export const ptySupported = (): boolean => process.platform === 'linux' || process.platform === 'darwin';

export function startPty(command: string, args: string[], opts: PtyOptions): PtyHandle {
  const line = `stty cols 500 rows 50 2>/dev/null; exec ${[command, ...args].map(quote).join(' ')}`;
  // Linux: `script -q -f -c <command line> /dev/null`. macOS: `script -q /dev/null sh -c <command line>`.
  const argv = process.platform === 'darwin' ? ['-q', '/dev/null', 'sh', '-c', line] : ['-q', '-f', '-c', line, '/dev/null'];
  const child = spawn('script', argv, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  child.stdin?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => opts.onText(plainText(chunk)));
  // The pseudo-terminal merges the program's own stderr into stdout; `script`'s own stderr carries nothing the page needs.
  child.stderr?.resume();
  let spawnError: string | null = null;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>((resolve) => {
    child.on('error', (err) => {
      spawnError = (err as NodeJS.ErrnoException).code ?? 'error';
    });
    child.on('close', (code, signal) => resolve({ code, signal, spawnError }));
  });
  return {
    writeLine: (text) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(`${text}\n`);
      return true;
    },
    signal: (sig) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    },
    done,
  };
}

/** The last non-empty line of what a terminal program printed, with the secrets removed and clipped: all a failed sign-in says about why. */
export function lastTerminalLine(text: string, secrets: readonly string[]): string {
  const lines = plainText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return redact(lines[lines.length - 1] ?? '', secrets).slice(0, 300);
}
