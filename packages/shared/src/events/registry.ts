import { z } from 'zod';
import { ChannelMessagePostedEvent } from './channel.message.posted.ts';
import { ChannelMessageEditedEvent } from './channel.message.edited.ts';
import { ChannelMessageDeletedEvent } from './channel.message.deleted.ts';
import { ChannelReactionChangedEvent } from './channel.reaction.changed.ts';
import { ChannelChannelCreatedEvent } from './channel.channel.created.ts';
import { ChannelChannelUpdatedEvent } from './channel.channel.updated.ts';
import { ChannelChannelArchivedEvent } from './channel.channel.archived.ts';
import { ChannelMemberAddedEvent } from './channel.member.added.ts';
import { ChannelMemberRemovedEvent } from './channel.member.removed.ts';
import { ChannelMentionCreatedEvent } from './channel.mention.created.ts';
import { NotificationsNotificationCreatedEvent } from './notifications.notification.created.ts';
import { FilesFileUploadedEvent } from './files.file.uploaded.ts';
import { FilesFileDeletedEvent } from './files.file.deleted.ts';
import { RepoRepoCommittedEvent } from './repo.repo.committed.ts';
import { PagesPageWrittenEvent } from './pages.page.written.ts';
import { BotsBotLoadedEvent } from './bots.bot.loaded.ts';
import { BotsBotInvalidEvent } from './bots.bot.invalid.ts';
import { BotsBotRemovedEvent } from './bots.bot.removed.ts';
import { BotsRunClosedEvent } from './bots.run.closed.ts';
import { AnswerAnswerPostedEvent } from './answer.answer.posted.ts';
import { AnswerAnswerSharedEvent } from './answer.answer.shared.ts';
import { ConversationsConversationStartedEvent } from './conversations.conversation.started.ts';
import { RetentionSweepCompletedEvent } from './retention.sweep.completed.ts';
import { RetentionSettingsChangedEvent } from './retention.settings.changed.ts';
import { ApprovalsApprovalRequestedEvent } from './approvals.approval.requested.ts';
import { ApprovalsApprovalDecidedEvent } from './approvals.approval.decided.ts';
import { ApprovalsApprovalResumedEvent } from './approvals.approval.resumed.ts';
import { TasksTaskCreatedEvent } from './tasks.task.created.ts';
import { TasksTaskUpdatedEvent } from './tasks.task.updated.ts';
import { TasksTaskClaimedEvent } from './tasks.task.claimed.ts';
import { TasksTaskCompletedEvent } from './tasks.task.completed.ts';
import { TasksTaskHandedOffEvent } from './tasks.task.handed_off.ts';
import { RhythmsRhythmRanEvent } from './rhythms.rhythm.ran.ts';
import { HermesConnectionCreatedEvent } from './hermes.connection.created.ts';
import { HermesConnectionUpdatedEvent } from './hermes.connection.updated.ts';
import { HermesConnectionDeletedEvent } from './hermes.connection.deleted.ts';
import { HermesConnectionTestedEvent } from './hermes.connection.tested.ts';
import { HermesProfilesChangedEvent } from './hermes.profiles.changed.ts';
import { BotsPairingRotatedEvent } from './bots.pairing.rotated.ts';
import { RunnersJobRefusedEvent } from './runners.job.refused.ts';
import { RunnersRunnerConnectedEvent } from './runners.runner.connected.ts';
import { RunnersRunnerDisconnectedEvent } from './runners.runner.disconnected.ts';
import { RunnersTokenMintedEvent } from './runners.token.minted.ts';
import { RunnersTokenRevokedEvent } from './runners.token.revoked.ts';
import { LlmConfigAppliedEvent } from './llm.config.applied.ts';
import { LlmKeyChangedEvent } from './llm.key.changed.ts';
import { LlmBudgetExceededEvent } from './llm.budget.exceeded.ts';
import { LlmGuardDecidedEvent } from './llm.guard.decided.ts';
import { GuardrailsDlpDecidedEvent } from './guardrails.dlp.decided.ts';
import { GuardrailsEgressDecidedEvent } from './guardrails.egress.decided.ts';
import { RuntimeGateHeldEvent } from './runtime.gate.held.ts';
import { RuntimeTaskNotWokenEvent } from './runtime.task.not_woken.ts';
import { IdentityEmailVerifiedEvent } from './identity.email.verified.ts';
import { IdentityPasswordAdminSetEvent } from './identity.password.admin_set.ts';
import { IdentityPasswordChangedEvent } from './identity.password.changed.ts';
import { IdentityPasswordResetEvent } from './identity.password.reset.ts';
import { IdentitySessionSignInFailedEvent } from './identity.session.sign_in_failed.ts';
import { IdentitySessionSignedInEvent } from './identity.session.signed_in.ts';
import { IdentitySessionSignedOutEvent } from './identity.session.signed_out.ts';
import { IdentityWorkspaceBootstrappedEvent } from './identity.workspace.bootstrapped.ts';
import { WorkspaceTeamCreatedEvent } from './workspace.team.created.ts';
import { WorkspaceTeamRenamedEvent } from './workspace.team.renamed.ts';
import { WorkspaceTeamArchivedEvent } from './workspace.team.archived.ts';
import { WorkspaceTeamUnarchivedEvent } from './workspace.team.unarchived.ts';
import { WorkspaceInvitationCreatedEvent } from './workspace.invitation.created.ts';
import { WorkspaceInvitationAcceptedEvent } from './workspace.invitation.accepted.ts';
import { TeamTemplateAppliedEvent } from './team.template.applied.ts';
import { TeamMemberAddedEvent } from './team.member.added.ts';
import { TeamMemberRemovedEvent } from './team.member.removed.ts';
import { TeamRoleChangedEvent } from './team.role.changed.ts';
import { TeamTagCreatedEvent } from './team.tag.created.ts';
import { TeamTagDeletedEvent } from './team.tag.deleted.ts';
import { TeamTagAssignedEvent } from './team.tag.assigned.ts';
import { TeamTagRemovedEvent } from './team.tag.removed.ts';
import { ProjectCreatedEvent } from './project.project.created.ts';
import { ProjectUpdatedEvent } from './project.project.updated.ts';
import { ProjectDeletedEvent } from './project.project.deleted.ts';
import { IdentityProviderChangedEvent } from './identity.provider.changed.ts';
import { IdentityOidcSignedInEvent } from './identity.oidc.signed_in.ts';
import { IdentityOidcRefusedEvent } from './identity.oidc.refused.ts';
import { WorkspaceMemberRoleChangedEvent } from './workspace.member.role_changed.ts';
import { WorkspaceSettingsUpdatedEvent } from './workspace.settings.updated.ts';
import { KernelCapabilityDeniedEvent } from './kernel.capability.denied.ts';
import { ReadingStateChangedEvent } from './reading.state.changed.ts';
import { KernelTestPingedEvent } from './kernel.test.pinged.ts';
import { KernelTestPingedEventV2, upcastKernelTestPingedV1ToV2 } from './kernel.test.pinged.v2.ts';

