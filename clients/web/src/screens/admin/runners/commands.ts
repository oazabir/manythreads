import {
  BotRunnerName,
  BotRunnerLabel,
  BotRunnerProfileRule,
  CreateBotRunnerRequest,
  UpdateBotRunnerRequest,
  type BotRunner,
  type BotRunnerKind,
  type BotRunnerStatus,
  type OldConnection,
  type SetBotRunnerTeamsRequest,
  type TeamId,
  type TestBotRunnerResponse,
} from '@manythreads/shared';

/*
 * The model of the Runners page (PLAN P19-04): the words, the checks and the small decisions the screen makes, with no React in them so they are
 * tested on their own. Every sentence an admin reads here is chosen in this file. A key is never read back from the server, so nothing here ever holds
 * one except a form value on its way out.
 */

// ---- kinds ----------------------------------------------------------------------------------------------------

export type KindCard = {
  kind: BotRunnerKind;
  title: string;
  /** One sentence for the chooser. */
  sentence: string;
  /** False: the card is shown and explains itself, but cannot be picked yet. */
  available: boolean;
  /** Why a card cannot be picked yet. */
  unavailable?: string;
};

export const KIND_CARDS: readonly KindCard[] = [
  {
    kind: 'hermes_gateway',
    title: 'Hermes gateway',
    sentence: 'A Hermes you already run on a machine of your own. You give its address and its key once.',
    available: true,
  },
  {
    kind: 'hermes_pod',
    title: 'Team Hermes pod',
    sentence: "Each team's own Hermes, started for you inside this cluster. There is nothing to type; you choose which teams may use it.",
    available: true,
  },
  {
    kind: 'claude_cli',
    title: 'Claude Code',
    sentence: 'Runs the Claude Code program in its own pod, signed in with a Claude plan.',
    available: false,
    unavailable: 'Needs a Claude sign-in; coming with the Claude pod.',
  },
  {
    kind: 'codex_cli',
    title: 'Codex',
    sentence: 'Runs the Codex program in its own pod, signed in with a ChatGPT plan.',
    available: false,
    unavailable: 'Needs a Codex sign-in; coming with the Claude pod.',
  },
  {
    kind: 'llm_gateway',
    title: 'LLM gateway',
    sentence: "A bot that only talks: it answers through one of this workspace's model names, with the usual budgets and limits. It has no shell, files or browser.",
    available: true,
  },
];

const KIND_WORDS: Record<BotRunnerKind, string> = {
  hermes_gateway: 'Hermes gateway',
  hermes_pod: 'Team Hermes pod',
  claude_cli: 'Claude Code',
  codex_cli: 'Codex',
  llm_gateway: 'LLM gateway',
};
export const kindWords = (k: BotRunnerKind): string => KIND_WORDS[k];

// ---- state ----------------------------------------------------------------------------------------------------

export type StateLook = { label: string; glyph: string; tone: 'ok' | 'warn' | 'bad' | 'idle' };

/** The badge words and a shape for each state, so the state never rests on colour alone. */
const STATES: Record<BotRunnerStatus, StateLook> = {
  ready: { label: 'Ready', glyph: '✓', tone: 'ok' },
  not_set_up: { label: 'Not set up', glyph: '○', tone: 'warn' },
  waiting_for_sign_in: { label: 'Waiting for sign-in', glyph: '…', tone: 'warn' },
  starting: { label: 'Starting', glyph: '…', tone: 'warn' },
  needs_sign_in: { label: 'Needs sign-in', glyph: '!', tone: 'bad' },
  waiting_for_node: { label: 'Waiting for node', glyph: '…', tone: 'warn' },
  moving: { label: 'Moving', glyph: '→', tone: 'warn' },
  paused: { label: 'Paused', glyph: '‖', tone: 'warn' },
  off: { label: 'Off', glyph: '–', tone: 'idle' },
};
export const stateLook = (s: BotRunnerStatus): StateLook => STATES[s];

// ---- list words -----------------------------------------------------------------------------------------------

