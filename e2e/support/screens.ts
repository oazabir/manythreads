// Screenshots of the identity and teams screens from the REAL server (not the mock), for docs/retro/screens/phase-2/.
// Start the servers first (the same ones playwright.config.ts starts):
//   MANYTHREADS_TEST_PLUGINS=1 NODE_ENV=test MANYTHREADS_API_PORT=3100 MANYTHREADS_TEST_AUTH_TOKEN=x pnpm -C e2e exec tsx api/support/start-server.ts
//   MANYTHREADS_API_PORT=3101 NODE_ENV=test pnpm -C e2e exec tsx support/start-empty-server.ts
//   MANYTHREADS_API_ORIGIN=http://127.0.0.1:3100 pnpm --filter @manythreads/web preview --port 4173 --strictPort
//   MANYTHREADS_API_ORIGIN=http://127.0.0.1:3101 pnpm --filter @manythreads/web preview --port 4174 --strictPort
// then: pnpm -C e2e exec tsx support/screens.ts <out dir>
import { readFileSync } from 'node:fs';
import { chromium, request, type Browser, type BrowserContext } from '@playwright/test';
import { BOOTSTRAP_TOKEN_FILE, PERSONA_PASSWORD, WEB, WEB_EMPTY, personaEmail, type PersonaKey } from './env.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: screens.ts <out dir>');
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function signedIn(browser: Browser, key: PersonaKey, viewport: typeof DESKTOP): Promise<BrowserContext> {
  const api = await request.newContext({ baseURL: WEB });
  const res = await api.post('/api/auth/password/sign-in', { data: { email: personaEmail(key), password: PERSONA_PASSWORD } });
  if (!res.ok()) throw new Error(`sign-in as ${key}: ${res.status()}`);
  const storageState = await api.storageState();
  await api.dispose();
  return browser.newContext({ baseURL: WEB, viewport, storageState, ...(viewport === MOBILE ? { isMobile: true, hasTouch: true } : {}) });
}

const browser = await chromium.launch();
const shot = async (ctx: BrowserContext, path: string, name: string, prepare?: (page: import('@playwright/test').Page) => Promise<void>): Promise<void> => {
  const page = await ctx.newPage();
  await page.goto(path);
  await page.locator('[data-testid="app-frame"]').waitFor();
  await prepare?.(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts?.ready);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true, animations: 'disabled' });
  await page.close();
};

// sign-in and bootstrap (anonymous)
for (const [vp, suffix] of [[DESKTOP, 'desktop'], [MOBILE, 'mobile']] as const) {
  const ctx = await browser.newContext({ baseURL: WEB, viewport: vp });
  await shot(ctx, '/sign-in', `signin-${suffix}`, async (page) => {
    await page.getByLabel('Email').fill(personaEmail('nadia'));
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').waitFor();
  });
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const token = readFileSync(BOOTSTRAP_TOKEN_FILE, 'utf8').trim();
  await shot(ctx, `${WEB_EMPTY}/bootstrap/${token}`, 'bootstrap-desktop', async (page) => {
    await page.getByLabel('Workspace').fill('Kahf Software');
    await page.getByLabel('Name', { exact: true }).fill('Omar Al Zabir');
    await page.getByLabel('Email').fill('omar@kahf.example');
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  });
  await ctx.close();
}

// Omar: teams create, roster of a team made from the template, members, account, sign-in methods
const omar = await signedIn(browser, 'omar', DESKTOP);
const csrf = (await omar.cookies()).find((c) => c.name === 'manythreads_csrf')?.value ?? '';
const made = await omar.request.post('/api/teams/from-template', { data: { templateId: 'engineering', name: 'Platform', slug: 'platform' }, headers: { 'x-csrf-token': csrf } });
if (!made.ok()) throw new Error(`from-template: ${made.status()}`);
await shot(omar, '/teams', 'teams-create-desktop', async (page) => {
  await page.getByRole('checkbox', { name: 'Create a Engineering team' }).click();
  await page.getByLabel('Engineering team name').fill('Platform 2');
  await page.getByLabel('Engineering invite emails').fill('nadia@kahf.example, rafi@kahf.example');
});
await shot(omar, '/settings/team/platform/roster', 'roster-desktop', async (page) => {
  await page.getByRole('heading', { name: 'Platform' }).waitFor();
  await page.locator('[data-landmark="template-definition"]').waitFor();
});
await shot(omar, '/settings/workspace/members', 'members-desktop', async (page) => void (await page.getByRole('table').waitFor()));
await shot(omar, '/settings/workspace/sign-in', 'settings-signin-desktop', async (page) => void (await page.getByText('Username and password').first().waitFor()));
await shot(omar, '/account', 'account-desktop', async (page) => void (await page.getByRole('button', { name: 'Sign out everywhere' }).waitFor()));
await omar.close();
const omarMobile = await signedIn(browser, 'omar', MOBILE);
await shot(omarMobile, '/settings/workspace/members', 'members-mobile', async (page) => void (await page.getByRole('table').waitFor()));
await omarMobile.close();
await browser.close();
