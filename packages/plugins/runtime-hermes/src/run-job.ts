import { createHash } from 'node:crypto';
import {
  authorizeContext,
  requestToolApproval,
  type ApprovalProvider,
  type BotRunHandle,
  type BotRuntimeHandle,
  type JobInfo,
  type BotRuntimeInput,
  type BotRuntimeProvider,
  type BotRuntimeScope,
  type PluginContext,
  type PluginLogger,
  type PluginTx,
} from '@manythreads/sdk';
import {
  GUARD_RULE_DLP_APPROVAL,
  LlmAliasName,
  botMdPath,
  mcpUrlOf,
  parseBotMd,
} from '@manythreads/shared';
import { z } from 'zod';
import { hasGate, runGate, type ClassifierDoor } from './gate.ts';
import { holdForApproval, holdForGate, postNotice, previewText } from './holds.ts';
import { classifyFailure, looksLikeRejectedKey, postFailureNotice, type FailureCategory } from './failure-notice.ts';
import { MAX_DELEGATION_DEPTH } from './match.ts';
import { rhythmOverrideProblem, applyRhythmOverrides, emitRhythmFinished, emitRhythmStarted, finishRhythmRun } from './rhythm-run.ts';

/** The job queue one run executes in. */
export const RUN_QUEUE = 'runtime-hermes.run';

/** A run's default wall clock when its definition names none (hermes.ts uses the same), and the slack its token outlives it by. */
const DEFAULT_RUN_BUDGET_SECONDS = 600;
const RUN_TOKEN_SLACK_SECONDS = 120;

export const RunPayload = z.strictObject({
  workspaceId: z.uuid(),
  botId: z.uuid(),
  teamId: z.uuid(),
  channelId: z.uuid(),
  trigger: z.enum(['conversation', 'mention', 'channel_message', 'task_assigned', 'routine']),
  askerActorId: z.uuid().nullable(),
  /**
   * Where the reply goes: the thread root when the message is inside one, else the message itself (the reply opens the thread). Null for a run
   * a schedule started: it has no thread, so what it posts goes at the top of `channelId`.
   */
  replyRootId: z.uuid().nullable(),
  /** The run's `thread_id`: the thread the message is in, when there is one (`bot_runs.thread_id` references `app.threads`). */
  runThreadId: z.uuid().nullable(),
  prompt: z.string().min(1).max(40_000),
  /** Set when this run is a DLP-held model call a person has since approved (`registerApprovalResume`): its finding is let through as written. */
  approvalId: z.uuid().optional(),
  /**
   * The message as the person wrote it, which the gate (P5-11) checks; `prompt` also names the author and the channel, and a gate-list entry must
   * not match those. Absent on a run queued before the gate existed: the gate then reads the prompt, which can only match more.
   */
  text: z.string().max(40_000).optional(),
  /** Set when this run is a gate-held message a person has since approved: the gate does not look at it again. */
  gateApprovalId: z.uuid().optional(),
  /**
   * Set when this run answers a bot-authored mention (a delegation): the authoring bot and how deep the chain in this
   * thread already is. Absent (or 0 on the row) when a person asked.
   */
  delegation: z.strictObject({ fromBotId: z.uuid(), depth: z.number().int().min(1).max(MAX_DELEGATION_DEPTH) }).optional(),
  /**
   * Set when this run is the firing of a rhythm (a `routine` trigger, PLAN P6-08): which firing it settles, the page a routine's reply is
   * written to and how, and the rhythm's own model alias and effort. `rhythms` owns the ledger; the run only reports back with events.
   */
  rhythm: z
    .strictObject({
      rhythmRunId: z.uuid(),
      kind: z.enum(['heartbeat', 'routine', 'task']),
      outputPath: z.string().min(1).max(300).nullable(),
      outputMode: z.enum(['create', 'replace', 'append']).nullable(),
      modelAlias: z.string().min(1).max(40).nullable(),
      effort: z.enum(['low', 'medium', 'high']).nullable(),
    })
    .optional(),
  /** Marks the payload stored with a gate hold, so that approving it resumes the run past the gate (not past the DLP check). */
  gateHold: z.literal(true).optional(),
});
export type RunPayload = z.infer<typeof RunPayload>;

