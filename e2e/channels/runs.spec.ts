import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/*
 * Message runs (P21-01, P21-24): what a run is and where it ends, on a stack of its own with seed v21 (`#polish` holds a run of twelve by Nadia).
 *  - twelve short messages by one person inside five minutes: one avatar and one name, eleven continued rows of the same height, shorter than the head row;
 *  - the five-minute rule: exactly five minutes still joins, five minutes and a second does not; another author always starts a new run;
 *  - the "New" line splits a run: the first unread message gets its avatar and name again, the ones after it join it;
 *  - the time of a continued row shows on hover.
 * Times are set in the database (the owner), so the rule is tested at its edge without waiting five minutes. Esc on the list and in a menu is covered by
 * hover-bar.spec.ts (its fifth test).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone has message-runs.spec.ts');
test.use({ actionTimeout: 10_000 });
test.setTimeout(120_000);

const T = { timeout: 15_000 };
let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(240_000); // the web client is built and the stack is seeded first: slow on a busy machine
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'polish' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
});
test.afterAll(async () => {
  for (const api of [omar, nadia, rafi]) await api?.ctx.dispose();
  await stack?.stop();
});

const content = (page: Page): Locator => page.locator('[data-landmark="content"]');
const rowOf = (page: Page, id: string): Locator => content(page).locator(`[data-message-id="${id}"]`);
const isRun = async (page: Page, id: string): Promise<boolean> => ((await rowOf(page, id).getAttribute('class')) ?? '').split(/\s+/).includes('run');

/** A channel with messages at fixed times: yesterday at 12:00 UTC plus the given offsets in seconds, each by its author. */
async function channelWith(name: string, plan: Array<{ by: StackApi; at: number }>): Promise<{ name: string; ids: string[] }> {
  const created = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name });
  const base = new Date();
  base.setUTCDate(base.getUTCDate() - 1);
  base.setUTCHours(12, 0, 0, 0);
  const ids: string[] = [];
  for (const [i, step] of plan.entries()) ids.push((await postAs(step.by, created.channel.id, `${name} message ${i + 1}`)).id);
  // the row's trigger keeps a message's time fixed for every caller but the system role: the owner lifts it for these statements
  await stack.sql('ALTER TABLE app.messages DISABLE TRIGGER messages_before_update');
  try {
    for (const [i, step] of plan.entries()) {
      await stack.sql('UPDATE app.messages SET created_at = $2 WHERE id = $1', [ids[i], new Date(base.getTime() + step.at * 1000).toISOString()]);
    }
  } finally {
    await stack.sql('ALTER TABLE app.messages ENABLE TRIGGER messages_before_update');
  }
  return { name, ids };
}

test('seed v21: twelve short messages by one person are one run, the continued rows are shorter than the head and all the same, and the time shows on hover', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/polish');
  try {
    const first = page.getByTestId('message').filter({ hasText: 'Morning. I looked at the deploy checklist.' }).first();
    await first.scrollIntoViewIfNeeded();
    await expect(first.locator('.av')).toHaveCount(1, T);
    const rows = content(page).locator('[data-testid="message"].run');
    await expect(rows).toHaveCount(11, T);
    await expect(rows.locator('.av')).toHaveCount(0);
    const head = (await first.boundingBox())?.height ?? 0;
    const heights = await rows.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(heights).size, `the continued rows have one height (${heights.join(', ')})`).toBe(1);
    expect(heights[0] ?? 0, 'a continued row is shorter than the head row').toBeLessThan(head);
    // the time: hidden at rest, shown on hover
    const second = rows.first();
    await expect(second.locator('.run-time')).toHaveCSS('opacity', '0');
    await second.hover();
    await expect(second.locator('.run-time')).toHaveCSS('opacity', '1');
  } finally {
    await context.close();
  }
});

test('the five-minute rule: exactly five minutes joins, one second more does not, another author never joins', async ({ browser, playwright }) => {
  const c = await channelWith('rule-edge', [
    { by: nadia, at: 0 },
    { by: nadia, at: 300 }, // exactly five minutes after the first: joins
    { by: nadia, at: 601 }, // five minutes and one second after the second: a new run
    { by: nadia, at: 630 }, // joins the new run
    { by: rafi, at: 660 }, // another author: a new run, even a half minute later
    { by: nadia, at: 690 }, // back to Nadia: not a continuation of Rafi's
  ]);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${c.name}`);
  try {
    await expect(content(page).locator('[data-testid="message"]')).toHaveCount(6, T);
    const runs = await Promise.all(c.ids.map((id) => isRun(page, id)));
    expect(runs, 'which rows continue the one above').toEqual([false, true, false, true, false, false]);
    // one avatar for each run head
    await expect(content(page).locator('[data-testid="message"] .av')).toHaveCount(4);
  } finally {
    await context.close();
  }
});

test('a run of five: one avatar, one name, four continued rows', async ({ browser, playwright }) => {
  const c = await channelWith('run-five', [0, 60, 120, 180, 240].map((at) => ({ by: nadia, at })));
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${c.name}`);
  try {
    await expect(content(page).locator('[data-testid="message"]')).toHaveCount(5, T);
    await expect(content(page).locator('[data-testid="message"] .av')).toHaveCount(1);
    await expect(content(page).locator('[data-testid="message"].run')).toHaveCount(4);
    expect(await Promise.all(c.ids.map((id) => isRun(page, id)))).toEqual([false, true, true, true, true]);
  } finally {
    await context.close();
  }
});

test('the "New" line inside a run: the first unread message gets its avatar and name again and the next ones join it', async ({ browser, playwright }) => {
  const c = await channelWith('run-new', [0, 20, 40, 60].map((at) => ({ by: nadia, at })));
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/c/${c.name}`);
  try {
    await expect(content(page).locator('[data-testid="message"]')).toHaveCount(4, T);
    // read through the end of the channel and later mark the third message unread: the line goes above it
    expect(await Promise.all(c.ids.map((id) => isRun(page, id)))).toEqual([false, true, true, true]);
    const third = rowOf(page, c.ids[2]!);
    await third.hover();
    await third.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    // the channel opened with all four unread, so the line was above the first message; it moves down to the third
    const order = (): Promise<Array<string | null>> => page.locator('.vlist [data-testid="unread-divider"], .vlist [data-testid="message"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    await expect.poll(order, T).toEqual(['message', 'message', 'unread-divider', 'message', 'message']);
    await expect(page.getByTestId('unread-divider')).toHaveCount(1);
    expect(await Promise.all(c.ids.map((id) => isRun(page, id)))).toEqual([false, true, false, true]);
    await expect(rowOf(page, c.ids[2]!).locator('.av')).toHaveCount(1);
    await expect(rowOf(page, c.ids[3]!).locator('.av')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
