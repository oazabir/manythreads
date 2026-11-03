import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Memory → Sharing (PLAN P8-26) end to end. The tab opens from its address and from a keyboard; a team that shares nothing says so; a team lead is offered New share and
 * its dialog tells what is missing before it creates anything; a member who is not a lead reads the page without New share; the workspace switch is on, an admin turns
 * it off and on again, and a member sees it locked. A real digest needs the Archivist and a second team that accepted, which a one-team stack does not have: the spec
 * asserts the pages and the routes, never that a digest was sent. One stack for the file (the specs write to it, in order).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/t/engineering/memory?tab=sharing';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the Sharing tab opens from its address and with the arrow keys, and an empty team says it shares nothing', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(page.getByTestId('memory-tab-sharing')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sharing-tab')).toBeVisible();
    await expect(page.getByTestId('shares-empty')).toBeVisible();
    await expect(page.getByTestId('requests-empty')).toBeVisible();
    await expect(page.getByTestId('received-empty')).toBeVisible();
    await page.getByTestId('memory-tab-sharing').focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('memory-tab-inbox')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('memory-tab-sharing')).toHaveAttribute('aria-selected', 'true');
  } finally {
    await context.close();
  }
});

test('New share says what is missing before it creates anything, and closes without leaving a file behind', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await page.getByTestId('share-new').click();
    const dialog = page.getByTestId('share-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('share-submit').click();
    await expect(page.getByTestId('share-problem')).toHaveText('Give the share a name.');
    await page.getByTestId('share-name-input').fill('Release notes');
    await expect(dialog).toContainText('routines/shares/release-notes.yaml');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('shares-empty')).toBeVisible();
  } finally {
    await context.close();
  }
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const list = await omar.get<{ shares: unknown[]; canManage: boolean }>('/api/teams/engineering/shares');
    expect(list.canManage).toBe(true);
    expect(list.shares).toHaveLength(0);
  } finally {
    await omar.ctx.dispose();
  }
});

test('a member who is not a lead reads the page without New share; a person outside the team is refused', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', PATH);
  try {
    await expect(page.getByTestId('sharing-tab')).toBeVisible();
    await expect(page.getByTestId('shares-empty')).toContainText('A team lead or a workspace admin can set one up.');
    await expect(page.getByTestId('share-new')).toHaveCount(0);
    await expect(page.getByTestId('share-run')).toHaveCount(0);
  } finally {
    await context.close();
  }
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    expect(await rafi.status('POST', '/api/teams/engineering/shares/none/run')).toBeGreaterThanOrEqual(400);
  } finally {
    await rafi.ctx.dispose();
  }
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    expect([403, 404]).toContain(await lena.status('GET', '/api/teams/engineering/shares'));
  } finally {
    await lena.ctx.dispose();
  }
});

test('the workspace Memory sharing switch is on; an admin turns it off and on; a member sees it locked', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/memory-sharing');
  try {
    await expect(page.getByTestId('memory-sharing')).toBeVisible();
    await expect(page.getByTestId('memory-sharing-state')).toHaveText('on');
    const toggle = page.getByRole('switch', { name: 'Let teams share memory' });
    await toggle.click();
    await expect(page.getByTestId('memory-sharing-state')).toHaveText('off');
    await page.goto(PATH);
    await expect(page.getByTestId('sharing-off')).toBeVisible();
    await page.goto('/settings/workspace/memory-sharing');
    await page.getByRole('switch', { name: 'Let teams share memory' }).click();
    await expect(page.getByTestId('memory-sharing-state')).toHaveText('on');
  } finally {
    await context.close();
  }
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const setting = await nadia.get<{ enabled: boolean; canChange: boolean }>('/api/workspace/memory-sharing');
    expect(setting).toMatchObject({ enabled: true, canChange: false });
  } finally {
    await nadia.ctx.dispose();
  }
});

test('on a phone the Sharing tab and its New share dialog fit the width, no sideways scroll', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('sharing-tab')).toBeVisible();
    await expect(page.getByTestId('share-new')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('share-new').click();
    await expect(page.getByTestId('share-dialog')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
