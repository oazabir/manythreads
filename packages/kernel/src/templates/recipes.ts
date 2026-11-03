import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RECIPE_FILE_MAX_CHARS, Recipe, recipeProblems } from '@manythreads/shared';
import { parse } from 'yaml';
import { TemplateLoadError } from './load.ts';

// The recipe gallery on disk (PLAN P18-01): `<templates>/recipes/<id>/` with recipe.yaml, bots/<slug>/BOT.md, bots/<slug>/evals/<set>.yaml and routines/<id>.yaml.
// `loadRecipes` reads every folder, builds the `Recipe`, and refuses the first one that fails the shared checks (`recipeProblems`), naming the file and the field.
// A broken recipe stops the loader, never reaches a team: the gallery is made of files a person is going to be asked to approve.

/** Folder of the recipes inside the templates folder. `loadTemplates` skips it; it is not a team template. */
export const RECIPES_DIR = 'recipes';

const dirents = async (dir: string): Promise<Dirent[]> => {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new TemplateLoadError(dir, null, `cannot read (${err instanceof Error ? err.message : String(err)})`);
  }
};

const readText = async (file: string): Promise<string> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new TemplateLoadError(file, null, `cannot read (${err instanceof Error ? err.message : String(err)})`);
  }
  if (text.length > RECIPE_FILE_MAX_CHARS) throw new TemplateLoadError(file, null, `is larger than ${RECIPE_FILE_MAX_CHARS / 1024} KB`);
  return text;
};

/** The files of one recipe folder, keyed by their path in the team repo. Anything else in the folder is a typo and is refused. */
async function readRecipeFiles(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await dirents(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'recipe.yaml' && entry.isFile()) continue;
    if (entry.name === 'bots' && entry.isDirectory()) {
      for (const slug of await dirents(full)) {
        if (!slug.isDirectory()) throw new TemplateLoadError(path.join(full, slug.name), null, 'only bot folders belong in bots/');
        for (const f of await dirents(path.join(full, slug.name))) {
          const file = path.join(full, slug.name, f.name);
          if (f.isFile() && f.name === 'BOT.md') files[`bots/${slug.name}/BOT.md`] = await readText(file);
          else if (f.isDirectory() && f.name === 'evals') {
            for (const set of await dirents(file)) {
              if (!set.isFile() || !set.name.endsWith('.yaml')) throw new TemplateLoadError(path.join(file, set.name), null, 'only <set>.yaml scenario sets belong in evals/');
              files[`bots/${slug.name}/evals/${set.name}`] = await readText(path.join(file, set.name));
            }
          } else throw new TemplateLoadError(file, null, 'a recipe bot folder holds BOT.md and evals/<set>.yaml only');
        }
      }
      continue;
    }
    if (entry.name === 'routines' && entry.isDirectory()) {
      for (const f of await dirents(full)) {
        if (!f.isFile() || !f.name.endsWith('.yaml')) throw new TemplateLoadError(path.join(full, f.name), null, 'only <id>.yaml routine contracts belong in routines/');
        files[`routines/${f.name}`] = await readText(path.join(full, f.name));
      }
      continue;
    }
    throw new TemplateLoadError(full, null, 'a recipe folder holds recipe.yaml, bots/ and routines/ only');
  }
  return files;
}

/**
 * Every recipe under `<dir>/recipes/`, sorted by id. Throws `TemplateLoadError` on the first problem (file and field named). Ids must match their folder, and a bot slug
 * belongs to one recipe only (two recipes with one bot would collide in a team that installs both). No recipes folder: an empty list.
 */
export async function loadRecipes(dir: string): Promise<Recipe[]> {
  const root = path.join(dir, RECIPES_DIR);
  const recipes: Recipe[] = [];
  const bots = new Map<string, string>();
  for (const entry of (await dirents(root)).filter((e) => e.isDirectory())) {
    const folder = path.join(root, entry.name);
    const yamlFile = path.join(folder, 'recipe.yaml');
    let raw: unknown;
    try {
      raw = parse(await readText(yamlFile));
    } catch (err) {
      if (err instanceof TemplateLoadError) throw err;
      throw new TemplateLoadError(yamlFile, null, `invalid YAML (${err instanceof Error ? err.message : String(err)})`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateLoadError(yamlFile, null, 'expected a mapping');
    if ('files' in raw) throw new TemplateLoadError(yamlFile, 'files', 'come from the folder, remove it from recipe.yaml');
    const result = Recipe.safeParse({ ...raw, files: await readRecipeFiles(folder) });
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.map(String).join('.') || null;
      throw new TemplateLoadError(issue?.path[0] === 'files' && typeof issue.path[1] === 'string' ? path.join(folder, ...issue.path[1].split('/')) : yamlFile, field, issue?.message ?? 'invalid recipe');
    }
    const recipe = result.data;
    if (recipe.id !== entry.name) throw new TemplateLoadError(yamlFile, 'id', `"${recipe.id}" must match folder name "${entry.name}"`);
    const problem = recipeProblems(recipe)[0];
    if (problem) throw new TemplateLoadError(path.join(folder, ...problem.file.split('/')), problem.field, problem.message);
    const prior = bots.get(recipe.botSlug);
    if (prior) throw new TemplateLoadError(yamlFile, 'botSlug', `"${recipe.botSlug}" is also the bot of ${prior}; a bot belongs to one recipe`);
    bots.set(recipe.botSlug, recipe.id);
    recipes.push(recipe);
  }
  return recipes;
}
