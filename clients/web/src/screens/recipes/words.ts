import { RECIPE_CATEGORIES, type RecipeCard, type RecipeCategory } from '@manythreads/shared';

/*
 * The plain words and small rules of the recipe gallery, kept apart from the screen so a test can read them. A recipe is a ready-made automation:
 * a bot, the check scenarios for it, and a routine (a written job the bot repeats on a schedule). Nothing here talks to the server.
 */

export type StateLook = { tone: 'ok' | 'warn' | 'idle'; glyph: string; label: string; hint: string };

/**
 * One phrase for where a recipe stands in this team: ready to add, waiting for approval, installed but not yet on a schedule, or running.
 * "Ready to add" is the default every card starts in, so it is kept for screen readers and never drawn as a pill (see `pillShown`).
 */
export function stateLook(c: Pick<RecipeCard, 'state' | 'scheduled' | 'openProposals'>): StateLook {
  if (c.state === 'waiting') {
    const n = c.openProposals;
    return { tone: 'warn', glyph: '', label: 'Waiting for approval', hint: `${String(n)} ${n === 1 ? 'proposal waits' : 'proposals wait'} for a team lead or a workspace admin.` };
  }
  if (c.state === 'installed') {
    return c.scheduled
      ? { tone: 'ok', glyph: '✓', label: 'Installed and running', hint: 'The bot is in the team and its schedule is on.' }
      : { tone: 'warn', glyph: '!', label: 'Installed, schedule off', hint: 'The bot is in the team. A team lead turns the schedule on in Jobs.' };
  }
  return { tone: 'idle', glyph: '–', label: 'Ready to add', hint: 'Nothing of this recipe is in the team yet.' };
}

/** Whether the state pill is drawn: only when something has happened (waiting, installed); a recipe nobody touched carries no pill, and offers an Add button instead. */
export const pillShown = (c: Pick<RecipeCard, 'state' | 'scheduled' | 'openProposals'>): boolean => stateLook(c).tone !== 'idle';

/** Whether the card offers the Add button: the recipe is not in this team yet and nothing waits for approval. */
export const canOfferAdd = (c: Pick<RecipeCard, 'state'>): boolean => c.state === 'available';

/** What a recipe needs, in plain words, for the one-line summary on a card: the first need, and how many more. */
export function needsLine(c: Pick<RecipeCard, 'needs'>): string {
  const [first, ...rest] = c.needs;
  if (first === undefined) return 'Needs nothing set up first.';
  return rest.length === 0 ? `Needs: ${first}` : `Needs: ${first} (and ${String(rest.length)} more)`;
}

export type Shelf = { id: RecipeCategory | 'all'; label: string; count: number };

/** The filter chips: "All", then each shelf that has at least one recipe, in the gallery's own order. */
export function shelves(cards: ReadonlyArray<Pick<RecipeCard, 'category'>>): Shelf[] {
  const out: Shelf[] = [{ id: 'all', label: 'All', count: cards.length }];
  for (const c of RECIPE_CATEGORIES) {
    const count = cards.filter((x) => x.category === c.id).length;
    if (count > 0) out.push({ id: c.id, label: c.label, count });
  }
  return out;
}

/**
 * The recipes people reach for first, in the order they are shown. No usage numbers exist yet, so the list is chosen by hand (owner default, PLAN F10-7);
 * replace it with real install counts when there are some.
 */
export const POPULAR_RECIPES: ReadonlyArray<string> = ['daily-standup', 'weekly-digest', 'request-intake', 'bug-triage', 'release-notes', 'meeting-prep', 'follow-up-chaser', 'incident-watch'];

/** The cards in gallery order: the popular ones first, in the list's order, then every other one by name (a tie keeps the order the server sent). */
export function byPopularity<T extends Pick<RecipeCard, 'id' | 'name'>>(cards: ReadonlyArray<T>): T[] {
  const rank = (c: T): number => {
    const i = POPULAR_RECIPES.indexOf(c.id);
    return i === -1 ? POPULAR_RECIPES.length : i;
  };
  return [...cards].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The recipes on one shelf (every recipe for "all"), popular first. */
export function onShelf<T extends Pick<RecipeCard, 'id' | 'name' | 'category'>>(cards: ReadonlyArray<T>, shelf: RecipeCategory | 'all'): T[] {
  return byPopularity(shelf === 'all' ? cards : cards.filter((c) => c.category === shelf));
}

/** A shelf named in the address (`?shelf=`), or "all" when it names none. */
export function shelfFrom(raw: string | null): RecipeCategory | 'all' {
  return RECIPE_CATEGORIES.find((c) => c.id === raw)?.id ?? 'all';
}

export type InstallGate = { allowed: boolean; reason: string | null };

/**
 * Whether this person may press Install, and if not, why in a sentence. The server lets anyone who can post file the proposals, but the gallery keeps the button to the people
 * who can also approve them (a team lead, or a workspace admin), so nothing is filed that its author cannot finish.
 */
export function installGate(
  who: { guest: boolean; canApply: boolean },
  card: Pick<RecipeCard, 'state' | 'bot'>,
  serverAllows: boolean,
): InstallGate {
  if (card.state === 'installed') return { allowed: false, reason: `This team already has ${card.bot.name}. Open it on the Bots page.` };
  if (card.state === 'waiting') return { allowed: false, reason: 'This recipe already waits for approval. Deal with those proposals first.' };
  if (who.guest) return { allowed: false, reason: 'Guests cannot add recipes. Ask a team lead or a workspace admin.' };
  if (!serverAllows) return { allowed: false, reason: 'Recipes cannot be added to this team right now (it may be archived).' };
  if (!who.canApply) return { allowed: false, reason: 'Only a team lead or a workspace admin can add a recipe. Ask one of them.' };
  return { allowed: true, reason: null };
}

/** The files an install proposes, in words a person recognises. */
export function fileRole(path: string): string {
  if (/\/BOT\.md$/.test(path)) return 'The bot';
  if (/\/evals\//.test(path)) return 'Its check scenarios';
  if (path.startsWith('routines/')) return 'Its routine (the job it repeats)';
  return 'File';
}

/** How the bot works, in one phrase. */
export const runtimeLine = (c: Pick<RecipeCard, 'bot'>): string => (c.bot.runtime === 'rules' ? 'Follows fixed rules; no model is called.' : 'Uses a model to read and write.');

/** How the recipe's checks read: how many scenarios, and the score they must reach (`minScore` is a share from 0 to 1). */
export function checksLine(c: Pick<RecipeCard, 'evals'>): string {
  const n = c.evals.cases;
  return `${String(n)} ${n === 1 ? 'scenario checks' : 'scenarios check'} it before it is trusted (pass mark ${String(Math.round(c.evals.minScore * 100))}%).`;
}

/** What the screen says when the install went through: how many proposals were filed and who applies them. */
export function filedLine(n: number): string {
  return `${String(n)} ${n === 1 ? 'proposal is' : 'proposals are'} filed. Nothing is added to the team until a team lead or workspace admin approves ${n === 1 ? 'it' : 'them'}.`;
}

/** What the top bar says beside the title "Recipes" (it must not repeat it). */
export const RECIPES_TOPIC = 'Ready-made automations';
