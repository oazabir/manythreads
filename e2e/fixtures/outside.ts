import { defaultAccount, startFakeGithub, startFakeProviders, type FakeGithub, type FakeProviders } from '@manythreads/test-utils';

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
