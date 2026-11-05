import { z } from 'zod';
import { ProposalId } from '../../ids.ts';
import { RecipeCategory, RecipeId } from '../../entities/recipe.ts';

// The recipe gallery routes (PLAN P18-01; docs/plugins/workshop.md "The recipe gallery"). The gallery is read by anyone who can read the team; installing a recipe
// files proposals as the signed-in person, so the person's own rights decide who may apply them.

/**
 * Where a recipe stands in this team:
 *  - `available`   nothing of it is in the team and no proposal for it waits;
 *  - `waiting`     at least one proposal for one of its files is open;
 *  - `installed`   its bot is in the team (so a lead can turn its schedule on).
 */
export const RecipeState = z.enum(['available', 'waiting', 'installed']);
export type RecipeState = z.infer<typeof RecipeState>;

export const RecipeCard = z.object({
  id: RecipeId,
  name: z.string(),
  summary: z.string(),
  category: RecipeCategory,
  categoryLabel: z.string(),
  schedule: z.object({ cron: z.string(), label: z.string() }),
  channels: z.array(z.string()),
  needs: z.array(z.string()),
  bot: z.object({
    slug: z.string(),
    name: z.string(),
    kind: z.enum(['agent', 'automation']),
    /** `rules` runs without a model call at all. */
    runtime: z.enum(['hermes', 'rules']),
  }),
  /** What the bot is allowed to do, in plain words ("post messages"). */
  abilities: z.array(z.string()),
  /** Where the routine writes its result, e.g. `pages/digests/weekly.md`. */
  outputPage: z.string(),
  evals: z.object({ cases: z.number().int(), minScore: z.number() }),
  /** The repo paths installing the recipe proposes. */
  paths: z.array(z.string()),
  state: RecipeState,
  /** Proposals of this recipe that are open right now. */
  openProposals: z.number().int().min(0),
  /** The routine already has a schedule (a scheduled job with this recipe's contract). */
  scheduled: z.boolean(),
});
export type RecipeCard = z.infer<typeof RecipeCard>;

export const ListRecipesResponse = z.object({
  recipes: z.array(RecipeCard),
  /** Whether the signed-in person may install (a team member who can post, not a guest). */
  canInstall: z.boolean(),
});
export type ListRecipesResponse = z.infer<typeof ListRecipesResponse>;
export const listRecipesRoute = { method: 'GET', path: '/api/teams/:slug/recipes' } as const;

export const RecipeParams = z.object({ slug: z.string().min(1), recipeId: RecipeId });
export type RecipeParams = z.infer<typeof RecipeParams>;

export const InstallRecipeRequest = z.strictObject({});
export type InstallRecipeRequest = z.infer<typeof InstallRecipeRequest>;
export const InstallRecipeResponse = z.object({
  recipe: RecipeCard,
  proposals: z.array(z.object({ id: ProposalId, path: z.string(), checksOk: z.boolean() })),
});
export type InstallRecipeResponse = z.infer<typeof InstallRecipeResponse>;
export const installRecipeRoute = { method: 'POST', path: '/api/teams/:slug/recipes/:recipeId/install' } as const;