/** Who may use a runner, in one phrase for the list. */
export function describeTeams(r: Pick<BotRunner, 'allTeams' | 'teams'>): string {
  if (r.allTeams) return 'Every team';
  const names = r.teams.map((t) => t.name);
  if (names.length === 0) return 'No team yet';
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** True when nobody can use the runner yet, so the row says so instead of looking finished. */
export const hasNoTeams = (r: Pick<BotRunner, 'allTeams' | 'teams'>): boolean => !r.allTeams && r.teams.length === 0;

export const countBots = (n: number): string => (n === 0 ? 'No bots' : n === 1 ? '1 bot' : `${n} bots`);

/** The address and key line of a gateway; the key is never shown, only whether one is set. */
export function describeGateway(r: Pick<BotRunner, 'kind' | 'baseUrl' | 'hasKey'>): string | null {
  if (r.kind !== 'hermes_gateway') return null;
  return `${r.baseUrl ?? 'No address yet'} · ${r.hasKey ? 'A key is set' : 'No key yet'}`;
}

/**
 * Why a runner's switch cannot be turned off, or null when it can. The server refuses to switch off the default runner, so the page says why before the
 * admin tries.
 */
export const cannotSwitchOff = (r: Pick<BotRunner, 'isDefault' | 'enabled'>): string | null =>
  r.isDefault && r.enabled ? 'This is the default runner. Make another runner the default first.' : null;

/** Why a runner cannot be made the default, or null when it can (the server refuses a switched-off runner and the kinds that cannot run a bot yet). */
export function cannotBeDefault(r: Pick<BotRunner, 'kind' | 'enabled'>): string | null {
  if (!r.enabled) return 'A runner that is switched off cannot be the default.';
  if (r.kind !== 'hermes_gateway' && r.kind !== 'hermes_pod') return 'This kind of runner cannot be the default yet.';
  return null;
}

/** The sentence announced after the on/off switch changed. */
export const switchWords = (r: Pick<BotRunner, 'label'>, enabled: boolean): string => `${r.label} is switched ${enabled ? 'on' : 'off'}.`;

export const defaultWords = (r: Pick<BotRunner, 'label'> | null): string => (r ? `${r.label} is now the default runner.` : 'There is no default runner now.');

/** What the test said, as one sentence for the live region and the row. */
export function testWords(r: Pick<BotRunner, 'label'>, res: Pick<TestBotRunnerResponse, 'ok' | 'error' | 'status'>): string {
  if (res.ok) return `${r.label} answered. It is ready.`;
  return `${r.label} did not pass: ${res.error ?? 'it is not ready.'}`;
}

/** Before a delete: the line that tells the admin what is at stake, or null when no bot is placed on the runner. */
export function deleteWarning(r: Pick<BotRunner, 'label' | 'botCount'>): string | null {
  if (r.botCount === 0) return null;
  const one = r.botCount === 1;
  return `${countBots(r.botCount)} still run${one ? 's' : ''} on ${r.label}. It cannot be deleted until ${one ? 'that bot is' : 'they are'} moved to another runner.`;
}

// ---- teams ----------------------------------------------------------------------------------------------------

/** The team control: every team, one team, or several. */
export type TeamsChoice = { mode: 'all' } | { mode: 'one'; teamId: string } | { mode: 'several'; teamIds: readonly string[] };

export const NO_TEAMS: TeamsChoice = { mode: 'several', teamIds: [] };

export function choiceOf(r: Pick<BotRunner, 'allTeams' | 'teams'>): TeamsChoice {
  if (r.allTeams) return { mode: 'all' };
  const ids = r.teams.map((t) => t.teamId as string);
  const only = ids[0];
  return ids.length === 1 && only !== undefined ? { mode: 'one', teamId: only } : { mode: 'several', teamIds: ids };
}

/** Switching modes keeps what carries over: the first ticked team becomes the one team; the one team becomes the first tick. */
export function switchMode(c: TeamsChoice, mode: TeamsChoice['mode']): TeamsChoice {
  if (c.mode === mode) return c;
  if (mode === 'all') return { mode: 'all' };
  const current = c.mode === 'one' ? [c.teamId] : c.mode === 'several' ? c.teamIds : [];
  if (mode === 'one') return { mode: 'one', teamId: current[0] ?? '' };
  return { mode: 'several', teamIds: current };
}

export function toggleTeam(c: TeamsChoice, teamId: string, on: boolean): TeamsChoice {
  if (c.mode !== 'several') return c;
  const without = c.teamIds.filter((t) => t !== teamId);
  return { mode: 'several', teamIds: on ? [...without, teamId] : without };
}

export function teamsBody(c: TeamsChoice): SetBotRunnerTeamsRequest | null {
  if (c.mode === 'all') return { all: true };
  // the ids come from the server's own team list, so they are the branded ids already
  if (c.mode === 'one') return c.teamId === '' ? null : { teams: [c.teamId as TeamId] };
  return { teams: c.teamIds as TeamId[] };
}

/** A sentence when the choice cannot be saved, a warning (not an error) when it saves but leaves the runner unused, else null. */
export function teamsProblem(c: TeamsChoice): { kind: 'error' | 'warning'; text: string } | null {
  if (c.mode === 'one' && c.teamId === '') return { kind: 'error', text: 'Choose the team.' };
  if (c.mode === 'several' && c.teamIds.length === 0) return { kind: 'warning', text: 'No team is ticked, so no team can use this runner yet.' };
  return null;
}

/**
 * The teams to offer in the teams control: the workspace's live teams, plus any team already on the runner that the list leaves out (an archived or hidden
 * team), so saving never drops one silently and the admin can see and untick it.
 */
export function teamOptions(loaded: ReadonlyArray<{ id: string; name: string }>, onRunner: ReadonlyArray<{ teamId: string; name: string }>): Array<{ id: string; name: string }> {
  const seen = new Set(loaded.map((t) => t.id));
  const extra = onRunner.filter((t) => !seen.has(t.teamId)).map((t) => ({ id: t.teamId as string, name: `${t.name} (archived or hidden)` }));
  return [...loaded.map((t) => ({ id: t.id, name: t.name })), ...extra];
}

/** True when the edit form differs from the saved runner, so Save only shows when there is something to save. */
export function editChanged(
  current: Pick<BotRunner, 'kind' | 'label' | 'baseUrl' | 'profileRule' | 'modelAlias'>,
  v: Pick<RunnerFormValues, 'label' | 'baseUrl' | 'apiKey' | 'profileRule' | 'modelAlias'>,
): boolean {
  if (v.label.trim() !== current.label) return true;
  if (current.kind === 'hermes_gateway') return v.baseUrl.trim() !== (current.baseUrl ?? '') || v.apiKey !== '' || v.profileRule.trim() !== (current.profileRule ?? DEFAULT_PROFILE_RULE);
  if (current.kind === 'llm_gateway') return v.modelAlias !== (current.modelAlias ?? '');
  return false;
}

/** The status line after an add. */
export function addedWords(r: Pick<BotRunner, 'label' | 'kind' | 'allTeams' | 'teams'>): string {
  if (hasNoTeams(r)) return `${r.label} was added. It is not open to any team yet: choose its teams.`;
  return r.kind === 'hermes_gateway' ? `${r.label} was added. Run Test to check it.` : `${r.label} was added.`;
}

export function teamsSavedWords(r: Pick<BotRunner, 'label' | 'allTeams' | 'teams'>): string {
  if (r.allTeams) return `${r.label} is open to every team.`;
  if (r.teams.length === 0) return `${r.label} is not open to any team.`;
  return `${r.label} is open to ${r.teams.map((t) => t.name).join(', ')}.`;
}

// ---- forms ----------------------------------------------------------------------------------------------------

export type FormErrors = Partial<Record<'label' | 'name' | 'baseUrl' | 'apiKey' | 'profileRule' | 'modelAlias' | 'teams', string>>;

const FRIENDLY: Record<keyof FormErrors, string> = {
  label: 'Give the runner a name people can read, up to 80 characters.',
  name: 'Use lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit (up to 63 characters).',
  baseUrl: 'Use an http or https address, such as https://hermes.example.com:8642, with no password, query or fragment.',
  apiKey: 'The key is at least 8 characters.',
  profileRule: 'Use letters, digits, dots, dashes or underscores, and include {bot} where the bot’s short name goes.',
  modelAlias: 'Choose a model name.',
  teams: 'Choose the team.',
};

const errorsOf = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): FormErrors => {
  const out: FormErrors = {};
  for (const i of issues) {
    const k = i.path[0];
    if (typeof k === 'string' && k in FRIENDLY) out[k as keyof FormErrors] = FRIENDLY[k as keyof FormErrors];
  }
  return out;
};

