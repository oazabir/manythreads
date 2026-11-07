import { expect, test, type BrowserContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/*
 * PLAN P21-23 part 2 (the channel, the thread and the bot page on a phone) and the density check of P21-21, on the desktop and the 390 px project:
 *  - a finger dragged right across a message opens its thread; a finger held on it opens the reaction picker and adds no reaction; a tap on a message
 *    with replies opens its thread; a drag up or down only scrolls (touch gestures: mobile-web project only, they are touch events)
 *  - a short conversation (three messages in a DM) never has the "Jump to first unread" pill, the floating day pill and the day dividers over each other
 *  - the first page of a channel is a skeleton of messages, not the word "Loading"
 *  - Compact density takes at most 70% of Comfortable's height for a run of short messages; a continued line has no avatar
 *  - the thread panel: a long source chip wraps to two lines at 390; the thread's box never scrolls sideways
 *  - the bot page header at 390: avatar and name, then one row of actions with "…", nothing over anything
 * Starts its own stack with one bot whose name is far longer than a row.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let channelId = '';
let channelName = '';
let replied = '';
let plain = '';
let dmId = '';
const LONG_NAME = 'Release Manager For The Entire Platform Engineering Organisation';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack(conversationStackEnv());
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  await addBot(stack, omar, 'release-manager', brainMd(['Hello']).replace('name: Brain', `name: ${LONG_NAME}`));
  channelName = 'phone-probe';
  channelId = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: channelName })).channel.id;
  // eight short messages from one author: one run
  for (const t of ['Rolled the canary.', 'Metrics look flat.', 'No errors in the last ten minutes.', 'Starting the second batch now.', 'Second batch done.', 'Queue drained.']) await postAs(omar, channelId, t);
  replied = (await postAs(omar, channelId, 'A message that gets a reply.')).id;
  await postAs(nadia, channelId, 'Here is the reply.', replied);
  plain = (await postAs(omar, channelId, 'A message nobody answered.')).id;
  // a conversation of three short messages that Omar has not read
  const omarId = (await omar.get<{ person: { id: string } }>('/api/session')).person.id;
  dmId = (await nadia.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [omarId] })).dm.channel.id;
  for (const t of ['Hi Omar', 'Quick question about the rollout', 'Can you look at it today?']) await postAs(nadia, dmId, t);
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

const rowOf = (page: Page, id: string): Locator => page.locator(`[data-message-id="${id}"]`);

/** Touch events from a real finger (CDP), so the page sees pointer events of type touch, which is what its gestures listen to. */
function finger(cdp: CDPSession) {
  const send = (type: string, x: number, y: number): Promise<unknown> => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return {
    down: (x: number, y: number) => send('touchStart', x, y),
    move: (x: number, y: number) => send('touchMove', x, y),
    up: () => send('touchEnd', 0, 0),
  };
}

async function openPhone(browser: Parameters<typeof openOn>[0], playwright: Parameters<typeof openOn>[1], path: string) {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', path, { viewport: PHONE, mobile: true });
  const cdp = await context.newCDPSession(page);
  return { page, context, touch: finger(cdp) };
}

const center = async (loc: Locator): Promise<{ x: number; y: number; left: number }> => {
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.x };
};

