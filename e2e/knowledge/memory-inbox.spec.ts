import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, noSidewaysScroll, openOn, postAs } from '../support/stack-browser.ts';

/*
 * Memory → Inbox (PLAN P8-21) end to end. A person pastes a note in the New note dialog and sees it in the queue; the filters count what is there; the Files
 * root has an `inbox/` row that opens the Inbox; a team member who is not a lead reads the queue but is not offered Release, Discard or Retry; a person
 * outside the team is refused. The team's email address shows only when the server sends one: the stack's server may not, and then the page says nothing about it.
 *
 * What a note becomes depends on the Archivist and the model behind it, which a stack does not have. So the spec asserts the note is on the queue in some state
 * and never that it was filed. One stack for the file (the specs write to it, in order).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/t/engineering/memory?tab=inbox';
const NOTE = 'Standup notes, Monday';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a person pastes a note and it is on the queue, with the filters counting it', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH);
  try {
    await expect(page.getByTestId('memory-tab-inbox')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('inbox-tab')).toBeVisible();
    await expect(page.getByTestId('inbox-dropzone')).toBeVisible();
    await expect(page.getByTestId('inbox-empty')).toBeVisible();

    await page.getByTestId('inbox-new-note').click();
    const dialog = page.getByTestId('inbox-note-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('inbox-note-submit')).toBeDisabled();
    await dialog.getByLabel('Title (optional)').fill(NOTE);
    await page.getByTestId('inbox-note-text').fill('The release moves to Friday. Rafi owns the changelog.');
    await page.getByTestId('inbox-note-submit').click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId('inbox-item').filter({ hasText: NOTE });
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('inbox-item-state')).toBeVisible();
    await expect(page.getByTestId('inbox-count-all')).toHaveText('1');
    await expect(page.getByTestId('inbox-empty')).toHaveCount(0);
    for (const id of ['processing', 'needs_review', 'held', 'filed', 'failed']) await expect(page.getByTestId(`inbox-filter-${id}`)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the same note again is told to the sender as already in the inbox', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const again = await nadia.post<{ duplicate: boolean }>('/api/teams/engineering/inbox/notes', {
      title: NOTE,
      text: 'The release moves to Friday. Rafi owns the changelog.',
      teamOnly: false,
    });
    expect(again.duplicate).toBe(true);
  } finally {
    await nadia.ctx.dispose();
  }
});

test('a team member who is not a lead reads the queue without Release, Discard or Retry; a person outside the team is refused', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', PATH);
  try {
    // the second drop of the same text is listed too, as a duplicate of the first
    await expect(page.getByTestId('inbox-item').filter({ hasText: NOTE }).first()).toBeVisible();
    await expect(page.getByTestId('inbox-release')).toHaveCount(0);
    await expect(page.getByTestId('inbox-discard')).toHaveCount(0);
    await expect(page.getByTestId('inbox-retry')).toHaveCount(0);
  } finally {
    await context.close();
  }
  const lena = await apiOn(playwright, stack, 'lena');
  try {
    expect([403, 404]).toContain(await lena.status('GET', '/api/teams/engineering/inbox/items'));
  } finally {
    await lena.ctx.dispose();
  }
});

test('the email address is shown only when the server sends one', async ({ browser, playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  let address: string | null = null;
  try {
    const list = await omar.get<{ emailAddress?: string | null }>('/api/teams/engineering/inbox/items');
    address = list.emailAddress ?? null;
  } finally {
    await omar.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(page.getByTestId('inbox-tab')).toBeVisible();
    if (address) await expect(page.getByTestId('inbox-email-address')).toHaveText(address);
    else await expect(page.getByTestId('inbox-email')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the Files root has an inbox row, and it opens the Memory inbox', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/files');
  try {
    const inbox = page.locator('[data-testid="file-row"][data-path="inbox"]');
    await expect(inbox).toBeVisible();
    await expect(inbox).toContainText('Memory inbox');
    await inbox.click();
    await expect(page).toHaveURL(/\/t\/engineering\/memory\?tab=inbox/);
    await expect(page.getByTestId('inbox-tab')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('on a phone the inbox fits the width: drop zone, filters and cards, no sideways scroll', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH, { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('inbox-dropzone')).toBeVisible();
    await expect(page.getByTestId('inbox-item').filter({ hasText: NOTE }).first()).toBeVisible();
    await expect(page.getByTestId('inbox-new-note')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('inbox-new-note').click();
    await expect(page.getByTestId('inbox-note-dialog')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('Send to memory is in a message’s menu and puts the message in the inbox', async ({ browser, playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  let before = 0;
  try {
    before = (await nadia.get<{ items: unknown[] }>('/api/teams/engineering/inbox/items')).items.length;
    const general = (await channelsOf(nadia))['general'];
    if (!general) throw new Error('the seeded team has no general channel');
    await postAs(nadia, general, 'Decision: we move the release to Friday so QA has two days.');
  } finally {
    await nadia.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  try {
    const message = page.getByTestId('message').filter({ hasText: 'we move the release to Friday' }).first();
    await message.hover();
    await message.getByRole('button', { name: 'More actions' }).click();
    await page.getByTestId('send-to-memory').click();
    const dialog = page.getByTestId('send-to-memory-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('send-to-memory-help')).toContainText('Engineering’s memory inbox');
    await page.getByTestId('send-to-memory-submit').click();
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
  const after = await apiOn(playwright, stack, 'nadia');
  try {
    expect((await after.get<{ items: unknown[] }>('/api/teams/engineering/inbox/items')).items).toHaveLength(before + 1);
  } finally {
    await after.ctx.dispose();
  }
});
