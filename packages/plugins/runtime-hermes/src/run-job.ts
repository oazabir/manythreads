import { createHash } from 'node:crypto';
import {
  authorizeContext,
  CapabilityRefusedError,
  requestToolApproval,
  type ApprovalProvider,
  type BotRunHandle,
  type BotRuntimeEvent,
  type BotRuntimeFailure,
  type BotRuntimeHandle,
  type JobInfo,
  type McpToolsProvider,
  type ModelMessage,
  type ModelToolSpec,
  type ModelTurnResult,
  type BotRuntimeInput,
  type BotRunnersProvider,
  type BotRuntimeProvider,
  type BotRuntimeScope,
  type PluginContext,
  type PluginLogger,
  type PluginTx,
} from '@manythreads/sdk';
import {
  BotRunnerName,
  BotRunnerRunRefusedReason,
  GUARD_RULE_DLP_APPROVAL,
  LlmAliasName,
  botMdPath,
  mcpUrlOf,
  modelAliasesOfDefinition,
  parseBotMd,
} from '@manythreads/shared';
import { z } from 'zod';
import { hasGate, runGate, type ClassifierDoor } from './gate.ts';
import { settleAgentApproval } from './agent-approval.ts';
import { holdForApproval, holdForGate, postNotice, previewText } from './holds.ts';
import { classifyFailure, looksLikeRejectedKey, postFailureNotice, postNotOnTeamNotice, type FailureCategory } from './failure-notice.ts';
import { applyChatAlias, recordRunFacts, recordStopped, streamsLive } from './chat-run.ts';
import { LiveFrames, trackRun, untrackRun } from './live.ts';
import { MAX_DELEGATION_DEPTH } from './match.ts';
import { meterPodRun } from './metering.ts';
import { rehearsalBlocker, withRehearsalNote } from './rehearsal.ts';
import { scheduledJobOverrideProblem, applyScheduledJobOverrides, emitScheduledJobFinished, emitScheduledJobStarted, finishScheduledJobRun } from './scheduled-job-run.ts';

