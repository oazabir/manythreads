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
  'member.deactivated': { category: 'people', label: 'Deactivated a member' },
  'member.reactivated': { category: 'people', label: 'Reactivated a member' },
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
  'personal_space.opened': { category: 'access', label: "Opened someone's Personal space" },
  'personal_space.exported': { category: 'access', label: "Downloaded someone's Personal space" },
  'channel.created': { category: 'content', label: 'Created a channel' },
  'channel.archived': { category: 'content', label: 'Archived or restored a channel' },
  'channel.member_added': { category: 'content', label: 'Added someone to a channel' },
  'channel.member_removed': { category: 'content', label: 'Removed someone from a channel' },
  'message.deleted': { category: 'content', label: 'Deleted a message' },
  'approval.requested': { category: 'approvals', label: 'Asked for approval' },
  'approval.decided': { category: 'approvals', label: 'Decided an approval' },
  'approval.resumed': { category: 'approvals', label: 'Ran an approved action' },
  'terminal.opened': { category: 'bots', label: 'Opened a test terminal for a bot' },
  'terminal.closed': { category: 'bots', label: 'Closed a test terminal for a bot' },
  'bot.loaded': { category: 'bots', label: 'Loaded a bot definition' },
  'bot.removed': { category: 'bots', label: 'Removed a bot' },
  'bot.pairing_rotated': { category: 'bots', label: 'Reset a bot pairing' },
  'bot.key_changed': { category: 'bots', label: 'Changed a bot model key' },
  'runner.token_minted': { category: 'bots', label: 'Created a runner token' },
  'runner.token_revoked': { category: 'bots', label: 'Revoked a runner token' },
  'hermes.connection_created': { category: 'bots', label: 'Added a Hermes connection' },
  'hermes.connection_updated': { category: 'bots', label: 'Changed a Hermes connection' },
  'hermes.connection_deleted': { category: 'bots', label: 'Removed a Hermes connection' },
  'bot_runner.created': { category: 'settings', label: 'Added a bot runner' },
  'bot_runner.updated': { category: 'settings', label: 'Changed a bot runner' },
  'bot_runner.deleted': { category: 'settings', label: 'Removed a bot runner' },
  'bot_runner.tested': { category: 'settings', label: 'Tested a bot runner' },
  'bot_runner.availability_changed': { category: 'settings', label: 'Changed which teams can use a bot runner' },
  'bot_runner.default_changed': { category: 'settings', label: 'Changed the default bot runner' },
  'bot_runner.node_changed': { category: 'settings', label: 'Changed the machine a bot runner uses' },
  'bot_runner.terms_accepted': { category: 'settings', label: 'Accepted the terms for a bot runner' },
  'claude_pod.credentials_uploaded': { category: 'settings', label: "Uploaded a Claude Code runner's sign-in file" },
  'claude_pod.credentials_replaced': { category: 'settings', label: "Replaced a Claude Code runner's sign-in file" },
  'claude_pod.credentials_removed': { category: 'settings', label: "Removed a Claude Code runner's sign-in file" },
  'claude_pod.runner_paused': { category: 'bots', label: 'A Claude Code runner paused itself' },
  'bot_runner.run_refused': { category: 'bots', label: "A bot's run was refused by its runner" },
  'bot_runner.run_unmetered': { category: 'bots', label: 'A pod run left no spend line at the model gateway' },
  'connection.created': { category: 'settings', label: 'Added a connection' },
  'connection.updated': { category: 'settings', label: 'Changed a connection' },
  'connection.switched': { category: 'settings', label: 'Switched a connection on or off' },
  'connection.credential_set': { category: 'settings', label: 'Put a credential into a connection' },
  'connection.deleted': { category: 'settings', label: 'Removed a connection' },
  'webhook.created': { category: 'access', label: 'Created a webhook' },
  'webhook.revoked': { category: 'access', label: 'Revoked a webhook' },
  'webhook.rotated': { category: 'access', label: 'Replaced a webhook secret' },
  'webhook.signing_changed': { category: 'access', label: 'Changed webhook signing' },
  'integration.token_created': { category: 'access', label: 'Created an integration API token' },
  'integration.token_rotated': { category: 'access', label: 'Replaced an integration API token' },
  'integration.token_revoked': { category: 'access', label: 'Revoked an integration API token' },
  'integration.api_called': { category: 'access', label: 'An integration used its API token' },
  'integration.outgoing_changed': { category: 'access', label: 'Changed an outgoing webhook' },
  'integration.outgoing_sent': { category: 'content', label: 'Sent a message to an outgoing webhook' },
  'integration.outgoing_failed': { category: 'content', label: 'Could not send a message to an outgoing webhook' },
  'capability.denied': { category: 'access', label: 'Was refused a capability' },
  'guard.dlp_decided': { category: 'guardrails', label: 'Data-loss check acted on outgoing text' },
  'guard.egress_blocked': { category: 'guardrails', label: 'Blocked an outgoing request' },
  'guard.model_decided': { category: 'guardrails', label: 'Model guard acted on text' },
  'guard.budget_refused': { category: 'guardrails', label: 'Refused a model call over its limit' },
  'guard.policy_changed': { category: 'guardrails', label: 'Changed the data-protection policy' },
  'guard.gate_held': { category: 'guardrails', label: 'Held a command for approval' },
  'answer.sources_held_back': { category: 'guardrails', label: 'Answer posted with sources held back' },
  'answer.shared': { category: 'guardrails', label: 'Shared an answer' },
  'memory.withheld': { category: 'memory', label: 'Did not keep a memory' },
  'model_config.applied': { category: 'settings', label: 'Applied the model setup' },
  'model_alias.tested': { category: 'settings', label: 'Tested a model alias' },
  'setup.step_marked': { category: 'settings', label: 'Changed a setup step' },
  'setup.goal_launched': { category: 'settings', label: 'Sent the first goal to Brain' },
  'setup.checklist_dismissed': { category: 'settings', label: 'Put the setup checklist away' },
  'knowledge.base_created': { category: 'content', label: 'Created a knowledge base' },
  'knowledge.base_deleted': { category: 'content', label: 'Removed a knowledge base' },
  'knowledge.document_added': { category: 'content', label: 'Added a document to a knowledge base' },
  'knowledge.document_removed': { category: 'content', label: 'Removed a document from a knowledge base' },
  'knowledge.base_resynced': { category: 'content', label: 'Re-read a knowledge base' },
  'retention.settings_changed': { category: 'settings', label: 'Changed retention' },
  'linkpreview.settings_changed': { category: 'settings', label: 'Changed link previews' },
  'emoji.added': { category: 'settings', label: 'Added a custom emoji' },
  'emoji.deleted': { category: 'settings', label: 'Removed a custom emoji' },
  'import.uploaded': { category: 'content', label: 'Uploaded an export to import' },
  'import.analysed': { category: 'content', label: 'Checked an export before importing it' },
  'import.started': { category: 'content', label: 'Started an import' },
  'import.finished': { category: 'content', label: 'An import ended' },
  'import.person_claimed': { category: 'content', label: 'Someone took over their imported messages' },
  'meeting.started': { category: 'content', label: 'Opened a voice room' },
  'meeting.ended': { category: 'content', label: 'A voice room ended' },
  'meeting.consent_changed': { category: 'access', label: 'Changed who is transcribed or recorded in a voice room' },
  'meeting.recording_started': { category: 'access', label: 'Started recording a voice room' },
  'meeting.recording_stopped': { category: 'access', label: 'Stopped recording a voice room' },
  'meeting.notetaker_added': { category: 'bots', label: 'Added a note-taker to a voice room' },
  'meeting.notetaker_removed': { category: 'bots', label: 'A note-taker left a voice room' },
  'meeting.notes_shared': { category: 'access', label: 'Shared or unshared meeting notes' },
  'meeting.notes_saved': { category: 'content', label: 'Saved meeting notes to the team' },
  'meeting.scheduled': { category: 'content', label: 'Planned a voice room ahead' },
  'meeting.schedule_changed': { category: 'content', label: 'Changed a planned voice room' },
  'meeting.schedule_cancelled': { category: 'content', label: 'Cancelled a planned voice room' },
  'knowledge.source_synced': { category: 'content', label: 'Read a connected app into a knowledge base' },
  'webhook.provider_endpoint_changed': { category: 'access', label: 'Changed an address a work app calls' },
  'webhook.provider_event_refused': { category: 'access', label: 'Turned away a work app call' },
  'bridge.account_changed': { category: 'settings', label: 'Changed a chat app account' },
  'bridge.channel_linked': { category: 'access', label: 'Joined a channel to an outside chat' },
  'bridge.channel_unlinked': { category: 'access', label: 'Took a channel off an outside chat' },
  'bridge.identity_linked': { category: 'access', label: 'Linked a person to a chat app user' },
  'bridge.identity_unlinked': { category: 'access', label: 'Unlinked a person from a chat app user' },
  'bridge.message_refused': { category: 'access', label: 'Turned away chat app messages' },
  'connection.person_offboarded': { category: 'people', label: "Removed a leaving person's connections" },
  'digest.sent': { category: 'system', label: 'Sent an email digest' },
  'digest.unsubscribed': { category: 'settings', label: 'Turned off the email digest' },
  'retention.sweep_completed': { category: 'system', label: 'Ran the retention sweep' },
  'audit.exported': { category: 'system', label: 'Exported the audit log' },
} as const satisfies Record<string, { category: AuditCategory; label: string }>;
export type KnownAuditAction = keyof typeof AUDIT_ACTIONS;

/** The plain words for an action; an action this version does not know is shown as it is. */
export const auditActionLabel = (action: string): string => (AUDIT_ACTIONS as Record<string, { label: string } | undefined>)[action]?.label ?? action;
