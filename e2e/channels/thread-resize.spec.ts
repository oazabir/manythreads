import { expect, test } from '@playwright/test';
import { apiAs, bulkMessages, createChannel, messages, openAs, postMessage } from './support.ts';

// the desktop layout (side panel); the phone sheet is covered in mobile-web
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/**
 * P21-27: an open thread follows the window. Beside the channel while 888 px or wider, filling the area from 761 to 887 px (with a
 * "Back to the channel" arrow), a full sheet from 760 px down; back at its own width when the window is wide again. Nothing is lost on the way.
 */
test('a thread fills the area in a narrow window and goes back to its width when the window is wide again', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'thread-resize');
  await bulkMessages(omar, id, 60);
  const root = await postMessage(nadiaApi, id, 'Which port do we use for the staging gateway?');
  await postMessage(nadiaApi, id, 'Eight four four three.', root.id);

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  const panel = page.locator('[data-landmark="right-panel"]');
  const resizer = page.getByTestId('panel-resizer');
  const expand = page.getByTestId('panel-expand');
  const backToChannel = page.getByTestId('panel-back-channel');
  const thread = panel.getByTestId('thread-view');
  const reply = panel.getByRole('textbox', { name: 'Reply in thread' });
  try {
    await expect(messages(page).last()).toBeVisible();
    await page.locator(`[data-message-id="${root.id}"]`).getByRole('button', { name: '1 reply' }).click();
    await expect(thread).toHaveAttribute('data-root-id', root.id);

    // wide: at the side, with a bar to drag and an Expand button; drag it to 500 px
    await expect(panel).not.toHaveAttribute('data-expanded', /.+/);
    await expect(resizer).toBeVisible();
    await expect(expand).toBeVisible();
    await expect(backToChannel).toHaveCount(0);
    const bar = (await resizer.boundingBox())!;
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 200);
    await page.mouse.down();
    await page.mouse.move(1440 - 500, bar.y + 200, { steps: 8 });
    await page.mouse.up();
    await expect(resizer).toHaveAttribute('aria-valuenow', '500');

    // a draft in the thread, and a mark on the channel's list that survives only if nothing remounts
    await reply.fill('draft that must survive the resizing');
    const list = page.locator('[data-landmark="content"] .vlist');
    await list.evaluate((el) => {
      (el as HTMLElement).dataset['keep'] = 'yes';
      el.scrollTop = Math.max(0, el.scrollTop / 2);
    });
    await page.waitForTimeout(200);
    const top = await list.evaluate((el) => el.scrollTop);
    const threadHandle = await thread.elementHandle();

    // 850 px: the thread fills the area, a Back arrow replaces the bar and the Expand button
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(panel).toHaveAttribute('data-expanded', 'auto');
    await expect(backToChannel).toBeVisible();
    await expect(backToChannel).toHaveAccessibleName('Back to the channel');
    await expect(resizer).toHaveCount(0);
    await expect(expand).toHaveCount(0);
    await expect(reply).toHaveValue('draft that must survive the resizing');
    const box = (await panel.boundingBox())!;
    expect(box.width).toBeGreaterThan(850 - 260); // the area beside the rail, not a 500 px strip

    // 1440 px again: at the side, still 500 px wide, the same draft, the same thread element, the channel where it was
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(panel).not.toHaveAttribute('data-expanded', /.+/);
    await expect(resizer).toBeVisible();
    await expect(resizer).toHaveAttribute('aria-valuenow', '500');
    await expect(backToChannel).toHaveCount(0);
    await expect(reply).toHaveValue('draft that must survive the resizing');
    expect(await threadHandle!.evaluate((el) => el.isConnected)).toBe(true);
    expect(await list.evaluate((el) => (el as HTMLElement).dataset['keep'])).toBe('yes');
    expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(40);

    // 700 px: the phone sheet; widening brings the side panel back with the draft
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(panel).not.toHaveAttribute('data-expanded', 'auto');
    await expect(resizer).toHaveCount(0);
    await expect(thread).toBeVisible();
    expect((await panel.boundingBox())!.width).toBeGreaterThanOrEqual(699);
    await expect(reply).toHaveValue('draft that must survive the resizing');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(resizer).toHaveAttribute('aria-valuenow', '500');
    await expect(reply).toHaveValue('draft that must survive the resizing');

    // Expand at 1440 stays expanded through 850 and back (the person's choice is not undone by the window)
    await expand.click();
    await expect(panel).toHaveAttribute('data-expanded', 'true');
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(panel).toHaveAttribute('data-expanded', 'true');
    await expect(backToChannel).toHaveCount(0);
    await expect(page.getByTestId('panel-expand')).toHaveAccessibleName('Restore');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(panel).toHaveAttribute('data-expanded', 'true');
    await page.getByTestId('panel-expand').click();
    await expect(panel).not.toHaveAttribute('data-expanded', /.+/);
    await expect(resizer).toHaveAttribute('aria-valuenow', '500');

    // at 850 the Back arrow closes a thread that has nothing below it
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(backToChannel).toBeVisible();
    await backToChannel.click();
    await expect(panel).toBeHidden();
    expect(page.url()).not.toContain('panel=');
    await expect(messages(page).last()).toBeVisible();
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

/** The narrow arrow steps back through threads when there are several, and the Back button of a wide window is still just "Back". */
test('at 850 px Back to the channel steps back to the earlier thread; wide, the button is Back', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'thread-resize-two');
  const a = await postMessage(nadiaApi, id, 'First topic: the release notes.');
  const b = await postMessage(nadiaApi, id, 'Second topic: the rollback runbook.');
  await postMessage(nadiaApi, id, 'reply a', a.id);
  await postMessage(nadiaApi, id, 'reply b', b.id);
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  const panel = page.locator('[data-landmark="right-panel"]');
  try {
    await page.locator(`[data-message-id="${a.id}"]`).getByRole('button', { name: '1 reply' }).click();
    await page.locator(`[data-message-id="${b.id}"]`).getByRole('button', { name: '1 reply' }).click();
    await expect(panel.getByTestId('thread-view')).toHaveAttribute('data-root-id', b.id);
    await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(panel.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
    await panel.getByTestId('panel-back-channel').click();
    await expect(panel.getByTestId('thread-view')).toHaveAttribute('data-root-id', a.id);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
