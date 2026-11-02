import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { PTY_HELPER } from './pty-helper.ts';

// The one seam between the terminal and the machine (PLAN P7-09): something that starts a shell on a pseudo terminal and hands back its bytes. The rest of the plugin only knows this
// interface, so a better implementation (a library, a container, a separate pod) replaces the Python program without touching the limits, the recording or the routes. The tests of the
// session logic use a scripted fake that implements it; the tests of the real thing start a real shell.

export type PtyMode = 'jail' | 'plain';

export interface PtyStart {
  /** The folder the shell starts in (and, in `jail`, the memory-backed `/work` is copied from). It already holds the seed files. */
  workDir: string;
  mode: PtyMode;
  uid: number;
  gid: number;
  cols: number;
  rows: number;
}

export interface PtyExit {
  /** The shell's exit status; null when it was killed. */
  code: number | null;
  /** Set when the sandbox could not be built (nothing ran): the one line the starter wrote on its own pipe (never read from what the shell prints). */
  fatal: string | null;
}

export interface PtyProcess {
  /** Types into the shell. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Stops reading what the shell prints (the shell blocks when its pipe is full), and starts again. */
  pause(): void;
  resume(): void;
  /** Ends the shell and everything in its sandbox, and answers when it is gone. Safe to call twice. */
  kill(): Promise<void>;
  onData(listener: (text: string) => void): void;
  onExit(listener: (info: PtyExit) => void): void;
}

export interface PtyStarter {
  start(options: PtyStart): PtyProcess;
}

/** Exported for the tests of the helper itself. */
export const PYTHON = process.env['MANYTHREADS_TERMINAL_PYTHON'] || 'python3';

export const pythonPty: PtyStarter = {
  start(options) {
    const child: ChildProcess = spawn(PYTHON, ['-I', '-c', PTY_HELPER, options.mode, options.workDir, String(options.uid), String(options.gid), String(options.cols), String(options.rows)], {
      // nothing of the server's environment reaches the helper, and so none can reach the shell
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      // 0 keys in, 1 the shell's output, 2 nothing, 3 resize lines, 4 the one "fatal:" line when the sandbox could not be built (never the shell's own terminal)
      stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
      cwd: '/',
    });
    const decoder = new StringDecoder('utf8');
    const dataListeners: Array<(text: string) => void> = [];
    const exitListeners: Array<(info: PtyExit) => void> = [];
    let fatal: string | null = null;
    let fatalText = '';
    let ended = false;
    let exited: Promise<void>;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (text !== '') for (const l of dataListeners) l(text);
    });
    (child.stdio[4] as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      fatalText = (fatalText + chunk.toString('utf8')).slice(-400);
      const m = /fatal: ([^\n]{1,300})/.exec(fatalText);
      if (m) fatal = m[1] ?? null;
    });
    for (const stream of [child.stdin, child.stdio[3], child.stdio[4]]) stream?.on('error', () => undefined);
    // assigned once, here; the kill path waits on it
    // eslint-disable-next-line prefer-const
    exited = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        ended = true;
        const rest = decoder.end();
        if (rest !== '') for (const l of dataListeners) l(rest);
        for (const l of exitListeners) l({ code: signal ? null : code, fatal });
        resolve();
      });
      child.once('error', () => {
        fatal = fatal ?? 'the terminal program could not be started';
      });
    });
    return {
      write(data) {
        if (!ended && child.stdin?.writable) child.stdin.write(data);
      },
      resize(cols, rows) {
        const ctl = child.stdio[3] as NodeJS.WritableStream | null;
        if (!ended && ctl?.writable) ctl.write(`R ${String(Math.trunc(cols))} ${String(Math.trunc(rows))}\n`);
      },
      pause() {
        child.stdout?.pause();
      },
      resume() {
        child.stdout?.resume();
      },
      async kill() {
        if (ended) return;
        // a paused output pipe would keep the program from ever reading its input again, so it could not see the input close
        child.stdout?.resume();
        // ask nicely first: the program ends the shell and its whole sandbox when its input closes; then make sure
        child.stdin?.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 1500);
        timer.unref();
        await exited;
        clearTimeout(timer);
      },
      onData(listener) {
        dataListeners.push(listener);
      },
      onExit(listener) {
        exitListeners.push(listener);
      },
    };
  },
};
