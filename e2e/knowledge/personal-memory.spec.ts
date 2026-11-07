import { expect, test } from '@playwright/test';
import { personas } from '../fixtures/seed.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll } from '../support/stack-browser.ts';
import { PERSONAL_ROUTES, fact, memoryPaths, openMemory, putMemory } from './personal-support.ts';

/*
 * Personal memory (PLAN P20-05, P20-04 screens): `/memory` is a person's own bundle of memory files, kept as rows (never a git commit), seen by its owner
 * alone. Covers: isolation (another member, a guest, an admin who has not opened the space), the "changed since you opened it" refusal, edit, earlier
 * versions and Bring back (which makes a NEW version), delete, and the phone. Own stack, in order, desktop unless a test says otherwise.
 */
test.describe.configure({ mode: 'serial' });

const { nadia } = personas;
const TEA = 'memory/facts/tea.md';
const PLAN = 'memory/facts/plan.md';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Nadia saves a file and sees it; Rafi does not, on screen or through the API', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout; the phone has its own test below');
  const nadiaApi = await apiOn(playwright, stack, 'nadia');
  const rafiApi = await apiOn(playwright, stack, 'rafi');
  const nadiaView = await openMemory(browser, playwright, stack, 'nadia');
  const rafiView = await openMemory(browser, playwright, stack, 'rafi');
  try {
    await putMemory(nadiaApi, TEA, fact('Tea order', 'Nadia takes green tea, no sugar.'));
    expect(await memoryPaths(nadiaApi)).toContain(TEA);

    // the Personal side is the first thing /memory shows
    await expect(nadiaView.page.getByTestId('space-switch')).toHaveAttribute('data-space', 'personal');
    await nadiaView.page.reload();
    const row = nadiaView.page.getByTestId('personal-concept-row').filter({ hasText: 'Tea order' });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(nadiaView.page.getByTestId('personal-concept-title')).toHaveText('Tea order');
    await expect(nadiaView.page.getByTestId('personal-file-text')).toContainText('green tea');
    await expect(nadiaView.page.getByTestId('personal-file-version')).toContainText('Version 1');

    // Rafi: an empty memory of his own, and no way to name hers
    await expect(rafiView.page.getByTestId('personal-memory-empty')).toBeVisible();
    await expect(rafiView.page.getByTestId('personal-concept-row')).toHaveCount(0);
    expect(await memoryPaths(rafiApi)).toEqual([]);
    expect(await rafiApi.status('GET', `/api/me/memory/file?path=${encodeURIComponent(TEA)}`)).toBe(404);
    expect(await rafiApi.status('GET', `/api/me/memory/versions?path=${encodeURIComponent(TEA)}`)).toBe(404);
    // a link to her file shows him nothing of it
    await rafiView.page.goto(`/memory?concept=${encodeURIComponent(TEA)}`);
    // the page has drawn his (empty) memory before anything is asserted absent
    await expect(rafiView.page.getByTestId('personal-memory-empty')).toBeVisible();
    await expect(rafiView.page.getByTestId('personal-concept-detail')).toHaveCount(0);
    await expect(rafiView.page.getByText('green tea')).toHaveCount(0);
  } finally {
    await nadiaView.close();
    await rafiView.close();
    await nadiaApi.ctx.dispose();
    await rafiApi.ctx.dispose();
  }
});

