import type { FakeAccountData } from '../../../../packages/test-utils/src/fake-providers-data.ts';
import type { SeedGrant } from '../tokens.ts';

/*
 * The shape of a stand-in module (PLAN Bundle D, WP-0b). A module starts one or more local HTTP servers that answer like a provider, and hands back a handle: the
 * addresses, the variables that point the server under test at it, a token-free picture of what it saw, and a way to forget it. The ones that need a control action
 * of their own (Slack, Teams, Confluence ...) answer `control` under `/__fake/<id>/...`; nothing else in fake-saas has to change when a module is added.
 */

export interface StandInContext {
  /** The interface to bind. */
  host: string;
  /** The host name written into the addresses a module hands out (default: `host`, or 127.0.0.1 for 0.0.0.0). */
  publicHost: string;
  /** The first port this module may use (0: ask the OS). A module that opens several servers uses consecutive ports from here, as many as its `ports`. */
  port: number;
  seedKey: string;
  seedGrants: SeedGrant[];
  /** The accounts the workspace stand-in holds (undefined: its default one). */
  accounts: FakeAccountData[] | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** The module's own options, from `StartFakeSaasOptions.modules[<id>]`. */
  options: unknown;
}

export interface ControlRequest {
  method: string;
  /** The path after `/__fake/<id>`, always starting with `/` (`/` when empty). */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export interface ControlResponse {
  status: number;
  body: unknown;
}

export interface StandInHandle<Api = unknown> {
  id: string;
  /** The module's own typed object (`FakeProviders`, `FakeTelegram` ...). */
  api: Api;
  /** Named addresses (`url`, or one per provider). */
  urls: Record<string, string>;
  /** The variables that make the server under test use this stand-in (app ids and secrets, fake bases). */
  env(): Record<string, string>;
  /** What the stand-in saw, as plain JSON: calls, writes, messages. Never a token, a code, a verifier or a client secret. */
  state(): Record<string, unknown>;
  /** Forget what was recorded and put the data back as it was at the start. */
  reset(): void;
  control?(request: ControlRequest): Promise<ControlResponse | null>;
  stop(): Promise<void>;
}

export interface StandInModule {
  id: string;
  /** How many consecutive ports `start` may open (default 1). */
  ports?: number;
  start(context: StandInContext): Promise<StandInHandle>;
}
