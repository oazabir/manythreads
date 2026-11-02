import { modelRunnerProblem, type BotFrontmatter, type TeamBotRunner } from '@manythreads/shared';

/*
 * The words and rules of the "Runs on" choice (a bot is placed on a runner an admin set up, by name; the page never shows an address, a key or a node).
 * Everything here is pure so the wording can be tested without a screen: the option text, the state of a runner, the plan line of a subscription runner,
 * the older placements a bot may still carry, and what "Move to a runner" picks.
 */

type Kind = TeamBotRunner['kind'];
type Status = TeamBotRunner['status'];
type Placement = NonNullable<BotFrontmatter['placement']>;

/** A short text mark per kind (never a picture): drawn before the name in the list and beside the chosen runner. */
export const KIND_ICON: Readonly<Record<Kind, string>> = {
  hermes_gateway: '⇄',
  hermes_pod: '⬡',
  claude_cli: '✦',
  codex_cli: '❯',
  llm_gateway: '◎',
};

export const KIND_LABEL: Readonly<Record<Kind, string>> = {
  hermes_gateway: 'Hermes gateway',
  hermes_pod: 'Team Hermes pod',
  claude_cli: 'Claude Code',
  codex_cli: 'Codex',
  llm_gateway: 'Model API',
};

export const STATUS_LABEL: Readonly<Record<Status, string>> = {
  ready: 'Ready',
  not_set_up: 'Not set up',
  waiting_for_sign_in: 'Waiting for sign-in',
  starting: 'Starting',
  needs_sign_in: 'Needs sign-in',
  waiting_for_node: 'Waiting for its machine',
  moving: 'Moving',
  paused: 'Paused',
  off: 'Off',
};

/** The kinds that can run a bot today. The others are listed so people know they exist, but cannot be chosen until the server can start them. */
const RUNNABLE: ReadonlySet<Kind> = new Set<Kind>(['hermes_gateway', 'hermes_pod']);
export const canRunBots = (r: Pick<TeamBotRunner, 'kind'>): boolean => RUNNABLE.has(r.kind);

/**
 * A Model API runner (the platform's LLM gateway) can be chosen for a bot, but it only calls a model: it has no shell, files or browser. It is never the workspace default and "Move to a runner"
 * never picks it, so it is not in `canRunBots`.
 */
const MODEL_ONLY: ReadonlySet<Kind> = new Set<Kind>(['llm_gateway']);

/**
 * Why a bot cannot be placed on this runner, or null. A runner that only calls a model cannot take a bot whose definition asks for a shell, files or a browser (`capabilities.runtime`), nor a bot
 * that has no way to post its reply (`capabilities.native` lists neither `messages.post` nor `answer.post`). `nativeGrants` left out means the page does not know them: only the first is checked.
 * The sentences are the server's own (`modelRunnerProblem` in @manythreads/shared), the ones the bot loader saves on the bot, so a bot is never chosen here and then refused on save.
 */
export function modelOnlyProblem(r: Pick<TeamBotRunner, 'kind' | 'label'>, runtimeGrants: ReadonlyArray<string>, nativeGrants?: ReadonlyArray<string>): string | null {
  if (!MODEL_ONLY.has(r.kind)) return null;
  return modelRunnerProblem(r.label, { runtime: runtimeGrants, native: nativeGrants });
}

/** Can this runner be chosen for the bot in the picker: it runs bots, or it is a model-only runner and the bot asks for nothing it lacks. */
export const canChoose = (r: Pick<TeamBotRunner, 'kind' | 'label'>, runtimeGrants: ReadonlyArray<string> = [], nativeGrants?: ReadonlyArray<string>): boolean =>
  (RUNNABLE.has(r.kind) || MODEL_ONLY.has(r.kind)) && modelOnlyProblem(r, runtimeGrants, nativeGrants) === null;

/** Does the workspace default runner really take bots that name no runner? Only when it is on and of a kind that can run bots; otherwise those bots run on the host as they always did. */
export const defaultApplies = (r: Pick<TeamBotRunner, 'kind' | 'status'>): boolean => canRunBots(r) && r.status !== 'off';

/** What the page says about the bots that name no runner when the default runner is set but cannot take them. */
export const DEFAULT_CANNOT_RUN = 'This bot runs on the host because the default runner cannot run bots.';

