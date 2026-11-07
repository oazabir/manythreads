import { expect, test } from '@playwright/test';
import { personas } from '../../fixtures/seed.ts';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { BANNER_TIME, apiOn, openSpaceOf, uploadAs } from '../../files/personal-support.ts';
import { DESKTOP, MOBILE, expectWireframe, openPage } from '../support/vt.ts';

/*
 * Looking into a Personal space (P20-06, P20-07, P20-13; own baselines, class W): the read-only banner of the admin's view at 1440x900 and 390x844, the
 * Members menu with Open Personal space and Deactivate, the two dialogs, the row of a deactivated person, and the Account card "Who opened your Personal
 * space". Times carry data-vt-mask, the clock time at the end of the access hour in the banner included.
 * personal-open-banner.png, personal-open-banner-390.png, members-menu.png, open-space-dialog.png, deactivate-dialog.png, members-deactivated.png,
 * personal-opens-card.png.
 */
const { nadia, rafi } = personas;
const REASON = 'Nadia is away and we need the handover notes';
const FILES_ORDER = [['team-switch', 'search', 'sidebar'], ['header', 'tree', 'list']];
const MEMBERS_ORDER = [['nav', 'content'], ['members-table']];

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'desktop project: the viewport is set by the spec');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const nadiaApi = await apiOn(playwright, stack, 'nadia');
  await uploadAs(nadiaApi, 'Notes', 'handover.md', '# Handover\n\nWhere everything is.\n');
  await uploadAs(nadiaApi, 'Notes', 'figures.csv', 'a,b\n1,2\n', { type: 'text/csv' });
  await nadiaApi.ctx.dispose();
  const omar = await apiOn(playwright, stack, 'omar');
  expect((await openSpaceOf(omar, nadia.personId, REASON)).status).toBe(200);
  await omar.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the admin\'s read-only view of a Personal space keeps its layout at 1440 (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto(`/files/person/${nadia.personId}?path=Notes`);
    await expect(page.getByTestId('file-row')).toHaveCount(2);
    await expect(page.getByTestId('admin-view-note')).toContainText(BANNER_TIME);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expectWireframe(page, 'personal-open-banner', FILES_ORDER);
  } finally {
    await close();
  }
});

test('the admin\'s read-only view keeps its layout on a phone (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', MOBILE, true);
  try {
    await page.goto(`/files/person/${nadia.personId}?path=Notes`);
    await expect(page.getByTestId('file-row')).toHaveCount(2);
    await expect(page.getByTestId('admin-view-note')).toContainText(BANNER_TIME);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectWireframe(page, 'personal-open-banner-390', [['header', 'list']]);
  } finally {
    await close();
  }
});

test('Members: the row menu, the two dialogs and a deactivated row keep their layout (W)', async ({ browser, playwright }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/settings/workspace/members');
    await expect(page.getByTestId('member-row')).toHaveCount(7);
    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Change role', 'Send a password reset', 'Open Personal space', 'Deactivate']);
    await expectWireframe(page, 'members-menu', MEMBERS_ORDER);

    await page.getByRole('menuitem', { name: 'Open Personal space' }).click();
    await page.getByTestId('open-space-reason').fill('The on-call rota is only in his files');
    await expect(page.getByTestId('open-space-submit')).toBeEnabled();
    await expectWireframe(page, 'open-space-dialog', MEMBERS_ORDER);
    await page.getByTestId('open-space-dialog').getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    await expect(page.getByTestId('deactivate-dialog')).toBeVisible();
    await expectWireframe(page, 'deactivate-dialog', MEMBERS_ORDER);
    await page.getByTestId('deactivate-dialog').getByRole('button', { name: 'Cancel' }).click();

    // a deactivated person wears a tag and is offered Reactivate; put back whatever happens
    const omar = await apiOn(playwright, stack, 'omar');
    try {
      expect((await omar.ctx.patch(`/api/workspace/members/${rafi.personId}`, { data: { status: 'suspended' }, headers: await omar.headers() })).status()).toBe(200);
      await page.reload();
      await expect(page.getByTestId('member-deactivated')).toHaveCount(1);
      await expectWireframe(page, 'members-deactivated', MEMBERS_ORDER);
    } finally {
      await omar.ctx.patch(`/api/workspace/members/${rafi.personId}`, { data: { status: 'active' }, headers: await omar.headers() });
      await omar.ctx.dispose();
    }
  } finally {
    await close();
  }
});

test('Account: "Who opened your Personal space" keeps its layout (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'nadia', DESKTOP);
  try {
    await page.goto('/account/security');
    const opens = page.getByTestId('personal-open');
    await expect(opens).toHaveCount(1);
    await expect(opens.first()).toContainText('Omar (open now)');
    await expect(opens.first()).toContainText(REASON);
    // the sessions card holds the browser and times of this run: out of the plate
    await page.locator('[data-landmark="sessions"]').evaluate((el) => el.setAttribute('data-vt-mask', ''));
    await expectWireframe(page, 'personal-opens-card', [['nav', 'content'], ['page-header'], ['personal-opens']]);
  } finally {
    await close();
  }
});
