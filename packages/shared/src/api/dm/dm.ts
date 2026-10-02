import { z } from 'zod';
import { Channel } from '../../entities/channel.ts';
import { Page } from '../../common/page.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, MessageId, PersonId } from '../../ids.ts';

// Direct messages (SPEC 6.1, PLAN P3-06): a private channel of `kind: 'dm'` between two or more people, found or made by the set
// of people. Reading and posting use the ordinary channel routes with the DM's channel id.

/** Most people besides the caller in one conversation. */
export const MAX_DM_PEERS = 8;

/** Open (or create) the conversation with these people; the caller is always part of it. Opening the same set twice gives the same channel. */
export const OpenDmRequest = z.strictObject({ personIds: z.array(PersonId).min(1).max(MAX_DM_PEERS) });
export type OpenDmRequest = z.infer<typeof OpenDmRequest>;

export const DmParticipant = z.object({ personId: PersonId, displayName: z.string() });
export type DmParticipant = z.infer<typeof DmParticipant>;

export const DmLastMessage = z.object({
  id: MessageId,
  authorId: ActorId,
  /** The first 140 characters of the plain text. */
  preview: z.string(),
  createdAt: IsoDateTime,
});
export type DmLastMessage = z.infer<typeof DmLastMessage>;

/** A conversation as the DM list shows it. `participants` includes the caller. */
export const DirectMessageSummary = z.object({
  channel: Channel,
  participants: z.array(DmParticipant),
  lastMessage: DmLastMessage.nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type DirectMessageSummary = z.infer<typeof DirectMessageSummary>;

export const OpenDmResponse = z.object({ dm: DirectMessageSummary, created: z.boolean() });
export type OpenDmResponse = z.infer<typeof OpenDmResponse>;
export const openDmRoute = { method: 'POST', path: '/api/dms' } as const;

/** My conversations, the most recently active first. */
export const ListDmsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type ListDmsQuery = z.infer<typeof ListDmsQuery>;
export const ListDmsResponse = Page(DirectMessageSummary);
export type ListDmsResponse = z.infer<typeof ListDmsResponse>;
export const listDmsRoute = { method: 'GET', path: '/api/dms' } as const;