/** The LLM gateway door, structurally: `gateway-llm` registers it, and a plugin cannot import another plugin's types. */
export interface LlmDoor {
  id: string;
  [member: string]: unknown;
  botKey(tx: PluginTx, botId: string): Promise<string | null>;
  /** Tell the gateway the proxy refused this bot's key, so it checks the key at the proxy and registers it again if the proxy lost it. Optional: an older gateway has none. */
  keyRejected?(tx: PluginTx, botId: string): Promise<void>;
  /** The gate's classifier call (P5-11). */
  classify: ClassifierDoor['classify'];
  preflight(
    tx: PluginTx,
    request: {
      workspaceId: string;
      botId: string | null;
      teamId: string | null;
      sessionId: string | null;
      alias: string;
      text: string;
      dlpMode?: 'preset' | 'hold' | 'approved';
    },
  ): Promise<{ allowed: boolean; message: string | null; text: string; outcome: string; rules: string[] }>;
}

/** The repo door, structurally: what `repo-git` registers (docs/plugins/repo-git.md). */
export interface RepoDoor {
  id: string;
  [member: string]: unknown;
  blob(tx: PluginTx, teamId: string, path: string, ref: string, maxBytes?: number): Promise<{ content: Uint8Array }>;
}

export interface RunBotRow {
  id: string;
  slug: string;
  name: string;
  runtime: string;
  definition_sha: string;
  team_id: string;
  workspace_id: string;
  status: string;
  [key: string]: unknown;
}

/** Thrown by a run's own scope when a call it made was turned into a pending approval: the run ends `stopped`, it did not fail. */
export class ApprovalPending extends Error {
  constructor(readonly capability: string) {
    super(`"${capability}" is waiting for a person's approval`);
    this.name = 'ApprovalPending';
  }
}

/**
 * A run that ended without an answer: ask the gateway to re-check the bot's key when the proxy refused it (the next run then works), and tell the
 * asker in one short line why there is no answer. The line names a category only (`failure-notice.ts`); the error text goes to the log, nowhere else.
 */
