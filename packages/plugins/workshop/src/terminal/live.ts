import { TERMINAL_END_WORDS, TERMINAL_LIMITS, TerminalClientFrame, type TerminalEndReason, type TerminalLimitsShape, type TerminalServerFrame } from '@manythreads/shared';
import type { TerminalConfig } from './config.ts';
import type { PtyExit, PtyProcess } from './pty.ts';
import type { Recorder } from './recorder.ts';

// One running shell and the hard limits around it (PLAN P7-09). It knows nothing of the database, the socket library or the HTTP routes: it is handed the shell, a place to send frames and
// the recorder, and it ends the shell (always, however the end came) when ANY of these happens: the page closes, an admin presses End, nothing was typed for the idle time, the longest time
// passed, the shell printed or was sent more than its allowance, the shell exited, a frame was not valid, or the owner of the terminal lost the right to have it.

/** Where the frames go: the socket in production, a list in a test. */
export interface TerminalSink {
  send(frame: TerminalServerFrame): void;
  close(code: number, reason: string): void;
}

export interface TerminalEnd {
  reason: TerminalEndReason;
  bytesIn: number;
  bytesOut: number;
  startedAt: Date;
  endedAt: Date;
}

export type LiveOptions = {
  config: Pick<TerminalConfig, 'idleMs' | 'maxMs' | 'outputBytesPerSecond' | 'outputBytesTotal' | 'inputBytesTotal'>;
  /** The same limits as the page is told (seconds). */
  limits: TerminalLimitsShape;
  pty: PtyProcess;
  sink: TerminalSink;
  recorder: Recorder;
  /** Removes the folder of the terminal; runs after the shell is gone. */
  cleanup: () => Promise<void>;
  credentialsRevoked: number;
  /** How often the record is redacted and handed to `checkpoint` while open. */
  checkpointMs?: number;
  checkpoint?: (state: { bytesIn: number; bytesOut: number }) => Promise<void>;
};

const WINDOW_MS = 100;
const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

export class LiveTerminal {
  private bytesIn = 0;
  private bytesOut = 0;
  private windowBytes = 0;
  private paused = false;
  private over = false;
  private readonly startedAt = new Date();
  private idleTimer: NodeJS.Timeout | undefined;
  private maxTimer: NodeJS.Timeout | undefined;
  private windowTimer: NodeJS.Timeout | undefined;
  private checkpointTimer: NodeJS.Timeout | undefined;
  private endedPromise: Promise<TerminalEnd> | undefined;
  private resolveEnded!: (end: TerminalEnd) => void;
  private readonly result: Promise<TerminalEnd>;
  private exit: PtyExit | undefined;

  constructor(private readonly options: LiveOptions) {
    this.result = new Promise<TerminalEnd>((resolve) => {
      this.resolveEnded = resolve;
    });
  }

  /** Resolves when the terminal has ended and everything is cleaned up. */
  get ended(): Promise<TerminalEnd> {
    return this.result;
  }

  get isOver(): boolean {
    return this.over;
  }

  start(): void {
    const { config, pty, sink } = this.options;
    pty.onData((text) => this.output(text));
    pty.onExit((info) => {
      this.exit = info;
      // the shell ended by itself (the person typed `exit`), or could not be started at all
      void this.end(info.fatal !== null ? 'error' : 'closed');
    });
    this.idleTimer = setTimeout(() => void this.end('idle'), config.idleMs);
    this.maxTimer = setTimeout(() => void this.end('max_duration'), config.maxMs);
    this.windowTimer = setInterval(() => {
      this.windowBytes = 0;
      if (this.paused && !this.over) {
        this.paused = false;
        pty.resume();
      }
    }, WINDOW_MS);
    const every = this.options.checkpointMs ?? 5000;
    this.checkpointTimer = setInterval(() => void this.saveCheckpoint(), every);
    for (const t of [this.idleTimer, this.maxTimer, this.windowTimer, this.checkpointTimer]) t.unref();
    sink.send({ t: 'ready', limits: this.options.limits, credentialsRevoked: this.options.credentialsRevoked });
  }

