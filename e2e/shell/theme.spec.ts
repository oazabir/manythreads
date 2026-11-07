import { expect, test, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PERSONA_PASSWORD, personaEmail } from '../support/env.ts';
import { apiOn, DESKTOP, messagesIn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * P21-21, Account → Appearance: the theme (System, Light, Dark) and the message density (Comfortable, Compact). System follows the device; a choice
 * is saved with the person, drawn at once, and still there after a reload with no light frame, after sign-out and sign-in, and on a new device.
 * On a stack of its own: it changes people's saved look, which other specs on the shared server must not inherit.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

// tokens.css: --paper in dark is #0F1216, in light #EDEEF0
const DARK_PAPER = 'rgb(15, 18, 22)';
const LIGHT_PAPER = 'rgb(237, 238, 240)';

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

type Scheme = 'light' | 'dark';

/** A fresh browser (no saved copy of any look) as the persona, with the device set to `scheme`. */
async function openAs(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  who: 'omar' | 'nadia' | 'rafi',
  path: string,
  scheme: Scheme,
  init?: () => void,
): Promise<{ page: Page; context: BrowserContext }> {
  const api = await apiOn(playwright, stack, who);
  const storageState = await api.ctx.storageState();
  await api.ctx.dispose();
  const context = await browser.newContext({ baseURL: stack.origin, viewport: DESKTOP, storageState, reducedMotion: 'reduce', colorScheme: scheme });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(path);
  return { page, context };
}

const html = (page: Page, attr: 'data-theme' | 'data-theme-choice' | 'data-density') => page.locator('html').getAttribute(attr);
const bodyBackground = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const mine = (api: StackApi) => api.get<{ person: { appearance: { theme: string; density: string } } }>('/api/session').then((s) => s.person.appearance);

test('System follows the device: dark when the device is dark, light when it is light, and nothing is saved by looking', async ({ browser, playwright }) => {
  for (const [scheme, paper] of [['dark', DARK_PAPER], ['light', LIGHT_PAPER]] as const) {
    const { page, context } = await openAs(browser, playwright, 'omar', '/account/appearance', scheme);
    try {
      await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
      expect(await html(page, 'data-theme-choice')).toBe('system');
      expect(await html(page, 'data-theme')).toBe(scheme);
      expect(await html(page, 'data-density')).toBe('comfortable');
      await expect(page.getByTestId('appearance-theme-system').getByRole('radio')).toBeChecked();
      await expect.poll(() => bodyBackground(page)).toBe(paper);
    } finally {
      await context.close();
    }
  }
  expect(await mine(omar)).toEqual({ theme: 'system', density: 'comfortable' });
});

test('the Account menu lists Appearance, and picking Dark saves it, draws it at once and says Saved', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, playwright, 'nadia', '/account', 'light');
  try {
    await page.getByRole('link', { name: 'Appearance' }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    expect(await html(page, 'data-theme')).toBe('light');
    await page.getByTestId('appearance-theme-dark').click();
    await expect(page.getByTestId('appearance-saved')).toBeVisible();
    expect(await html(page, 'data-theme')).toBe('dark');
    expect(await html(page, 'data-theme-choice')).toBe('dark');
    await expect.poll(() => bodyBackground(page)).toBe(DARK_PAPER);
    await expect(page.getByTestId('appearance-theme-dark').getByRole('radio')).toBeChecked();
    expect(await mine(nadia)).toEqual({ theme: 'dark', density: 'comfortable' });
    // the setting is a radio group: arrow keys move through it, and the focus stays on the group
    await page.getByTestId('appearance-theme-dark').getByRole('radio').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('appearance-theme-light').getByRole('radio')).toBeChecked();
    await expect(page.getByTestId('appearance-theme-light').getByRole('radio')).toBeFocused();
    await expect.poll(() => mine(nadia)).toEqual({ theme: 'light', density: 'comfortable' });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('appearance-theme-dark').getByRole('radio')).toBeChecked();
    await expect.poll(() => mine(nadia)).toEqual({ theme: 'dark', density: 'comfortable' });
  } finally {
    await context.close();
  }
});

