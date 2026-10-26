import { createHash } from 'node:crypto';
import { BotRunTrigger, approvalSummary, previewArgsDetailed, type ApprovalResume, type ApprovalSource } from '@manythreads/shared';
import { RunEndedError, type BotRunHandle, type CapabilityAuthorizeContext, type PluginContext, type PluginTx, type ProviderImpl } from './types.ts';

// The one handler for `needsApproval` (SPEC §7.3; PLAN P5-20): `ctx.providers.get<ApprovalProvider>('approvals')`, registered by the approvals
// plugin. A call that must wait for a person — whichever of the four sources says so (an Environment with `protected: true`, `dispatch: strict`,
// the DLP `require_approval` outcome, the grant's own flag) — asks for an approval here instead of writing rows of its own. Look it up when a
// request arrives, not in `register` (the approvals plugin may load after you).

/** What a caller gives the handler. The bot, the team, the person who asked and the thread the run answers in are read from the run itself. */
export interface ApprovalRequestInput {
  /** The run that is stopping. */
  runId: string;
  /** Which of the four sources set `needsApproval` (see `approvalSourceFor` in `@manythreads/shared`). */
  source: ApprovalSource;
  /** The capability that waits (`email.send`); `llm.call` for the model call a DLP hold stopped. */
  tool: string;
  /** One line for the Approvals inbox: what is being asked, in words. */
  summary: string;
  /** What an approver is shown of the call: build it with `previewArgs` (clipped, secrets hidden), never the raw arguments. */
  argsPreview: Record<string, unknown>;
  /** The preview left something out: the card says so and the people who may decide can open the full call. */
  argsTruncated?: boolean;
  /** What approving does: re-run the tool call (`tool`, done by the approvals plugin) or hand `payload` back to the caller (`handoff`, see `claim`). */
  resume: ApprovalResume;
  /** `role:<tag>` / `person:<id>` principals; omitted means the bot's own `approvals.approvers`, and empty means the team's leads. */
  approvers?: readonly string[];
  /** Asking twice for the same pending thing returns the first approval (a model that retries a call must not fill the inbox). */
  dedupeKey?: string;
}

export interface ApprovalRequestResult {
  approvalId: string;
  /** False when `dedupeKey` matched a pending approval of the same bot: nothing new was written. */
  created: boolean;
  /** Who can see and decide it: `team` (the team's Approvals inbox) or `conversation` (only the people who can read the private channel, DM or bot conversation the run answered in). */
  visibleTo: 'team' | 'conversation';
}

/**
 * Thrown by `request` when the run answered in a private conversation and nobody in it but the requester could decide the call: filing it would
 * make an approval that is undecidable and invisible to everyone who could help. The message says why, for the caller to pass on.
 */
export class NoEligibleApproverError extends Error {
  constructor(message = 'Nobody but you could decide this call in this conversation: no one else who can read it is allowed to approve it. Ask a lead to name an approver who is in this conversation.') {
    super(message);
    this.name = 'NoEligibleApproverError';
  }
}

/** What `requestToolApproval` answers when the approval could not be filed for a reason the caller should say. */
export interface ApprovalRefusal {
  refused: string;
}

export interface ApprovalProvider extends ProviderImpl {
  id: string;
  /**
   * Writes a pending approval for the run and tells the team (an `approvals.approval.requested` event and a live push). Runs in the
   * run's own transaction (`ctx.runs.asBot`) or in a system one (a job); the database refuses it from anyone but the run's bot or the
   * system, and from a run of another bot.
   */
  request(tx: PluginTx, input: ApprovalRequestInput): Promise<ApprovalRequestResult>;
  /** How many approvals this run is waiting on. A run with any ends `stopped`, not `done`. */
  pendingForRun(tx: PluginTx, runId: string): Promise<number>;
  /**
   * For the plugin that asked with a `handoff`: when an approved `source` approval of this bot is waiting to be taken back (the
   * `approvals.approval.decided` event says so), answers the payload it stored — exactly once. A replayed event finds it spent and gets
   * null. System transaction only (an event consumer's own); anything else gets null.
   */
  claim(tx: PluginTx, approvalId: string, expect: { botId: string; source: ApprovalSource }): Promise<Record<string, unknown> | null>;
}

/** Arguments in a stable text form (keys sorted), so the same call always has the same key. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(record[k])}`)
    .join(',')}}`;
}

/** The one key for "this tool with these arguments": asking twice is one approval per asker (the database scopes it by bot and asker). */
export const approvalDedupeKey = (tool: string, input: Record<string, unknown>): string =>
  createHash('sha256').update(`${tool}\n${stable(input)}`).digest('hex');

