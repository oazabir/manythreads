import { spawn as nodeSpawn } from 'node:child_process';
import {
  RunnerUnavailableError,
  type BotRuntimeEvent,
  type BotRuntimeHandle,
  type BotRuntimeInput,
  type BotRuntimeProvider,
  type BotRuntimeScope,
  type RunnerDoor,
} from '@manythreads/sdk';
import { childEnv, removeProfileDir, startGroupProcess, writeProfile, type ProcessExit } from '@manythreads/sdk/process';
import { chatArgs, renderProfile } from './profile.ts';
import { parseHermesLine, replyText, type HermesEvent } from './stream.ts';

// The environment allowlist, the profile directory handling and the process-group start/stop live in `@manythreads/sdk/process`: the
// runner (`packages/runner`) runs the same agent the same way on another machine, and the two must not drift. They are re-exported
// here because this was their home and the plugin's tests and callers name them.
export { childEnv, passthroughNames, PROFILE_MARKER, sweepStaleProfiles } from '@manythreads/sdk/process';

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
  /**
   * The runners door (`ctx.providers.get('runner')`), looked up when a run needs it (the runners plugin may load after this one). A bot
   * whose `placement.runner` names a runner is dispatched there instead of being started in this process's host.
   */
  runners?: () => RunnerDoor | undefined;
}

export function createHermesProvider(options: HermesRuntimeOptions): BotRuntimeProvider {
  return {
    id: HERMES_RUNTIME_ID,
    usesGateway: true,
    gated: true,

    render: (input: BotRuntimeInput) => renderProfile(input),

    async run(input: BotRuntimeInput, scope: BotRuntimeScope): Promise<BotRuntimeHandle> {
      const runner = input.definition.frontmatter.placement?.runner;
      if (runner !== undefined) return runOnRunner(options, input, scope, runner);
      return runHere(options, input, scope);
    },
  };
}

/** A run that could not start: one failed `result` carrying the reason, so the run closes `failed` and says why. */
function refusedRun(reason: string, failure?: 'runner_offline'): BotRuntimeHandle {
  return {
    stop: async () => undefined,
    events: (async function* refused(): AsyncGenerator<BotRuntimeEvent> {
      yield { type: 'result', text: '', ok: false, error: reason, ...(failure ? { failure } : {}), tokens: null };
    })(),
  };
}

/** "Out of time" for a run that ended unanswered: the ceiling fired, or the run's own budget had already passed when it ended. */
function pastBudget(input: BotRuntimeInput, startedAt: number, ceilingFired: () => boolean): () => boolean {
  return () => ceilingFired() || Date.now() - startedAt >= (input.limits.runBudgetSeconds ?? 600) * 1000;
}

/**
 * The run on a runner (SPEC §7.4): the same profile, rendered here, is sent to the machine the definition names, and what comes back is
 * the child's stdout lines and its exit — the same two things a local child gives — so `consume` reads both alike. The prompt travels as
 * data in the job, never as an argument. A stop (the run job's, or the ceiling below) is sent to the runner, which signals its process
 * group; the runner enforces the budget on its own as well, so a server that dies mid-run does not leave the agent running.
 */
async function runOnRunner(options: HermesRuntimeOptions, input: BotRuntimeInput, scope: BotRuntimeScope, runner: string): Promise<BotRuntimeHandle> {
  const runId = input.endpoint?.runId ?? '?';
  const door = options.runners?.();
  if (!door) return refusedRun(`bot ${input.bot.slug} is placed on runner "${runner}", but this server has no runners service`, 'runner_offline');
  const profile = renderProfile(input);
  let dispatch: Awaited<ReturnType<RunnerDoor['dispatch']>>;
  try {
    dispatch = await door.dispatch({
      teamId: input.bot.teamId,
      runner,
      job: {
        runId,
        profile: { home: profile.home, files: profile.files },
        prompt: input.prompt,
        runBudgetSeconds: input.limits.runBudgetSeconds,
        maxTurns: input.limits.maxTurns,
        killGraceSeconds: options.killGraceSeconds,
      },
    });
  } catch (err) {
    const reason = err instanceof RunnerUnavailableError ? err.reason : `the runner "${runner}" could not be reached: ${err instanceof Error ? err.message : String(err)}`;
    scope.log(`runtime-hermes: run ${runId} was not started: ${reason}`);
    return refusedRun(reason, 'runner_offline');
  }
  let stderrTail = '';
  const exited: Promise<ProcessExit> = dispatch.exited.then((exit) => {
    stderrTail = exit.stderrTail;
    return { code: exit.code, signal: exit.signal as NodeJS.Signals | null };
  });
  let stopping: Promise<void> | undefined;
  const kill = (): Promise<void> => (stopping ??= dispatch.stop().catch(() => undefined));
  // The platform's own ceiling, as for a local child: the runner's budget is the first line of defence, this is the second.
  const budget = (input.limits.runBudgetSeconds ?? 600) + options.killGraceSeconds;
  let timedOut = false;
  const ceiling = setTimeout(() => {
    timedOut = true;
    scope.log(`runtime-hermes: run ${runId} exceeded ${budget}s and was stopped`);
    void kill();
  }, budget * 1000);
  ceiling.unref?.();
  // The runner enforces the same budget itself and usually gets there first (its stop arrives as a signal or an odd exit code, before this
  // ceiling fires), so a run that ended unanswered after the budget has passed also counts as having run out of time.
  const startedAt = Date.now();
  const events = consume(dispatch.lines[Symbol.asyncIterator](), kill, () => stderrTail, exited, pastBudget(input, startedAt, () => timedOut));
  return {
    stop: async () => {
      clearTimeout(ceiling);
      await kill();
    },
    events: (async function* stream(): AsyncGenerator<BotRuntimeEvent> {
      try {
        yield* events;
      } finally {
        clearTimeout(ceiling);
        await kill();
      }
    })(),
  };
}

