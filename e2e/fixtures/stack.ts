import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { ownerSql } from '@manythreads/test-utils';
import { E2E_POOL_ENV } from '../support/pools.ts';

/**
 * A private web + API origin for one spec file (fixtures/stack-server.ts): the built web client and a real server on a
 * fresh, seeded database. The issuer is the in-process fake (packages/test-utils `startFakeOidc`) which redirects the
 * browser straight back, so a browser can follow the whole flow; tools/mock-oidc is the container for manual runs.
 */
export interface Stack {
  /** `http://127.0.0.1:<port>`: what the browser opens and the OIDC redirect URI is built from. */
  origin: string;
  ownerUrl: string;
  testAuthToken: string;
  /** The one-time first-admin token of an empty stack (`MANYTHREADS_STACK_SEED=none`), else null. */
  bootstrapToken: string | null;
  /** SQL as the database owner, to arrange or inspect state the API cannot reach. */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  stop(): Promise<void>;
}

const serverFile = fileURLToPath(new URL('./stack-server.ts', import.meta.url));
const e2eDir = fileURLToPath(new URL('..', import.meta.url));

/** How long a stack may take to print its ready line (migrations of every plugin + the seed, on a machine running four of them at once). */
const START_BUDGET_MS = 120_000;
/** The budget of a hook that starts a stack: the start itself and the arrangement a spec does after it (sign-ins, a few posts). */
const HOOK_BUDGET_MS = START_BUDGET_MS + 60_000;

/**
 * A `beforeAll` runs under the TEST timeout (30 s), not under the stack's own 120 s start budget: on a loaded machine (the full suite, four
 * workers each starting a stack) the start passed 30 s and the hook died with "beforeAll hook timeout of 30000ms exceeded" in whichever file
 * was unlucky, while the same file started in 10 s alone. The budget is raised here, once, for every spec that starts a stack; a hook or
 * fixture that already has more keeps it, and outside a hook or test (a script) there is nothing to raise.
 */
function allowForStart(): void {
  try {
    if (test.info().timeout !== 0 && test.info().timeout < HOOK_BUDGET_MS) test.setTimeout(HOOK_BUDGET_MS);
  } catch {
    // not running inside Playwright
  }
}

export async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  allowForStart();
  const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', serverFile], {
    cwd: e2eDir,
    env: { ...process.env, NODE_ENV: 'test', ...E2E_POOL_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A worker that dies (timeout, crash, Ctrl-C) must not leave its stack and database behind.
  const killOnExit = (): void => void child.kill('SIGTERM');
  process.once('exit', killOnExit);
  let output = '';
  const ready = await new Promise<{ origin: string; ownerUrl: string; testAuthToken: string; bootstrapToken: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stack did not start in time:\n${output.slice(-1500)}`)), START_BUDGET_MS);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (process.env['MANYTHREADS_E2E_LOG'] === '1') process.stderr.write(chunk);
      const line = /MANYTHREADS_STACK (\{.*\})/.exec(output);
      if (line?.[1]) {
        clearTimeout(timer);
        resolve(JSON.parse(line[1]) as { origin: string; ownerUrl: string; testAuthToken: string; bootstrapToken: string | null });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => {
      output += c.toString('utf8');
      if (process.env['MANYTHREADS_E2E_LOG'] === '1') process.stderr.write(c);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`stack exited with ${code} before it was ready:\n${output.slice(-1500)}`));
    });
  });
  return {
    origin: ready.origin,
    ownerUrl: ready.ownerUrl,
    testAuthToken: ready.testAuthToken,
    bootstrapToken: ready.bootstrapToken,
    sql: (text, params) => ownerSql(ready.ownerUrl, text, params),
    stop: () =>
      new Promise<void>((resolve) => {
        process.off('exit', killOnExit);
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
      }),
  };
}

/** A request context signed in as a persona through POST /api/test/session (docs/testing.md); `csrf` for writes. */
export async function signedInContext(
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  email: string,
): Promise<APIRequestContext> {
  const ctx = await playwright.request.newContext({ baseURL: stack.origin });
  const res = await ctx.post('/api/test/session', { data: { email }, headers: { 'x-test-auth': stack.testAuthToken } });
  expect(res.status(), `test sign-in as ${email}`).toBe(200);
  return ctx;
}

/** The CSRF header the web client sends on writes. */
export async function csrf(ctx: APIRequestContext): Promise<Record<string, string>> {
  const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_csrf' || c.name === '__Host-manythreads_csrf');
  return cookie ? { 'x-csrf-token': cookie.value } : {};
}

export interface ProviderJson {
  id: string;
  kind: string;
  enabled: boolean;
  disabledReason: string | null;
  hasSecret: boolean;
  label?: string;
}

/** Creates an OIDC provider through the admin API (POST /api/auth/oidc/providers). */
export async function createProvider(admin: APIRequestContext, body: Record<string, unknown>): Promise<ProviderJson> {
  const res = await admin.post('/api/auth/oidc/providers', { data: body, headers: await csrf(admin) });
  expect(res.status(), `create provider: ${await res.text()}`).toBe(200);
  return ((await res.json()) as { provider: ProviderJson }).provider;
}
