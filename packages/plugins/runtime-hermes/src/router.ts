import { createHash } from 'node:crypto';
import {
  NoEligibleApproverError,
  requestToolApproval,
  type ApprovalProvider,
  type BotRuntimeHandle,
  type BotRuntimeInput,
  type BotRuntimeProvider,
  type BotRuntimeScope,
  type CapabilityAuthorizeContext,
  type PluginContext,
  type PluginEvent,
  type PluginTx,
} from '@manythreads/sdk';
import {
  ApprovalsApprovalDecidedEvent,
  ChannelMessagePostedEvent,
  GUARD_RULE_DLP_APPROVAL,
  LlmAliasName,
  botMdPath,
  parseBotMd,
  parseMarkup,
  type BotTrigger,
} from '@manythreads/shared';
import { z } from 'zod';
import { hasGate, runGate, type ClassifierDoor, type GateVerdict } from './gate.ts';

// Trigger routing (PLAN P5-10: "route `conversation`, `mention`, `channel_message` triggers"). One subscription on
// `channel.message.posted` decides, for every active bot of the message's team, whether one of its BOT.md triggers fired;
// the run itself happens in a job, because starting a process and talking to a model has no business in the outbox
// transaction that delivered the event.
//
// The three triggers, as this phase can honestly tell them apart:
//
//  * `conversation` — the message landed in the bot's own channel (`channels.bot_id = bot.id`, the unlisted per-bot channel
//    P5-16 creates). This is also the shape a DM with a bot takes, so it is the trigger a person talking to a bot fires.
//  * `mention` — the body names the bot (`@<slug>`), optionally only in the channels the trigger lists.
//  * `channel_message` — a message in a channel the trigger lists (or, with no `source`, anywhere on the bot's team).
//
// What never fires a run: a message a **bot** wrote (no bot answers a bot in this phase — that is delegation, P6), a private
// channel, a DM, an archived channel, and the bot's own reply, which is a message like any other. One message starts at most
// one run per bot (the job's dedupe key), and the trigger with the highest priority wins: conversation, then mention, then
// channel_message.

/** The job queue one run executes in. */
export const RUN_QUEUE = 'runtime-hermes.run';

/** A run's default wall clock when its definition names none (hermes.ts uses the same), and the slack its token outlives it by. */
const DEFAULT_RUN_BUDGET_SECONDS = 600;
const RUN_TOKEN_SLACK_SECONDS = 120;

/** What the router decided: which trigger of one bot fires on one message. */
export type RoutedTrigger = 'conversation' | 'mention' | 'channel_message';

export interface MessageView {
  /** The channel's name, without the `#`. */
  channelName: string;
  /** The channel is the bot's own (its conversation). */
  isBotChannel: boolean;
  /** The lowercased `@handles` the body names. */
  mentions: ReadonlySet<string>;
}

/** The trigger of `bot` that this message fires, or null. Highest priority first; `source.channels` narrows mention and channel_message. */
export function matchTrigger(triggers: readonly BotTrigger[], botSlug: string, view: MessageView): RoutedTrigger | null {
  const inSource = (trigger: BotTrigger): boolean => {
    const source = 'source' in trigger ? trigger.source : undefined;
    return (
      source === undefined || source.channels.some((ref) => ref.slice(1).toLowerCase() === view.channelName.toLowerCase())
    );
  };
  const has = (type: BotTrigger['type']): BotTrigger | undefined => triggers.find((t) => t.type === type);

  if (has('conversation') && view.isBotChannel) return 'conversation';
  const mention = has('mention');
  if (mention && view.mentions.has(botSlug.toLowerCase()) && inSource(mention)) return 'mention';
  const channelMessage = has('channel_message');
  if (channelMessage && inSource(channelMessage)) return 'channel_message';
  return null;
}

/**
 * The `@handles` a body names, lowercased — read with the composer's own parser, so a handle inside a code span, a fence, a
 * URL or an email names nobody here either, and a mention the composer would link is a mention that routes. A bot's slug
 * (letters, digits, `.`, `_`, `-`) is exactly what that parser accepts.
 */
