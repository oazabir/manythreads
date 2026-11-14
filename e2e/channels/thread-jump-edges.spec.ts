import { expect, test, type Locator } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

// Edge cases of the thread panel's "Jump to latest" pill that `thread-jump.spec.ts` leaves out: a reply deleted while the reader is
// scrolled up, an older page from "Earlier replies", and the full-page thread (variant "main"), which has no pill.
test.skip(({ isMobile }) => isMobile, 'desktop layout');

const distance = (list: Locator): Promise<number> => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

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

test('a reply deleted while scrolled up drops out of the count', async ({ browser }) => {
  const omarApi = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omarApi, 'jumpdel');
  const root = await postMessage(omarApi, id, 'Incident notes, replies below.');
  for (let i = 1; i <= 25; i += 1) await postMessage(nadiaApi, id, `Note ${i}: what we saw on the dashboards and what we did about it.`, root.id);

  const { page, context } = await openAs(browser, 'omar', `/t/engineering/c/${name}?panel=thread:${root.id}`);
  const thread = page.locator('[data-landmark="right-panel"]').getByTestId('thread-view');
  const list = thread.locator('.rpb');
  const pill = thread.getByTestId('thread-jump-latest');
  try {
    await expect(messages(thread)).toHaveCount(26);
    await expect.poll(() => distance(list)).toBeLessThan(40);
    await leaveBottom(list);
    await expect(pill).toHaveText('Jump to latest');

    await postMessage(nadiaApi, id, 'One more thing on the cache.', root.id);
    const gone = await postMessage(nadiaApi, id, 'Posted in the wrong thread, sorry.', root.id);
    await expect(pill).toHaveText('2 new replies');

    const del = await nadiaApi.ctx.delete(`/api/channels/${id}/messages/${gone.id}`, { headers: await nadiaApi.headers() });
    expect(del.status()).toBeLessThan(300);
    await expect(pill).toHaveText('1 new reply');
    await expect(pill).toHaveAccessibleName('Jump to latest, 1 new reply');
  } finally {
    await context.close();
    await omarApi.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

test('"Earlier replies" loads an older page without counting it as new', async ({ browser }) => {
  const omarApi = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omarApi, 'jumpold');
  const root = await postMessage(omarApi, id, 'Long thread, more than one page of replies.');
  // the panel loads 50 replies at first; 51 leaves one older reply behind "Earlier replies"
  for (let i = 1; i <= 51; i += 1) await postMessage(nadiaApi, id, `Reply ${i}.`, root.id);

  const { page, context } = await openAs(browser, 'omar', `/t/engineering/c/${name}?panel=thread:${root.id}`);
  const thread = page.locator('[data-landmark="right-panel"]').getByTestId('thread-view');
  const list = thread.locator('.rpb');
  const pill = thread.getByTestId('thread-jump-latest');
  try {
    await expect(messages(thread)).toHaveCount(51);
    await expect.poll(() => distance(list)).toBeLessThan(40);
    await leaveBottom(list);
    await expect(pill).toHaveText('Jump to latest');

    await thread.getByRole('button', { name: 'Earlier replies' }).click();
    await expect(messages(thread)).toHaveCount(52);
    await expect(pill).toHaveText('Jump to latest');

    // a reply that is new after all: counted alone
    await postMessage(nadiaApi, id, 'Reply 52, the newest.', root.id);
    await expect(messages(thread)).toHaveCount(53);
    await expect(pill).toHaveText('1 new reply');
  } finally {
    await context.close();
    await omarApi.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

test('the full-page thread (Threads) has no pill when scrolled up', async ({ browser }) => {
  const omarApi = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id } = await createChannel(omarApi, 'jumpmain');
  const root = await postMessage(omarApi, id, 'Thread read in the Threads screen.');
  for (let i = 1; i <= 25; i += 1) await postMessage(nadiaApi, id, `Line ${i} of a long discussion about the release train and its gates.`, root.id);

  const { page, context } = await openAs(browser, 'omar', `/t/engineering/threads?thread=${root.id}`);
  const thread = page.locator(`[data-testid="thread-view"][data-root-id="${root.id}"]`);
  const list = thread.locator('.rpb');
  try {
    await expect(thread).toHaveClass(/\bmain\b/);
    await expect(messages(thread)).toHaveCount(26);
    await leaveBottom(list);
    await expect.poll(() => distance(list)).toBeGreaterThan(40);
    await postMessage(nadiaApi, id, 'A new line while Omar reads above.', root.id);
    await expect(messages(thread)).toHaveCount(27);
    await expect(page.getByTestId('thread-jump-latest')).toHaveCount(0);
  } finally {
    await context.close();
    await omarApi.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
