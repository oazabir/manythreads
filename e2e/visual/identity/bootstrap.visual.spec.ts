import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { expectWireframe, openPage } from '../support/vt.ts';

/*
 * First-admin bootstrap (PLAN phase 2 section 2 wireframe, class W) on an empty database: the one-time link of a server that
 * has no workspace yet, form filled in, password rule satisfied. Own baseline: bootstrap.png.
 */
let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'none' });
  expect(stack.bootstrapToken, 'the empty stack printed a first-admin link').toBeTruthy();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('bootstrap matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, null);
  try {
    await page.goto(`/bootstrap/${stack.bootstrapToken}`);
    await page.getByLabel('Workspace').fill('Kahf Software');
    await page.getByLabel('Name', { exact: true }).fill('Omar Al Zabir');
    await page.getByLabel('Email').fill('omar@kahf.example');
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
    await page.getByLabel('Password', { exact: true }).blur();
    await expectWireframe(page, 'bootstrap', ['header', 'title', 'form', 'footer']);
  } finally {
    await close();
  }
});
