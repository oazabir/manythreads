import { z } from 'zod';
import { ActorId, ChannelId, MessageId, NotificationId, PersonId, WorkspaceId } from '../ids.ts';
import { NotificationKind, NotificationRefType } from '../entities/notification.ts';

/**
 * A notification was written for a person (or a reply or dm one was raised to a mention). The notifications plugin writes it as the system
 * actor when it consumes `channel.mention.created` / `channel.message.posted`. The payload names who was told and why, never the text.
 * It has no `teamId`, so only workspace admins read it from the event log; push and mail channels subscribe to it.
 */
export const NotificationsNotificationCreatedEvent = z.object({
  type: z.literal('notifications.notification.created'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  notificationId: NotificationId,
  personId: PersonId,
  kind: NotificationKind,
  refType: NotificationRefType,
  refId: MessageId,
  channelId: ChannelId,
  /** Who did it (the author of the message). */
  actorId: ActorId,
});
export type NotificationsNotificationCreatedEvent = z.infer<typeof NotificationsNotificationCreatedEvent>;
