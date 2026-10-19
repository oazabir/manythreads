import { z } from 'zod';
import { MemoryConceptSummary } from '../../entities/memory.ts';
import { TeamSlug } from '../teams/common.ts';

export const ListMemoryConceptsPathParams = z.object({ slug: TeamSlug });
export type ListMemoryConceptsPathParams = z.infer<typeof ListMemoryConceptsPathParams>;

export const ListMemoryConceptsResponse = z.object({
  items: z.array(MemoryConceptSummary),
});
export type ListMemoryConceptsResponse = z.infer<typeof ListMemoryConceptsResponse>;
export const listMemoryConceptsRoute = { method: 'GET', path: '/api/teams/:slug/memory/concepts' } as const;