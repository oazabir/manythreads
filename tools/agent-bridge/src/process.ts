import { spawn, type ChildProcess } from 'node:child_process';

// Starting an agent CLI: argv only (never a shell), its own process group so a stop reaches the children it started,
// the prompt on stdin, and bounded buffers for what it prints.

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  onLine: (line: string) => void;
}

export interface ChildHandle {
  /** Send a signal to the whole process group. */
  signal(sig: NodeJS.Signals): void;
  /** Resolves when the process has ended and every line of stdout has been delivered. */
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError: string | null }>;
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

export function startChild(bin: string, args: string[], opts: SpawnOptions): ChildHandle {
  const child: ChildProcess = spawn(bin, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let stderrTail = '';
  let spawnError: string | null = null;
  let buf = '';
  let dropping = false;

  child.stdin?.on('error', () => undefined); // the child may exit before reading its prompt
  child.stdin?.end(opts.stdin);

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (dropping) dropping = false;
      else opts.onLine(line);
    }
    if (buf.length > MAX_LINE_BYTES) {
      buf = '';
      dropping = true; // the rest of an oversized line is skipped
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError: string | null }>((resolve) => {
    child.on('error', (err) => {
      spawnError = (err as NodeJS.ErrnoException).code ?? 'error';
    });
    // `close` fires after stdout and stderr have ended, so no line is lost.
    child.on('close', (code, signal) => {
      if (buf.trim() !== '' && !dropping) opts.onLine(buf);
      buf = '';
      resolve({ code, signal, stderrTail, spawnError });
    });
  });

  return {
    signal: (sig) => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig); // the group
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

/** The last non-empty stderr line, with every secret removed and clipped: all a failed run says about why. */
export function lastLine(text: string, secrets: readonly string[]): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return redact(lines[lines.length - 1] ?? '', secrets).slice(0, 300);
}

/**
 * The sign-in token shapes of a Claude or Codex runner (PLAN P19-12): the same ones the platform's data-protection step names `signin-token`
 * (packages/plugins/guardrails-dlp/src/dlp.ts; test/process.test.ts keeps the two together). The bridge is its own package and cannot import the plugin, so the patterns are
 * written out here. They are guesses until the real files are measured (P19-01, P19-13); the last one, the sign-in file's own field names, needs no guess about the value.
 * Linear time: every quantifier is bounded and a pattern starts only where a run of token characters starts (the look-behind).
 */
const RUN_START = '(?<![A-Za-z0-9_-])';
const TOKEN_SHAPES: readonly RegExp[] = [
  new RegExp(`${RUN_START}sk-ant-o(?:at|rt)\\d{2}-[A-Za-z0-9_-]{16,512}`, 'g'),
  new RegExp(`${RUN_START}eyJ[A-Za-z0-9_-]{8,4096}\\.eyJ[A-Za-z0-9_-]{8,4096}\\.[A-Za-z0-9_-]{8,4096}`, 'g'),
];
const REFRESH_TOKEN = new RegExp(`${RUN_START}rt_[A-Za-z0-9_-]{20,200}(?:\\.[A-Za-z0-9_-]{20,200})?`, 'g');
const TOKEN_FIELD = /("(?:refresh_token|access_token|id_token|accessToken|refreshToken|idToken)"[ \t\r\n]{0,8}:[ \t\r\n]{0,8}")[^"\s]{16,4096}"/g;

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[hidden]');
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, '[hidden]');
  out = out.replace(REFRESH_TOKEN, (m) => (/[0-9A-Z]/.test(m) ? '[hidden]' : m));
  out = out.replace(TOKEN_FIELD, '$1[hidden]"');
  // A Bearer token is cut whole (a JSON web token is longer than any cap the old rule had), so run it after the shapes above that cover a long token.
  return out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [hidden]');
}