/** The answer of a run the asker stopped before it had written a word. */
const STOPPED_BEFORE_ANSWER = 'Stopped before an answer was written.';

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
  trigger: z.enum(['conversation', 'mention', 'channel_message', 'task_assigned', 'routine', 'inbox', 'webhook']),
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
   * The id of the message that started the run, when a message did (PLAN P7-07). The gate's decision is kept with this id and never with the text: the Workshop's replay reads the
   * message again through the viewer's own access and asks the bot's current gate the same question.
   */
  messageId: z.uuid().optional(),
  /**
   * Set when this run answers a bot-authored mention (a delegation): the authoring bot and how deep the chain in this
   * thread already is. Absent (or 0 on the row) when a person asked.
   */
  delegation: z.strictObject({ fromBotId: z.uuid(), depth: z.number().int().min(1).max(MAX_DELEGATION_DEPTH) }).optional(),
  /**
   * Set when this run is the firing of a scheduled job (a `routine` trigger, PLAN P6-08): which firing it settles, the page a routine's reply is
   * written to and how, and the scheduled job's own model alias and effort. the `scheduled-jobs` plugin owns the ledger; the run only reports back with events.
   */
  scheduledJob: z
    .strictObject({
      scheduledJobRunId: z.uuid(),
      kind: z.enum(['heartbeat', 'routine', 'task']),
      outputPath: z.string().min(1).max(300).nullable(),
      outputMode: z.enum(['create', 'replace', 'append']).nullable(),
      modelAlias: z.string().min(1).max(40).nullable(),
      effort: z.enum(['low', 'medium', 'high']).nullable(),
      /** Set for a person's own routine (P20-10): whose Personal space the output is written to (the asker is the same person). Absent for a team's schedule. */
      personal: z.strictObject({ ownerPersonId: z.uuid() }).optional(),
    })
    .optional(),
  /**
   * Set when this run is the answer to a mail (an `inbox` trigger, PLAN P8-30): the claim that makes it the one run of this bot for this mail thread, the connection and the
   * mail. Only the ids travel; the mail is read from its row. The connections plugin finds the claim from this payload (the run's job) when the run posts, and links the
   * mail to that post. Such a run has no reply root (the post it makes opens the thread) and no asker.
   */
  inbox: z.strictObject({ claimId: z.uuid(), connectionId: z.uuid(), mailId: z.uuid() }).optional(),
  /**
   * Set when this run answers a work app's delivery (a `webhook` trigger, PLAN P16-10): the stored event that makes it the one run of this bot for this delivery. Only the id
   * travels; the text is read from the event's row. The run claims it (`app.webhooks_claim_run`) as soon as it is open, and a run that finds it already claimed stops. Such a run has
   * no reply root (the post it makes opens the thread) and no asker.
   */
  webhook: z.strictObject({ eventId: z.uuid() }).optional(),
  /** The card this run works on (a `task_assigned` run). Absent on a run queued before cards were recorded, and on every other trigger. Read by the board's bot icon. */
  taskId: z.uuid().optional(),
  /** Marks the payload stored with a gate hold, so that approving it resumes the run past the gate (not past the DLP check). */
  gateHold: z.literal(true).optional(),
  /**
   * Set by the router, from a question the Test route filed (`app.rehearsal_questions`), never from anything a caller sent: the run is a rehearsal, so
   * the gateway holds back every write it tries and lists it as "not done" (PLAN P7-11, docs/plugins/gateway-mcp.md). Only a conversation run has it.
   */
  rehearsal: z.literal(true).optional(),
  /**
   * The model a person picked for the message that started this run (Chat, PLAN P20-16), read by the router from `app.message_model_picks` (or carried by Regenerate), never from
   * anything a caller sent to a queue. The run uses it only when the bot's definition lists it; otherwise the bot's first alias answers.
   */
  modelAlias: z.string().min(1).max(40).optional(),
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
  ): Promise<{ allowed: boolean; message: string | null; text: string; outcome: string; rules: string[]; preset?: string; reason?: string | null }>;
  /** One turn of a run on an LLM gateway runner (P19-10); optional: an older gateway has none. */
  chat?(
    run: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>,
    request: {
      workspaceId: string;
      botId: string;
      teamId: string;
      runId: string;
      alias: string;
      messages: ModelMessage[];
      tools: ModelToolSpec[];
      maxTokens: number;
      firstTurn: boolean;
      checkedUpTo: number;
      timeoutMs?: number;
    },
  ): Promise<ModelTurnResult>;
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
  /** 'workspace' for the one Brain of the workspace (it has no team of its own: `team_id` here is the CONTEXT team of the run); absent or 'team' for every other bot. */
  scope?: string;
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
  failure?: BotRuntimeFailure | undefined;
  /** With `failure: 'runner_refused'`: which runner turned the run away and why, and the one sentence to say it with. */
  refusal?: RunnerRefusal | undefined;
}): Promise<void> {
  const { ctx, tx, log, run, payload, botId } = input;
  // A run the runner catalog turned away at the start (P19-03): the fact is written down whoever was waiting, and the thread hears one plain line.
  if (input.refusal) await recordRunnerRefusal(ctx, tx, run, botId, input.refusal, log);
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
  // A scheduled run has no one waiting for an answer; the reason lives on its firing in the scheduled jobs ledger.
  if (payload.scheduledJob) return;
  // A run that already put a live message into its reply thread did the work; a notice under it would contradict it (a run stopped at its
  // time limit after posting its result, say). Same thread restriction as the reply check in `postReply`.
  if (await runPostedReply(tx, run.runId, payload.channelId, payload.replyRootId)) {
    log.info(`runtime-hermes: run ${run.runId}: no failure notice (the run already posted into its thread)`);
    return;
  }
  await postFailureNotice(ctx, tx, run, payload, input.category ?? classifyFailure(input.error, input.failure), (line) => log.warn(line), input.refusal?.line);
}

/** What a runner said when it turned a run away: its name, a reason from the fixed list, and the plain sentence. */
export type RunnerRefusal = { runner: string; reason: string; line: string };

