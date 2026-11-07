import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { brainReady, routineStackEnv } from '../../settings/routine-support.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Account > Action items (PLAN P20-12; own baselines, class W, 1440x900 and 390x844). Baselines are made by the runner on first run and are not committed with this spec.
 *   action-items.png / -390              the list: open items (one overdue, one with a later day, one with no day), the done group closed, no keeper
 *   action-items-done.png / -390         the same with the done group opened
 *   action-items-keeper-plan.png / -390  the plan of the routine that keeps the list up to date, before the yes
 * The days are fixed (2020 and 2099) so the wording does not move with the clock; "Last saved" is a <time> and is masked.
 */
const PAGE = [['page-header'], ['title']];
const DESK = [['nav', 'content'], ...PAGE];
const PHONE_ORDER = [['nav-select', 'content'], ...PAGE];

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack(routineStackEnv());
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    await brainReady(stack, nadia);
    let revision: string | null = null;
    const add = async (change: Record<string, unknown>): Promise<string> => {
      const res = await nadia.ctx.patch('/api/me/action-items', { data: { revision, change }, headers: await nadia.headers() });
      expect(res.status(), await res.text()).toBe(200);
      const body = (await res.json()) as { list: { revision: string }; id: string };
      revision = body.list.revision;
      return body.id;
    };
    await add({ op: 'add', what: 'Send the revised quote to Acme', owner: 'Sam', due: '2020-01-31' });
    await add({ op: 'add', what: 'Book the venue for the offsite', due: '2099-12-31' });
    await add({ op: 'add', what: 'Reply to the audit questions' });
    const done = await add({ op: 'add', what: 'Renew the domain', owner: 'Rana', due: '2020-03-02' });
    await add({ op: 'tick', id: done, done: true });
  } finally {
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

for (const [suffix, viewport, mobile] of [
  ['', DESKTOP, false],
  ['-390', MOBILE, true],
] as const) {
  const order = mobile ? PHONE_ORDER : DESK;

  test(`Action items keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/account/action-items');
      await expect(page.getByTestId('action-items-count')).toContainText('3 to do, 1 done.');
      await expect(page.getByTestId('action-items-open').getByTestId('action-item')).toHaveCount(3);
      await expect(page.getByTestId('action-item-due-text').first()).toHaveClass(/late/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expectWireframe(page, `action-items${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`Action items with the done group open keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/account/action-items');
      await page.getByTestId('action-items-done-group').locator(':scope > summary').click();
      await expect(page.getByTestId('action-items-done').getByTestId('action-item')).toHaveCount(1);
      await page.getByTestId('action-items-done').scrollIntoViewIfNeeded();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `action-items-done${suffix}`, order);
    } finally {
      await close();
    }
  });

  test(`Action items with the keeper plan shown keeps its layout${suffix || ' at 1440'} (W)`, async ({ browser }) => {
    const { page, close } = await openPage(browser, stack, 'nadia', viewport, mobile);
    try {
      await page.goto('/account/action-items');
      await page.getByTestId('keeper-start').click();
      await expect(page.getByTestId('keeper-plan')).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expectWireframe(page, `action-items-keeper-plan${suffix}`, order);
    } finally {
      await close();
    }
  });
}
