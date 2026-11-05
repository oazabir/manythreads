import { z } from 'zod';

// The routine contract at `routines/<slug>.yaml` (SPEC §6.5): a name, a prompt and where its output goes. The scheduled jobs plugin reads it when a schedule fires; the recipe
// gallery (entities/recipe.ts) checks the ones it ships with the same schema, so a recipe cannot ship a contract the scheduler would refuse.
export const RoutineContract = z.object({
  name: z.string().min(1).max(80),
  prompt: z.string().min(1).max(20_000).optional(),
  output: z.object({
    page: z
      .string()
      .max(300, 'the output page path is at most 300 characters')
      .regex(/^pages\//, 'the output page lives under pages/')
      .refine((p) => !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), 'the output page path must not contain empty, . or .. parts'),
    mode: z.enum(['create', 'replace', 'append']).default('replace'),
  }),
});
export type RoutineContract = z.infer<typeof RoutineContract>;
