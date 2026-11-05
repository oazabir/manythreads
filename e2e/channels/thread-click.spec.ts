import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

// the desktop layout (side panel); the phone has its own case in mobile-web
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/** P21-26: clicking a message that has a thread opens it on the side; clicking its controls, links, chips or a selection does not. */
const panelUrl = (rootId: string): RegExp => new RegExp(`panel=thread(%3A|:)${rootId}`);
const historyLength = (page: Page): Promise<number> => page.evaluate(() => window.history.length);

async function expectNoPanel(page: Page): Promise<void> {
  await expect(page.getByTestId('thread-view')).toHaveCount(0);
  expect(page.url()).not.toContain('panel=');
}

async function closePanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByTestId('thread-view')).toHaveCount(0);
}

/** The box around a row's text, so a mouse can press at its start and release at its end. */
async function textBox(text: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  return text.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
}

test('click the body of a message with replies to open its thread; controls, links, chips and selections leave it shut', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'thread-click');
  const withThread = await postMessage(nadiaApi, id, 'Release plan: read https://example.com/plan with @rafi before Friday please');
  await postMessage(nadiaApi, id, 'First reply in the thread', withThread.id);
  await postMessage(nadiaApi, id, 'Second reply in the thread', withThread.id);
  await nadiaApi.post(`/api/channels/${id}/messages/${withThread.id}/reactions`, { emoji: '👍' });
  const plain = await postMessage(nadiaApi, id, 'A message nobody has answered yet');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  const content = page.locator('[data-landmark="content"]');
  const row = content.locator(`[data-message-id="${withThread.id}"]`);
  const plainRow = content.locator(`[data-message-id="${plain.id}"]`);
  try {
    await expect(messages(content)).toHaveCount(2);
    await expect(row.getByRole('button', { name: '2 replies' })).toBeVisible();

    // controls and parts that are something else: nothing opens
    const link = row.getByRole('link', { name: 'https://example.com/plan' });
    await link.evaluate((a) => a.addEventListener('click', (e) => e.preventDefault())); // no new tab; the click still reaches the row
    await link.click();
    await expectNoPanel(page);
    await row.locator('.m').first().click();
    await expectNoPanel(page);
    await row.locator('.rx').first().click(); // toggles the reaction; the row is not a thread click
    await expectNoPanel(page);
    await row.locator('.who b').click();
    await expectNoPanel(page);
    await page.keyboard.press('Escape');
    await expectNoPanel(page);

    // a modified click is the person's own (open in a tab, extend a selection)
    await row.locator('.txt').first().click({ modifiers: ['Shift'], position: { x: 4, y: 4 } });
    await expectNoPanel(page);

    // drag-selecting text inside the row does not open it
    const box = await textBox(row.locator('.txt').first());
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 60), box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
    await expectNoPanel(page);
    // clear the selection (a click on the plain row would toggle its tap bar, which is checked below)
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // a double click selects a word. The browser sends click detail=1 first, so that first click may open the thread (accepted); never more than once
    const before = await historyLength(page);
    await row.locator('.txt').first().dblclick({ position: { x: 6, y: 6 } });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
    expect(await historyLength(page)).toBeLessThanOrEqual(before + 1);
    if (page.url().includes('panel=')) await closePanel(page);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    // a plain click on the body opens the thread beside the channel
    await row.locator('.txt').first().click({ position: { x: 6, y: 6 } });
    await expect(page.getByTestId('thread-view')).toHaveAttribute('data-root-id', withThread.id);
    await expect(page).toHaveURL(panelUrl(withThread.id));
    await expect(page.getByTestId('thread-view')).toContainText('Second reply in the thread');
    await expect(messages(content)).toHaveCount(2); // the channel stayed

    // the same click again changes nothing: same URL, no new history entry
    const url = page.url();
    const length = await historyLength(page);
    await row.locator('.txt').first().click({ position: { x: 6, y: 6 } });
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    expect(await historyLength(page)).toBe(length);
    await expect(page.getByTestId('thread-view')).toHaveAttribute('data-root-id', withThread.id);
    // the click did not open the tap bar either (that belongs to a message without a thread)
    await expect(row).not.toHaveClass(/tapped/);
    await closePanel(page);

    // a message without replies opens nothing; its click toggles the tap bar as before
    await plainRow.locator('.txt').click({ position: { x: 6, y: 6 } });
    await expectNoPanel(page);
    await expect(plainRow).toHaveClass(/tapped/);
    await plainRow.locator('.txt').click({ position: { x: 6, y: 6 } });
    await expect(plainRow).not.toHaveClass(/tapped/);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

test('the row opens its thread with Enter when it has focus, and not from the toolbar or the editor', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const rafiApi = await apiAs('rafi');
  const { id, name } = await createChannel(omar, 'thread-click-key');
  const mine = await postMessage(rafiApi, id, 'My own note that has an answer');
  await postMessage(nadiaApi, id, 'An answer', mine.id);
  const other = await postMessage(nadiaApi, id, 'Nobody replied to this one');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  const content = page.locator('[data-landmark="content"]');
  const row = content.locator(`[data-message-id="${mine.id}"]`);
  try {
    await expect(messages(content)).toHaveCount(2);
    // Enter on a row without replies does nothing
    await content.locator(`[data-message-id="${other.id}"]`).focus();
    await page.keyboard.press('Enter');
    await expectNoPanel(page);

    // Enter on the focused row opens its thread
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('thread-view')).toHaveAttribute('data-root-id', mine.id);
    await expect(page).toHaveURL(panelUrl(mine.id));
    await closePanel(page);

    // while the message is being edited, a click in the editor opens nothing, and Enter belongs to the editor
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const editor = row.getByRole('textbox', { name: 'Edit message' });
    await expect(editor).toBeVisible();
    await editor.click();
    await expectNoPanel(page);
    await row.locator('.txt, .edit-box').first().click({ position: { x: 2, y: 2 } });
    await expectNoPanel(page);
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expectNoPanel(page);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
    await rafiApi.ctx.dispose();
  }
});
