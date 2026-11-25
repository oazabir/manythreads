import { expect, test, type Page } from '@playwright/test';
import { apiAs, createChannel, openAs, postMessage } from './support.ts';

// P18-05 (docs/plans/catch-me-up.md): Nadia opens a channel with unread messages, presses Catch me up, and the Summary panel shows Brain's summary with [n] markers
// that open the message they come from. The model is not called here: the summary route is answered in the browser (page.route) with a summary that cites the
// messages posted for the test, so the spec checks the screen, not a model. The server side (only readable messages, ranges, limits) is
// packages/plugins/channels/test/summary.test.ts.

const T = { timeout: 15_000 };
test.setTimeout(90_000);
// a click that cannot happen fails in seconds and names its step (MISTAKES P3-14), instead of waiting out the test
test.use({ actionTimeout: 10_000, navigationTimeout: 20_000 });

/** Answers the summary route with a fixed summary citing `ids` as [1], [2], ...; records each request body. */
async function stubSummary(page: Page, ids: readonly string[], asked: Array<Record<string, unknown>>): Promise<void> {
  await page.route('**/api/channels/*/summary', async (route) => {
    asked.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'ready',
        range: 'new',
        body: '**Decisions**\n- The release moves to Friday [1]\n\n**Waiting on you**\n- Omar asks you to check the notes [2]',
        sources: ids.map((messageId, i) => ({ n: i + 1, messageId, threadRootId: null })),
        messageCount: ids.length,
        readCount: ids.length,
        leftOut: 0,
        from: new Date(Date.now() - 3600_000).toISOString(),
        to: new Date().toISOString(),
        botName: 'Brain',
      }),
    });
  });
}

test('desktop: Catch me up on a channel with unread messages; a marker opens the message it cites', async ({ browser, isMobile }) => {
  test.skip(isMobile, 'the desktop layout');
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'catchup');
  const nadia = await openAs(browser, 'nadia', '/t/engineering/threads');
  try {
    // Nadia is elsewhere while Omar writes, so the channel opens with unread messages
    await expect(nadia.page.locator('[data-landmark="sidebar"] a.it', { hasText: name })).toBeVisible(T);
    const first = await postMessage(omar, id, 'The release moves to Friday');
    const second = await postMessage(omar, id, '@nadia can you check the release notes?');
    for (let i = 0; i < 3; i += 1) await postMessage(omar, id, `a later note ${i}`);
    const asked: Array<Record<string, unknown>> = [];
    await stubSummary(nadia.page, [first.id, second.id], asked);
    await nadia.page.goto(`/t/engineering/c/${name}`);

    const button = nadia.page.getByTestId('catch-me-up');
    await expect(button).toBeVisible(T);
    await button.click();
    const panel = nadia.page.getByTestId('summary-panel');
    await expect(panel).toBeVisible(T);
    // it starts with "Since I last read" (there was something unread) and sends the position the screen opened with
    await expect(panel.getByTestId('summary-range-new')).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByTestId('summary-body')).toContainText('The release moves to Friday', T);
    expect(asked[0]).toMatchObject({ threadRootId: null, range: 'new' });
    expect('afterMessageId' in (asked[0] ?? {})).toBe(true);
    await expect(panel.getByTestId('summary-coverage')).toContainText('From 2 messages');
    await expect(panel.getByTestId('summary-marker')).toHaveCount(2);
    await expect(panel).toContainText('Only you see this summary');

    // [2] opens Omar's question in the channel, in view
    const marker = panel.getByTestId('summary-marker').nth(1);
    // a marker is a real button, not a 0 px line (a finger has to hit it)
    expect((await marker.boundingBox())!.height).toBeGreaterThan(8);
    await marker.click();
    await expect(nadia.page).toHaveURL(new RegExp(`message=${second.id}`), T);
    const row = nadia.page.locator(`[data-testid="message"][data-message-id="${second.id}"]`);
    await expect(row).toBeInViewport(T);
  } finally {
    await nadia.context.close();
    await omar.ctx.dispose();
  }
});

test('390 px: the Summary panel is a full sheet, its choices wrap, no sideways scroll', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'catchup-phone');
  const first = await postMessage(omar, id, 'A decision for the phone');
  const second = await postMessage(omar, id, 'A question for the phone');
  const nadia = await openAs(browser, 'nadia', '/t/engineering/threads', { width: 390, height: 844 }, true);
  try {
    await stubSummary(nadia.page, [first.id, second.id], []);
    await nadia.page.goto(`/t/engineering/c/${name}`);
    const button = nadia.page.getByTestId('catch-me-up');
    await expect(button).toBeVisible(T);
    await button.click();
    const panel = nadia.page.getByTestId('summary-panel');
    await expect(panel.getByTestId('summary-body')).toBeVisible(T);
    const box = await panel.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(340);
    expect(await nadia.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const ranges = await panel.getByRole('group', { name: 'What to summarise' }).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(ranges).toBeLessThanOrEqual(1);
  } finally {
    await nadia.context.close();
    await omar.ctx.dispose();
  }
});