/**
 * What the broker must know beyond the capability's name: the repo path(s) the call itself names. A mutation (`files.*`,
 * `pages.write`) is judged on the path its own arguments name — the same path the handler would write — and a call that
 * names none is refused rather than judged blind. The one shared copy (previously duplicated in runtime-hermes, approvals
 * and gateway-mcp with identical bodies): a runtime's direct call, an approval resume and the MCP gateway door all need it
 * for the same reason.
 */
export function authorizeContext(input: Record<string, unknown>): CapabilityAuthorizeContext {
  const path = input['path'];
  const paths = input['paths'];
  return {
    ...(typeof path === 'string' ? { path } : {}),
    ...(Array.isArray(paths) && paths.every((p): p is string => typeof p === 'string') ? { paths } : {}),
  };
}

/**
 * Capabilities that can never wait for an approval. An approved call is re-run later in a NEW run that has none of the first run's context (no
 * source log, perhaps no thread): a capability whose safety depends on what the run read — `memory.retain` stores caller-supplied text in the team's
 * memory and is refused for a run that read anything private — would be decided blind, and a person approving "remember this" is not checking where the
 * text came from. So they are never filed (`requestToolApproval` refuses) and never resumed (the approvals plugin refuses too).
 */
export const NEVER_APPROVAL_GATED: readonly string[] = ['memory.retain'];

export const neverApprovalGatedReason = (tool: string): string =>
  `“${tool}” cannot wait for an approval: it is refused for a run that read anything private, and an approved call runs later without that history. Ask a lead to remove needsApproval from it.`;

/**
 * Thrown by an `ApprovalProvider.request` for a tool in `NEVER_APPROVAL_GATED`: the provider itself refuses, so a caller that did not go through
 * `requestToolApproval` (or a second implementation of the helper) cannot file one either. The message is `neverApprovalGatedReason`, for the caller to pass on.
 */
export class NeverApprovalGatedError extends Error {
  readonly tool: string;
  constructor(tool: string) {
    super(neverApprovalGatedReason(tool));
    this.name = 'NeverApprovalGatedError';
    this.tool = tool;
  }
}

/**
 * The `grant` source's one call (the MCP gateway, the Hermes runtime's own scope): file an approval for a tool call the run made, in the run's own
 * transaction as its bot, with the preview, summary, resume and dedupe key built the one way. Answers null when the approvals plugin is not loaded —
 * the caller then fails closed — and `{ refused }` when the run is in a private conversation and nobody else in it could decide (see `NoEligibleApproverError`), because running a call the grant says a person must approve is the one thing the flag exists to stop.
 *
 * Only for tools that act (a write): a read would be re-run as the bot, not as the person whose visibility it was asked under, so a read never
 * waits for approval — the caller refuses it instead.
 */
export async function requestToolApproval(
  ctx: Pick<PluginContext, 'providers' | 'runs'>,
  run: BotRunHandle,
  tool: string,
  input: Record<string, unknown>,
  options: { approvers?: readonly string[] } = {},
): Promise<ApprovalRequestResult | ApprovalRefusal | null> {
  if (NEVER_APPROVAL_GATED.includes(tool)) return { refused: neverApprovalGatedReason(tool) };
  const approvals = ctx.providers.get<ApprovalProvider>('approvals');
  if (!approvals) return null;
  // The approval row keeps the call's arguments to run it later: a secret handed over with a call must not be filed in it.
  if (Object.keys(input).some((k) => /^private[_-]?note$/i.test(k))) {
    return { refused: 'This call carries a private note, which cannot wait in an approval. Make the call without the private note, or have a person do the step.' };
  }
  const { preview, truncated } = previewArgsDetailed(input);
  try {
    return await ctx.runs.asBot(run, (tx) =>
      approvals.request(tx, {
        runId: run.runId,
        source: 'grant',
        tool,
        summary: approvalSummary(tool, input),
        argsPreview: preview,
        argsTruncated: truncated,
        resume: { kind: 'tool', capability: tool, args: input, trigger: BotRunTrigger.parse(run.trigger) },
        ...(options.approvers ? { approvers: options.approvers } : {}),
        dedupeKey: approvalDedupeKey(tool, input),
      }),
    );
  } catch (err) {
    if (err instanceof NoEligibleApproverError || err instanceof NeverApprovalGatedError) return { refused: err.message };
    // The run was ended between the caller's check and this call (the reaper, a close): the model is told, the caller does not see an exception
    if (err instanceof RunEndedError) return { refused: 'This run has ended, so the call cannot wait for an approval; start a new run.' };
    throw err;
  }
}
