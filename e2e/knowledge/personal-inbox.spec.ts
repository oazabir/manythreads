import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn } from '../support/stack-browser.ts';
import { dropFile, inboxOf, memoryPaths, openMemory, settled } from './personal-support.ts';

/*
 * Personal inbox (PLAN P20-05, P20-04 screens): the Inbox tab of `/memory`. A person drops a file or pastes a note; the platform reads it and files it as a
 * Reference in their own memory (no Archivist, no git). Covers: a note goes queued, filing, filed and the link opens the file; another member's inbox is
 * empty; a memory bundle from elsewhere is held and "Let it through" ends in a plain "cannot be imported"; Discard asks first; Send to team copies the item
 * into the team's inbox. Own stack, in order, desktop only.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const INBOX = '/memory?tab=inbox';
const NOTE_TITLE = 'Standup, Monday';
const NOTE_TEXT = 'The release moves to Friday. Rafi owns the changelog.';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a note is dropped, goes through the queue to filed, and its link opens the file in Nadia’s memory', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia', INBOX);
  try {
    await expect(page.getByTestId('personal-inbox-tab')).toBeVisible();
    await expect(page.getByTestId('personal-inbox-dropzone')).toBeVisible();
    await expect(page.getByTestId('personal-inbox-empty')).toBeVisible();

    await page.getByTestId('personal-inbox-new-note').click();
    const dialog = page.getByRole('dialog');
    await expect(page.getByTestId('personal-note-submit')).toBeDisabled();
    await dialog.getByLabel('Title (optional)').fill(NOTE_TITLE);
    await page.getByTestId('personal-note-text').fill(NOTE_TEXT);
    await page.getByTestId('personal-note-submit').click();
    await expect(dialog).toBeHidden();

    const card = page.getByTestId('personal-inbox-item').filter({ hasText: NOTE_TITLE });
    await expect(card).toHaveCount(1);
    await expect(page.getByTestId('personal-inbox-count-all')).toHaveText('1');
    await expect(page.getByTestId('personal-inbox-empty')).toHaveCount(0);
    for (const id of ['processing', 'held', 'filed', 'failed']) await expect(page.getByTestId(`personal-inbox-filter-${id}`)).toBeVisible();
    // there is no "needs review" for a person's own inbox: the owner is the reviewer
    await expect(page.getByTestId('personal-inbox-filter-needs_review')).toHaveCount(0);

    // the screen follows the item while it moves; it ends filed, with a Reference
    await expect(card).toHaveAttribute('data-state', 'filed', { timeout: 60_000 });
    await expect(page.getByTestId('personal-inbox-count-filed')).toHaveText('1');
    const item = (await inboxOf(api, 'filed'))[0];
    expect(item?.space).toMatch(/^person:/);
    expect(item?.filedPaths.some((p) => p.includes('references/'))).toBe(true);
    expect(await memoryPaths(api)).toEqual(expect.arrayContaining(item!.filedPaths.filter((p) => p.includes('references/')).map((p) => (p.startsWith('memory/') ? p : `memory/${p}`))));

    // follow the link: the Memory tab opens that file
    const link = card.getByTestId('personal-inbox-concept-link').or(card.getByTestId('personal-inbox-reference-link')).first();
    await link.click();
    await expect(page).toHaveURL(/\/memory\?concept=/);
    await expect(page.getByTestId('personal-concept-detail')).toBeVisible();
    await expect(page.getByTestId('personal-file-text')).toContainText('Rafi owns the changelog');
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('Rafi’s inbox is empty and a link to Nadia’s item or file shows him nothing', async ({ browser, playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  const rafi = await apiOn(playwright, stack, 'rafi');
  const { page, close } = await openMemory(browser, playwright, stack, 'rafi', INBOX);
  try {
    const hers = (await inboxOf(nadia))[0]!;
    await expect(page.getByTestId('personal-inbox-empty')).toBeVisible();
    expect(await inboxOf(rafi)).toEqual([]);
    expect(await rafi.status('GET', `/api/me/inbox/items/${hers.id}`)).toBe(404);
    expect(await rafi.status('POST', `/api/me/inbox/items/${hers.id}/send-to-team`, { teamSlug: 'engineering' })).toBe(404);
    await expect(page.getByText(NOTE_TITLE)).toHaveCount(0);
  } finally {
    await close();
    await nadia.ctx.dispose();
    await rafi.ctx.dispose();
  }
});

test('a memory bundle from elsewhere is held; "Let it through" ends in a plain "cannot be imported", and the item can be discarded', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'rafi');
  const { page, close } = await openMemory(browser, playwright, stack, 'rafi', INBOX);
  try {
    const dropped = await dropFile(api, 'someones-memory.zip', 'PK\u0003\u0004 not really a zip', 'application/zip');
    await settled(api, dropped.id, ['held']);
    await page.reload();
    const card = page.getByTestId('personal-inbox-item').filter({ hasText: 'someones-memory.zip' });
    await expect(card).toHaveAttribute('data-state', 'held');
    await expect(page.getByTestId('personal-inbox-count-held')).toHaveText('1');
    // the server's own sentence for the hold (the card shows it before its generic wording)
    await expect(card.getByTestId('personal-inbox-item-sentence')).toContainText('memory bundle from somewhere else');
    await expect(card.getByTestId('personal-inbox-item-sentence')).toContainText('Release it only if you trust where it came from');
    await expect(card.getByTestId('personal-inbox-release')).toBeVisible();
    await expect(card.getByTestId('personal-inbox-discard')).toBeVisible();
    await expect(card.getByTestId('personal-inbox-retry')).toHaveCount(0);

    await card.getByTestId('personal-inbox-release').click();
    await expect(card).toHaveAttribute('data-state', 'failed', { timeout: 60_000 });
    await expect(card.getByTestId('personal-inbox-item-sentence')).toContainText('Importing a bundle is not available yet');
    // nothing was filed in the memory
    expect((await inboxOf(api, 'failed'))[0]?.filedPaths ?? []).toEqual([]);

    // Discard asks first; "Keep it" style cancel leaves the item, the confirm removes it
    await card.getByTestId('personal-inbox-discard').click();
    await expect(card.getByTestId('personal-inbox-discard-confirm')).toBeVisible();
    expect((await inboxOf(api)).map((i) => i.id)).toContain(dropped.id);
    await card.getByTestId('personal-inbox-discard-confirm').click();
    await expect(page.getByTestId('personal-inbox-item').filter({ hasText: 'someones-memory.zip' })).toHaveCount(0);
    expect((await inboxOf(api)).map((i) => i.id)).not.toContain(dropped.id);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});

test('Send to team drops a copy in the team’s inbox and keeps the personal item', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'nadia');
  const { page, close } = await openMemory(browser, playwright, stack, 'nadia', INBOX);
  try {
    const mine = (await inboxOf(api, 'filed'))[0]!;
    const card = page.getByTestId('personal-inbox-item').filter({ hasText: NOTE_TITLE });
    await expect(card).toHaveAttribute('data-state', 'filed');
    await card.getByTestId('personal-inbox-send-to-team').click();
    const dialog = page.getByRole('dialog');
    await expect(page.getByTestId('personal-send-team-help')).toContainText('your copy stays in your inbox');
    await expect(page.getByTestId('personal-send-team-select')).toBeVisible();
    await page.getByTestId('personal-send-team-select').selectOption('engineering');
    await page.getByTestId('personal-send-team-submit').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('personal-inbox-status')).toContainText(/engineering/i);

    // the team's inbox has a copy as Nadia; hers is still where it was
    const team = await api.get<{ items: Array<{ name: string }> }>('/api/teams/engineering/inbox/items');
    expect(team.items.some((i) => i.name.includes(NOTE_TITLE.split(',')[0]!))).toBe(true);
    expect((await inboxOf(api)).map((i) => i.id)).toContain(mine.id);
    // the same item sent again is a duplicate, not a second copy
    const again = await api.post<{ duplicate: boolean }>(`/api/me/inbox/items/${mine.id}/send-to-team`, { teamSlug: 'engineering' });
    expect(again.duplicate).toBe(true);
  } finally {
    await close();
    await api.ctx.dispose();
  }
});