/** type -> schemaVersion -> schema. A breaking change adds a new version beside the old one (B.4). */
export const eventRegistry = {
  'channel.message.posted': { 1: ChannelMessagePostedEvent },
  'channel.message.edited': { 1: ChannelMessageEditedEvent },
  'channel.message.deleted': { 1: ChannelMessageDeletedEvent },
  'channel.reaction.changed': { 1: ChannelReactionChangedEvent },
  'channel.channel.created': { 1: ChannelChannelCreatedEvent },
  'channel.channel.updated': { 1: ChannelChannelUpdatedEvent },
  'channel.channel.archived': { 1: ChannelChannelArchivedEvent },
  'channel.member.added': { 1: ChannelMemberAddedEvent },
  'channel.member.removed': { 1: ChannelMemberRemovedEvent },
  'channel.mention.created': { 1: ChannelMentionCreatedEvent },
  'notifications.notification.created': { 1: NotificationsNotificationCreatedEvent },
  'files.file.uploaded': { 1: FilesFileUploadedEvent },
  'files.file.deleted': { 1: FilesFileDeletedEvent },
  'repo.repo.committed': { 1: RepoRepoCommittedEvent },
  'pages.page.written': { 1: PagesPageWrittenEvent },
  'bots.bot.loaded': { 1: BotsBotLoadedEvent },
  'bots.bot.invalid': { 1: BotsBotInvalidEvent },
  'bots.bot.removed': { 1: BotsBotRemovedEvent },
  'bots.run.closed': { 1: BotsRunClosedEvent },
  'conversations.conversation.started': { 1: ConversationsConversationStartedEvent },
  'answer.answer.posted': { 1: AnswerAnswerPostedEvent },
  'answer.answer.shared': { 1: AnswerAnswerSharedEvent },
  'retention.sweep.completed': { 1: RetentionSweepCompletedEvent },
  'retention.settings.changed': { 1: RetentionSettingsChangedEvent },
  'approvals.approval.requested': { 1: ApprovalsApprovalRequestedEvent },
  'approvals.approval.decided': { 1: ApprovalsApprovalDecidedEvent },
  'approvals.approval.resumed': { 1: ApprovalsApprovalResumedEvent },
  'llm.config.applied': { 1: LlmConfigAppliedEvent },
  'llm.key.changed': { 1: LlmKeyChangedEvent },
  'llm.budget.exceeded': { 1: LlmBudgetExceededEvent },
  'llm.guard.decided': { 1: LlmGuardDecidedEvent },
  'guardrails.dlp.decided': { 1: GuardrailsDlpDecidedEvent },
  'guardrails.egress.decided': { 1: GuardrailsEgressDecidedEvent },
  'runtime.gate.held': { 1: RuntimeGateHeldEvent },
  'runtime.task.not_woken': { 1: RuntimeTaskNotWokenEvent },
  'identity.email.verified': { 1: IdentityEmailVerifiedEvent },
  'identity.password.admin_set': { 1: IdentityPasswordAdminSetEvent },
  'identity.password.reset': { 1: IdentityPasswordResetEvent },
  'identity.password.changed': { 1: IdentityPasswordChangedEvent },
  'identity.session.sign_in_failed': { 1: IdentitySessionSignInFailedEvent },
  'identity.session.signed_in': { 1: IdentitySessionSignedInEvent },
  'identity.session.signed_out': { 1: IdentitySessionSignedOutEvent },
  'identity.workspace.bootstrapped': { 1: IdentityWorkspaceBootstrappedEvent },
  'workspace.team.created': { 1: WorkspaceTeamCreatedEvent },
  'workspace.team.renamed': { 1: WorkspaceTeamRenamedEvent },
  'workspace.team.archived': { 1: WorkspaceTeamArchivedEvent },
  'workspace.team.unarchived': { 1: WorkspaceTeamUnarchivedEvent },
  'workspace.invitation.created': { 1: WorkspaceInvitationCreatedEvent },
  'workspace.invitation.accepted': { 1: WorkspaceInvitationAcceptedEvent },
  'team.template.applied': { 1: TeamTemplateAppliedEvent },
  'team.member.added': { 1: TeamMemberAddedEvent },
  'team.member.removed': { 1: TeamMemberRemovedEvent },
  'team.role.changed': { 1: TeamRoleChangedEvent },
  'team.tag.created': { 1: TeamTagCreatedEvent },
  'team.tag.deleted': { 1: TeamTagDeletedEvent },
  'team.tag.assigned': { 1: TeamTagAssignedEvent },
  'team.tag.removed': { 1: TeamTagRemovedEvent },
  'project.project.created': { 1: ProjectCreatedEvent },
  'project.project.updated': { 1: ProjectUpdatedEvent },
  'project.project.deleted': { 1: ProjectDeletedEvent },
  'identity.provider.changed': { 1: IdentityProviderChangedEvent },
  'identity.oidc.signed_in': { 1: IdentityOidcSignedInEvent },
  'identity.oidc.refused': { 1: IdentityOidcRefusedEvent },
  'workspace.settings.updated': { 1: WorkspaceSettingsUpdatedEvent },
  'workspace.member.role_changed': { 1: WorkspaceMemberRoleChangedEvent },
  'reading.state.changed': { 1: ReadingStateChangedEvent },
  'kernel.capability.denied': { 1: KernelCapabilityDeniedEvent },
  'tasks.task.created': { 1: TasksTaskCreatedEvent },
  'tasks.task.updated': { 1: TasksTaskUpdatedEvent },
  'tasks.task.claimed': { 1: TasksTaskClaimedEvent },
  'tasks.task.completed': { 1: TasksTaskCompletedEvent },
  'tasks.task.handed_off': { 1: TasksTaskHandedOffEvent },
  'rhythms.rhythm.ran': { 1: RhythmsRhythmRanEvent },
  'runners.runner.connected': { 1: RunnersRunnerConnectedEvent },
  'runners.runner.disconnected': { 1: RunnersRunnerDisconnectedEvent },
  'runners.job.refused': { 1: RunnersJobRefusedEvent },
  'runners.token.minted': { 1: RunnersTokenMintedEvent },
  'runners.token.revoked': { 1: RunnersTokenRevokedEvent },
  'hermes.connection.created': { 1: HermesConnectionCreatedEvent },
  'hermes.connection.updated': { 1: HermesConnectionUpdatedEvent },
  'hermes.connection.deleted': { 1: HermesConnectionDeletedEvent },
  'hermes.connection.tested': { 1: HermesConnectionTestedEvent },
  'hermes.profiles.changed': { 1: HermesProfilesChangedEvent },
  'bots.pairing.rotated': { 1: BotsPairingRotatedEvent },
  'kernel.test.pinged': { 1: KernelTestPingedEvent, 2: KernelTestPingedEventV2 },
} as const;

