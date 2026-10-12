import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { BotRuntimeEvent, BotRuntimeHandle, BotRuntimeInput, BotRuntimeProvider, BotRuntimeScope } from '@manythreads/sdk';
import { chatArgs, renderProfile } from './profile.ts';
import { parseHermesLine, replyText, type HermesEvent } from './stream.ts';

// The `hermes` bot_runtime provider (SPEC §7.1, §10.2; PLAN P5-10): one Hermes invocation per run, in a profile rendered
// for that run alone, talking to the run's own MCP endpoint — the per-run URL decision of docs/spikes/per-run-scoping.md.
//
// What "start and stop" means here, honestly: the runtime starts **a process** (the Hermes CLI, or whatever
// `MANYTHREADS_HERMES_BIN` names — the container's entry point in a deployment that runs Hermes in one, the devbox's own
// install in development) with `HERMES_HOME` pointed at the generated profile, and stops it by signalling it. There is no
// long-lived Hermes daemon to manage and no second copy of the agent's state: the profile is a directory under
// `MANYTHREADS_RUNTIME_DIR`, and it is removed when the run ends.
//
// The stream is Hermes' own `--format stream-json` (docs/reference/cli-commands.md on the devbox): text deltas, tool
// calls, and a terminal `result` record whose `exit_code` is the run's outcome. The prompt goes on **stdin** through
// `--query-file -`, so a message body is never shell-interpreted and never lands in an argv a process list shows.

/** The provider's id, which is also the `bots.runtime` value it runs. */
export const HERMES_RUNTIME_ID = 'hermes';

/**
 * The only parent variables a Hermes child inherits: what a program needs to find its binaries, its locale and its clock,
 * and Hermes' own `HERMES_*` settings. Everything else in the server's environment — the KMS key, the database URLs and
 * their passwords, the LiteLLM master key, the test auth token — stays in the server. A run's authority is its profile
 * (the bot's virtual key and the run's token), never the platform's credentials, so an agent that runs a shell tool
 * (`env`, `/proc/self/environ`) finds none of them (MISTAKES: child process env inheritance).
 */
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'USER', 'LOGNAME', 'SHELL', 'TERM']);
const ENV_PREFIXES = ['LC_', 'HERMES_'];

/** The child's environment: the allowlisted part of `source`, nothing else. `HERMES_HOME` is added by the caller. */
export function childEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(name) || ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) env[name] = value;
  }
  return env;
}

/**
 * Remove profile directories a crashed or killed server left behind (a profile holds the run token and the bot's key and is
 * removed when its run ends; a process that died mid-run never got to). Called once at startup; only directories older than
 * `maxAgeMs` go, so a profile another replica sharing the directory is using right now is left alone. Answers how many went.
 */
export async function sweepStaleProfiles(dataRoot: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dataRoot);
  } catch {
    return 0; // no directory yet: nothing to sweep
  }
  let removed = 0;
  for (const name of names) {
    const path = resolve(dataRoot, name);
    try {
      const info = await stat(path);
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // raced with the run that owns it, or unreadable: leave it for the next start
    }
  }
  return removed;
}

export interface HermesRuntimeOptions {
  /** The Hermes entry point (`MANYTHREADS_HERMES_BIN`, default `hermes`). */
  bin: string;
  /** Arguments before `chat` (e.g. `docker exec -i manythreads-hermes hermes`). */
  prefix: readonly string[];
  /** Where a run's profile home is written (`MANYTHREADS_RUNTIME_DIR`). */
  dataRoot: string;
  /** The environment the child may inherit from: only the allowlisted names (`childEnv`) reach it; `HERMES_HOME` is set on top. */
  env: NodeJS.ProcessEnv;
  /** How long a run may take before it is killed outright, after the Hermes turn budget has had its say. */
  killGraceSeconds: number;
  /** Injectable for tests; the real `node:child_process.spawn`. */
  spawn?: typeof nodeSpawn;
}

/** Everything the profile directory needs to be written, in order, with `..` and absolute paths refused. */
function profilePaths(dataRoot: string, home: string, files: Record<string, string>): { dir: string; written: [string, string][] } {
  const root = resolve(dataRoot);
  const dir = resolve(root, home);
  if (dir !== root && !dir.startsWith(root + sep)) throw new Error(`runtime-hermes: refusing to render outside ${root}`);
  const written: [string, string][] = [];
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(dir, path);
    if (!target.startsWith(dir + sep)) throw new Error(`runtime-hermes: refusing to write ${path} outside the profile`);
    written.push([target, content]);
  }
  return { dir, written };
}

