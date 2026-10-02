import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { personaEmail, type PersonaKey } from './env.ts';

/*
 * Helpers of the specs that start a stack of their own (fixtures/stack.ts): a persona's API calls and browser context against that
 * stack's origin. Sign-in is the test-only session route (docs/testing.md), the same cookies a password sign-in leaves.
 */

export interface StackApi {
  ctx: APIRequestContext;
  headers(): Promise<Record<string, string>>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, data?: unknown): Promise<T>;
  /** The status of a request, for refusals. */
  status(method: 'GET' | 'POST', path: string, data?: unknown): Promise<number>;
}

export async function apiOn(playwright: PlaywrightWorkerArgs['playwright'], stack: Stack, who: PersonaKey | string): Promise<StackApi> {
  const email = who.includes('@') ? who : personaEmail(who as PersonaKey);
  const ctx = await playwright.request.newContext({ baseURL: stack.origin });
  const signIn = await ctx.post('/api/test/session', { data: { email }, headers: { 'x-test-auth': stack.testAuthToken } });
  expect(signIn.status(), `test sign-in as ${email}`).toBe(200);
  const headers = async (): Promise<Record<string, string>> => {
    const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_csrf');
    return cookie ? { 'x-csrf-token': cookie.value } : {};
  };
  return {
    ctx,
    headers,
    async get<T>(path: string) {
      const res = await ctx.get(path);
      expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200);
      return (await res.json()) as T;
    },
    async post<T>(path: string, data?: unknown) {
      const res = await ctx.post(path, { data, headers: await headers() });
      expect(res.status(), `POST ${path}: ${await res.text()}`).toBeLessThan(300);
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },
    async status(method, path, data) {
      const res = method === 'GET' ? await ctx.get(path) : await ctx.post(path, { data, headers: await headers() });
      return res.status();
    },
  };
}

export const DESKTOP = { width: 1440, height: 900 } as const;
export const PHONE = { width: 390, height: 844 } as const;

/** A browser context of the persona on the stack, with a page open at `path`. */
export async function openOn(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  who: PersonaKey | string,
  path: string,
  opts: { viewport?: { width: number; height: number }; mobile?: boolean; init?: () => void } = {},
): Promise<{ page: Page; context: BrowserContext }> {
  const api = await apiOn(playwright, stack, who);
  const storageState = await api.ctx.storageState();
  await api.ctx.dispose();
  const context = await browser.newContext({
    baseURL: stack.origin,
    viewport: opts.viewport ?? DESKTOP,
    storageState,
    reducedMotion: 'reduce',
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  if (opts.init) await context.addInitScript(opts.init);
  const page = await context.newPage();
  await page.goto(path);
  return { page, context };
}

/** Channels of a team as the person's sidebar directory lists them, by name. */
export async function channelsOf(api: StackApi, team = 'engineering'): Promise<Record<string, string>> {
  const dir = await api.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>(`/api/teams/${team}/channels`);
  return Object.fromEntries(dir.groups.flatMap((g) => g.channels).map((c) => [c.name.replace(/^#/, ''), c.id]));
}

export const messagesIn = (page: Page) => page.locator('[data-testid="message"]');

export async function postAs(api: StackApi, channelId: string, body: string, threadRootId: string | null = null): Promise<{ id: string }> {
  return api.post<{ id: string }>(`/api/channels/${channelId}/messages`, { channelId, body, threadRootId });
}

export async function noSidewaysScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
}
