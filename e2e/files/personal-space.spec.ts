import { expect, test, type Page } from '@playwright/test';
import { personas } from '../fixtures/seed.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { STACK_ENV } from './support.ts';
import { ME, type PersonalFileJson, REFUSED, apiOn, meNode, openPersonal, openRowMenu, personalRoot, pickFile, rowAt, statusOf, teamRoots, textOf, treeOf, uploadAs, usageOf } from './personal-support.ts';

/*
 * P20-02 / P20-03 / P20-14 (Files side): the Files screen has two top levels, Personal (your own files) and Teams. A member has Personal; a guest does not.
 * In Personal: upload, rename, move, delete, the versions of a note and Restore, the allowance in words. Another member, and an admin who has not opened
 * the space, reach nothing: not on screen and not through the API. Runs on its own stack, in order, desktop only (the phone has its own spec).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; personal-mobile.spec.ts is the phone');
test.describe.configure({ mode: 'serial' });

const { nadia } = personas;

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Appends a sentence in the Raw text of the open note and saves it. */
async function editRaw(page: Page, sentence: string): Promise<void> {
  const md = page.getByTestId('file-view').getByTestId('viewer-markdown');
  if ((await md.getAttribute('data-mode')) !== 'raw') await md.getByRole('button', { name: 'Raw', exact: true }).click();
  const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
  await raw.fill(`${(await raw.inputValue()).trimEnd()}\n\n${sentence}\n`);
  await md.getByRole('button', { name: 'Save' }).click();
  await expect(md.getByRole('status')).toContainText('Saved. The earlier version is kept in the version history.');
}

test('Personal comes first with its seven starting folders, and the teams of the person follow under "Teams"', async ({ browser, playwright }) => {
  const nadiaView = await openPersonal(browser, playwright, stack, 'nadia');
  try {
    const page = nadiaView.page;
    // `/files` is Personal
    await expect(page.getByTestId('files-screen')).toHaveAttribute('data-space', ME);
    const roots = page.getByTestId('tree-root');
    await expect(roots.first()).toHaveAttribute('data-root', 'personal');
    await expect(personalRoot(page)).toContainText('Personal');
    await expect(page.getByTestId('tree-teams')).toHaveText('Teams');
    await expect(teamRoots(page)).toHaveText(['Engineering']);
    // the starting folders are in the tree and in the list, none of them a file
    const folders = page.locator(`[data-testid="tree-node"][data-space="${ME}"][data-kind="folder"]`);
    await expect(folders).toHaveText(['Action items', 'Inbox', 'Knowledge', 'Meetings', 'Memory', 'Notes', 'Routines']);
    await expect(page.locator('[data-testid="file-row"][data-kind="folder"]')).toHaveCount(7);
    await expect(page.locator('[data-testid="file-row"][data-kind="file"]')).toHaveCount(0);
    // Memory belongs to the person's memory, and says so
    await expect(rowAt(page, 'Memory')).toContainText('Your memory');
    // a file cannot live at the top: Upload and New note wait for a folder
    await expect(page.getByTestId('upload')).toBeDisabled();
    await expect(page.getByTestId('new-page')).toBeDisabled();
    await meNode(page, 'Notes').click();
    await expect(page).toHaveURL(/path=Notes/);
    await expect(page.getByTestId('upload')).toBeEnabled();
    await expect(page.getByTestId('files-empty')).toContainText('Nothing here yet.');
    await expect(page.getByTestId('breadcrumb')).toContainText('Personal');
    await expect(page.getByTestId('breadcrumb')).toContainText('Notes');
    // the team branch is the team's repo as before
    await page.goto(`${stack.origin}/t/engineering/files`);
    await expect(page.getByTestId('files-screen')).toHaveAttribute('data-space', 'engineering');
    await expect(personalRoot(page)).toBeVisible();
    await expect(page.locator('[data-testid="tree-node"][data-space="engineering"][data-path="pages"]')).toBeVisible();
  } finally {
    await nadiaView.close();
  }

  // a person in two teams has two team roots
  const priya = await openPersonal(browser, playwright, stack, 'priya');
  try {
    // the order is the session's; the set is what matters
    await expect(teamRoots(priya.page)).toHaveCount(2);
    await expect.poll(async () => (await teamRoots(priya.page).allTextContents()).map((t) => t.trim()).sort()).toEqual(['Engineering', 'Marketing']);
    await expect(personalRoot(priya.page)).toBeVisible();
  } finally {
    await priya.close();
  }
});

