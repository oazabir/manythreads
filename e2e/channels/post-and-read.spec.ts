import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

/** PLAN criterion 1 (first half) and e2e/channels/post-and-read: Nadia posts, Rafi has the channel open and sees it live, in order; a reaction syncs. */
test('Nadia posts and Rafi, with the channel open, sees it within a second; a reaction syncs both ways', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'live');
  const nadiaApi = await apiAs('nadia');
  await postMessage(nadiaApi, id, 'Earlier: the build is green.');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const nadia = await openAs(browser, 'nadia', `/t/engineering/c/${name}`);
  try {
    await expect(messages(rafi.page)).toHaveCount(1);
    await expect(messages(nadia.page)).toHaveCount(1);

    const typed = 'Merged the **rollback** fix, see #' + name + ' for details';
    await nadia.page.getByRole('textbox', { name: `Message #${name}` }).fill(typed);
    await nadia.page.keyboard.press('Enter');

    // the author sees it at once, Rafi within a second, both in order, and the markdown is drawn, not shown raw
    await expect(messages(nadia.page)).toHaveCount(2);
    await expect(messages(rafi.page)).toHaveCount(2, { timeout: 1_000 });
    for (const page of [nadia.page, rafi.page]) {
      await expect(messages(page).nth(0)).toContainText('Earlier: the build is green.');
      await expect(messages(page).nth(1)).toContainText('Merged the rollback fix');
      await expect(messages(page).nth(1).locator('strong')).toHaveText('rollback');
      await expect(messages(page).nth(1).locator('.who b')).toHaveText('Nadia');
    }

    // Shift+Enter is a new line, not a send
    const box = rafi.page.getByRole('textbox', { name: `Message #${name}` });
    await box.fill('line one');
    await box.press('Shift+Enter');
    await box.pressSequentially('line two');
    await expect(messages(rafi.page)).toHaveCount(2);
    await box.press('Enter');
    await expect(messages(rafi.page)).toHaveCount(3);
    await expect(messages(nadia.page)).toHaveCount(3, { timeout: 1_000 });
    await expect(messages(nadia.page).nth(2).locator('.md p')).toContainText('line one');
    await expect(messages(nadia.page).nth(2).locator('.md br')).toHaveCount(1);

    // a reaction by Rafi shows on Nadia's screen with the count; Nadia adding hers makes it 2 and "mine"
    const first = messages(rafi.page).nth(0);
    await first.hover();
    await first.getByRole('button', { name: 'Add reaction' }).click();
    await rafi.page.getByRole('menuitem', { name: 'React with 👍' }).click();
    const onNadia = messages(nadia.page).nth(0).locator('.rx');
    await expect(onNadia).toHaveCount(1);
    await expect(onNadia).toContainText('👍');
    await expect(onNadia).toContainText('1');
    await expect(onNadia).toHaveAttribute('aria-pressed', 'false');
    await onNadia.click();
    await expect(onNadia).toContainText('2');
    await expect(onNadia).toHaveAttribute('aria-pressed', 'true');
    await expect(messages(rafi.page).nth(0).locator('.rx')).toContainText('2');
    // taking it back
    await onNadia.click();
    await expect(onNadia).toContainText('1');
    await expect(messages(rafi.page).nth(0).locator('.rx')).toContainText('1');
  } finally {
    await rafi.context.close();
    await nadia.context.close();
    await omar.ctx.dispose();
    await nadiaApi.ctx.dispose();
  }
});

test('edit and delete your own message, live for the other reader; empty channel and no-access copy', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'edit');
  const empty = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  try {
    await expect(empty.page.getByTestId('channel-start')).toContainText(`This is the start of #${name}.`);
  } finally {
    await empty.context.close();
  }
  const rafiApi = await apiAs('rafi');
  await postMessage(rafiApi, id, 'typo here');
  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const nadia = await openAs(browser, 'nadia', `/t/engineering/c/${name}`);
  try {
    const mine = messages(rafi.page).first();
    await expect(mine).toContainText('typo here');
    await mine.hover();
    await mine.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Edit' }).click();
    await rafi.page.getByRole('textbox', { name: 'Edit message' }).fill('fixed here');
    await rafi.page.keyboard.press('Enter');
    await expect(mine).toContainText('fixed here');
    await expect(mine).toContainText('(edited)');
    await expect(messages(nadia.page).first()).toContainText('fixed here', { timeout: 1_000 });

    // Nadia may not edit or delete Rafi's message (she is not a lead)
    await messages(nadia.page).first().hover();
    await expect(messages(nadia.page).first().getByRole('button', { name: 'More actions' })).toHaveCount(0);

    await mine.hover();
    await mine.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Delete…' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Delete message' }).click();
    await expect(messages(rafi.page)).toHaveCount(0);
    await expect(messages(nadia.page)).toHaveCount(0, { timeout: 1_000 });
  } finally {
    await rafi.context.close();
    await nadia.context.close();
  }

  // a channel that does not exist (or one the person cannot see) says the same thing
  const lost = await openAs(browser, 'nadia', '/t/engineering/c/does-not-exist');
  try {
    await expect(lost.page.getByTestId('no-access')).toContainText('You cannot see this channel.');
  } finally {
    await lost.context.close();
    await omar.ctx.dispose();
    await rafiApi.ctx.dispose();
  }
});
