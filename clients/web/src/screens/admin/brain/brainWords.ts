import type { BotRunner, BotSummary, LlmAlias, TeamSummary } from '@manythreads/shared';

/*
 * The plain facts and sentences of Settings → Workspace → Brain, kept apart from the page so a test can read them. Nothing here touches the network. The page is read
 * only: the server has no route that changes the workspace Brain (its definition is stored by the system and a change goes in as a new version through the loader), so
 * every fact is read from a route that exists — the team roster (`GET /api/teams/:slug/bots`), the runners, the model names — or is a rule the platform enforces and
 * the bots plugin documents (docs/plugins/bots.md, "The workspace Brain" and "Which bots may read a person's Personal space").
 */

export const BRAIN_SLUG = 'brain';

/** The model names the shipped Brain definition (`templates/_workspace/bots/brain/BOT.md`) asks for. The page shows what each one is bound to; it cannot read the stored definition. */
export const BRAIN_MODEL_NAMES = ['smart', 'fast'] as const;

/** The one Brain of the workspace in a team's roster: scope `workspace`, slug `brain`. Null when the roster has none (not set up yet). */
export function findWorkspaceBrain(bots: readonly BotSummary[]): BotSummary | null {
  return bots.find((b) => b.scope === 'workspace' && b.slug === BRAIN_SLUG) ?? null;
}

/** The team the roster is read through: the Brain belongs to no team, and any live team's roster lists it. The first team that is not archived. */
export function contextTeam<T extends Pick<TeamSummary, 'archivedAt'>>(teams: readonly T[]): T | null {
  return teams.find((t) => t.archivedAt === null) ?? null;
}

export type BrainTone = 'ok' | 'warn' | 'alert';
export type BrainState = { tone: BrainTone; label: string; sentence: string };

/** What the row's status says, in words. `invalid` keeps the last good definition running, so the Brain still answers. */
export function brainState(bot: Pick<BotSummary, 'status' | 'invalid'>): BrainState {
  if (bot.status === 'disabled') return { tone: 'warn', label: 'Off', sentence: 'The Brain is switched off, so nobody can ask it anything.' };
  if (bot.status === 'invalid') {
    const why = bot.invalid?.message ? ` The last attempt failed: ${bot.invalid.message}` : '';
    return { tone: 'alert', label: 'Needs a fix', sentence: `The newest definition could not be loaded, so the Brain keeps answering from the last one that worked.${why}` };
  }
  return { tone: 'ok', label: 'On', sentence: 'The Brain is loaded and switched on for every team.' };
}

/** The first eight characters of the definition's fingerprint, enough to tell two versions apart. */
export const shortSha = (sha: string): string => sha.slice(0, 8);

/** The ways a person can reach the Brain, from its definition's triggers. */
export function reachWords(bot: Pick<BotSummary, 'conversational' | 'mentionable'>): string[] {
  const out: string[] = [];
  if (bot.conversational) out.push('A one-to-one conversation in Chat');
  if (bot.mentionable) out.push('@Brain in any channel');
  return out;
}

/** Where its runs go: a runner its definition names, else the runner each team is given, else the workspace default runner when one is set. */
export function runsOnWords(bot: Pick<BotSummary, 'placement'>, runners: readonly Pick<BotRunner, 'name' | 'isDefault'>[] | null): string {
  const named = bot.placement?.runs_on;
  if (typeof named === 'string') return `The runner called ${named}.`;
  const standard = runners?.find((r) => r.isDefault)?.name;
  return standard
    ? `The runner each team is given, or the workspace default, ${standard}, when a team has none.`
    : 'The runner each team is given. The workspace has no default runner, so a team without one cannot run it.';
}

export type ModelLine = { name: string; bound: string | null };

/** For each model name the Brain asks for, the model it is bound to now; null when the LLM page has no binding for it. */
export function modelLines(aliases: readonly Pick<LlmAlias, 'alias' | 'model'>[] | null): ModelLine[] | null {
  if (aliases === null) return null;
  return BRAIN_MODEL_NAMES.map((name) => ({ name, bound: aliases.find((a) => a.alias === name)?.model ?? null }));
}

/** What the Brain may read, per place it is asked. Rules the platform enforces on every tool call (`app.run_space_context()`), not settings on this page. */
export const READ_RULES: ReadonlyArray<{ where: string; reads: string }> = [
  { where: 'In a team channel', reads: 'Only that team’s messages, files, knowledge and memory.' },
  { where: 'In a private conversation or a direct message', reads: 'The Personal space of the person asking (if they allow it), and every team that person can read. Nothing of anyone else’s.' },
  { where: 'In a routine or a webhook', reads: 'Only the team the routine or webhook belongs to.' },
];

export const GUEST_RULE = 'A guest has no Personal space and no Brain.';

/** The default for a person’s Personal space, and where each person changes it. */
export const CONSENT_DEFAULT =
  'Brain may read the Personal space of whoever asks it, until that person turns it off. Every other bot needs the person’s own yes. Only the person sees and changes their own answer.';

/** What became of the old team Brains. The roster leaves a switched-off Brain out and no route lists it, so the page can say what happened but not name them. */
export const RETIRED_TEAM_BRAINS =
  'Each team used to have a Brain of its own. When the workspace Brain was set up, those were switched off. Their conversations, runs and memory stay readable, and they take no new questions. This page cannot list them: the server gives no list of switched-off bots.';

export const NOT_EDITABLE =
  'This page only shows the Brain. Its definition, its models and its runner cannot be changed from here yet. Models are bound on the LLM page, and runners on the Runners page.';

export const NOT_SET_UP =
  'The workspace Brain is not set up yet. The server creates it by itself, within fifteen minutes of starting. If this stays empty, ask whoever runs the server to look at the bots log.';

export const NO_TEAMS = 'The Brain is read through a team’s bot list, and this workspace has no live team yet. Create a team first; the Brain joins every team.';
