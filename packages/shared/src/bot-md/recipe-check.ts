import { parse as parseYaml } from 'yaml';
import { LlmAliasName } from '../entities/llm.ts';
import { Recipe } from '../entities/recipe.ts';
import { RoutineContract } from '../entities/routine.ts';
import { nextCronRun, parseCron } from '../common/cron.ts';
import { botEvalSetPath, parseBotEvalSet } from './evals.ts';
import { capabilityMeets } from './eval-run.ts';
import { compileGate } from './gate.ts';
import { MAX_CONVERSATION_PROMPTS } from './frontmatter.ts';
import { parseBotMd } from './render.ts';

// What a recipe has to satisfy before it may sit in the gallery (PLAN P18-01). The loader (kernel `loadRecipes`), the gallery routes and the tests all call
// `recipeProblems`, so a recipe that passes here is one the bots loader, the scheduled-jobs scheduler and the eval harness will each accept. Pure: no files, no database,
// no model.

/**
 * The platform tools a recipe's bot may hold. Only tools that exist today and that read or write inside manythreads: no outside tool (mail, shell, cluster), no
 * file write outside `pages/`, no state change of someone else's card (`tasks.complete`, `tasks.handoff`). `messages.post` and `pages.write` are required: the
 * routine runner posts the link and saves the page as the bot, through these two grants.
 */
export const RECIPE_TOOLS: readonly string[] = [
  'messages.post',
  'messages.search',
  'pages.write',
  'files.search',
  'knowledge.search',
  'memory.recall',
  'tasks.read',
  'tasks.create',
];

/** Where a recipe's routine may write: one folder, so a recipe never overwrites a page a person made. */
export const RECIPE_PAGE_PREFIX = 'pages/recipes/';

/** The shortest gap between two runs of a recipe's schedule, in minutes: a run may call a model, so a recipe may not be set to fire every minute. */
export const RECIPE_MIN_GAP_MINUTES = 15;

export interface RecipeProblem {
  /** The file of the recipe folder the problem is in (`recipe.yaml`, `bots/x/BOT.md`, `routines/x.yaml`). */
  file: string;
  /** The field, or null for the whole file. */
  field: string | null;
  message: string;
}

