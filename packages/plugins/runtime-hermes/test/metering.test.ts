import type { BotRunHandle, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { meterPodRun } from '../src/metering.ts';

// P19-10: each run the team's pod served is checked after it ends. The usage the pod reported becomes one spend line under the bot and the run; a finished run
// with no line raises exactly one `bot_runner.run.unmetered`. The ledger and the event log are stand-ins here; the end-to-end line is in gateway-run.test.ts.

const RUN = { runId: '00000000-0000-4000-8000-0000000000a1', botId: 'b', botActorId: 'a', teamId: '00000000-0000-4000-8000-0000000000t1', workspaceId: '00000000-0000-4000-8000-0000000000w1' } as unknown as BotRunHandle;
const BOT = '00000000-0000-4000-8000-0000000000b1';

function world(opts: { door?: boolean; existingLines?: number } = {}) {
  const ledger: Array<Record<string, unknown>> = Array.from({ length: opts.existingLines ?? 0 }, () => ({ preexisting: true }));
  const events: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const tx = {
    async query(sql: string) {
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: ledger.length }] };
      return { rows: [] };
    },
  } as unknown as PluginTx;
  const ctx = {
    providers: {
      get: (kind: string) =>
        kind === 'llm' && opts.door !== false
          ? { id: 'llm', recordSpend: async (_tx: PluginTx, record: Record<string, unknown>) => void ledger.push(record) }
          : undefined,
    },
    audit: { emit: async (_tx: PluginTx, event: Record<string, unknown>) => void events.push(event) },
    runtime: { now: () => new Date('2026-11-02T10:00:00.000Z') },
  } as unknown as PluginContext;
  const log: PluginLogger = { info: () => undefined, warn: (m) => void warnings.push(m) };
  return { ledger, events, warnings, tx, ctx, log };
}

const usage = { input: 10, output: 5, total: 15 };

describe('meterPodRun', () => {
  it('a pod run that reported its usage gets one spend line under the bot and the run, and raises nothing', async () => {
    const w = world();
    const metered = await meterPodRun({ ctx: w.ctx, tx: w.tx, log: w.log, run: RUN, botId: BOT, runner: 'team-pod', ok: true, alias: 'smart', tokens: usage });
    expect(metered).toBe(true);
    expect(w.ledger).toEqual([expect.objectContaining({ botId: BOT, runId: RUN.runId, sessionId: RUN.runId, teamId: RUN.teamId, alias: 'smart', promptTokens: 10, completionTokens: 5, costUsd: 0 })]);
    expect(w.events).toEqual([]);
  });

  it('a pod run with a spend line already at the gateway passes without a second line', async () => {
    const w = world({ existingLines: 1 });
    expect(await meterPodRun({ ctx: w.ctx, tx: w.tx, log: w.log, run: RUN, botId: BOT, runner: 'team-pod', ok: true, alias: 'smart', tokens: null })).toBe(true);
    expect(w.ledger).toHaveLength(1);
    expect(w.events).toEqual([]);
  });

  it('a finished pod run with no usage and no line raises exactly one bot_runner.run.unmetered, holding ids and the runner name only', async () => {
    const w = world();
    const metered = await meterPodRun({ ctx: w.ctx, tx: w.tx, log: w.log, run: RUN, botId: BOT, runner: 'team-pod', ok: true, alias: 'smart', tokens: null });
    expect(metered).toBe(false);
    expect(w.events).toEqual([{ type: 'bot_runner.run.unmetered', workspaceId: RUN.workspaceId, teamId: RUN.teamId, botId: BOT, runId: RUN.runId, runner: 'team-pod', at: '2026-11-02T10:00:00.000Z' }]);
    expect(w.ledger).toEqual([]);
  });

  it('a pod run that reports zero tokens counts as no usage', async () => {
    const w = world();
    await meterPodRun({ ctx: w.ctx, tx: w.tx, log: w.log, run: RUN, botId: BOT, runner: 'team-pod', ok: true, alias: 'smart', tokens: { input: 0, output: 0, total: 0 } });
    expect(w.events).toHaveLength(1);
  });

  it('a failed run owes nothing: no event, though a reported usage is still written down', async () => {
    const none = world();
    await meterPodRun({ ctx: none.ctx, tx: none.tx, log: none.log, run: RUN, botId: BOT, runner: 'team-pod', ok: false, alias: 'smart', tokens: null });
    expect(none.events).toEqual([]);
    const some = world();
    await meterPodRun({ ctx: some.ctx, tx: some.tx, log: some.log, run: RUN, botId: BOT, runner: 'team-pod', ok: false, alias: 'smart', tokens: usage });
    expect(some.ledger).toHaveLength(1);
    expect(some.events).toEqual([]);
  });

  it('without a gateway door the run is unmetered, and a runner name outside the contract is not written', async () => {
    const w = world({ door: false });
    await meterPodRun({ ctx: w.ctx, tx: w.tx, log: w.log, run: RUN, botId: BOT, runner: 'team-pod', ok: true, alias: 'smart', tokens: usage });
    expect(w.events).toHaveLength(1);
    const bad = world();
    await meterPodRun({ ctx: bad.ctx, tx: bad.tx, log: bad.log, run: RUN, botId: BOT, runner: 'Not A Name!', ok: true, alias: 'smart', tokens: null });
    expect(bad.events).toEqual([]);
  });

  it('never throws: a ledger that fails is a warning, and the savepoint is rolled back', async () => {
    const w = world();
    const queries: string[] = [];
    const tx = {
      async query(sql: string) {
        queries.push(sql);
        if (/count\(\*\)/.test(sql)) throw new Error('ledger down');
        return { rows: [] };
      },
    } as unknown as PluginTx;
    await expect(meterPodRun({ ctx: w.ctx, tx, log: w.log, run: RUN, botId: BOT, runner: 'team-pod', ok: true, alias: 'smart', tokens: null })).resolves.toBe(false);
    expect(queries).toContain('ROLLBACK TO SAVEPOINT run_pod_metering');
    expect(w.warnings.join(' ')).toMatch(/could not be metered/);
  });
});
