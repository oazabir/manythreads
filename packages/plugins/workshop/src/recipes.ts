import { conflict, forbidden, json, notFound, requireTeam, route, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import {
  InstallRecipeRequest,
  InstallRecipeResponse,
  ListRecipesResponse,
  RecipeCard,
  RecipeParams,
  RoutineContract,
  botEvalSetPath,
  installRecipeRoute,
  listRecipesRoute,
  parseBotEvalSet,
  parseBotMd,
  recipeCategoryLabel,
  recipePaths,
  type Recipe,
} from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { plainTool } from './labels.ts';

// The recipe gallery (PLAN P18-01, docs/plugins/workshop.md "The recipe gallery"). The recipes are files on disk (`templates/recipes/`, read and checked by the kernel's
// `ctx.templates.recipes()`); this file is the two routes that show them to a team and install one. Installing changes nothing in the team's repository: it FILES PROPOSALS
// (docs/plugins/proposals.md), one per file, as the signed-in person, so the usual rule decides who may apply them (a bot is added by a workspace admin, the rest by a lead
// or an admin) and each person reads the lines before anything is committed. The schedule is a rhythm, which a lead turns on once the bot exists.

const WRITE_LIMIT = { limit: 20, windowMs: 60_000 } as const;
const READ_LIMIT = { limit: 600, windowMs: 60_000 } as const;

/** The recipe as the card shows it. Everything comes from files the loader already checked, so a parse failure here is a bug, not input. */
function describe(recipe: Recipe): Omit<RecipeCard, 'state' | 'openProposals' | 'scheduled'> {
  const botPath = `bots/${recipe.botSlug}/BOT.md`;
  const bot = parseBotMd(recipe.files[botPath] ?? '');
  if (!bot.ok) throw new Error(`recipe ${recipe.id}: ${botPath} does not load: ${bot.failure.message}`);
  const fm = bot.frontmatter;
  const set = parseBotEvalSet(recipe.files[botEvalSetPath(recipe.botSlug, fm.evals?.set ?? '')] ?? '');
  const routine = RoutineContract.safeParse(parseYaml(recipe.files[`routines/${recipe.id}.yaml`] ?? ''));
  if (!set.ok || !routine.success) throw new Error(`recipe ${recipe.id}: its scenario set or routine does not load`);
  return {
    id: recipe.id,
    name: recipe.name,
    summary: recipe.summary,
    category: recipe.category,
    categoryLabel: recipeCategoryLabel(recipe.category),
    schedule: recipe.schedule,
    channels: recipe.channels,
    needs: recipe.needs,
    bot: { slug: recipe.botSlug, name: fm.name, kind: fm.kind, runtime: fm.runtime },
    abilities: (fm.capabilities?.native ?? []).map(plainTool),
    outputPage: routine.data.output.page,
    evals: { cases: set.set.cases.length, minScore: fm.evals?.minScore ?? 0 },
    paths: recipePaths(recipe),
  };
}

type Standing = { bots: Set<string>; open: Map<string, number>; scheduled: Set<string> };

/** What the team already has of the gallery: bots by slug, open proposals by path, and routine contracts that have a schedule. One statement each, for all recipes. */
async function standing(tx: PluginTx, team: TeamRow, recipes: readonly Recipe[]): Promise<Standing> {
  const paths = recipes.flatMap(recipePaths);
  const bots = (await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE team_id = $1::uuid AND slug = ANY ($2::text[])', [team.id, recipes.map((r) => r.botSlug)])).rows;
  const open = (
    await tx.query<{ path: string; n: string }>("SELECT path, count(*) AS n FROM app.proposals WHERE team_id = $1::uuid AND status = 'open' AND path = ANY ($2::text[]) GROUP BY path", [team.id, paths])
  ).rows;
  const scheduled = (
    await tx.query<{ contract_path: string }>('SELECT DISTINCT contract_path FROM app.rhythms WHERE team_id = $1::uuid AND contract_path = ANY ($2::text[])', [team.id, recipes.map((r) => `routines/${r.id}.yaml`)])
  ).rows;
  return { bots: new Set(bots.map((b) => b.slug)), open: new Map(open.map((o) => [o.path, Number(o.n)])), scheduled: new Set(scheduled.map((s) => s.contract_path)) };
}

function cardOf(recipe: Recipe, have: Standing): RecipeCard {
  const openProposals = recipePaths(recipe).reduce((n, p) => n + (have.open.get(p) ?? 0), 0);
  const installed = have.bots.has(recipe.botSlug);
  return RecipeCard.parse({
    ...describe(recipe),
    state: installed ? 'installed' : openProposals > 0 ? 'waiting' : 'available',
    openProposals,
    scheduled: have.scheduled.has(`routines/${recipe.id}.yaml`),
  });
}

/** Whoever may post in the team may propose, the same right as proposing from Files. */
const maySuggest = async (tx: PluginTx, team: TeamRow): Promise<boolean> => (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1::uuid, 'post') AS ok", [team.id])).rows[0]?.ok === true;

export function registerRecipeRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listRecipesRoute,
    rateLimit: READ_LIMIT,
    readOnly: true,
    schema: { response: ListRecipesResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const recipes = await ctx.templates.recipes();
      const have = await standing(tx, team, recipes);
      return json(ListRecipesResponse.parse({ recipes: recipes.map((r) => cardOf(r, have)), canInstall: !team.archived_at && (await maySuggest(tx, team)) }));
    }),
  });

  ctx.http.route({
    ...installRecipeRoute,
    rateLimit: WRITE_LIMIT,
    schema: { body: InstallRecipeRequest, response: InstallRecipeResponse },
    handler: route(async (req, tx) => {
      const { slug, recipeId } = RecipeParams.parse(req.params);
      InstallRecipeRequest.parse(req.body ?? {});
      const team = await requireTeam(tx, slug);
      if (team.archived_at) throw conflict('This team is archived, so nothing can be added to it');
      if (!(await maySuggest(tx, team))) throw forbidden('Only people who can post in this team can ask for a recipe');
      const recipes = await ctx.templates.recipes();
      const recipe = recipes.find((r) => r.id === recipeId);
      if (!recipe) throw notFound(`No recipe "${recipeId}"`);
      const before = cardOf(recipe, await standing(tx, team, recipes));
      if (before.state === 'installed') throw conflict(`This team already has a bot called ${recipe.botSlug}, so "${recipe.name}" is already in place. Open it on the Bots page.`);
      if (before.state === 'waiting') throw conflict(`"${recipe.name}" is already waiting for approval (${before.openProposals} ${before.openProposals === 1 ? 'proposal' : 'proposals'} on the Proposals page). Deal with those first.`);

      // One transaction as the person: every proposal is filed or none is. A refusal of the proposals plugin (a file that changes nothing, a bot name taken) rolls the rest back.
      const filed: Array<{ id: string; path: string; checksOk: boolean }> = [];
      for (const path of recipePaths(recipe)) {
        const isBot = path.endsWith('/BOT.md');
        const what = isBot ? `the ${before.bot.name} bot` : path.startsWith('routines/') ? `the schedule contract of "${recipe.name}"` : `the checks for the ${before.bot.name} bot`;
        const out = (await ctx.runs.invoke(tx, 'proposals.propose', {
          team: slug,
          path,
          op: 'put',
          content: recipe.files[path],
          title: `Recipe "${recipe.name}": add ${what}`.slice(0, 200),
          note: `From the recipe gallery: ${recipe.summary} It runs ${recipe.schedule.label.charAt(0).toLowerCase()}${recipe.schedule.label.slice(1)} once a lead turns its schedule on.`,
        })) as { ok: true; proposal: { id: string; path: string; checks: Array<{ ok?: boolean }> } } | { ok: false; message?: string; status?: number };
        if (!out.ok) {
          const reason = out.message ?? 'The proposal could not be made.';
          throw out.status === 403 ? forbidden(reason) : conflict(`${path}: ${reason}`);
        }
        filed.push({ id: out.proposal.id, path: out.proposal.path, checksOk: out.proposal.checks.every((c) => c.ok !== false) });
      }
      const after = cardOf(recipe, await standing(tx, team, recipes));
      return json(InstallRecipeResponse.parse({ recipe: after, proposals: filed }), 201);
    }),
  });
}
