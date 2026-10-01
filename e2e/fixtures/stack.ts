import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, type APIRequestContext, type PlaywrightWorkerArgs } from '@playwright/test';
import { ownerSql } from '@manythreads/test-utils';

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

export async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', serverFile], {
    cwd: e2eDir,
    env: { ...process.env, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const ready = await new Promise<{ origin: string; ownerUrl: string; testAuthToken: string; bootstrapToken: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stack did not start in time:\n${output.slice(-1500)}`)), 120_000);
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
  const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_csrf');
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
