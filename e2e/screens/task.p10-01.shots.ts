import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P10-01 (Setup checklist and wizard) on the live site. Omar (workspace admin) opens Setup and reads the nine steps with the facts behind each
 * (what is done, what is optional, what is set aside), reads the sidebar card and its count, opens Settings, Workspace, LLM, Aliases and runs one
 * real test call on the smart alias (one small question: it shows the plain answer, or the cause in plain words), and checks the wizard shows the
 * same result. Priya (a plain member) has no card and the routes refuse her. The phone picture shows the stacked steps and the drawer-less card.
 * Nothing is created or changed: no team, no alias edit, and the checklist is NOT put away and no goal is sent (those change the live state).
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p10-01-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: phone ? PHONE : DESKTOP,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`${who}@kahf.example`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password`).not.toHaveURL(/\/sign-in/);
  await page.goto(`/t/${TEAM}/threads`);
  await expect(page.getByTestId('app-frame')).toBeVisible(T);
  return page;
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p10-01-${name}.png`), animations: 'disabled', fullPage });
}

const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

test('Omar and Priya: the setup steps and their facts, the sidebar card, a real model test, member refused, phone', async ({ browser }) => {
  const omar = await signIn(browser, 'omar');
  let priya: Page | null = null;
  let phone: Page | null = null;
  try {
    // ---- the state as the server holds it
    const stateRes = await omar.request.get('/api/workspace/onboarding');
    console.log('GET /api/workspace/onboarding:', stateRes.status(), (await stateRes.text()).slice(0, 400));
    expect(stateRes.status()).toBe(200);
    const testsRes = await omar.request.get('/api/workspace/llm/alias-tests');
    console.log('GET /api/workspace/llm/alias-tests:', testsRes.status(), (await testsRes.text()).slice(0, 600));
    expect(testsRes.status()).toBe(200);

    // ---- (a) the wizard: nine steps, each with a status that comes from a fact
    await omar.goto('/onboarding');
    await expect(omar.getByRole('heading', { name: 'Finish setting up', exact: true })).toBeVisible(T);
    const steps = omar.locator('[data-landmark="steps"] [data-step]');
    await expect(steps).toHaveCount(9, T);
    const rows = await steps.evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-step')}: done=${e.getAttribute('data-done')} status=${e.getAttribute('data-status')} next=${e.getAttribute('data-next')}`),
    );
    console.log('steps:\n  ' + rows.join('\n  '));
    console.log('count:', await omar.getByTestId('ob-count').innerText());
    await shot(omar, '01-wizard-top');
    await shot(omar, '02-wizard-full', true);

    // ---- (b) the sidebar card, when the checklist is not put away
    const card = omar.locator('[data-landmark="setup-checklist"]');
    const cardShown = (await card.count()) > 0;
    console.log('sidebar card shown:', cardShown);
    if (cardShown) {
      console.log('card:', (await card.innerText()).replace(/\s+/g, ' '), '| finished:', await card.getAttribute('data-finished'));
      await shot(omar, '03-card-in-wizard');
      await omar.goto(`/t/${TEAM}/threads`);
      await expect(omar.locator('[data-landmark="setup-checklist"]')).toBeVisible(T);
      await shot(omar, '04-card-in-threads');
    }

    // ---- (c) the Models step: one real test call, from the wizard
    await omar.goto('/onboarding');
    const models = omar.locator('[data-step="models"]');
    await expect(models).toBeVisible(T);
    const aliasRows = models.locator('[data-alias]');
    const aliasCount = await aliasRows.count();
    console.log('bound, testable aliases in the wizard:', aliasCount);
    if (aliasCount > 0) {
      const first = aliasRows.first();
      const alias = await first.getAttribute('data-alias');
      console.log('state before the test:', await first.locator('[data-test-state]').getAttribute('data-test-state'));
      await first.getByRole('button', { name: `Test the ${alias} alias`, exact: true }).click();
      await expect(first.locator('[data-test-state]')).not.toHaveAttribute('data-test-state', 'untested', { timeout: 60_000 });
      await expect(first.getByRole('button', { name: `Test the ${alias} alias`, exact: true })).toBeEnabled({ timeout: 60_000 });
      const result = first.locator('[data-test-state]');
      console.log(`test of ${alias}:`, await result.getAttribute('data-test-state'), '| cause:', await result.getAttribute('data-cause'), '|', (await first.innerText()).replace(/\s+/g, ' '));
      console.log('models step after the test: done =', await models.getAttribute('data-done'));
      await models.scrollIntoViewIfNeeded();
      await shot(omar, '05-models-tested');
    } else {
      console.log('no alias is connected on this site: the Models step shows its empty hint');
      console.log('empty hint:', await models.getByTestId('ob-models-empty').innerText());
      await shot(omar, '05-models-empty');
    }

    // ---- (d) the same result on Workspace > LLM > Aliases
    await omar.goto('/settings/workspace/llm');
    await expect(omar.getByRole('heading', { name: 'Aliases', exact: true })).toBeVisible(T);
    await omar.waitForTimeout(800);
    const testButtons = await omar.getByRole('button', { name: /^Test the .* alias$/ }).count();
    const statuses = await omar.locator('[data-test-state]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-test-state')}${e.getAttribute('data-cause') ? `/${e.getAttribute('data-cause')}` : ''}`));
    console.log('aliases screen: test buttons =', testButtons, '| statuses =', statuses.join(', '));
    await shot(omar, '06-aliases');

    // ---- (e) Priya: no card, routes refused, no Setup page
    priya = await signIn(browser, 'priya');
    console.log('Priya sees a card:', await priya.locator('[data-landmark="setup-checklist"]').count());
    expect(await priya.locator('[data-landmark="setup-checklist"]').count()).toBe(0);
    for (const [method, path] of [
      ['GET', '/api/workspace/onboarding'],
      ['GET', '/api/workspace/llm/alias-tests'],
    ] as const) {
      const res = await priya.request.fetch(path, { method });
      console.log(`${method} ${path} as Priya:`, res.status());
      expect(res.status()).toBeGreaterThanOrEqual(403);
    }
    await priya.goto('/onboarding');
    await expect(priya.getByRole('heading', { name: 'Page not found' })).toBeVisible(T);
    await shot(priya, '07-priya-not-found');
    await priya.context().close();
    priya = null;

    // ---- (f) phone
    phone = await signIn(browser, 'omar', true);
    await phone.goto('/onboarding');
    await expect(phone.locator('[data-landmark="steps"] [data-step]')).toHaveCount(9, T);
    const sideways = await noSideways(phone);
    console.log('phone: no sideways scroll =', sideways);
    await shot(phone, '08-phone-wizard-top');
    await phone.locator('[data-step="models"]').scrollIntoViewIfNeeded();
    await shot(phone, '09-phone-models');
    await phone.locator('[data-step="launch"]').scrollIntoViewIfNeeded();
    await shot(phone, '10-phone-launch');
    await phone.goto('/settings/workspace/llm');
    await phone.waitForTimeout(800);
    console.log('phone aliases: no sideways scroll =', await noSideways(phone));
    await shot(phone, '11-phone-aliases');
    expect(sideways).toBe(true);
    await phone.context().close();
    phone = null;
  } finally {
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
