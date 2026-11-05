import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, openOn, postAs, type StackApi } from '../support/stack-browser.ts';
import { apiAs, bulkMessages, createChannel, messages, openAs, postMessage, uniqueName } from './support.ts';

/*
 * P21-01 / P21-03: messages by one author close together are a run (one avatar, one name; the time shows in the gutter on hover or tap); a reaction or a
 * reply under a message ends the run; a long text is cut to four lines with "Show more" (kept open for the tab); the reply count carries the avatars of
 * the people who replied, the time of the last reply and a dot while there is something unread; an @bot chip has the bot's tone. Desktop and phone width.
 */
test.use({ actionTimeout: 10_000 });

const T = { timeout: 15_000 };
const FULL_STAMP = /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}( \d{4})?, \d{2}:\d{2}$/;
const content = (page: Page): Locator => page.locator('[data-landmark="content"]');
const rowOf = (page: Page, id: string): Locator => content(page).locator(`[data-message-id="${id}"]`);

test('three quick messages by one person are one run: one avatar, one visible name, the time in the gutter on hover or tap', async ({ browser, isMobile }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'runs');
  const tag = uniqueName('run');
  const a = await postMessage(nadiaApi, id, `${tag} one`);
  const b = await postMessage(nadiaApi, id, `${tag} two`);
  const c = await postMessage(nadiaApi, id, `${tag} three`);
  const rafiApi = await apiAs('rafi');
  const d = await postMessage(rafiApi, id, `${tag} four, someone else`);
  const viewer = await openAs(browser, 'rafi', `/t/engineering/c/${name}`, isMobile ? { width: 390, height: 844 } : undefined, isMobile);
  const { page } = viewer;
  try {
    await expect(messages(content(page))).toHaveCount(4, T);
    // one avatar and one drawn name for the three; the others have the name only for screen readers
    await expect(rowOf(page, a.id).locator('.av')).toHaveCount(1);
    await expect(rowOf(page, a.id).locator('.who b')).toBeVisible();
    for (const m of [b, c]) {
      await expect(rowOf(page, m.id)).toHaveClass(/\brun\b/);
      await expect(rowOf(page, m.id).locator('.av')).toHaveCount(0);
      await expect(rowOf(page, m.id).locator('.who b')).toHaveClass(/sr-only/);
      await expect(rowOf(page, m.id).locator('.who b')).toHaveText('Nadia');
    }
    // another author starts a run of their own
    await expect(rowOf(page, d.id)).not.toHaveClass(/\brun\b/);
    await expect(rowOf(page, d.id).locator('.av')).toHaveCount(1);
    await expect(content(page).locator('.msg .av')).toHaveCount(2);

    // the header time of the first row has the full date as its tooltip
    await expect(rowOf(page, a.id).locator('.who time')).toHaveAttribute('title', FULL_STAMP);

    // the gutter time: hidden at rest, shown on hover (desktop) or after a tap (phone); its tooltip is the full date and time
    const gutter = rowOf(page, b.id).locator('.run-time');
    await expect(gutter).toHaveCSS('opacity', '0');
    await expect(gutter).toHaveAttribute('title', FULL_STAMP);
    await expect(gutter).toHaveText(/^\d{2}:\d{2}$/);
    if (isMobile) await rowOf(page, b.id).locator('.txt').click({ position: { x: 4, y: 4 } });
    else await rowOf(page, b.id).hover();
    await expect(gutter).toHaveCSS('opacity', '1');
    // the first row's header time is the same text as its tooltip's time
    const first = await rowOf(page, a.id).locator('.who time').innerText();
    expect(await rowOf(page, a.id).locator('.who time').getAttribute('title')).toMatch(new RegExp(`, ${first}$`));
  } finally {
    await viewer.context.close();
  }
});

test('a reaction on the middle message ends the run: the next message gets its avatar and name again', async ({ browser, isMobile }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'runsplit');
  const tag = uniqueName('split');
  const a = await postMessage(nadiaApi, id, `${tag} one`);
  const b = await postMessage(nadiaApi, id, `${tag} two`);
  const c = await postMessage(nadiaApi, id, `${tag} three`);
  const viewer = await openAs(browser, 'rafi', `/t/engineering/c/${name}`, isMobile ? { width: 390, height: 844 } : undefined, isMobile);
  const { page } = viewer;
  try {
    await expect(messages(content(page))).toHaveCount(3, T);
    await expect(content(page).locator('.msg .av')).toHaveCount(1);
    // live: the reaction arrives by push, the list redraws without a reload
    await nadiaApi.post(`/api/channels/${id}/messages/${b.id}/reactions`, { emoji: '👍' });
    await expect(rowOf(page, b.id).locator('.rx:not(.rx-add)')).toHaveCount(1, T);
    await expect(rowOf(page, b.id)).toHaveClass(/\brun\b/); // two still continues one: the reaction is under two, not one
    await expect(rowOf(page, c.id)).not.toHaveClass(/\brun\b/);
    await expect(rowOf(page, c.id).locator('.av')).toHaveCount(1);
    await expect(rowOf(page, c.id).locator('.who b')).toBeVisible();
    await expect(rowOf(page, c.id).locator('.who b')).not.toHaveClass(/sr-only/);
    await expect(rowOf(page, a.id).locator('.av')).toHaveCount(1);
  } finally {
    await viewer.context.close();
  }
});