test('a Dark choice survives a reload without a light frame, even when the device is light', async ({ browser, playwright }) => {
  // records the theme and the page colour on each of the first 60 frames
  const record = (): void => {
    const frames: Array<{ theme: string | null; body: string | null; root: string }> = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const tick = (): void => {
      const body = document.body ? getComputedStyle(document.body).backgroundColor : null;
      frames.push({ theme: document.documentElement.getAttribute('data-theme'), body, root: getComputedStyle(document.documentElement).backgroundColor });
      if (frames.length < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const { page, context } = await openAs(browser, playwright, 'nadia', '/t/engineering/threads', 'light', record);
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames.length)).toBeGreaterThanOrEqual(30);
    const frames = await page.evaluate(() => (window as unknown as { __frames: Array<{ theme: string | null; body: string | null; root: string }> }).__frames);
    // nothing is drawn before the first frame, so the very first one already has the cached theme (the first load had nothing cached: the reload does)
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.map((f) => f.theme), JSON.stringify(frames.slice(0, 3))).toEqual(frames.map(() => 'dark'));
    expect(frames.filter((f) => f.body === LIGHT_PAPER)).toEqual([]);
    expect(await bodyBackground(page)).toBe(DARK_PAPER);
  } finally {
    await context.close();
  }
});

test('the look is kept across sign-out and sign-in, and on a new device', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, playwright, 'nadia', '/account/appearance', 'light');
  try {
    await expect(page.getByTestId('appearance-theme-dark').getByRole('radio')).toBeChecked();
    // sign out: the sign-in page keeps drawing the last look from this browser's copy
    const csrf = (await context.cookies()).find((c) => c.name === 'manythreads_csrf' || c.name === '__Host-manythreads_csrf');
    const out = await page.request.post('/api/auth/sign-out', { headers: csrf ? { 'x-csrf-token': csrf.value } : {} });
    expect(out.status()).toBe(200);
    await page.goto('/sign-in');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await html(page, 'data-theme')).toBe('dark');
    // sign in again: the server's value is still Dark
    await page.getByLabel('Email').fill(personaEmail('nadia'));
    await page.getByLabel('Password', { exact: true }).fill(PERSONA_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('app-frame')).toBeVisible();
    expect(await html(page, 'data-theme')).toBe('dark');
  } finally {
    await context.close();
  }
  // a new device: no saved copy, a light device, and the page still turns dark once the session says so
  const fresh = await openAs(browser, playwright, 'nadia', '/account/appearance', 'light');
  try {
    await expect(fresh.page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
    await expect.poll(() => html(fresh.page, 'data-theme')).toBe('dark');
    await expect.poll(() => bodyBackground(fresh.page)).toBe(DARK_PAPER);
  } finally {
    await fresh.context.close();
  }
});

test('Compact makes a run of messages shorter, and it is saved and kept after a reload', async ({ browser, playwright }) => {
  const made = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'density-run' });
  for (let i = 1; i <= 8; i++) await postAs(rafi, made.channel.id, `message ${String(i)} of the run`);
  const { page, context } = await openAs(browser, playwright, 'rafi', '/t/engineering/c/density-run', 'light');
  const runHeight = async (): Promise<number> => {
    await expect(messagesIn(page)).toHaveCount(8);
    return page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="message"]')];
      return rows[rows.length - 1]!.getBoundingClientRect().bottom - rows[0]!.getBoundingClientRect().top;
    });
  };
  try {
    expect(await html(page, 'data-density')).toBe('comfortable');
    const comfortable = await runHeight();
    await page.goto('/account/appearance');
    await page.getByTestId('appearance-density-compact').click();
    await expect(page.getByTestId('appearance-saved')).toBeVisible();
    expect(await html(page, 'data-density')).toBe('compact');
    expect(await mine(rafi)).toEqual({ theme: 'system', density: 'compact' });
    await page.goto('/t/engineering/c/density-run');
    const compact = await runHeight();
    expect(compact, `comfortable ${String(comfortable)} px, compact ${String(compact)} px`).toBeLessThan(comfortable * 0.9);
    await page.reload();
    expect(await html(page, 'data-density')).toBe('compact');
    expect(await runHeight()).toBe(compact);
  } finally {
    await context.close();
  }
});

test('a refused save puts the old look back and says so', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, playwright, 'omar', '/account/appearance', 'light');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
    await page.route('**/api/me/appearance', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'The server could not save that.' } }) }));
    await page.getByTestId('appearance-theme-dark').click();
    await expect(page.getByRole('alert')).toContainText(/could not save/i);
    expect(await html(page, 'data-theme-choice')).toBe('system');
    await expect(page.getByTestId('appearance-theme-system').getByRole('radio')).toBeChecked();
    expect(await mine(omar)).toEqual({ theme: 'system', density: 'comfortable' });
  } finally {
    await context.close();
  }
});