/** A short name from the readable one: "Office Hermes" becomes "office-hermes". */
export function suggestName(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 63)
    .replace(/[^a-z0-9]+$/g, '');
  return BotRunnerName.safeParse(slug).success ? slug : '';
}

export const DEFAULT_PROFILE_RULE = '{bot}';

export type RunnerFormValues = {
  label: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  profileRule: string;
  modelAlias: string;
  teams: TeamsChoice;
};

export const emptyForm = (): RunnerFormValues => ({ label: '', name: '', baseUrl: '', apiKey: '', profileRule: DEFAULT_PROFILE_RULE, modelAlias: '', teams: NO_TEAMS });

type Checked = { ok: true; body: CreateBotRunnerRequest } | { ok: false; errors: FormErrors };

/** Check an add form for one of the kinds that can be made now, with the server's own schema, so the page never accepts what the server would refuse. */
export function validateNew(kind: BotRunnerKind, v: RunnerFormValues): Checked {
  const errors: FormErrors = {};
  const teams = teamsBody(v.teams);
  if (teams === null) errors.teams = FRIENDLY.teams;
  const draft: Record<string, unknown> = { name: v.name.trim(), label: v.label.trim(), kind };
  if (teams !== null) draft['teams'] = teams;
  if (kind === 'hermes_gateway') {
    draft['baseUrl'] = v.baseUrl.trim();
    draft['apiKey'] = v.apiKey;
    draft['profileRule'] = v.profileRule.trim() === '' ? DEFAULT_PROFILE_RULE : v.profileRule.trim();
  }
  if (kind === 'llm_gateway') {
    if (v.modelAlias === '') errors.modelAlias = FRIENDLY.modelAlias;
    else draft['modelAlias'] = v.modelAlias;
  }
  const r = CreateBotRunnerRequest.safeParse(draft);
  if (!r.success) Object.assign(errors, errorsOf(r.error.issues));
  if (kind === 'hermes_gateway' && v.apiKey === '') errors.apiKey = 'Type the gateway’s key.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return r.success ? { ok: true, body: r.data } : { ok: false, errors };
}

