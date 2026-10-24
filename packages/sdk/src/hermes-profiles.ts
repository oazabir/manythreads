import type { ProviderImpl } from './types.ts';

// The `hermes.profiles` provider (registered by `runtime-hermes`): what a controller needs in order to keep a team's managed Hermes pod
// (mode B) in step with the team's bots. Look it up when you need it, not in `register`: `ctx.providers.get<HermesProfilesProvider>('hermes.profiles')`.
//
// A bot placed on the managed gateway (`placement: { gateway: { connection: managed } }`) is one Hermes *profile* in the team's pod, named
// `mt-<bot slug>`. The platform renders that profile (identity, tools, model, the MCP address) and owns the three credentials it needs;
// the controller only writes the files and the secrets into the pod and keeps the pod's gateway serving them.

/** One bot's profile as the pod must hold it. */
export interface GatewayProfileSpec {
  /** The profile's directory name in the pod: `mt-<bot slug>`. Requests reach it at `/p/<profile>/v1/...`. */
  profile: string;
  botId: string;
  /**
   * The profile's files by name: `SOUL.md`, `config.yaml` and `.env.template` (the `.env` with every secret written as `${NAME}` is NOT what Hermes
   * reads: the controller writes the real `.env` from `secrets`, using the same names). `config.yaml` refers to secrets only by variable name.
   */
  files: Record<string, string>;
  /**
   * The three credentials of the profile, as the variables the files name. `MCP_TOKEN` is the bot's pairing token (the bot-level token of the
   * stable MCP endpoint), `LLM_KEY` the bot's virtual key at the LLM gateway, `API_SERVER_KEY` the key that authorises requests to this profile.
   * Treat the whole object as secret: never log it and keep it out of anything but the pod's secret store.
   */
  secrets: { MCP_TOKEN: string; LLM_KEY: string; API_SERVER_KEY: string };
}

export interface HermesProfilesProvider extends ProviderImpl {
  id: 'hermes.profiles';
  /** Every active bot of the team that is placed on the managed gateway, rendered. Idempotent: credentials are created on first use and then stable. */
  profilesForTeam(teamId: string): Promise<GatewayProfileSpec[]>;
  /**
   * Tell the platform where the team's own pod answers, so runs of managed bots go there (the connection named `managed`). Idempotent; `apiKey` is
   * the pod's gateway key used for the `/health` check only when no per-profile key applies (requests to a profile always use that profile's `API_SERVER_KEY`).
   */
  setManagedGateway(teamId: string, input: { baseUrl: string }): Promise<void>;
  /**
   * Call `listener` after the team's managed profile set changes (also announced as the `hermes.profiles.changed` event). Returns a function that stops listening.
   * The listener runs in this process only; across replicas, subscribe to the event instead.
   */
  onChange(listener: (change: { teamId: string }) => void): () => void;
}
