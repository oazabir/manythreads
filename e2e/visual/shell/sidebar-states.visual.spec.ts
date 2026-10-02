import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { DESKTOP, expectWireframe, openPage } from '../support/vt.ts';
import type { PersonaKey } from '../../support/env.ts';

/*
 * The app shell as each kind of person sees it (PLAN phase 3 section 5, own baselines, class W): Nadia (member of one team),
 * Priya (two teams, the switcher), Lena (guest: no Files, Boards, Approvals or Bots). 1440x900: sidebar-nadia.png,
 * sidebar-priya.png, sidebar-lena.png. Channel groups appear once the channels plugin is loaded.
 */
let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const key of ['nadia', 'priya', 'lena'] as const satisfies readonly PersonaKey[]) {
  test(`sidebar as ${key} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, key, DESKTOP);
    try {
      await page.goto('/');
      await expect(page.locator('[data-landmark="sidebar"]')).toBeVisible();
      await expectWireframe(page, `sidebar-${key}`, [['team-switch', 'search', 'sidebar'], ['header', 'content']]);
    } finally {
      await close();
    }
  });
}
