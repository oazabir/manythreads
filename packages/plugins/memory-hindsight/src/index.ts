import { definePlugin } from '@manythreads/sdk';
import { hindsightFromEnv, type HindsightClient } from './hindsight.ts';
import { createMemoryProvider } from './provider.ts';
import { registerMemoryTools } from './tools.ts';

export { createHindsightClient, hindsightFromEnv, HindsightError } from './hindsight.ts';
export type { HindsightClient, HindsightFact, HindsightRetainItem, HindsightTransport } from './hindsight.ts';
export { bankIdFor, createMemoryProvider } from './provider.ts';
export { refuseBankFields, RecallArgs, RetainArgs } from './schemas.ts';
export { registerMemoryTools } from './tools.ts';

/**
 * memory-hindsight: team memory on Hindsight (SPEC 12.1, PLAN P5-12). One bank per team, `team:<slug>`, and the bank is derived — from the
 * run's team (found by the pairing token that opened the run) or, for the platform, from a team id in a system transaction — never from an
 * argument. It registers the `memory` provider (retain / recall / forget, `MemoryProvider` in the SDK) and the two tools a bot's run has,
 * `memory.recall` and `memory.retain`. The engine runs in the `hindsight` compose service (profile `memory`) on a network only the server
 * shares; `MANYTHREADS_HINDSIGHT_URL` (and `MANYTHREADS_HINDSIGHT_API_KEY`) tell this plugin where. With no URL the tools answer
 * `not_configured` and nothing else changes. docs/plugins/memory-hindsight.md.
 */
export default definePlugin({
  manifest: {
    name: 'memory-hindsight',
    version: '0.1.0',
    kind: 'server',
    extends: ['provider.memory'],
    capabilities: [
      { name: 'memory.recall', destructive: false },
      { name: 'memory.retain', destructive: false },
    ],
    // app.memory_run_scope() reads app.bot_runs and app.run_source_log: the bots namespace migrates first.
    dependsOn: ['bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    // One client per (URL, key) pair, so the bank cache survives calls; looked up per call because a test sets the environment late.
    let cached: { key: string; client: HindsightClient } | null = null;
    const client = (): HindsightClient => {
      const key = `${process.env['MANYTHREADS_HINDSIGHT_URL'] ?? ''}|${process.env['MANYTHREADS_HINDSIGHT_API_KEY'] ?? ''}`;
      if (!cached || cached.key !== key) cached = { key, client: hindsightFromEnv() };
      return cached.client;
    };
    const provider = createMemoryProvider({ client });
    ctx.providers.register('memory', provider);
    registerMemoryTools(ctx, provider);
  },
});