test('a guest has no Personal space: the screen says so, and every /api/me/files call is refused', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'lena');
  try {
    expect(await statusOf(api, 'GET', '/api/me/files/tree')).toBe(403);
    expect(await statusOf(api, 'GET', '/api/me/files/usage')).toBe(403);
    expect(await statusOf(api, 'POST', '/api/me/files/folders', { path: 'Mine' })).toBe(403);
    const upload = await api.ctx.post('/api/me/files?folderPath=Notes', {
      headers: { ...(await api.headers()), 'content-type': 'text/plain', 'x-file-name': 'a.txt' },
      data: Buffer.from('x'),
    });
    expect(upload.status()).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
  const { page, close } = await openPersonal(browser, playwright, stack, 'lena');
  try {
    await expect(page.getByTestId('files-no-personal')).toContainText('Personal files are not available here.');
    await expect(page.getByTestId('tree-root')).toHaveCount(0);
    await expect(page.getByTestId('file-row')).toHaveCount(0);
    await expect(page.getByTestId('upload')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('upload, rename, move and delete: each one changes the list, the allowance and the server', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await expect(page.getByTestId('quota-text')).toHaveText('0 B of 5.0 GB used');

    // upload into Notes
    await pickFile(page, { name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('Plan v1\n') });
    const plan = rowAt(page, 'Notes/plan.md');
    await expect(plan).toBeVisible();
    await expect(plan).toHaveAttribute('data-store', 'personal');
    await expect(plan).toHaveAttribute('data-kind', 'file');
    await expect(page.getByTestId('quota-text')).toHaveText('8 B of 5.0 GB used');
    const stored = await treeOf(api, 'Notes');
    expect(stored.map((e) => e.path)).toEqual(['Notes/plan.md']);
    expect(await usageOf(api)).toMatchObject({ usedBytes: 8, fileCount: 1 });
    const planId = stored[0]?.fileId ?? '';
    expect(await textOf(api, planId)).toBe('Plan v1\n');

    // a second file with the same name is kept, under a numbered name
    await pickFile(page, { name: 'plan.md', mimeType: 'text/markdown', buffer: Buffer.from('Another\n') });
    await expect(rowAt(page, 'Notes/plan (2).md')).toBeVisible();
    await expect(plan).toBeVisible();

    // rename
    await openRowMenu(page, 'Notes/plan (2).md');
    await page.getByTestId('row-action-rename').click();
    const rename = page.getByTestId('dialog-rename');
    await rename.getByLabel('New name').fill('plan.md');
    await rename.getByRole('button', { name: 'Rename' }).click();
    // the name is taken in that folder: the dialog says so in words and nothing changes
    await expect(rename.getByRole('alert')).toContainText('already');
    await rename.getByLabel('New name').fill('agenda.md');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rowAt(page, 'Notes/agenda.md')).toBeVisible();
    await expect(rowAt(page, 'Notes/plan (2).md')).toHaveCount(0);
    expect((await treeOf(api, 'Notes')).map((e) => e.name).sort()).toEqual(['agenda.md', 'plan.md']);

    // move into a folder that does not exist yet: it is made
    await openRowMenu(page, 'Notes/agenda.md');
    await page.getByTestId('row-action-move').click();
    const move = page.getByTestId('dialog-move');
    await move.getByLabel('Move to folder').fill('Meetings/Q4');
    await move.getByRole('button', { name: 'Move' }).click();
    await expect(rowAt(page, 'Notes/agenda.md')).toHaveCount(0);
    expect((await treeOf(api, 'Meetings')).map((e) => e.path)).toEqual(['Meetings/Q4']);
    expect((await treeOf(api, 'Meetings/Q4')).map((e) => e.path)).toEqual(['Meetings/Q4/agenda.md']);
    await meNode(page, 'Meetings').locator('[data-testid="tree-caret"]').click();
    await expect(meNode(page, 'Meetings/Q4')).toBeVisible();
    await meNode(page, 'Meetings/Q4').click();
    await expect(rowAt(page, 'Meetings/Q4/agenda.md')).toBeVisible();
    // a top-level move is refused in the dialog: files in Personal live in folders
    await openRowMenu(page, 'Meetings/Q4/agenda.md');
    await page.getByTestId('row-action-move').click();
    await page.getByTestId('dialog-move').getByLabel('Move to folder').fill('');
    await expect(page.getByTestId('dialog-move').getByRole('button', { name: 'Move' })).toBeDisabled();
    await page.getByTestId('dialog-move').getByRole('button', { name: 'Cancel' }).click();

    // delete asks first and says what it does to the versions and the space
    await openRowMenu(page, 'Meetings/Q4/agenda.md');
    await page.getByTestId('row-action-delete').click();
    const confirm = page.getByTestId('dialog-delete');
    await expect(confirm).toContainText('Delete agenda.md?');
    await expect(confirm).toContainText('removed with every earlier version');
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(rowAt(page, 'Meetings/Q4/agenda.md')).toBeVisible();
    await openRowMenu(page, 'Meetings/Q4/agenda.md');
    await page.getByTestId('row-action-delete').click();
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(rowAt(page, 'Meetings/Q4/agenda.md')).toHaveCount(0);
    expect(await treeOf(api, 'Meetings/Q4')).toEqual([]);
    // the bytes are gone, and the space is back
    expect(await usageOf(api)).toMatchObject({ usedBytes: 8, fileCount: 1 });
    await expect(page.getByTestId('quota-text')).toHaveText('8 B of 5.0 GB used');
    // an empty folder you made can be deleted
    await page.goto(`${stack.origin}/files?path=Meetings`);
    await openRowMenu(page, 'Meetings/Q4');
    await page.getByTestId('row-action-delete').click();
    await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(rowAt(page, 'Meetings/Q4')).toHaveCount(0);
    await page.goto(`${stack.origin}/files`);
    // the seven starting folders stay: they have no menu at all
    await expect(rowAt(page, 'Notes').getByTestId('row-menu')).toHaveCount(0);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a note: edit it twice, read its versions and restore the first; the replaced text is kept too', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openPersonal(browser, playwright, stack, 'nadia', '?path=Notes');
  try {
    await page.getByTestId('new-page').click();
    await expect(page.getByTestId('dialog-new-file')).toContainText('A name without an extension becomes a Markdown note.');
    await page.getByTestId('dialog-new-file').getByLabel('Name').fill('retro');
    await page.getByTestId('dialog-new-file').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('file-view-path')).toHaveAttribute('title', 'Notes/retro.md');
    const note = (await treeOf(api, 'Notes')).find((e) => e.name === 'retro.md');
    const id = note?.fileId ?? '';
    expect(await textOf(api, id)).toBe('# Retro\n\n');

    await editRaw(page, 'Edit one: the canary hold is thirty minutes.');
    await editRaw(page, 'Edit two: page the on-call before promoting.');
    const versions = await api.get<{ items: Array<{ current: boolean }> }>(`/api/me/files/${id}/versions`);
    expect(versions.items.map((v) => v.current)).toEqual([true, false, false]);

    // Versions open in the right panel: the current one first, the older ones after it
    await page.getByTestId('file-view').getByTestId('open-history').click();
    const history = page.getByTestId('history');
    await expect(history).toBeVisible();
    const rows = history.getByTestId('commit-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toHaveAttribute('data-selected', 'true');
    await expect(rows.first()).toContainText('Current version');
    await expect(rows.last()).toContainText('Earlier version');
    // the current version cannot be restored
    await expect(history.getByTestId('restore-version')).toBeDisabled();
    // the change of the newest earlier version is a line added to the first text
    await rows.nth(1).getByRole('button').first().click();
    await expect(history.getByTestId('text-diff').locator('[data-line="add"]', { hasText: 'Edit one' })).toHaveCount(1);

    // restore the oldest: the question says the version now is kept
    await rows.last().getByRole('button').first().click();
    await expect(rows.last()).toHaveAttribute('data-selected', 'true');
    await history.getByTestId('restore-version').click();
    const dialog = page.getByTestId('dialog-restore');
    await expect(dialog.getByTestId('restore-question')).toContainText('The version you have now is kept, so you can go back to it.');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(history.getByRole('status')).toContainText('Restored. The version you had before is kept.');
    // nothing was lost: four entries now (the restored text, the one it replaced, and the two older ones)
    await expect(rows).toHaveCount(4);
    expect(await textOf(api, id)).toBe('# Retro\n\n');
    const after = await api.get<{ items: Array<{ current: boolean; contentUrl: string }> }>(`/api/me/files/${id}/versions`);
    expect(after.items).toHaveLength(4);
    const replaced = await api.ctx.get(after.items[1]?.contentUrl ?? '');
    expect(await replaced.text()).toContain('Edit two');
    // the page open in the middle shows the restored text after a reload
    await page.reload();
    const viewer = page.getByTestId('file-view').getByTestId('viewer-markdown');
    await expect(viewer).toBeVisible();
    // the restored text has loaded (its title is there) before "the replaced line is gone" means anything
    await expect(viewer).toContainText('Retro');
    await expect(viewer).not.toContainText('Edit two');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('the allowance is shown in words under the list, and a new file moves it', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const { page, close } = await openPersonal(browser, playwright, stack, 'rafi', '?path=Inbox');
  try {
    const quota = page.getByTestId('quota');
    await expect(quota).toBeVisible();
    await expect(page.getByTestId('quota-text')).toHaveText('0 B of 5.0 GB used');
    await expect(quota.getByRole('meter', { name: 'Personal files used' })).toHaveAttribute('aria-valuenow', '0');
    await uploadAs(api, 'Inbox', 'drop.md', 'x'.repeat(2048));
    // a change from another place shows after the next visit
    await page.reload();
    await expect(page.getByTestId('quota-text')).toHaveText('2 KB of 5.0 GB used');
    await expect(quota.getByRole('meter')).toHaveAttribute('aria-valuetext', '2 KB of 5.0 GB');
    // a team's folders have no allowance line
    await page.goto(`${stack.origin}/t/engineering/files`);
    await expect(page.getByTestId('files-screen')).toBeVisible();
    await expect(page.getByTestId('quota')).toHaveCount(0);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test.describe('nobody else reads it', () => {
  let secret: PersonalFileJson;
  const SECRET_TEXT = 'the rota for the reorg, for my eyes only';

  test.beforeAll(async ({ playwright }) => {
    const api = await apiOn(playwright, stack, 'nadia');
    secret = await uploadAs(api, 'Notes', 'reorg.md', SECRET_TEXT);
    await uploadAs(api, 'Notes', 'reorg.md', `${SECRET_TEXT}\nrevised`, { conflict: 'version' });
    await api.ctx.dispose();
  });

  test('another member sees an empty Personal of their own, and no link reaches the file', async ({ browser, playwright }) => {
    const { page, close } = await openPersonal(browser, playwright, stack, 'sameera', '?path=Notes');
    try {
      await expect(page.getByTestId('files-empty')).toContainText('Nothing here yet.');
      await expect(rowAt(page, 'Notes/reorg.md')).toHaveCount(0);
      // the same address with the file open: Sameera's Notes has no such file
      await page.goto(`${stack.origin}/files?open=Notes/reorg.md`);
      await expect(page.getByTestId('files-screen')).toBeVisible();
      // wait for the end state (the screen has looked and found nothing), so the absence below is not just "not loaded yet"
      await expect(page.getByText('This file no longer exists')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(SECRET_TEXT);
      await expect(page.getByTestId('file-view')).toHaveCount(0);
      // the panel link of a Personal file names it by path: Sameera's Notes has no such file either
      await page.goto(`${stack.origin}/files?panel=file:~me/Notes/reorg.md`);
      await expect(page.getByTestId('files-screen')).toBeVisible();
      await expect(page.getByText('This file no longer exists')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(SECRET_TEXT);
      await expect(page.getByTestId('file-preview')).toHaveCount(0);
      // a link that names the file by id, as a channel attachment would: nothing of it shows
      await page.goto(`${stack.origin}/files?panel=file:${secret.id}`);
      await expect(page.getByTestId('files-screen')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(SECRET_TEXT);
      await expect(page.getByTestId('file-preview')).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('another member, an admin who has not opened the space, and a visitor with no session get 403 or 404 from every route', async ({ playwright }) => {
    for (const who of ['sameera', 'omar', 'priya'] as const) {
      const api = await apiOn(playwright, stack, who);
      try {
        const paths: Array<['GET' | 'PATCH' | 'DELETE' | 'POST', string, unknown?]> = [
          ['GET', `/api/files/${secret.id}`],
          ['GET', `/api/files/${secret.id}/content`],
          ['GET', `/api/me/files/${secret.id}/versions`],
          ['PATCH', `/api/me/files/${secret.id}`, { name: 'mine.md' }],
          ['DELETE', `/api/me/files/${secret.id}`],
          ['POST', `/api/me/files/${secret.id}/share-check`, { destination: 'team_files', teamSlug: 'engineering' }],
          ['POST', `/api/me/files/${secret.id}/copy-to-team`, { teamSlug: 'engineering', path: 'pages/stolen.md' }],
        ];
        for (const [method, path, data] of paths) {
          expect(REFUSED, `${who} ${method} ${path}`).toContain(await statusOf(api, method, path, data));
        }
        // the listing of their own space does not hold it
        const own = await treeOf(api, 'Notes');
        expect(own.map((e) => e.path)).not.toContain('Notes/reorg.md');
      } finally {
        await api.ctx.dispose();
      }
    }
    // an admin's read of the space as a person is refused before an open, with words about what to do
    const omar = await apiOn(playwright, stack, 'omar');
    try {
      const res = await omar.ctx.get(`/api/people/${nadia.personId}/files/tree`);
      expect(res.status()).toBe(403);
      expect(await res.text()).toMatch(/open/i);
      expect((await omar.ctx.post(`/api/people/${nadia.personId}/personal-space/export`, { headers: await omar.headers() })).status()).toBe(403);
    } finally {
      await omar.ctx.dispose();
    }
    // nobody signed in
    const anon = await playwright.request.newContext({ baseURL: stack.origin });
    try {
      expect((await anon.get(`/api/files/${secret.id}/content`)).status()).toBe(401);
      expect((await anon.get('/api/me/files/tree')).status()).toBe(401);
    } finally {
      await anon.dispose();
    }
  });

  test('the owner still reads it, and the older text is only theirs too', async ({ playwright }) => {
    const api = await apiOn(playwright, stack, 'nadia');
    try {
      expect(await textOf(api, secret.id)).toContain('revised');
      const list = await api.get<{ items: Array<{ contentUrl: string; current: boolean }> }>(`/api/me/files/${secret.id}/versions`);
      const older = list.items.find((v) => !v.current);
      const other = await apiOn(playwright, stack, 'sameera');
      try {
        expect(REFUSED).toContain((await other.ctx.get(older?.contentUrl ?? '/api/me/files/none/versions/none/content')).status());
      } finally {
        await other.ctx.dispose();
      }
    } finally {
      await api.ctx.dispose();
    }
  });
});
