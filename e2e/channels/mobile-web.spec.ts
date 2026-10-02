import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, messagesIn, noSidewaysScroll, openOn, postAs, PHONE, type StackApi } from '../support/stack-browser.ts';

/**
 * e2e/channels/mobile-web (PLAN phase 3 section 4, project `mobile-web`, 390x844): the sidebar is a drawer behind the hamburger, a thread
 * is a full sheet, the composer is usable (send with the button), search and the bell work from the header, and nothing ever scrolls sideways.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => !isMobile, 'phone viewport only');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let nadia: StackApi;
let rafi: StackApi;
let omar: StackApi;
let dev = '';
let root = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  dev = (await channelsOf(nadia))['dev']!;
  root = (await postAs(rafi, dev, 'Rollback runbook is ready for review, with a very long unbroken line https://example.com/runbooks/rollback/2026/09/very/long/path/that/would/overflow')).id;
  await postAs(nadia, dev, 'Reviewing now.', root);
  await postAs(rafi, dev, '@nadia ready when you are.');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

test('drawer, channel, thread sheet, send: no sideways scroll anywhere', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads', { viewport: PHONE, mobile: true });
  try {
    const rail = page.locator('#shell-rail');
    await expect(rail).toHaveAttribute('inert', '');
    expect(await noSidewaysScroll(page)).toBe(true);

    // the drawer opens behind the hamburger and lists the channels; choosing one closes it
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'open');
    await expect(rail.getByRole('link', { name: /dev/ })).toBeVisible();
    await expect(rail.getByRole('button', { name: 'New', exact: true })).toBeVisible();
    await rail.getByRole('link', { name: /dev/ }).click();
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'closed');
    await expect(page).toHaveURL(/\/t\/engineering\/c\/dev/);
    await expect(messagesIn(page).first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);

    // a thread is a full sheet over the channel
    await page.locator(`[data-message-id="${root}"]`).getByRole('button', { name: /1 reply/ }).click();
    const sheet = page.locator('[data-landmark="right-panel"]');
    await expect(page.getByTestId('thread-view')).toBeVisible();
    expect(await sheet.boundingBox()).toMatchObject({ x: 0, y: 0, width: PHONE.width, height: PHONE.height });
    expect(await noSidewaysScroll(page)).toBe(true);
    // reply from the sheet with the send button
    const reply = page.getByTestId('thread-view').getByRole('textbox');
    await reply.fill('Approved from my phone.');
    await page.getByTestId('thread-view').getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('thread-view').locator('[data-testid="message"]').filter({ hasText: 'Approved from my phone.' })).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(sheet).toBeHidden();

    // the composer: type, send with the button, see it at the bottom
    const box = page.getByRole('textbox', { name: 'Message #dev' });
    await box.fill('Shipping the rollback runbook now');
    await page.getByRole('button', { name: 'Send' }).first().click();
    await expect(messagesIn(page).last()).toContainText('Shipping the rollback runbook now');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('search and the bell from the header, and a direct message, fit the phone', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
  try {
    // find: opens the drawer on the search box; results are a full sheet and a hit lands on the message
    await page.getByRole('button', { name: 'Find' }).click();
    const box = page.locator('#shell-rail').getByRole('searchbox');
    await expect(box).toBeFocused();
    await box.fill('rollback');
    await box.press('Enter');
    const results = page.getByTestId('search-results');
    await expect(results).toContainText('Messages');
    expect(await noSidewaysScroll(page)).toBe(true);
    await results.getByTestId('search-hit').first().click();
    await expect(page).toHaveURL(/message=/);
    await expect(page.locator('[data-landmark="right-panel"]')).toBeHidden();

    // the bell: Nadia's reply to a thread Rafi started is waiting
    await page.getByTestId('bell').click();
    const pop = page.getByTestId('notifications-popover');
    await expect(pop).toBeVisible();
    const box2 = await pop.boundingBox();
    expect(box2!.x).toBeGreaterThanOrEqual(0);
    expect(box2!.x + box2!.width).toBeLessThanOrEqual(PHONE.width);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.keyboard.press('Escape');

    // direct message from the drawer picker
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'New message' });
    await picker.getByRole('checkbox', { name: /Priya/ }).check();
    await picker.getByRole('button', { name: 'Message' }).click();
    await expect(page).toHaveURL(/\/dm\//);
    await page.getByRole('textbox', { name: /Message Priya/ }).fill('Welcome to the team');
    await page.getByRole('button', { name: 'Send' }).first().click();
    await expect(messagesIn(page).last()).toContainText('Welcome to the team');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('Lena on the phone: the drawer holds #releases only, there is no composer', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/', { viewport: PHONE, mobile: true });
  try {
    await expect(page).toHaveURL(/\/c\/releases$/);
    await expect(page.getByTestId('read-only')).toHaveText('You can read this channel.');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('[data-landmark="sidebar"] a.it')).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