test('Lena, a guest, is refused every Personal route and is not offered the Personal side', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    for (const [method, path] of PERSONAL_ROUTES) expect(await lena.status(method, path), `${method} ${path}`).toBe(403);
    expect(await lena.status('POST', '/api/me/inbox/notes', { text: 'a note' })).toBe(403);
    expect(await lena.status('POST', '/api/me/knowledge', { name: 'notes' })).toBe(403);
  } finally {
    await lena.ctx.dispose();
  }
  const { page, close } = await openMemory(browser, playwright, stack, 'lena');
  try {
    // she sees the refusal and no Personal memory: no files, no switch to it
    await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
    await expect(page.getByTestId('personal-concept-row')).toHaveCount(0);
    await expect(page.getByTestId('space-personal')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('an admin who has not opened Nadia’s space reads none of her memory; the open space route needs a reason', async ({ playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    // Omar's own list is his; nothing of Nadia's is in it
    expect(await memoryPaths(omar)).not.toContain(TEA);
    expect(await omar.status('GET', `/api/me/memory/file?path=${encodeURIComponent(TEA)}`)).toBe(404);
    // the people routes of her space are closed until an audited open
    expect([403, 404]).toContain(await omar.status('GET', `/api/people/${nadia.personId}/files/tree`));
    const noReason = await omar.ctx.post(`/api/people/${nadia.personId}/personal-space/open`, { data: { reason: '' }, headers: await omar.headers() });
    expect(noReason.status()).toBe(400);
    // still nothing after the refused open
    expect([403, 404]).toContain(await omar.status('GET', `/api/people/${nadia.personId}/files/tree`));
  } finally {
    await omar.ctx.dispose();
  }
});

test('a save that started from an old version is refused in a plain sentence, with a way to the latest', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia');
  try {
    await putMemory(api, PLAN, fact('Release plan', 'Ship on Friday.'));
    await page.reload();
    await page.getByTestId('personal-concept-row').filter({ hasText: 'Release plan' }).click();
    await expect(page.getByTestId('personal-file-version')).toContainText('Version 1');
    await page.getByTestId('personal-file-edit').click();
    await page.getByTestId('personal-file-textarea').fill(fact('Release plan', 'Ship on Thursday.'));

    // while the editor is open, the file moves on (another window, or a bot she allowed)
    const v2 = await putMemory(api, PLAN, fact('Release plan', 'Ship on Monday.'), 1);
    expect(v2.file.versionNo).toBe(2);

    await page.getByTestId('personal-file-save').click();
    await expect(page.getByTestId('personal-file-problem')).toContainText('changed since you opened it');
    await expect(page.getByTestId('personal-file-problem')).toContainText('version 2');
    // nothing was merged or overwritten
    expect((await api.get<{ file: { content: string; versionNo: number } }>(`/api/me/memory/file?path=${encodeURIComponent(PLAN)}`)).file).toMatchObject({ versionNo: 2 });
    await page.getByTestId('personal-file-reload').click();
    await expect(page.getByTestId('personal-file-text')).toContainText('Ship on Monday.');
    await expect(page.getByTestId('personal-file-version')).toContainText('Version 2');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('edit, earlier versions and Bring back: every change, a restore too, is a new version', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const api = await apiOn(playwright, stack, 'nadia');
  const path = 'memory/facts/coffee.md';
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia');
  try {
    await putMemory(api, path, fact('Coffee', 'Nadia drinks coffee at nine.'));
    await page.reload();
    await page.getByTestId('personal-concept-row').filter({ hasText: 'Coffee' }).click();
    await expect(page.getByTestId('personal-file-version')).toContainText('Version 1');

    // Save stays off until the text differs
    await page.getByTestId('personal-file-edit').click();
    await expect(page.getByTestId('personal-file-save')).toBeDisabled();
    await page.getByTestId('personal-file-textarea').fill(fact('Coffee', 'Nadia drinks coffee at ten.'));
    await page.getByTestId('personal-file-save').click();
    await expect(page.getByTestId('personal-file-text')).toContainText('at ten');
    await expect(page.getByTestId('personal-file-version')).toContainText('Version 2');

    // the earlier versions: two rows, the current one marked, Bring back only on the older
    await page.getByTestId('personal-file-history').click();
    const rows = page.getByTestId('personal-file-version-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ has: page.getByText('Now', { exact: true }) })).toHaveAttribute('data-version', '2');
    await expect(page.getByTestId('personal-file-restore')).toHaveCount(1);
    await page.getByRole('button', { name: 'Bring back version 1' }).click();

    // the old text is back, as version 3; the history only goes forward
    await expect(page.getByTestId('personal-file-text')).toContainText('at nine');
    await expect(page.getByTestId('personal-file-version')).toContainText('Version 3');
    const versions = await api.get<{ items: Array<{ versionNo: number }> }>(`/api/me/memory/versions?path=${encodeURIComponent(path)}`);
    expect(versions.items.map((v) => v.versionNo).sort()).toEqual([1, 2, 3]);
    const now = await api.get<{ file: { content: string; versionNo: number } }>(`/api/me/memory/file?path=${encodeURIComponent(path)}`);
    expect(now.file.versionNo).toBe(3);
    expect(now.file.content).toContain('at nine');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('a file that breaks the memory format is refused with its reason, and Delete asks first', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const api = await apiOn(playwright, stack, 'nadia');
  const keep = 'memory/facts/old-note.md';
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia');
  try {
    // no front matter: not a memory file. 400 with the path and the validator's reason; nothing was saved
    const bad = await api.ctx.put('/api/me/memory/file', { data: { path: 'memory/facts/bad.md', content: 'just words, no front matter' }, headers: await api.headers() });
    expect(bad.status()).toBe(400);
    expect(await bad.text()).toContain('bad.md');
    expect(await memoryPaths(api)).not.toContain('memory/facts/bad.md');

    // a file of its own, so this test does not lean on an earlier one
    await putMemory(api, keep, fact('Old note', 'Nothing to see here.'));
    await page.reload();
    await page.getByTestId('personal-concept-row').filter({ hasText: 'Old note' }).click();
    await page.getByTestId('personal-file-delete').click();
    await expect(page.getByTestId('personal-file-delete-confirm')).toBeVisible();
    expect(await memoryPaths(api)).toContain(keep);
    await page.getByTestId('personal-file-delete-confirm').click();
    await expect(page.getByTestId('personal-concept-row').filter({ hasText: 'Old note' })).toHaveCount(0);
    expect(await memoryPaths(api)).not.toContain(keep);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('on a phone the files list and the open file fit the width', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia', '/memory', { viewport: PHONE, mobile: true });
  try {
    await putMemory(api, 'memory/facts/long-name.md', fact('A file with a rather long title that has to wrap inside its row on a narrow screen', 'Body text.'));
    await page.reload();
    const row = page.getByTestId('personal-concept-row').first();
    await expect(row).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await row.click();
    await expect(page.getByTestId('personal-concept-detail')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});
