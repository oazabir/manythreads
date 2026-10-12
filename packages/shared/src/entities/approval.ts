import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ApprovalId, BotId, ChannelId, MessageId, TeamId, WorkspaceId } from '../ids.ts';
import { BotRunTrigger } from './bot.ts';
import { JsonObject } from './kernel.ts';

// Approvals (PLAN.md A.5, P5-20; SPEC §7.3): the one mechanism by which a tool call (or a model call) waits for a person. Every enum here
// matches a CHECK of the approvals plugin's migration 0001_approvals.sql, and the enum columns are listed in the kernel's schema-enums map.

/**
 * Why a call is waiting. One mechanism, four ways of setting it (SPEC §7.3): an Environment with `protected: true`, `dispatch: strict`
 * in TEAM.md, the DLP `require_approval` outcome (SPEC §15) and the per-grant `needsApproval` flag (the base mechanism).
 */
export const ApprovalSource = z.enum(['environment', 'dispatch', 'dlp', 'grant']);
export type ApprovalSource = z.infer<typeof ApprovalSource>;

/** `pending` until a person decides (or it lapses: `expired`); `approved`, `denied` and `expired` are final. */
export const ApprovalStatus = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/**
 * What became of an approved call. `none`: nothing to do (still pending, or denied); `queued`: approved, the stopped action is
 * waiting for its job; `running`: the job claimed it and is making the call (a crash here leaves this state, and the sweep turns it into
 * `failed`: the call may or may not have happened); `ran`: it ran; `failed`: it was approved but could not run (the grant is gone, the tool refused).
 */
export const ApprovalOutcome = z.enum(['none', 'queued', 'running', 'ran', 'failed']);
export type ApprovalOutcome = z.infer<typeof ApprovalOutcome>;

/** What the stored resume is, readable without the call's arguments (`approvals.resume_kind`, generated from the `resume` document). */
export const ApprovalResumeKind = z.enum(['tool', 'handoff']);
export type ApprovalResumeKind = z.infer<typeof ApprovalResumeKind>;

export const ApprovalDecisionKind = z.enum(['approved', 'denied']);
export type ApprovalDecisionKind = z.infer<typeof ApprovalDecisionKind>;

/** How long a pending approval waits before it lapses (the column default of `approvals.expires_at`). */
export const APPROVAL_TTL_DAYS = 7;

/** How long an approved call may stay `queued` or `running` before the sweep calls it `failed` (and the card stops waiting for it). */
export const APPROVAL_RUN_TIMEOUT_MINUTES = 15;

/** The default order the four sources are tried in (see `approvalSourceFor`). */
export const APPROVAL_SOURCES_BY_PRECEDENCE: readonly ApprovalSource[] = ['environment', 'dispatch', 'dlp', 'grant'];

/**
 * The single question every caller asks: does this call wait, and which of the four sources says so? Environment and dispatch are set by
 * phase 6 (the caller passes what it knows; absent means "not asked"), DLP and the grant by the gateways today. The first that applies
 * names the approval, so a call that is both protected and flagged is one approval, not two.
 */
export function approvalSourceFor(flags: {
  environmentProtected?: boolean;
  dispatchStrict?: boolean;
  dlpRequiresApproval?: boolean;
  grantNeedsApproval?: boolean;
}): ApprovalSource | null {
  if (flags.environmentProtected === true) return 'environment';
  if (flags.dispatchStrict === true) return 'dispatch';
  if (flags.dlpRequiresApproval === true) return 'dlp';
  if (flags.grantNeedsApproval === true) return 'grant';
  return null;
}

/**
 * The bot-level rule (`guard.rules` in BOT.md) that turns a DLP detection into a pending approval instead of a redaction: the model call
 * waits for a person who sees what was found (rule names and a redacted excerpt, never the secret) and decides whether it may leave.
 */
export const GUARD_RULE_DLP_APPROVAL = 'dlp:require_approval';

