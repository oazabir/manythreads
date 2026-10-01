import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, request, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

/**
 * Pictures of the live site for the phase record. Personas get a real session from POST /api/test/session with the
 * `x-test-auth` token (docs/testing.md); the token comes from the environment, is only ever sent as that header and is
 * never printed. Output: <MANYTHREADS_SHOTS_DIR>/{desktop,mobile}/<name>.png (default e2e/screens/out).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const TOKEN = process.env['MANYTHREADS_TEST_AUTH_TOKEN'] ?? '';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? join(import.meta.dirname, 'out');

const EMAIL = { omar: 'omar@kahf.example', nadia: 'nadia@kahf.example', lena: 'lena@kahf.example' } as const;
type Persona = keyof typeof EMAIL;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

test.beforeAll(() => {
  if (TOKEN.length < 16) throw new Error('MANYTHREADS_TEST_AUTH_TOKEN is not set (the live test sign-in token)');
});

/** A browser context signed in as the persona (or anonymous when `persona` is null). */
async function open(browser: Browser, persona: Persona | null, viewport: { width: number; height: number }, mobile: boolean): Promise<Page> {
  let storageState: BrowserContextOptions['storageState'];
  if (persona) {
    const ctx = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
    const res = await ctx.post('/api/test/session', { data: { email: EMAIL[persona] }, headers: { 'x-test-auth': TOKEN } });
    expect(res.status(), `test sign-in as ${persona} (is testAuth enabled on the site?)`).toBe(200);
    storageState = await ctx.storageState();
    await ctx.dispose();
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
