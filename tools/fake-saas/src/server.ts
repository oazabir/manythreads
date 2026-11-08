import type { FakeProviders } from '../../../packages/test-utils/src/fake-providers.ts';
import { defaultAccount, type FakeAccountData } from '../../../packages/test-utils/src/fake-providers-data.ts';
import type { FakeSupport } from '../../../packages/test-utils/src/fake-support.ts';
import type { FakeTrackers } from '../../../packages/test-utils/src/fake-trackers.ts';
import { startControl, type Control } from './control.ts';
import { PROVIDER_MODULES } from './providers/registry.ts';
import { sendWebhook, type SendWebhookOptions, type SendWebhookResult } from './providers/sender.ts';
import type { FakeTelegram, TelegramSendInput, TelegramSendResult } from './providers/telegram.ts';
import type { StandInHandle, StandInModule } from './providers/types.ts';
import { createState, resetState, type FakeSaasState } from './state.ts';
import { seedRefreshToken, seedToken, type SeedGrant, type SeedProvider } from './tokens.ts';

/*
 * fake-saas: the one process that hosts every stand-in of Bundle D (PLAN P16-12). `startFakeSaas()` starts each module of the registry on its own port (the base
 * port, then base + 2 ..., with the control port at base + 1; port 0 asks the OS for all of them), the control port, and returns one object a spec or the CLI uses.
 * It refuses to start when NODE_ENV=production: a stand-in that signs in anybody has no place in a live release.
 */

export interface StartFakeSaasOptions {
  /** The interface to bind (default 127.0.0.1). */
  host?: string;
  /** The host name written into the addresses the stand-ins hand out (default: `host`, or 127.0.0.1 for 0.0.0.0): what a pod or a browser must dial. */
  publicHost?: string;
  /** The base port (default 0: free ports). The control port is base + 1. */
  port?: number;
  /** The key the seeded tokens are derived from (default `manythreads-seed`). */
  seedKey?: string;
  /** Sign-ins that exist before any consent; their tokens are `seedToken(provider, seedKey, email)`. */
  seedGrants?: SeedGrant[];
  /** The accounts the Google, Microsoft and Notion stand-in holds (default: its one default account, or one per seeded address). */
  accounts?: FakeAccountData[];
  /** The app id and secret the stand-ins accept (default: each fake's own). */
  clientId?: string;
  clientSecret?: string;
  /** When set, every control call must carry it in `x-fake-saas-key`. */
  controlKey?: string;
  /** Options of one module, by its id (`telegram`: `{ bots, strictChats }`). */
  modules?: Record<string, unknown>;
  /** A different list of modules (a test of one module); default: the registry. */
  only?: readonly StandInModule[];
}

export interface FakeSaasControl {
  /** `http://<publicHost>:<port>` of the control port. */
  url: string;
  sendWebhook(options: SendWebhookOptions): Promise<SendWebhookResult>;
  telegramSend(input: TelegramSendInput): Promise<TelegramSendResult>;
  /** Everything the stand-ins saw, as plain JSON. Never a token. */
  state(): Record<string, unknown>;
  reset(): void;
}

export interface FakeSaas {
  host: string;
  publicHost: string;
  seedKey: string;
  /** Google, Microsoft and Notion. */
  workspace: FakeProviders;
  trackers: FakeTrackers;
  support: FakeSupport;
  telegram: FakeTelegram;
  /** Every module by id, the ones of the registry that have no field of their own included. */
  standIns: Record<string, StandInHandle>;
  control: FakeSaasControl;
  /** The variables for the server under test: app ids and secrets, the fake base of every provider, the bridge bases, and where the control port is. */
  env(): Record<string, string>;
  /** The token a seeded grant carries (access and refresh). */
  seedTokens(provider: SeedProvider, email: string): { accessToken: string; refreshToken: string };
  state: FakeSaasState;
  stop(): Promise<void>;
}

export function refuseProduction(env: Record<string, string | undefined> = process.env): void {
  if (env['NODE_ENV'] === 'production') throw new Error('fake-saas refuses to start when NODE_ENV=production: a stand-in that signs in anybody has no place in a live release');
}

export async function startFakeSaas(options: StartFakeSaasOptions = {}): Promise<FakeSaas> {
  refuseProduction();
  const host = options.host ?? '127.0.0.1';
  const publicHost = options.publicHost ?? (host === '0.0.0.0' ? '127.0.0.1' : host);
  const seedKey = options.seedKey ?? 'manythreads-seed';
  const base = options.port ?? 0;
  const grants = options.seedGrants ?? [];
  const accounts = options.accounts;
  const modules = options.only ?? PROVIDER_MODULES;
  const state = createState();
  const handles: StandInHandle[] = [];
  let control: Control | undefined;

  try {
    let next = base;
    for (const mod of modules) {
      if (base !== 0 && next === base + 1) next++;
      const handle = await mod.start({
        host,
        publicHost,
        port: base === 0 ? 0 : next,
        seedKey,
        seedGrants: grants,
        accounts: accounts ?? (grants.length > 0 ? [...new Set(grants.map((g) => g.email))].map((email) => defaultAccount(email)) : undefined),
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        options: options.modules?.[mod.id],
      });
      handles.push(handle);
      next += mod.ports ?? 1;
    }
    const byId = Object.fromEntries(handles.map((h) => [h.id, h])) as Record<string, StandInHandle>;
    const api = <T>(id: string): T => {
      const h = byId[id];
      if (!h) throw new Error(`the stand-in "${id}" is not running`);
      return h.api as T;
    };
    const stateOf = (): Record<string, unknown> => ({ ...Object.fromEntries(handles.map((h) => [h.id, h.state()])), webhooksSent: state.webhooksSent });
    const reset = (): void => {
      for (const h of handles) h.reset();
      resetState(state);
    };
    const record = async (o: SendWebhookOptions): Promise<SendWebhookResult> => {
      const result = await sendWebhook(o);
      state.webhooksSent.push({ provider: o.provider, kind: o.kind, tamper: o.tamper ?? 'none', target: o.url.split('?')[0]!, statuses: result.responses.map((r) => r.status), at: new Date().toISOString() });
      return result;
    };
    const controlApi: FakeSaasControl = {
      url: '',
      sendWebhook: record,
      telegramSend: (input) => api<FakeTelegram>('telegram').telegramSend(input),
      state: stateOf,
      reset,
    };
    const saas: FakeSaas = {
      host,
      publicHost,
      seedKey,
      get workspace() {
        return api<FakeProviders>('workspace');
      },
      get trackers() {
        return api<FakeTrackers>('trackers');
      },
      get support() {
        return api<FakeSupport>('support');
      },
      get telegram() {
        return api<FakeTelegram>('telegram');
      },
      standIns: byId,
      control: controlApi,
      env: () => ({ ...Object.assign({}, ...handles.map((h) => h.env())), FAKE_SAAS_CONTROL: controlApi.url }),
      seedTokens: (provider, email) => ({ accessToken: seedToken(provider, seedKey, email), refreshToken: seedRefreshToken(provider, seedKey, email) }),
      state,
      stop: async () => {
        await control?.stop();
        await Promise.all(handles.map((h) => h.stop()));
      },
    };
    control = await startControl({
      host,
      publicHost,
      port: base === 0 ? 0 : base + 1,
      ...(options.controlKey ? { key: options.controlKey } : {}),
      saas,
      record,
    });
    controlApi.url = control.url;
    return saas;
  } catch (error) {
    await control?.stop().catch(() => undefined);
    await Promise.all(handles.map((h) => h.stop().catch(() => undefined)));
    throw error;
  }
}
