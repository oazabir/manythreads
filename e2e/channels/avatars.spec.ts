import { expect, test } from '@playwright/test';
import { apiAs, openAs, type Api } from './support.ts';

/**
 * Profile pictures (PLAN P14-23, docs/plugins/avatars.md). Rafi has no picture, so his account page draws his initials. He chooses a built-in picture
 * from the dialog (it shows at once and is in the roster the others read), uploads a photo (the browser shrinks it; the roster then carries a photo value and
 * the picture is loaded from the photo route), and goes back to the initials. A file that is not a picture is refused in words. His change is seen by Omar.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
// A 1x1 PNG: the browser draws it into a 256-pixel square and saves it again.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let rafi: Api;
const mineInRoster = async (viewer: Api): Promise<string | null> => {
  const { members } = (await viewer.get('/api/teams/engineering/roster')) as { members: { email: string; avatar: string | null }[] };
  return members.find((m) => m.email.startsWith('rafi'))?.avatar ?? null;
};

test.beforeAll(async () => {
  rafi = await apiAs('rafi');
  await rafi.ctx.delete('/api/me/avatar', { headers: await rafi.headers() });
});
test.afterAll(async () => {
  await rafi?.ctx.delete('/api/me/avatar', { headers: await rafi.headers() });
  await rafi?.ctx.dispose();
});

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout');

  test('initials by default; a built-in picture, a photo and back to the initials', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', '/account');
    try {
      const row = page.getByTestId('account-picture');
      await expect(row.locator('.av')).toBeVisible(T);
      await expect(row.locator('.av img')).toHaveCount(0);

      await page.getByTestId('account-change-picture').click();
      const dialog = page.getByTestId('avatar-picker');
      await expect(dialog).toBeVisible(T);
      // the three people groups and no bot pictures
      await expect(dialog.getByRole('region', { name: 'Men' }).locator('.avp-cell')).toHaveCount(10);
      await expect(dialog.getByRole('region', { name: 'Women', exact: true }).locator('.avp-cell')).toHaveCount(5);
      await expect(dialog.getByRole('region', { name: 'Women with a hijab' }).locator('.avp-cell')).toHaveCount(5);
      await expect(dialog.getByTestId('avatar-bot-panda')).toHaveCount(0);

      // a built-in picture is saved at once, shown, and read by the others
      await dialog.getByTestId('avatar-man-4').click();
      await expect(dialog.getByTestId('avatar-current')).toHaveText('Man with curly hair', T);
      expect(await mineInRoster(rafi)).toBe('preset:man-4');
      await expect(dialog.locator('.avp-now .av img')).toHaveAttribute('src', '/avatars/man-4.webp');
      const omar = await apiAs('omar');
      expect(await mineInRoster(omar)).toBe('preset:man-4');

      // a photo
      await dialog.getByTestId('avatar-file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
      await expect(dialog.getByTestId('avatar-current')).toHaveText('Profile photo', T);
      const photo = await mineInRoster(omar);
      expect(photo).toMatch(/^photo:[0-9a-f]{16}$/);
      const img = dialog.locator('.avp-now .av img');
      await expect(img).toHaveAttribute('src', /\/api\/people\/[0-9a-f-]+\/avatar\?v=[0-9a-f]{16}$/);
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), T).toBe(256);
      await omar.ctx.dispose();

      // something that is not a picture is refused in words and changes nothing
      await dialog.getByTestId('avatar-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a picture') });
      await expect(dialog.getByRole('alert')).toContainText('Choose a picture file', T);
      await expect(dialog.getByTestId('avatar-current')).toHaveText('Profile photo');

      // back to the initials
      await dialog.getByTestId('avatar-remove').click();
      await expect(dialog.getByTestId('avatar-current')).toContainText('initials', T);
      await expect(dialog.locator('.avp-now .av img')).toHaveCount(0);
      expect(await mineInRoster(rafi)).toBeNull();
      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(row.locator('.av')).toHaveText(/^[A-Z]{2}$/, T);
    } finally {
      await context.close();
    }
  });
});
