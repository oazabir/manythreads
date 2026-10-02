import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs } from './support.ts';

// the desktop layout (hover actions, side panel); the phone layout has its own spec (mobile-web)
test.skip(({ isMobile }) => isMobile, 'desktop layout');

/** The shared composer: toolbar, pickers, per-channel draft, optimistic send with "Not sent · Retry", and attachments. */
test('toolbar, @ and # pickers, and a draft that survives a reload but not a different channel', async ({ browser }) => {
  const omar = await apiAs('omar');
  const a = await createChannel(omar, 'compose');
  const b = await createChannel(omar, 'compose');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${a.name}`);
  const { page } = rafi;
  const box = page.getByRole('textbox', { name: `Message #${a.name}` });
  try {
    await expect(box).toBeVisible();
    // toolbar: bold wraps the selection, the code button wraps a span, the list button starts a bullet
    await box.fill('make this bold');
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 9));
    await page.getByRole('button', { name: 'Bold' }).click();
    await expect(box).toHaveValue('make **this** bold');
    await box.fill('');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await expect(box).toHaveValue('- ');
    await box.fill('');

    // @ opens the people picker (the roster of the team), Enter completes it; # does the same for channels
    await box.pressSequentially('hello @nad');
    const people = page.getByRole('listbox', { name: 'People' });
    await expect(people).toBeVisible();
    await expect(people.getByRole('option')).toHaveCount(1);
    await expect(people.getByRole('option').first()).toContainText('Nadia');
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue('hello @nadia ');
    await expect(messages(page)).toHaveCount(0); // Enter picked the person, it did not send
    await box.pressSequentially(`see #${a.name.slice(0, 7)}`);
    const channels = page.getByRole('listbox', { name: 'Channels' });
    await expect(channels.getByRole('option', { name: new RegExp(`#${a.name}`) })).toBeVisible();
    await page.keyboard.press('Escape'); // closes the picker, nothing else
    await expect(channels).toBeHidden();
    await box.fill('an unsent thought');

    // the draft is kept for this channel: a reload brings it back, the other channel has its own empty box
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.getByRole('textbox', { name: `Message #${a.name}` })).toHaveValue('an unsent thought');
    await page.goto(`/t/engineering/c/${b.name}`);
    await expect(page.getByRole('textbox', { name: `Message #${b.name}` })).toHaveValue('');
    await page.goto(`/t/engineering/c/${a.name}`);
    await expect(page.getByRole('textbox', { name: `Message #${a.name}` })).toHaveValue('an unsent thought');

    // sending clears the draft
    await page.getByRole('textbox', { name: `Message #${a.name}` }).press('Enter');
    await expect(messages(page)).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole('textbox', { name: `Message #${a.name}` })).toHaveValue('');
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});

test('a send that fails stays in place as "Not sent · Retry" and is delivered by Retry', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { name } = await createChannel(omar, 'retry');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  try {
    const box = page.getByRole('textbox', { name: `Message #${name}` });
    await expect(box).toBeVisible();
    await page.route('**/api/channels/*/messages', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()));
    await box.fill('this will not go through at first');
    await box.press('Enter');
    const pending = page.getByTestId('pending-message');
    await expect(pending).toContainText('this will not go through at first');
    await expect(pending).toContainText('Not sent · Retry');
    await expect(messages(page)).toHaveCount(0);

    await page.unroute('**/api/channels/*/messages');
    await pending.getByRole('button', { name: 'Retry' }).click();
    await expect(pending).toHaveCount(0);
    await expect(messages(page)).toHaveCount(1);
    await expect(messages(page).first()).toContainText('this will not go through at first');

    // Discard removes a failed message without sending it
    await page.route('**/api/channels/*/messages', (route) => (route.request().method() === 'POST' ? route.abort('failed') : route.continue()));
    await box.fill('never mind');
    await box.press('Enter');
    await expect(pending).toContainText('Not sent');
    await pending.getByRole('button', { name: 'Discard' }).click();
    await expect(pending).toHaveCount(0);
    await expect(messages(page)).toHaveCount(1);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});

test('attachments: upload with progress, a card on the message, remove, and "Too large (50 MB)"', async ({ browser }, testInfo) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'files');
  // the clip appears only on a server that stores files
  const probe = await omar.ctx.get(`/api/channels/${id}/files?limit=1`);
  test.skip(probe.status() === 404, 'no files service on this server');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  try {
    await expect(page.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    const pdf = Buffer.from('%PDF-1.4\n%notes from the incident review\n'.repeat(500));
    await page.locator('input[type=file]').setInputFiles([
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf },
      { name: 'draft.md', mimeType: 'text/markdown', buffer: Buffer.from('# draft') },
    ]);
    const uploads = page.getByTestId('upload');
    await expect(uploads).toHaveCount(2);
    await expect(uploads.filter({ hasText: 'report.pdf' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
    await expect(uploads.filter({ hasText: 'draft.md' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });

    // remove one before sending
    await page.getByRole('button', { name: 'Remove draft.md' }).click();
    await expect(uploads).toHaveCount(1);

    // a file over the limit (80 MB, as in the plan) is refused in the box with the size error, never uploaded, and can be removed
    const big = testInfo.outputPath('big.zip');
    writeFileSync(big, Buffer.alloc(80 * 1024 * 1024));
    await page.locator('input[type=file]').setInputFiles(big);
    await expect(uploads.filter({ hasText: 'big.zip' })).toContainText('Too large (50 MB)');
    await expect(uploads.filter({ hasText: 'big.zip' })).toHaveAttribute('data-status', 'error');
    await expect(uploads.filter({ hasText: 'big.zip' }).getByRole('alert')).toHaveText('Too large (50 MB)');
    await page.getByRole('button', { name: 'Remove big.zip' }).click();
    await expect(uploads).toHaveCount(1);

    // a bigger file shows a progress bar while it goes up
    await page.evaluate(() => {
      (window as unknown as { __bars: number }).__bars = 0;
      new MutationObserver(() => {
        if (document.querySelector('[role="progressbar"]')) (window as unknown as { __bars: number }).__bars += 1;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const mid = testInfo.outputPath('mid.bin');
    writeFileSync(mid, Buffer.alloc(24 * 1024 * 1024, 7));
    await page.locator('input[type=file]').setInputFiles(mid);
    await expect(uploads.filter({ hasText: 'mid.bin' })).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __bars: number }).__bars)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Remove mid.bin' }).click();

    const box = page.getByRole('textbox', { name: `Message #${name}` });
    await box.fill('Notes from the incident review');
    await box.press('Enter');
    const card = messages(page).first().getByTestId('attachment');
    await expect(card).toContainText('report.pdf');
    await expect(card).toContainText('KB');
    await expect(uploads).toHaveCount(0);

    // the card downloads the same bytes
    const res = await page.request.get((await card.getAttribute('href')) ?? '');
    expect(res.status()).toBe(200);
    expect((await res.body()).equals(pdf)).toBe(true);

    // a file only: it goes without text, and the message carries the file's name
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
    await expect(uploads.filter({ hasText: 'photo.png' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(messages(page)).toHaveCount(2);
    await expect(messages(page).nth(1).getByTestId('attachment')).toContainText('photo.png');
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});
