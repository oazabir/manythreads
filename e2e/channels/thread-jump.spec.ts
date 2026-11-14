import { expect, test, type Locator } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

// the desktop layout: the thread in the right panel beside the channel
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/** How far the reply list is from its bottom, in px. */
const distance = (list: Locator): Promise<number> => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
const scrollUp = (list: Locator): Promise<void> => list.evaluate((el) => { el.scrollTop = 0; });
const scrollDown = (list: Locator): Promise<void> => list.evaluate((el) => { el.scrollTop = el.scrollHeight; });

/**
 * Scrolls the reply list to the top and waits for that scroll's own event (and a frame) to land. A store update that renders between the
 * jump and its event re-pins a list that was at the bottom (the panel's pin effect), so the jump is tried again until it holds.
 */
async function leaveBottom(list: Locator): Promise<void> {
  await expect(async () => {
    const d = await list.evaluate(
      (el) =>
        new Promise<number>((resolve) => {
          const left = (): number => el.scrollHeight - el.scrollTop - el.clientHeight;
          if (el.scrollTop === 0) return resolve(left());
          el.addEventListener('scroll', () => requestAnimationFrame(() => resolve(left())), { once: true });
          el.scrollTop = 0;
        }),
    );
    expect(d).toBeGreaterThan(40);
  }).toPass({ timeout: 10_000 });
}

/** The pill's middle and the reply list's middle, across the reading direction. */
async function centres(pill: Locator, list: Locator): Promise<{ pill: number; list: number }> {
  const [p, l] = await Promise.all([pill.boundingBox(), list.boundingBox()]);
  return { pill: p!.x + p!.width / 2, list: l!.x + l!.width / 2 };
}

test('scrolled up in a thread, "Jump to latest" counts the replies of others and goes back to the newest', async ({ browser }) => {
  const omarApi = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omarApi, 'jump');
  // Omar posts the root, so he follows the thread; Nadia fills it
  const root = await postMessage(omarApi, id, 'Rollout plan for the 2.5 release, replies below.');
  for (let i = 1; i <= 25; i += 1) await postMessage(nadiaApi, id, `Step ${i} of the rollout: check the dashboards and write down what moved.`, root.id);
  const short = await postMessage(omarApi, id, 'A short thread.');
  await postMessage(nadiaApi, id, 'One reply only.', short.id);

  const { page, context } = await openAs(browser, 'omar', `/t/engineering/c/${name}?panel=thread:${root.id}`);
  const panel = page.locator('[data-landmark="right-panel"]');
  const thread = panel.getByTestId('thread-view');
  const list = thread.locator('.rpb');
  const pill = thread.getByTestId('thread-jump-latest');
  try {
    await expect(messages(thread)).toHaveCount(26);
    // at the bottom: no pill
    await expect.poll(() => distance(list)).toBeLessThan(40);
    await expect(pill).toHaveCount(0);

    // scrolled up: "Jump to latest", no count
    await leaveBottom(list);
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('Jump to latest');
    await expect(pill).toHaveAccessibleName('Jump to latest');
    // centred over the reply list, in either direction
    let c = await centres(pill, list);
    expect(Math.abs(c.pill - c.list)).toBeLessThanOrEqual(2);
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    c = await centres(pill, list);
    expect(Math.abs(c.pill - c.list)).toBeLessThanOrEqual(2);
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });

    // two replies from Nadia while Omar reads above: counted, and the list does not move
    await postMessage(nadiaApi, id, 'Dashboards look fine after step 25.', root.id);
    await postMessage(nadiaApi, id, 'Ready to flip the flag.', root.id);
    await expect(messages(thread)).toHaveCount(28);
    await expect(pill).toHaveText('2 new replies');
    await expect(pill).toHaveAccessibleName('Jump to latest, 2 new replies');
    expect(await distance(list)).toBeGreaterThan(40);

    // press: at the newest reply, the pill gone
    await pill.click();
    await expect.poll(() => distance(list)).toBeLessThan(40);
    await expect(pill).toHaveCount(0);
    await expect(list).toBeFocused();

    // up again, one reply: "1 new reply"; scrolling down by hand clears it, and the next time up there is no count
    await leaveBottom(list);
    await expect(pill).toHaveText('Jump to latest');
    await postMessage(nadiaApi, id, 'Flag flipped.', root.id);
    await expect(messages(thread)).toHaveCount(29);
    await expect(pill).toHaveText('1 new reply');
    await scrollDown(list);
    await expect(pill).toHaveCount(0);
    await leaveBottom(list);
    await expect(pill).toHaveText('Jump to latest');

    // Omar's own reply while scrolled up: the list goes to it and the pill goes away
    const box = thread.getByRole('textbox', { name: 'Reply in thread' });
    await box.fill('Thanks, closing this out.');
    await box.press('Enter');
    await expect(messages(thread)).toHaveCount(30);
    await expect(thread.getByTestId('message').last()).toContainText('Thanks, closing this out.');
    await expect.poll(() => distance(list)).toBeLessThan(40);
    await expect(pill).toHaveCount(0);

    // a thread that fits: no pill, even after trying to scroll it
    await page.goto(`/t/engineering/c/${name}?panel=thread:${short.id}`);
    await expect(messages(thread)).toHaveCount(2);
    await expect(thread).toHaveAttribute('data-root-id', short.id);
    await scrollUp(list);
    await expect(pill).toHaveCount(0);
  } finally {
    await context.close();
    await omarApi.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
