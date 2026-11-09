// Signing a persona in and giving a journey its windows (PLAN P12-01).
import type { Browser, BrowserContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import { Pages } from '../../pages/index.ts';
import { DESKTOP, PHONE, apiOn, type StackApi } from '../../support/stack-browser.ts';
import { personaEmail } from '../../support/env.ts';
import { VIEWPORTS, type JourneyContext, type Persona } from './journey.ts';

/** Teams a persona opens first. Priya has two; everybody else lives in Engineering. */
export const HOME_TEAM: Record<Persona, string> = {
  omar: 'engineering',
  nadia: 'engineering',
  rafi: 'engineering',
  sameera: 'engineering',
  tariq: 'engineering',
  priya: 'engineering',
  lena: 'engineering',
};

export interface Windows {
  context: BrowserContext;
  page: Page;
}

/** The time one action (a click, a fill) may wait for its element. Playwright's own default is no limit: a step that waits for a missing control would run until the test times out. */
export const ACTION_TIMEOUT_MS = 20_000;

async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(30_000);
  return context;
}

function contextOptions(kind: 'desktop' | 'mobile') {
  const size = kind === 'mobile' ? PHONE : DESKTOP;
  return { viewport: { width: size.width, height: size.height }, reducedMotion: 'reduce' as const, ...(kind === 'mobile' ? { isMobile: true, hasTouch: true } : {}) };
}

/**
 * A window with `persona` signed in through the test session route (the same cookies a password sign-in leaves) on the viewport of `kind`. The page is opened at
 * `path`. A journey that must show the real sign-in form uses `ctx.anonymous('/sign-in')` and the SignInPage object instead.
 */
export async function loginAs(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  persona: Persona,
  kind: 'desktop' | 'mobile',
  path = '/',
): Promise<Windows & { api: StackApi }> {
  const api = await apiOn(playwright, stack, persona);
  const storageState = await api.ctx.storageState();
  const context = await newContext(browser, { baseURL: stack.origin, storageState, ...contextOptions(kind) });
  const page = await context.newPage();
  await page.goto(path);
  return { context, page, api };
}

/** A window nobody is signed in on. */
export async function anonymousWindow(browser: Browser, stack: Stack, kind: 'desktop' | 'mobile', path = '/'): Promise<Windows> {
  const context = await newContext(browser, { baseURL: stack.origin, ...contextOptions(kind) });
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

export interface JourneySession {
  ctx: JourneyContext;
  /** Close every window and API context the journey opened. */
  close(): Promise<void>;
}

/**
 * Builds the `JourneyContext` of one persona on one viewport: the persona's own window is `ctx.page`; `also()` opens colleagues in more windows (same viewport),
 * `anonymous()` a window with nobody signed in. `start: 'empty'` has nobody to sign in as, so `ctx.page` is an anonymous window.
 */
export async function openJourney(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  persona: Persona,
  kind: 'desktop' | 'mobile',
  options: { empty?: boolean; path?: string } = {},
): Promise<JourneySession> {
  const contexts: BrowserContext[] = [];
  const apis = new Map<string, StackApi>();
  const apiFor = async (who: Persona): Promise<StackApi> => {
    const known = apis.get(who);
    if (known) return known;
    const api = await apiOn(playwright, stack, who);
    apis.set(who, api);
    return api;
  };
  let own: Windows;
  if (options.empty) own = await anonymousWindow(browser, stack, kind, options.path ?? '/');
  else {
    const signedIn = await loginAs(browser, playwright, stack, persona, kind, options.path ?? '/');
    apis.set(persona, signedIn.api);
    own = signedIn;
  }
  contexts.push(own.context);
  const ctx: JourneyContext = {
    persona,
    viewport: kind,
    stack,
    page: own.page,
    get pages() {
      return new Pages(ctx.page, HOME_TEAM[persona]);
    },
    async also(who, path = '/') {
      const w = await loginAs(browser, playwright, stack, who, kind, path);
      contexts.push(w.context);
      apis.set(`${who}#window`, w.api);
      return { page: w.page, pages: new Pages(w.page, HOME_TEAM[who]) };
    },
    api: apiFor,
    async anonymous(path = '/') {
      const w = await anonymousWindow(browser, stack, kind, path);
      contexts.push(w.context);
      return { page: w.page, pages: new Pages(w.page, HOME_TEAM[persona]) };
    },
  };
  return {
    ctx,
    async close() {
      for (const c of contexts) await c.close().catch(() => undefined);
      for (const a of apis.values()) await a.ctx.dispose().catch(() => undefined);
    },
  };
}

export { VIEWPORTS, personaEmail };
