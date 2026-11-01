import { z } from 'zod';
import { ChannelId } from '../../ids.ts';

/*
 * A person's own view of the channel groups in the sidebar (slot 40 of the contract), kept per team on the server so it follows them from one
 * device to the next: which channels they starred, how the groups are sorted, whether quiet channels are folded away, and the order of the groups.
 * Only this person reads or changes it; nothing here is shared with the team.
 */

/** The most channels one person can star in one team. */
export const MAX_STARRED_CHANNELS = 100;
/** A channel with no message for this many days counts as idle when "Hide channels idle for 30 days" is on. */
export const IDLE_CHANNEL_DAYS = 30;
/** More groups than this are never listed in a saved order (a team has a handful). */
export const MAX_SIDEBAR_GROUP_ORDER = 200;

/** `team`: the order the team set (the default, as the sidebar always was). `recent`: the channel with the newest message first. `name`: alphabetical. */
export const SidebarSort = z.enum(['team', 'recent', 'name']);
export type SidebarSort = z.infer<typeof SidebarSort>;

/**
 * The saved view. `groupOrder` lists group ids (a group's id, or the team's id for channels that sit in no group, which the directory shows as
 * one group called "Channels"); a group missing from the list keeps its place after the listed ones.
 */
export const SidebarPrefs = z.object({
  starred: z.array(ChannelId).max(MAX_STARRED_CHANNELS),
  sort: SidebarSort,
  hideIdle: z.boolean(),
  groupOrder: z.array(z.uuid()).max(MAX_SIDEBAR_GROUP_ORDER),
});
export type SidebarPrefs = z.infer<typeof SidebarPrefs>;

/** What a person who never changed anything sees. */
export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = { starred: [], sort: 'team', hideIdle: false, groupOrder: [] };

export const GetSidebarPrefsResponse = SidebarPrefs;
export type GetSidebarPrefsResponse = z.infer<typeof GetSidebarPrefsResponse>;
export const getSidebarPrefsRoute = { method: 'GET', path: '/api/teams/:slug/sidebar-prefs' } as const;

/**
 * Change any of the fields; the ones left out stay as they are. Stars are sent as changes, not as a whole list, so two tabs or devices cannot undo
 * each other's stars: `starAdd` channels to star (of this team, ones the person can see; at most 100 stars in all) and `starRemove` channels to
 * unstar. `groupOrder` replaces the whole order (ids of this team's groups, each once). The response is the saved view.
 */
export const PutSidebarPrefsRequest = z
  .strictObject({
    starAdd: z.array(ChannelId).max(MAX_STARRED_CHANNELS).optional(),
    starRemove: z.array(ChannelId).max(MAX_STARRED_CHANNELS).optional(),
    sort: SidebarSort.optional(),
    hideIdle: z.boolean().optional(),
    groupOrder: z.array(z.uuid()).max(MAX_SIDEBAR_GROUP_ORDER).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to change' });
export type PutSidebarPrefsRequest = z.infer<typeof PutSidebarPrefsRequest>;
export const PutSidebarPrefsResponse = SidebarPrefs;
export type PutSidebarPrefsResponse = z.infer<typeof PutSidebarPrefsResponse>;
export const putSidebarPrefsRoute = { method: 'PUT', path: '/api/teams/:slug/sidebar-prefs' } as const;
