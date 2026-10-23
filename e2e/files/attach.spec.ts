import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs } from '../channels/support.ts';

test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone composer is covered by e2e/channels/mobile-web.spec.ts');

/**
 * PLAN section 4, `e2e/files/attach.spec.ts` and criterion 7 (browser half): a PDF, a PNG and an 80 MB file are chosen in the composer, so
 * two uploads finish and one is refused as "Too large (50 MB)" before a byte is sent; the message draws the PDF as a card and the picture
 * as a picture, and both download the same bytes. (The server half, 403 for Lena without a grant, is e2e/api/files/attach-acl.spec.ts.)
 */
test('a PDF and a PNG upload, an 80 MB file is refused in the box, and both download the same bytes', async ({ browser }, testInfo) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'attach');
  const probe = await omar.ctx.get(`/api/channels/${id}/files?limit=1`);
  test.skip(probe.status() === 404, 'no files service on this server');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const { page } = rafi;
  try {
    const pdf = Buffer.from('%PDF-1.4\n%quarterly report\n'.repeat(400));
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a tiny picture'.repeat(50))]);
    const big = testInfo.outputPath('big.zip');
    writeFileSync(big, Buffer.alloc(80 * 1024 * 1024));
    await page.locator('input[type=file]').setInputFiles([
      { name: 'report.pdf', mimeType: 'application/pdf', buffer: pdf },
      { name: 'photo.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.locator('input[type=file]').setInputFiles(big);
    const uploads = page.getByTestId('upload');
    await expect(uploads).toHaveCount(3);
    await expect(uploads.filter({ hasText: 'report.pdf' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
    await expect(uploads.filter({ hasText: 'photo.png' })).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
    await expect(uploads.filter({ hasText: 'big.zip' })).toHaveAttribute('data-status', 'error');
    await expect(uploads.filter({ hasText: 'big.zip' }).getByRole('alert')).toHaveText('Too large (50 MB)');
    await expect(page.locator('[data-testid="upload"][data-status="done"]')).toHaveCount(2); // two upload, one error
    await page.getByRole('button', { name: 'Remove big.zip' }).click();

    await page.getByRole('textbox', { name: `Message #${name}` }).fill('The report and the screenshot');
    await page.getByRole('button', { name: 'Send' }).click();
    // the PDF stays a card; the picture is drawn on the message itself, not as a card
    const sent = messages(page).first();
    const cards = sent.getByTestId('attachment');
    await expect(cards).toHaveCount(1);
    await expect(cards.filter({ hasText: 'report.pdf' })).toContainText('KB');
    const pictures = sent.getByTestId('message-image');
    await expect(pictures).toHaveCount(1);

    // the card downloads its file…
    const cardHref = (await cards.filter({ hasText: 'report.pdf' }).getAttribute('href')) ?? '';
    const cardRes = await page.request.get(cardHref);
    expect(cardRes.status(), 'report.pdf').toBe(200);
    expect((await cardRes.body()).equals(pdf), 'report.pdf downloads as the bytes that went up').toBe(true);

    // …and the picture does, from the full view a press opens
    await pictures.first().click();
    const pictureHref = (await page.getByTestId('image-download').getAttribute('href')) ?? '';
    const pictureRes = await page.request.get(pictureHref);
    expect(pictureRes.status(), 'photo.png').toBe(200);
    expect((await pictureRes.body()).equals(png), 'photo.png downloads as the bytes that went up').toBe(true);
  } finally {
    await rafi.context.close();
    await omar.ctx.dispose();
  }
});
