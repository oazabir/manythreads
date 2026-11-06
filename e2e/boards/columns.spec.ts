import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, PHONE, type StackApi } from '../support/stack-browser.ts';

/*
 * Custom board columns (PLAN P6-14): a lead adds a column that counts as a task state, moves it with Alt+Arrow, drags a card into it
 * (the place survives a reload), is refused when deleting a column that holds a card, and a member sees none of the column controls. On
 * a phone the column menu's Move left does what the keyboard does. The spec starts its own stack, so the board it edits is its own.
 */
test.skip(({ isMobile }) => isMobile, 'the tests set their own viewport; the mobile-web project adds nothing');
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
    await expect.poll(async () => (await columnNames(page)).indexOf('QA')).toBe(4);

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

/* A board of its own per test below, so the order of the tests above cannot change what these see. */
const freshBoard = async (name: string): Promise<string> => (await omar.post<{ board: { id: string } }>('/api/teams/engineering/boards', { name })).board.id;
const columnsPath = (id: string) => `/api/teams/engineering/boards/${id}/columns`;
const newCard = async (title: string): Promise<string> =>
  (await omar.post<{ task: { id: string } }>('/api/teams/engineering/tasks', { title, description: '', kind: 'other', priority: 'normal', branch: `task/${title.toLowerCase().replace(/\W+/g, '-')}` })).task.id;

test('the options menu opens on its first button, and Esc closes it and gives the focus back to the options button', async ({ browser, playwright }) => {
  const id = await freshBoard('Keyboard board');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${id}`);
  try {
    const first = page.getByTestId('board-column').first();
    const options = first.getByTestId('column-menu');
    await options.focus();
    await page.keyboard.press('Enter');
    await expect(options).toHaveAttribute('aria-expanded', 'true');
    await expect(first.getByTestId('column-rename')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(first.getByRole('group')).toHaveCount(0);
    await expect(options).toBeFocused();
    await expect(options).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await context.close();
  }
});

test('Esc in the rename box keeps the old name, nothing is saved', async ({ browser, playwright }) => {
  const id = await freshBoard('Rename board');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${id}`);
  try {
    const first = page.getByTestId('board-column').first();
    const before = (await first.getByTestId('column-name').textContent()) ?? '';
    await first.getByTestId('column-menu').click();
    await first.getByTestId('column-rename').click();
    const input = page.getByTestId('column-rename-input');
    await input.fill('Half typed');
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(first.getByTestId('column-name')).toHaveText(before);
    // the server still has the old name (read after a reload, so a late save would show)
    await page.reload();
    await expect(page.getByTestId('board-column').first().getByTestId('column-name')).toHaveText(before);
    expect((await omar.get<{ board: { columns: Array<{ name: string }> } }>(`/api/teams/engineering/boards/${id}`)).board.columns.map((c) => c.name)).not.toContain('Half typed');
  } finally {
    await context.close();
  }
});

test('at 12 columns Add column is disabled and says why', async ({ browser, playwright }) => {
  const id = await freshBoard('Full board');
  for (let i = 0; i < 7; i += 1) await omar.post(columnsPath(id), { name: `Extra ${i + 1}`, state: 'in_progress' });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${id}`);
  try {
    await expect(page.getByTestId('board-column')).toHaveCount(12);
    const add = page.getByTestId('add-column');
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute('title', 'A board holds at most 12 columns');
    expect(await omar.status('POST', columnsPath(id), { name: 'One too many', state: 'open' })).toBeGreaterThanOrEqual(400);
  } finally {
    await context.close();
  }
});

test('deleting a column that holds cards shows the server sentence and keeps the column', async ({ browser, playwright }) => {
  const id = await freshBoard('Delete board');
  await newCard('First held card');
  await newCard('Second held card');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${id}`);
  try {
    const open = page.locator('[data-testid="board-column"][data-state="open"]').first();
    await expect(open.getByTestId('board-card').filter({ hasText: 'Second held card' })).toBeVisible();
    await expect(open.getByTestId('board-card').filter({ hasText: 'First held card' })).toBeVisible();
    const held = await open.getByTestId('board-card').count();
    await open.getByTestId('column-menu').click();
    await open.getByTestId('column-delete').click();
    await open.getByTestId('column-delete-confirm').click();
    await expect(page.getByTestId('board-refusal')).toContainText(`${held} cards are in Open; move them first`);
    await expect(page.getByTestId('board-column')).toHaveCount(5);
    await expect(open.getByTestId('board-card')).toHaveCount(held);
  } finally {
    await context.close();
  }
});

test('dragging a card to another column of the same state keeps its state and moves its place', async ({ browser, playwright }) => {
  const id = await freshBoard('Same state board');
  const card = await newCard('Same state card');
  await omar.post(columnsPath(id), { name: 'Doing 2', state: 'open' });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${id}`);
  try {
    const mine = (col: string) => page.locator(`[data-testid="board-column"][aria-label="${col}"] [data-testid="board-card"][data-task="${card}"]`);
    await expect(mine('Open')).toBeVisible();
    // the strip scrolls sideways: bring the target fully into the window before the drag, so its centre is under the pointer
    const doing2 = page.locator('[data-testid="board-column"][aria-label="Doing 2"]');
    await doing2.scrollIntoViewIfNeeded();
    await mine('Open').dragTo(doing2);
    await expect(mine('Doing 2')).toBeVisible();
    await expect(mine('Open')).toHaveCount(0);
    await expect(mine('Doing 2')).toHaveAttribute('data-state', 'open');
    await page.reload();
    await expect(mine('Doing 2')).toBeVisible();
    const places = await omar.get<{ places: Array<{ taskId: string; columnId: string }> }>(`/api/teams/engineering/boards/${id}/places`);
    const doing = (await omar.get<{ board: { columns: Array<{ id: string; name: string }> } }>(`/api/teams/engineering/boards/${id}`)).board.columns.find((c) => c.name === 'Doing 2');
    expect(places.places.find((p) => p.taskId === card)?.columnId).toBe(doing?.id);
    expect((await omar.get<{ task: { state: string } }>(`/api/teams/engineering/tasks/${card}`)).task.state).toBe('open');
  } finally {
    await context.close();
  }
});

test('on a phone the column menu is not clipped: every button is inside the screen and is what a tap would hit', async ({ browser, playwright }) => {
  const id = await freshBoard('Clip board');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${id}`, { viewport: PHONE, mobile: true });
  try {
    // the first column is empty-ish and the last is at the far end of the strip: the two worst places for an absolute menu
    for (const which of ['first', 'last'] as const) {
      const col = page.locator('[data-testid="board-column"]')[which]();
      await col.scrollIntoViewIfNeeded();
      await col.getByTestId('column-menu').click();
      const buttons = col.locator('.bd-col-menu button');
      await expect(buttons.first()).toBeFocused();
      const n = await buttons.count();
      expect(n).toBe(4);
      for (let i = 0; i < n; i += 1) {
        const b = buttons.nth(i);
        await b.scrollIntoViewIfNeeded();
        const box = await b.boundingBox();
        expect(box, `button ${i} of the ${which} column has a box`).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 0.5);
        const hit = await b.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return top === el || el.contains(top);
        });
        expect(hit, `button ${i} of the ${which} column is what is under its own centre`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(buttons).toHaveCount(0);
    }
  } finally {
    await context.close();
  }
});

test('on a phone the column menu moves a column left', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/boards?board=${boardId}`, { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('board-column')).toHaveCount(6);
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
