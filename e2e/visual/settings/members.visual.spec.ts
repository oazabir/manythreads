import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Workspace settings > Members (PLAN phase 2 section 2: left nav and a members table with name, email, role and tags; on a
 * phone the nav becomes a top select). Class W, own baselines at 1440x900 and 390x844: members-desktop.png, members-mobile.png.
 */
let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const [name, viewport, mobile, order] of [
  ['members-desktop', DESKTOP, false, [['nav', 'content'], ['members-table']]],
  ['members-mobile', MOBILE, true, [['nav-select', 'content'], ['members-table']]],
] as const) {
  test(`members ${name} matches its baseline (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'omar', viewport, mobile);
    try {
      await page.goto('/settings/workspace/members');
      await expect(page.getByRole('table')).toBeVisible();
      await expectWireframe(page, name, order.map((g) => [...g]));
    } finally {
      await close();
    }
  });
}
