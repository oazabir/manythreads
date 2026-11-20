import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage } from './support.ts';

// PLAN P31-07: pin a message from its More menu, see the mark in a second tab at once, open the channel's pinned list from the details menu, jump to the
// message from it and unpin there. The desktop layout (hover actions); on a phone the same list is in the same details menu. A guest's view of pins is in
// guest-lena.spec.ts (it needs the seeded read grant).
test.skip(({ isMobile }) => isMobile, 'desktop layout');

test('pin, the live mark, the pinned list and unpin', async ({ browser }) => {
  const omar = await apiAs('omar');
  const { id, name } = await createChannel(omar, 'pins');
  const nadiaApi = await apiAs('nadia');
  await postMessage(nadiaApi, id, 'The rollback runbook is in pages/runbook.md');
  await postMessage(nadiaApi, id, 'A later message');

  const rafi = await openAs(browser, 'rafi', `/t/engineering/c/${name}`);
  const nadia = await openAs(browser, 'nadia', `/t/engineering/c/${name}`);
  try {
    const row = messages(rafi.page).filter({ hasText: 'rollback runbook' });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('pinned-mark')).toHaveCount(0);

    // pin from the More menu: the row says so here, and in Nadia's tab without a reload
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await rafi.page.getByRole('menuitem', { name: 'Pin to channel' }).click();
    await expect(row.getByRole('status')).toHaveText('Pinned to the channel');
    await expect(row.getByTestId('pinned-mark')).toBeVisible();
    await expect(messages(nadia.page).filter({ hasText: 'rollback runbook' }).getByTestId('pinned-mark')).toBeVisible();

    // the menu now offers the way back
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    await expect(rafi.page.getByRole('menuitem', { name: 'Unpin from channel' })).toBeVisible();
    await rafi.page.keyboard.press('Escape');

    // the pinned list, from the channel details menu, in the right panel
    await nadia.page.getByTestId('channel-details-button').click();
    await nadia.page.getByTestId('details-pins').click();
    const panel = nadia.page.getByTestId('pins-panel');
    await expect(panel.getByTestId('pin-row')).toHaveCount(1);
    await expect(panel.getByTestId('pin-row')).toContainText('rollback runbook');

    // Open jumps to the message in the channel
    await panel.getByTestId('pin-open').click();
    await expect(nadia.page).toHaveURL(/[?&]message=/);

    // unpin from the list: it empties here, and Rafi's mark goes
    await nadia.page.getByTestId('channel-details-button').click();
    await nadia.page.getByTestId('details-pins').click();
    await nadia.page.getByTestId('pins-panel').getByTestId('pin-unpin').click();
    await expect(nadia.page.getByTestId('pins-empty')).toBeVisible();
    await expect(row.getByTestId('pinned-mark')).toHaveCount(0);
  } finally {
    await rafi.context.close();
    await nadia.context.close();
  }
});
