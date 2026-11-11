import { z } from 'zod';

// Branded uuids (PLAN.md B.2 rule 5). Schema and type share one name.

export const WorkspaceId = z.uuid().brand<'WorkspaceId'>();
export type WorkspaceId = z.infer<typeof WorkspaceId>;

export const PersonId = z.uuid().brand<'PersonId'>();
export type PersonId = z.infer<typeof PersonId>;

export const TeamId = z.uuid().brand<'TeamId'>();
export type TeamId = z.infer<typeof TeamId>;

export const ChannelId = z.uuid().brand<'ChannelId'>();
export type ChannelId = z.infer<typeof ChannelId>;

export const MessageId = z.uuid().brand<'MessageId'>();
export type MessageId = z.infer<typeof MessageId>;

export const ThreadId = z.uuid().brand<'ThreadId'>();
export type ThreadId = z.infer<typeof ThreadId>;

/** A person or a bot (anything that can author a message or hold a capability). */
export const ActorId = z.uuid().brand<'ActorId'>();
export type ActorId = z.infer<typeof ActorId>;

export const BotId = z.uuid().brand<'BotId'>();
export type BotId = z.infer<typeof BotId>;

export const EventId = z.uuid().brand<'EventId'>();
export type EventId = z.infer<typeof EventId>;

export const JobId = z.uuid().brand<'JobId'>();
export type JobId = z.infer<typeof JobId>;

export const RunId = z.uuid().brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;

export const FileId = z.uuid().brand<'FileId'>();
export type FileId = z.infer<typeof FileId>;

export const FileVersionId = z.uuid().brand<'FileVersionId'>();
export type FileVersionId = z.infer<typeof FileVersionId>;

export const TaskId = z.uuid().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskId>;

export const OutboxId = z.uuid().brand<'OutboxId'>();
export type OutboxId = z.infer<typeof OutboxId>;

export const EntityLinkId = z.uuid().brand<'EntityLinkId'>();
export type EntityLinkId = z.infer<typeof EntityLinkId>;

export const CapabilityGrantId = z.uuid().brand<'CapabilityGrantId'>();
export type CapabilityGrantId = z.infer<typeof CapabilityGrantId>;

// Phase 2: identity, sessions, teams and ACL.

export const SecretId = z.uuid().brand<'SecretId'>();
export type SecretId = z.infer<typeof SecretId>;

export const AuthProviderId = z.uuid().brand<'AuthProviderId'>();
export type AuthProviderId = z.infer<typeof AuthProviderId>;

export const IdentityId = z.uuid().brand<'IdentityId'>();
export type IdentityId = z.infer<typeof IdentityId>;

export const PersonEmailId = z.uuid().brand<'PersonEmailId'>();
export type PersonEmailId = z.infer<typeof PersonEmailId>;

export const SessionId = z.uuid().brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

export const InvitationId = z.uuid().brand<'InvitationId'>();
export type InvitationId = z.infer<typeof InvitationId>;

export const EmailVerificationId = z.uuid().brand<'EmailVerificationId'>();
export type EmailVerificationId = z.infer<typeof EmailVerificationId>;

export const RoleId = z.uuid().brand<'RoleId'>();
export type RoleId = z.infer<typeof RoleId>;

export const AclEntryId = z.uuid().brand<'AclEntryId'>();
export type AclEntryId = z.infer<typeof AclEntryId>;

// Phase 3: channels.

export const ChannelGroupId = z.uuid().brand<'ChannelGroupId'>();
export type ChannelGroupId = z.infer<typeof ChannelGroupId>;

export const NotificationId = z.uuid().brand<'NotificationId'>();
export type NotificationId = z.infer<typeof NotificationId>;

/** One saved-for-later item of one person (P14-04). */
export const LaterItemId = z.uuid().brand<'LaterItemId'>();
export type LaterItemId = z.infer<typeof LaterItemId>;

/** One reminder made with `/remind` (P14-04): for the person themself, for someone else, or for a channel. */
export const ReminderId = z.uuid().brand<'ReminderId'>();
export type ReminderId = z.infer<typeof ReminderId>;

/** One message a person scheduled to be sent later (P14-05). */
export const ScheduledMessageId = z.uuid().brand<'ScheduledMessageId'>();
export type ScheduledMessageId = z.infer<typeof ScheduledMessageId>;
/** One custom emoji an admin added to the workspace (P14-02). */
export const CustomEmojiId = z.uuid().brand<'CustomEmojiId'>();
export type CustomEmojiId = z.infer<typeof CustomEmojiId>;
/** One poll of a channel (P14-07). */
export const PollId = z.uuid().brand<'PollId'>();
export type PollId = z.infer<typeof PollId>;
/** One voice room: a live or finished meeting (P15-01). */
export const MeetingId = z.uuid().brand<'MeetingId'>();
export type MeetingId = z.infer<typeof MeetingId>;
/** One line of a meeting's transcript (P15-08). */
export const MeetingSegmentId = z.uuid().brand<'MeetingSegmentId'>();
export type MeetingSegmentId = z.infer<typeof MeetingSegmentId>;
/** One person's or channel's access to a meeting's notes, given by the organizer (P15-23). */
export const MeetingShareId = z.uuid().brand<'MeetingShareId'>();
export type MeetingShareId = z.infer<typeof MeetingShareId>;
/** One person's audio file of a recorded meeting (P15-15). */
export const MeetingRecordingId = z.uuid().brand<'MeetingRecordingId'>();
export type MeetingRecordingId = z.infer<typeof MeetingRecordingId>;