/** Who may decide: holders of the role tags, the named people, and — when neither is listed — the team's leads and workspace admins. */
export const ApprovalApprovers = z.strictObject({
  roles: z.array(z.string().regex(/^role:[a-z][a-z0-9-]*$/)).max(20),
  people: z.array(z.uuid()).max(20),
  /** True when no role or person is named: the team's leads (and workspace owners and admins) decide. */
  leads: z.boolean(),
});
export type ApprovalApprovers = z.infer<typeof ApprovalApprovers>;

/** `role:on-call` and `person:<uuid>` principals (BOT.md `approvals.approvers`) as the scope a row stores. */
export function approversFromPrincipals(principals: readonly string[]): ApprovalApprovers {
  const roles: string[] = [];
  const people: string[] = [];
  for (const p of principals) {
    if (p.startsWith('role:') && !roles.includes(p)) roles.push(p);
    else if (p.startsWith('person:') && !people.includes(p.slice(7))) people.push(p.slice(7));
  }
  return ApprovalApprovers.parse({ roles, people, leads: roles.length === 0 && people.length === 0 });
}

/**
 * What approving does, kept on the row and never sent to a client (it may carry the call's real arguments). `tool`: re-run the stopped tool
 * call as its bot (the approvals plugin does it). `handoff`: the requesting plugin takes `payload` back when the approval is approved — the
 * model call a DLP hold stopped is re-queued by the runtime that stopped it, which alone knows how (`ApprovalProvider.claim`).
 */
export const ApprovalResume = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool'),
    capability: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
    args: z.record(z.string(), z.unknown()),
    /** The trigger of the run that was stopped; the re-run opens its run with the same one. */
    trigger: BotRunTrigger,
  }),
  z.strictObject({
    kind: z.literal('handoff'),
    payload: z.record(z.string(), z.unknown()),
  }),
]);
export type ApprovalResume = z.infer<typeof ApprovalResume>;

/** The decision on an approval, as a list shows it. */
export const ApprovalDecisionView = z.object({
  decision: ApprovalDecisionKind,
  deciderId: ActorId,
  deciderName: z.string(),
  note: z.string(),
  decidedAt: IsoDateTime,
});
export type ApprovalDecisionView = z.infer<typeof ApprovalDecisionView>;

/** Why the caller cannot decide an approval that is still pending (null when they can, or when it is no longer pending). */
export const ApprovalBlockReason = z.enum(['requester', 'not_approver']);
export type ApprovalBlockReason = z.infer<typeof ApprovalBlockReason>;

/** One approval as the Approvals inbox and the in-thread card read it. */
export const Approval = z.object({
  id: ApprovalId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  source: ApprovalSource,
  status: ApprovalStatus,
  outcome: ApprovalOutcome,
  /** Why an approved call did not run, in a sentence; empty otherwise. */
  outcomeDetail: z.string(),
  /** After this a pending approval lapses (`expired`) and can no longer be decided. */
  expiresAt: IsoDateTime,
  /** When the call was claimed, once an approved call is running. */
  startedAt: IsoDateTime.nullable(),
  /** The capability waiting (`email.send`), or `llm.call` for a model call a DLP hold stopped. */
  tool: z.string().min(1),
  /** One line for the list: what is being asked, in words. */
  summary: z.string().min(1),
  /** What the approver is shown of the call: clipped and redacted, never the raw arguments. */
  argsPreview: JsonObject,
  /** The preview left something out (a long value, a long list, a deep object): the people who may decide can open the full call. */
  argsTruncated: z.boolean(),
  botId: BotId.nullable(),
  botSlug: z.string().nullable(),
  botName: z.string().nullable(),
  /** The person who asked (the bot's asker); the bot itself when nobody did. Cannot decide their own request. */
  requesterId: ActorId,
  requesterName: z.string(),
  /** Where the stopped run answers, so the card can sit in that thread. */
  channelId: ChannelId.nullable(),
  threadRootId: MessageId.nullable(),
  approvers: ApprovalApprovers,
  /** Whether the caller may approve or deny it now, and if not, why. */
  canDecide: z.boolean(),
  blockReason: ApprovalBlockReason.nullable(),
  decision: ApprovalDecisionView.nullable(),
  createdAt: IsoDateTime,
});
export type Approval = z.infer<typeof Approval>;

