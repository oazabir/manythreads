import type { BotRuntimeEvent, BotRuntimeHandle } from '@manythreads/sdk';

/** A run that could not start: one failed `result` carrying the reason, so the run closes `failed` and says why. */
export function refusedRun(reason: string, failure?: 'runner_offline' | 'hermes_unreachable'): BotRuntimeHandle {
  return {
    stop: async () => undefined,
    events: (async function* refused(): AsyncGenerator<BotRuntimeEvent> {
      yield { type: 'result', text: '', ok: false, error: reason, ...(failure ? { failure } : {}), tokens: null };
    })(),
  };
}

/**
 * A run the runner catalog turned away at the start (switched off, not open to the team, not ready, gone): the same failed `result`, plus the runner's name and a reason from a
 * fixed list. The run job posts `line` once in the thread, as one plain sentence, and writes the `bot_runner.run.refused` event from `runner` and `reason`. Nothing was started.
 */
export function runnerRefusedRun(line: string, refusal: { runner: string; reason: string }): BotRuntimeHandle {
  return {
    stop: async () => undefined,
    events: (async function* refused(): AsyncGenerator<BotRuntimeEvent> {
      yield { type: 'result', text: '', ok: false, error: line, failure: 'runner_refused', refusal: { ...refusal, line }, tokens: null };
    })(),
  };
}
