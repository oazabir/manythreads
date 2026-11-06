import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, PHONE, type StackApi } from '../support/stack-browser.ts';

/*
 * Custom board columns (PLAN P6-14): a lead adds a column that counts as a task state, moves it with Alt+Arrow, drags a card into it
 * (the place survives a reload), is refused when deleting a column that holds a card, and a member sees none of the column controls. On
 * a phone the column menu's Move left does what the keyboard does. The spec starts its own stack, so the board it edits is its own.
 */
test.skip(({ isMobile }) => isMobile, 'the phone has its own test below');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 10_000 });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let boardId = '';
let cardId = '';
const CARD = 'Check the rota page';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  boardId = (await omar.post<{ board: { id: string } }>('/api/teams/engineering/boards', { name: 'Columns board' })).board.id;
  cardId = (await omar.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title: CARD, description: '', kind: 'other', priority: 'normal', branch: 'task/rota' })).task.id;
  await nadia.post(`/api/teams/engineering/tasks/${cardId}/claim`);
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

const columnNames = (page: import('@playwright/test').Page) => page.getByTestId('column-name').allTextContents();

test('a lead adds QA as a Verify column, moves it, drags a card in and cannot delete it while it holds the card', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${boardId}`);
  try {
    await expect(page.getByTestId('board-column')).toHaveCount(5);
    await page.getByTestId('add-column').click();
    await page.getByTestId('add-column-name').fill('QA');
    await page.getByTestId('add-column-state').selectOption('verify');
    await page.getByTestId('add-column-save').click();
    await expect(page.getByTestId('board-column')).toHaveCount(6);
    expect((await columnNames(page)).at(-1)).toBe('QA');

    // Alt+Arrow on the grip moves the column and the live region says where it went
    await page.getByRole('button', { name: 'Move column QA' }).focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.getByTestId('board-live')).toHaveText('QA is now column 5 of 6');
    await expect.poll(async () => (await columnNames(page)).indexOf('QA')).toBe(4);
    await page.reload();
    expect((await columnNames(page)).indexOf('QA')).toBe(4);

    // the card (In progress) is dragged into QA: the move to Verify runs through the task rules, and the place is kept
    const qa = page.locator('[data-testid="board-column"][aria-label="QA"]');
    await page.locator(`[data-testid="board-card"][data-task="${cardId}"]`).dragTo(qa);
    await expect(qa.locator(`[data-testid="board-card"][data-task="${cardId}"]`)).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-testid="board-column"][aria-label="QA"]').locator(`[data-testid="board-card"][data-task="${cardId}"]`)).toBeVisible();
    await expect(page.locator('[data-testid="board-column"][data-state="verify"][aria-label="Verify"] [data-testid="board-card"]')).toHaveCount(0);

    // a column that holds a card cannot be deleted; the refusal says how many
    await qa.getByTestId('column-menu').click();
    await qa.getByTestId('column-delete').click();
    await qa.getByTestId('column-delete-confirm').click();
    await expect(page.getByTestId('board-refusal')).toContainText('1 card is in QA');
    await expect(page.getByTestId('board-column')).toHaveCount(6);
  } finally {
    await context.close();
  }
});

test('a rename shows at once, and a member sees no column controls', async ({ browser, playwright }) => {
  const lead = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${boardId}`);
  try {
    const qa = lead.page.locator('[data-testid="board-column"][aria-label="QA"]');
    await qa.getByTestId('column-menu').click();
    await qa.getByTestId('column-rename').click();
    await lead.page.getByTestId('column-rename-input').fill('Testing');
    await lead.page.keyboard.press('Enter');
    await expect(lead.page.locator('[data-testid="board-column"][aria-label="Testing"]')).toBeVisible();
  } finally {
    await lead.context.close();
  }
  const member = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/boards?board=${boardId}`);
  try {
    await expect(member.page.locator('[data-testid="board-column"][aria-label="Testing"]')).toBeVisible();
    await expect(member.page.getByTestId('column-grip')).toHaveCount(0);
    await expect(member.page.getByTestId('column-menu')).toHaveCount(0);
    await expect(member.page.getByTestId('add-column')).toHaveCount(0);
  } finally {
    await member.context.close();
  }
});

test('on a phone the column menu moves a column left', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${boardId}`, { viewport: PHONE, mobile: true });
  try {
    const before = await columnNames(page);
    const last = page.locator('[data-testid="board-column"]').last();
    await last.scrollIntoViewIfNeeded();
    await last.getByTestId('column-menu').click();
    await last.getByTestId('column-left').click();
    await expect.poll(async () => (await columnNames(page)).at(-2)).toBe(before.at(-1));
  } finally {
    await context.close();
  }
});
