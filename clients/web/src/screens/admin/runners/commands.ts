import {
  BotRunnerName,
  BotRunnerLabel,
  BotRunnerProfileRule,
  CreateBotRunnerRequest,
  UpdateBotRunnerRequest,
  inspectClaudeCredentials,
  inspectCodexCredentials,
  type BotRunner,
  type ClaudeRunnerUsageRow,
  type BotRunnerKind,
  type BotRunnerStatus,
  type OldConnection,
  type RunnerNode,
  type RunnerPlacement,
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
    unavailable: 'Not turned on in this install.',
  },
  {
    kind: 'codex_cli',
    title: 'Codex',
    sentence: 'Runs the Codex program in its own pod, signed in with a ChatGPT plan.',
    available: false,
    unavailable: 'Not turned on in this install.',
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

/** The chooser's cards; the Claude Code and Codex cards can be picked only when the server says pods for them are turned on (one switch for both). */
export const cardsFor = (claudePodsAvailable: boolean): readonly KindCard[] =>
  KIND_CARDS.map((c) => ((c.kind === 'claude_cli' || c.kind === 'codex_cli') && claudePodsAvailable ? { ...c, available: true } : c));

export const DEFAULT_PROFILE_RULE = '{bot}';

export type RunnerFormValues = {
  label: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  profileRule: string;
  modelAlias: string;
  teams: TeamsChoice;
  /** Claude Code and Codex only: how many bot runs at once, 1 to 4. */
  maxConcurrent: number;
};

export const emptyForm = (): RunnerFormValues => ({ label: '', name: '', baseUrl: '', apiKey: '', profileRule: DEFAULT_PROFILE_RULE, modelAlias: '', teams: NO_TEAMS, maxConcurrent: 2 });

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
  if (kind === 'claude_cli' || kind === 'codex_cli') draft['maxConcurrent'] = v.maxConcurrent;
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

// ---- the machine a pod runner stands on (P19-08) -------------------------------------------------------------

/** The value of the "let the cluster choose" option in the machine select. */
export const NODE_AUTO = '';

/** Only the team Hermes pod has a machine to choose; the other kinds run elsewhere. */
export const hasNodeChoice = (r: Pick<BotRunner, 'kind'>): boolean => r.kind === 'hermes_pod' || r.kind === 'claude_cli';

/**
 * The state line under a pod runner: where its pods stand now, in plain words. `placement` comes from the server live (the cluster is asked); `chosen` is the
 * machine stored on the runner. Null when there is nothing worth saying (the cluster cannot be asked and no machine is chosen).
 */
export function placementLine(chosen: string | null, placement: RunnerPlacement | null): { text: string; tone: 'ok' | 'warn' | 'idle' } | null {
  if (placement === null) return chosen === null ? null : { text: `Set to run on ${chosen}.`, tone: 'idle' };
  const at = placement.node ?? chosen;
  switch (placement.state) {
    case 'running':
      return { text: at ? `Running on ${at}` : 'Running', tone: 'ok' };
    case 'moving':
      return { text: at ? `Moving to ${at}. The work volumes are being made again there.` : 'Moving. The work volumes are being made again.', tone: 'warn' };
    case 'waiting':
      if (placement.reason === 'move_not_confirmed') return { text: 'Waiting: the machine for this pod changed, and nothing has been moved. Open Machine and confirm the move.', tone: 'warn' };
      if (placement.reason === 'node_not_ready') return { text: `Waiting: node ${at ?? 'chosen'} is not Ready`, tone: 'warn' };
      if (placement.reason === 'starting') return { text: at ? `Waiting: the pod is starting on ${at}` : 'Waiting: the pod is starting', tone: 'warn' };
      return { text: at ? `Waiting: no pod can be placed on ${at} yet` : 'Waiting: no pod can be placed yet', tone: 'warn' };
    case 'idle':
      return { text: at ? `Set to run on ${at}. No team pod has started yet.` : 'The cluster chooses the machine. No team pod has started yet.', tone: 'idle' };
  }
}

/**
 * Is the pod's state changing by itself, so the page should look again? A move under way and a pod that is starting or waiting for a machine are. A move that waits for the
 * admin's word is not: nothing changes until someone acts, so there is nothing to poll for.
 */
export const isChangingPlacement = (p: RunnerPlacement | null): boolean => p !== null && (p.state === 'moving' || (p.state === 'waiting' && p.reason !== 'move_not_confirmed'));

/** Does the pod's machine need the admin's confirmation (the machine changed without a move being confirmed)? */
export const needsMoveConfirm = (p: RunnerPlacement | null): boolean => p !== null && p.state === 'waiting' && p.reason === 'move_not_confirmed';

/** "offers 4 CPUs and 16 GiB of memory": what a machine can give to pods. It is not what is left over, so the word is "offers". */
export function offerWords(n: Pick<RunnerNode, 'cpuAllocatableMillis' | 'memoryAllocatableBytes'>): string | null {
  const parts: string[] = [];
  if (n.cpuAllocatableMillis !== null) {
    const cpus = Math.round(n.cpuAllocatableMillis / 100) / 10;
    parts.push(`${cpus} ${cpus === 1 ? 'CPU' : 'CPUs'}`);
  }
  if (n.memoryAllocatableBytes !== null) {
    const gib = Math.round((n.memoryAllocatableBytes / 1024 ** 3) * 10) / 10;
    parts.push(`${gib} GiB of memory`);
  }
  return parts.length === 0 ? null : `offers ${parts.join(' and ')}`;
}

/** The text of one choice in the machine select: its name, and in a few words what is worth knowing before picking it. */
export function nodeOption(n: RunnerNode): string {
  const notes = [n.ready ? null : 'not Ready', n.workVolumes > 0 ? 'has the work volume' : null, n.architecture, offerWords(n)].filter((x): x is string => Boolean(x));
  return notes.length === 0 ? n.name : `${n.name} (${notes.join(', ')})`;
}

/** The sentence under the select when the install has exactly one machine, or null. */
export const singleNodeLine = (nodes: ReadonlyArray<Pick<RunnerNode, 'name'>>, singleNode: boolean): string | null =>
  singleNode && nodes.length === 1 ? `This install has one machine, ${nodes[0]!.name}. There is nothing to choose; every pod runs there.` : null;

/** The machines a pod's work volume sits on now, other than `target`. A change to `target` recreates the volume when this is not empty. */
export const volumesElsewhere = (nodes: ReadonlyArray<Pick<RunnerNode, 'name' | 'workVolumes'>>, target: string | null): string[] =>
  target === null ? [] : nodes.filter((n) => n.workVolumes > 0 && n.name !== target).map((n) => n.name);

/**
 * The confirm text of a machine change, or null when nothing is lost. Said plainly because it cannot be undone: the pod's two volumes are made again,
 * empty, on the new machine. The Secrets (keys) are kept, so the pod comes back up and clones its repositories again.
 */
export function moveWarning(label: string, from: readonly string[], to: string): string | null {
  if (from.length === 0) return null;
  return (
    `${label}’s work volumes now sit on ${from.join(' and ')}. A volume stays on one machine, so they will be deleted and made again, empty, on ${to}. ` +
    'The bots’ working copies and any work not yet pushed to its repository are lost, and each Hermes profile starts with an empty history. ' +
    'The keys are kept, and the repositories are cloned again when the pod starts.'
  );
}

/** What the admin reads after saving the machine. */
export function nodeSavedWords(label: string, node: string | null, recreates: boolean): string {
  if (node === null) return `${label} can now run on any machine. Pods already placed stay where they are.`;
  return recreates ? `${label} will run on ${node}. Its work volumes are being made again there.` : `${label} will run on ${node}.`;
}

// ---- the Claude Code and Codex sign-in (P19-06, P19-13) -------------------------------------------------------

/** The two kinds that are signed in with a file the admin uploads. */
export type SigninKind = 'claude_cli' | 'codex_cli';
export const isSigninKind = (k: BotRunnerKind): k is SigninKind => k === 'claude_cli' || k === 'codex_cli';

/** The words that differ between the two: the program, the plan, the file. One table, so the Codex sentences stay beside the Claude ones. */
export const SIGNIN_WORDS: Record<SigninKind, { program: string; plan: string; fileName: string; fileFor: string; login: string; terms: string; termsLabel: string; usageHeader: string; refused: string }> = {
  claude_cli: {
    program: 'Claude Code',
    plan: 'Claude plan',
    fileName: '.credentials.json',
    fileFor: 'Choose the .credentials.json file of a Claude login.',
    login: 'Claude login',
    terms: "Confirm that the Claude plan's terms allow sharing this runner.",
    termsLabel: "The Claude plan's terms allow this login to be shared by the teams I chose.",
    usageHeader: "Claude's own cost figure",
    refused: "Claude refused this runner's sign-in.",
  },
  codex_cli: {
    program: 'Codex',
    plan: 'ChatGPT plan',
    fileName: 'auth.json',
    fileFor: 'Choose the auth.json file of a Codex login with a ChatGPT account.',
    login: 'ChatGPT login',
    terms: "Confirm that the ChatGPT plan's terms allow sharing this runner.",
    termsLabel: "The ChatGPT plan's terms allow this login to be shared by the teams I chose.",
    usageHeader: "Codex's own cost figure",
    refused: "Codex refused this runner's sign-in.",
  },
};

/** What the page shows of a chosen sign-in file before it goes up. Read here in the browser only; no token is ever in it. */
export type SigninPreview =
  | { ok: true; plan: string; expiresWords: string; others: { count: number; names: string[] }; needsAck: boolean }
  | { ok: false; message: string };

const dateWords = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/**
 * The summary of a chosen file's text. Reads the shape with the shared reader; the text is then sent unchanged. For a Codex file the plan name and the access token's expiry are
 * read from the two tokens here, in the browser (the server reads no token), and the page sends the plan name in a header.
 */
export function previewSignin(text: string, kind: SigninKind = 'claude_cli', now: number = Date.now()): SigninPreview {
  if (kind === 'codex_cli') {
    const looked = inspectCodexCredentials(text, { readPlan: true });
    if (!looked.ok) return { ok: false, message: looked.message };
    const s = looked.summary;
    const expiresWords =
      s.expiresAt === null
        ? 'Codex renews the access part by itself.'
        : s.expiresAt <= now
          ? `The access part ran out on ${dateWords(s.expiresAt)}. Codex renews it by itself.`
          : `The access part runs out on ${dateWords(s.expiresAt)}. Codex renews it by itself.`;
    return { ok: true, plan: s.planLabel, expiresWords, others: { count: s.otherCount, names: s.otherNames }, needsAck: s.otherCount > 0 };
  }
  const looked = inspectClaudeCredentials(text, now);
  if (!looked.ok) return { ok: false, message: looked.message };
  const s = looked.summary;
  return {
    ok: true,
    plan: s.planLabel,
    expiresWords: s.expiresAt <= now ? `The access part ran out on ${dateWords(s.expiresAt)}. Claude Code renews it by itself.` : `The access part runs out on ${dateWords(s.expiresAt)}. Claude Code renews it by itself.`,
    others: { count: s.otherSignins, names: s.otherNames },
    needsAck: s.otherSignins > 0,
  };
}

export function othersSentence(p: { count: number; names: string[] }, kind: SigninKind = 'claude_cli'): string {
  const names = p.names.length > 0 ? ` (${p.names.join(', ')}${p.count > p.names.length ? ', …' : ''})` : '';
  if (kind === 'codex_cli') {
    if (p.count === 0) return 'The file holds nothing beyond the Codex login.';
    const one = p.count === 1;
    return `The file also holds ${one ? '1 other entry' : `${p.count} other entries`}${names}. ${one ? 'It is' : 'They are'} stored with the file, as ${one ? 'it is' : 'they are'}, in this runner's pod.`;
  }
  if (p.count === 0) return 'The file holds no other sign-ins.';
  return `The file also holds ${p.count === 1 ? '1 other sign-in' : `${p.count} other sign-ins`}${names}. They are stored with it, as they are, in this runner's pod.`;
}

export type UploadChecks = { termsTicked: boolean; signinsTicked: boolean };

/** Why Upload cannot go yet, in one sentence; null when it can. */
export function uploadProblem(preview: SigninPreview | null, c: UploadChecks, kind: SigninKind = 'claude_cli'): string | null {
  if (preview === null) return SIGNIN_WORDS[kind].fileFor;
  if (!preview.ok) return preview.message;
  if (!c.termsTicked) return SIGNIN_WORDS[kind].terms;
  if (preview.needsAck && !c.signinsTicked) return kind === 'codex_cli' ? 'Confirm that the other entries in the file may be stored with it, as they are.' : 'Confirm that the other sign-ins in the file may be stored as they are.';
  return null;
}

export function signedInWords(r: Pick<BotRunner, 'planLabel' | 'credentialsExpiresAt' | 'uploadedAt'> & { kind?: BotRunnerKind }): string | null {
  if (!r.uploadedAt) return null;
  return `Signed in: ${r.planLabel ?? (r.kind === 'codex_cli' ? SIGNIN_WORDS.codex_cli.plan : SIGNIN_WORDS.claude_cli.plan)}. Uploaded ${r.uploadedAt.slice(0, 10)}.`;
}

export const needsSigninBanner = (r: Pick<BotRunner, 'kind' | 'status'>): boolean => isSigninKind(r.kind) && r.status === 'needs_sign_in';

export type UsageLine = { team: string; runs: number; minutes: number; cost: string | null };

/** The usage rows of one runner, added up per team over the days the server sent. The cost is the CLI's own figure, shown as it is. */
export function usageLines(rows: ReadonlyArray<ClaudeRunnerUsageRow>, runnerId: string): UsageLine[] {
  const by = new Map<string, { team: string; runs: number; seconds: number; cost: number }>();
  for (const r of rows) {
    if (r.runnerId !== runnerId) continue;
    const e = by.get(r.teamId) ?? { team: r.teamName, runs: 0, seconds: 0, cost: 0 };
    e.runs += r.runs;
    e.seconds += r.seconds;
    e.cost += r.cliCost;
    by.set(r.teamId, e);
  }
  return [...by.values()]
    .sort((a, b) => b.runs - a.runs || a.team.localeCompare(b.team))
    .map((e) => ({ team: e.team, runs: e.runs, minutes: Math.round(e.seconds / 60), cost: e.cost > 0 ? e.cost.toFixed(2) : null }));
}
