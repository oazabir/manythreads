import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV } from './support.ts';
import { apiOn, openPersonal, openRowMenu, rowAt, treeOf, usageOf } from './personal-support.ts';

/*
 * P20-02: the allowance of a Personal space. The default is 5 GB; this stack lowers it to 1000 bytes (MANYTHREADS_PERSONAL_QUOTA_BYTES, read on every call)
 * so the full state can be reached without moving gigabytes. The screen says it in words under the list; an upload that does not fit is refused in the
 * list of uploads and changes nothing. Own stack, in order, desktop.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; personal-mobile.spec.ts is the phone');
test.describe.configure({ mode: 'serial' });

const QUOTA = 1000;

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV, MANYTHREADS_PERSONAL_QUOTA_BYTES: String(QUOTA) });
});
test.afterAll(async () => {
  await stack?.stop();
});

const bytes = (n: number, fill = 'a') => Buffer.from(fill.repeat(n));

test('under the allowance the text says how much is used; a file that does not fit is refused in words and changes nothing', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const { page, close } = await openPersonal(browser, playwright, stack, 'priya', '?path=Notes');
  try {
    await expect(page.getByTestId('quota-text')).toHaveText('0 B of 1000 B used');
    expect(await usageOf(api)).toMatchObject({ usedBytes: 0, quotaBytes: QUOTA });

    await page.getByTestId('upload-input').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: bytes(600) });
    await expect(rowAt(page, 'Notes/a.txt')).toBeVisible();
    await expect(page.getByTestId('quota-text')).toHaveText('600 B of 1000 B used');
    await expect(page.getByTestId('quota').getByRole('meter')).toHaveAttribute('aria-valuenow', '600');
    await expect(page.locator('.fquota.ok')).toBeVisible();

    // 600 more do not fit: the upload row says why, the list and the allowance stay as they were
    await page.getByTestId('upload-input').setInputFiles({ name: 'b.txt', mimeType: 'text/plain', buffer: bytes(600, 'b') });
    const failed = page.getByTestId('upload-list').getByRole('alert');
    await expect(failed).toContainText(/That would take you over your \d+ GB of Personal space\. Delete something or an older version first\./);
    await expect(rowAt(page, 'Notes/b.txt')).toHaveCount(0);
    await expect(page.getByTestId('quota-text')).toHaveText('600 B of 1000 B used');
    expect(await usageOf(api)).toMatchObject({ usedBytes: 600, fileCount: 1 });
    expect((await treeOf(api, 'Notes')).map((e) => e.name)).toEqual(['a.txt']);
    // the refusal can be dismissed
    await page.getByTestId('upload-list').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('upload-list')).toHaveCount(0);

    // the same refusal from the API
    const res = await api.ctx.post('/api/me/files?folderPath=Notes', { headers: { ...(await api.headers()), 'content-type': 'text/plain', 'x-file-name': 'c.txt' }, data: bytes(600, 'c') });
    expect(res.status()).toBe(413);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('at the allowance the bar is full and says so; deleting a file lifts the note', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const { page, close } = await openPersonal(browser, playwright, stack, 'priya', '?path=Notes');
  try {
    await page.getByTestId('upload-input').setInputFiles({ name: 'fill.txt', mimeType: 'text/plain', buffer: bytes(400, 'f') });
    await expect(rowAt(page, 'Notes/fill.txt')).toBeVisible();
    await expect(page.getByTestId('quota-text')).toHaveText('1000 B of 1000 B used');
    await expect(page.locator('.fquota.full')).toBeVisible();
    await expect(page.getByTestId('quota').getByRole('alert')).toHaveText('Your Personal files are full. Delete something to add more.');
    // not even one more byte
    await page.getByTestId('upload-input').setInputFiles({ name: 'one.txt', mimeType: 'text/plain', buffer: bytes(1, 'o') });
    await expect(page.getByTestId('upload-list').getByRole('alert')).toContainText('Personal space');
    expect(await usageOf(api)).toMatchObject({ usedBytes: QUOTA });

    // delete the 600 byte file: the note goes, the text follows the server
    await openRowMenu(page, 'Notes/a.txt');
    await page.getByTestId('row-action-delete').click();
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(rowAt(page, 'Notes/a.txt')).toHaveCount(0);
    await expect(page.getByTestId('quota-text')).toHaveText('400 B of 1000 B used');
    await expect(page.getByTestId('quota').getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.fquota.ok')).toBeVisible();
    expect(await usageOf(api)).toMatchObject({ usedBytes: 400, fileCount: 1 });
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('the allowance is per person: another member starts at nothing', async ({ playwright }) => {
  const sameera = await apiOn(playwright, stack, 'sameera');
  try {
    expect(await usageOf(sameera)).toMatchObject({ usedBytes: 0, quotaBytes: QUOTA, fileCount: 0 });
  } finally {
    await sameera.ctx.dispose();
  }
});