test('a finger dragged right across a message opens its thread; one dragged down only scrolls', async ({ browser, playwright, isMobile }) => {
  test.skip(!isMobile, 'touch gestures: the phone project');
  const { page, context, touch } = await openPhone(browser, playwright, `/t/engineering/c/${channelName}`);
  try {
    const row = rowOf(page, plain);
    await expect(row).toBeVisible();
    const at = await center(row);
    // a drag mostly down is the list scrolling: no thread
    await touch.down(at.x, at.y);
    for (let i = 1; i <= 5; i += 1) await touch.move(at.x + i * 4, at.y - i * 12);
    await touch.up();
    await expect(page.getByTestId('thread-view')).toHaveCount(0);
    // a short swipe does not count either
    await touch.down(at.left + 20, at.y);
    for (let x = 20; x <= 50; x += 10) await touch.move(at.left + x, at.y);
    await touch.up();
    await expect(page.getByTestId('thread-view')).toHaveCount(0);

    // a long, straight one does: the row follows the finger, then the thread opens
    await touch.down(at.left + 20, at.y);
    for (let x = 30; x <= 160; x += 20) await touch.move(at.left + x, at.y);
    await expect(row).toHaveAttribute('data-swiping', '');
    await expect(row).toHaveAttribute('data-swipe-ready', '');
    await touch.up();
    await expect(page.getByTestId('thread-view')).toBeVisible();
    await expect(page.getByTestId('thread-view').getByTestId('message').first()).toContainText('A message nobody answered.');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a finger held on a message opens the reaction picker and adds no reaction; a tap on a message with replies opens its thread', async ({ browser, playwright, isMobile }) => {
  test.skip(!isMobile, 'touch gestures: the phone project');
  const { page, context, touch } = await openPhone(browser, playwright, `/t/engineering/c/${channelName}`);
  try {
    const row = rowOf(page, plain);
    await expect(row).toBeVisible();
    const at = await center(row);
    await touch.down(at.left + 120, at.y);
    await page.waitForTimeout(700);
    await expect(page.getByRole('menu', { name: 'Reactions' })).toBeVisible();
    await touch.up();
    // the browser's own press-and-release events right after the hold must not close it or open anything
    await page.waitForTimeout(400);
    await expect(page.getByRole('menu', { name: 'Reactions' })).toBeVisible();
    await expect(page.getByTestId('thread-view')).toHaveCount(0);
    await expect(row.locator('.reactions')).toHaveCount(0);
    // a tap elsewhere (once the browser's follow-up events are over) closes it again
    await page.waitForTimeout(500);
    await page.getByRole('textbox', { name: `Message #${channelName}` }).tap();
    await expect(page.getByRole('menu', { name: 'Reactions' })).toHaveCount(0);

    // a tap on the text of a message that has replies opens its thread
    const answered = rowOf(page, replied);
    await expect(answered).toBeVisible();
    const t = await center(answered.locator('.txt'));
    await page.touchscreen.tap(t.x, t.y);
    await expect(page.getByTestId('thread-view')).toBeVisible();
    await expect(page.getByTestId('thread-view').getByTestId('message').first()).toContainText('A message that gets a reply.');
  } finally {
    await context.close();
  }
});

test('three unread messages in a DM: the jump pill, the day pill and the dividers never overlap', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/dm/${dmId}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(page.getByTestId('message')).toHaveCount(3);
    await expect(page.getByTestId('jump-first-unread')).toBeVisible();
    // the list holds three lines: there is nothing to scroll, so no day floats over it
    await expect(page.locator('.day-float')).toHaveCount(0);
    const boxes = await page.evaluate(() => {
      const rect = (e: Element): [number, number, number, number] => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      };
      return {
        jump: rect(document.querySelector('[data-testid="jump-first-unread"]')!),
        days: [...document.querySelectorAll('.vlist .daysep > span, .day-float > span')].map(rect),
        list: rect(document.querySelector('.chview-list')!),
      };
    });
    expect(boxes.days.length).toBeGreaterThanOrEqual(2); // "Today" and "New messages"
    const hit = (a: number[], b: number[]): boolean => !(a[2]! <= b[0]! || a[0]! >= b[2]! || a[3]! <= b[1]! || a[1]! >= b[3]!);
    for (const d of boxes.days) expect(hit(boxes.jump, d), `the pill at ${boxes.jump.join(',')} covers a divider at ${d.join(',')}`).toBe(false);
    // and it is inside the list, not under the composer
    expect(boxes.jump[1]!).toBeGreaterThanOrEqual(boxes.list[1]! - 0.5);
    expect(boxes.jump[3]!).toBeLessThanOrEqual(boxes.list[3]! + 0.5);
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('the first page of a channel shows a skeleton of messages, not the word Loading', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/general', {});
  try {
    await context.route(new RegExp(`/api/channels/${channelId}/messages(\\?|$)`), async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return route.continue();
    });
    await page.goto(`/t/engineering/c/${channelName}`);
    const skeleton = page.getByRole('status', { name: `Loading messages in #${channelName}` });
    await expect(skeleton).toBeVisible();
    await expect(skeleton).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.chview-list').getByText('Loading…')).toHaveCount(0);
    await expect(skeleton).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('message').first()).toBeVisible();
  } finally {
    await context.close();
  }
});

test('Compact density takes at most 70% of the height of Comfortable for a run of short messages, and a continued line has no avatar', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${channelName}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const run = page.locator('[data-testid="message"]').filter({ hasText: /Rolled the canary|Metrics look flat|No errors in the last|Starting the second|Second batch done|Queue drained/ });
    await expect(run).toHaveCount(6);
    const span = async (): Promise<number> =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="message"]')].slice(0, 6);
        return rows[rows.length - 1]!.getBoundingClientRect().bottom - rows[0]!.getBoundingClientRect().top;
      });
    const setDensity = async (d: 'comfortable' | 'compact'): Promise<void> => {
      await page.evaluate((v) => document.documentElement.setAttribute('data-density', v), d);
      await expect(page.locator('html')).toHaveAttribute('data-density', d);
    };
    await setDensity('comfortable');
    const roomy = await span();
    await setDensity('compact');
    const tight = await span();
    expect(tight / roomy, `compact ${tight}px of ${roomy}px`).toBeLessThanOrEqual(0.7);

    // a continued line: no picture, no name drawn, the time only on hover, in the empty column
    const second = run.nth(1);
    await expect(second).toHaveClass(/run/);
    await expect(second.locator('.av, .av-wrap')).toHaveCount(0);
    const stamp = second.locator('time.run-time');
    await expect(stamp).toHaveCSS('opacity', '0');
    if (!isMobile) {
      await second.hover();
      await expect(stamp).toHaveCSS('opacity', '1');
      const [row, time, text] = await Promise.all([second.boundingBox(), stamp.boundingBox(), second.locator('.txt').boundingBox()]);
      expect(time!.x).toBeGreaterThanOrEqual(row!.x - 0.5);
      expect(time!.x + time!.width, 'the time ends before the text starts').toBeLessThanOrEqual(text!.x + 0.5);
    }
  } finally {
    await context.close();
  }
});

