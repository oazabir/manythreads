import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn, PHONE, type StackApi } from '../support/stack-browser.ts';

/**
 * P30-02, the Appearance entry of the gear menu at the bottom left of the sidebar: a submenu with the four palettes and System, Light and Dark. A click
 * draws the look on the whole page at once, saves it with the person, and leaves the menu open; a reload keeps it. On a 390 px screen the submenu takes
 * the menu's place under a Back row, in the sidebar drawer and in the "You" sheet of the bottom bar. Pictures of the open submenu (Graphite dark and Linen
 * light, wide and 390 px) go to temp/screenshots/p30 (git-ignored; `MANYTHREADS_P30_SHOTS` moves them).
 * On a stack of its own: it changes a person's saved look.
 *
 *   flock /tmp/manythreads-test.lock pnpm -C e2e exec playwright test -c <a config with testMatch 'shell/appearance-menu.spec.ts'> --workers=1 --retries=0
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'both layouts are opened inside the tests');
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env['MANYTHREADS_P30_SHOTS'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p30');

let stack: Stack;
let nadia: StackApi;

test.beforeAll(async ({ playwright }) => {
  mkdirSync(SHOTS, { recursive: true });
  stack = await startStack();
  nadia = await apiOn(playwright, stack, 'nadia');
});
test.afterAll(async () => {
  await nadia?.ctx.dispose();
  await stack?.stop();
});

const attr = (page: Page, name: 'data-palette' | 'data-theme' | 'data-theme-choice'): Promise<string | null> => page.locator('html').getAttribute(name);
const mine = () => nadia.get<{ person: { appearance: { theme: string; density: string; palette: string } } }>('/api/session').then((s) => s.person.appearance);

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('menu-appearance').click();
  await expect(page.getByTestId('appearance-menu')).toBeVisible();
}

test('a click in the gear menu draws the palette and the mode at once, saves them, keeps the menu open, and a reload keeps them', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    expect(await attr(page, 'data-palette')).toBe('classic');
    await openAppearance(page);
    const sub = page.getByRole('menu', { name: 'Appearance' });
    await expect(sub.getByRole('menuitemradio')).toHaveText(['Graphite', 'Linen', 'Harbor', 'Classic', 'System', 'Light', 'Dark']);
    await expect(sub.getByRole('menuitemradio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');

    await sub.getByRole('menuitemradio', { name: 'Linen' }).click();
    expect(await attr(page, 'data-palette')).toBe('linen');
    await expect(sub.getByRole('menuitemradio', { name: 'Linen' })).toHaveAttribute('aria-checked', 'true');
    await expect(sub).toBeVisible(); // the menu stays open: a person can try the next one
    await sub.getByRole('menuitemradio', { name: 'Dark' }).click();
    expect(await attr(page, 'data-theme')).toBe('dark');
    expect(await attr(page, 'data-theme-choice')).toBe('dark');
    await expect.poll(mine).toEqual({ theme: 'dark', density: 'comfortable', palette: 'linen' });
    await expect(sub).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('app-frame')).toBeVisible();
    expect(await attr(page, 'data-palette')).toBe('linen');
    expect(await attr(page, 'data-theme')).toBe('dark');
    await openAppearance(page);
    await expect(page.getByRole('menuitemradio', { name: 'Linen' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  } finally {
    await context.close();
  }
});

test('looking at a palette shows it and leaving puts the saved one back; the keys, Esc and the focus follow the menu pattern', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    const gear = page.getByRole('button', { name: 'Account menu' });
    await openAppearance(page);
    await page.getByRole('menuitemradio', { name: 'Harbor' }).hover();
    await expect.poll(() => attr(page, 'data-palette')).toBe('harbor');
    await page.getByRole('menuitem', { name: 'More appearance settings…' }).hover();
    await page.getByTestId('menu-appearance').hover();
    await expect.poll(() => attr(page, 'data-palette')).toBe('linen');
    expect((await mine()).palette).toBe('linen'); // only a click saves

    // the keyboard: Esc closes the submenu first, then the menu, and focus ends on the gear
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('appearance-menu')).toBeHidden();
    await expect(page.getByTestId('menu-appearance')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitemradio', { name: 'Linen' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: 'Harbor' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await attr(page, 'data-palette')).toBe('harbor');
    await expect.poll(async () => (await mine()).palette).toBe('harbor');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('appearance-menu')).toBeHidden();
    await expect(page.getByTestId('menu-appearance')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('menu-appearance')).toBeHidden();
    await expect(gear).toBeFocused();
    await expect(gear).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await context.close();
  }
});

test('"More appearance settings…" opens Settings → Appearance with the same choice checked', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  try {
    await openAppearance(page);
    await page.getByRole('menuitem', { name: 'More appearance settings…' }).click();
    await expect(page).toHaveURL(/\/account\/appearance$/);
    await expect(page.getByTestId('appearance-palette-harbor').getByRole('radio')).toBeChecked();
    await expect(page.getByTestId('appearance-menu')).toBeHidden();
  } finally {
    await context.close();
  }
});

test('on 390 px the submenu takes the place of the menu under a Back row, in the drawer and in the You sheet', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general', { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    // the bottom bar's You sheet
    await page.getByTestId('bar-you').click();
    await page.getByTestId('menu-appearance').click();
    await expect(page.getByTestId('appearance-back')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeHidden();
    await page.getByRole('menuitemradio', { name: 'Graphite' }).click();
    expect(await attr(page, 'data-palette')).toBe('graphite');
    await expect.poll(async () => (await mine()).palette).toBe('graphite');
    await expect(page.getByTestId('appearance-menu')).toBeVisible();
    await page.getByTestId('appearance-back').click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByTestId('menu-appearance')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-sheet')).toBeHidden();

    // the sidebar drawer's gear
    await page.getByRole('button', { name: 'Open menu' }).click();
    await openAppearance(page);
    await expect(page.getByTestId('appearance-back')).toBeVisible();
    await page.getByRole('menuitemradio', { name: 'Linen' }).click();
    expect(await attr(page, 'data-palette')).toBe('linen');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

/** Sets the look through the submenu, as a person would, and leaves it open for the picture. */
async function shoot(page: Page, palette: 'Graphite' | 'Linen', mode: 'Light' | 'Dark', file: string): Promise<void> {
  await openAppearance(page);
  await page.getByRole('menuitemradio', { name: palette }).click();
  await page.getByRole('menuitemradio', { name: mode }).click();
  await expect.poll(() => attr(page, 'data-theme')).toBe(mode.toLowerCase());
  await expect(page.getByRole('menuitemradio', { name: palette })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: palette }).focus();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, file) });
}

