import type { PluginTx, ProviderImpl } from './types.ts';
import type { TeamRow } from './http.ts';

// The seam of the bot page's Deploy action (PLAN P8-34). Deploying a bot is three acts that three plugins own: committing its definition (proposals, the one way a change reaches
// `bots/`), making its knowledge bases ready (knowledge) and switching on the connections it uses (connections). The workshop plugin composes them for the action; each owner
// registers its own step as a provider of kind `deploy.step`, with the step's name as the provider's `id`, and the action looks them up when it runs
// (`ctx.providers.get<DeployStep>('deploy.step', 'knowledge')`, in the request, not in `register`: the owner may load after the action's plugin). Nothing here is a lifecycle state:
// the bot's liveness stays the loader's, a base's stays `knowledge_bases.status`, a connection's stays `connections.status`.

export const DEPLOY_STEPS = ['definition', 'knowledge', 'connection'] as const;
export type DeployStepName = (typeof DEPLOY_STEPS)[number];

/** What the bot's definition says it uses: every name is a short name from its BOT.md (`knowledge:` bases, `capabilities.connections` and the `inbox` trigger's connection). */
export interface DeployScope {
  team: TeamRow;
  botSlug: string;
  /** `bots/<slug>/BOT.md`. */
  path: string;
  /** The text to commit, or null when the file as it is in the repo is what is deployed. */
  content: string | null;
  /** The blob the text was written from (undefined: the file as it is now). A file someone else changed meanwhile is refused, not overwritten. */
  baseBlobSha: string | null | undefined;
  bases: string[];
  connections: string[];
}

/**
 * What one step came to. `changed`: it did something (a commit, documents read, a connection switched on). `unchanged`: what it owns was already as the deploy wants it. `not_used`:
 * the definition uses nothing of this kind. `refused`: it could not be done, and `message` says why in the words a person reads.
 */
export type DeployState = 'changed' | 'unchanged' | 'not_used' | 'refused';

export interface DeployOutcome {
  state: DeployState;
  message: string;
}

export interface DeployStep extends ProviderImpl {
  id: DeployStepName;
  /**
   * Can this step be done, as the person asking? Reads only: no write, no network call. Answers null when it can, or the reason it cannot, in plain words. The action runs every step's
   * check before it changes anything, so a refusal that could be known in advance leaves nothing half done.
   */
  check(tx: PluginTx, scope: DeployScope): Promise<string | null>;
  /** Does the step, as the person asking, in the caller's transaction. A refusal is an outcome with state `refused`, not an exception, so the action can report all three. */
  apply(tx: PluginTx, scope: DeployScope): Promise<DeployOutcome>;
}
