import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { EntityLinkId, TeamId } from '../ids.ts';

// Entity links (PLAN.md A.1 `entity_links`, kernel services of SPEC §3). Types match the CHECKs of kernel migration 0013.

/** The kinds of thing a link can join. */
export const EntityType = z.enum(['message', 'thread', 'task', 'page', 'bot', 'file']);
export type EntityType = z.infer<typeof EntityType>;

/** `type + id` of one entity. */
export const EntityRef = z.object({ type: EntityType, id: z.uuid() });
export type EntityRef = z.infer<typeof EntityRef>;

/**
 * What a link means, lowercase snake_case: `mentions` (a message names an entity), `attached` (a file on a message),
 * `related`, `created_from` (a task made from a message), ... The set is open: plugins add their own.
 */
export const EntityLinkKind = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'must be lowercase letters, digits and underscores');
export type EntityLinkKind = z.infer<typeof EntityLinkKind>;

/** A link from `src` to `dst` as the services return it (the stored row without its column prefixes). */
export const EntityLinkView = z.object({
  id: EntityLinkId,
  teamId: TeamId,
  src: EntityRef,
  dst: EntityRef,
  kind: EntityLinkKind,
  createdAt: IsoDateTime,
});
export type EntityLinkView = z.infer<typeof EntityLinkView>;

/** What a resolver returns for an entity the caller may see: enough to draw a chip or a list row. */
export const EntitySummary = z.object({
  type: EntityType,
  id: z.uuid(),
  title: z.string(),
  /** A short second line (channel name, status, size), or null. */
  subtitle: z.string().nullable(),
  /** Where the client opens it (`?panel=thread:<id>`, a route), or null. */
  href: z.string().nullable(),
});
export type EntitySummary = z.infer<typeof EntitySummary>;

export const LinkDirection = z.enum(['out', 'in', 'both']);
export type LinkDirection = z.infer<typeof LinkDirection>;
