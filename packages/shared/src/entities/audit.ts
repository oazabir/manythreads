import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { AuditEventId } from '../ids.ts';

// The audit console (PLAN P10-05): one row per thing that was done, answering who did what, when, to what, and what was held back. A row is
// content-blind: it names people, bots, teams and things by id and short name and never carries a message, a file's contents, a secret or a
// memory's text.

/** Who did it: a person, a bot, or the system itself (a background job, or the platform acting on its own). */
export const AuditActorKind = z.enum(['person', 'bot', 'system']);
export type AuditActorKind = z.infer<typeof AuditActorKind>;

/**
 * How it ended. `ok` it happened; `denied` somebody or something was refused (a wrong password, a tool call turned down, a proposal rejected);
 * `failed` it was tried and broke; `withheld` the platform held something back on purpose (a guardrail redacted or blocked text, a memory was not
 * kept because its source was private, a citation was dropped from an answer).
 */
export const AuditOutcome = z.enum(['ok', 'denied', 'failed', 'withheld']);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/** The group a row belongs to; the filter bar offers these. */
export const AuditCategory = z.enum(['sign_in', 'people', 'content', 'bots', 'approvals', 'guardrails', 'memory', 'access', 'settings', 'system']);
export type AuditCategory = z.infer<typeof AuditCategory>;

/** Where a row was made from: the event log, or the memory plugin's own log of what it kept and what it held back. */
export const AuditSource = z.enum(['event', 'memory_retain_log']);
export type AuditSource = z.infer<typeof AuditSource>;

/** A row's action, e.g. `proposal.applied`: lower-case words and dots. */
export const AuditAction = z.string().regex(/^[a-z_]+(\.[a-z_]+){1,3}$/).max(80);
export type AuditAction = z.infer<typeof AuditAction>;

