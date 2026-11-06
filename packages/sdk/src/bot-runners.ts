import { runsOnProblem, type BotFrontmatter } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// The `bot.runners` provider (registered by `bot-runners`, extension point `provider.bot.runners`): the one function that answers "where does this bot's
// run go?" (PLAN P19-02). `runtime-hermes` asks it when a bot is placed on a runner, or on a team connection that an admin adopted into one. Look it up
// when you need it, not in `register`: the plugin may load after you.
//
//   ctx.providers.get<BotRunnersProvider>('bot.runners')?.resolveRunner({ teamId, runner })
//
// Address, key and node never leave the server through this: a BOT.md, a bot API answer and a log carry the runner's NAME only.

/** The agent that answers behind a runner's address: `hermes` is a Hermes gateway, `claude-code` and `codex` are the agent bridge. */
export type RunnerAgent = 'hermes' | 'claude-code' | 'codex';

/** Where a run goes. Treat `key` as a secret: never log it. */
export interface RunnerTarget {
  runner: string;
  /** The runner's label, for the one plain line a refused run shows. Only handed out for a runner the team may use. */
  label: string;
  kind: 'hermes_gateway' | 'hermes_pod' | 'claude_cli' | 'codex_cli' | 'llm_gateway';
  /**
   * `hermes_gateway`: the address the admin typed. `hermes_pod`: where the team's own pod answers (its connection `managed`), or null before the pod is up.
   * Kinds that have no address of their own say null.
   */
  address: string | null;
  /** `hermes_gateway`: the gateway's key. `hermes_pod`: null, because each bot's profile has its own key and the caller supplies it. */
  key: string | null;
  agent: RunnerAgent;
  /** True when every request to the address must pass the outbound guard (an address a person typed). */
  guard: boolean;
  /** How a profile is named from a bot on a Hermes gateway; `{bot}` stands for the slug. */
  profileRule: string;
  /** The state the runner was last found in (`off` when disabled). A run is refused in every state a runner cannot serve (see `resolveRunner`). */
  status: string;
  /** `llm_gateway`: the model alias the runner answers with (`smart`, `fast`, ...). Null for every other kind. */
  modelAlias: string | null;
}

/** Why a runner cannot be used for a run. `message` is one plain sentence, safe to post in a thread. */
export type RunnerRefusal = {
  ok: false;
  reason: 'unknown' | 'disabled' | 'not_available_to_team' | 'not_runnable' | 'not_set_up' | 'not_ready';
  message: string;
};

export type RunnerResolution = { ok: true; target: RunnerTarget } | RunnerRefusal;

/** What the loader may ask of a `placement.runs_on`: does the runner exist, and may the bot's team use it? A switched-off runner passes (that is judged when a run starts). */
export type RunnerPlacementCheck = { ok: true } | { ok: false; message: string };

/** The runners that matter to a team when its bots are placed or started: the workspace default (only when the team may use it and it can run bots), and the pod runners the team may use. */
export interface TeamRunnerInfo {
  defaultRunner: string | null;
  /** Names of the enabled `hermes_pod` runners the team may use: a bot placed on one has a profile on the team's pod. */
  podRunners: string[];
  /**
   * The machine the team's Hermes pod is pinned to (P19-08): the node of the pod runner the team uses, in the order default runner, then name. Null: the cluster chooses.
   * Several pod runners share one pod per team, so when they name different machines the first in that order wins.
   */
  podNode?: string | null;
}

/** A bot placed on a pod runner (`placement.runs_on`), as the pod controller needs it to write the bridge's profile for it. */
export interface PodRunnerBot {
  teamId: string;
  teamSlug: string;
  botSlug: string;
}

/** One Claude Code runner, as the `claude-pods` controller reads it (P19-05). No key, no address: those stay in the catalog. */
export interface PodRunnerInfo {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  /** The machine the admin chose, or null (the cluster chooses). */
  node: string | null;
  /** Runs at once; null = the controller's default. */
  maxConcurrent: number | null;
  /** The teams on the runner's list (the list is the permission); empty with `allTeams` true means every team. */
  teams: { id: string; slug: string }[];
  allTeams: boolean;
  /** The bots placed on the runner, from the teams it serves. */
  bots: PodRunnerBot[];
}

/** What the controller found about a runner's pod; written to the catalog's status column. */
export interface PodRunnerState {
  runnerId: string;
  status: 'waiting_for_sign_in' | 'starting' | 'ready' | 'waiting_for_node' | 'moving' | 'not_set_up';
  /** One plain sentence for the admin page, or null. Never a cluster message. */
  detail: string | null;
}

