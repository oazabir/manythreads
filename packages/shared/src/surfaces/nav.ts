import { z } from 'zod';
import type { ApiRoute } from '../api/client/route.ts';

/** A counter the sidebar can show next to an entry, read from a named source (`threads.unread`). */
export const NavBadge = z.strictObject({
  /** Which counter feeds the badge. The shell resolves it; an unknown or missing source shows nothing. */
  source: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/),
  /** `unread` is the loud blue pill, `quiet` the grey one (approvals, noisy channels). */
  tone: z.enum(['unread', 'quiet']).default('unread'),
});
export type NavBadge = z.infer<typeof NavBadge>;

/**
 * One entry a plugin contributes to the sidebar (`surface.nav`), sorted by `order`.
 *  - `item`: a row that opens `path`.
 *  - `group-list`: the channel groups with their channels (rendered by the shell from the channels feed).
 *  - `header`: a section heading that opens `path`; the entries it owns follow it.
 * `path` is relative to the team: `/files` opens `/t/<team>/files`; `~/roster` opens the team's settings page
 * `/settings/team/<team>/roster`.
 */
export const NavContribution = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  order: z.number().int().nonnegative(),
  label: z.string().min(1).max(40),
  kind: z.enum(['item', 'group-list', 'header']),
  path: z.string().startsWith('/').or(z.string().startsWith('~/')).optional(),
  icon: z.enum(['files', 'boards', 'threads', 'approvals', 'dm']).optional(),
  /** Shown beside the entry while its section has nothing in it (product copy: "No files yet"). */
  emptyState: z.string().min(1).max(60).optional(),
  badge: NavBadge.optional(),
  /** A guest sees an entry only when it says so; the channel groups are the one entry guests keep. */
  guests: z.boolean().optional(),
});
export type NavContribution = z.infer<typeof NavContribution>;

/** Contributions in the order the sidebar shows them. Equal orders keep their given order. */
export const sortNav = (items: readonly NavContribution[]): NavContribution[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.order - b.item.order || a.index - b.index)
    .map((x) => x.item);

/** A channel as the sidebar lists it. */
export const NavChannel = z.object({
  id: z.string(),
  name: z.string().min(1),
  isPrivate: z.boolean().default(false),
  unread: z.number().int().nonnegative().default(0),
});
export type NavChannel = z.infer<typeof NavChannel>;

export const NavChannelGroup = z.object({
  id: z.string(),
  name: z.string().min(1),
  channels: z.array(NavChannel),
});
export type NavChannelGroup = z.infer<typeof NavChannelGroup>;

/** What the sidebar needs to draw the channel groups of one team (a guest gets only the channels granted to them). */
export const NavChannelDirectory = z.object({ groups: z.array(NavChannelGroup) });
export type NavChannelDirectory = z.infer<typeof NavChannelDirectory>;
export const navChannelDirectoryRoute = { method: 'GET', path: '/api/teams/:slug/channels' } as const satisfies ApiRoute;
