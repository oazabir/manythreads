import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { apiOn, channelsOf, openOn, PHONE } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/*
 * The one page header (P21-12) and the look tokens (P21-20): every route has exactly one h1 (the page's own; the shell draws a fallback h1 only while no
 * page header is mounted, so the two can coexist for one render and the checks poll), the skip link, one bell and one Find in the band, the phone trail,
 * the bot crumb tail, and the focus ring. Runs on desktop and mobile-web.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let channel = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, omar, 'helper', brainMd(['What is blocking the release?']));
    channel = Object.keys(await channelsOf(omar))[0] ?? 'dev';
  } finally {
    await omar.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

async function open(browser: import('@playwright/test').Browser, playwright: import('@playwright/test').PlaywrightWorkerArgs['playwright'], isMobile: boolean, who: PersonaKey, path: string) {
  return openOn(browser, playwright, stack, who, path, isMobile ? { viewport: PHONE, mobile: true } : {});
}

const h1s = (page: Page) => page.getByRole('heading', { level: 1 });
/** Exactly one h1, once the page has settled (the fallback and the page's own heading can both be there for one render). */
async function expectOneH1(page: Page, label: string): Promise<void> {
  await expect.poll(async () => h1s(page).count(), { message: `one h1 on ${label}`, timeout: 15_000 }).toBe(1);
  await expect(h1s(page)).toBeVisible();
  // and it stays one
  await page.waitForTimeout(300);
  await expect(h1s(page), `still one h1 on ${label}`).toHaveCount(1);
}

const TEAM_ROUTES = [
  'threads', 'files', 'boards', 'org', 'jobs', 'approvals', 'bots', 'agents', 'projects', 'recipes', 'memory', 'proposals', 'chat', 'chat?bot=helper', 'bots/helper', 'bots/new', 'bots/helper/usage', 'knowledge',
];
const SETTINGS_ROUTES = [
  '/settings/workspace/general', '/settings/workspace/members', '/settings/workspace/roles', '/settings/workspace/llm', '/settings/workspace/runners',
  '/settings/workspace/guardrails', '/settings/workspace/audit', '/settings/workspace/import', '/settings/team/engineering/roster', '/settings/team/engineering/connections',
  '/teams', '/account', '/account/profile', '/account/notifications', '/account/connections', '/account/security', '/account/bots',
  '/account/routines', '/account/action-items',
];
// Personal (P20-04) lives outside `/t/:team`: its screens are the first thing the Personal side of the switch shows
const PERSONAL_ROUTES = ['/memory', '/memory?tab=inbox', '/knowledge'];

test('team routes have exactly one h1', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', '/t/engineering/threads');
  try {
    for (const r of [...TEAM_ROUTES, `c/${channel}`]) {
      await page.goto(`/t/engineering/${r}`);
      await expectOneH1(page, r);
    }
  } finally {
    await context.close();
  }
});

test('Personal routes (/memory, /memory?tab=inbox, /knowledge) have exactly one h1', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'nadia', '/memory');
  try {
    for (const r of PERSONAL_ROUTES) {
      await page.goto(r);
      await expectOneH1(page, r);
    }
  } finally {
    await context.close();
  }
});

test('settings routes have exactly one h1', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', '/settings/workspace/general');
  try {
    for (const r of SETTINGS_ROUTES) {
      await page.goto(r);
      await expectOneH1(page, r);
    }
  } finally {
    await context.close();
  }
});

test('ConversationView: list, workshop and loading each have one h1; a phone thread view has one too', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'nadia', '/t/engineering/bots/helper/chat');
  try {
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await expectOneH1(page, 'conversation list');
    await expect(h1s(page)).toContainText('Brain');

    await page.goto('/t/engineering/bots/helper/chat?view=workshop');
    await expect(page.getByTestId('workshop-tab')).toBeVisible();
    await expectOneH1(page, 'workshop');

    // loading: hold the open call back and look while the screen waits for it
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/api\/teams\/engineering\/bots\/helper\/conversation$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto('/t/engineering/bots/helper/chat');
    await expect(page.getByTestId('conversation-loading')).toBeVisible();
    await expectOneH1(page, 'loading');
    release();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await page.unroute(/\/api\/teams\/engineering\/bots\/helper\/conversation$/);
    await expectOneH1(page, 'loaded');

    // a message opens a thread; on a phone it has the screen to itself, with no list heading
    const box = page.getByRole('textbox', { name: 'Message Brain' });
    await box.fill('Does the header hold?');
    await box.press('Enter');
    await expect(page).toHaveURL(/[?&]thread=[0-9a-f-]{36}/);
    await expectOneH1(page, 'thread open');
  } finally {
    await context.close();
  }
});