test('in the thread panel a long source chip wraps to two lines and nothing scrolls sideways at 390', async ({ browser, playwright, isMobile }) => {
  test.skip(!isMobile, 'the phone project');
  const { page, context } = await openPhone(browser, playwright, `/t/engineering/c/${channelName}`);
  try {
    await rowOf(page, replied).getByRole('button', { name: /1 repl/ }).click();
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible();
    // the chips of an Answer in the thread, as the Answer card draws them
    await thread.locator('.rpb').evaluate((el) => {
      const list = document.createElement('ul');
      list.className = 'an-cites';
      list.setAttribute('data-probe', 'chips');
      const long = 'brain (check MVYDWDO2-2) Name every tool you have been given and say what each of them is for in the order you would use them';
      for (const text of [long, 'a short one']) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="an-cite"><span class="an-n">1</span><span class="an-cite-label"></span></span>`;
        li.querySelector('.an-cite-label')!.textContent = text;
        list.append(li);
      }
      el.append(list);
    });
    const chip = thread.locator('[data-probe="chips"] .an-cite').first();
    const label = chip.locator('.an-cite-label');
    const [c, l, panel] = await Promise.all([chip.boundingBox(), label.boundingBox(), thread.boundingBox()]);
    expect(c!.x + c!.width, 'the chip ends inside the panel').toBeLessThanOrEqual(panel!.x + panel!.width + 0.5);
    const lineHeight = await label.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 16);
    expect(l!.height, 'two lines, not one cut line and not three').toBeGreaterThan(lineHeight * 1.5);
    expect(l!.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
    expect(await noSidewaysScroll(page)).toBe(true);
    // the reply box: no part of it scrolls sideways
    const composer = thread.locator('.rpf');
    expect(await composer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await thread.locator('.ctools').first().evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await thread.getByRole('textbox').fill('a reply with a very long unbroken line https://example.com/runbooks/rollback/2026/09/very/long/path/that/would/overflow/the/box');
    expect(await composer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('the bot page header at 390: the name, its description, then one row of actions; the roster count stacks under the title', async ({ browser, playwright, isMobile }) => {
  test.skip(!isMobile, 'the phone project');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/release-manager', { viewport: PHONE, mobile: true });
  try {
    const head = page.locator('[data-landmark="bot-head"]');
    await expect(head).toBeVisible();
    await expect(page.getByTestId('open-conversation')).toBeVisible();
    await expect(page.getByTestId('bot-more')).toBeVisible();
    const parts = await page.evaluate(() => {
      const rect = (sel: string): [number, number, number, number] => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      };
      return { avatar: rect('[data-landmark="bot-head"] > .av, [data-landmark="bot-head"] > .av-wrap'), title: rect('[data-testid="bot-title"]'), desc: rect('[data-testid="bot-head-runtime"]'), actions: rect('[data-testid="bot-head-actions"]'), more: rect('[data-testid="bot-more"]'), tabs: rect('[data-landmark="bot-tabs"]') };
    });
    const hit = (a: number[], b: number[]): boolean => !(a[2]! <= b[0]! || a[0]! >= b[2]! || a[3]! <= b[1]! || a[1]! >= b[3]!);
    expect(hit(parts.actions, parts.title), 'the actions are under the title').toBe(false);
    expect(hit(parts.actions, parts.desc)).toBe(false);
    expect(hit(parts.actions, parts.avatar)).toBe(false);
    expect(hit(parts.more, parts.actions)).toBe(false);
    expect(Math.abs(parts.more[1]! - parts.actions[1]!), 'Talk, Deploy and "…" share one row').toBeLessThan(8);
    expect(parts.actions[1]!).toBeGreaterThanOrEqual(parts.desc[3]! - 0.5);
    expect(parts.tabs[1]!).toBeGreaterThanOrEqual(parts.actions[3]! - 0.5);
    expect(parts.more[2]!).toBeLessThanOrEqual(PHONE.width);
    expect(await noSidewaysScroll(page)).toBe(true);
    // the menu is not cut off by the row of actions
    await page.getByTestId('bot-more').click();
    await expect(page.getByRole('menu', { name: 'More actions' })).toBeVisible();
    await expect(page.getByRole('menu', { name: 'More actions' })).toBeInViewport();
    await page.keyboard.press('Escape');

    // the roster: the count line is under the title
    await page.goto('/t/engineering/bots');
    const title = await page.locator('[data-landmark="page-header"] [data-landmark="title"]').boundingBox();
    const count = await page.getByTestId('roster-count').boundingBox();
    expect(count!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 0.5);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await (context as BrowserContext).close();
  }
});