test('pictures of the open submenu: Graphite dark and Linen light, wide and 390 px', async ({ browser, playwright }) => {
  for (const [palette, mode, tag] of [['Graphite', 'Dark', 'graphite-dark'], ['Linen', 'Light', 'linen-light']] as const) {
    const wide = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
    try {
      await expect(wide.page.getByTestId('app-frame')).toBeVisible();
      await shoot(wide.page, palette, mode, `${tag}-1440.png`);
    } finally {
      await wide.context.close();
    }
    const phone = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general', { viewport: PHONE, mobile: true });
    try {
      await expect(phone.page.getByTestId('app-frame')).toBeVisible();
      await phone.page.getByRole('button', { name: 'Open menu' }).click();
      await shoot(phone.page, palette, mode, `${tag}-390-drawer.png`);
    } finally {
      await phone.context.close();
    }
    const sheet = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general', { viewport: PHONE, mobile: true });
    try {
      await expect(sheet.page.getByTestId('app-frame')).toBeVisible();
      await sheet.page.getByTestId('bar-you').click();
      await sheet.page.getByTestId('menu-appearance').click();
      await sheet.page.getByRole('menuitemradio', { name: palette }).click();
      await sheet.page.getByRole('menuitemradio', { name: mode }).click();
      await expect.poll(() => attr(sheet.page, 'data-theme')).toBe(mode.toLowerCase());
      await sheet.page.waitForTimeout(400);
      await sheet.page.screenshot({ path: join(SHOTS, `${tag}-390-sheet.png`) });
    } finally {
      await sheet.context.close();
    }
  }
});
