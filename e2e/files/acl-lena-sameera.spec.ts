import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn } from '../support/stack-browser.ts';
import { STACK_ENV, apiOn } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/acl-lena-sameera.spec.ts` (criterion 6): the tree follows the folder's ACL. Lena (a guest granted #releases only) is
 * refused `#dev` attachments, Sameera (Customer support) is refused Engineering's tree, Nadia (Engineering) is refused Marketing's: the screen says
 * "You do not have access" and the API answers 403 for the tree, the repo and the bytes. Read-only, on a stack of its own with seed v4 content.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');

const DENIED = 'You do not have access';

let stack: Stack;
let devFileId = '';
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...STACK_ENV });
  const nadia = await apiOn(playwright, stack, 'nadia');
  const tree = await nadia.get<{ entries: { fileId: string | null; name: string }[] }>('/api/teams/engineering/files/tree?path=channels/dev');
  devFileId = tree.entries.find((e) => e.name === 'latency-before-after.png')?.fileId ?? '';
  expect(devFileId).not.toBe('');
  await nadia.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('Lena, a guest, gets 403 on #dev attachments and on the tree, and the screen says so', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'lena');
  try {
    expect(await api.status('GET', '/api/teams/engineering/files/tree?path=channels/dev')).toBe(403);
    expect(await api.status('GET', '/api/teams/engineering/files/tree')).toBe(403);
    expect(await api.status('GET', '/api/teams/engineering/repo/tree')).toBe(403);
    expect(await api.status('GET', `/api/files/${devFileId}`)).toBe(403);
    expect(await api.status('GET', `/api/files/${devFileId}/content`)).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/t/engineering/files?path=channels/dev');
  try {
    await expect(page.getByTestId('files-denied')).toContainText(DENIED);
    await expect(page.getByTestId('file-row')).toHaveCount(0);
    // a guest's sidebar has no Files
    await expect(page.locator('[data-landmark="sidebar"]')).not.toContainText('Files');
    // a link to the attachment in a panel says the same
    await page.goto(`${stack.origin}/t/engineering/files?panel=file:${devFileId}`);
    await expect(page.locator('[data-landmark="right-panel"]')).toContainText(DENIED);
  } finally {
    await context.close();
  }
});

test('Sameera, of another team, is refused Engineering: 403 everywhere, and the screen says so', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'sameera');
  try {
    expect(await api.status('GET', '/api/teams/engineering/files/tree')).toBe(403);
    expect(await api.status('GET', '/api/teams/engineering/files/tree?path=channels/dev')).toBe(403);
    expect(await api.status('GET', '/api/teams/engineering/repo/blob?path=pages/runbook.md')).toBe(403);
    expect(await api.status('GET', '/api/teams/engineering/repo/history?path=pages/runbook.md')).toBe(403);
    expect(await api.status('GET', `/api/files/${devFileId}/content`)).toBe(403);
    // and a write is refused too
    expect(await api.status('POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path: 'pages/x.md', content: 'x\n', encoding: 'utf8' }], message: 'x' })).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'sameera', '/t/engineering/files');
  try {
    await expect(page.locator('[data-landmark="content"]')).toContainText(DENIED);
    await expect(page.getByTestId('file-row')).toHaveCount(0);
    // her own team's tree works
    await page.goto(`${stack.origin}/t/customer-support/files`);
    await expect(page.getByTestId('files-screen')).toBeVisible();
    await expect(page.locator('[data-testid="tree-node"][data-path="pages"]')).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Nadia is refused Marketing's tree", async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await api.status('GET', '/api/teams/marketing/files/tree')).toBe(403);
    expect(await api.status('GET', '/api/teams/marketing/repo/tree')).toBe(403);
    expect(await api.status('GET', '/api/teams/marketing/files/tree?path=channels/general')).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/marketing/files');
  try {
    await expect(page.locator('[data-landmark="content"]')).toContainText(DENIED);
    await expect(page.getByTestId('file-row')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
