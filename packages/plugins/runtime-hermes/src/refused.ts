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

