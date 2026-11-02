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
  checkPlacement(tx: PluginTx, query: { teamId: string; runner: string; runtimeGrants?: readonly string[] }): Promise<RunnerPlacementCheck>;
  /**
   * What kind of runner `runner` is for a bot of `teamId` (and the model alias, for an LLM gateway runner), or null when there is no such runner. Runs on the CALLER's transaction. The run job
   * asks it to pick the `model` runtime for a bot placed on an LLM gateway runner; whether the run may start is `resolveRunner`'s question, not this one's.
   */
  kindOf(tx: PluginTx, query: { teamId: string; runner: string }): Promise<{ kind: RunnerTarget['kind']; modelAlias: string | null } | null>;
  /** The default runner and the pod runners that apply to a team (P19-03). Runs as the system actor. */
  teamRunners(query: { teamId: string }): Promise<TeamRunnerInfo>;
}
