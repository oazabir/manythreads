import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

/**
 * Pictures of the live site for the phase record. Personas sign in exactly like people do: the sign-in page's email and
 * password form. The password is a random one-off the screenshots workflow set through the server's admin CLI
 * (docs/deploy.md); it comes from the environment, is only ever typed into that form and is never printed.
 * Output: <MANYTHREADS_SHOTS_DIR>/{desktop,mobile}/<name>.png (default e2e/screens/out).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? join(import.meta.dirname, 'out');

const EMAIL = { omar: 'omar@kahf.example', nadia: 'nadia@kahf.example', lena: 'lena@kahf.example' } as const;
type Persona = keyof typeof EMAIL;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

test.beforeAll(() => {
  if (PASSWORD.length < 12) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the one-off password of the screenshot personas)');
});

// One real sign-in per persona and worker; later screens start from the cookies it produced.
const signedIn = new Map<Persona, Promise<NonNullable<BrowserContextOptions['storageState']>>>();

async function signInThroughTheForm(browser: Browser, persona: Persona): Promise<NonNullable<BrowserContextOptions['storageState']>> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(EMAIL[persona]);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // the form leaves /sign-in once the session exists; a refusal would show an alert instead
    await expect(page, `password sign-in as ${persona} (was the one-off password set?)`).not.toHaveURL(/\/sign-in/);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/** A browser context signed in as the persona (or anonymous when `persona` is null). */
async function open(browser: Browser, persona: Persona | null, viewport: { width: number; height: number }, mobile: boolean): Promise<Page> {
  let storageState: BrowserContextOptions['storageState'];
  if (persona) {
    let state = signedIn.get(persona);
    if (!state) signedIn.set(persona, (state = signInThroughTheForm(browser, persona)));
    storageState = await state;
  }
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: 'reduce',
    ...(storageState ? { storageState } : {}),
  });
  return context.newPage();
}

async function shoot(page: Page, kind: 'desktop' | 'mobile', name: string, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const dir = join(OUT, kind);
  mkdirSync(dir, { recursive: true });
  // Dynamic regions (times, ids) carry data-vt-mask: painted over so a re-run differs only when the screen does.
  await page.screenshot({ path: join(dir, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
  await page.context().close();
}

const SCREENS: { name: string; persona: Persona | null; path: string }[] = [
  { name: 'sign-in', persona: null, path: '/sign-in' },
  { name: 'teams', persona: 'omar', path: '/teams' },
  { name: 'roster', persona: 'omar', path: '/settings/team/engineering/roster' },
  { name: 'members', persona: 'omar', path: '/settings/workspace/members' },
  { name: 'account', persona: 'nadia', path: '/account' },
  { name: 'settings-sign-in', persona: 'omar', path: '/settings/workspace/sign-in' },
  { name: 'teams-guest', persona: 'lena', path: '/teams' },
];

for (const s of SCREENS) {
  test(`desktop ${s.name}`, async ({ browser }) => {
    await shoot(await open(browser, s.persona, DESKTOP, false), 'desktop', s.name, s.path);
  });
}

for (const s of SCREENS.filter((x) => x.name === 'sign-in' || x.name === 'members')) {
  test(`mobile ${s.name}`, async ({ browser }) => {
    await shoot(await open(browser, s.persona, MOBILE, true), 'mobile', s.name, s.path);
  });
}
