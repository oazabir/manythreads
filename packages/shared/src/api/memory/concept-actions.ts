import { z } from 'zod';
import { TeamSlug } from '../teams/common.ts';

export const ConceptPathParams = z.object({ slug: TeamSlug, path: z.string().min(1).max(500) });
export type ConceptPathParams = z.infer<typeof ConceptPathParams>;

export const RebuildConceptsPathParams = z.object({ slug: TeamSlug });
export type RebuildConceptsPathParams = z.infer<typeof RebuildConceptsPathParams>;

export const RebuildConceptsResponse = z.object({ concepts: z.number().int().nonnegative() });
export type RebuildConceptsResponse = z.infer<typeof RebuildConceptsResponse>;
export const rebuildConceptsRoute = { method: 'POST', path: '/api/teams/:slug/memory/concepts/rebuild' } as const;

export const ConfirmConceptResponse = z.object({ ok: z.boolean() });
export type ConfirmConceptResponse = z.infer<typeof ConfirmConceptResponse>;
export const confirmConceptRoute = { method: 'POST', path: '/api/teams/:slug/memory/concepts/:path/confirm' } as const;

export const DeprecateConceptResponse = z.object({ ok: z.boolean() });
export type DeprecateConceptResponse = z.infer<typeof DeprecateConceptResponse>;
export const deprecateConceptRoute = { method: 'POST', path: '/api/teams/:slug/memory/concepts/:path/deprecate' } as const;