export type EventType = keyof typeof eventRegistry;

/** Every stored shape, any version. */
export type AnyEvent =
  | z.infer<typeof IdentityEmailVerifiedEvent>
  | z.infer<typeof IdentityPasswordAdminSetEvent>
  | z.infer<typeof IdentityPasswordResetEvent>
  | z.infer<typeof IdentityPasswordChangedEvent>
  | z.infer<typeof IdentitySessionSignInFailedEvent>
  | z.infer<typeof IdentitySessionSignedInEvent>
  | z.infer<typeof IdentitySessionSignedOutEvent>
  | z.infer<typeof IdentityWorkspaceBootstrappedEvent>
  | z.infer<typeof WorkspaceTeamCreatedEvent>
  | z.infer<typeof WorkspaceTeamRenamedEvent>
  | z.infer<typeof WorkspaceTeamArchivedEvent>
  | z.infer<typeof WorkspaceTeamUnarchivedEvent>
  | z.infer<typeof WorkspaceInvitationCreatedEvent>
  | z.infer<typeof WorkspaceInvitationAcceptedEvent>
  | z.infer<typeof TeamTemplateAppliedEvent>
  | z.infer<typeof TeamMemberAddedEvent>
  | z.infer<typeof TeamMemberRemovedEvent>
  | z.infer<typeof TeamRoleChangedEvent>
  | z.infer<typeof TeamTagCreatedEvent>
  | z.infer<typeof TeamTagDeletedEvent>
  | z.infer<typeof TeamTagAssignedEvent>
  | z.infer<typeof TeamTagRemovedEvent>
  | z.infer<typeof ProjectCreatedEvent>
  | z.infer<typeof ProjectUpdatedEvent>
  | z.infer<typeof ProjectDeletedEvent>
  | z.infer<typeof IdentityProviderChangedEvent>
  | z.infer<typeof IdentityOidcSignedInEvent>
  | z.infer<typeof IdentityOidcRefusedEvent>
  | z.infer<typeof WorkspaceSettingsUpdatedEvent>
  | z.infer<typeof WorkspaceMemberRoleChangedEvent>
  | z.infer<typeof ChannelMessagePostedEvent>
  | z.infer<typeof ChannelMessageEditedEvent>
  | z.infer<typeof ChannelMessageDeletedEvent>
  | z.infer<typeof ChannelReactionChangedEvent>
  | z.infer<typeof ChannelChannelCreatedEvent>
  | z.infer<typeof ChannelChannelUpdatedEvent>
  | z.infer<typeof ChannelChannelArchivedEvent>
  | z.infer<typeof ChannelMemberAddedEvent>
  | z.infer<typeof ChannelMemberRemovedEvent>
  | z.infer<typeof ChannelMentionCreatedEvent>
  | z.infer<typeof NotificationsNotificationCreatedEvent>
  | z.infer<typeof FilesFileUploadedEvent>
  | z.infer<typeof FilesFileDeletedEvent>
  | z.infer<typeof RepoRepoCommittedEvent>
  | z.infer<typeof PagesPageWrittenEvent>
  | z.infer<typeof BotsBotLoadedEvent>
  | z.infer<typeof BotsBotInvalidEvent>
  | z.infer<typeof BotsBotRemovedEvent>
  | z.infer<typeof BotsRunClosedEvent>
  | z.infer<typeof ConversationsConversationStartedEvent>
  | z.infer<typeof RetentionSweepCompletedEvent>
  | z.infer<typeof RetentionSettingsChangedEvent>
  | z.infer<typeof LlmConfigAppliedEvent>
  | z.infer<typeof ApprovalsApprovalRequestedEvent>
  | z.infer<typeof ApprovalsApprovalDecidedEvent>
  | z.infer<typeof ApprovalsApprovalResumedEvent>
  | z.infer<typeof LlmKeyChangedEvent>
  | z.infer<typeof ReadingStateChangedEvent>
  | z.infer<typeof KernelCapabilityDeniedEvent>
  | z.infer<typeof KernelTestPingedEvent>
  | z.infer<typeof KernelTestPingedEventV2>
  | z.infer<typeof TasksTaskCreatedEvent>
  | z.infer<typeof TasksTaskUpdatedEvent>
  | z.infer<typeof TasksTaskClaimedEvent>
  | z.infer<typeof TasksTaskCompletedEvent>
  | z.infer<typeof TasksTaskHandedOffEvent>
  | z.infer<typeof RhythmsRhythmRanEvent>;