/** "Omar's Max plan · shared with 3 teams" or "… · this team only" for a subscription runner; null for every other kind. */
export function planLine(r: Pick<TeamBotRunner, 'ownerName' | 'planLabel' | 'sharedWith'>): string | null {
  if (r.planLabel === null) return null;
  const who = r.ownerName === null ? r.planLabel : `${r.ownerName}'s ${r.planLabel}`;
  return `${who} · ${r.sharedWith <= 1 ? 'this team only' : `shared with ${String(r.sharedWith)} teams`}`;
}

/** What a person reads in the list for one runner. A runner that is not Ready can be chosen, and says so; one that cannot run bots yet cannot. */
export function optionText(r: TeamBotRunner, runtimeGrants: ReadonlyArray<string> = [], nativeGrants?: ReadonlyArray<string>): string {
  const parts = [`${KIND_ICON[r.kind]} ${r.label}`, KIND_LABEL[r.kind]];
  const plan = planLine(r);
  if (plan !== null) parts.push(plan);
  if (modelOnlyProblem(r, runtimeGrants, nativeGrants) !== null) parts.push(runtimeGrants.length > 0 ? 'no shell, files or browser: this bot needs one' : 'this bot cannot post a reply: add messages.post');
  else if (MODEL_ONLY.has(r.kind)) {
    parts.push('model only');
    if (r.status !== 'ready') parts.push(STATUS_LABEL[r.status]);
  } else if (!canRunBots(r)) parts.push('cannot run bots yet');
  else if (r.status !== 'ready') parts.push(STATUS_LABEL[r.status]);
  if (r.isDefault && defaultApplies(r)) parts.push('default');
  return parts.join(' · ');
}

/** The sentence under the select for the runner that is chosen: what it is, and a plain warning when it is not Ready. */
export function chosenNote(r: TeamBotRunner, runtimeGrants: ReadonlyArray<string> = [], nativeGrants?: ReadonlyArray<string>): { text: string; tone: 'ok' | 'warn' } {
  const problem = modelOnlyProblem(r, runtimeGrants, nativeGrants);
  if (problem !== null) return { text: problem, tone: 'warn' };
  if (!canRunBots(r) && !MODEL_ONLY.has(r.kind)) return { text: `${r.label} cannot run bots yet. Pick another runner.`, tone: 'warn' };
  if (r.status === 'ready') return { text: `${r.label} is ready.`, tone: 'ok' };
  if (r.status === 'off') return { text: `${r.label} is switched off. This bot's runs are turned away until an admin switches it on.`, tone: 'warn' };
  return { text: `${r.label} is not ready (${STATUS_LABEL[r.status].toLowerCase()}). You can choose it, but runs may be turned away until an admin fixes it.`, tone: 'warn' };
}

/** The kind of the older placements a bot may still carry, in plain words, for the read-only "Old placement" block. */
export function oldPlacement(p: Placement | undefined): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  if (p?.gateway !== undefined) {
    out.push({ label: 'Hermes connection', value: p.gateway.connection });
    if (p.gateway.profile !== undefined) out.push({ label: 'Profile', value: p.gateway.profile });
  }
  if (p?.node !== undefined) out.push({ label: 'Node', value: p.node });
  if (p?.runner !== undefined) out.push({ label: 'Runner machine', value: p.runner });
  return out;
}

export const hasOldPlacement = (p: Placement | undefined): boolean => p?.gateway !== undefined || p?.node !== undefined || p?.runner !== undefined;

/** The runner "Move to a runner" starts from: the default when it can run bots, else the first one that is Ready, else the first that can run bots. Null when none can. */
export function moveTarget(runners: ReadonlyArray<TeamBotRunner>): TeamBotRunner | null {
  const usable = runners.filter(canRunBots);
  return usable.find((r) => r.isDefault && defaultApplies(r)) ?? usable.find((r) => r.status === 'ready') ?? usable[0] ?? null;
}

/** The placement after a move: the older keys are gone, `runs_on` is set, and what is unrelated (requires, isolation) stays. */
export function movedPlacement(p: Placement | undefined, runner: string): Placement {
  return { ...(p?.requires !== undefined ? { requires: p.requires } : {}), ...(p?.isolation !== undefined ? { isolation: p.isolation } : {}), runs_on: runner };
}

/** The placement after picking a runner ('' means "the workspace default": `runs_on` is removed, and an otherwise empty placement goes with it). */
export function pickedPlacement(p: Placement | undefined, runner: string): Placement | undefined {
  const next: Placement = { ...(p ?? {}) };
  delete next.runs_on;
  if (runner !== '') next.runs_on = runner;
  return Object.keys(next).length === 0 ? undefined : next;
}