export async function reportFailure(input: {
  ctx: PluginContext;
  tx: PluginTx;
  log: PluginLogger;
  run: BotRunHandle;
  payload: RunPayload;
  botId: string;
  category?: FailureCategory;
  error?: string | undefined;
  failure?: 'runner_offline' | 'hermes_unreachable' | 'timeout' | undefined;
}): Promise<void> {
  const { ctx, tx, log, run, payload, botId } = input;
  if (looksLikeRejectedKey(input.error)) {
    const llm = ctx.providers.get<LlmDoor>('llm');
    try {
      await tx.query('SAVEPOINT run_key_rejected');
      await llm?.keyRejected?.(tx, botId);
      await tx.query('RELEASE SAVEPOINT run_key_rejected');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT run_key_rejected').catch(() => undefined);
      log.warn(`runtime-hermes: run ${run.runId}: the gateway could not be asked to re-check the bot's key: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A scheduled run has no one waiting for an answer; the reason lives on its firing in the rhythms ledger.
  if (payload.rhythm) return;
  // A run that already put a live message into its reply thread did the work; a notice under it would contradict it (a run stopped at its
  // time limit after posting its result, say). Same thread restriction as the reply check in `postReply`.
  if (await runPostedReply(tx, run.runId, payload.channelId, payload.replyRootId)) {
    log.info(`runtime-hermes: run ${run.runId}: no failure notice (the run already posted into its thread)`);
    return;
  }
  await postFailureNotice(ctx, tx, run, payload, input.category ?? classifyFailure(input.error, input.failure), (line) => log.warn(line));
}

type ParsedDefinition = Extract<ReturnType<typeof parseBotMd>, { ok: true }>;

/** The definition the run executes, read from the repo and checked against the loaded row. */
export interface LoadedDefinition {
  frontmatter: ParsedDefinition['frontmatter'];
  body: string;
  alias: string | null;
  holdOnDetection: boolean;
  approvers: readonly string[];
}

/**
 * The definition the run executes: the file the loader last loaded, read from the repo. A row whose file has moved on (a
 * commit in flight) is refused rather than run on a definition the roster never showed. Null when there is nothing to run.
 */
export async function loadDefinition(ctx: PluginContext, tx: PluginTx, bot: RunBotRow, log: PluginLogger): Promise<LoadedDefinition | null> {
  const repo = ctx.providers.get<RepoDoor>('repo');
  if (!repo) throw new Error('runtime-hermes: the repo provider is not registered');
  const file = await repo.blob(tx, bot.team_id, botMdPath(bot.slug), 'main');
  const contents = Buffer.from(file.content).toString('utf8');
  if (createHash('sha256').update(file.content).digest('hex') !== bot.definition_sha) {
    log.warn(`runtime-hermes: bot ${bot.slug} has a newer BOT.md in the repo than the loaded definition; no run`);
    return null;
  }
  const parsed = parseBotMd(contents);
  if (!parsed.ok) {
    log.warn(`runtime-hermes: the loaded definition of ${bot.slug} no longer parses (${parsed.failure.message}); no run`);
    return null;
  }
  return {
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    alias: parsed.frontmatter.model?.aliases?.[0] ?? null,
    holdOnDetection: parsed.frontmatter.guard?.rules?.includes(GUARD_RULE_DLP_APPROVAL) ?? false,
    approvers: parsed.frontmatter.approvals?.approvers ?? [],
  };
}

// The gate (SPEC §7.3, P5-11): before anything is sent to a model, a bot with a `guard.gate` list checks the message against it — the list
// first, then the local classifier. A hit holds the message for a person and stops the run (`stopped`); the model is never called. A run
// a person already released (past the gate or past the DLP check, which comes after it) is not asked again. A runtime with no model has
// nothing to gate.
//
// Answers `'stop'` when the run was closed at the gate (refused or held), `'continue'` when the message may reach a model.
export async function checkGate(input: {
  ctx: PluginContext;
  tx: PluginTx;
  log: PluginLogger;
  provider: BotRuntimeProvider;
  definition: LoadedDefinition;
  payload: RunPayload;
  run: BotRunHandle;
  bot: RunBotRow;
}): Promise<'continue' | 'stop'> {
  const { ctx, tx, log, provider, definition, payload, run, bot } = input;
  const gateEntries = definition.frontmatter.guard?.gate;
  if (provider.gated && hasGate(gateEntries) && payload.approvalId === undefined && payload.gateApprovalId === undefined) {
    const text = payload.text ?? payload.prompt;
    const verdict = await runGate(tx, {
      entries: gateEntries,
      text,
      run: { workspaceId: bot.workspace_id, botId: bot.id, teamId: bot.team_id, runId: run.runId },
      llm: ctx.providers.get<LlmDoor>('llm'),
    });
    if (verdict.kind === 'refused') {
      log.warn(`runtime-hermes: run ${run.runId} refused at the gate: ${verdict.detail}`);
      await postNotice(
        ctx,
        run,
        payload,
        'Held: a budget or rate limit is reached, so this message was not checked and nothing was sent to a model. Try again later.',
        (line) => log.warn(line),
      );
      await ctx.runs.close(run.runId, 'stopped');
      return 'stop';
    }
    if (verdict.kind === 'hold') {
      const approvalId = await holdForGate(ctx, tx, {
        run,
        payload,
        hold: verdict,
        excerpt: await previewText(ctx, tx, bot.workspace_id, text),
        approvers: definition.approvers,
      });
      await ctx.audit.emit(tx, {
        type: 'runtime.gate.held',
        workspaceId: bot.workspace_id,
        teamId: bot.team_id,
        botId: bot.id,
        runId: run.runId,
        stage: verdict.stage,
        entry: verdict.entry,
        approvalId,
        at: ctx.runtime.now().toISOString(),
      });
      log.info(
        approvalId !== null
          ? `runtime-hermes: run ${run.runId} stopped at the gate (${verdict.stage}): waiting for an approval`
          : `runtime-hermes: run ${run.runId} refused at the gate (${verdict.stage}): held, and nobody could be asked`,
      );
      // With a card in the thread the asker knows; without one (nobody could be asked) they would see a bot that never answers.
      if (approvalId === null) {
        await postNotice(
          ctx,
          run,
          payload,
          verdict.stage === 'classifier_unavailable'
            ? "Couldn't check this message, so it was held and nothing was sent to a model. Nobody here can approve it; ask a lead to look at this bot's gate and the local model."
            : "Held by this bot's gate. Nobody here can approve it, so nothing was sent to a model.",
          (line) => log.warn(line),
        );
      }
      await ctx.runs.close(run.runId, 'stopped');
      return 'stop';
    }
  }
  return 'continue';
}

// A runtime that talks to a model is handed the gateway, the bot's own virtual key, and the pre-call check (preset, DLP
// hook, budgets, rate limits) that P5-07 puts in front of every call: a refusal stops the run before anything is sent,
// and a redaction rewrites the prompt that is. A runtime with no model (`rules`) gets none of it and is never refused for
// lacking one. What a Hermes run lacks (no alias, no gateway URL) is reported by the provider's own profile render.
//
// Answers null when the run was closed before the call (held or refused); otherwise the key and the prompt the model gets.
export async function checkPreflight(input: {
  ctx: PluginContext;
  tx: PluginTx;
  log: PluginLogger;
  provider: BotRuntimeProvider;
  bot: RunBotRow;
  run: BotRunHandle;
  payload: RunPayload;
  alias: string | null;
  gatewayBase: string;
  holdOnDetection: boolean;
  approvers: readonly string[];
}): Promise<{ key: string | null; prompt: string } | null> {
  const { ctx, tx, log, provider, bot, run, payload, alias, holdOnDetection, approvers } = input;
  let key: string | null = null;
  let prompt = payload.prompt;
  if (provider.usesGateway && alias !== null) {
    // The gateway's alias set is closed (SPEC §10.2): a name outside it is bound to nothing the proxy has, and the guard
    // events the pre-call check writes could not even describe it. Say so, instead of failing inside the gateway.
    if (!LlmAliasName.safeParse(alias).success) {
      throw new Error(`bot ${bot.slug}: "${alias}" is not a gateway alias (${LlmAliasName.options.join(', ')})`);
    }
    const llm = ctx.providers.get<LlmDoor>('llm');
    if (llm) {
      key = await llm.botKey(tx, bot.id);
      // A bot whose Guard rules say `dlp:require_approval` has a finding held for a person instead of redacted (SPEC §15); the run that
      // an approval put back is the one call let through as written.
      const dlpMode = payload.approvalId !== undefined ? 'approved' : holdOnDetection ? 'hold' : undefined;
      const decision = await llm.preflight(tx, {
        workspaceId: bot.workspace_id,
        botId: bot.id,
        teamId: bot.team_id,
        sessionId: run.runId,
        alias,
        text: payload.prompt,
        ...(dlpMode ? { dlpMode } : {}),
      });
      if (!decision.allowed && decision.outcome === 'require_approval') {
        const filed = await holdForApproval(ctx, tx, { run, payload, alias, rules: decision.rules, excerpt: decision.text, approvers });
        log.info(
          filed
            ? `runtime-hermes: run ${run.runId} stopped before the call: waiting for an approval`
            : `runtime-hermes: run ${run.runId} refused before the call: held for approval, and the approvals plugin is not loaded`,
        );
        // With a card in the thread the asker knows; without one nobody can release the call, and they would see a bot that never answers.
        if (!filed) await reportFailure({ ctx, tx, log, run, payload, botId: bot.id, category: 'approval' });
        await ctx.runs.close(run.runId, 'stopped');
        return null;
      }
      if (!decision.allowed) {
        log.warn(`runtime-hermes: run ${run.runId} refused before the call: ${decision.message ?? 'not allowed'}`);
        await reportFailure({ ctx, tx, log, run, payload, botId: bot.id, category: 'limit' });
        await ctx.runs.close(run.runId, 'stopped');
        return null;
      }
      prompt = decision.text; // the redacted text when the hook rewrote it; the prompt itself otherwise
    }
  }
  return { key, prompt };
}

// The scope a provider gets is the run's own authority, and the broker decides every call it makes: the runtime
// implements what a model chose, so a call it makes is exactly as constrained as one made over the run's MCP
// endpoint. Without this the allowlist compiled from `capabilities.native` would be a promise the platform keeps at
// one door and forgets at the other.
export function buildScope(input: {
  ctx: PluginContext;
  log: PluginLogger;
  bot: RunBotRow;
  definition: LoadedDefinition;
  payload: RunPayload;
  prompt: string;
  run: BotRunHandle;
  token: string;
  provider: BotRuntimeProvider;
  gatewayBase: string;
  key: string | null;
  approvers: readonly string[];
}): { input: BotRuntimeInput; scope: BotRuntimeScope } {
  const { ctx, log, bot, definition, payload, prompt, run, token, provider, gatewayBase, key, approvers } = input;
  const built: BotRuntimeInput = {
    bot: {
      id: bot.id,
      slug: bot.slug,
      name: bot.name,
      teamId: bot.team_id,
      workspaceId: bot.workspace_id,
      runtime: bot.runtime,
      definitionSha: bot.definition_sha,
    },
    definition: { frontmatter: definition.frontmatter, body: definition.body },
    trigger: payload.trigger,
    asker: payload.askerActorId === null ? null : { actorId: payload.askerActorId, personId: null, displayName: null },
    prompt,
    thread: { channelId: payload.channelId, threadRootId: payload.replyRootId },
    // The URL names the run and carries no credential (a URL is logged by proxies and access logs); the token travels as a
    // bearer header, which the rendered profile sets.
    endpoint: { runId: run.runId, url: mcpUrlOf(ctx.runtime.publicUrl), token },
    // A run placed on a runner reaches the models through this server, not through the cluster's LiteLLM address (which the runner's
    // machine cannot resolve) and without the bot's virtual key (which never leaves the server): the run's own token is the credential
    // of the run-scoped proxy `gateway-llm` serves at `/api/llm/runs/<runId>/v1`.
    gateway:
      provider.usesGateway && gatewayBase !== ''
        ? definition.frontmatter.placement?.runner !== undefined
          ? { baseUrl: `${ctx.runtime.publicUrl}/api/llm/runs/${run.runId}`, key: token }
          : { baseUrl: gatewayBase, key }
        : null,
    // SPEC §7.1's limits: a run's own wall clock. The definition schema has no turn count, so none is passed.
    limits: { runBudgetSeconds: definition.frontmatter.limits?.timeoutSeconds ?? null, maxTurns: null, sessionMinutes: definition.frontmatter.limits?.sessionMinutes ?? null },
  };

  const scope: BotRuntimeScope = {
    async invoke(capability, args) {
      const decision = await ctx.runs.authorize(run, capability, authorizeContext(args));
      if (!decision.allowed) throw new Error(`the run may not call "${capability}": ${decision.reason}`);
      // A grant that waits for a person becomes a pending approval (the approvals plugin's one handler) and the run stops: the call is not
      // made now, and approving it later makes it once, as the bot. Without that plugin it fails closed — running it anyway is the one
      // thing the flag exists to stop.
      if (decision.needsApproval) {
        const filed = await requestToolApproval(ctx, run, capability, args, { approvers });
        if (!filed) throw new Error(`"${capability}" needs a person's approval before it runs`);
        if ('refused' in filed) throw new Error(filed.refused);
        throw new ApprovalPending(capability);
      }
      return ctx.runs.asBot(run, (inner) => ctx.runs.invoke(inner, capability, args));
    },
    logSource: (source) => ctx.runs.asBot(run, (inner) => ctx.runs.logSource(inner, source)),
    log: (line) => log.info(line),
  };
  return { input: built, scope };
}