test('the skip link moves focus to the content: "Skip to messages" in a channel or a DM, "Skip to content" elsewhere', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', `/t/engineering/c/${channel}`);
  try {
    const cases: Array<[string, string]> = [[`/t/engineering/c/${channel}`, 'Skip to messages'], ['/t/engineering/boards', 'Skip to content']];
    for (const [path, label] of cases) {
      await page.goto(path);
      await expectOneH1(page, path);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Tab');
      const link = page.getByRole('link', { name: label, exact: true });
      await expect(link, path).toBeFocused();
      await expect(link).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page.locator('#content'), `${path}: Enter focuses #content`).toBeFocused();
    }
    // (the settings and account frames sit outside the shell and have no skip link: reported, not asserted)
    // the channel's link never reads "Skip to content", and the other pages never read "messages"
    await expect(page.getByRole('link', { name: 'Skip to messages' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('exactly one bell and one Find in the band on Approvals, Threads and Files', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', '/t/engineering/approvals');
  try {
    for (const r of ['approvals', 'threads', 'files']) {
      await page.goto(`/t/engineering/${r}`);
      await expectOneH1(page, r);
      await expect(page.getByTestId('bell'), `${r}: bell`).toHaveCount(1);
      // Find is the phone's search button (a wide screen has the sidebar search); the wide Threads inbox draws its own two bands and no shell band
      const find = page.locator('button[aria-label="Find"]');
      await expect(find, `${r}: Find`).toHaveCount(!isMobile && r === 'threads' ? 0 : 1);
      if (isMobile) await expect(page.getByRole('button', { name: 'Find', exact: true })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test('the trail: the phone shows only the last crumb, a desktop shows the whole path', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', '/t/engineering/bots/helper');
  try {
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toBeVisible();
    await expect(crumbs.locator('li:visible').last()).toHaveText('Brain');
    if (isMobile) await expect(crumbs.locator('li:visible')).toHaveCount(1);
    else await expect(crumbs.locator('li:visible')).toHaveText(['Engineering', 'Bots', 'Brain']);

    await page.goto('/t/engineering/boards');
    await expectOneH1(page, 'boards');
    await expect(crumbs.locator('li:visible').last()).toHaveText('Boards');
    if (isMobile) await expect(crumbs.locator('li:visible')).toHaveCount(1);
    else await expect(crumbs.locator('li:visible')).toHaveText(['Engineering', 'Boards']);
  } finally {
    await context.close();
  }
});

test('the bot crumb tail clears when you leave the bot page', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', '/t/engineering/bots/helper');
  try {
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText('Brain');
    // leave by the app's own navigation (no reload), so the shell's state is what is tested
    if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /^Boards/ }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/boards$/);
    await expectOneH1(page, 'boards');
    await expect(crumbs).not.toContainText('Brain');
    await expect(crumbs).toContainText('Boards');
    // and back to the roster: the section crumb is the last one again, with no stale bot name
    await page.goto('/t/engineering/bots');
    await expectOneH1(page, 'bots');
    await expect(crumbs).not.toContainText('Brain');
  } finally {
    await context.close();
  }
});

const outline = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.outlineWidth, style: s.outlineStyle };
  });

test('the focus ring is 2px on a sidebar link, an input and a menu item; a mouse click on an h1 shows none', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'omar', '/t/engineering/boards');
  try {
    await expectOneH1(page, 'boards');
    // keyboard focus first, so the browser treats the focus that follows as focus-visible
    await page.keyboard.press('Tab');
    if (isMobile) {
      await page.keyboard.press('Tab'); // past the skip link, which covers the menu button while it has focus
      await page.getByRole('button', { name: 'Open menu' }).press('Enter');
    }

    const link = page.locator('[data-landmark="sidebar"] a').first();
    await link.focus();
    await expect(link).toBeFocused();
    expect(await outline(page, '[data-landmark="sidebar"] a:focus'), 'sidebar link').toEqual({ width: '2px', style: 'solid' });

    const input = page.locator('[data-landmark="search"] input');
    await input.focus();
    await expect(input).toBeFocused();
    expect(await outline(page, '[data-landmark="search"] input:focus'), 'input').toEqual({ width: '2px', style: 'solid' });

    await page.getByRole('button', { name: 'Account menu' }).click();
    const item = page.getByRole('menuitem').first();
    await expect(item).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await item.focus();
    await expect(item).toBeFocused();
    expect(await outline(page, '[role="menuitem"]:focus'), 'menu item').toEqual({ width: '2px', style: 'solid' });
    await page.keyboard.press('Escape');

    if (isMobile) await page.getByRole('button', { name: 'Close menu' }).click({ position: { x: 380, y: 400 } });
    // a mouse click on the page heading (tabIndex -1) focuses it without a ring
    const h1 = h1s(page);
    await expect(h1).toHaveAttribute('tabindex', '-1');
    await h1.click();
    await expect(h1).toBeFocused();
    const s = await h1.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(s).toBe('none');
  } finally {
    await context.close();
  }
});
