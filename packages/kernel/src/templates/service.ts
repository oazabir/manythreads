import { fileURLToPath } from 'node:url';
import type { PluginTemplates } from '@manythreads/sdk';
import type { Recipe, TeamTemplate } from '@manythreads/shared';
import { loadSetupProfile, loadTemplates } from './load.ts';
import { loadRecipes } from './recipes.ts';

/** `templates/` at the repository root unless `MANYTHREADS_TEMPLATES_DIR` says otherwise. */
export const defaultTemplatesDir = (): string =>
  process.env['MANYTHREADS_TEMPLATES_DIR'] ?? fileURLToPath(new URL('../../../../templates/', import.meta.url));

/**
 * `ctx.templates` for plugins: the shipped templates, validated by `loadTemplates` and read once on first use (a failed read is
 * not cached, so a fixed file is picked up by the next call).
 */
export function createTemplateService(dir: string | (() => string) = defaultTemplatesDir): PluginTemplates {
  let loaded: Promise<readonly TeamTemplate[]> | undefined;
  const list = (): Promise<readonly TeamTemplate[]> => {
    loaded ??= loadTemplates(typeof dir === 'function' ? dir() : dir);
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  };
  let profile: ReturnType<PluginTemplates['setupProfile']> | undefined;
  let recipes: Promise<readonly Recipe[]> | undefined;
  return {
    list,
    get: async (id) => (await list()).find((t) => t.id === id),
    recipes: () => {
      recipes ??= loadRecipes(typeof dir === 'function' ? dir() : dir);
      recipes.catch(() => {
        recipes = undefined;
      });
      return recipes;
    },
    setupProfile: () => {
      profile ??= loadSetupProfile(typeof dir === 'function' ? dir() : dir);
      profile.catch(() => {
        profile = undefined;
      });
      return profile;
    },
  };
}