test('a long text is cut with Show more; Show more opens the text, not the thread, and the text stays open after scrolling away and back', async ({ browser, isMobile }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const rafiApi = await apiAs('rafi');
  const { id, name } = await createChannel(omar, 'clamp');
  const tag = uniqueName('long');
  const body = [`${tag} starts here`, ...Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of a long note about the release plan.`)].join('\n\n');
  const short = await postMessage(nadiaApi, id, `${tag} short and sweet`);
  const long = await postMessage(nadiaApi, id, body);
  await postMessage(rafiApi, id, `${tag} a reply that makes the long message a thread`, long.id);
  await bulkMessages(omar, id, 90);
  const viewer = await openAs(browser, 'nadia', `/t/engineering/c/${name}`, isMobile ? { width: 390, height: 844 } : undefined, isMobile);
  const { page } = viewer;
  const list = page.locator('.vlist');
  try {
    await expect(messages(content(page)).last()).toContainText('bulk 90', T);
    const row = rowOf(page, long.id);
    // the oldest page loads while the list is at the top, so keep asking for the top until the row is drawn (flaky on the phone otherwise)
    await expect(async () => {
      await list.evaluate((el) => { el.scrollTop = 0; });
      await expect(row).toBeVisible({ timeout: 1500 });
    }).toPass(T);
    await expect(rowOf(page, short.id).locator('.show-more')).toHaveCount(0);
    await expect(row.locator('.txt')).toHaveClass(/\bclamp\b/);
    const clampedHeight = (await row.locator('.txt').boundingBox())!.height;
    expect(clampedHeight).toBeLessThan(5 * 21 + 4);
    const showMore = row.getByRole('button', { name: 'Show more' });
    await expect(showMore).toBeVisible();

    await showMore.click();
    await expect(row.locator('.txt')).not.toHaveClass(/\bclamp\b/);
    await expect(showMore).toHaveCount(0);
    expect((await row.locator('.txt').boundingBox())!.height).toBeGreaterThan(clampedHeight * 2);
    // the text opened; the thread did not
    await expect(page.getByTestId('thread-view')).toHaveCount(0);
    expect(page.url()).not.toContain('panel=');

    // away and back: the row is drawn again and is still whole
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(row).toHaveCount(0, T);
    await expect(async () => {
      await list.evaluate((el) => { el.scrollTop = 0; });
      await expect(row).toBeVisible({ timeout: 1500 });
    }).toPass(T);
    await expect(row.locator('.txt')).not.toHaveClass(/\bclamp\b/);
    await expect(row.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  } finally {
    await viewer.context.close();
  }
});

test('the reply count shows who replied, when, and a dot until the thread is opened', async ({ browser, isMobile }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const rafiApi = await apiAs('rafi');
  const priyaApi = await apiAs('priya');
  const { id, name } = await createChannel(omar, 'replyprev');
  const tag = uniqueName('rp');
  const root = await postMessage(nadiaApi, id, `${tag} root`);
  await postMessage(rafiApi, id, `${tag} first reply`, root.id);
  await postMessage(priyaApi, id, `${tag} second reply`, root.id);
  const viewer = await openAs(browser, 'nadia', `/t/engineering/c/${name}`, isMobile ? { width: 390, height: 844 } : undefined, isMobile);
  const { page } = viewer;
  try {
    const row = rowOf(page, root.id);
    const replies = row.locator('button.replies');
    await expect(replies).toBeVisible(T);
    await expect(replies).toContainText('2 replies');
    await expect(replies).toContainText(/Last reply (just now|\d+m ago|\d+h ago)/);
    await expect(replies.locator('.rp-avs .av')).toHaveCount(2);
    await expect(replies.locator('.rp-unread')).toHaveCount(1);
    await expect(replies.locator('.rp-unread .sr-only')).toHaveText('unread');

    // a live reply: its author joins the avatars (newest first), the count grows
    await postMessage(omar, id, `${tag} third reply`, root.id);
    await expect(replies).toContainText('3 replies', T);
    await expect(replies.locator('.rp-avs .av')).toHaveCount(3);

    // opening the thread reads it: the dot goes
    await replies.click();
    await expect(page.getByTestId('thread-view')).toBeVisible(T);
    await expect(replies.locator('.rp-unread')).toHaveCount(0, T);
    await expect(replies).toContainText('3 replies');
  } finally {
    await viewer.context.close();
  }
});

test.describe('bot chip (a stack with the seeded coder bot)', () => {
  let stack: Stack;
  let nadia: StackApi;
  let dev = '';
  test.beforeAll(async ({ playwright }) => {
    stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
    nadia = await apiOn(playwright, stack, 'nadia');
    dev = (await channelsOf(nadia))['dev']!;
  });
  test.afterAll(async () => {
    await nadia?.ctx.dispose();
    await stack?.stop();
  });

  test('an @mention of a bot has the bot tone; an @mention of a person and @channel keep the person tone', async ({ browser, playwright, isMobile }) => {
    const tag = uniqueName('chip');
    const m = await postAs(nadia, dev, `${tag} ask @coder and tell @rafi, cc @channel`);
    const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev', isMobile ? { viewport: PHONE, mobile: true } : {});
    try {
      const row = page.locator(`[data-message-id="${m.id}"]`);
      const bot = row.locator('.m[data-mention="coder"]');
      await expect(bot).toBeVisible(T);
      await expect(bot).toHaveClass(/\bm-bot\b/, T);
      await expect(row.locator('.m[data-mention="rafi"]')).not.toHaveClass(/\bm-bot\b/);
      await expect(row.locator('.m[data-mention="channel"]')).not.toHaveClass(/\bm-bot\b/);
      // the two tones differ
      const look = (loc: Locator): Promise<string> => loc.evaluate((el) => `${getComputedStyle(el).color}|${getComputedStyle(el).backgroundColor}`);
      expect(await look(bot)).not.toBe(await look(row.locator('.m[data-mention="rafi"]')));
    } finally {
      await context.close();
    }
  });
});