export function mentionedHandles(body: string): Set<string> {
  return new Set(parseMarkup(body).mentions.map((m) => m.handle.toLowerCase()));
}

/** What the run is asked, in one prompt: who said it, where, and the message itself. The bot's behaviour is SOUL.md's job. */
export function buildPrompt(input: { authorName: string; channelName: string; body: string }): string {
  return `${input.authorName} in #${input.channelName}:\n\n${input.body}`;
}

const RunPayload = z.strictObject({
  workspaceId: z.uuid(),
  botId: z.uuid(),
  teamId: z.uuid(),
  channelId: z.uuid(),
  trigger: z.enum(['conversation', 'mention', 'channel_message']),
  askerActorId: z.uuid().nullable(),
  /** Where the reply goes: the thread root when the message is inside one, else the message itself (the reply opens the thread). */
  replyRootId: z.uuid(),
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
  /** Marks the payload stored with a gate hold, so that approving it resumes the run past the gate (not past the DLP check). */
  gateHold: z.literal(true).optional(),
});
export type RunPayload = z.infer<typeof RunPayload>;

interface MessageRow {
  id: string;
  body: string;
  channel_id: string;
  thread_root_id: string | null;
  author_id: string;
  channel_name: string;
  channel_team: string | null;
  channel_private: boolean;
  channel_archived: Date | null;
  channel_bot_id: string | null;
  author_kind: string;
  author_name: string;
  [key: string]: unknown;
}

interface BotRow {
  id: string;
  slug: string;
  runtime: string;
  triggers: BotTrigger[] | null;
  [key: string]: unknown;
}

