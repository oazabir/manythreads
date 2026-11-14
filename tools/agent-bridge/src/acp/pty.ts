import { spawn } from 'node:child_process';

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
  /**
   * Type a line (the pasted code): the text, then, a moment later, Enter as a carriage return. Measured against the real `claude auth login` (docs/spikes/acp-measured.md): the
   * program puts its terminal in raw mode (no echo, no CR-to-LF change) and submits on either a line feed or a carriage return, with the Enter in the same write as the text or
   * after a pause, and with the text wrapped as a bracketed paste or not. The pause and the carriage return are what a person's keyboard does, so they are the safest of the ways
   * that work. False when the program no longer reads.
   */
  writeLine(text: string): boolean;
  /** Signal the program's whole session (it leads its own process group under the terminal) and the terminal tool. */
  signal(sig: NodeJS.Signals): void;
  /** True once the program has ended. */
  readonly exited: boolean;
  /** Ends when the program does. `spawnError` is set when `script` itself is missing. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CSI sequences (colours, cursor moves), OSC sequences (window titles, hyperlinks) and the carriage returns a terminal adds. An OSC ends at BEL, at ESC + backslash, or, as the real Claude
// login ends its hyperlink (OSC 8, measured), at the next ESC: without that, the hyperlink's own copy of the address is left in the text in front of the printed address and the two run
// together into one address twice as long. Linear: no nested quantifiers.
const ANSI = new RegExp(`${ESC}\\[[0-9;?]{0,20}[ -/]{0,4}[@-~]|${ESC}\\][^${BEL}${ESC}]{0,4000}(?:${BEL}|${ESC}\\\\|(?=${ESC}))|${ESC}[()][A-Za-z0-9]|\\r`, 'g');

export const plainText = (raw: string): string => raw.replace(ANSI, '');

/** Where an escape sequence that the text ends in the middle of begins (so its start waits for the rest), or the text's length when it ends cleanly. */
function unfinishedAt(raw: string): number {
  let cut = raw.length;
  // A lone escape, or the start of a colour or cursor code, at the very end: the rest comes with the next chunk.
  const esc = raw.lastIndexOf(ESC);
  if (esc >= 0 && raw.length - esc <= 30 && new RegExp(`^${ESC}(?:\\[[0-9;?]{0,20}[ -/]{0,4}|[()]|)$`).test(raw.slice(esc))) cut = esc;
  // An OSC (a window title, a hyperlink) is finished by BEL or by any later ESC (see above): while neither has come it waits, but never for long.
  const osc = raw.slice(0, cut).lastIndexOf(`${ESC}]`);
  if (osc >= 0 && cut - osc <= 4200) {
    const tail = raw.slice(osc + 2, cut);
    if (!tail.includes(BEL) && !tail.includes(ESC)) cut = osc;
  }
  return cut;
}

/**
 * Turns what a terminal program printed, in chunks that may cut an escape sequence in two, into plain text chunks. The cut-off start of a sequence is kept until the rest comes, so a
 * hyperlink or a colour code that arrives split is still removed whole (and half a sign-in address is never left in the text).
 */
export function plainChunks(onText: (text: string) => void): (raw: string) => void {
  let carry = '';
  return (chunk) => {
    const raw = carry + chunk;
    const cut = unfinishedAt(raw);
    carry = raw.slice(cut);
    const text = plainText(raw.slice(0, cut));
    if (text !== '') onText(text);
  };
}

/** One argument for a POSIX shell: single quotes, and a quote inside closed and reopened. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether this machine can run a program under a pseudo-terminal this way. */
export const ptySupported = (): boolean => process.platform === 'linux' || process.platform === 'darwin';

/** The pause between the pasted text and Enter (a terminal app that treats a quick burst as a paste would take the Enter as part of the text). */
const ENTER_AFTER_MS = 100;

export function startPty(command: string, args: string[], opts: PtyOptions): PtyHandle {
  // The shell first tells this process its own number on descriptor 3 (it becomes the program with `exec`, so the number stays right): `script` runs the program in a new session of its own, which a
  // signal to `script` does not reach, and a stop must end the program, not only its terminal tool.
  const line = `echo $$ >&3 2>/dev/null; stty cols 500 rows 50 2>/dev/null; exec ${[command, ...args].map(quote).join(' ')}`;
  // Linux: `script -q -e -f -c <command line> /dev/null`, the shell named explicitly (script would use $SHELL), and `-e` so that script ends with the program's own exit code (measured: without
  // it script always ends 0, and a failed sign-in or sign-out looks like a good one). macOS: `script -q /dev/null sh -c <command line>`, which ends with the program's code as it is.
  const argv = process.platform === 'darwin' ? ['-q', '/dev/null', '/bin/sh', '-c', line] : ['-q', '-e', '-f', '-c', `/bin/sh -c ${quote(line)}`, '/dev/null'];
  const child = spawn('script', argv, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], shell: false });
  child.stdin?.on('error', () => undefined);
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', plainChunks(opts.onText));
  // The pseudo-terminal merges the program's own stderr into stdout; `script`'s own stderr carries nothing the page needs.
  child.stderr?.resume();
  let programPid: number | null = null;
  const pidPipe = child.stdio[3];
  if (pidPipe && 'setEncoding' in pidPipe) {
    let said = '';
    pidPipe.setEncoding('utf8');
    pidPipe.on('data', (chunk: string) => {
      said += chunk;
      const n = Number(said.trim());
      if (/^\d+\n/.test(said) && Number.isInteger(n) && n > 1) programPid = n;
    });
    pidPipe.on('error', () => undefined);
  }
  let spawnError: string | null = null;
  let exited = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>((resolve) => {
    child.on('error', (err) => {
      spawnError = (err as NodeJS.ErrnoException).code ?? 'error';
    });
    child.on('close', (code, signal) => {
      exited = true;
      resolve({ code, signal, spawnError });
    });
  });
  const kill = (pid: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  return {
    get exited() {
      return exited;
    },
    writeLine: (text) => {
      const stdin = child.stdin;
      if (exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(text);
      const enter = setTimeout(() => {
        if (!exited && !stdin.destroyed && !stdin.writableEnded) stdin.write('\r');
      }, ENTER_AFTER_MS);
      enter.unref();
      return true;
    },
    signal: (sig) => {
      if (programPid !== null) kill(programPid, sig);
      if (child.pid !== undefined) kill(child.pid, sig);
    },
    done,
  };
}
