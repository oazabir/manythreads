import type { ApprovalProvider, BotRunHandle, BotRuntimeScope, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { RuntimeRhythmFinishedEvent, RuntimeRhythmStartedEvent, clip } from '@manythreads/shared';
import { ApprovalPending, type LoadedDefinition, type RunPayload } from './run-job.ts';

// What a run does differently when a schedule started it (PLAN P6-08; SPEC §6.4, §6.5). The ledger of firings belongs to the `rhythms` plugin; a
// run only reports to it with two events — `runtime.rhythm.started` when it opens, `runtime.rhythm.finished` when its outcome is known.
//
// Where the output goes, in the simplest reading of the spec (§6.4 says "the thread shows 'wrote … · diff'" and a scheduled run has no thread):
//  * routine   — the run's final reply is written to the contract's page (`create` / `replace` / `append`) as the bot, through the `pages.write`
//                capability (so the broker, the path guard and the bot's own grants apply, and a page being edited live takes the change), then the
//                bot posts "wrote <page> · diff" at the top of the channel the run was given. An empty reply is a failed run, not an empty page.
//  * task      — the reply is posted at the top of that channel, as any run's reply is.
//  * heartbeat — the bot decides: nothing is posted for it; it uses its own tools if something is worth saying.
// A failed scheduled run posts no notice into the channel; the firing's reason on the Rhythms screen says why.

type Rhythm = NonNullable<RunPayload['rhythm']>;

/** Why the rhythm's model alias cannot be used with this bot, in plain words, or null. Allowed: the aliases and fallbacks the bot's BOT.md lists. */
export function rhythmOverrideProblem(definition: LoadedDefinition, rhythm: Rhythm): string | null {
  if (rhythm.modelAlias === null) return null;
  const model = definition.frontmatter.model;
  const allowed = [...(model?.aliases ?? []), ...(model?.fallbacks ?? [])];
  return allowed.includes(rhythm.modelAlias) ? null : `The model alias ${rhythm.modelAlias} is not one this bot may use.`;
}

/** Apply the rhythm's `model` / `effort` overrides to the definition the run executes (SPEC §6.5). The loaded definition is a copy per run. */
export function applyRhythmOverrides(definition: LoadedDefinition, rhythm: Rhythm): void {
  const model = definition.frontmatter.model;
  if (rhythm.modelAlias !== null && model?.aliases !== undefined) {
    definition.alias = rhythm.modelAlias;
    definition.frontmatter = { ...definition.frontmatter, model: { ...model, aliases: [rhythm.modelAlias, ...model.aliases.filter((a) => a !== rhythm.modelAlias)] } };
  }
  if (rhythm.effort !== null && definition.frontmatter.model !== undefined) {
    definition.frontmatter = { ...definition.frontmatter, model: { ...definition.frontmatter.model, effort: rhythm.effort } };
  }
}

export async function emitRhythmStarted(ctx: PluginContext, tx: PluginTx, payload: RunPayload, run: BotRunHandle): Promise<void> {
  if (!payload.rhythm) return;
  await ctx.audit.emit(
    tx,
    RuntimeRhythmStartedEvent.parse({
      type: 'runtime.rhythm.started',
      schemaVersion: 1,
      workspaceId: payload.workspaceId,
      teamId: payload.teamId,
      botId: payload.botId,
      rhythmRunId: payload.rhythm.rhythmRunId,
      runId: run.runId,
    }),
  );
}

export async function emitRhythmFinished(
  ctx: PluginContext,
  tx: PluginTx,
  payload: RunPayload,
  outcome: { runId: string | null; status: 'done' | 'failed'; reason?: string; outputPath?: string | null; commitSha?: string | null },
): Promise<void> {
  if (!payload.rhythm) return;
  await ctx.audit.emit(
    tx,
    RuntimeRhythmFinishedEvent.parse({
      type: 'runtime.rhythm.finished',
      schemaVersion: 1,
      workspaceId: payload.workspaceId,
      teamId: payload.teamId,
      botId: payload.botId,
      rhythmRunId: payload.rhythm.rhythmRunId,
      runId: outcome.runId,
      status: outcome.status,
      reason: clip(outcome.reason ?? '', 500),
      outputPath: outcome.outputPath ?? null,
      commitSha: outcome.commitSha ?? null,
    }),
  );
}

/** The commit a `pages.write` answered with, or why it wrote nothing. */
function readWrite(answer: unknown): { ok: true; sha: string | null } | { ok: false; reason: string } {
  const a = (answer ?? {}) as { ok?: unknown; message?: unknown; result?: { sha?: unknown } };
  if (a.ok === false) return { ok: false, reason: `The page could not be written: ${typeof a.message === 'string' ? a.message : 'refused'}` };
  return { ok: true, sha: typeof a.result?.sha === 'string' ? a.result.sha : null };
}

/**
 * The end of a scheduled run: write a routine's page, say so, settle the firing, close the run. Never leaves the firing unsettled; a run that
 * waits for a person's approval is closed `stopped` and settled by the ledger's `bots.run.closed` safety net.
 */
export async function finishRhythmRun(input: {
  ctx: PluginContext;
  tx: PluginTx;
  log: PluginLogger;
  run: BotRunHandle;
  payload: RunPayload;
  scope: BotRuntimeScope;
  reply: string;
  ok: boolean;
}): Promise<void> {
  const { ctx, tx, log, run, payload, scope, reply, ok } = input;
  const rhythm = payload.rhythm!;
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (approvals && (await approvals.pendingForRun(tx, run.runId)) > 0) {
    await ctx.runs.close(run.runId, 'stopped');
    return;
  }

  let status: 'done' | 'failed' = ok ? 'done' : 'failed';
  let reason = ok ? '' : 'The run failed before it produced an answer.';
  let commitSha: string | null = null;
  const text = reply.trim();

  if (ok && rhythm.kind === 'routine' && rhythm.outputPath !== null) {
    if (text === '') {
      status = 'failed';
      reason = `The run produced no output, so nothing was written to ${rhythm.outputPath}.`;
    } else {
      try {
        const written = readWrite(
          await scope.invoke('pages.write', {
            team: payload.teamId,
            mode: rhythm.outputMode ?? 'replace',
            path: rhythm.outputPath,
            content: reply.endsWith('\n') ? reply : `${reply}\n`,
            message: `Routine output: ${rhythm.outputPath}`,
          }),
        );
        if (written.ok) commitSha = written.sha;
        else {
          status = 'failed';
          reason = written.reason;
        }
      } catch (err) {
        if (err instanceof ApprovalPending) throw err;
        status = 'failed';
        reason = clip(err instanceof Error ? err.message : 'The page could not be written.', 400);
      }
    }
    if (status === 'done') await postWrote(tx, log, scope, payload, rhythm.outputPath);
  } else if (ok && rhythm.kind === 'task' && text !== '') {
    await scope.invoke('messages.post', { channelId: payload.channelId, body: reply }).catch((err: unknown) => {
      if (err instanceof ApprovalPending) throw err;
      log.warn(`runtime-hermes: run ${run.runId}: the task rhythm's reply could not be posted: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  await emitRhythmFinished(ctx, tx, payload, { runId: run.runId, status, reason, outputPath: status === 'done' ? rhythm.outputPath : null, commitSha });
  await ctx.runs.close(run.runId, status);
}

/** "wrote <page> · diff": the page and its history in the Files screen, where a commit's diff is read. */
async function postWrote(tx: PluginTx, log: PluginLogger, scope: BotRuntimeScope, payload: RunPayload, path: string): Promise<void> {
  try {
    const slug = (await tx.query<{ slug: string }>('SELECT slug FROM app.teams WHERE id = $1::uuid', [payload.teamId])).rows[0]?.slug;
    const link = slug ? `/t/${slug}/files?open=${encodeURIComponent(path)}` : null;
    const body = link ? `wrote [${path}](${link}) · [diff](${link})` : `wrote ${path} · diff`;
    await scope.invoke('messages.post', { channelId: payload.channelId, body });
  } catch (err) {
    if (err instanceof ApprovalPending) throw err;
    log.warn(`runtime-hermes: the “wrote ${path}” line could not be posted: ${err instanceof Error ? err.message : String(err)}`);
  }
}
