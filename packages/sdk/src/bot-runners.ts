import type { ProviderImpl } from './types.ts';

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
  /** The state the runner was last found in (`off` when disabled). The run-start check of a later task refuses anything but `ready`. */
  status: string;
}

/** Why a runner cannot be used for a run. `message` is one plain sentence, safe to post in a thread. */
export type RunnerRefusal = {
  ok: false;
  reason: 'unknown' | 'disabled' | 'not_available_to_team' | 'not_runnable' | 'not_set_up';
  message: string;
};

export type RunnerResolution = { ok: true; target: RunnerTarget } | RunnerRefusal;

export interface BotRunnersProvider extends ProviderImpl {
  id: 'bot.runners';
  /**
   * The target of runner `runner` for a bot of `teamId`, or why not. Refuses a runner that is unknown to the team's workspace, switched off, not
   * available to the team (the team list is the permission), or of a kind that cannot run a bot yet. Runs as the system actor and is the only reader of
   * a runner's key.
   */
  resolveRunner(query: { teamId: string; runner: string }): Promise<RunnerResolution>;
}
