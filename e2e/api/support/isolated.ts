import { test as base, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';

/**
 * Isolation for api specs that write data. The `api` project shares ONE server (api/support/start-server.ts) for specs that only
 * read or only try (and fail) to write; a spec FILE that creates channels, posts, follows, uploads, grants or configures providers
 * calls `useIsolatedStack()` and gets a stack of its own for the whole file: a fresh database with the seven personas, the header
 * actor and the test-kernel routes, a server on a free port, and everything dropped when the file ends (MISTAKES: parallel e2e specs
 * that mutate the shared server leak into one another).
 *
 *   import { expect, test, useIsolatedStack } from '../support/isolated.ts';
 *   const iso = useIsolatedStack();                 // personas only; pass { MANYTHREADS_STACK_SEED: 'content' } for seed v3
 *   test('...', async ({ request }) => { ... });    // `request` and `baseURL` point at the file's own server
 *   const stack = await iso.start();                // in a hook or a test: owner SQL (`stack.sql`), `stack.origin`, ...
 *
 * The stack starts when the file's first test (or `iso.start()`) needs it, and stops in the file's afterAll. `expect` is re-exported
 * so a spec imports one module. Call `useIsolatedStack` once, at the top level of the file.
 */
const running = new Map<string, Promise<Stack>>();

const DEFAULT_ENV: Record<string, string> = {
  MANYTHREADS_STACK_API_ONLY: '1',
  MANYTHREADS_STACK_DEV_AUTH: '1',
  MANYTHREADS_STACK_TEST_PLUGINS: '1',
  MANYTHREADS_STACK_SEED: 'personas',
};

function stackFor(file: string, env: Record<string, string>): Promise<Stack> {
  let stack = running.get(file);
  if (!stack) {
    stack = startStack({ ...DEFAULT_ENV, ...env });
    running.set(file, stack);
    // a failed start must not be cached: the next test retries
    stack.catch(() => running.delete(file));
  }
  return stack;
}

export const test = base.extend<{ stackEnv: Record<string, string>; isolatedStack: Stack }>({
  stackEnv: [{}, { option: true }],
  isolatedStack: [
    async ({ stackEnv }, use, testInfo) => {
      await use(await stackFor(testInfo.file, stackEnv));
    },
    { timeout: 240_000 },
  ],
  // The file's own origin instead of the project's shared one.
  baseURL: async ({ isolatedStack }, use) => {
    await use(isolatedStack.origin);
  },
});
export { expect } from '@playwright/test';

export interface IsolatedStack {
  /** The file's stack, started on first use (a hook or a test of the file). */
  start(): Promise<Stack>;
}

export function useIsolatedStack(env: Record<string, string> = {}): IsolatedStack {
  test.use({ stackEnv: env });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    const file = test.info().file;
    const stack = running.get(file);
    running.delete(file);
    await (await stack?.catch(() => undefined))?.stop();
  });
  return { start: () => stackFor(test.info().file, env) };
}

/** A request context signed in as a persona on a stack (POST /api/test/session). */
export async function signedIn(playwright: PlaywrightWorkerArgs['playwright'], stack: Stack, email: string): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: stack.origin });
  const res = await ctx.post('/api/test/session', { data: { email }, headers: { 'x-test-auth': stack.testAuthToken } });
  if (res.status() !== 200) throw new Error(`test sign-in as ${email}: ${res.status()}`);
  return ctx;
}
