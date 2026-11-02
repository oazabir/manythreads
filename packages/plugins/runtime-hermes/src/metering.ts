import type { BotRunHandle, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { BotRunnerName, LlmAliasName } from '@manythreads/shared';

// Every model call of a Hermes pod goes through the platform's model gateway (P19-10, PLAN decision 10). The run job checks that, after each pod run: the
// usage the pod reported becomes one line in the spend ledger (`app.llm_spend`, under the bot and the run), and an ok run that ends with no line at all raises
// one `bot_runner.run.unmetered` event (and an audit row). The platform never prices a call, so the line holds tokens and a cost of zero, like every other
// platform call; the check proves the run was counted, not what it cost.

/** The part of the gateway door this file needs; `gateway-llm` registers the full door and a plugin cannot import another plugin's types. */
interface SpendDoor {
  id: string;
  [member: string]: unknown;
  recordSpend?(
    tx: PluginTx,
    record: {
      workspaceId: string;
      teamId: string | null;
      botId: string | null;
      sessionId: string | null;
      runId: string | null;
      alias: LlmAliasName;
      model: string | null;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
    },
  ): Promise<string>;
}

export interface PodRunMeter {
  ctx: PluginContext;
  tx: PluginTx;
  log: PluginLogger;
  run: BotRunHandle;
  botId: string;
  /** The pod runner's name, from the run's `result`. */
  runner: string;
  /** Whether the run ended well: a run that failed before it called a model owes the ledger nothing. */
  ok: boolean;
  /** The gateway alias the bot's profile names. */
  alias: string | null;
  /** What the pod reported for the run, when it did. */
  tokens: { input: number; output: number; total: number } | null | undefined;
}

/** How many ledger lines the run has. */
async function spendLinesOf(tx: PluginTx, runId: string): Promise<number> {
  const res = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.llm_spend WHERE run_id = $1::uuid', [runId]);
  return res.rows[0]?.n ?? 0;
}

/**
 * Write the pod run's spend line from the usage it reported, then check the ledger holds a line for the run. Answers whether the run was metered. A finished run with
 * no line raises one `bot_runner.run.unmetered`; a failed run raises nothing. Never throws: a metering problem must not cost the asker their answer.
 */
export async function meterPodRun(input: PodRunMeter): Promise<boolean> {
  const { ctx, tx, log, run, botId, runner, ok, alias, tokens } = input;
  try {
    await tx.query('SAVEPOINT run_pod_metering');
    const door = ctx.providers.get<SpendDoor>('llm');
    const aliasName = LlmAliasName.safeParse(alias);
    if (door?.recordSpend && aliasName.success && tokens && tokens.total > 0) {
      await door.recordSpend(tx, {
        workspaceId: run.workspaceId,
        teamId: run.teamId,
        botId,
        sessionId: run.runId,
        runId: run.runId,
        alias: aliasName.data,
        model: null,
        promptTokens: tokens.input,
        completionTokens: tokens.output,
        costUsd: 0,
      });
    }
    const metered = (await spendLinesOf(tx, run.runId)) > 0;
    if (ok && !metered && BotRunnerName.safeParse(runner).success) {
      await ctx.audit.emit(tx, {
        type: 'bot_runner.run.unmetered',
        workspaceId: run.workspaceId,
        teamId: run.teamId,
        botId,
        runId: run.runId,
        runner,
        at: ctx.runtime.now().toISOString(),
      });
      log.warn(`runtime-hermes: run ${run.runId} on the pod runner ${runner} left no spend line at the model gateway`);
    }
    await tx.query('RELEASE SAVEPOINT run_pod_metering');
    return metered;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT run_pod_metering').catch(() => undefined);
    log.warn(`runtime-hermes: run ${run.runId}: the pod run could not be metered: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
