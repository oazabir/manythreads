import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Settings > Members (PLAN P21-19, POLISH 6.2): a picture and name per row, last active, a search box, a row menu (Change role, Send a password
 * reset; no removal) and an Invite people button. The stack is the spec's own: it changes a role and creates an invitation.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const rowOf = (page: import('@playwright/test').Page, email: string) => page.getByTestId('member-row').filter({ hasText: email });

test('search, row menu change role, invite people', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/members');
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
    const rows = page.getByTestId('member-row');
    await expect(rows).toHaveCount(7);
    await expect(page.getByRole('columnheader', { name: 'Last active' })).toBeVisible();
    // a picture (initials on a disc) beside every name; Omar signed in just now, Rafi never did
    await expect(rows.first().locator('.av')).toBeVisible();
    await expect(rowOf(page, 'omar@kahf.example')).toContainText('Active now');
    await expect(rowOf(page, 'rafi@kahf.example')).toContainText('Never signed in');

    // the search box keeps the people whose name or email has the words, and says so when nobody does
    const search = page.getByRole('searchbox', { name: 'Search people' });
    await search.fill('NADIA');
    await expect(rows).toHaveCount(1);
    await expect(rowOf(page, 'nadia@kahf.example')).toBeVisible();
    await search.fill('kahf.example');
    await expect(rows).toHaveCount(7);
    await search.fill('nobody-by-this-name');
    await expect(page.getByTestId('members-none')).toBeVisible();
    await search.fill('');
    await expect(rows).toHaveCount(7);

    // the row menu: two items, Escape closes it and gives focus back; there is no way to remove a person here
    const rafiMenu = page.getByRole('button', { name: 'Options for Rafi' });
    await rafiMenu.click();
    await expect(page.getByRole('menuitem')).toHaveText(['Change role', 'Send a password reset']);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(rafiMenu).toBeFocused();

    // you do not change your own role from here
    await page.getByRole('button', { name: 'Options for Omar' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Send a password reset']);
    await page.keyboard.press('Escape');

    // Change role: the dialog saves through PATCH /api/workspace/members/:id and the row shows the new role
    await rafiMenu.click();
    await page.getByRole('menuitem', { name: 'Change role' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change role for Rafi' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save role' })).toBeDisabled();
    await dialog.getByLabel('Role').selectOption('admin');
    await dialog.getByRole('button', { name: 'Save role' }).click();
    await expect(dialog).toBeHidden();
    await expect(rowOf(page, 'rafi@kahf.example')).toContainText('admin');
    await expect(page.getByTestId('member-note')).toContainText('Rafi is now an admin.');
    // it was saved on the server, not only drawn: a reload still shows it
    await page.reload();
    await expect(rowOf(page, 'rafi@kahf.example')).toContainText('admin');

    // and back: the spec leaves the person as it found them (the stack is its own and is dropped, but a later test in this file reads the list)
    await rafiMenu.click();
    await page.getByRole('menuitem', { name: 'Change role' }).click();
    const back = page.getByRole('dialog', { name: 'Change role for Rafi' });
    await expect(back.getByLabel('Role')).toHaveValue('admin');
    await back.getByLabel('Role').selectOption('member');
    await back.getByRole('button', { name: 'Save role' }).click();
    await expect(back).toBeHidden();
    await expect(page.getByTestId('member-note').last()).toContainText('Rafi is now a member.');
    await expect(rowOf(page, 'rafi@kahf.example')).toContainText('member');

    // Send a password reset
    await rafiMenu.click();
    await page.getByRole('menuitem', { name: 'Send a password reset' }).click();
    await expect(page.getByTestId('member-note').last()).toContainText('rafi@kahf.example');

    // Invite people: cancel changes nothing, sending shows the one-time link
    await page.getByRole('button', { name: 'Invite people' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite people' });
    await expect(invite.getByLabel('Email')).toBeFocused();
    await invite.getByRole('button', { name: 'Cancel' }).click();
    await expect(invite).toBeHidden();
    await page.getByRole('button', { name: 'Invite people' }).click();
    await invite.getByLabel('Email').fill('new.person@kahf.example');
    await invite.getByLabel('Role').selectOption('member');
    await invite.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByTestId('invite-link')).toContainText('/invite/');
    await expect(page.getByRole('dialog', { name: 'Invitation ready' })).toContainText('new.person@kahf.example');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('on a phone the rows stack, the menu opens and nothing scrolls sideways', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/members', { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('member-row').first()).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    // the two controls above the list are on screen at 390 px
    await expect(page.getByRole('searchbox', { name: 'Search people' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Invite people' })).toBeInViewport();
    // a long address wraps inside its card instead of pushing the page sideways
    await page.getByRole('searchbox', { name: 'Search people' }).fill('kahf.example');
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByRole('searchbox', { name: 'Search people' }).fill('');
    await page.getByRole('button', { name: 'Options for Nadia' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= PHONE.width).toBe(true);
    await page.keyboard.press('Escape');
    // the settings select keeps the groups as optgroups
    const groups = await page.locator('#settings-section optgroup').evaluateAll((os) => os.map((o) => (o as HTMLOptGroupElement).label));
    expect(groups).toEqual(expect.arrayContaining(['Account', 'People', 'Bots and models', 'Security', 'Operations', 'Teams']));
  } finally {
    await context.close();
  }
});