/** One voice room planned ahead on a calendar (Bundle D, P16-05). */
export const ScheduledMeetingId = z.uuid().brand<'ScheduledMeetingId'>();
export type ScheduledMeetingId = z.infer<typeof ScheduledMeetingId>;
/** One chat app account of the workspace: a Telegram bot, a WhatsApp number, a Slack app, a Teams bot (Bundle D, P16-09). */
export const BridgeAccountId = z.uuid().brand<'BridgeAccountId'>();
export type BridgeAccountId = z.infer<typeof BridgeAccountId>;
/** One public channel joined to one outside chat (Bundle D, P16-09). */
export const BridgeLinkId = z.uuid().brand<'BridgeLinkId'>();
export type BridgeLinkId = z.infer<typeof BridgeLinkId>;
/** One delivery a provider sent to an app endpoint, after it was verified and read (Bundle D, P16-10). */
export const ProviderEventId = z.uuid().brand<'ProviderEventId'>();
export type ProviderEventId = z.infer<typeof ProviderEventId>;

// Phase 9: surfaces (bot-generated UI).

/** One surface: a screen a bot drew in OpenUI Lang, shown in a thread (P9-01). */
export const SurfaceId = z.uuid().brand<'SurfaceId'>();
export type SurfaceId = z.infer<typeof SurfaceId>;
/** One line of a surface's history: a render, an update, a click or form submission, a pin (P9-01). */
export const SurfaceEventId = z.uuid().brand<'SurfaceEventId'>();
export type SurfaceEventId = z.infer<typeof SurfaceEventId>;

// Phase 5: approvals.

export const ApprovalId = z.uuid().brand<'ApprovalId'>();
export type ApprovalId = z.infer<typeof ApprovalId>;

// Phase 6: tasks, boards, scheduled jobs.

export const TaskClaimId = z.uuid().brand<'TaskClaimId'>();
export type TaskClaimId = z.infer<typeof TaskClaimId>;

export const TaskEventId = z.uuid().brand<'TaskEventId'>();
export type TaskEventId = z.infer<typeof TaskEventId>;

export const HandoffId = z.uuid().brand<'HandoffId'>();
export type HandoffId = z.infer<typeof HandoffId>;

export const EnvironmentId = z.uuid().brand<'EnvironmentId'>();
export type EnvironmentId = z.infer<typeof EnvironmentId>;

export const BoardId = z.uuid().brand<'BoardId'>();
export type BoardId = z.infer<typeof BoardId>;

export const RunnerId = z.uuid().brand<'RunnerId'>();
export type RunnerId = z.infer<typeof RunnerId>;

export const WebhookId = z.uuid().brand<'WebhookId'>();
export type WebhookId = z.infer<typeof WebhookId>;

export const ProposalId = z.uuid().brand<'ProposalId'>();
export type ProposalId = z.infer<typeof ProposalId>;
/** One run of a bot's scenario set (`bot_eval_runs`, PLAN P7-08). */
export const BotEvalRunId = z.uuid().brand<'BotEvalRunId'>();
export type BotEvalRunId = z.infer<typeof BotEvalRunId>;

export const HermesConnectionId = z.uuid().brand<'HermesConnectionId'>();
export type HermesConnectionId = z.infer<typeof HermesConnectionId>;

/** One place bots can run (`bot_runners`, PLAN P19-02). */
export const BotRunnerId = z.uuid().brand<'BotRunnerId'>();
export type BotRunnerId = z.infer<typeof BotRunnerId>;

export const ScheduledJobId = z.uuid().brand<'ScheduledJobId'>();
export type ScheduledJobId = z.infer<typeof ScheduledJobId>;

export const ScheduledJobRunId = z.uuid().brand<'ScheduledJobRunId'>();
export type ScheduledJobRunId = z.infer<typeof ScheduledJobRunId>;

export const ProjectId = z.uuid().brand<'ProjectId'>();
export type ProjectId = z.infer<typeof ProjectId>;

// Phase 10: the audit console.

/** One row of the audit console. It is the id of the event (or memory log line) the row was made from, so a row can be traced back to its source. */
export const AuditEventId = z.uuid().brand<'AuditEventId'>();
export type AuditEventId = z.infer<typeof AuditEventId>;

/** A custom data-loss rule an admin wrote (guardrails-dlp). */
export const DlpRuleId = z.uuid().brand<'DlpRuleId'>();
export type DlpRuleId = z.infer<typeof DlpRuleId>;

/** One "Add a bot" conversation: a person's brief, what was found out and the proposals it ended in (`setup_sessions`, PLAN P7-02). */
export const SetupSessionId = z.uuid().brand<'SetupSessionId'>();
export type SetupSessionId = z.infer<typeof SetupSessionId>;

/** One Workshop conversation on a bot's page: Build, Rehearse or Live (`workshop_sessions`, PLAN P7-05). */
export const WorkshopSessionId = z.uuid().brand<'WorkshopSessionId'>();
export type WorkshopSessionId = z.infer<typeof WorkshopSessionId>;

/** One "check this again" notice on a bot: something it depends on changed, or its eval score dropped (`bot_reassessments`, PLAN P7-07). */
export const BotReassessmentId = z.uuid().brand<'BotReassessmentId'>();
export type BotReassessmentId = z.infer<typeof BotReassessmentId>;
/** One recorded terminal into a bot's sandbox (`terminal_sessions`, PLAN P7-09). */
export const TerminalSessionId = z.uuid().brand<'TerminalSessionId'>();
export type TerminalSessionId = z.infer<typeof TerminalSessionId>;
