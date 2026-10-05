import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { actorOf, commitsOf } from '../files/support.ts';
import { apiOn } from '../support/stack-browser.ts';
import { BOTS_STACK_ENV, BOT_MD, commitDefinition, definitionOf, openBot } from './support.ts';

/*
 * The BOT.md editor (PLAN P5-05): a team lead changes a bot on its page and Save is one commit in his name; the loader picks it up and the
 * roster and the page follow. Omar leads Engineering, so `bots/` is his to write directly (the repo writer agrees). It also covers the
 * refusal a lead gets when someone changed the file while the page was open: nothing is overwritten (409). Runs on its own stack because
 * it commits to the team repo.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ ...BOTS_STACK_ENV });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('a lead edits the definition in the page: one commit by him, and the loader reloads the row from it', async ({ browser, playwright }) => {
  const before = await commitsOf(stack);
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder');
  try {
    const role = page.getByTestId('bot-role');
    await expect(role).toHaveValue('Writes and reviews code changes for the Engineering team');
    await role.fill('Reviews the Engineering team’s code changes');
    await expect(role).toHaveValue('Reviews the Engineering team’s code changes');
    await expect(page.getByTestId('dirty-state')).toContainText('Unsaved changes');
    await page.getByTestId('save-bot').click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByTestId('dirty-state')).toContainText('No changes');
    const omar = await apiOn(playwright, stack, 'omar');
    const { content } = await definitionOf(omar);
    await omar.ctx.dispose();
    expect(content).toContain('role: Reviews the Engineering team’s code changes');
    // the page reloaded the file it wrote: the value it shows is the one the loader reads
    await expect(role).toHaveValue('Reviews the Engineering team’s code changes');
  } finally {
    await close();
  }

  const after = await commitsOf(stack);
  expect(after.length).toBe(before.length + 1);
  expect(after[0]?.authorId).toBe(actorOf('omar'));
  expect(after[0]?.paths).toEqual([BOT_MD]);
  expect(after[0]?.message).toContain('coder');

  // the loader copied the new role onto the row: the roster shows it too
  const { page: rosterPage, close: closeRoster } = await openBot(browser, playwright, stack, 'omar', 'coder', '?tab=identity');
  try {
    await expect(rosterPage.getByTestId('bot-role')).toHaveValue('Reviews the Engineering team’s code changes');
  } finally {
    await closeRoster();
  }
});

test('the capabilities tab edits the one allowlist and the file it writes is the loader’s own shape', async ({ browser, playwright }) => {
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder', '?tab=capabilities');
  try {
    await expect(page.getByTestId('pane-capabilities')).toContainText('Never bot-writable');
    const native = page.getByTestId('caps-native');
    await expect(native).toContainText('none');
    await native.getByLabel('Add granted').fill('messages.post');
    await native.getByRole('button', { name: 'Add' }).click();
    await expect(native.locator('.b-chip.on')).toContainText('messages.post');
    await expect(page.getByTestId('dirty-state')).toContainText('Unsaved changes');
    await page.getByTestId('save-bot').click();
    await expect(page.getByRole('status')).toContainText('Saved');
  } finally {
    await close();
  }

  // the repo file now holds the capability under the loader's own key, which is what makes it load again
  const omar = await apiOn(playwright, stack, 'omar');
  const { content } = await definitionOf(omar);
  await omar.ctx.dispose();
  expect(content).toContain('capabilities:');
  expect(content).toContain('messages.post');
});

test('a definition someone else changed while the page was open is refused, not overwritten', async ({ browser, playwright }) => {
  const { page, close } = await openBot(browser, playwright, stack, 'omar', 'coder');
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await page.getByTestId('bot-role').fill('A role the page never saved');
    // someone else commits behind the page's back
    const base = await definitionOf(omar);
    await commitDefinition(omar, base.content.replace(/^role: .*$/m, 'role: Changed by someone else'), 'Change Coder elsewhere', base.blobSha);

    await page.getByTestId('save-bot').click();
    await expect(page.getByRole('alert')).toContainText('Someone changed this definition while you were editing');
    // the draft stays on screen and the other person's version is what the repo holds
    await expect(page.getByTestId('bot-role')).toHaveValue('A role the page never saved');
    const { content } = await definitionOf(omar);
    expect(content).toContain('role: Changed by someone else');
    expect(content).not.toContain('A role the page never saved');
  } finally {
    await omar.ctx.dispose();
    await close();
  }
});
