import { z } from 'zod';
import { INBOX_NAME_MAX, INBOX_NOTE_MAX_CHARS, InboxItem, InboxItemId } from '../../entities/inbox.ts';
import { PersonId } from '../../ids.ts';
import { SpaceRef } from '../../entities/space.ts';
import type { ApiRoute } from '../client/route.ts';
import { TeamSlug } from '../teams/common.ts';

// A person's own inbox (P20-04, D10): a place to drop a file, a note or a link that only its owner sees. The platform reads it into text and files it as a
// Reference in the person's Memory (a Personal space; never git). An item that looks risky (private data in the text, a very large file, a memory bundle from
// elsewhere) is held for the person to release or discard. Moving an item to a team is the person's own action ("Send to team": a copy dropped into the team
// inbox, where that team's rules apply). docs/plugins/memory-inbox.md.

/** An inbox item of a person: the shape of a team's, without a team. `space` is `person:<id>`. */
export const PersonalInboxItem = InboxItem.omit({ teamId: true }).extend({ personId: PersonId, space: SpaceRef });
export type PersonalInboxItem = z.infer<typeof PersonalInboxItem>;

export const PersonalInboxItemParams = z.object({ itemId: InboxItemId });
export type PersonalInboxItemParams = z.infer<typeof PersonalInboxItemParams>;

export const ListPersonalInboxQuery = z.object({
  state: InboxItem.shape.state.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListPersonalInboxQuery = z.infer<typeof ListPersonalInboxQuery>;
export const ListPersonalInboxResponse = z.object({ items: z.array(PersonalInboxItem), maxBytes: z.number().int().min(1) });
export type ListPersonalInboxResponse = z.infer<typeof ListPersonalInboxResponse>;
export const listPersonalInboxRoute = { method: 'GET', path: '/api/me/inbox/items' } as const satisfies ApiRoute;

export const GetPersonalInboxItemResponse = z.object({ item: PersonalInboxItem });
export type GetPersonalInboxItemResponse = z.infer<typeof GetPersonalInboxItemResponse>;
export const getPersonalInboxItemRoute = { method: 'GET', path: '/api/me/inbox/items/:itemId' } as const satisfies ApiRoute;

/** The upload's file name travels in `?name=` (or `x-file-name`); the body is the file itself. */
export const UploadPersonalInboxQuery = z.object({ name: z.string().trim().min(1).max(INBOX_NAME_MAX).optional() });
export type UploadPersonalInboxQuery = z.infer<typeof UploadPersonalInboxQuery>;
export const PersonalInboxItemResponse = z.object({ item: PersonalInboxItem, duplicate: z.boolean() });
export type PersonalInboxItemResponse = z.infer<typeof PersonalInboxItemResponse>;
export const uploadPersonalInboxRoute = { method: 'POST', path: '/api/me/inbox/items' } as const satisfies ApiRoute;

export const CreatePersonalInboxNoteRequest = z.strictObject({
  title: z.string().trim().min(1).max(INBOX_NAME_MAX).optional(),
  text: z.string().trim().min(1).max(INBOX_NOTE_MAX_CHARS),
});
export type CreatePersonalInboxNoteRequest = z.infer<typeof CreatePersonalInboxNoteRequest>;
export const createPersonalInboxNoteRoute = { method: 'POST', path: '/api/me/inbox/notes' } as const satisfies ApiRoute;

/** Release a held item (the owner decides), discard it, or put a failed one back in the queue. */
export const PersonalInboxActionResponse = z.object({ item: PersonalInboxItem });
export type PersonalInboxActionResponse = z.infer<typeof PersonalInboxActionResponse>;
export const releasePersonalInboxRoute = { method: 'POST', path: '/api/me/inbox/items/:itemId/release' } as const satisfies ApiRoute;
export const discardPersonalInboxRoute = { method: 'POST', path: '/api/me/inbox/items/:itemId/discard' } as const satisfies ApiRoute;
export const retryPersonalInboxRoute = { method: 'POST', path: '/api/me/inbox/items/:itemId/retry' } as const satisfies ApiRoute;

/**
 * Send to team: a copy of the original is dropped into the named team's inbox as the person (the team's own rules apply: its holds, its size cap, its review
 * mode). The personal item stays. The person must be able to post in that team; a guest has no Personal inbox at all.
 */
export const SendPersonalInboxToTeamRequest = z.strictObject({ teamSlug: TeamSlug, teamOnly: z.boolean().default(false) });
export type SendPersonalInboxToTeamRequest = z.infer<typeof SendPersonalInboxToTeamRequest>;
export const SendPersonalInboxToTeamResponse = z.object({ teamItemId: InboxItemId, duplicate: z.boolean() });
export type SendPersonalInboxToTeamResponse = z.infer<typeof SendPersonalInboxToTeamResponse>;
export const sendPersonalInboxToTeamRoute = { method: 'POST', path: '/api/me/inbox/items/:itemId/send-to-team' } as const satisfies ApiRoute;
