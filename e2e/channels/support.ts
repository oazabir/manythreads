import { randomUUID } from 'node:crypto';
import { expect, request, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { WEB, authState, type PersonaKey } from '../support/env.ts';

/*
 * Helpers of the channel and thread specs. They run against the shared web origin (`WEB`, the seeded workspace and seven personas)
 * as signed-in personas (the storage state global-setup wrote through the real password sign-in). Every spec makes its own channel
 * with a random name, so specs on the same server do not disturb each other.
 */

export interface Api {
  ctx: APIRequestContext;
  /** The CSRF header the web client sends on writes. */
  headers(): Promise<Record<string, string>>;
  post(path: string, data?: unknown): Promise<unknown>;
  get(path: string): Promise<unknown>;
}

export async function apiAs(key: PersonaKey): Promise<Api> {
  const ctx = await request.newContext({ baseURL: WEB, storageState: authState(key) });
  const headers = async (): Promise<Record<string, string>> => {
    const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'manythreads_csrf' || c.name === '__Host-manythreads_csrf');
    return cookie ? { 'x-csrf-token': cookie.value } : {};
  };
  return {
    ctx,
    headers,
    async post(path, data) {
      const res = await ctx.post(path, { data, headers: await headers() });
      expect(res.status(), `POST ${path}: ${await res.text()}`).toBeLessThan(300);
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    },
    async get(path) {
      const res = await ctx.get(path);
      expect(res.status(), `GET ${path}`).toBe(200);
      return res.json();
    },
  };
}

export const uniqueName = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 6)}`;

/** A public channel of Engineering (Omar leads it). Returns its id and name. */
export async function createChannel(admin: Api, prefix: string, extra: Record<string, unknown> = {}): Promise<{ id: string; name: string }> {
  const name = uniqueName(prefix);
  const res = (await admin.post('/api/teams/engineering/channels', { name, ...extra })) as { channel: { id: string } };
  return { id: res.channel.id, name };
}

export async function postMessage(api: Api, channelId: string, body: string, threadRootId: string | null = null): Promise<{ id: string }> {
  return (await api.post(`/api/channels/${channelId}/messages`, { channelId, body, threadRootId })) as { id: string };
}

export async function bulkMessages(api: Api, channelId: string, count: number): Promise<void> {
  await api.post('/api/test/bulk-messages', { channelId, count });
}

/** A browser context signed in as a persona; `page` is open on `path`. */
export async function openAs(
  browser: Browser,
  key: PersonaKey,
  path: string,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
  mobile = false,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    baseURL: WEB,
    viewport,
    storageState: authState(key),
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto(path);
  return { page, context };
}

/**
 * Holds a finger on a message row for long enough to count as a hold (channels/gestures.ts: 500 ms), with real touch events (CDP). Under a finger there is no
 * hover bar (P34-05): a hold opens the reactions, with Reply in thread and More actions under them (or the actions, for a reader who cannot react).
 */
export async function holdOn(page: Page, row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  const b = (await row.boundingBox())!;
  const x = b.x + Math.min(120, b.width / 2);
  const y = b.y + b.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // the browser's own press-and-release events right after a hold are ignored for a moment (gestures.ts AFTER_GESTURE_MS)
  await page.waitForTimeout(400);
  await cdp.detach();
}

/** The messages inside a page or a region of it. */
export const messages = (scope: Page | Locator): Locator => scope.locator('[data-testid="message"]');
