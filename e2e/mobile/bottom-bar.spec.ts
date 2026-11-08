import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, channelsOf, noSidewaysScroll, openOn, postAs, PHONE, type StackApi } from '../support/stack-browser.ts';

/*
 * The phone shell (P21-23, project `mobile-web`, 390x844): the bottom bar with its five entries and badges, the bar staying clear of the composer,
 * the edge swipe that opens the drawer without fighting scrolling, 40 px header controls, one search icon, and a long channel name read in full.
 * One test also runs on the desktop project: the sidebar's search box keeps its text whole (an ellipsis, the full words in a tooltip).
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const LONG_NAME = 'quarterly-planning-and-roadmap-review';
const BAR = 56;

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let dev = '';
let long = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  dev = (await channelsOf(nadia))['dev']!;
  long = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: LONG_NAME })).channel.id;
  await postAs(omar, long, 'First message in the long-named channel.');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

/** One finger from (x0, y0) to (x1, y1) in a few steps, as the browser's touch input (what a real swipe sends). */
async function swipe(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(...from) });
  for (let i = 1; i <= 6; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / 6;
    const y = from[1] + ((to[1] - from[1]) * i) / 6;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x, y) });
    await page.waitForTimeout(30); // a finger's moves arrive a frame apart; the browser merges the ones that come faster
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone viewport only');

  test('five entries in order, Home lit on Threads, and the bar clears the channel composer', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads', { viewport: PHONE, mobile: true });
    try {
      const bar = page.getByRole('navigation', { name: 'Main' });
      await expect(bar).toBeVisible();
      await expect(bar.locator('.bb-item .bb-label')).toHaveText(['Home', 'Messages', 'Activity', 'Search', 'You']);
      await expect(bar.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
      const box = (await bar.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(BAR);
      expect(box.y + box.height).toBeCloseTo(PHONE.height, 0);
      expect(await noSidewaysScroll(page)).toBe(true);

      // in a channel the composer ends above the bar, and the last message is not behind it
      await page.goto('/t/engineering/c/dev');
      const input = page.getByRole('textbox', { name: 'Message #dev' });
      await expect(input).toBeVisible();
      const top = (await bar.boundingBox())!.y;
      for (const target of [input, page.getByRole('button', { name: 'Send' }).first()]) {
        const b = (await target.boundingBox())!;
        expect(b.y + b.height, 'composer control ends above the bar').toBeLessThanOrEqual(top + 0.5);
      }
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bottom-bar-h').trim())).not.toBe('0px');

      // while the keyboard is up (a text box has the focus) the bar steps aside; it comes back when the focus leaves
      await input.focus();
      await expect(bar).toBeHidden();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset['bottomBar'] ?? '')).toBe('');
      await input.evaluate((el) => (el as HTMLElement).blur());
      await expect(bar).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('Messages shows an unread direct message as a badge, lists it, and the badge clears when it is read', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads', { viewport: PHONE, mobile: true });
    try {
      const bar = page.getByRole('navigation', { name: 'Main' });
      await expect(bar.getByTestId('bar-messages').locator('.pill')).toHaveCount(0);
      const me = await omar.get<{ person: { id: string } }>('/api/session');
      const dm = await nadia.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [me.person.id] });
      await postAs(nadia, dm.dm.channel.id, 'Are you free for five minutes?');
      // the new conversation reaches the page as a push; a message that lands before the list has refreshed is only counted by a later one, so say it again
      const badge = bar.getByTestId('bar-messages').locator('.pill');
      for (let tries = 0; tries < 4 && (await badge.count()) === 0; tries++) {
        await badge.waitFor({ timeout: 5_000 }).catch(async () => postAs(nadia, dm.dm.channel.id, `Are you there? (${tries})`));
      }
      await expect(badge).toHaveText(/^[1-9]\d*\b/);

      await bar.getByRole('link', { name: /Messages/ }).click();
      await expect(page).toHaveURL(/\/t\/engineering\/dms$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible();
      await expect(bar.getByRole('link', { name: /Messages/ })).toHaveAttribute('aria-current', 'page');
      const row = page.getByTestId('messages-screen').getByRole('link', { name: /Nadia/ });
      await expect(row).toBeVisible();
      expect(await noSidewaysScroll(page)).toBe(true);
      // the page offers a new message too
      await page.getByTestId('messages-screen').getByRole('button', { name: 'New message' }).click();
      await expect(page.getByRole('dialog', { name: 'New message' })).toBeVisible();
      await page.keyboard.press('Escape');

      await row.click();
      await expect(page).toHaveURL(/\/dm\//);
      await expect(bar.getByRole('link', { name: /Messages/ })).toHaveAttribute('aria-current', 'page');
      await expect(bar.getByTestId('bar-messages').locator('.pill')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('Activity opens its page; Search opens the drawer on the search box; You opens the account sheet', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads', { viewport: PHONE, mobile: true });
    try {
      const bar = page.getByRole('navigation', { name: 'Main' });
      await bar.getByRole('link', { name: /Activity/ }).click();
      await expect(page).toHaveURL(/\/t\/engineering\/activity$/);
      await expect(bar.getByRole('link', { name: /Activity/ })).toHaveAttribute('aria-current', 'page');

      await bar.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'open');
      await expect(page.locator('#shell-rail').getByRole('searchbox')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'closed');

      await bar.getByRole('button', { name: 'You' }).click();
      const sheet = page.getByTestId('account-sheet');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('menuitem', { name: 'Account' })).toBeVisible();
      await expect(sheet.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
      const s = (await sheet.boundingBox())!;
      expect(s.y + s.height).toBeCloseTo(PHONE.height, 0);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await bar.getByRole('button', { name: 'You' }).click();
      await sheet.getByRole('menuitem', { name: 'Account' }).click();
      await expect(page).toHaveURL(/\/account\/profile$/);
    } finally {
      await context.close();
    }
  });

  test('a thread covers the bar; closing it brings the bar back', async ({ browser, playwright }) => {
    const root = (await postAs(nadia, dev, 'A message with a thread under it.')).id;
    await postAs(omar, dev, 'First reply.', root);
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
    try {
      const bar = page.getByRole('navigation', { name: 'Main' });
      await expect(bar).toBeVisible();
      await page.locator(`[data-message-id="${root}"]`).getByRole('button', { name: /\d+ repl(y|ies)/ }).click();
      await expect(page.getByTestId('thread-view')).toBeVisible();
      await expect(bar).toBeHidden();
      await page.getByRole('button', { name: 'Close panel' }).click();
      await expect(bar).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a swipe in from the left edge opens the drawer; a scroll, a swipe from the middle and a swipe on a wide screen do not', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
    try {
      const frame = page.locator('.frame');
      await expect(page.getByRole('textbox', { name: 'Message #dev' })).toBeVisible();
      // from the middle of the screen, to the right: nothing opens (in the header, away from the message rows, whose own swipe replies)
      await swipe(page, [150, 30], [300, 34]);
      // from the edge but mostly down: a scroll
      await swipe(page, [6, 300], [40, 520]);
      await page.waitForTimeout(250);
      await expect(frame).toHaveAttribute('data-drawer', 'closed');
      // from the edge and straight across
      await swipe(page, [4, 400], [180, 410]);
      await expect(frame).toHaveAttribute('data-drawer', 'open');
      await expect(page.locator('#shell-rail')).not.toHaveAttribute('inert', '');
      await page.getByRole('button', { name: 'Close menu' }).click({ position: { x: 380, y: 400 } });
      await expect(frame).toHaveAttribute('data-drawer', 'closed');
    } finally {
      await context.close();
    }
  });

  test('every control in the header is at least 40 px, on a channel, a direct message and a page', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
    try {
      for (const path of ['/t/engineering/c/dev', '/t/engineering/boards', '/t/engineering/files', '/t/engineering/dms']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        const buttons = page.locator('.chead button');
        await expect(buttons.first()).toBeVisible();
        // a channel's tools (search, members, bell) arrive a moment after its heading
        if (path.includes('/c/')) await expect(page.getByTestId('bell')).toBeVisible();
        const sizes = await buttons.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => {
          const r = e.getBoundingClientRect();
          return { name: e.getAttribute('aria-label') ?? e.textContent?.trim().slice(0, 30) ?? '', w: Math.round(r.width), h: Math.round(r.height) };
        }));
        // the menu button on every page; a channel has its tools beside it
        expect(sizes.length, path).toBeGreaterThanOrEqual(path.includes('/c/') ? 3 : 1);
        for (const s of sizes) {
          expect(s.w, `${path}: ${s.name} width`).toBeGreaterThanOrEqual(40);
          expect(s.h, `${path}: ${s.name} height`).toBeGreaterThanOrEqual(40);
        }
        expect(await noSidewaysScroll(page), path).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test('one search icon in the header: the conversation search on a channel, none on a page', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
    try {
      const searchButtons = page.locator('.chead button[aria-label*="earch"], .chead button[aria-label="Find"]');
      await expect(page.getByRole('button', { name: 'Search this conversation' })).toBeVisible();
      await expect(searchButtons).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Find', exact: true })).toHaveCount(0);
      await page.goto('/t/engineering/boards');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(searchButtons).toHaveCount(0);
      // the bar's Search is the one way in from a page
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('a 40-character channel name reads in full at 390, on at most two lines, with the tools still in view', async ({ browser, playwright }) => {
    expect(LONG_NAME.length).toBeGreaterThanOrEqual(35);
    const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${LONG_NAME}`, { viewport: PHONE, mobile: true });
    try {
      const name = page.locator('.chead .chd-name');
      await expect(name).toHaveText(`#${LONG_NAME}`);
      const r = (await name.boundingBox())!;
      const line = await name.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(PHONE.width);
      expect(r.height).toBeLessThanOrEqual(line * 2 + 2);
      expect(await name.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe('ellipsis');
      // nothing is cut: the text fits the box it is drawn in
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const tool of [page.getByTestId('bell'), page.getByRole('button', { name: 'Search this conversation' })]) {
        await expect(tool).toBeInViewport({ ratio: 1 });
      }
      expect(await noSidewaysScroll(page)).toBe(true);
    } finally {
      await context.close();
    }
  });
});

test('the sidebar search keeps its words: an ellipsis when they do not fit, the whole text in a tooltip', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
    const region = page.locator('[data-landmark="search"]');
    await expect(region).toHaveAttribute('title', /^Search /);
    const input = region.getByRole('searchbox');
    expect(await input.evaluate((el) => getComputedStyle(el).textOverflow)).toBe('ellipsis');
    // a name that cannot fit still ends in an ellipsis instead of half a letter
    await input.evaluate((el) => el.setAttribute('placeholder', 'Search Customer support and the rest of a very long team name'));
    expect(await input.evaluate((el) => el.scrollWidth >= el.clientWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
