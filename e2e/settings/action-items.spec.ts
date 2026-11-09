import { expect, test, type Page } from '@playwright/test';
import { personalRecipeById, type ListActionItemsResponse } from '@manythreads/shared';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';
import { brainReady, connectMail, listRoutines, messageOf, patchRoutine, routineStackEnv } from './routine-support.ts';

/*
 * Account > Action items (PLAN P20-12): the person's own list, `Action items/action-items.md` in their Personal space. They tick, edit and add items, turn one into a
 * card on a board, and may let a routine keep the list up to date (shown as a plan first, switched on only with a yes). Every change names the revision the list was
 * read at; a save made in between is a 409 and the screen reloads instead of overwriting it. The list is the person's own (guests: routines-privacy.spec.ts).
 * One stack per project, in order; each test says what it leaves behind.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack(routineStackEnv());
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    await brainReady(stack, nadia);
  } finally {
    await nadia.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
});

const open = (browser: Parameters<typeof openOn>[0], playwright: Parameters<typeof openOn>[1], isMobile: boolean, who: 'nadia' | 'rafi') =>
  openOn(browser, playwright, stack, who, '/account/action-items', isMobile ? { viewport: PHONE, mobile: true } : {});

const itemNamed = (page: Page, text: string) => page.getByTestId('action-item').filter({ has: page.getByTestId('action-item-text').filter({ hasText: text }) });
const listRoutinesOf = async (api: StackApi) => (await listRoutines(api)).items;
const listOf = (api: StackApi) => api.get<ListActionItemsResponse>('/api/me/action-items');
async function patchItems(api: StackApi, revision: string | null, body: Record<string, unknown>) {
  return api.ctx.patch('/api/me/action-items', { data: { revision, change: body }, headers: await api.headers() });
}

const QUOTE = 'Send the revised quote to Acme';

test('a new list is empty, and nothing keeps it up to date until the person says so', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Your action items' })).toBeVisible();
    await expect(page.getByTestId('action-items-count')).toHaveText('Nothing on your list yet.');
    await expect(page.getByTestId('action-item')).toHaveCount(0);
    await expect(page.getByTestId('keeper-off')).toBeVisible();
    await expect(page.getByTestId('keeper-on')).toHaveCount(0);
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await listOf(nadia)).toMatchObject({ items: [], fileId: null, revision: null, keeperRoutineId: null });
  } finally {
    await nadia.ctx.dispose();
  }
});

test('add: an item with a person and a day; an overdue day is marked, a later one is not', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    // the Add button waits for words
    await expect(page.getByTestId('action-item-add-button')).toBeDisabled();
    await page.getByTestId('action-item-what').fill(QUOTE);
    await page.getByTestId('action-item-owner').fill('Sam');
    await page.getByTestId('action-item-due').fill('2020-01-31');
    await page.getByTestId('action-item-add-button').click();
    const quote = itemNamed(page, QUOTE);
    await expect(quote).toHaveCount(1);
    await expect(quote.getByTestId('action-item-owner-text')).toHaveText('Sam');
    await expect(quote.getByTestId('action-item-due-text')).toHaveText('Was due 31 Jan');
    await expect(quote.getByTestId('action-item-due-text')).toHaveClass(/late/);
    // the form is empty again
    await expect(page.getByTestId('action-item-what')).toHaveValue('');

    await page.getByTestId('action-item-what').fill('Book the venue');
    await page.getByTestId('action-item-due').fill('2099-12-31');
    await page.getByTestId('action-item-add-button').click();
    const venue = itemNamed(page, 'Book the venue');
    await expect(venue).toHaveCount(1);
    await expect(venue.getByTestId('action-item-due-text')).toHaveText('Due 31 Dec');
    await expect(venue.getByTestId('action-item-due-text')).not.toHaveClass(/late/);
    await expect(page.getByTestId('action-items-count')).toContainText('2 to do, 0 done.');

    // it is the person's file, saved
    const saved = await listOf(nadia);
    expect(saved.items.map((i) => i.what)).toEqual([QUOTE, 'Book the venue']);
    expect(saved.items[0]).toMatchObject({ owner: 'Sam', due: '2020-01-31', done: false, cardTaskId: null });
    expect(saved.fileId).not.toBeNull();
    expect(saved.revision).not.toBeNull();
    if (isMobile) expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('tick moves an item to the done group, and unticking brings it back', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    // click, not check(): the box is controlled (it follows the server's answer), and check() fails when the state has not changed by the time it looks
    await itemNamed(page, 'Book the venue').getByTestId('action-item-tick').click();
    await expect(page.getByTestId('action-items-count')).toContainText('1 to do, 1 done.');
    await expect(page.getByTestId('action-items-open').getByTestId('action-item')).toHaveCount(1);
    await expect(page.getByTestId('action-items-done-group').locator(':scope > summary')).toHaveText('1 done');
    expect((await listOf(nadia)).items.find((i) => i.what === 'Book the venue')?.done).toBe(true);

    await page.getByTestId('action-items-done-group').locator(':scope > summary').click();
    const done = page.getByTestId('action-items-done').getByTestId('action-item');
    await expect(done).toHaveCount(1);
    await expect(done).toHaveAttribute('data-done', 'true');
    await done.getByTestId('action-item-tick').click();
    await expect(page.getByTestId('action-items-count')).toContainText('2 to do, 0 done.');
    await expect(page.getByTestId('action-items-done-group')).toHaveCount(0);
    expect((await listOf(nadia)).items.every((i) => !i.done)).toBe(true);
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('edit changes the words, the person and the day, and keeps the rest', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    // the row is found by its id: while it is being edited its words are an input, so a locator that looks for the words would lose it
    const id = await itemNamed(page, QUOTE).getAttribute('data-id');
    expect(id).toBeTruthy();
    const quote = page.locator(`[data-testid="action-item"][data-id="${id}"]`);
    await quote.getByTestId('action-item-edit').click();
    await expect(quote.getByTestId('action-item-edit-form')).toBeVisible();
    await expect(quote.getByTestId('action-item-edit-what')).toHaveValue(QUOTE);
    await quote.getByTestId('action-item-edit-what').fill(`${QUOTE} today`);
    await quote.getByTestId('action-item-edit-owner').fill('Rana');
    await quote.getByTestId('action-item-edit-due').fill('2099-01-15');
    await quote.getByTestId('action-item-edit-save').click();
    const edited = itemNamed(page, `${QUOTE} today`);
    await expect(edited).toHaveCount(1);
    await expect(edited.getByTestId('action-item-owner-text')).toHaveText('Rana');
    await expect(edited.getByTestId('action-item-due-text')).toHaveText('Due 15 Jan');
    const items = (await listOf(nadia)).items;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.what === `${QUOTE} today`)).toMatchObject({ owner: 'Rana', due: '2099-01-15', done: false });
    expect(items.some((i) => i.what === QUOTE)).toBe(false);
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('add to board makes a card on the team’s board and the list remembers it', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    const item = itemNamed(page, 'Book the venue');
    await item.getByTestId('action-item-to-board').click();
    await expect(item.getByTestId('action-item-board-form')).toBeVisible();
    await item.getByTestId('action-item-team').selectOption('engineering');
    await item.getByTestId('action-item-board-go').click();
    await expect(item.getByTestId('action-item-on-board')).toHaveText('On a board');
    await expect(item.getByTestId('action-item-board-form')).toHaveCount(0);
    // an item that is on a board offers no second card
    await expect(item.getByTestId('action-item-to-board')).toHaveCount(0);

    const saved = (await listOf(nadia)).items.find((i) => i.what === 'Book the venue')!;
    expect(saved.cardTaskId).not.toBeNull();
    const cards = await stack.sql<{ title: string; team: string }>('SELECT t.title, tm.slug AS team FROM app.tasks t JOIN app.teams tm ON tm.id = t.team_id WHERE t.id = $1', [saved.cardTaskId]);
    expect(cards).toEqual([{ title: 'Book the venue', team: 'engineering' }]);
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('a save made since the list was read is a 409, and the screen reloads instead of overwriting it', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  try {
    // the page has read the list before anyone else writes to it (the page is the older read)
    await expect(page.getByTestId('action-items-count')).toBeVisible();
    // through the route: the revision of an older read is refused with a sentence
    const old = (await listOf(nadia)).revision;
    const fresh = await patchItems(nadia, old, { op: 'add', what: 'Written by a second tab' });
    expect(fresh.status(), await fresh.text()).toBe(200);
    const stale = await patchItems(nadia, old, { op: 'add', what: 'Written from an old read' });
    expect(stale.status()).toBe(409);
    expect(await messageOf(stale)).toBe('The list changed since you opened it. It has been reloaded; try again.');
    expect((await listOf(nadia)).items.map((i) => i.what)).not.toContain('Written from an old read');

    // on the page: it was opened before that other save, so its next change is not saved; it says so and shows the list as it is now
    await expect(itemNamed(page, 'Written by a second tab')).toHaveCount(0);
    await itemNamed(page, 'Book the venue').getByTestId('action-item-tick').click();
    await expect(page.getByTestId('action-items-notice')).toHaveText('Your list changed while you were looking at it, so I reloaded it. Your change was not saved; please do it again.');
    await expect(itemNamed(page, 'Written by a second tab')).toHaveCount(1);
    // the tick was not saved
    expect((await listOf(nadia)).items.find((i) => i.what === 'Book the venue')?.done).toBe(false);
    await expect(itemNamed(page, 'Book the venue').getByTestId('action-item-tick')).not.toBeChecked();
    // doing it again works
    await itemNamed(page, 'Book the venue').getByTestId('action-item-tick').click();
    await expect.poll(async () => (await listOf(nadia)).items.find((i) => i.what === 'Book the venue')?.done).toBe(true);
  } finally {
    await context.close();
    await nadia.ctx.dispose();
  }
});

test('the list is one person’s own', async ({ playwright, isMobile }) => {
  test.skip(isMobile, 'a server-side rule; no layout is under test');
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    expect(await listOf(rafi)).toMatchObject({ items: [], fileId: null, keeperRoutineId: null });
    // an item id of someone else's list is not found in his
    const nadia = await apiOn(playwright, stack, 'nadia');
    try {
      const id = (await listOf(nadia)).items[0]!.id;
      const res = await patchItems(rafi, null, { op: 'tick', id, done: true });
      expect(res.status()).toBe(404);
    } finally {
      await nadia.ctx.dispose();
    }
  } finally {
    await rafi.ctx.dispose();
  }
});

test('the keeper routine is shown as a plan, turned on only with a yes, and needs the connection it reads', async ({ browser, playwright, isMobile }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const { page, context } = await open(browser, playwright, isMobile, 'nadia');
  let disconnect: (() => Promise<void>) | null = null;
  try {
    const recipe = personalRecipeById('action-items')!;
    await page.getByTestId('keeper-start').click();
    const plan = page.getByTestId('keeper-plan');
    await expect(plan).toBeVisible();
    await expect(plan).toContainText(recipe.name);
    await expect(plan).toContainText('It writes only to');
    // a plan is not a routine
    expect((await listRoutinesOf(nadia)).length).toBe(0);
    expect((await listOf(nadia)).keeperRoutineId).toBeNull();
    // "Not now" goes back to the start
    await page.getByTestId('keeper-cancel').click();
    await expect(page.getByTestId('keeper-plan')).toHaveCount(0);
    await expect(page.getByTestId('keeper-start')).toBeVisible();

    // the list reads mail, and Nadia has not connected it: the yes is refused in words and nothing is switched on
    await page.getByTestId('keeper-start').click();
    await page.getByTestId('keeper-confirm').click();
    await expect(page.getByTestId('keeper-error')).toHaveText('Connect your mail first (Account, then Connections), or take it out of this routine.');
    expect((await listRoutinesOf(nadia)).length).toBe(0);

    disconnect = await connectMail(stack, 'nadia@kahf.example');
    await page.getByTestId('keeper-confirm').click();
    await expect(page.getByTestId('keeper-on')).toBeVisible();
    await expect(page.getByTestId('keeper-link')).toHaveAttribute('href', '/account/routines');
    await expect(page.getByTestId('keeper-start')).toHaveCount(0);

    const list = await listOf(nadia);
    expect(list.keeperRoutineId).not.toBeNull();
    const keeper = (await listRoutines(nadia)).items.find((r) => r.id === list.keeperRoutineId)!;
    expect(keeper).toMatchObject({ recipeId: 'action-items', enabled: true, botSlug: 'brain' });
    expect(keeper.sources).toContain('action_items');

    // a paused keeper is no keeper: the page offers the plan again
    expect((await patchRoutine(nadia, keeper.id, { enabled: false })).status()).toBe(200);
    expect((await listOf(nadia)).keeperRoutineId).toBeNull();
    await page.reload();
    await expect(page.getByTestId('keeper-off')).toBeVisible();
  } finally {
    if (disconnect) await disconnect();
    await context.close();
    await nadia.ctx.dispose();
  }
});
