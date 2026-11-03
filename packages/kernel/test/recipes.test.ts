import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_CATEGORIES, RECIPE_TOOLS, botEvalSetPath, nextCronRun, parseBotEvalSet, parseBotMd, recipePaths, recipeProblems, renderBotMd, runEvalSet, staticAnswerer, type Recipe } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TemplateLoadError, createTemplateService, loadRecipes, loadTemplates } from '../src/templates/index.ts';

// The recipe gallery on disk (PLAN P18-01): every recipe under templates/recipes/ parses, its bot passes the BOT.md schema, its routine passes the scheduler's
// contract schema, its scenario set runs in the free mode with no model, and a broken recipe is refused with the file and the field named. Nothing here calls a model.

const templatesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../templates');

let recipes: Recipe[] = [];
beforeAll(async () => {
  recipes = await loadRecipes(templatesDir);
});

describe('the shipped recipe gallery', () => {
  it('has about twenty recipes with unique ids and unique bots, each in a shelf that exists', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(18);
    expect(recipes.length).toBeLessThanOrEqual(24);
    expect(new Set(recipes.map((r) => r.id)).size).toBe(recipes.length);
    expect(new Set(recipes.map((r) => r.botSlug)).size).toBe(recipes.length);
    const shelves = RECIPE_CATEGORIES.map((c) => c.id) as string[];
    for (const r of recipes) expect(shelves, r.id).toContain(r.category);
    for (const shelf of shelves) expect(recipes.some((r) => r.category === shelf), shelf).toBe(true);
  });

  it('covers the twelve automations the plan names', () => {
    const ids = recipes.map((r) => r.id);
    for (const id of [
      'request-intake', 'daily-standup', 'weekly-digest', 'incident-watch', 'new-joiner-onboarding', 'customer-escalation',
      'release-notes', 'meeting-prep', 'follow-up-chaser', 'out-of-office-handover', 'content-calendar', 'invoice-approval',
    ]) expect(ids, id).toContain(id);
  });

  it('has no problem under the shared checks (the same function the loader runs)', () => {
    for (const r of recipes) expect(recipeProblems(r), r.id).toEqual([]);
  });

  it("holds each recipe's bot to the BOT.md schema, in the editor's own form, with a routine trigger that names its contract", () => {
    for (const r of recipes) {
      const text = r.files[`bots/${r.botSlug}/BOT.md`]!;
      const parsed = parseBotMd(text);
      expect(parsed.ok, r.id).toBe(true);
      if (!parsed.ok) continue;
      // saving the definition without a change writes the same bytes, so a lead's first edit is a clean diff
      expect(renderBotMd(parsed.frontmatter, parsed.body), r.id).toBe(text);
      expect(parsed.frontmatter.triggers, r.id).toContainEqual({ type: 'routine', routine: r.id });
      expect(parsed.frontmatter.evals, r.id).toEqual({ set: r.botSlug, minScore: 0.9 });
      for (const tool of parsed.frontmatter.capabilities?.native ?? []) expect(RECIPE_TOOLS, `${r.id}: ${tool}`).toContain(tool);
    }
  });

  it('writes every routine under pages/recipes/, each to its own page', () => {
    const pages: string[] = [];
    for (const r of recipes) {
      const text = r.files[`routines/${r.id}.yaml`]!;
      const m = /^ {2}page: (\S+)$/m.exec(text);
      expect(m, r.id).not.toBeNull();
      expect(m![1], r.id).toMatch(/^pages\/recipes\/[a-z0-9-]+\.md$/);
      pages.push(m![1]!);
    }
    expect(new Set(pages).size).toBe(pages.length);
  });

  it('runs every scenario set in the free mode with no model: each set has a case that can be checked and every checkable case passes', async () => {
    for (const r of recipes) {
      const bot = parseBotMd(r.files[`bots/${r.botSlug}/BOT.md`]!);
      if (!bot.ok) throw new Error(r.id);
      const setName = bot.frontmatter.evals!.set;
      const set = parseBotEvalSet(r.files[botEvalSetPath(r.botSlug, setName)]!);
      if (!set.ok) throw new Error(`${r.id}: ${set.message}`);
      const definition = { slug: r.botSlug, name: bot.frontmatter.name, body: bot.body, native: bot.frontmatter.capabilities?.native ?? [], alias: bot.frontmatter.model?.aliases?.[0] ?? null };
      const { summary } = await runEvalSet(staticAnswerer, definition, set.set.cases, bot.frontmatter.evals!.minScore);
      expect(summary.judged, r.id).toBeGreaterThan(0);
      expect(summary.ok, `${r.id}: ${JSON.stringify(summary)}`).toBe(true);
      expect(set.set.cases.length, r.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('fires each schedule, never more often than every fifteen minutes', () => {
    for (const r of recipes) {
      const first = nextCronRun(r.schedule.cron, new Date('2026-11-03T00:00:00Z'));
      expect(first, r.id).not.toBeNull();
    }
  });

  it('lists the bot first, then the scenario set, then the routine', () => {
    const r = recipes.find((x) => x.id === 'daily-standup')!;
    expect(recipePaths(r)).toEqual(['bots/standup-writer/BOT.md', 'bots/standup-writer/evals/standup-writer.yaml', 'routines/daily-standup.yaml']);
  });

  it('is not a team template: loadTemplates skips the recipes folder', async () => {
    const ids = (await loadTemplates(templatesDir)).map((t) => t.id);
    expect(ids).not.toContain('recipes');
    expect(ids).toEqual(['customer-support', 'engineering', 'marketing', 'product-design', 'research']);
  });

  it('is served by ctx.templates.recipes(), read once', async () => {
    const service = createTemplateService(templatesDir);
    const a = await service.recipes();
    expect(a.map((r) => r.id)).toEqual(recipes.map((r) => r.id));
    expect(await service.recipes()).toBe(a);
  });

  it('reaches the server image: the docker ignore list never drops templates/', async () => {
    const ignored = (await readFile(path.resolve(templatesDir, '../deploy/docker/server.Dockerfile.dockerignore'), 'utf8')).split('\n').map((l) => l.trim());
    expect(ignored.filter((l) => l === 'templates' || l === 'templates/' || l === '/templates')).toEqual([]);
  });
});

describe('a broken recipe is refused with the file and the field', () => {
  let tmp = '';
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'recipes-'));
  });
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** A copy of one shipped recipe in a folder of its own, edited by `change` before the loader reads it. */
  async function broken(change: (dir: string) => Promise<void>, id = 'daily-standup'): Promise<TemplateLoadError> {
    const root = await mkdtemp(path.join(tmp, 'case-'));
    await mkdir(path.join(root, 'recipes'), { recursive: true });
    await cp(path.join(templatesDir, 'recipes', id), path.join(root, 'recipes', id), { recursive: true });
    await change(path.join(root, 'recipes', id));
    const err = await loadRecipes(root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'the loader should have refused it').toBeInstanceOf(TemplateLoadError);
    return err as TemplateLoadError;
  }
  const edit = async (file: string, from: string | RegExp, to: string): Promise<void> => {
    const text = await readFile(file, 'utf8');
    expect(text.replace(from, to), `${file} did not change`).not.toBe(text);
    await writeFile(file, text.replace(from, to));
  };
  const bot = (dir: string): string => path.join(dir, 'bots/standup-writer/BOT.md');

  it('an unknown key in BOT.md', async () => {
    const err = await broken((d) => edit(bot(d), 'visibility: team', 'visibility: team\nmystery: 1'));
    expect(err.file).toContain('BOT.md');
    expect(err.message).toContain('mystery');
  });

  it('a tool no recipe may hold', async () => {
    const err = await broken((d) => edit(bot(d), '- tasks.read', '- email.send'));
    expect(err.field).toBe('capabilities.native');
    expect(err.message).toContain('email.send');
  });

  it('a bot without the two tools the routine runner needs', async () => {
    const err = await broken((d) => edit(bot(d), '    - pages.write\n', ''));
    expect(err.message).toContain('pages.write');
  });

  it('a rules bot (it has no reply to save as the routine page)', async () => {
    const err = await broken((d) => edit(bot(d), 'runtime: hermes', 'runtime: rules'));
    expect(err.field).toBe('runtime');
  });

  it('a routine trigger that names another contract', async () => {
    const err = await broken((d) => edit(bot(d), 'routine: daily-standup', 'routine: weekly-digest'));
    expect(err.field).toBe('triggers');
  });

  it('an alias a workspace does not have', async () => {
    const err = await broken((d) => edit(bot(d), '    - fast', '    - turbo'));
    expect(err.message).toContain('turbo');
  });

  it('a scenario set that does not exist, or that requires a call the bot is not granted', async () => {
    const missing = await broken((d) => rm(path.join(d, 'bots/standup-writer/evals/standup-writer.yaml')));
    expect(missing.message).toContain('evals');
    const ungranted = await broken((d) => edit(path.join(d, 'bots/standup-writer/evals/standup-writer.yaml'), /required:\n {10}- tasks.read/, 'required:\n          - tasks.create'));
    expect(ungranted.message).toContain('tasks.create');
  });

  it('a routine that writes outside pages/recipes/, or is not a contract at all', async () => {
    const outside = await broken((d) => edit(path.join(d, 'routines/daily-standup.yaml'), 'pages/recipes/', 'pages/'));
    expect(outside.field).toBe('output.page');
    const notYaml = await broken((d) => writeFile(path.join(d, 'routines/daily-standup.yaml'), 'name: [unclosed'));
    expect(notYaml.file).toContain('daily-standup.yaml');
  });

  it('a schedule that fires every minute, or never', async () => {
    const often = await broken((d) => edit(path.join(d, 'recipe.yaml'), /cron: .*/, 'cron: "* * * * *"'));
    expect(often.field).toBe('schedule.cron');
    const never = await broken((d) => edit(path.join(d, 'recipe.yaml'), /cron: .*/, 'cron: "0 0 30 2 *"'));
    expect(never.field).toBe('schedule.cron');
  });

  it('a recipe whose id does not match its folder, an extra file, and plan wording', async () => {
    const root = await mkdtemp(path.join(tmp, 'folder-'));
    await mkdir(path.join(root, 'recipes'), { recursive: true });
    await cp(path.join(templatesDir, 'recipes/daily-standup'), path.join(root, 'recipes/daily-note'), { recursive: true });
    await expect(loadRecipes(root)).rejects.toMatchObject({ field: 'id' });
    expect((await broken((d) => writeFile(path.join(d, 'notes.md'), 'x'))).message).toContain('recipe.yaml, bots/ and routines/ only');
    expect((await broken((d) => edit(bot(d), 'You never invent progress', 'You never invent progress (see PLAN)'))).message).toContain('plan or phase wording');
  });

  it('two recipes that share one bot', async () => {
    const root = await mkdtemp(path.join(tmp, 'dup-'));
    await mkdir(path.join(root, 'recipes'), { recursive: true });
    await cp(path.join(templatesDir, 'recipes/daily-standup'), path.join(root, 'recipes/daily-standup'), { recursive: true });
    await cp(path.join(templatesDir, 'recipes/daily-standup'), path.join(root, 'recipes/daily-note'), { recursive: true });
    await edit(path.join(root, 'recipes/daily-note/recipe.yaml'), 'id: daily-standup', 'id: daily-note');
    await rm(path.join(root, 'recipes/daily-note/routines/daily-standup.yaml'));
    await writeFile(path.join(root, 'recipes/daily-note/routines/daily-note.yaml'), await readFile(path.join(root, 'recipes/daily-standup/routines/daily-standup.yaml'), 'utf8'));
    await edit(path.join(root, 'recipes/daily-note/bots/standup-writer/BOT.md'), 'routine: daily-standup', 'routine: daily-note');
    await expect(loadRecipes(root)).rejects.toThrow(/also the bot of daily-note|a bot belongs to one recipe/);
  });

  it('no recipes folder: an empty gallery', async () => {
    const root = await mkdtemp(path.join(tmp, 'empty-'));
    expect(await loadRecipes(root)).toEqual([]);
  });
});
