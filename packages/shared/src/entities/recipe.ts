import { z } from 'zod';
import { CronExpression } from './rhythm.ts';

// The recipe gallery (PLAN P18-01): a recipe is a ready automation a team can ask for. It is data on disk, `templates/recipes/<id>/`, made of
//   recipe.yaml                          the card: name, one-sentence summary, shelf, the suggested schedule, what the team needs to have
//   bots/<slug>/BOT.md                   the bot that does the work (an agent, or a rules bot that runs without a model)
//   bots/<slug>/evals/<set>.yaml         the scenario set that checks it
//   routines/<id>.yaml                   the routine contract the schedule runs (name, prompt, the page its output goes to)
// Installing a recipe files each of those files as a proposal in the team (docs/plugins/proposals.md), so a person with the right to approve
// reads every line before anything is committed. The schedule itself is a rhythm (docs/plugins/rhythms.md) that a lead turns on afterwards.

export const RecipeId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase slug');

/** The shelves of the gallery, in the order the screen draws them. */
export const RECIPE_CATEGORIES = [
  { id: 'requests', label: 'Requests and approvals' },
  { id: 'rhythm', label: 'Team rhythm' },
  { id: 'customers', label: 'Customers' },
  { id: 'engineering', label: 'Engineering' },
  { id: 'people', label: 'People' },
  { id: 'content', label: 'Content and meetings' },
] as const;
export const RecipeCategory = z.enum(['requests', 'rhythm', 'customers', 'engineering', 'people', 'content']);
export type RecipeCategory = z.infer<typeof RecipeCategory>;
export const recipeCategoryLabel = (id: RecipeCategory): string => RECIPE_CATEGORIES.find((c) => c.id === id)?.label ?? id;

/** A file a recipe puts in the team repo: its bot, the bot's scenario set and its routine contract. */
export const RECIPE_FILE_PATH = /^(bots\/[a-z][a-z0-9-]{0,39}\/(BOT\.md|evals\/[a-z0-9][a-z0-9._-]{0,63}\.yaml)|routines\/[a-z][a-z0-9-]{0,39}\.yaml)$/;
export const RECIPE_FILE_MAX_CHARS = 64 * 1024;
export const RECIPE_FILES_MAX = 8;

export const Recipe = z
  .strictObject({
    id: RecipeId,
    name: z.string().min(1).max(80),
    /** One sentence a person reads on the card: what the recipe does for the team. */
    summary: z.string().min(1).max(220),
    category: RecipeCategory,
    version: z.number().int().positive(),
    /** When the routine runs. `cron` is in UTC; `label` is the same thing in words ("Weekdays at 09:00 UTC"). */
    schedule: z.strictObject({ cron: CronExpression, label: z.string().min(1).max(80) }),
    /** Channels the recipe's bot reads or posts in. A recipe never creates a channel; the card says which ones it expects. */
    channels: z.array(z.string().regex(/^#[a-z0-9][a-z0-9-]{0,62}$/, "channel name like '#requests'")).max(6),
    /** What the team needs before the recipe is useful, in plain sentences ("A channel called #requests"). */
    needs: z.array(z.string().min(1).max(160)).max(6),
    botSlug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase slug'),
    /** Repo path to file text. Read from the recipe's folder by the loader; never part of recipe.yaml. */
    files: z
      .record(z.string().regex(RECIPE_FILE_PATH, 'bots/<slug>/BOT.md, bots/<slug>/evals/<set>.yaml or routines/<id>.yaml'), z.string().min(1).max(RECIPE_FILE_MAX_CHARS))
      .refine((f) => Object.keys(f).length <= RECIPE_FILES_MAX, { message: `at most ${RECIPE_FILES_MAX} files` }),
  })
  .superRefine((r, ctx) => {
    const need = [`bots/${r.botSlug}/BOT.md`, `routines/${r.id}.yaml`];
    for (const path of need) if (r.files[path] === undefined) ctx.addIssue({ code: 'custom', path: ['files'], message: `${path} is missing` });
    for (const path of Object.keys(r.files)) {
      const bot = /^bots\/([^/]+)\//.exec(path);
      if (bot && bot[1] !== r.botSlug) ctx.addIssue({ code: 'custom', path: ['files', path], message: `a recipe has one bot, "${r.botSlug}"` });
      const routine = /^routines\/([^/]+)\.yaml$/.exec(path);
      if (routine && routine[1] !== r.id) ctx.addIssue({ code: 'custom', path: ['files', path], message: `the routine file must be routines/${r.id}.yaml` });
    }
  });
export type Recipe = z.infer<typeof Recipe>;

/** The repo paths a recipe writes, the bot first. */
export const recipePaths = (r: Pick<Recipe, 'files' | 'botSlug'>): string[] => {
  const first = `bots/${r.botSlug}/BOT.md`;
  return [first, ...Object.keys(r.files).filter((p) => p !== first).sort()];
};