// A run that finished with an Answer (`answer.post`, PLAN P5-18) has posted its reply already — with its citations and what it reached —
// and the text the model printed after the tool call is that same reply, not a second one: it is not posted again. The message says which run
// wrote it in its `meta.runId`, which is how a run is known to have answered. A plain `messages.post` the run made into the reply channel counts
// too (the tool stamps `meta.runId`, and puts a post with no thread into the reply thread), so the model's own message is not followed by the final text.
//
// The reply is a message like any other: posted through the channels plugin's own `messages.post`, as the run's bot,
// and authorized like every other call the run makes — a definition that never asked for `messages.post` cannot post.
// A failed run posts nothing: the text a dying process managed to print is a fragment, not an answer.
//
// A run that asked for an approval (a model's tool call over the MCP endpoint, say) ended at that question: `stopped`, not `done`.
export async function postReply(input: {
  ctx: PluginContext;
  tx: PluginTx;
  run: BotRunHandle;
  payload: RunPayload;
  scope: BotRuntimeScope;
  reply: string;
  ok: boolean;
  /** Why a failed run failed; with `botId` and `log` it lets the asker be told (`reportFailure`). Without them a failed run closes silently. */
  failed?: { botId: string; log: PluginLogger; error?: string | undefined; failure?: 'runner_offline' | 'hermes_unreachable' | 'timeout' | undefined };
}): Promise<void> {
  const { ctx, tx, run, payload, scope, reply, ok, failed } = input;
  const answered = ok && (await runPostedReply(tx, run.runId, payload.channelId, payload.replyRootId));
  if (ok && !answered && reply.trim() !== '') {
    await scope.invoke('messages.post', {
      channelId: payload.channelId,
      body: reply,
      threadRootId: payload.replyRootId,
    });
  }
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  const waiting = approvals ? await approvals.pendingForRun(tx, run.runId) : 0;
  // A failed run says so once (never the half answer above); one that is waiting for a person has its card in the thread already.
  if (!ok && waiting === 0 && failed) await reportFailure({ ctx, tx, log: failed.log, run, payload, botId: failed.botId, error: failed.error, failure: failed.failure });
  await ctx.runs.close(run.runId, waiting > 0 ? 'stopped' : ok ? 'done' : 'failed');
}

