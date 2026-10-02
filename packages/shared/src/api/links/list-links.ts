import { z } from 'zod';
import { EntityLinkKind, EntityLinkView, EntitySummary, EntityType, LinkDirection } from '../../entities/entity-link.ts';

export const ListLinksRequest = z.strictObject({
  type: EntityType,
  id: z.uuid(),
  direction: LinkDirection.default('both'),
  kind: EntityLinkKind.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListLinksRequest = z.infer<typeof ListLinksRequest>;

/** One link the caller can see, with the entity at its other end resolved. Links whose other end the caller may not see are left out. */
export const ListedLink = z.object({
  link: EntityLinkView,
  /** `out`: the asked-about entity is the source; `in`: it is the destination. */
  direction: z.enum(['out', 'in']),
  other: EntitySummary,
});
export type ListedLink = z.infer<typeof ListedLink>;

export const ListLinksResponse = z.object({ links: z.array(ListedLink) });
export type ListLinksResponse = z.infer<typeof ListLinksResponse>;
export const listLinksRoute = { method: 'GET', path: '/api/links' } as const;
