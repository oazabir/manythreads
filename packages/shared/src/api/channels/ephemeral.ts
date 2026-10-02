import { z } from 'zod';
import { IsoDateTime } from '../../common/time.ts';
import { ChannelId, MessageId, PersonId } from '../../ids.ts';

// Presence and typing (PLAN A.3, UNLOGGED tables of the channels plugin). Both are best-effort and expire by themselves: a client
// keeps them alive by repeating the request while the person is online or typing.

/** How long a heartbeat counts as online (clients send one every 30 seconds). */
export const PRESENCE_TTL_SECONDS = 90;
/** How long one typing signal counts (clients repeat it every 3 seconds while the person types). */
export const TYPING_TTL_SECONDS = 5;

export const PresenceStatus = z.enum(['online', 'away']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

/** The heartbeat: "I am here" (`online`, the default) or "I am here but idle" (`away`). */
export const HeartbeatRequest = z.strictObject({ status: PresenceStatus.optional() });
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;
export const HeartbeatResponse = z.object({ status: PresenceStatus, seenAt: IsoDateTime, expiresAt: IsoDateTime });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;
export const heartbeatRoute = { method: 'POST', path: '/api/presence' } as const;

/** Who has sent a heartbeat in the last `PRESENCE_TTL_SECONDS`. A guest sees only themself. */
export const PresentPerson = z.object({ personId: PersonId, status: PresenceStatus, seenAt: IsoDateTime });
export type PresentPerson = z.infer<typeof PresentPerson>;
export const ListPresenceResponse = z.object({ people: z.array(PresentPerson) });
export type ListPresenceResponse = z.infer<typeof ListPresenceResponse>;
export const listPresenceRoute = { method: 'GET', path: '/api/presence' } as const;

/** "I am typing in this channel" (`threadRootId`: in the thread of that message). Expires after `TYPING_TTL_SECONDS`. */
export const TypingRequest = z.strictObject({ threadRootId: MessageId.nullable().optional() });
export type TypingRequest = z.infer<typeof TypingRequest>;
export const TypingResponse = z.object({ expiresAt: IsoDateTime });
export type TypingResponse = z.infer<typeof TypingResponse>;
export const typingRoute = { method: 'POST', path: '/api/channels/:channelId/typing' } as const;

/** Who is typing in the channel right now (not the caller). */
export const TypingPerson = z.object({ personId: PersonId, expiresAt: IsoDateTime });
export type TypingPerson = z.infer<typeof TypingPerson>;
export const ListTypingResponse = z.object({ typing: z.array(TypingPerson) });
export type ListTypingResponse = z.infer<typeof ListTypingResponse>;
export const listTypingRoute = { method: 'GET', path: '/api/channels/:channelId/typing' } as const;
export const TypingPathParams = z.object({ channelId: ChannelId });

/** WebSocket push `typing.started`, sent to the channel's audience except the typist. Clients drop it at `expiresAt` or when the person's message arrives. */
export const WS_TYPING_STARTED = 'typing.started';
export const TypingStartedPush = z.object({
  channelId: ChannelId,
  personId: PersonId,
  threadRootId: MessageId.nullable(),
  expiresAt: IsoDateTime,
});
export type TypingStartedPush = z.infer<typeof TypingStartedPush>;
