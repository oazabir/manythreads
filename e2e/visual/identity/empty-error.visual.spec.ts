import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { expectWireframe, openPage } from '../support/vt.ts';

/*
 * Empty and error states (PLAN phase 2 section 2: "Create your first team.", expired invite, 403 with a way back). Class W, own
 * baselines: empty-teams.png (a new workspace whose admin has made no team yet), expired-invite.png (an invitation link that
 * does not exist, which reads the same as one that expired or was used), forbidden.png (Lena, a guest, opens Engineering).
 */
let seeded: Stack;
let empty: Stack;
test.beforeAll(async () => {
  [seeded, empty] = await Promise.all([startStack(), startStack({ MANYTHREADS_STACK_SEED: 'none' })]);
});
test.afterAll(async () => {
  await Promise.all([seeded?.stop(), empty?.stop()]);
});

test('empty teams matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, empty, null);
  try {
    await page.goto(`/bootstrap/${empty.bootstrapToken}`);
    await page.getByLabel('Workspace').fill('Kahf Software');
    await page.getByLabel('Name', { exact: true }).fill('Omar Al Zabir');
    await page.getByLabel('Email').fill('omar@kahf.example');
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Kahf Software' })).toBeVisible();
    await page.goto('/teams');
    await expect(page.getByText('Create your first team.')).toBeVisible();
    await expectWireframe(page, 'empty-teams', [['nav', 'content'], ['title', 'lede', 'empty', 'picker']]);
  } finally {
    await close();
  }
});

test('expired invitation matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, seeded, null);
  try {
    await page.goto('/invite/0123456789abcdef0123456789abcdef0123456789abcdef');
    await expect(page.getByRole('heading', { name: 'This invitation has expired' })).toBeVisible();
    await expectWireframe(page, 'expired-invite', ['content']);
  } finally {
    await close();
  }
});

test('403 matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, seeded, 'lena');
  try {
    await page.goto('/teams/engineering');
    await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to manythreads' }).first()).toBeVisible();
    await expectWireframe(page, 'forbidden', ['nav', 'content']);
  } finally {
    await close();
  }
});
