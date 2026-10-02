// Screenshots of the app shell from the REAL server stack (a fresh seeded database), for docs/retro/screens/phase-3/.
// The web client must be built first (pnpm --filter @manythreads/web build). Then:
//   pnpm -C e2e exec tsx support/shell-screens.ts <out dir>
// The channel groups come from the channels plugin; until it is loaded the real stack shows an empty slot, so the
// `-mock` shots use the client's own mock transport (?mock=1) to show how groups, counts and the panel look.
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from '@playwright/test';
import { startStack } from '../fixtures/stack.ts';
import { DESKTOP, MOBILE, openPage } from '../visual/support/vt.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: shell-screens.ts <out dir>');
mkdirSync(out, { recursive: true });

const stack = await startStack();
const browser: Browser = await chromium.launch();
const settle = async (page: Page): Promise<void> => {
  await page.locator('[data-testid="app-frame"]').waitFor();
  await page.locator('[aria-busy="true"]').first().waitFor({ state: 'detached' });
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts?.ready);
};
const shoot = async (page: Page, name: string): Promise<void> => {
  await settle(page);
  await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
};

try {
  for (const key of ['nadia', 'priya', 'lena'] as const) {
    const { page, close } = await openPage(browser, stack, key, DESKTOP);
    await page.goto('/');
    await shoot(page, `shell-${key}-1440`);
    await close();
  }
  {
    const { page, close } = await openPage(browser, stack, 'nadia', MOBILE, true);
    await page.goto('/');
    await settle(page);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('.frame[data-drawer="open"]').waitFor();
    await page.waitForTimeout(300);
    await shoot(page, 'shell-nadia-390-drawer');
    await close();
  }
  // mock transport: channel groups, a count, and the right panel with a back stack
  {
    const { page, close } = await openPage(browser, stack, null, DESKTOP);
    await page.goto('/t/engineering/c/dev?mock=1&as=nadia&panel=member:00000000-0000-7000-8000-0000000c0003');
    await shoot(page, 'shell-nadia-1440-mock-panel');
    await close();
  }
  {
    const { page, close } = await openPage(browser, stack, null, DESKTOP);
    await page.goto('/t/engineering/c/releases?mock=1&as=lena');
    await shoot(page, 'shell-lena-1440-mock');
    await close();
  }
  {
    const { page, close } = await openPage(browser, stack, null, MOBILE, true);
    await page.goto('/t/engineering/c/dev?mock=1&as=nadia&panel=member:00000000-0000-7000-8000-0000000c0003');
    await shoot(page, 'shell-nadia-390-mock-sheet');
    await close();
  }
} finally {
  await browser.close();
  await stack.stop();
}
