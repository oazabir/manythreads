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