export interface BotRunnersProvider extends ProviderImpl {
  id: 'bot.runners';
  /**
   * The target of runner `runner` for a bot of `teamId`, or why not. Refuses a runner that is unknown to the team's workspace, switched off, not
   * available to the team (the team list is the permission), or of a kind that cannot run a bot yet. Runs as the system actor and is the only reader of
   * a runner's key.
   */
  resolveRunner(query: { teamId: string; runner: string }): Promise<RunnerResolution>;
  /**
   * For the bot loader (P19-03): is `runner` a runner of the team's workspace, and is the team allowed to use it? Runs on the CALLER's transaction (the outbox consumer's), because
   * a subscriber must not read on a connection of its own while its transaction is open. Answers in one plain sentence that names nothing the team may not know.
   */
  checkPlacement(tx: PluginTx, query: { teamId: string; runner: string; runtimeGrants?: readonly string[]; nativeGrants?: readonly string[] }): Promise<RunnerPlacementCheck>;
  /**
   * What kind of runner `runner` is for a bot of `teamId` (and the model alias, for an LLM gateway runner), or null when there is no such runner. Runs on the CALLER's transaction. The run job
   * asks it to pick the `model` runtime for a bot placed on an LLM gateway runner; whether the run may start is `resolveRunner`'s question, not this one's.
   */
  kindOf(tx: PluginTx, query: { teamId: string; runner: string }): Promise<{ kind: RunnerTarget['kind']; modelAlias: string | null } | null>;
  /** The default runner and the pod runners that apply to a team (P19-03). Runs as the system actor. */
  teamRunners(query: { teamId: string }): Promise<TeamRunnerInfo>;
  /** The runners of one pod kind (P19-05): the Claude Code pod controller asks for its list here, so it never reads the catalog's tables. Runs as the system actor. */
  podRunners(query: { kind: 'claude_cli' }): Promise<PodRunnerInfo[]>;
  /** The pod controller reports what it found; the catalog stores it as the runner's status. A runner the admin has paused or that needs a sign-in keeps that state. */
  reportPodState(state: PodRunnerState): Promise<void>;
  /** Count one finished run of a Claude Code runner for the team that used it (P19-07): runs, seconds and the CLI's own cost figure, per runner, team and day. Runs as the system actor. */
  recordUsage(input: { runner: string; teamId: string; seconds: number; cost: number | null }): Promise<void>;
  /**
   * A Claude Code runner stopped taking runs by itself: `plan_limit` pauses it until `until` (null or not usable: a short default, then the next run tries again), `needs_sign_in` marks it so until a new sign-in file is uploaded.
   * Writes the state and the `claude_pod.runner.paused` event once (a runner already in that state is left alone). Runs as the system actor.
   */
  pauseRunner(input: { runner: string; teamId: string; reason: 'plan_limit' | 'needs_sign_in'; until: string | null }): Promise<void>;
}

/**
 * The one placement question for a parsed BOT.md, shared by the bot loader (when the file is committed) and the proposal check (before it is applied), so the two cannot disagree:
 * `placement.runs_on` is for Hermes bots, the runner exists and the team may use it, and a runner that only calls a model suits the bot (no shell, files or browser asked for, and a way
 * to post the reply). Null when the placement is fine or the definition names no runner; else one plain sentence for the `placement.runs_on` field. Reads on the caller's `tx`, which must be
 * able to read the runner catalog (the loader's system transaction); `runners` is the `bot.runners` provider, undefined when that plugin is off.
 */
export async function botPlacementProblem(runners: BotRunnersProvider | undefined, tx: PluginTx, query: { teamId: string; frontmatter: Pick<BotFrontmatter, 'runtime' | 'placement' | 'capabilities'> }): Promise<string | null> {
  const fm = query.frontmatter;
  const rules = runsOnProblem(fm);
  if (rules !== null) return rules;
  const runsOn = fm.placement?.runs_on;
  if (runsOn === undefined) return null;
  if (!runners) return 'Runners are not available on this server, so "runs_on" cannot be used.';
  const verdict = await runners.checkPlacement(tx, { teamId: query.teamId, runner: runsOn, runtimeGrants: fm.capabilities?.runtime ?? [], nativeGrants: fm.capabilities?.native ?? [] });
  return verdict.ok ? null : verdict.message;
}
