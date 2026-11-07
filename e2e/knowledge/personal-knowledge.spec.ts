import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll } from '../support/stack-browser.ts';
import { openMemory } from './personal-support.ts';

/*
 * Personal knowledge (PLAN P20-06, P20-04 screens): `/knowledge` is a person's own knowledge bases, files and web pages only the owner (and Brain, when
 * they ask it) can search. Covers: create, upload, search with the document and version in the hit, delete a document and a base, the cap of 10 bases,
 * another member and a guest reaching nothing, and the team page at `/t/<team>/knowledge`. Own stack, in order, desktop unless a test says otherwise.
 */
test.describe.configure({ mode: 'serial' });

const RUNBOOK = '# Coffee corner\n\nThe espresso machine is descaled every second Tuesday. Ask Priya for the key.\n\n## Beans\n\nBeans come from the roaster on Elm Street.\n';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a member creates a base, uploads a file, finds a passage in it and then removes the file and the base', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout; the phone has its own test below');
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia', '/knowledge');
  try {
    await expect(page.getByTestId('knowledge-screen')).toBeVisible();
    await expect(page.getByTestId('personal-knowledge-empty')).toBeVisible();
    await expect(page.getByTestId('personal-knowledge-count')).toContainText('of 10');
    await expect(page.getByTestId('personal-knowledge-create')).toBeDisabled();

    await page.getByTestId('personal-knowledge-name').fill('Office notes');
    await page.getByTestId('personal-knowledge-create').click();
    const row = page.getByTestId('personal-knowledge-row').filter({ hasText: 'Office notes' });
    await expect(row).toHaveCount(1);
    await expect(page.getByTestId('personal-base-title')).toHaveText('Office notes');
    await expect(page.getByTestId('personal-base-empty')).toBeVisible();

    await page.getByTestId('personal-base-file').setInputFiles({ name: 'coffee-corner.md', mimeType: 'text/markdown', buffer: Buffer.from(RUNBOOK) });
    const doc = page.getByTestId('personal-base-doc');
    await expect(doc).toHaveCount(1);
    await expect(doc).toContainText('coffee-corner.md');
    await expect(doc).toContainText('version 1');
    await expect(doc).toContainText('Searchable');
    await expect(doc).toHaveAttribute('data-status', 'indexed');

    await page.getByTestId('personal-base-question').fill('when is the espresso machine descaled?');
    await page.getByTestId('personal-base-search').click();
    const hit = page.getByTestId('personal-base-hit').first();
    await expect(hit).toContainText('coffee-corner.md');
    await expect(hit).toContainText('version 1');
    await expect(hit).toContainText('descaled');

    await page.getByTestId('personal-base-question').fill('quantum chromodynamics lattice');
    await page.getByTestId('personal-base-search').click();
    // either nothing, or only weak matches; a search that finds nothing says so
    await expect(page.getByTestId('personal-base-hits').or(page.getByTestId('personal-base-nohits'))).toBeVisible();

    // the same file again changes nothing
    await page.getByTestId('personal-base-file').setInputFiles({ name: 'coffee-corner.md', mimeType: 'text/markdown', buffer: Buffer.from(RUNBOOK) });
    await expect(page.getByTestId('personal-base-notice')).toContainText('nothing changed');
    await expect(doc).toHaveCount(1);

    // remove the file, then the base
    await page.getByTestId('personal-base-doc-remove').click();
    await expect(page.getByTestId('personal-base-doc')).toHaveCount(0);
    await expect(page.getByTestId('personal-base-empty')).toBeVisible();
    await page.getByTestId('personal-base-delete').click();
    await page.getByTestId('personal-base-delete-confirm').click();
    await expect(page.getByTestId('personal-knowledge-row')).toHaveCount(0);
    await expect(page.getByTestId('personal-knowledge-empty')).toBeVisible();
  } finally {
    await close();
  }
});

