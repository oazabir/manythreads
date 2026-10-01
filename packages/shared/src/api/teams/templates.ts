import { z } from 'zod';
import { TeamTemplate } from '../../entities/template.ts';

/** A template as the picker lists it: names as text, without the TEAM.md body. */
export const TemplateSummary = z.object({
  id: TeamTemplate.shape.id,
  name: TeamTemplate.shape.name,
  description: TeamTemplate.shape.description,
  version: TeamTemplate.shape.version,
  channels: z.array(z.string()),
  board: z.string(),
  bots: z.array(z.object({ slug: z.string(), name: z.string(), role: z.string(), automation: z.boolean() })),
  roleTags: z.array(z.string()),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const ListTemplatesResponse = z.object({ templates: z.array(TemplateSummary) });
export type ListTemplatesResponse = z.infer<typeof ListTemplatesResponse>;
export const listTemplatesRoute = { method: 'GET', path: '/api/templates' } as const;

export const GetTemplateResponse = z.object({ template: TeamTemplate });
export type GetTemplateResponse = z.infer<typeof GetTemplateResponse>;
export const getTemplateRoute = { method: 'GET', path: '/api/templates/:id' } as const;
