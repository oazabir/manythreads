import { TERMINAL_LIMITS, type TerminalClientFrame, type TerminalServerFrame } from '@manythreads/shared';
import { KEY_EOF, KEY_INTERRUPT } from './model';
import type { TerminalTransport } from './transport';

/*
 * A pretend shell for the mock mode and the tests (PLAN P7-09): the same frames the server sends, with a few commands answered the way the real sandbox would answer them. It reads what
 * is typed, echoes it back as a terminal does, and answers `id`, `pwd`, `ls`, `echo`, `env`, `whoami` and `exit`. Ctrl+C gives a fresh prompt; Ctrl+D ends the shell. Nothing here runs anything.
 */

const PROMPT = 'nobody@sandbox:/work$ ';

const ANSWERS: Readonly<Record<string, string>> = {
  id: 'uid=65534(nobody) gid=65534(nogroup) groups=65534(nogroup)',
  whoami: 'nobody',
  pwd: '/work',
  ls: 'README.txt',
  env: 'HOME=/work\nPATH=/usr/local/bin:/usr/bin:/bin\nTERM=xterm-256color',
};

export function answerFor(line: string): string {
  const t = line.trim();
  if (t === '') return '';
  if (Object.hasOwn(ANSWERS, t)) return ANSWERS[t] as string;
  const echo = /^echo\s+(.*)$/.exec(t);
  if (echo) return (echo[1] ?? '').replace(/^["']|["']$/g, '');
  if (t.startsWith('curl') || t.startsWith('ping') || t.startsWith('wget')) return `${t.split(/\s+/)[0] ?? ''}: network is unreachable`;
  return `bash: ${t.split(/\s+/)[0] ?? ''}: command not found`;
}

export type MockShellOptions = {
  /** Milliseconds before each answer; 0 answers on the next turn of the event loop. */
  delayMs?: number;
  /** Frames the pretend server sends first instead of the ready frame; for a test of an odd start. */
  script?: TerminalServerFrame[];
  /** Everything the page sent, for a test to read. */
  sent?: TerminalClientFrame[];
};

export function mockShellTransport(options: MockShellOptions = {}): TerminalTransport {
  const delay = options.delayMs ?? 0;
  let frames: ((f: TerminalServerFrame) => void) | null = null;
  let closed: ((i: { code: number; reason: string }) => void) | null = null;
  let over = false;
  let pending = '';
  const emit = (f: TerminalServerFrame): void => {
    if (!over) frames?.(f);
  };
  const out = (d: string): void => emit({ t: 'out', d });
  const finish = (reason: 'closed' | 'idle', message: string): void => {
    if (over) return;
    emit({ t: 'end', reason, message });
    over = true;
    closed?.({ code: 1000, reason: 'closed' });
  };
  const limits = {
    idleSeconds: TERMINAL_LIMITS.idleSeconds,
    maxSeconds: TERMINAL_LIMITS.maxSeconds,
    outputBytesPerSecond: TERMINAL_LIMITS.outputBytesPerSecond,
    outputBytesTotal: TERMINAL_LIMITS.outputBytesTotal,
    inputBytesTotal: TERMINAL_LIMITS.inputBytesTotal,
    transcriptChars: TERMINAL_LIMITS.transcriptChars,
  };
  setTimeout(() => {
    if (options.script) {
      for (const f of options.script) emit(f);
      return;
    }
    emit({ t: 'ready', limits, credentialsRevoked: 2 });
    out(`A throwaway test sandbox. Nothing here reaches real work.\r\n${PROMPT}`);
  }, delay);

  return {
    send(frame) {
      options.sent?.push(frame);
      if (over || frame.t !== 'in') return;
      setTimeout(() => {
        for (const ch of frame.d) {
          if (ch === KEY_INTERRUPT) {
            pending = '';
            out(`^C\r\n${PROMPT}`);
          } else if (ch === KEY_EOF) {
            out('logout\r\n');
            finish('closed', 'Closed.');
          } else if (ch === '\n') {
            const line = pending;
            pending = '';
            if (line.trim() === 'exit') {
              out(`${line}\r\nexit\r\n`);
              finish('closed', 'Closed.');
              return;
            }
            const answer = answerFor(line);
            out(`${line}\r\n${answer === '' ? '' : `${answer.replace(/\n/g, '\r\n')}\r\n`}${PROMPT}`);
          } else {
            pending += ch;
          }
        }
      }, delay);
    },
    close() {
      if (over) return;
      over = true;
      closed?.({ code: 1000, reason: 'closed' });
    },
    onFrame(l) {
      frames = l;
    },
    onClose(l) {
      closed = l;
    },
  };
}