test('another member cannot see, search or delete a base of Nadia; a guest has none at all', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    const made = await nadia.ctx.post('/api/me/knowledge', { data: { slug: 'private-notes', name: 'Private notes' }, headers: await nadia.headers() });
    expect(made.status()).toBeLessThan(300);
    const up = await nadia.ctx.post('/api/me/knowledge/private-notes/documents?name=secret.md', {
      headers: { ...(await nadia.headers()), 'content-type': 'text/markdown', 'x-file-name': 'secret.md' },
      data: Buffer.from('# Secret\n\nThe vault code is stored in the blue folder.\n'),
    });
    expect(up.status()).toBeLessThan(300);

    expect((await rafi.get<{ bases: unknown[] }>('/api/me/knowledge')).bases).toEqual([]);
    expect([403, 404]).toContain(await rafi.status('GET', '/api/me/knowledge/private-notes'));
    const found = await rafi.ctx.get('/api/me/knowledge/private-notes/search?q=vault');
    expect([403, 404]).toContain(found.status());
    const del = await rafi.ctx.delete('/api/me/knowledge/private-notes', { headers: await rafi.headers() });
    expect([403, 404]).toContain(del.status());
    // it is still there for her
    expect((await nadia.get<{ bases: Array<{ slug: string }> }>('/api/me/knowledge')).bases.map((b) => b.slug)).toContain('private-notes');

    expect(await lena.status('GET', '/api/me/knowledge')).toBe(403);
    expect(await lena.status('POST', '/api/me/knowledge', { slug: 'mine', name: 'Mine' })).toBe(403);
  } finally {
    await Promise.all([nadia.ctx.dispose(), rafi.ctx.dispose(), lena.ctx.dispose()]);
  }
});

test('a person has at most ten bases: the eleventh is refused, the screen says so, and deleting one makes room', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const api = await apiOn(playwright, stack, 'rafi');
  const { page, close } = await openMemory(browser, playwright, stack, 'rafi', '/knowledge');
  try {
    for (let i = 1; i <= 10; i += 1) {
      const res = await api.ctx.post('/api/me/knowledge', { data: { slug: `base-${i}`, name: `Base ${i}` }, headers: await api.headers() });
      expect(res.status(), `base ${i}: ${await res.text()}`).toBeLessThan(300);
    }
    const eleventh = await api.ctx.post('/api/me/knowledge', { data: { slug: 'base-11', name: 'Base 11' }, headers: await api.headers() });
    expect(eleventh.status()).toBeGreaterThanOrEqual(400);
    expect(eleventh.status()).toBeLessThan(500);
    expect((await api.get<{ bases: unknown[] }>('/api/me/knowledge')).bases).toHaveLength(10);

    await page.reload();
    await expect(page.getByTestId('personal-knowledge-row')).toHaveCount(10);
    await expect(page.getByTestId('personal-knowledge-count')).toContainText('10 bases of 10');
    await expect(page.getByTestId('personal-knowledge-count')).toContainText('Delete one to make another');
    // at the cap the name box and Create are both off (filling a disabled box would wait for the whole test timeout)
    await expect(page.getByTestId('personal-knowledge-name')).toBeDisabled();
    await expect(page.getByTestId('personal-knowledge-create')).toBeDisabled();

    const gone = await api.ctx.delete('/api/me/knowledge/base-10', { headers: await api.headers() });
    expect(gone.status()).toBeLessThan(300);
    await page.reload();
    await page.getByTestId('personal-knowledge-name').fill('One more');
    await expect(page.getByTestId('personal-knowledge-create')).toBeEnabled();
    await page.getByTestId('personal-knowledge-create').click();
    await expect(page.getByTestId('personal-knowledge-row').filter({ hasText: 'One more' })).toHaveCount(1);
    await expect(page.getByTestId('personal-knowledge-count')).toContainText('10 bases of 10');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('the team page at /t/engineering/knowledge lists the team’s bases and links back to Personal', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'desktop layout');
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia', '/t/engineering/knowledge');
  try {
    // the seeded team may or may not have a base: the list or the empty sentence, never neither
    await expect(page.getByTestId('team-knowledge-list').or(page.getByTestId('team-knowledge-empty'))).toBeVisible();
    await expect(page.getByTestId('space-switch')).toHaveAttribute('data-space', 'teams');
    await page.getByTestId('space-personal').click();
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(page.getByTestId('personal-knowledge')).toBeVisible();
  } finally {
    await close();
  }
});

test('on a phone the bases and the open base fit the width', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'priya');
  const { page, close } = await openMemory(browser, playwright, stack, 'priya', '/knowledge', { viewport: PHONE, mobile: true });
  try {
    const made = await api.ctx.post('/api/me/knowledge', { data: { slug: 'long', name: 'A base with a rather long name that has to wrap on a narrow screen' }, headers: await api.headers() });
    expect(made.status()).toBeLessThan(300);
    await page.reload();
    await expect(page.getByTestId('personal-knowledge-row').first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('personal-knowledge-row').first().click();
    await expect(page.getByTestId('personal-base-title')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});
