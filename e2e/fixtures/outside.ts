import { defaultAccount, startFakeGithub, startFakeProviders, type FakeGithub, type FakeProviders } from '@manythreads/test-utils';
import { startFakeSaas, type FakeSaas, type StartFakeSaasOptions } from '../../tools/fake-saas/src/index.ts';

// The outside services the specs talk to (PLAN P8-12): a fake Google, Microsoft 365 and Notion on one local address, and a fake GitHub. Both run in the spec's own
// process and answer over real HTTP, so the server under test (started with `outside.env`) reaches them the way it reaches the real ones. No real account is touched
// and no secret is real: the app id and secret below exist only for the run.

/** The token the fake GitHub accepts; a spec connects a repository with it. */
export const FAKE_GITHUB_TOKEN = 'e2e-github-token-0000';

export interface Outside {
  google: FakeProviders;
  github: FakeGithub;
  /**
   * The variables for the server under test: the Google, Microsoft and Notion app ids and secrets, and the fake base of each (honoured outside production only), plus
   * the fake GitHub's address for the code that reads `MANYTHREADS_TEST_GITHUB_API` (a test server only).
   */
  env: Record<string, string>;
  stop(): Promise<void>;
}

/** Starts both. `account` is the address the fake Google signs the person in as (the default account holds files, mail, events and Notion pages to find). */
export async function startOutside(options: { account?: string } = {}): Promise<Outside> {
  const google = await startFakeProviders(options.account ? { accounts: [defaultAccount(options.account)] } : {});
  const github = await startFakeGithub({ token: FAKE_GITHUB_TOKEN, owner: 'kahf-demo', login: 'kahf-bot' });
  return {
    google,
    github,
    env: { ...google.env(), MANYTHREADS_TEST_GITHUB_API: github.url },
    stop: async () => {
      await google.stop();
      await github.stop();
    },
  };
}

export interface OutsideSaas {
  /** The whole stand-in process: every provider, the Telegram Bot API, the signed-webhook sender and the control port. */
  saas: FakeSaas;
  /** The fake Google, Microsoft and Notion (the same object as `saas.workspace`), for specs written against `startOutside`. */
  google: FakeProviders;
  github: FakeGithub;
  /**
   * The variables for the server under test: every provider's app id, secret and fake base, `MANYTHREADS_BRIDGE_TELEGRAM_FAKE_BASE`, the fake GitHub's address, and
   * `FAKE_SAAS_CONTROL` (where the control port is, for a probe that talks to it).
   */
  env: Record<string, string>;
  /** `http://127.0.0.1:<port>` of the control port. */
  control: string;
  stop(): Promise<void>;
}

/**
 * Starts tools/fake-saas (PLAN Bundle D, P16-12) and the fake GitHub. `account` is the address the fake Google signs the person in as; `saas` takes any option of
 * `startFakeSaas` (seeded sign-ins, accounts, the Telegram bots). `startOutside` stays as it was.
 */
export async function startOutsideSaas(options: { account?: string; saas?: StartFakeSaasOptions } = {}): Promise<OutsideSaas> {
  const saas = await startFakeSaas({ ...(options.account && !options.saas?.accounts ? { accounts: [defaultAccount(options.account)] } : {}), ...options.saas });
  const github = await startFakeGithub({ token: FAKE_GITHUB_TOKEN, owner: 'kahf-demo', login: 'kahf-bot' });
  return {
    saas,
    google: saas.workspace,
    github,
    env: { ...saas.env(), MANYTHREADS_TEST_GITHUB_API: github.url },
    control: saas.control.url,
    stop: async () => {
      await saas.stop();
      await github.stop();
    },
  };
}