/** One row of the console. */
export const AuditEntry = z.object({
  /** The id of the event (or memory log line) it was made from. */
  id: AuditEventId,
  occurredAt: IsoDateTime,
  actor: z.object({
    /** Null when the system acted on its own, or when the actor could not be told (a failed sign-in with an unknown address). */
    id: z.uuid().nullable(),
    kind: AuditActorKind,
    /** The name as it was when the row was written, so a renamed or removed person is still readable. */
    name: z.string().max(200),
  }),
  category: AuditCategory,
  action: AuditAction,
  /** What it was done to: a kind such as `proposal` or `person`, its id, and a short name when there is one. */
  target: z.object({
    kind: z.string().regex(/^[a-z_]{1,40}$/).nullable(),
    id: z.string().max(80).nullable(),
    label: z.string().max(200).nullable(),
  }),
  team: z.object({ id: z.uuid(), name: z.string().max(200) }).nullable(),
  outcome: AuditOutcome,
  /** A short plain-language reason or count, from a fixed set of phrases. Never text a person wrote. */
  reason: z.string().max(200).nullable(),
  source: AuditSource,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/**
 * Every action the console can show, with its group and the plain words for it. Kept in one place so the server (which writes the rows), the
 * filter bar and the table read the same list; an action not listed here is shown by its raw name.
 */
export const AUDIT_ACTIONS = {
  'sign_in.succeeded': { category: 'sign_in', label: 'Signed in' },
  'sign_in.failed': { category: 'sign_in', label: 'Failed to sign in' },
  'sign_in.signed_out': { category: 'sign_in', label: 'Signed out' },
  'sign_in.single_sign_on': { category: 'sign_in', label: 'Signed in with single sign-on' },
  'sign_in.single_sign_on_refused': { category: 'sign_in', label: 'Single sign-on refused' },
  'sign_in.workspace_created': { category: 'sign_in', label: 'Created the workspace' },
  'password.changed': { category: 'sign_in', label: 'Changed a password' },
  'password.reset': { category: 'sign_in', label: 'Reset a password' },
  'password.set_by_admin': { category: 'sign_in', label: 'Set a password for someone' },
  'sign_in_method.changed': { category: 'settings', label: 'Changed a sign-in method' },
  'member.role_changed': { category: 'people', label: 'Changed a workspace role' },
  'invitation.created': { category: 'people', label: 'Invited someone' },
  'invitation.accepted': { category: 'people', label: 'Accepted an invitation' },
  'team.created': { category: 'people', label: 'Created a team' },
  'team.renamed': { category: 'people', label: 'Renamed a team' },
  'team.archived': { category: 'people', label: 'Archived a team' },
  'team.unarchived': { category: 'people', label: 'Restored a team' },
  'team.member_added': { category: 'people', label: 'Added someone to a team' },
  'team.member_removed': { category: 'people', label: 'Removed someone from a team' },
  'team.role_changed': { category: 'people', label: 'Changed a team role' },
  'workspace.settings_updated': { category: 'settings', label: 'Changed workspace settings' },
  'proposal.created': { category: 'content', label: 'Proposed a change' },
  'proposal.applied': { category: 'content', label: 'Applied a proposal' },
  'proposal.rejected': { category: 'content', label: 'Turned down a proposal' },
  'file.uploaded': { category: 'content', label: 'Uploaded a file' },
  'file.deleted': { category: 'content', label: 'Deleted a file' },
  'channel.created': { category: 'content', label: 'Created a channel' },
  'channel.archived': { category: 'content', label: 'Archived or restored a channel' },
  'channel.member_added': { category: 'content', label: 'Added someone to a channel' },
  'channel.member_removed': { category: 'content', label: 'Removed someone from a channel' },
  'message.deleted': { category: 'content', label: 'Deleted a message' },
  'approval.requested': { category: 'approvals', label: 'Asked for approval' },
  'approval.decided': { category: 'approvals', label: 'Decided an approval' },
  'approval.resumed': { category: 'approvals', label: 'Ran an approved action' },
  'bot.loaded': { category: 'bots', label: 'Loaded a bot definition' },
  'bot.removed': { category: 'bots', label: 'Removed a bot' },
  'bot.pairing_rotated': { category: 'bots', label: 'Reset a bot pairing' },
  'bot.key_changed': { category: 'bots', label: 'Changed a bot model key' },
  'runner.token_minted': { category: 'bots', label: 'Created a runner token' },
  'runner.token_revoked': { category: 'bots', label: 'Revoked a runner token' },
  'hermes.connection_created': { category: 'bots', label: 'Added a Hermes connection' },
  'hermes.connection_updated': { category: 'bots', label: 'Changed a Hermes connection' },
  'hermes.connection_deleted': { category: 'bots', label: 'Removed a Hermes connection' },
  'webhook.created': { category: 'access', label: 'Created a webhook' },
  'webhook.revoked': { category: 'access', label: 'Revoked a webhook' },
  'webhook.rotated': { category: 'access', label: 'Replaced a webhook secret' },
  'webhook.signing_changed': { category: 'access', label: 'Changed webhook signing' },
  'capability.denied': { category: 'access', label: 'Was refused a capability' },
  'guard.dlp_decided': { category: 'guardrails', label: 'Data-loss check acted on outgoing text' },
  'guard.egress_blocked': { category: 'guardrails', label: 'Blocked an outgoing request' },
  'guard.model_decided': { category: 'guardrails', label: 'Model guard acted on text' },
  'guard.budget_refused': { category: 'guardrails', label: 'Refused a model call over its limit' },
  'guard.gate_held': { category: 'guardrails', label: 'Held a command for approval' },
  'answer.sources_held_back': { category: 'guardrails', label: 'Answer posted with sources held back' },
  'answer.shared': { category: 'guardrails', label: 'Shared an answer' },
  'memory.withheld': { category: 'memory', label: 'Did not keep a memory' },
  'model_config.applied': { category: 'settings', label: 'Applied the model setup' },
  'retention.settings_changed': { category: 'settings', label: 'Changed retention' },
  'retention.sweep_completed': { category: 'system', label: 'Ran the retention sweep' },
  'audit.exported': { category: 'system', label: 'Exported the audit log' },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;
export type KnownAuditAction = keyof typeof AUDIT_ACTIONS;

/** The plain words for an action; an action this version does not know is shown as it is. */
export const auditActionLabel = (action: string): string => (AUDIT_ACTIONS as Record<string, { label: string } | undefined>)[action]?.label ?? action;
