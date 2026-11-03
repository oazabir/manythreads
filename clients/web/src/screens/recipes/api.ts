import {
  InstallRecipeRequest,
  InstallRecipeResponse,
  ListRecipesResponse,
  installRecipeRoute,
  listRecipesRoute,
} from '@manythreads/shared';
import { call } from '../../api/client';

/*
 * What the recipe gallery asks of the server (PLAN P18-01). Installing a recipe never changes the team by itself: the server files one proposal per file and a
 * team lead or workspace admin applies them. Every refusal (already installed, already waiting, archived team) comes back worded for a person, and the screen shows it as is.
 */

export const fetchRecipes = (slug: string) => call(listRecipesRoute, { response: ListRecipesResponse }, undefined, { slug });

export const installRecipe = (slug: string, recipeId: string) =>
  call(installRecipeRoute, { request: InstallRecipeRequest, response: InstallRecipeResponse }, InstallRecipeRequest.parse({}), { slug, recipeId });