/** The newest version of every event: what `upcast` returns and emitters write. */
export type LatestEvent =
  | z.infer<typeof IdentityEmailVerifiedEvent>
  | z.infer<typeof IdentityPasswordAdminSetEvent>
  | z.infer<typeof IdentityPasswordResetEvent>
  | z.infer<typeof IdentityPasswordChangedEvent>
  | z.infer<typeof IdentitySessionSignInFailedEvent>
  | z.infer<typeof IdentitySessionSignedInEvent>
  | z.infer<typeof IdentitySessionSignedOutEvent>
  | z.infer<typeof IdentityWorkspaceBootstrappedEvent>
  | z.infer<typeof WorkspaceTeamCreatedEvent>
  | z.infer<typeof WorkspaceTeamRenamedEvent>
  | z.infer<typeof WorkspaceTeamArchivedEvent>
  | z.infer<typeof WorkspaceTeamUnarchivedEvent>
  | z.infer<typeof WorkspaceInvitationCreatedEvent>
  | z.infer<typeof WorkspaceInvitationAcceptedEvent>
  | z.infer<typeof TeamTemplateAppliedEvent>
  | z.infer<typeof TeamMemberAddedEvent>
  | z.infer<typeof TeamMemberRemovedEvent>
  | z.infer<typeof TeamRoleChangedEvent>
  | z.infer<typeof TeamTagCreatedEvent>
  | z.infer<typeof TeamTagDeletedEvent>
  | z.infer<typeof TeamTagAssignedEvent>
  | z.infer<typeof TeamTagRemovedEvent>
  | z.infer<typeof ProjectCreatedEvent>
  | z.infer<typeof ProjectUpdatedEvent>
  | z.infer<typeof ProjectDeletedEvent>
  | z.infer<typeof IdentityProviderChangedEvent>
  | z.infer<typeof IdentityOidcSignedInEvent>
  | z.infer<typeof IdentityOidcRefusedEvent>
  | z.infer<typeof WorkspaceSettingsUpdatedEvent>
  | z.infer<typeof WorkspaceMemberRoleChangedEvent>
  | z.infer<typeof ChannelMessagePostedEvent>
  | z.infer<typeof ChannelMessageEditedEvent>
  | z.infer<typeof ChannelMessageDeletedEvent>
  | z.infer<typeof ChannelReactionChangedEvent>
  | z.infer<typeof ChannelChannelCreatedEvent>
  | z.infer<typeof ChannelChannelUpdatedEvent>
  | z.infer<typeof ChannelChannelArchivedEvent>
  | z.infer<typeof ChannelMemberAddedEvent>
  | z.infer<typeof ChannelMemberRemovedEvent>
  | z.infer<typeof ChannelMentionCreatedEvent>
  | z.infer<typeof NotificationsNotificationCreatedEvent>
  | z.infer<typeof FilesFileUploadedEvent>
  | z.infer<typeof FilesFileDeletedEvent>
  | z.infer<typeof ReadingStateChangedEvent>
  | z.infer<typeof KernelCapabilityDeniedEvent>
  | z.infer<typeof KernelTestPingedEventV2>
  | z.infer<typeof BotsBotLoadedEvent>
  | z.infer<typeof BotsBotInvalidEvent>
  | z.infer<typeof BotsBotRemovedEvent>
  | z.infer<typeof BotsRunClosedEvent>
  | z.infer<typeof ConversationsConversationStartedEvent>
  | z.infer<typeof RetentionSweepCompletedEvent>
  | z.infer<typeof RetentionSettingsChangedEvent>
  | z.infer<typeof LlmConfigAppliedEvent>
  | z.infer<typeof ApprovalsApprovalRequestedEvent>
  | z.infer<typeof ApprovalsApprovalDecidedEvent>
  | z.infer<typeof ApprovalsApprovalResumedEvent>
  | z.infer<typeof LlmKeyChangedEvent>
  | z.infer<typeof TasksTaskCreatedEvent>
  | z.infer<typeof TasksTaskUpdatedEvent>
  | z.infer<typeof TasksTaskClaimedEvent>
  | z.infer<typeof TasksTaskCompletedEvent>
  | z.infer<typeof TasksTaskHandedOffEvent>
  | z.infer<typeof RhythmsRhythmRanEvent>;