/** The `bot_runner.run.refused` event: ids, the runner's name and a reason from a fixed list; never an address, a key, a node or the sentence. A reason or a name outside the contract is not written. */
export async function recordRunnerRefusal(ctx: PluginContext, tx: PluginTx, run: BotRunHandle, botId: string, refusal: RunnerRefusal, log: PluginLogger): Promise<void> {
  const reason = BotRunnerRunRefusedReason.safeParse(refusal.reason);
  if (!reason.success || !BotRunnerName.safeParse(refusal.runner).success) {
    log.warn(`runtime-hermes: run ${run.runId}: a runner refusal with an unknown reason or name was not recorded`);
    return;
  }
  try {
    await tx.query('SAVEPOINT run_runner_refused');
    await ctx.audit.emit(tx, {
      type: 'bot_runner.run.refused',
      workspaceId: run.workspaceId,
      teamId: run.teamId,
      botId,
      runId: run.runId,
      runner: refusal.runner,
      reason: reason.data,
      at: ctx.runtime.now().toISOString(),
    });
    await tx.query('RELEASE SAVEPOINT run_runner_refused');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT run_runner_refused').catch(() => undefined);
    log.warn(`runtime-hermes: run ${run.runId}: the refusal could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The id of the provider that answers a bot placed on an LLM gateway runner: registered by `bot-runners`, chosen here by the runner's kind (never by `bots.runtime`). */
export const MODEL_RUNTIME_ID = 'model';

/** Is the runner this bot's `runs_on` names an LLM gateway runner? Asked of the runner catalog on the job's transaction; false when there is no `runs_on` or no catalog. */
export async function runsOnModelRunner(ctx: PluginContext, tx: PluginTx, bot: RunBotRow, runsOn: string | undefined): Promise<boolean> {
  // Only a Hermes bot has a runner to choose: a rules bot runs inside the server and must never be redirected.
  if (runsOn === undefined || bot.runtime !== 'hermes') return false;
  const runners = ctx.providers.get<BotRunnersProvider>('bot.runners');
  if (!runners) return false;
  return (await runners.kindOf(tx, { teamId: bot.team_id, runner: runsOn }))?.kind === 'llm_gateway';
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
  let contents: string;
  let sha: string;
  if (bot.scope === 'workspace') {
    // the workspace Brain has no repo: its BOT.md is a row of app.workspace_bot_definitions, found by the sha the bot row carries (bots 0027)
    const row = (
      await tx.query<{ content: string }>(
        'SELECT content FROM app.workspace_bot_definitions WHERE workspace_id = $1::uuid AND slug = $2 AND sha = $3 ORDER BY version DESC LIMIT 1',
        [bot.workspace_id, bot.slug, bot.definition_sha],
      )
    ).rows[0];
    if (!row) {
      log.warn(`runtime-hermes: the workspace bot ${bot.slug} has no stored definition at the loaded sha; no run`);
      return null;
    }
    contents = row.content;
    sha = bot.definition_sha;
  } else {
    const repo = ctx.providers.get<RepoDoor>('repo');
    if (!repo) throw new Error('runtime-hermes: the repo provider is not registered');
    const file = await repo.blob(tx, bot.team_id, botMdPath(bot.slug), 'main');
    contents = Buffer.from(file.content).toString('utf8');
    sha = createHash('sha256').update(file.content).digest('hex');
  }
  if (sha !== bot.definition_sha) {
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
    alias: modelAliasesOfDefinition(parsed.frontmatter)[0] ?? null,
    holdOnDetection: parsed.frontmatter.guard?.rules?.includes(GUARD_RULE_DLP_APPROVAL) ?? false,
    approvers: parsed.frontmatter.approvals?.approvers ?? [],
  };
}

/**
 * Keeps one line of what the gate or the guard decided for this run (`run_decisions`, PLAN P7-07), content-blind. Recording never changes the outcome of the check it describes:
 * a failure is logged and the run goes on.
 */
async function recordDecision(ctx: PluginContext, log: PluginLogger, run: BotRunHandle, decision: Parameters<PluginContext['runs']['logDecision']>[1]): Promise<void> {
  try {
    await ctx.runs.asBot(run, (tx) => ctx.runs.logDecision(tx, decision));
  } catch (err) {
    log.warn(`runtime-hermes: run ${run.runId}: a ${decision.kind} decision could not be recorded: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
  }
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
    await recordDecision(ctx, log, run, {
      kind: 'gate',
      subject: 'gate',
      outcome: verdict.kind === 'pass' ? 'passed' : verdict.kind === 'hold' ? 'held' : 'refused',
      target: null,
      messageId: payload.messageId ?? null,
      detail: {
        stage: verdict.kind === 'hold' ? verdict.stage : 'none',
        entry: verdict.kind === 'hold' ? verdict.entry : null,
        entries: gateEntries.length,
        // whether stage two (a model) was part of the decision, so a replay knows what it cannot redo
        topics: gateEntries.filter((e) => !(e.length > 1 && e.startsWith('/'))).length,
      },
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
      await recordDecision(ctx, log, run, {
        kind: 'guard',
        subject: alias,
        outcome: !decision.allowed && (decision.reason === 'budget' || decision.reason === 'rate') ? 'refused' : decision.outcome,
        target: null,
        messageId: payload.messageId ?? null,
        detail: { preset: decision.preset ?? null, reason: decision.reason ?? null, rules: decision.rules.slice(0, 20), allowed: decision.allowed },
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

/** What `buildScope` reads of a run's payload: a drop run (P8-18) has no channel, so `channelId` may be null and the run has no thread. */
export type ScopePayload = Pick<RunPayload, 'askerActorId' | 'replyRootId'> & { trigger: string; channelId: string | null };

// The scope a provider gets is the run's own authority, and the broker decides every call it makes: the runtime
// implements what a model chose, so a call it makes is exactly as constrained as one made over the run's MCP
// endpoint. Without this the allowlist compiled from `capabilities.native` would be a promise the platform keeps at
// one door and forgets at the other.
export function buildScope(input: {
  ctx: PluginContext;
  log: PluginLogger;
  bot: RunBotRow;
  definition: LoadedDefinition;
  payload: ScopePayload;
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
    thread: payload.channelId === null ? null : { channelId: payload.channelId, threadRootId: payload.replyRootId },
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
      // The runtime's own door has one use in a conversation: the reply. A rehearsal run (which holds every write back at the gateway) never makes any
      // other call here, so a runtime that tried would be stopped rather than allowed to bypass the hold.
      if (run.rehearsal === true && capability !== 'messages.post') throw new Error(`the run is a rehearsal and may not call "${capability}"`);
      const decision = await ctx.runs.authorize(run, capability, authorizeContext(args));
      if (!decision.allowed) throw new CapabilityRefusedError(capability, decision.reason);
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
  // The `model` runtime has no process: it calls the model and the tools through these two doors, as the run's bot. No other runtime is handed them.
  if (provider.id === MODEL_RUNTIME_ID) {
    const llm = ctx.providers.get<LlmDoor>('llm');
    if (llm?.chat) {
      const chat = llm.chat.bind(llm);
      scope.model = {
        // The gateway opens its own short system transactions for the check and for the spend line; none is open while the proxy answers (that can take minutes).
        turn: (turn) =>
          chat((fn) => ctx.db.system(fn), {
            workspaceId: bot.workspace_id,
            botId: bot.id,
            teamId: bot.team_id,
            runId: run.runId,
            alias: turn.alias,
            messages: turn.messages,
            tools: turn.tools,
            maxTokens: turn.maxTokens,
            firstTurn: turn.firstTurn,
            checkedUpTo: turn.checkedUpTo,
            ...(turn.timeoutMs === undefined ? {} : { timeoutMs: turn.timeoutMs }),
          }),
      };
    }
    const mcp = ctx.providers.get<McpToolsProvider>('mcp.tools');
    if (mcp) scope.tools = { list: () => mcp.offered(run), call: (name, args) => mcp.call(run, name, args) };
  }
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
  failed?: { botId: string; log: PluginLogger; error?: string | undefined; failure?: BotRuntimeFailure | undefined; refusal?: RunnerRefusal | undefined };
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
  if (!ok && waiting === 0 && failed) await reportFailure({ ctx, tx, log: failed.log, run, payload, botId: failed.botId, error: failed.error, failure: failed.failure, refusal: failed.refusal });
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
  /** The gateway alias the definition names first; the alias a pod run's spend line is written under. */
  alias: string | null;
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
      const payload = withRehearsalNote(RunPayload.parse(raw));
      if (await settleEarlierAttempt(ctx, job.log, job, payload)) return;

      let prepared: PreparedRun | undefined;
      let opened: BotRunHandle | undefined;
      let handle: BotRuntimeHandle | undefined;
      let approvers: readonly string[] = [];
      let scheduledJobSettled = false;
      // The live frames of a run that streams; ended after its answer is posted (so the screen never sees "ended" before the answer), and on any failure (so it
      // never waits for an end that will not come).
      let frames: LiveFrames | undefined;
      try {
        // 1. Read, open the run, gate, pre-call check (one short transaction).
        const result = await job.transaction(async (tx): Promise<PreparedRun | null> => {
          const found = (
            await tx.query<RunBotRow>(
              `SELECT id, slug, name, runtime, definition_sha, team_id, workspace_id, status, scope
                 FROM app.bots WHERE id = $1 AND workspace_id = $2`,
              [payload.botId, payload.workspaceId],
            )
          ).rows[0];
          if (!found || found.status !== 'active') return null; // a disabled, invalid or removed bot does not answer
          // The workspace Brain has no team of its own: the run keeps the CONTEXT team (the team of the channel or conversation it answers in), and what it may read
          // comes only from the run's own row (app.run_space_context). Every other bot must be asked in its own team.
          const bot: RunBotRow = found.scope === 'workspace' ? { ...found, team_id: payload.teamId } : found;
          if (bot.team_id !== payload.teamId) return null;

          let provider = ctx.providers.get<BotRuntimeProvider>('bot_runtime', bot.runtime);
          if (!provider) {
            job.log.warn(`runtime-hermes: no bot_runtime provider is loaded for "${bot.runtime}" (bot ${bot.slug})`);
            return null;
          }
          const definition = await loadDefinition(ctx, tx, bot, job.log);
          if (!definition) return null;
          if (payload.scheduledJob) {
            const problem = scheduledJobOverrideProblem(definition, payload.scheduledJob);
            if (problem !== null) {
              scheduledJobSettled = true;
              await emitScheduledJobFinished(ctx, tx, payload, { runId: null, status: 'failed', reason: problem });
              return null;
            }
            applyScheduledJobOverrides(definition, payload.scheduledJob);
          }
          if (payload.trigger === 'conversation') applyChatAlias(definition, payload.modelAlias, job.log);
          const { frontmatter, alias, holdOnDetection } = definition;
          approvers = definition.approvers;

          // A bot placed (`runs_on`) on an LLM gateway runner is answered by a loop of model calls through the platform's gateway, not by Hermes (P19-10). Every other bot keeps its runtime.
          if (await runsOnModelRunner(ctx, tx, bot, frontmatter.placement?.runs_on)) {
            const model = ctx.providers.get<BotRuntimeProvider>('bot_runtime', MODEL_RUNTIME_ID);
            if (!model) {
              job.log.warn(`runtime-hermes: bot ${bot.slug} is placed on an LLM gateway runner, but no "${MODEL_RUNTIME_ID}" runtime is loaded`);
              return null;
            }
            provider = model;
          }

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
              ...(payload.taskId ? { taskId: payload.taskId } : {}),
              ttlSeconds,
              ...(payload.rehearsal === true ? { rehearsal: true } : {}),
            });
          } catch (err) {
            // A run that cannot be opened (an asker no longer on the team, a bot that moved) will not open on a retry either: say so
            // once and end the job rather than letting the queue replay it five times.
            job.log.warn(`runtime-hermes: no run for bot ${bot.slug}: ${err instanceof Error ? err.message : String(err)}`);
            // A person off the bot's team who names it would otherwise wait for an answer that never comes: tell them in the thread.
            await postNotOnTeamNotice(ctx, tx, { payload, jobId: job.jobId, bot }, (line) => job.log.warn(line));
            return null;
          }
          const { run, token } = openedRun;
          opened = run;
          await emitScheduledJobStarted(ctx, tx, payload, run);

          // One run of one bot for one delivery: the latch row is written in the same step that names this run, so a job that was replayed after a crash stops here instead of answering twice.
          if (payload.webhook) {
            const eventId = payload.webhook.eventId;
            const first = await ctx.db.system(async (sys) => (await sys.query<{ ok: boolean }>('SELECT app.webhooks_claim_run($1::uuid, $2::uuid, $3::uuid) AS ok', [eventId, bot.id, run.runId])).rows[0]?.ok === true, {
              workspaceId: bot.workspace_id,
            });
            if (!first) {
              job.log.warn(`runtime-hermes: delivery ${eventId} already started a run for bot ${bot.slug}; this one stops`);
              await ctx.runs.close(run.runId, 'stopped');
              return null;
            }
          }

          // A rehearsal holds back what goes through the tool door; a definition that also lets the bot's own process change things (a shell, files, a
          // browser) cannot be held back there, so the run says why it did not start and ends here, before anything is sent to a model.
          const blocker = payload.rehearsal === true ? rehearsalBlocker(definition.frontmatter.capabilities?.runtime) : null;
          if (blocker !== null) {
            await postNotice(ctx, run, payload, blocker, (line) => job.log.warn(line));
            await ctx.runs.close(run.runId, 'stopped');
            return null;
          }

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
          return { bot, provider, run, input, scope, alias };
        });
        if (!result) {
          // A scheduled run that never opened (the bot went inactive, its definition moved on, no runtime is loaded) must not leave its firing queued.
          if (payload.scheduledJob && !opened && !scheduledJobSettled) {
            await job.transaction((tx) =>
              emitScheduledJobFinished(ctx, tx, payload, { runId: null, status: 'failed', reason: 'The run could not start: the bot is not active, its definition has changed, or no runtime is loaded for it.' }),
            );
          }
          return;
        }
        prepared = result;
        const { bot, provider, run, input, scope, alias: runAlias } = prepared;
        // A person's conversation streams: the asker gets the words as they are written, and can stop the run (live.ts). Anyone else's run does neither.
        // Tracked from here, not from the moment the process exists, so a Stop pressed while the run is starting is kept and applied the moment it has one.
        const liveEntry = streamsLive(payload) ? trackRun(run.runId, payload.askerActorId) : undefined;
        frames = streamsLive(payload)
          ? new LiveFrames(ctx, job, { runId: run.runId, channelId: payload.channelId, threadRootId: payload.replyRootId, askerActorId: payload.askerActorId }, job.log)
          : undefined;
        // Not in the transaction that opened the run: a hold or a close in that transaction goes through the run's own door on another connection, which would wait for this row's lock.
        await job.transaction((tx) => recordRunFacts(tx, run.runId, payload, runAlias));

        // 2. The model turn: no transaction held.
        let toolCalls = 0;
        handle = await provider.run(input, scope);
        if (liveEntry) {
          liveEntry.handle = handle;
          if (liveEntry.stopped) await handle.stop();
        }
        let reply = '';
        let ok = false;
        let error: string | undefined;
        let failure: BotRuntimeFailure | undefined;
        let refusal: RunnerRefusal | undefined;
        let viaPod: { runner: string } | undefined;
        let viaClaude: Extract<BotRuntimeEvent, { type: 'result' }>['viaClaude'];
        let tokens: { input: number; output: number; total: number } | null | undefined;
        for await (const event of handle.events) {
          if (event.type === 'text') frames?.text(event.text);
          // The agent's tool calls are the run's whole footprint on the workspace, and nothing else writes them down: say each one, and
          // whether it was refused, so a run that quietly stopped using its tools can be read from the log instead of guessed at.
          if (event.type === 'tool') {
            toolCalls += 1;
            frames?.looking(event.name);
            job.log.info(`runtime-hermes: run ${run.runId} called ${event.name}`);
          }
          // The bot's program stopped to ask a person (a command it wants to run): file it, wait for the decision, and tell the program (agent-approval.ts).
          if (event.type === 'approval') await settleAgentApproval({ ctx, job, run, question: event, approvers, stopped: () => liveEntry?.stopped === true });
          if (event.type === 'tool_result') job.log.info(`runtime-hermes: run ${run.runId} ${event.name} ${event.ok ? 'answered' : `failed: ${event.reason ?? 'no reason given'}`}`);
          if (event.type !== 'result') continue;
          reply = event.text;
          ok = event.ok;
          error = event.error;
          failure = event.failure;
          refusal = event.refusal;
          viaPod = event.viaPod;
          viaClaude = event.viaClaude;
          tokens = event.tokens;
          if (event.tokens) job.log.info(`runtime-hermes: run ${run.runId} used ${event.tokens.total} tokens over ${toolCalls} tool calls`);
          if (!event.ok) job.log.warn(`runtime-hermes: run ${run.runId} failed: ${event.error ?? 'no reason given'}`);
        }
        await handle.stop();
        // The asker pressed Stop: what had been written is the answer (a killed process ends with an error that is not the asker's to read).
        const stoppedByAsker = liveEntry?.stopped === true;
        if (stoppedByAsker) {
          ok = true;
          error = undefined;
          failure = undefined;
          reply = frames !== undefined && frames.full.trim() !== '' ? frames.full : STOPPED_BEFORE_ANSWER;
        }
        if (liveEntry) untrackRun(run.runId);

        // 2b. A run the team's pod served is counted at the model gateway: one spend line under the bot, or the `bot_runner.run.unmetered` event (P19-10).
        if (viaPod) {
          const pod = viaPod;
          await job.transaction((tx) => meterPodRun({ ctx, tx, log: job.log, run, botId: bot.id, runner: pod.runner, ok, alias: runAlias, tokens })).catch((err: unknown) => {
            job.log.warn(`runtime-hermes: run ${run.runId}: the pod run could not be metered: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        // 2c. A run a shared Claude runner served is counted for the team; a plan limit or a refused sign-in pauses the runner (once; the next run is refused at the start).
        if (viaClaude) {
          const claude = viaClaude;
          const runners = ctx.providers.get<BotRunnersProvider>('bot.runners');
          try {
            await runners?.recordUsage({ runner: claude.runner, teamId: input.bot.teamId, seconds: claude.seconds, cost: claude.cost });
            if (claude.failure) await runners?.pauseRunner({ runner: claude.runner, teamId: input.bot.teamId, reason: claude.failure, until: claude.resetsAt ?? null });
          } catch (err) {
            job.log.warn(`runtime-hermes: run ${run.runId}: the Claude runner's usage could not be written: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // 3. Post the reply and close the run (one short transaction).
        if (payload.scheduledJob) {
          // A firing turned away by its runner is written down like any refused run (event and audit); its ledger line is the runner's own sentence.
          await job.transaction(async (tx) => {
            if (!ok && refusal) await recordRunnerRefusal(ctx, tx, run, bot.id, refusal, job.log);
            await finishScheduledJobRun({ ctx, tx, log: job.log, run, payload, scope, reply, ok, ...(!ok && refusal ? { failureReason: refusal.line } : {}) });
          });
          return;
        }
        // committed first: the reply is posted through the run's own door, and the conversations plugin reads this fact when that message's event arrives
        if (stoppedByAsker) await job.transaction((tx) => recordStopped(tx, run.runId));
        await job.transaction((tx) => postReply({ ctx, tx, run, payload, scope, reply, ok, failed: { botId: bot.id, log: job.log, error, failure, refusal } }));
        await frames?.end(stoppedByAsker ? 'stopped' : ok ? 'done' : 'failed');
      } catch (err) {
        untrackRun(opened?.runId ?? '');
        await frames?.end('failed').catch(() => undefined);
        if (!opened) {
          // Nothing started: let the queue retry. A scheduled run that keeps failing before it opens (a missing BOT.md, no repo) settles its firing
          // on the third attempt, with the reason, instead of leaving it queued.
          if (payload.scheduledJob && job.attempt >= 3) {
            await job
              .transaction((tx) => emitScheduledJobFinished(ctx, tx, payload, { runId: null, status: 'failed', reason: `The run could not be set up: ${err instanceof Error ? err.message : 'unknown error'}` }))
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
        // the reply itself refused by the bot's allowlist: a typed error, so the notice names the cause without reading any text
        const refusedReply = err instanceof CapabilityRefusedError && err.capability === 'messages.post';
        await handle?.stop().catch(() => undefined);
        if (payload.scheduledJob) {
          await job
            .transaction((tx) => emitScheduledJobFinished(ctx, tx, payload, { runId: run.runId, status: 'failed', reason: 'The run stopped with an error before it finished.' }))
            .catch(() => undefined);
        }
        await job
          .transaction(async (tx) => {
            const waiting = await ctx.providers.get<ApprovalProvider>('approvals')?.pendingForRun(tx, run.runId).catch(() => 0);
            if (!waiting) await reportFailure({ ctx, tx, log: job.log, run, payload, botId: payload.botId, error: err instanceof Error ? err.message : String(err), ...(refusedReply ? { category: 'not_allowed' as const } : {}) });
          })
          .catch(() => undefined);
        await ctx.runs.close(run.runId, 'failed');
      }
    },
    { detached: true, concurrency: options.concurrency ?? runConcurrencyFrom(process.env), serialKey: 'botId' },
  );
}
