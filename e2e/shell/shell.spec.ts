import { expect, test } from '@playwright/test';
import { apiAs, createChannel } from '../channels/support.ts';
import { authState } from '../support/env.ts';

/**
 * The app shell (PLAN P3-11, P3-12, P3-14 layout): the sidebar contract, team switching, the guest variant, the right panel
 * deep link, and the phone layout. Channel content is later work; these specs cover the frame around it.
 */

const sidebarRows = async (page: import('@playwright/test').Page): Promise<string[]> =>
  page.locator('[data-landmark="sidebar"] > .it, [data-landmark="sidebar"] > .sec').allInnerTexts().then((rows) => rows.map((r) => r.split('\n')[0]!.trim()));

// channels are real now: the URL names a channel the directory lists (a made-up name is "You cannot see this channel.")
let dev = '';
test.beforeAll(async () => {
  const omar = await apiAs('omar');
  dev = (await createChannel(omar, 'dev')).name;
  await omar.ctx.dispose();
});

test.describe('Nadia, a member', () => {
  test.use({ storageState: authState('nadia') });

  test('the sidebar is the contract in order, with empty states in product words', async ({ page, isMobile }) => {
    await page.goto('/');
    if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
    const sidebar = page.locator('[data-landmark="sidebar"]');
    await expect(sidebar).toBeVisible();
    // the rows arrive once the team list has loaded
    await expect.poll(() => sidebarRows(page)).toEqual(['Files', 'Boards', 'Threads', 'Approvals', 'Direct messages', 'Bots']);
    await expect(sidebar).not.toContainText('No files yet');
    await expect(sidebar).toContainText('No boards yet');
    await expect(sidebar).toContainText('Nothing waiting');
    await expect(sidebar).toContainText('No bots yet');
    await expect(sidebar).not.toContainText(/phase|later/i);
    // search placeholder names the team; the person is named at the bottom
    await expect(page.locator('[data-landmark="search"] input')).toHaveAttribute('placeholder', 'Search Engineering');
    await expect(page.locator('.rail .foot')).toContainText('Nadia');
  });

  test('Bots opens the team roster; sections and channels have their own URLs', async ({ page, isMobile }) => {
    await page.goto('/t/engineering/files');
    await expect(page.getByTestId('files-screen')).toBeVisible();
    await expect(page.locator('[data-landmark="header"]')).toContainText('Files');
    await page.goto(`/t/engineering/c/${dev}`);
    await expect(page.locator('[data-landmark="header"]')).toContainText(`# ${dev}`);
    await expect(page.locator('[data-landmark="content"]')).toContainText(`This is the start of #${dev}.`);
    await page.goto('/t/engineering/dm/abc');
    await expect(page.locator('[data-landmark="header"]')).toContainText('Direct message');
    await page.goto('/t/engineering/threads');
    if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Bots/ }).click();
    await expect(page).toHaveURL(/\/settings\/team\/engineering\/roster$/);
  });

  test('a team she is not on is a 403 inside the shell', async ({ page }) => {
    await page.goto('/t/customer-support/threads');
    await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
  });

  test('?panel= restores the panel; Esc and the close button close it', async ({ page }) => {
    await page.goto(`/t/engineering/c/${dev}?panel=thread:abc`);
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-panel-entry]')).toHaveAttribute('data-panel-entry', 'thread:abc');
    // the channel stays visible beside it on desktop
    await expect(page.locator('[data-landmark="content"]')).toContainText(`This is the start of #${dev}.`);
    await page.reload();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/panel=/);

    await page.goto(`/t/engineering/c/${dev}?panel=file:docs/readme.md`);
    await expect(panel).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(panel).toBeHidden();
  });

  test('a panel type nobody registered says so instead of failing', async ({ page }) => {
    await page.goto('/t/engineering/threads?panel=nope:1');
    await expect(page.locator('[data-landmark="right-panel"]')).toContainText('This item cannot be shown here.');
  });
});

test.describe('Priya, a member of two teams', () => {
  test.use({ storageState: authState('priya') });

  test('switching teams keeps the section and the /t/<slug> URL', async ({ page, isMobile }) => {
    await page.goto('/t/engineering/files');
    if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('button', { name: /Team/ }).click();
    const menu = page.getByRole('menu', { name: 'Teams' });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await menu.getByRole('menuitemradio', { name: 'Marketing' }).click();
    await expect(page).toHaveURL(/\/t\/marketing\/files$/);
    await expect(page.getByTestId('files-screen')).toBeVisible();
  });
});

test.describe('Lena, a guest', () => {
  test.use({ storageState: authState('lena') });

  test('the guest shell has no Files, Boards, Approvals, Bots or team menu', async ({ page, isMobile }) => {
    await page.goto('/');
    if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
    const sidebar = page.locator('[data-landmark="sidebar"]');
    await expect(sidebar).toBeVisible();
    for (const hidden of ['Files', 'Boards', 'Approvals', 'Bots', 'Threads', 'Direct messages']) {
      await expect(sidebar.getByText(hidden, { exact: true })).toHaveCount(0);
    }
    await expect(page.locator('[data-landmark="team-switch"] button')).toHaveCount(0);
    await expect(page.locator('[data-landmark="search"] input')).toHaveAttribute('placeholder', 'Search');
  });
});

test.describe('phone layout', () => {
  test.use({ storageState: authState('nadia') });

  test('the sidebar is a drawer behind the hamburger and the panel a full-height sheet, with no sideways scroll', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone viewport only');
    await page.goto('/t/engineering/threads');
    const rail = page.locator('#shell-rail');
    await expect(rail).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'open');
    await expect(rail).not.toHaveAttribute('inert', '');
    // choosing a destination closes the drawer
    await rail.getByRole('link', { name: /Files/ }).click();
    await expect(page).toHaveURL(/\/files$/);
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'closed');
    // Esc closes the drawer without touching anything else
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'closed');

    await page.goto(`/t/engineering/c/${dev}?panel=thread:abc`);
    const box = await page.locator('[data-landmark="right-panel"]').boundingBox();
    const vp = page.viewportSize()!;
    expect(box).toMatchObject({ x: 0, y: 0, width: vp.width, height: vp.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