export function createHermesProvider(options: HermesRuntimeOptions): BotRuntimeProvider {
  const spawn = options.spawn ?? nodeSpawn;

  return {
    id: HERMES_RUNTIME_ID,
    usesGateway: true,

    render: (input: BotRuntimeInput) => renderProfile(input),

    async run(input: BotRuntimeInput, scope: BotRuntimeScope): Promise<BotRuntimeHandle> {
      const profile = renderProfile(input);
      const { dir, written } = profilePaths(options.dataRoot, profile.home, profile.files);
      // The profile holds the run token and the bot's key: owner-only directory and files, and gone again if anything between
      // here and a running child fails (a spawn that throws, a full disk) — not only when the stream ends.
      const removeProfile = () => rm(dir, { recursive: true, force: true }).catch(() => undefined);
      let child: ChildProcess;
      try {
        await mkdir(resolve(options.dataRoot), { recursive: true, mode: 0o700 });
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700);
        for (const [target, content] of written) await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
        child = spawn(options.bin, [...options.prefix, ...chatArgs(input)], {
          cwd: dir,
          env: { ...childEnv(options.env), HERMES_HOME: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
          // Its own process group, so a stop reaches whatever the agent started (a shell tool's children) and not only Hermes.
          detached: true,
        });
      } catch (err) {
        await removeProfile();
        throw err;
      }
      // A child that exits before reading its prompt closes the pipe: the write error is the child's failure to report (the
      // exit handler below does), not an unhandled 'error' event that would take the server down.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input.prompt);
      // The exit is listened for *here*, not when the stream is first read: a binary that fails immediately (a wrong argv, a
      // missing model) can be gone before the job takes its first event, and a listener attached afterwards would wait for a
      // `close` that already happened — a run that never ends holds its job worker forever.
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.once('error', () => resolveExit({ code: null, signal: null }));
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        // Keep only the tail: a dying process can print a lot, and the log line is one sentence.
        stderr = (stderr + chunk.toString('utf8')).slice(-2000);
      });

      /** Signal the whole process group (the child leads one), falling back to the child alone when there is no group to hit. */
      const signal = (name: NodeJS.Signals): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        if (typeof child.pid === 'number') {
          try {
            process.kill(-child.pid, name);
            return;
          } catch {
            // no such group (already gone, or a platform without them): fall through to the child itself
          }
        }
        child.kill(name);
      };
      const kill = (() => {
        let stopped = false;
        return async (): Promise<void> => {
          if (stopped) return;
          stopped = true;
          signal('SIGTERM');
          const timer = setTimeout(() => signal('SIGKILL'), options.killGraceSeconds * 1000);
          timer.unref?.();
        };
      })();

      // A hard ceiling: the turn budget is Hermes' own, this is the platform's (a wedged process would hold the job).
      const budget = (input.limits.runBudgetSeconds ?? 600) + options.killGraceSeconds;
      const ceiling = setTimeout(() => {
        scope.log(`runtime-hermes: run ${input.endpoint?.runId ?? '?'} exceeded ${budget}s and was stopped`);
        void kill();
      }, budget * 1000);
      ceiling.unref?.();

      const events = consume(child, kill, () => stderr, exited);
      const close = () => {
        clearTimeout(ceiling);
        return removeProfile();
      };
      return {
        stop: async () => {
          await kill();
          await close();
        },
        events: (async function* stream(): AsyncGenerator<BotRuntimeEvent> {
          try {
            yield* events;
          } finally {
            await kill();
            await close();
          }
        })(),
      };
    },
  };
}

/**
 * Turn the child's stdout into the run's events, ending with exactly one terminal `result`. A process that dies without a
 * `result` record gets a synthesised failure carrying what it managed to say and the tail of its stderr — a run is never
 * silent about how it ended.
 */
async function* consume(
  child: ChildProcess,
  kill: () => Promise<void>,
  stderrTail: () => string,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
): AsyncGenerator<BotRuntimeEvent> {
  const deltas: string[] = [];
  let result: HermesEvent & { type: 'result' } | null = null;

  if (child.stdout) {
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      const event = parseHermesLine(line);
      if (!event) continue;
      if (event.type === 'text') {
        deltas.push(event.text);
        yield { type: 'text', text: event.text };
        continue;
      }
      if (event.type === 'result') {
        result = event;
        yield {
          type: 'result',
          text: replyText(deltas, event),
          ok: event.ok,
          ...(event.error === undefined ? {} : { error: event.error }),
          tokens: event.tokens,
        };
        continue;
      }
      if (event.type === 'tool_use') {
        yield { type: 'tool', name: event.name, input: event.input };
        continue;
      }
      yield { type: 'tool_result', name: event.name, ok: event.ok };
    }
  }

  const exit = await exited;
  if (result === null) {
    const tail = stderrTail().trim().split('\n').slice(-3).join(' ');
    yield {
      type: 'result',
      text: deltas.join('').trim(),
      ok: false,
      error:
        exit.signal !== null
          ? `the ${HERMES_RUNTIME_ID} run was stopped (${exit.signal})`
          : `the ${HERMES_RUNTIME_ID} run ended without a result (exit ${exit.code ?? 'unknown'})${tail === '' ? '' : `: ${tail}`}`,
      tokens: null,
    };
    await kill();
  }
}
