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

const html = (page: Page, attr: 'data-theme' | 'data-theme-choice' | 'data-density' | 'data-palette') => page.locator('html').getAttribute(attr);
const bodyBackground = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const mine = (api: StackApi) => api.get<{ person: { appearance: { theme: string; density: string; palette: string } } }>('/api/session').then((s) => s.person.appearance);

test('System follows the device: dark when the device is dark, light when it is light, and nothing is saved by looking', async ({ browser, playwright }) => {
  for (const [scheme, paper] of [['dark', DARK_PAPER], ['light', LIGHT_PAPER]] as const) {
    const { page, context } = await openAs(browser, playwright, 'omar', '/account/appearance', scheme);
    try {
      await expect(page.getByRole('heading', { level: 1, name: 'Appearance' })).toBeVisible();
      expect(await html(page, 'data-theme-choice')).toBe('system');
      expect(await html(page, 'data-theme')).toBe(scheme);
      expect(await html(page, 'data-density')).toBe('comfortable');
      expect(await html(page, 'data-palette')).toBe('classic');
      await expect(page.getByTestId('appearance-theme-system').getByRole('radio')).toBeChecked();
      await expect.poll(() => bodyBackground(page)).toBe(paper);
    } finally {
      await context.close();
    }
  }
  expect(await mine(omar)).toEqual({ theme: 'system', density: 'comfortable', palette: 'classic' });
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
    expect(await mine(nadia)).toEqual({ theme: 'dark', density: 'comfortable', palette: 'classic' });
    // the setting is a radio group: arrow keys move through it, and the focus stays on the group
    await page.getByTestId('appearance-theme-dark').getByRole('radio').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('appearance-theme-light').getByRole('radio')).toBeChecked();
    await expect(page.getByTestId('appearance-theme-light').getByRole('radio')).toBeFocused();
    await expect.poll(() => mine(nadia)).toEqual({ theme: 'light', density: 'comfortable', palette: 'classic' });
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('appearance-theme-dark').getByRole('radio')).toBeChecked();
    await expect.poll(() => mine(nadia)).toEqual({ theme: 'dark', density: 'comfortable', palette: 'classic' });
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
    // the page keeps a copy for the next first paint once it has drawn the server's value
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('mt.appearance'))).toContain('"dark"');
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
    expect(await mine(rafi)).toEqual({ theme: 'system', density: 'compact', palette: 'classic' });
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
    expect(await mine(omar)).toEqual({ theme: 'system', density: 'comfortable', palette: 'classic' });
  } finally {
    await context.close();
  }
});

// ---- P28-07: the three themes (Graphite, Linen, Harbor) beside the original look ----

/** Records, on each of the first 60 frames, the palette, the mode and the page colour, so a flash of the wrong look shows. */
const recordLook = (): void => {
  const frames: Array<{ palette: string | null; theme: string | null; body: string | null }> = [];
  (window as unknown as { __look: typeof frames }).__look = frames;
  const tick = (): void => {
    frames.push({
      palette: document.documentElement.getAttribute('data-palette'),
      theme: document.documentElement.getAttribute('data-theme'),
      body: document.body ? getComputedStyle(document.body).backgroundColor : null,
    });
    if (frames.length < 60) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

test('the theme picker shows four looks with a live sample of each in light and dark, and Classic is chosen to begin with', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, playwright, 'rafi', '/account/appearance', 'light');
  try {
    await expect(page.getByTestId('appearance-picker')).toBeVisible();
    for (const id of ['classic', 'graphite', 'linen', 'harbor']) {
      await expect(page.getByTestId(`appearance-palette-${id}`)).toBeVisible();
      for (const mode of ['light', 'dark']) await expect(page.getByTestId(`appearance-palette-${id}`).getByTestId(`theme-sample-${id}-${mode}`)).toBeVisible();
    }
    await expect(page.getByTestId('appearance-palette-classic').getByRole('radio')).toBeChecked();
    // a sample is drawn by its own palette, not the page's: the dark Linen sample is a different colour from the dark Harbor one
    const colourOf = (id: string, mode: string) => page.getByTestId(`theme-sample-${id}-${mode}`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const seen = new Set([await colourOf('linen', 'dark'), await colourOf('harbor', 'dark'), await colourOf('graphite', 'dark'), await colourOf('linen', 'light'), await colourOf('harbor', 'light')]);
    expect(seen.size).toBe(5);
  } finally {
    await context.close();
  }
});

test('picking Linen in Settings saves it, draws it at once, and a reload draws Linen from the first frame', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, playwright, 'omar', '/account/appearance', 'light', recordLook);
  try {
    await expect(page.getByTestId('appearance-picker')).toBeVisible();
    const classicPaper = await bodyBackground(page);
    await page.getByTestId('appearance-palette-linen').click();
    await expect(page.getByTestId('appearance-saved')).toBeVisible();
    expect(await html(page, 'data-palette')).toBe('linen');
    expect(await html(page, 'data-theme')).toBe('light');
    const linenPaper = await bodyBackground(page);
    expect(linenPaper).not.toBe(classicPaper);
    await expect(page.getByTestId('appearance-palette-linen').getByRole('radio')).toBeChecked();
    expect(await mine(omar)).toEqual({ theme: 'system', density: 'comfortable', palette: 'linen' });
    await page.reload();
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __look: unknown[] }).__look.length)).toBeGreaterThanOrEqual(30);
    const frames = await page.evaluate(() => (window as unknown as { __look: Array<{ palette: string | null; theme: string | null; body: string | null }> }).__look);
    expect(frames.map((f) => f.palette), JSON.stringify(frames.slice(0, 3))).toEqual(frames.map(() => 'linen'));
    expect(frames.filter((f) => f.body === classicPaper)).toEqual([]);
    expect(await bodyBackground(page)).toBe(linenPaper);
    // from the first frame, the page asks the browser for the text face of this palette only
    const preloads = await page.evaluate(() => [...document.querySelectorAll('link[rel="preload"][as="font"]')].map((l) => l.getAttribute('href')));
    expect(preloads.filter((h) => h?.includes('ibm-plex-sans')).length, JSON.stringify(preloads)).toBe(1);
    expect(preloads.some((h) => h?.includes('geist') || h?.includes('inter'))).toBe(false);
  } finally {
    await context.close();
  }
});

test('Harbor in Dark is kept on a new device, and the shell colour of the browser follows it', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, playwright, 'rafi', '/account/appearance', 'light');
  try {
    await page.getByTestId('appearance-palette-harbor').click();
    await expect(page.getByTestId('appearance-saved')).toBeVisible();
    await page.getByTestId('appearance-theme-dark').click();
    await expect.poll(() => mine(rafi)).toEqual({ theme: 'dark', density: 'compact', palette: 'harbor' });
    const theme = page.locator('meta[name="theme-color"]');
    const shell = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--shell').trim());
    expect(shell).not.toBe('');
    await expect.poll(async () => (await theme.getAttribute('content'))?.toLowerCase()).toBe(shell.toLowerCase());
  } finally {
    await context.close();
  }
  const fresh = await openAs(browser, playwright, 'rafi', '/account/appearance', 'light');
  try {
    await expect.poll(() => html(fresh.page, 'data-palette')).toBe('harbor');
    await expect.poll(() => html(fresh.page, 'data-theme')).toBe('dark');
    await expect(fresh.page.getByTestId('appearance-palette-harbor').getByRole('radio')).toBeChecked();
  } finally {
    await fresh.context.close();
  }
});