  /** One frame from the page (text, JSON). Anything that is not a valid frame ends the terminal. */
  input(raw: string | Uint8Array): void {
    if (this.over) return;
    if (typeof raw !== 'string') {
      void this.end('error', 1003, 'text frames only');
      return;
    }
    if (raw.length > TERMINAL_LIMITS.inputFrameMax * 6 + 200) {
      void this.end('error', 1009, 'frame too large');
      return;
    }
    let frame: TerminalClientFrame;
    try {
      frame = TerminalClientFrame.parse(JSON.parse(raw));
    } catch {
      void this.end('error', 1007, 'bad frame');
      return;
    }
    if (frame.t === 'size') {
      this.options.pty.resize(frame.cols, frame.rows);
      return;
    }
    this.bytesIn += byteLength(frame.d);
    if (this.bytesIn > this.options.config.inputBytesTotal) {
      void this.end('input_limit');
      return;
    }
    // only a key resets the idle clock
    if (this.idleTimer) this.idleTimer.refresh();
    this.options.pty.write(frame.d);
  }

  private output(text: string): void {
    if (this.over) return;
    const { config, sink, pty, recorder } = this.options;
    this.bytesOut += byteLength(text);
    this.windowBytes += byteLength(text);
    if (this.bytesOut > config.outputBytesTotal) {
      void this.end('output_limit');
      return;
    }
    recorder.push(text);
    sink.send({ t: 'out', d: text });
    // slow the shell down instead of cutting it: the share of the per-second allowance for one window is spent, so stop reading until the next window
    if (!this.paused && this.windowBytes >= Math.max(1, Math.floor((config.outputBytesPerSecond * WINDOW_MS) / 1000))) {
      this.paused = true;
      pty.pause();
    }
  }

  private async saveCheckpoint(): Promise<void> {
    const { recorder, checkpoint } = this.options;
    if (this.over) return;
    await recorder.flush();
    if (checkpoint && !this.over) await checkpoint({ bytesIn: this.bytesIn, bytesOut: this.bytesOut }).catch(() => undefined);
  }

  /**
   * Ends the terminal: the shell and everything in its sandbox are killed, the record is completed, the folder is deleted, the page is told why. Safe to call many times; the first reason wins.
   * `code` is the socket close code (1000 unless the page sent something invalid).
   */
  end(reason: TerminalEndReason, code = 1000, closeText?: string): Promise<TerminalEnd> {
    if (this.endedPromise) return this.endedPromise;
    this.over = true;
    this.endedPromise = this.finish(reason, code, closeText);
    return this.endedPromise;
  }

  private async finish(reason: TerminalEndReason, code: number, closeText?: string): Promise<TerminalEnd> {
    const { sink, pty, recorder, cleanup } = this.options;
    for (const t of [this.idleTimer, this.maxTimer]) if (t) clearTimeout(t);
    for (const t of [this.windowTimer, this.checkpointTimer]) if (t) clearInterval(t);
    let message = TERMINAL_END_WORDS[reason];
    if (reason === 'error' && this.exit?.fatal) message = `The test sandbox could not be started: ${this.exit.fatal}`.slice(0, 300);
    try {
      sink.send({ t: 'end', reason, message });
    } catch {
      // the page is gone
    }
    try {
      // a shell stopped by the output allowance has its pipe paused: start reading again, or the program could not see the input close
      pty.resume();
      await pty.kill();
    } catch {
      // the helper is already gone
    }
    await recorder.flush(true);
    await cleanup().catch(() => undefined);
    try {
      sink.close(code, closeText ?? (reason === 'closed' || reason === 'ended_by_admin' ? 'closed' : reason));
    } catch {
      // already closed
    }
    const end: TerminalEnd = { reason, bytesIn: this.bytesIn, bytesOut: this.bytesOut, startedAt: this.startedAt, endedAt: new Date() };
    this.resolveEnded(end);
    return end;
  }
}