const PREVIEW_MAX_KEYS = 20;
const PREVIEW_MAX_ITEMS = 10;
const PREVIEW_MAX_DEPTH = 3;
const PREVIEW_MAX_STRING = 300;
const SECRET_KEY = /secret|token|passw|api[_-]?key|authorization|credential|private[_-]?key|cookie/i;

type PreviewValue = string | number | boolean | null | PreviewValue[] | { [key: string]: PreviewValue };

/** Walks a value for the preview; `limits` off keeps everything but still hides secret-named keys (the approver's full view). */
function walk(value: unknown, depth: number, clipped: { hit: boolean }, limits: boolean): PreviewValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (limits && value.length > PREVIEW_MAX_STRING) {
      clipped.hit = true;
      return `${value.slice(0, PREVIEW_MAX_STRING)}…`;
    }
    return value;
  }
  if (limits && depth >= PREVIEW_MAX_DEPTH) {
    clipped.hit = true;
    return '[…]';
  }
  if (Array.isArray(value)) {
    const kept = limits ? value.slice(0, PREVIEW_MAX_ITEMS) : value;
    const items = kept.map((v) => walk(v, depth + 1, clipped, limits));
    if (kept.length < value.length) {
      clipped.hit = true;
      items.push(`… ${value.length - kept.length} more`);
    }
    return items;
  }
  if (typeof value === 'object') return walkRecord(value as Record<string, unknown>, depth + 1, clipped, limits);
  return null; // undefined, a function, a symbol, a bigint: nothing an approver can read
}

function walkRecord(record: Record<string, unknown>, depth: number, clipped: { hit: boolean }, limits: boolean): { [key: string]: PreviewValue } {
  const out: { [key: string]: PreviewValue } = {};
  let n = 0;
  for (const [key, value] of Object.entries(record)) {
    if (limits && n === PREVIEW_MAX_KEYS) {
      clipped.hit = true;
      out['…'] = `${Object.keys(record).length - PREVIEW_MAX_KEYS} more`;
      break;
    }
    out[key] = SECRET_KEY.test(key) ? '[hidden]' : walk(value, depth, clipped, limits);
    n += 1;
  }
  return out;
}

/**
 * What an approver is shown of a call's arguments: at most 20 keys, 10 list items, 3 levels of nesting and 300 characters a string, and the
 * value of any key that names a secret (`token`, `password`, `apiKey`, `authorization`, ...) replaced by `[hidden]`. `truncated` says that
 * something other than a secret was left out, so the card can say so and offer the full call. Linear in the size of what it keeps.
 */
export function previewArgsDetailed(args: Record<string, unknown>): { preview: JsonObject; truncated: boolean } {
  const clipped = { hit: false };
  const preview = walkRecord(args, 1, clipped, true);
  return { preview, truncated: clipped.hit };
}

export function previewArgs(args: Record<string, unknown>): JsonObject {
  return previewArgsDetailed(args).preview;
}

/** The whole call for the people who may decide it: nothing clipped, but a key that names a secret is still `[hidden]`. */
export function fullArgs(args: Record<string, unknown>): JsonObject {
  return walkRecord(args, 1, { hit: false }, false);
}

/** Keys whose value says what a call is about, tried in this order when the inbox line needs a hint (`email.send · reply to m.okafor`). */
const SUMMARY_HINT_KEYS = ['subject', 'title', 'path', 'name', 'to', 'query', 'body'] as const;

/** The one line the inbox shows for a tool call: the capability and, when the arguments name one, what it is about. */
export function approvalSummary(tool: string, args: Record<string, unknown>): string {
  for (const key of SUMMARY_HINT_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const line = value.trim().replace(/\s+/g, ' ');
      return `${tool} · ${line.length > 80 ? `${line.slice(0, 79)}…` : line}`;
    }
  }
  return tool;
}
