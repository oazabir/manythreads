import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV, blobOf, commitsOf } from './support.ts';
import { apiOn, openPersonal, openRowMenu, rowAt, statusOf, textOf, uploadAs, type StackApi } from './personal-support.ts';

/*
 * P20-05: "Send to a team…" on a Personal file. The workspace's data rules (the egress chain, `app.llm_settings.preset`) are asked first and shown in
 * words; a block leaves the Copy button off and the server refuses the copy too; a redact copies the text with the key replaced; a clean file is copied as
 * written. Nothing leaves before the person presses the button. Own stack, in order, desktop.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

// A made-up key in the shape the "api-key" rule looks for. It is not a real credential.
const KEY = `sk-${'ab3dEf6hIj'.repeat(3)}`;

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

const setPreset = (preset: 'standard' | 'customer-facing'): Promise<unknown> =>
  stack.sql(`INSERT INTO app.llm_settings (workspace_id, preset) SELECT id, $1 FROM app.workspaces ON CONFLICT (workspace_id) DO UPDATE SET preset = EXCLUDED.preset`, [preset]);

const repoStatus = async (api: StackApi, path: string): Promise<number> => statusOf(api, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);

test('a file the data rules block: the dialog says so, Copy stays off, and the server refuses the copy too', async ({ browser, playwright }) => {
  await setPreset('customer-facing');
  const api = await apiOn(playwright, stack, 'nadia');
  const file = await uploadAs(api, 'Notes', 'blocked.md', `token ${KEY} end\n`);
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await openRowMenu(page, 'Notes/blocked.md');
    await page.getByTestId('row-action-share').click();
    const dialog = page.getByTestId('dialog-share');
    await expect(dialog).toContainText('Send blocked.md to a team');
    const verdict = dialog.getByTestId('share-verdict');
    await expect(verdict).toHaveAttribute('data-outcome', 'block');
    await expect(verdict).toContainText("Your workspace's data rules do not allow this file to be sent");
    await expect(verdict).toHaveAttribute('role', 'alert');
    // the rule that matched is named, the key itself is not shown anywhere
    await expect(verdict).toContainText('api-key');
    await expect(dialog).not.toContainText(KEY);
    await expect(dialog.getByTestId('share-send')).toBeDisabled();
    // the inbox is checked by the same rules; the other team is not an option for Nadia
    await expect(dialog.getByTestId('share-team').locator('option')).toHaveText(['Engineering']);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    // the server does not trust the screen
    expect(await statusOf(api, 'POST', `/api/me/files/${file.id}/copy-to-team`, { teamSlug: 'engineering', path: 'pages/from-personal/blocked.md' })).toBe(409);
    expect(await repoStatus(api, 'pages/from-personal/blocked.md')).toBe(404);
    // nothing was committed, and the original stays where it was
    expect((await commitsOf(stack)).some((c) => c.paths.includes('pages/from-personal/blocked.md'))).toBe(false);
    await expect(rowAt(page, 'Notes/blocked.md')).toBeVisible();
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a file with a key under the standard rules: the dialog warns, the copy goes, and the key is not in the team repo', async ({ browser, playwright }) => {
  await setPreset('standard');
  const api = await apiOn(playwright, stack, 'nadia');
  const keys = await uploadAs(api, 'Notes', 'keys.md', `token ${KEY} end\n`);
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await openRowMenu(page, 'Notes/keys.md');
    await page.getByTestId('row-action-share').click();
    const dialog = page.getByTestId('dialog-share');
    await expect(dialog.getByTestId('share-verdict')).toHaveAttribute('data-outcome', 'redact');
    await expect(dialog.getByTestId('share-verdict')).toContainText('will replace parts of this file before it is sent');
    await expect(dialog.getByTestId('share-send')).toBeEnabled();
    // the default path is under pages/, and a path with a dot-dot is refused in words before anything is sent
    await expect(dialog.getByTestId('share-path')).toHaveValue('pages/keys.md');
    await dialog.getByTestId('share-path').fill('../keys.md');
    await expect(dialog.getByRole('alert').filter({ hasText: 'Give a path such as pages/notes.md.' })).toBeVisible();
    await expect(dialog.getByTestId('share-send')).toBeDisabled();
    await dialog.getByTestId('share-path').fill('pages/from-personal/keys.md');
    await dialog.getByTestId('share-send').click();
    await expect(dialog.getByTestId('share-done')).toContainText('Copied to pages/from-personal/keys.md in Engineering.');
    await expect(dialog.getByTestId('share-done')).toContainText('Parts of it were replaced');
    await dialog.getByRole('button', { name: 'Done' }).click();

    const stored = await blobOf(api, 'pages/from-personal/keys.md');
    expect(stored).toContain('token');
    expect(stored).not.toContain(KEY);
    // the commit is the person's own, and the Personal original keeps its key
    const commit = (await commitsOf(stack)).find((c) => c.paths.includes('pages/from-personal/keys.md'));
    expect(commit?.message).toBe('Add pages/from-personal/keys.md from Personal files');
    expect(await textOf(api, keys.id)).toContain(KEY);
    // a copy never overwrites a team file: the same path again is refused with words
    await openRowMenu(page, 'Notes/keys.md');
    await page.getByTestId('row-action-share').click();
    await page.getByTestId('share-path').fill('pages/from-personal/keys.md');
    await page.getByTestId('share-send').click();
    // two alerts: the data-rules verdict (a redact is an alert) and the refusal of the copy; without the refusal there would be one
    await expect(page.getByTestId('dialog-share').getByRole('alert')).toHaveCount(2);
    await expect(page.getByTestId('share-done')).toHaveCount(0);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a clean file: the rules allow it, it is copied as written, and "Open it" goes to the page in the team files', async ({ browser, playwright }) => {
  await setPreset('standard');
  const api = await apiOn(playwright, stack, 'nadia');
  await uploadAs(api, 'Notes', 'plan.md', '# Plan\nNothing secret here.\n');
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await openRowMenu(page, 'Notes/plan.md');
    await page.getByTestId('row-action-share').click();
    const dialog = page.getByTestId('dialog-share');
    await expect(dialog.getByTestId('share-verdict')).toHaveAttribute('data-outcome', 'allow');
    await expect(dialog.getByTestId('share-verdict')).toContainText('Nothing in this file is held back');
    await dialog.getByTestId('share-path').fill('pages/from-personal/plan.md');
    await dialog.getByTestId('share-send').click();
    await expect(dialog.getByTestId('share-done')).toContainText('Copied to pages/from-personal/plan.md in Engineering.');
    expect(await blobOf(api, 'pages/from-personal/plan.md')).toBe('# Plan\nNothing secret here.\n');
    await dialog.getByRole('link', { name: 'Open it' }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/files\?.*open=pages(%2F|\/)from-personal(%2F|\/)plan\.md/);
    await expect(page.getByTestId('files-screen')).toHaveAttribute('data-space', 'engineering');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a picture cannot be copied into the team files: the option is off, and the inbox is the way', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const file = await uploadAs(api, 'Notes', 'pixel.png', png, { type: 'image/png' });
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await openRowMenu(page, 'Notes/pixel.png');
    await page.getByTestId('row-action-share').click();
    const dialog = page.getByTestId('dialog-share');
    await expect(dialog.getByTestId('share-to-files')).toBeDisabled();
    await expect(dialog.getByTestId('share-to-inbox')).toBeChecked();
    await expect(dialog).toContainText('Only text files up to 1 MB can be copied here.');
    expect(await statusOf(api, 'POST', `/api/me/files/${file.id}/copy-to-team`, { teamSlug: 'engineering', path: 'pages/pixel.md' })).toBe(422);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('the inbox: sending a file says it is read there before it is filed', async ({ browser, playwright }) => {
  await setPreset('standard');
  const api = await apiOn(playwright, stack, 'nadia');
  await uploadAs(api, 'Notes', 'for-inbox.md', 'Our on-call rota moves to Tuesdays from next month.\n');
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await openRowMenu(page, 'Notes/for-inbox.md');
    await page.getByTestId('row-action-share').click();
    const dialog = page.getByTestId('dialog-share');
    await dialog.getByTestId('share-to-inbox').check();
    await expect(dialog.getByTestId('share-path')).toHaveCount(0);
    await expect(dialog.getByTestId('share-verdict')).toHaveAttribute('data-outcome', 'allow');
    await dialog.getByTestId('share-send').click();
    await expect(dialog.getByTestId('share-done')).toContainText('Sent to the inbox of Engineering. It is read there before it is filed.');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});
