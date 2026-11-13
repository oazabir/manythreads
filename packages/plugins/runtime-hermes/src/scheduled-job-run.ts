import type { ApprovalProvider, BotRunHandle, BotRuntimeScope, PersonalFilesProvider, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { ACTION_ITEMS_PATH, RuntimeScheduledJobFinishedEvent, RuntimeScheduledJobStartedEvent, clip, modelAliasesOfDefinition, reviewActionItemsRewrite } from '@manythreads/shared';
import { ApprovalPending, type LoadedDefinition, type RunPayload } from './run-job.ts';

// What a run does differently when a schedule started it (PLAN P6-08; SPEC §6.4, §6.5). The ledger of firings belongs to the `scheduled-jobs` plugin; a
// run only reports to it with two events — `runtime.scheduled_job.started` when it opens, `runtime.scheduled_job.finished` when its outcome is known.
//
// Where the output goes, in the simplest reading of the spec (§6.4 says "the thread shows 'wrote … · diff'" and a scheduled run has no thread):
//  * routine   — the run's final reply is written to the contract's page (`create` / `replace` / `append`) as the bot, through the `pages.write`
//                capability (so the broker, the path guard and the bot's own grants apply, and a page being edited live takes the change), then the
//                bot posts "wrote <page> · diff" at the top of the channel the run was given. An empty reply is a failed run, not an empty page.
//  * task      — the reply is posted at the top of that channel, as any run's reply is.
//  * heartbeat — the bot decides: nothing is posted for it; it uses its own tools if something is worth saying.
// A failed scheduled run posts no notice into the channel; the firing's reason on the Jobs screen says why.

type ScheduledJob = NonNullable<RunPayload['scheduledJob']>;

/** Why the scheduled job's model alias cannot be used with this bot, in plain words, or null. Allowed: the aliases and fallbacks the bot's BOT.md lists. */
export function scheduledJobOverrideProblem(definition: LoadedDefinition, scheduledJob: ScheduledJob): string | null {
  if (scheduledJob.modelAlias === null) return null;
  const model = definition.frontmatter.model;
  const allowed = [...modelAliasesOfDefinition(definition.frontmatter), ...(model?.fallbacks ?? [])];
  return allowed.includes(scheduledJob.modelAlias) ? null : `The model alias ${scheduledJob.modelAlias} is not one this bot may use.`;
}

/** Apply the scheduled job's `model` / `effort` overrides to the definition the run executes (SPEC §6.5). The loaded definition is a copy per run. */
export function applyScheduledJobOverrides(definition: LoadedDefinition, scheduledJob: ScheduledJob): void {
  const model = definition.frontmatter.model;
  const own = modelAliasesOfDefinition(definition.frontmatter);
  if (scheduledJob.modelAlias !== null && own.length > 0) {
    definition.alias = scheduledJob.modelAlias;
    definition.frontmatter = { ...definition.frontmatter, model: { ...model, aliases: [scheduledJob.modelAlias, ...own.filter((a) => a !== scheduledJob.modelAlias)] } };
  }
  if (scheduledJob.effort !== null && definition.frontmatter.model !== undefined) {
    definition.frontmatter = { ...definition.frontmatter, model: { ...definition.frontmatter.model, effort: scheduledJob.effort } };
  }
}

export async function emitScheduledJobStarted(ctx: PluginContext, tx: PluginTx, payload: RunPayload, run: BotRunHandle): Promise<void> {
  if (!payload.scheduledJob) return;
  await ctx.audit.emit(
    tx,
    RuntimeScheduledJobStartedEvent.parse({
      type: 'runtime.scheduled_job.started',
      schemaVersion: 1,
      workspaceId: payload.workspaceId,
      teamId: payload.teamId,
      botId: payload.botId,
      scheduledJobRunId: payload.scheduledJob.scheduledJobRunId,
      runId: run.runId,
    }),
  );
}

export async function emitScheduledJobFinished(
  ctx: PluginContext,
  tx: PluginTx,
  payload: RunPayload,
  outcome: { runId: string | null; status: 'done' | 'failed'; reason?: string; outputPath?: string | null; commitSha?: string | null },
): Promise<void> {
  if (!payload.scheduledJob) return;
  await ctx.audit.emit(
    tx,
    RuntimeScheduledJobFinishedEvent.parse({
      type: 'runtime.scheduled_job.finished',
      schemaVersion: 1,
      workspaceId: payload.workspaceId,
      teamId: payload.teamId,
      botId: payload.botId,
      scheduledJobRunId: payload.scheduledJob.scheduledJobRunId,
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
export async function finishScheduledJobRun(input: {
  ctx: PluginContext;
  tx: PluginTx;
  log: PluginLogger;
  run: BotRunHandle;
  payload: RunPayload;
  scope: BotRuntimeScope;
  reply: string;
  ok: boolean;
  /** The runner's own sentence when it turned the run away: it becomes the firing's reason in place of the general one. */
  failureReason?: string;
}): Promise<void> {
  const { ctx, tx, log, run, payload, scope, reply, ok } = input;
  const scheduledJob = payload.scheduledJob!;
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (approvals && (await approvals.pendingForRun(tx, run.runId)) > 0) {
    await ctx.runs.close(run.runId, 'stopped');
    return;
  }

  let status: 'done' | 'failed' = ok ? 'done' : 'failed';
  let reason = ok ? '' : (input.failureReason?.trim().slice(0, 300) || 'The run failed before it produced an answer.');
  let commitSha: string | null = null;
  const text = reply.trim();

  if (ok && scheduledJob.kind === 'routine' && scheduledJob.outputPath !== null && scheduledJob.personal) {
    // a person's own routine: the output goes to the owner's Personal files, written as the bot, never to a team page and never announced in a channel
    if (text === '') {
      status = 'failed';
      reason = `The run produced no output, so nothing was written to ${scheduledJob.outputPath}.`;
    } else {
      const wrote = await writePersonalOutput(ctx, tx, run, scheduledJob.personal.ownerPersonId, scheduledJob.outputPath, scheduledJob.outputMode ?? 'replace', reply);
      if (!wrote.ok) {
        status = 'failed';
        reason = wrote.reason;
      }
    }
  } else if (ok && scheduledJob.kind === 'routine' && scheduledJob.outputPath !== null) {
    if (text === '') {
      status = 'failed';
      reason = `The run produced no output, so nothing was written to ${scheduledJob.outputPath}.`;
    } else {
      try {
        const written = readWrite(
          await scope.invoke('pages.write', {
            team: payload.teamId,
            mode: scheduledJob.outputMode ?? 'replace',
            path: scheduledJob.outputPath,
            content: reply.endsWith('\n') ? reply : `${reply}\n`,
            message: `Routine output: ${scheduledJob.outputPath}`,
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
    if (status === 'done') await postWrote(tx, log, scope, payload, scheduledJob.outputPath);
  } else if (ok && scheduledJob.kind === 'task' && text !== '') {
    await scope.invoke('messages.post', { channelId: payload.channelId, body: reply }).catch((err: unknown) => {
      if (err instanceof ApprovalPending) throw err;
      log.warn(`runtime-hermes: run ${run.runId}: the task scheduled job's reply could not be posted: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  await emitScheduledJobFinished(ctx, tx, payload, { runId: run.runId, status, reason, outputPath: status === 'done' ? scheduledJob.outputPath : null, commitSha });
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

/**
 * Write a personal routine's output into its owner's Personal files (the files plugin's `personal.files` provider), authored by the bot. Memory is written only through the memory
 * tool, so a path under `Memory/` is refused here too. A rewrite of the action-items list is checked first: an action never disappears or reopens (`reviewActionItemsRewrite`).
 */
export async function writePersonalOutput(
  ctx: PluginContext,
  tx: PluginTx,
  run: BotRunHandle,
  ownerPersonId: string,
  path: string,
  mode: 'create' | 'replace' | 'append',
  reply: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
  if (!files) return { ok: false, reason: 'Personal files are not available, so the output could not be saved.' };
  if (path.split('/')[0] === 'Memory') return { ok: false, reason: 'A routine does not write to Memory; the memory tool does.' };
  const content = reply.endsWith('\n') ? reply : `${reply}\n`;
  try {
    // the list that was checked is the list that is replaced: a person's edit between the read and the save makes the save refuse (409) instead of being overwritten
    let expectedRevision: string | null | undefined;
    if (path === ACTION_ITEMS_PATH) {
      const current = await files.read(tx, ownerPersonId, path);
      const problems = reviewActionItemsRewrite(current?.text ?? '', mode === 'append' ? `${current?.text ?? ''}${content}` : content);
      if (problems.length > 0) return { ok: false, reason: clip(`The action items were not changed. ${problems[0]}`, 400) };
      expectedRevision = current?.revision ?? null;
    }
    await files.write(tx, ownerPersonId, path, content, { mode, authorActorId: run.botActorId, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: clip(err instanceof Error ? `The output could not be saved: ${err.message}` : 'The output could not be saved.', 400) };
  }
}