/** What an edit of a gateway changes. Only changed fields are sent; a blank key means "keep the key that is set". */
export function validateEdit(
  current: Pick<BotRunner, 'kind' | 'label' | 'baseUrl' | 'profileRule' | 'modelAlias'>,
  v: Pick<RunnerFormValues, 'label' | 'baseUrl' | 'apiKey' | 'profileRule' | 'modelAlias'>,
): { ok: true; body: UpdateBotRunnerRequest; changed: boolean } | { ok: false; errors: FormErrors } {
  const draft: Record<string, unknown> = {};
  if (v.label.trim() !== current.label) draft['label'] = v.label.trim();
  if (current.kind === 'hermes_gateway') {
    if (v.baseUrl.trim() !== (current.baseUrl ?? '')) draft['baseUrl'] = v.baseUrl.trim();
    if (v.apiKey !== '') draft['apiKey'] = v.apiKey;
    if (v.profileRule.trim() !== (current.profileRule ?? DEFAULT_PROFILE_RULE)) draft['profileRule'] = v.profileRule.trim();
  }
  if (current.kind === 'llm_gateway' && v.modelAlias !== (current.modelAlias ?? '')) draft['modelAlias'] = v.modelAlias;
  const r = UpdateBotRunnerRequest.safeParse(draft);
  if (!r.success) return { ok: false, errors: errorsOf(r.error.issues) };
  return { ok: true, body: r.data, changed: Object.keys(draft).length > 0 };
}

/** The checks that need no server: label, name and rule on their own, for a live hint under a field. */
export const labelProblem = (label: string): string | null => (BotRunnerLabel.safeParse(label).success ? null : FRIENDLY.label);
export const nameProblem = (name: string): string | null => (BotRunnerName.safeParse(name.trim()).success ? null : FRIENDLY.name);
export const profileRuleProblem = (rule: string): string | null => (BotRunnerProfileRule.safeParse(rule.trim()).success ? null : FRIENDLY.profileRule);

/** The profile for a test, or an error sentence when what was typed is not a profile name. */
export function testProfile(typed: string): { ok: true; profile?: string } | { ok: false; error: string } {
  const t = typed.trim();
  if (t === '') return { ok: true };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t)) return { ok: false, error: 'A profile name uses letters, digits, dots, dashes or underscores.' };
  return { ok: true, profile: t };
}

// ---- model aliases (LLM gateway form) -------------------------------------------------------------------------

/** The model names an LLM gateway runner can be given: the aliases the LLM page has bound, in the order that page lists them. */
export const boundAliases = (aliases: ReadonlyArray<{ alias: string }>): string[] => aliases.map((a) => a.alias);

// ---- old connections ------------------------------------------------------------------------------------------

/** One line about an old connection: whose it is, what it is, and how many bots depend on it. */
export function describeOld(c: Pick<OldConnection, 'teamName' | 'kind' | 'agent' | 'botCount'>): string {
  const what = c.kind === 'managed' ? "the team's own Hermes pod" : c.agent === 'hermes' ? 'a Hermes gateway' : c.agent === 'claude-code' ? 'a Claude Code connection' : 'a Codex connection';
  return `${c.teamName} · ${what} · ${countBots(c.botCount)}`;
}

/** What adopting does, in a sentence the Adopt button points to. */
export function adoptWords(c: Pick<OldConnection, 'kind' | 'teamName'>): string {
  return c.kind === 'managed'
    ? `Adopting adds ${c.teamName} to the shared team pod runner. Nothing changes for its bots.`
    : `Adopting makes a runner with the same address and its own copy of the key, for ${c.teamName} only. Nothing changes for its bots.`;
}