// The retired product name is built, not written, so that no file of the repository holds it.
const RETIRED = String.fromCharCode(109, 97, 106, 108, 105, 115);
const INTERNAL_WORDING = /\bP\d{1,2}-\d{2}\b|\bPLAN\b|\bSPEC\b|\bphase \d\b|\{\{|TODO|FIXME/;

/** Every reason this recipe cannot be offered. Empty: it can. */
export function recipeProblems(recipe: Recipe): RecipeProblem[] {
  const out: RecipeProblem[] = [];
  const add = (file: string, field: string | null, message: string): void => void out.push({ file, field, message });

  // plain words: a person reads the card, the bot's page and the routine
  for (const [path, text] of Object.entries(recipe.files)) {
    if (text.toLowerCase().includes(RETIRED)) add(path, null, 'uses the retired product name');
    if (INTERNAL_WORDING.test(text)) add(path, null, 'has plan or phase wording, a placeholder or a TODO; write for the person who reads it');
  }
  for (const field of ['name', 'summary'] as const) {
    if (INTERNAL_WORDING.test(recipe[field])) add('recipe.yaml', field, 'has plan or phase wording');
  }

  // the schedule
  try {
    parseCron(recipe.schedule.cron);
    const first = nextCronRun(recipe.schedule.cron, new Date('2026-01-01T00:00:00Z'));
    const second = first === null ? null : nextCronRun(recipe.schedule.cron, first);
    if (first === null || second === null) add('recipe.yaml', 'schedule.cron', 'never fires');
    else {
      // the smallest gap among the next 40 runs (a schedule such as "every 30 minutes in office hours" has long gaps and short ones)
      let gap = Infinity;
      let prev = first;
      for (let i = 0; i < 40; i++) {
        const next = nextCronRun(recipe.schedule.cron, prev);
        if (next === null) break;
        gap = Math.min(gap, (next.getTime() - prev.getTime()) / 60_000);
        prev = next;
      }
      if (gap < RECIPE_MIN_GAP_MINUTES) add('recipe.yaml', 'schedule.cron', `runs every ${gap} minutes; a recipe runs at most every ${RECIPE_MIN_GAP_MINUTES} minutes because a run can call a model`);
    }
  } catch (err) {
    add('recipe.yaml', 'schedule.cron', err instanceof Error ? err.message : 'not a cron expression');
  }

  // the routine
  const routinePath = `routines/${recipe.id}.yaml`;
  let routineSlug: string | null = null;
  try {
    const contract = RoutineContract.safeParse(parseYaml(recipe.files[routinePath] ?? '', { maxAliasCount: 20 }));
    if (!contract.success) {
      const issue = contract.error.issues[0];
      add(routinePath, issue?.path.join('.') || null, issue?.message ?? 'not a routine contract');
    } else {
      routineSlug = recipe.id;
      if (!contract.data.output.page.startsWith(RECIPE_PAGE_PREFIX)) add(routinePath, 'output.page', `a recipe writes under ${RECIPE_PAGE_PREFIX}`);
      if (contract.data.prompt === undefined) add(routinePath, 'prompt', 'a recipe routine needs a prompt');
    }
  } catch (err) {
    add(routinePath, null, `not valid YAML (${err instanceof Error ? err.message : 'unreadable'})`);
  }

  // the bot
  const botPath = `bots/${recipe.botSlug}/BOT.md`;
  const bot = parseBotMd(recipe.files[botPath] ?? '');
  if (!bot.ok) {
    add(botPath, bot.failure.fieldPath, bot.failure.message);
    return out;
  }
  const fm = bot.frontmatter;
  if (fm.runtime !== 'hermes') {
    add(botPath, 'runtime', 'a recipe bot needs a model: a rules bot has no reply, so the routine could not save its page');
  }
  const native = fm.capabilities?.native ?? [];
  if (fm.capabilities?.connections !== undefined || fm.capabilities?.runtime !== undefined) {
    add(botPath, 'capabilities', 'a recipe bot holds platform tools only: no connection and no runtime tool');
  }
  for (const tool of native) if (!RECIPE_TOOLS.includes(tool)) add(botPath, 'capabilities.native', `"${tool}" is not a tool a recipe may hold (allowed: ${RECIPE_TOOLS.join(', ')})`);
  for (const tool of ['messages.post', 'pages.write']) if (!native.includes(tool)) add(botPath, 'capabilities.native', `needs ${tool}: the routine runner saves the page and posts its link as the bot`);
  if (fm.approvals?.approvers !== undefined) add(botPath, 'approvals.approvers', 'names no approver tag: a new team has defined none, so leads and admins decide');
  if (fm.handover !== undefined) add(botPath, 'handover', 'a recipe hands nothing over: it leaves a page and cards for a person');
  if (fm.placement?.gateway?.connection !== 'managed' || fm.placement.runs_on !== undefined) add(botPath, 'placement', 'a recipe runs on the team\'s managed gateway (placement.gateway.connection: managed)');
  for (const alias of [...(fm.model?.aliases ?? []), ...(fm.model?.fallbacks ?? [])]) {
    if (!LlmAliasName.safeParse(alias).success) add(botPath, 'model.aliases', `"${alias}" is not a model alias a workspace has`);
  }
  if (fm.model?.subscription !== undefined) add(botPath, 'model', 'a recipe uses gateway aliases, not a subscription runtime');

  const triggers = fm.triggers ?? [];
  const routine = triggers.find((t) => t.type === 'routine');
  if (!routine) add(botPath, 'triggers', 'needs a routine trigger, or the schedule cannot wake the bot');
  else if (routine.type === 'routine' && routine.routine !== undefined && routine.routine !== routineSlug) add(botPath, 'triggers', `the routine trigger names "${routine.routine}", but the contract is ${routinePath}`);
  for (const t of triggers) {
    if (t.type === 'channel_message' || t.type === 'webhook' || t.type === 'inbox' || t.type === 'drop' || t.type === 'task_assigned') {
      add(botPath, 'triggers', `a recipe wakes on a routine, a mention or a conversation, not "${t.type}"`);
    }
    if (t.type === 'mention' && t.source) for (const c of t.source.channels) if (!recipe.channels.includes(c)) add(botPath, 'triggers', `the mention trigger names ${c}, which recipe.yaml does not list in channels`);
  }
  for (const entry of fm.guard?.gate ?? []) if (!entry.startsWith('/')) add(botPath, 'guard.gate', `"${entry}" is a phrase; a recipe ships patterns only (a phrase makes the local classifier read every message)`);
  if (fm.guard?.gate !== undefined && !compileGate(fm.guard.gate).ok) add(botPath, 'guard.gate', 'the gate list does not compile');
  const prompts = fm.conversation?.prompts ?? [];
  if (prompts.length < 3 || prompts.length > MAX_CONVERSATION_PROMPTS) add(botPath, 'conversation.prompts', `three to ${MAX_CONVERSATION_PROMPTS} example questions`);
  if (fm.evals === undefined) {
    add(botPath, 'evals', 'a recipe ships a scenario set');
    return out;
  }

  // the scenario set
  const setPath = botEvalSetPath(recipe.botSlug, fm.evals.set);
  const setText = recipe.files[setPath];
  if (setText === undefined) {
    add(botPath, 'evals.set', `names "${fm.evals.set}", but ${setPath} does not exist`);
    return out;
  }
  const set = parseBotEvalSet(setText);
  if (!set.ok) {
    add(setPath, null, set.message);
    return out;
  }
  if (set.set.set !== fm.evals.set) add(setPath, 'set', `"${set.set.set}" must match the name BOT.md gives, "${fm.evals.set}"`);
  if (set.set.cases.length < 2) add(setPath, 'cases', 'a scenario set has at least two cases');
  let checkable = 0;
  for (const c of set.set.cases) {
    const required = c.expect.toolCalls?.required ?? [];
    if (required.length > 0) checkable++;
    for (const tool of required) {
      if (!native.some((granted) => capabilityMeets(granted, tool))) add(setPath, `cases.${c.id}`, `requires ${tool}, which the bot is not granted, so the case can never pass`);
    }
    // not vacuous: a phrase the answer must contain is in something the asker may open (or in the question itself)
    const sources = c.given?.sources ?? [];
    for (const phrase of c.expect.mentions ?? []) {
      const lower = phrase.toLowerCase();
      if (!sources.some((s) => s.visibleToAsker && s.text.toLowerCase().includes(lower)) && !c.question.toLowerCase().includes(lower)) add(setPath, `cases.${c.id}`, `"${phrase}" is in nothing the asker may open`);
    }
  }
  if (checkable === 0) add(setPath, 'cases', 'at least one case must require a call, or the free check has nothing to judge');
  return out;
}

/** Parses nothing from disk: the validated shape of a recipe, or the problems found. */
export function checkRecipe(recipe: unknown): { ok: true; recipe: Recipe; problems: [] } | { ok: false; problems: RecipeProblem[] } {
  const parsed = Recipe.safeParse(recipe);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 8).map((i) => ({ file: 'recipe.yaml', field: i.path.map(String).join('.') || null, message: i.message })) };
  }
  const problems = recipeProblems(parsed.data);
  return problems.length === 0 ? { ok: true, recipe: parsed.data, problems: [] } : { ok: false, problems };
}