/**
 * Did this run already post its reply? Either its Answer in the thread it answers in, or any message it wrote itself into that same thread
 * (a failure notice does not count; a post into another thread or channel leaves the asker's thread unanswered). `meta.runId` is written by the platform alone: the `messages` provider and the `messages.post` tool set it
 * from the transaction's own run, and no argument can.
 */
async function runPostedReply(tx: PluginTx, runId: string, channelId: string, replyRootId: string | null): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM app.messages
      WHERE channel_id = $1::uuid AND (thread_root_id IS NOT DISTINCT FROM $3::uuid OR id = $3::uuid)
        AND meta ->> 'runId' = $2::text AND deleted_at IS NULL AND NOT (meta ? 'runFailure')
      LIMIT 1`,
    [channelId, runId, replyRootId],
  );
  return res.rows.length > 0;
}

/** Runs of different bots at once in one server process (`MANYTHREADS_RUN_CONCURRENCY`, default 6). Runs of the SAME bot never overlap. */
export function runConcurrencyFrom(env: NodeJS.ProcessEnv): number {
  const n = Number((env['MANYTHREADS_RUN_CONCURRENCY'] ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 6;
}

/** What the short first transaction leaves for the model turn. */
interface PreparedRun {
  bot: RunBotRow;
  provider: BotRuntimeProvider;
  run: BotRunHandle;
  input: BotRuntimeInput;
  scope: BotRuntimeScope;
}

/**
 * A retried job (its lease was lost mid-run, or the server died) must not run the bot a second time: a model turn is not replayable, and a
 * second answer would contradict the first. If an earlier attempt of THIS job already opened a run, that run is closed as failed (the asker is
 * told once) and the job ends; nothing is sent to the model again.
 */
export async function settleEarlierAttempt(ctx: PluginContext, log: PluginLogger, job: JobInfo, payload: RunPayload): Promise<boolean> {
  if (job.attempt <= 1) return false;
  const earlier = await job.transaction(async (tx) => {
    const res = await tx.query<{ id: string; status: string }>(
      `SELECT r.id, r.status FROM app.bot_runs r WHERE r.job_id = $1::uuid ORDER BY r.started_at DESC LIMIT 1`,
      [job.jobId],
    );
    return res.rows[0];
  });
  if (!earlier) return false;
  log.warn(`runtime-hermes: job ${job.jobId} was retried after run ${earlier.id} began; the run is not repeated`);
  if (earlier.status === 'running') {
    const open = await ctx.runs.openRunOf(payload.botId);
    if (open && open.runId === earlier.id) {
      await job.transaction((tx) => reportFailure({ ctx, tx, log, run: open, payload, botId: payload.botId, category: 'other' })).catch(() => undefined);
    }
    await ctx.runs.close(earlier.id, 'failed');
  }
  return true;
}

/**
 * Run one bot: the job half of P5-10. Everything it needs is re-read from the database and the repo (a payload is whatever was enqueued).
 *
 * The job is *detached*: it holds no database transaction while the model works. Three short transactions bracket the turn — one to read, open
 * the run and pass the gate and the pre-call check; the turn itself (minutes, with no connection held); one to post the reply and close the run.
 * Jobs of the same bot are serialised by the queue (`serialKey`), so at most one run per bot is open, which is what lets a gateway profile
 * reach the bot's stable MCP endpoint and be attributed to "the bot's open run".
 */
export function registerRunJob(ctx: PluginContext, options: { concurrency?: number } = {}): void {
  ctx.jobs.register(
    RUN_QUEUE,
    async (raw, _unusable, job) => {
      const payload = RunPayload.parse(raw);
      if (await settleEarlierAttempt(ctx, job.log, job, payload)) return;

      let prepared: PreparedRun | undefined;
      let opened: BotRunHandle | undefined;
      let handle: BotRuntimeHandle | undefined;
      let approvers: readonly string[] = [];
      let rhythmSettled = false;
      try {
        // 1. Read, open the run, gate, pre-call check (one short transaction).
        const result = await job.transaction(async (tx): Promise<PreparedRun | null> => {
          const bot = (
            await tx.query<RunBotRow>(
              `SELECT id, slug, name, runtime, definition_sha, team_id, workspace_id, status
                 FROM app.bots WHERE id = $1 AND workspace_id = $2`,
              [payload.botId, payload.workspaceId],
            )
          ).rows[0];
          if (!bot || bot.status !== 'active') return null; // a disabled, invalid or removed bot does not answer
          if (bot.team_id !== payload.teamId) return null;

          const provider = ctx.providers.get<BotRuntimeProvider>('bot_runtime', bot.runtime);
          if (!provider) {
            job.log.warn(`runtime-hermes: no bot_runtime provider is loaded for "${bot.runtime}" (bot ${bot.slug})`);
            return null;
          }
          const definition = await loadDefinition(ctx, tx, bot, job.log);
          if (!definition) return null;
          if (payload.rhythm) {
            const problem = rhythmOverrideProblem(definition, payload.rhythm);
            if (problem !== null) {
              rhythmSettled = true;
              await emitRhythmFinished(ctx, tx, payload, { runId: null, status: 'failed', reason: problem });
              return null;
            }
            applyRhythmOverrides(definition, payload.rhythm);
          }
          const { frontmatter, alias, holdOnDetection } = definition;
          approvers = definition.approvers;

          // The token outlives the run's own budget (plus the kill grace): a run whose token expired mid-turn would lose its tools
          // for the rest of the turn. The kernel clamps this to its maximum.
          const ttlSeconds = (frontmatter.limits?.timeoutSeconds ?? DEFAULT_RUN_BUDGET_SECONDS) + RUN_TOKEN_SLACK_SECONDS;
          let openedRun: Awaited<ReturnType<PluginContext['runs']['open']>>;
          try {
            openedRun = await ctx.runs.open({
              botId: bot.id,
              teamId: bot.team_id,
              workspaceId: bot.workspace_id,
              trigger: payload.trigger,
              askerActorId: payload.askerActorId,
              delegationDepth: payload.delegation?.depth ?? 0,
              jobId: job.jobId,
              threadId: payload.runThreadId,
              // where the reply goes, so an approval this run raises leaves its card in that thread
              channelId: payload.channelId,
              replyRootId: payload.replyRootId,
              ttlSeconds,
            });
          } catch (err) {
            // A run that cannot be opened (an asker no longer on the team, a bot that moved) will not open on a retry either: say so
            // once and end the job rather than letting the queue replay it five times.
            job.log.warn(`runtime-hermes: no run for bot ${bot.slug}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
          const { run, token } = openedRun;
          opened = run;
          await emitRhythmStarted(ctx, tx, payload, run);

          if ((await checkGate({ ctx, tx, log: job.log, provider, definition, payload, run, bot })) === 'stop') return null;

          // What a Hermes run lacks (no alias, no gateway URL) is reported by the provider's own profile render.
          const gatewayBase = (process.env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
          const preflight = await checkPreflight({ ctx, tx, log: job.log, provider, bot, run, payload, alias, gatewayBase, holdOnDetection, approvers });
          if (!preflight) return null;

          const { input, scope } = buildScope({
            ctx,
            log: job.log,
            bot,
            definition,
            payload,
            prompt: preflight.prompt,
            run,
            token,
            provider,
            gatewayBase,
            key: preflight.key,
            approvers,
          });
          return { bot, provider, run, input, scope };
        });
        if (!result) {
          // A scheduled run that never opened (the bot went inactive, its definition moved on, no runtime is loaded) must not leave its firing queued.
          if (payload.rhythm && !opened && !rhythmSettled) {
            await job.transaction((tx) =>
              emitRhythmFinished(ctx, tx, payload, { runId: null, status: 'failed', reason: 'The run could not start: the bot is not active, its definition has changed, or no runtime is loaded for it.' }),
            );
          }
          return;
        }
        prepared = result;
        const { bot, provider, run, input, scope } = prepared;

        // 2. The model turn: no transaction held.
        let toolCalls = 0;
        handle = await provider.run(input, scope);
        let reply = '';
        let ok = false;
        let error: string | undefined;
        let failure: 'runner_offline' | 'hermes_unreachable' | 'timeout' | undefined;
        for await (const event of handle.events) {
          // The agent's tool calls are the run's whole footprint on the workspace, and nothing else writes them down: say each one, and
          // whether it was refused, so a run that quietly stopped using its tools can be read from the log instead of guessed at.
          if (event.type === 'tool') {
            toolCalls += 1;
            job.log.info(`runtime-hermes: run ${run.runId} called ${event.name}`);
          }
          if (event.type === 'tool_result') job.log.info(`runtime-hermes: run ${run.runId} ${event.name} ${event.ok ? 'answered' : `failed: ${event.reason ?? 'no reason given'}`}`);
          if (event.type !== 'result') continue;
          reply = event.text;
          ok = event.ok;
          error = event.error;
          failure = event.failure;
          if (event.tokens) job.log.info(`runtime-hermes: run ${run.runId} used ${event.tokens.total} tokens over ${toolCalls} tool calls`);
          if (!event.ok) job.log.warn(`runtime-hermes: run ${run.runId} failed: ${event.error ?? 'no reason given'}`);
        }
        await handle.stop();

        // 3. Post the reply and close the run (one short transaction).
        if (payload.rhythm) {
          await job.transaction((tx) => finishRhythmRun({ ctx, tx, log: job.log, run, payload, scope, reply, ok }));
          return;
        }
        await job.transaction((tx) => postReply({ ctx, tx, run, payload, scope, reply, ok, failed: { botId: bot.id, log: job.log, error, failure } }));
      } catch (err) {
        if (!opened) {
          // Nothing started: let the queue retry. A scheduled run that keeps failing before it opens (a missing BOT.md, no repo) settles its firing
          // on the third attempt, with the reason, instead of leaving it queued.
          if (payload.rhythm && job.attempt >= 3) {
            await job
              .transaction((tx) => emitRhythmFinished(ctx, tx, payload, { runId: null, status: 'failed', reason: `The run could not be set up: ${err instanceof Error ? err.message : 'unknown error'}` }))
              .catch(() => undefined);
          }
          throw err;
        }
        const run = opened;
        if (err instanceof ApprovalPending) {
          job.log.info(`runtime-hermes: run ${run.runId} stopped: "${err.capability}" is waiting for an approval`);
          await handle?.stop().catch(() => undefined);
          await ctx.runs.close(run.runId, 'stopped');
          return;
        }
        // A model call is not something to replay blindly: the run is closed as failed and the reason is logged, rather than
        // letting the job retry (which would re-ask the model and post a second answer).
        job.log.warn(`runtime-hermes: run ${run.runId} threw: ${err instanceof Error ? err.message : String(err)}`);
        await handle?.stop().catch(() => undefined);
        if (payload.rhythm) {
          await job
            .transaction((tx) => emitRhythmFinished(ctx, tx, payload, { runId: run.runId, status: 'failed', reason: 'The run stopped with an error before it finished.' }))
            .catch(() => undefined);
        }
        await job
          .transaction(async (tx) => {
            const waiting = await ctx.providers.get<ApprovalProvider>('approvals')?.pendingForRun(tx, run.runId).catch(() => 0);
            if (!waiting) await reportFailure({ ctx, tx, log: job.log, run, payload, botId: payload.botId, error: err instanceof Error ? err.message : String(err) });
          })
          .catch(() => undefined);
        await ctx.runs.close(run.runId, 'failed');
      }
    },
    { detached: true, concurrency: options.concurrency ?? runConcurrencyFrom(process.env), serialKey: 'botId' },
  );
}