type Upcaster = (event: AnyEvent) => AnyEvent;

/** type -> fromVersion -> function producing fromVersion + 1. */
const upcasters: Readonly<Record<string, Readonly<Record<number, Upcaster>>>> = {
  'kernel.test.pinged': {
    // The registry guarantees the input was validated as v1 before this runs.
    1: (event) => upcastKernelTestPingedV1ToV2(event as z.infer<typeof KernelTestPingedEvent>),
  },
};

const schemasByType: Readonly<Record<string, Readonly<Record<number, z.ZodType>>>> = eventRegistry;

const Envelope = z.looseObject({ type: z.string(), schemaVersion: z.number().int() });

const fail = (path: string, message: string): never => {
  throw new z.ZodError([{ code: 'custom', path: [path], message, input: undefined }]);
};

export const latestVersion = (type: EventType): number => {
  const versions = Object.keys(eventRegistry[type]).map(Number);
  return Math.max(...versions);
};

/** Validate `raw` against the schema for its own type + schemaVersion. Throws a ZodError naming the field. */
export const parseEvent = (raw: unknown): AnyEvent => {
  const { type, schemaVersion } = Envelope.parse(raw);
  const versions = Object.hasOwn(schemasByType, type) ? schemasByType[type] : undefined;
  if (!versions) return fail('type', `unknown event type "${type}"`);
  const schema = Object.hasOwn(versions, schemaVersion) ? versions[schemaVersion] : undefined;
  if (!schema) return fail('schemaVersion', `unknown schemaVersion ${schemaVersion} for event type "${type}"`);
  // Safe by construction: every registered schema infers to a member of AnyEvent.
  return schema.parse(raw) as AnyEvent;
};

/** Parse, then upcast step by step to the newest registered version. */
export const upcast = (raw: unknown): LatestEvent => {
  let event = parseEvent(raw);
  const type = event.type;
  const latest = latestVersion(type);
  while (event.schemaVersion < latest) {
    const step = upcasters[type]?.[event.schemaVersion];
    if (!step) return fail('schemaVersion', `no upcaster from v${event.schemaVersion} for "${type}"`);
    event = parseEvent(step(event));
  }
  return event as LatestEvent;
};
