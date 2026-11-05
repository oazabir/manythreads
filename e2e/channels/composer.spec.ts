import { writeFileSync } from 'node:fs';
import { expect, test, type Locator } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

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
    // the text is lost with it, so it asks first; "Keep it" brings the row back as it was
    await expect(pending).toContainText('Its text is lost');
    await pending.getByRole('button', { name: 'Keep it' }).click();
    await expect(pending).toContainText('Not sent');
    await pending.getByRole('button', { name: 'Discard' }).click();
    await pending.getByRole('button', { name: 'Yes, discard' }).click();
    await expect(pending).toHaveCount(0);
    await expect(messages(page)).toHaveCount(1);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});

test('attachments: upload with progress, a card for a file or a preview for a picture, remove, and "Too large (50 MB)"', async ({ browser }, testInfo) => {
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

    // pictures only: they go without text, drawn as previews in a grid rather than as file cards
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type=file]').setInputFiles([
      { name: 'photo.png', mimeType: 'image/png', buffer: png },
      { name: 'diagram.png', mimeType: 'image/png', buffer: png },
    ]);
    await expect(uploads).toHaveCount(2);
    await expect(uploads.filter({ hasText: 'photo.png' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
    await expect(uploads.filter({ hasText: 'diagram.png' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });

    // each image shows its own small preview in the box, and the picture is really decoded there
    const thumbs = uploads.locator('img.cfile-preview');
    await expect(thumbs).toHaveCount(2);
    expect(await thumbs.first().evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(messages(page)).toHaveCount(2);
    const pictures = messages(page).nth(1);
    await expect(pictures.getByTestId('attachment')).toHaveCount(0);
    const grid = pictures.getByTestId('message-images');
    await expect(grid).toHaveAttribute('data-layout', 'grid');
    await expect(pictures.getByTestId('message-image')).toHaveCount(2);
    await expect(pictures.getByTestId('message-image').first().getByRole('img')).toHaveAttribute('alt', 'photo.png');

    // a press opens the full picture on a scrim, with its download in the corner
    await pictures.getByTestId('message-image').first().click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('img')).toHaveAttribute('alt', 'photo.png');
    const download = lightbox.getByTestId('image-download');
    await expect(download).toHaveAttribute('download', 'photo.png');
    const got = await page.request.get((await download.getAttribute('href')) ?? '');
    expect(got.status()).toBe(200);
    expect((await got.body()).equals(png)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});

/** P21-28: the message box rests two lines tall (46 px), in a channel and in a thread, and grows with the text to 376 px, then scrolls. */
test('the message box rests two lines tall and stops growing at 376 px', async ({ browser }) => {
  const omar = await apiAs('omar');
  const nadiaApi = await apiAs('nadia');
  const { id, name } = await createChannel(omar, 'compose-height');
  const root = await postMessage(nadiaApi, id, 'A message with a thread to reply in');
  await postMessage(nadiaApi, id, 'A reply', root.id);
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  const heightOf = async (box: Locator): Promise<number> => (await box.boundingBox())!.height;
  try {
    const box = page.getByRole('textbox', { name: `Message #${name}` });
    await expect(box).toBeVisible();
    expect(await heightOf(box)).toBeGreaterThanOrEqual(44);
    expect(await heightOf(box)).toBeLessThanOrEqual(60);
    // the same box in a thread
    await page.locator(`[data-message-id="${root.id}"]`).getByRole('button', { name: '1 reply' }).click();
    const reply = page.getByTestId('thread-view').getByRole('textbox', { name: 'Reply in thread' });
    await expect(reply).toBeVisible();
    expect(await heightOf(reply)).toBeGreaterThanOrEqual(44);
    expect(await heightOf(reply)).toBeLessThanOrEqual(60);
    // resting size does not change on focus
    const resting = await heightOf(box);
    await box.focus();
    expect(await heightOf(box)).toBe(resting);
    // thirty lines: it grew, and stops at 376 px (the text scrolls inside)
    await box.fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
    await expect.poll(() => heightOf(box)).toBeGreaterThan(resting + 100);
    expect(await heightOf(box)).toBeLessThanOrEqual(376);
    expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await box.fill('');
    await expect.poll(() => heightOf(box)).toBe(resting);
    // the thread's box has no "Also send to" tick under or over it
    await expect(page.getByTestId('thread-view').getByTestId('also-to-channel')).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});
