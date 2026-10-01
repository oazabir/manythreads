import { z } from 'zod';
import { TeamId, WorkspaceId } from '../ids.ts';

/** A team template was applied: phase 3 creates its channels from the stored definition, phase 5 its bots. */
export const TeamTemplateAppliedEvent = z.object({
  type: z.literal('team.template.applied'),
  schemaVersion: z.literal(1),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  slug: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().positive(),
});
export type TeamTemplateAppliedEvent = z.infer<typeof TeamTemplateAppliedEvent>;