/** The run in this process's own host: a profile directory, a child that leads its process group, the profile removed when nothing is left. */
async function runHere(options: HermesRuntimeOptions, input: BotRuntimeInput, scope: BotRuntimeScope): Promise<BotRuntimeHandle> {
  const profile = renderProfile(input);
  let dir = '';
  let child: ReturnType<typeof startGroupProcess>;
  let timedOut = false;
  // The profile holds the run token and the bot's key: owner-only directory and files, and gone again if anything between
  // here and a running child fails (a spawn that throws, a full disk) — not only when the stream ends.
  const removeProfile = async (): Promise<void> => {
    if (dir === '') return;
    if (!(await removeProfileDir(dir))) scope.log(`runtime-hermes: the profile of run ${input.endpoint?.runId ?? '?'} could not be removed (Hermes wrote to it as it exited)`);
  };
  try {
    dir = await writeProfile(options.dataRoot, profile.home, profile.files);
    child = startGroupProcess({
      ...(options.spawn ? { spawn: options.spawn } : {}),
      bin: options.bin,
      args: [...options.prefix, ...chatArgs(input)],
      cwd: dir,
      env: { ...childEnv(options.env), HERMES_HOME: dir },
      stdin: input.prompt,
      killGraceSeconds: options.killGraceSeconds,
      // A hard ceiling: the turn budget is Hermes' own, this is the platform's (a wedged process would hold the job).
      budgetSeconds: input.limits.runBudgetSeconds ?? 600,
      onCeiling: (budget) => {
        timedOut = true;
        scope.log(`runtime-hermes: run ${input.endpoint?.runId ?? '?'} exceeded ${budget}s and was stopped`);
      },
    });
  } catch (err) {
    await removeProfile();
    throw err;
  }
  const startedAt = Date.now();
  const events = consume(child.lines, child.kill, child.stderrTail, child.exited, pastBudget(input, startedAt, () => timedOut));
  const close = async (): Promise<void> => {
    await child.settle();
    await removeProfile();
  };
  return {
    stop: async () => {
      await child.kill();
      await close();
    },
    events: (async function* stream(): AsyncGenerator<BotRuntimeEvent> {
      try {
        yield* events;
      } finally {
        await child.kill();
        await close();
      }
    })(),
  };
}

/**
 * Turn the child's stdout into the run's events, ending with exactly one terminal `result`. A process that dies without a
 * `result` record gets a synthesised failure carrying what it managed to say and the tail of its stderr — a run is never
 * silent about how it ended.
 */
async function* consume(
  lines: AsyncIterator<string> | null,
  kill: () => Promise<void>,
  stderrTail: () => string,
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timedOut: () => boolean = () => false,
): AsyncGenerator<BotRuntimeEvent> {
  const deltas: string[] = [];
  let result: HermesEvent & { type: 'result' } | null = null;

  if (lines) {
    for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
      const line = next.value;
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
          ...(!event.ok && timedOut() ? { failure: 'timeout' as const } : {}),
          tokens: event.tokens,
        };
        continue;
      }
      if (event.type === 'tool_use') {
        yield { type: 'tool', name: event.name, input: event.input };
        continue;
      }
      yield { type: 'tool_result', name: event.name, ok: event.ok, ...(event.reason ? { reason: event.reason } : {}) };
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
      ...(timedOut() ? { failure: 'timeout' as const } : {}),
      tokens: null,
    };
    await kill();
  }
}
