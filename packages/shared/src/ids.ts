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