/** The one subscription: decide, then enqueue one run per bot that the message fires. Runs in the outbox's system transaction. */
export function registerRouter(ctx: PluginContext): void {
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelMessagePostedEvent.parse(raw);
    const message = (
      await tx.query<MessageRow>(
        `SELECT m.id, m.body, m.channel_id, m.thread_root_id, m.author_id,
                c.name AS channel_name, c.team_id AS channel_team, c.private AS channel_private,
                c.archived_at AS channel_archived, c.bot_id AS channel_bot_id,
                a.kind AS author_kind, coalesce(p.display_name, b.name, 'someone') AS author_name
           FROM app.messages m
           JOIN app.channels c ON c.id = m.channel_id
           JOIN app.actors a ON a.id = m.author_id
           LEFT JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person'
           LEFT JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot'
          WHERE m.id = $1`,
        [event.messageId],
      )
    ).rows[0];
    if (!message) return;
    // No bot answers a bot (delegation is P6), no bot runs from a private channel or a DM (SPEC §12), none from an archived
    // channel, and a message whose author is gone has nobody to answer.
    if (message.author_kind !== 'person') return;
    if (message.channel_team === null || message.channel_private || message.channel_archived !== null) return;

    const view: MessageView = {
      channelName: message.channel_name,
      isBotChannel: false,
      mentions: mentionedHandles(message.body),
    };
    const bots = (
      await tx.query<BotRow>(
        `SELECT id, slug, runtime, triggers FROM app.bots WHERE team_id = $1 AND status = 'active' ORDER BY slug`,
        [message.channel_team],
      )
    ).rows;
    for (const bot of bots) {
      const trigger = matchTrigger(bot.triggers ?? [], bot.slug, {
        ...view,
        isBotChannel: message.channel_bot_id === bot.id,
      });
      if (trigger === null) continue;
      const payload: RunPayload = {
        workspaceId: event.workspaceId,
        botId: bot.id,
        teamId: message.channel_team,
        channelId: message.channel_id,
        trigger,
        askerActorId: message.author_id,
        replyRootId: message.thread_root_id ?? message.id,
        runThreadId: message.thread_root_id,
        prompt: buildPrompt({ authorName: message.author_name, channelName: message.channel_name, body: message.body }),
        text: message.body.slice(0, 40_000),
      };
      await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:${message.id}` });
    }
  });
}

/** The LLM gateway door, structurally: `gateway-llm` registers it, and a plugin cannot import another plugin's types. */
interface LlmDoor {
  id: string;
  [member: string]: unknown;
  botKey(tx: PluginTx, botId: string): Promise<string | null>;
  /** The completion the gate's classifier makes (P5-11). */
  complete: ClassifierDoor['complete'];
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
interface RepoDoor {
  id: string;
  [member: string]: unknown;
  blob(tx: PluginTx, teamId: string, path: string, ref: string, maxBytes?: number): Promise<{ content: Uint8Array }>;
}

interface RunBotRow {
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

/**
 * What the broker must know beyond the capability's name: the repo path(s) the call itself names. A mutation (`files.*`,
 * `pages.write`) is judged on the path its own arguments name — the same path the handler would write — and a call that
 * names none is refused rather than judged blind. The MCP gateway has the same rule at its own door
 * (gateway-mcp/src/catalog.ts, `authorizeContext`); a runtime's direct call needs it for the same reason.
 */
function authorizeContext(input: Record<string, unknown>): CapabilityAuthorizeContext {
  const path = input['path'];
  const paths = input['paths'];
  return {
    ...(typeof path === 'string' ? { path } : {}),
    ...(Array.isArray(paths) && paths.every((p): p is string => typeof p === 'string') ? { paths } : {}),
  };
}

/** Thrown by a run's own scope when a call it made was turned into a pending approval: the run ends `stopped`, it did not fail. */
class ApprovalPending extends Error {
  constructor(readonly capability: string) {
    super(`"${capability}" is waiting for a person's approval`);
    this.name = 'ApprovalPending';
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The model call a DLP hold stopped becomes a pending approval (source `dlp`, tool `llm.call`). What an approver sees is the rule names and the
 * **redacted** text; the original prompt travels only in the row's `resume`, and comes back to this plugin when the approval is approved
 * (`registerApprovalResume`). Without the approvals plugin the hold is a refusal: the call never leaves.
 */
async function holdForApproval(
  ctx: PluginContext,
  tx: PluginTx,
  held: { run: { runId: string }; payload: RunPayload; alias: string; rules: readonly string[]; excerpt: string; approvers: readonly string[] },
): Promise<boolean> {
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (!approvals) return false; // fail closed: the call is held and nobody can release it; the caller stops the run either way
  const resumable: Record<string, unknown> = { ...held.payload };
  delete resumable['approvalId']; // a held call has no approval yet; the claim adds the one that approves it
  try {
    await approvals.request(tx, {
    runId: held.run.runId,
    source: 'dlp',
    tool: 'llm.call',
    summary: clip(`Model call held · ${held.rules.join(', ')} found in the message`, 280),
    argsPreview: { alias: held.alias, rules: [...held.rules], message: clip(held.excerpt, 1500) },
    resume: { kind: 'handoff', payload: resumable },
    approvers: held.approvers,
    });
    return true;
  } catch (err) {
    // a private conversation where nobody else could decide it: not filed, so the call stays held and the run stops with the reason logged
    if (err instanceof NoEligibleApproverError) return false;
    throw err;
  }
}

/**
 * What an approver may read of a message the gate held: the message through the `pre_egress` chain under the `standard` rule, so a secret in it is
 * shown as `[redacted:api-key]`. With no guardrail loaded the text is not shown at all: a preview that cannot be made safe is left out.
 */
async function previewText(ctx: PluginContext, tx: PluginTx, workspaceId: string, text: string): Promise<string> {
  const chain = await ctx.hooks.runPreEgress(tx, { destination: 'approval', workspaceId, text, preset: 'standard' });
  return chain.hooks > 0 && chain.outcome !== 'block' ? chain.text : '[the message is not shown: it could not be checked for secrets]';
}

/**
 * A message the gate stopped becomes a pending approval (source `dlp` — "held by the guard" — tool `llm.gate`; the closest of the four sources
 * SPEC §7.3 names: the gate is the bot's own Guard section deciding that a model call waits for a person, as the DLP hold is). The approver sees
 * the stage, the gate entry that matched (when one did) and the redacted message; the payload that resumes the run travels only in the row's
 * `resume`. Approving puts the run back with the gate switched off for exactly that message. Without the approvals plugin the hold is a
 * refusal: the message never reaches a model.
 */
async function holdForGate(
  ctx: PluginContext,
  tx: PluginTx,
  held: { run: { runId: string }; payload: RunPayload; hold: Extract<GateVerdict, { kind: 'hold' }>; excerpt: string; approvers: readonly string[] },
): Promise<string | null> {
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (!approvals) return null; // fail closed: nobody can release it; the caller stops the run either way
  const resumable: Record<string, unknown> = { ...held.payload, gateHold: true };
  delete resumable['approvalId'];
  delete resumable['gateApprovalId'];
  const why =
    held.hold.stage === 'classifier_unavailable'
      ? 'the gate could not check this message'
      : held.hold.entry !== null
        ? `matched “${clip(held.hold.entry, 60)}”`
        : 'the local classifier flagged a gate topic';
  try {
    const filed = await approvals.request(tx, {
      runId: held.run.runId,
      source: 'dlp',
      tool: 'llm.gate',
      summary: clip(`Message held by the gate · ${why}`, 280),
      argsPreview: {
        stage: held.hold.stage,
        ...(held.hold.entry !== null ? { entry: clip(held.hold.entry, 200) } : {}),
        reason: clip(held.hold.detail, 300),
        message: clip(held.excerpt, 1500),
      },
      resume: { kind: 'handoff', payload: resumable },
      approvers: held.approvers,
    });
    return filed.approvalId;
  } catch (err) {
    // a private conversation where nobody else could decide it: not filed, so the message stays held and the run stops with the reason logged
    if (err instanceof NoEligibleApproverError) return null;
    throw err;
  }
}

/**
 * Takes a held model call back once a person approves it: the `approvals.approval.decided` event (an outbox consumer, so a system transaction)
 * claims the stored payload — once; a replayed event gets nothing — and puts the run on its queue again with the approval's id, which makes
 * the next pre-call check let that one finding through as written.
 */
export function registerApprovalResume(ctx: PluginContext): void {
  ctx.events.subscribe('approvals.approval.decided', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ApprovalsApprovalDecidedEvent.parse(raw);
    if (event.decision !== 'approved' || event.source !== 'dlp' || event.botId === null) return;
    const approvals = ctx.providers.get<ApprovalProvider>('approvals');
    if (!approvals) return;
    const payload = await approvals.claim(tx, event.approvalId, { botId: event.botId, source: 'dlp' });
    if (!payload) return;
    // A gate hold resumes past the gate only; a DLP hold resumes past the DLP check only. The two are different questions a person answered.
    const { gateHold, ...rest } = payload;
    const parsed = RunPayload.safeParse(gateHold === true ? { ...rest, gateApprovalId: event.approvalId } : { ...rest, approvalId: event.approvalId });
    if (!parsed.success) return;
    await ctx.jobs.enqueue(tx, RUN_QUEUE, parsed.data, { dedupeKey: `runtime-hermes:approval:${event.approvalId}` });
  });
}

/** Run one bot: the job half of P5-10. Everything it needs is re-read from the database and the repo (a payload is whatever was enqueued). */
export function registerRunJob(ctx: PluginContext): void {
  ctx.jobs.register(RUN_QUEUE, async (raw, tx, job) => {
    const payload = RunPayload.parse(raw);
    const bot = (
      await tx.query<RunBotRow>(
        `SELECT id, slug, name, runtime, definition_sha, team_id, workspace_id, status
           FROM app.bots WHERE id = $1 AND workspace_id = $2`,
        [payload.botId, payload.workspaceId],
      )
    ).rows[0];
    if (!bot || bot.status !== 'active') return; // a disabled, invalid or removed bot does not answer
    if (bot.team_id !== payload.teamId) return;

    const provider = ctx.providers.get<BotRuntimeProvider>('bot_runtime', bot.runtime);
    if (!provider) {
      job.log.warn(`runtime-hermes: no bot_runtime provider is loaded for "${bot.runtime}" (bot ${bot.slug})`);
      return;
    }

    // The definition the run executes: the file the loader last loaded, read from the repo. A row whose file has moved on (a
    // commit in flight) is refused rather than run on a definition the roster never showed.
    const repo = ctx.providers.get<RepoDoor>('repo');
    if (!repo) throw new Error('runtime-hermes: the repo provider is not registered');
    const file = await repo.blob(tx, bot.team_id, botMdPath(bot.slug), 'main');
    const contents = Buffer.from(file.content).toString('utf8');
    if (createHash('sha256').update(file.content).digest('hex') !== bot.definition_sha) {
      job.log.warn(`runtime-hermes: bot ${bot.slug} has a newer BOT.md in the repo than the loaded definition; no run`);
      return;
    }
    const parsed = parseBotMd(contents);
    if (!parsed.ok) {
      job.log.warn(`runtime-hermes: the loaded definition of ${bot.slug} no longer parses (${parsed.failure.message}); no run`);
      return;
    }
    const alias = parsed.frontmatter.model?.aliases?.[0] ?? null;
    const holdOnDetection = parsed.frontmatter.guard?.rules?.includes(GUARD_RULE_DLP_APPROVAL) ?? false;
    const approvers = parsed.frontmatter.approvals?.approvers ?? [];

    // The token outlives the run's own budget (plus the kill grace): a run whose token expired mid-turn would lose its tools
    // for the rest of the turn. The kernel clamps this to its maximum.
    const ttlSeconds = (parsed.frontmatter.limits?.timeoutSeconds ?? DEFAULT_RUN_BUDGET_SECONDS) + RUN_TOKEN_SLACK_SECONDS;
    let opened: Awaited<ReturnType<PluginContext['runs']['open']>>;
    try {
      opened = await ctx.runs.open({
        botId: bot.id,
        teamId: bot.team_id,
        workspaceId: bot.workspace_id,
        trigger: payload.trigger,
        askerActorId: payload.askerActorId,
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
      return;
    }
    const { run, token } = opened;

    let toolCalls = 0;
    let handle: BotRuntimeHandle | undefined;
    try {
      // The gate (SPEC §7.3, P5-11): before anything is sent to a model, a bot with a `guard.gate` list checks the message against it — the list
      // first, then the local classifier. A hit holds the message for a person and stops the run (`stopped`); the model is never called. A run
      // a person already released (past the gate or past the DLP check, which comes after it) is not asked again. A runtime with no model has
      // nothing to gate.
      const gateEntries = parsed.frontmatter.guard?.gate;
      if (provider.usesGateway && hasGate(gateEntries) && payload.approvalId === undefined && payload.gateApprovalId === undefined) {
        const text = payload.text ?? payload.prompt;
        const verdict = await runGate(tx, {
          entries: gateEntries,
          text,
          run: { workspaceId: bot.workspace_id, botId: bot.id, teamId: bot.team_id, runId: run.runId },
          llm: ctx.providers.get<LlmDoor>('llm'),
        });
        if (verdict.kind === 'refused') {
          job.log.warn(`runtime-hermes: run ${run.runId} refused at the gate: ${verdict.detail}`);
          await ctx.runs.close(run.runId, 'stopped');
          return;
        }
        if (verdict.kind === 'hold') {
          const approvalId = await holdForGate(ctx, tx, {
            run,
            payload,
            hold: verdict,
            excerpt: await previewText(ctx, tx, bot.workspace_id, text),
            approvers,
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
          job.log.info(
            approvalId !== null
              ? `runtime-hermes: run ${run.runId} stopped at the gate (${verdict.stage}): waiting for an approval`
              : `runtime-hermes: run ${run.runId} refused at the gate (${verdict.stage}): held, and nobody could be asked`,
          );
          await ctx.runs.close(run.runId, 'stopped');
          return;
        }
      }

      // A runtime that talks to a model is handed the gateway, the bot's own virtual key, and the pre-call check (preset, DLP
      // hook, budgets, rate limits) that P5-07 puts in front of every call: a refusal stops the run before anything is sent,
      // and a redaction rewrites the prompt that is. A runtime with no model (`rules`) gets none of it and is never refused for
      // lacking one. What a Hermes run lacks (no alias, no gateway URL) is reported by the provider's own profile render.
      const gatewayBase = (process.env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
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
            job.log.info(
              filed
                ? `runtime-hermes: run ${run.runId} stopped before the call: waiting for an approval`
                : `runtime-hermes: run ${run.runId} refused before the call: held for approval, and the approvals plugin is not loaded`,
            );
            await ctx.runs.close(run.runId, 'stopped');
            return;
          }
          if (!decision.allowed) {
            job.log.warn(`runtime-hermes: run ${run.runId} refused before the call: ${decision.message ?? 'not allowed'}`);
            await ctx.runs.close(run.runId, 'stopped');
            return;
          }
          prompt = decision.text; // the redacted text when the hook rewrote it; the prompt itself otherwise
        }
      }

      const input: BotRuntimeInput = {
        bot: {
          id: bot.id,
          slug: bot.slug,
          name: bot.name,
          teamId: bot.team_id,
          workspaceId: bot.workspace_id,
          runtime: bot.runtime,
          definitionSha: bot.definition_sha,
        },
        definition: { frontmatter: parsed.frontmatter, body: parsed.body },
        trigger: payload.trigger,
        asker: payload.askerActorId === null ? null : { actorId: payload.askerActorId, personId: null, displayName: null },
        prompt,
        thread: { channelId: payload.channelId, threadRootId: payload.replyRootId },
        // The URL names the run and carries no credential (a URL is logged by proxies and access logs); the token travels as a
        // bearer header, which the rendered profile sets.
        endpoint: { runId: run.runId, url: `${ctx.runtime.publicUrl}/api/mcp/runs/${run.runId}`, token },
        gateway: provider.usesGateway && gatewayBase !== '' ? { baseUrl: gatewayBase, key } : null,
        // SPEC §7.1's limits: a run's own wall clock. The definition schema has no turn count, so none is passed.
        limits: { runBudgetSeconds: parsed.frontmatter.limits?.timeoutSeconds ?? null, maxTurns: null, sessionMinutes: parsed.frontmatter.limits?.sessionMinutes ?? null },
      };

      // The scope a provider gets is the run's own authority, and the broker decides every call it makes: the runtime
      // implements what a model chose, so a call it makes is exactly as constrained as one made over the run's MCP
      // endpoint. Without this the allowlist compiled from `capabilities.native` would be a promise the platform keeps at
      // one door and forgets at the other.
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
        log: (line) => job.log.info(line),
      };

      handle = await provider.run(input, scope);

      let reply = '';
      let ok = false;
      for await (const event of handle.events) {
        if (event.type === 'tool') toolCalls += 1;
        if (event.type !== 'result') continue;
        reply = event.text;
        ok = event.ok;
        if (event.tokens) job.log.info(`runtime-hermes: run ${run.runId} used ${event.tokens.total} tokens over ${toolCalls} tool calls`);
        if (!event.ok) job.log.warn(`runtime-hermes: run ${run.runId} failed: ${event.error ?? 'no reason given'}`);
      }
      await handle.stop();

      // The reply is a message like any other: posted through the channels plugin's own `messages.post`, as the run's bot,
      // and authorized like every other call the run makes — a definition that never asked for `messages.post` cannot post.
      // A failed run posts nothing: the text a dying process managed to print is a fragment, not an answer.
      if (ok && reply.trim() !== '') {
        await scope.invoke('messages.post', {
          channelId: payload.channelId,
          body: reply,
          threadRootId: payload.replyRootId,
        });
      }
      // A run that asked for an approval (a model's tool call over the MCP endpoint, say) ended at that question: `stopped`, not `done`.
      const approvals = ctx.providers.get<ApprovalProvider>('approvals');
      const waiting = approvals ? await approvals.pendingForRun(tx, run.runId) : 0;
      await ctx.runs.close(run.runId, waiting > 0 ? 'stopped' : ok ? 'done' : 'failed');
    } catch (err) {
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
      await ctx.runs.close(run.runId, 'failed');
    }
  });
}
