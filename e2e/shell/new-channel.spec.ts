import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * The sidebar's "New channel" button and unread rows (PLAN P14-15), on a stack of its own (the spec creates channels and reads them, which
 * other specs on the shared server must not see). Omar leads Engineering, so he is offered the button and makes a channel through the
 * dialog; Nadia is a plain member, so she is not offered it. The new public channel appears in Nadia's sidebar by itself, a message
 * from Omar makes her row bold with a count, opening it clears both, and a channel she set to "nothing" keeps a grey count and no bold.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop sidebar; the phone drawer holds the same rows (e2e/shell/shell.spec.ts)');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose()]);
  await stack?.stop();
});

const row = (page: import('@playwright/test').Page, name: string) => page.locator(`[data-landmark="sidebar"] a.it[href$="/c/${name}"]`);

test('a team lead makes a channel through the dialog, with plain answers to a bad or taken name', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await page.getByTestId('new-channel').click();
    const dlg = page.getByTestId('new-channel-dialog');
    await expect(dlg).toBeVisible();
    const name = page.getByTestId('new-channel-name');
    const create = page.getByTestId('new-channel-create');
    await expect(name).toBeFocused();
    await expect(create).toBeDisabled();

    // a name the server would refuse is explained before anything is sent, and cannot be sent
    await name.fill('-bad');
    await expect(page.getByTestId('new-channel-hint')).toContainText('lowercase letters, numbers and dashes');
    await expect(create).toBeDisabled();

    // a typed name is cleaned the way the server keeps it
    await name.fill('Launch Room');
    await expect(page.getByTestId('new-channel-hint')).toHaveText('It will be called #launch-room.');
    await page.getByTestId('new-channel-topic').fill('Plans for the launch');
    await expect(page.getByTestId('new-channel-public')).toBeChecked();

    // a name that is already there
    await name.fill('dev');
    await create.click();
    await expect(page.getByTestId('new-channel-error')).toHaveText('A channel named #dev already exists in this team. Pick another name.');
    await expect(dlg).toBeVisible();

    await name.fill('Launch Room');
    await create.click();
    await expect(dlg).toBeHidden();
    await expect(page).toHaveURL(/\/t\/engineering\/c\/launch-room$/);
    await expect(page.getByRole('textbox', { name: 'Message #launch-room' })).toBeVisible();
    await expect(row(page, 'launch-room')).toHaveClass(/\bon\b/);
    const created = (await omar.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels')).groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'launch-room');
    expect(created).toBeTruthy();
    const detail = await omar.get<{ channel: { purpose: string; private: boolean } }>(`/api/channels/${created!.id}`);
    expect(detail.channel).toMatchObject({ purpose: 'Plans for the launch', private: false });

    // Esc closes the dialog and creates nothing
    await page.getByTestId('new-channel').click();
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  } finally {
    await context.close();
  }
});

test('a private channel made through the dialog is not on a member\'s sidebar; a member is not offered the button', async ({ browser, playwright }) => {
  const lead = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  const member = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await expect(member.page.getByTestId('app-frame')).toBeVisible();
    await expect(member.page.locator('[data-landmark="sidebar"] .channel-groups .group').first()).toBeVisible();
    await expect(member.page.getByTestId('new-channel')).toHaveCount(0);
    // the server says the same
    expect(await nadia.status('POST', '/api/teams/engineering/channels', { name: 'not-allowed' })).toBe(403);

    await lead.page.getByTestId('new-channel').click();
    await lead.page.getByTestId('new-channel-name').fill('leads-only');
    await lead.page.getByTestId('new-channel-private').check();
    await lead.page.getByTestId('new-channel-create').click();
    await expect(lead.page).toHaveURL(/\/t\/engineering\/c\/leads-only$/);
    await expect(row(lead.page, 'leads-only').locator('svg')).toBeVisible(); // the lock

    // a public one made by the lead shows up for the member without a reload, a private one does not
    await expect(row(member.page, 'launch-room')).toBeVisible();
    await expect(row(member.page, 'leads-only')).toHaveCount(0);
  } finally {
    await Promise.all([lead.context.close(), member.context.close()]);
  }
});

test('a new message makes the row bold with a count for the second person, and opening the channel clears it live', async ({ browser, playwright }) => {
  const channels = (await nadia.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels')).groups.flatMap((g) => g.channels);
  const launch = channels.find((c) => c.name.replace(/^#/, '') === 'launch-room')!;
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    const link = row(page, 'launch-room');
    await expect(link).toBeVisible();
    await expect(link).not.toHaveClass(/unread/);
    await expect(link.locator('.pill')).toHaveCount(0);

    await postAs(omar, launch.id, 'first note');
    await postAs(omar, launch.id, 'second note');
    await expect(link).toHaveClass(/unread/);
    await expect(link.locator('.pill')).toHaveText('2');
    await expect(link.locator('.it-label')).toHaveCSS('font-weight', '600');

    await link.click();
    await expect(page).toHaveURL(/\/c\/launch-room$/);
    await expect(page.getByText('second note')).toBeVisible();
    await expect(link).not.toHaveClass(/unread/);
    await expect(link.locator('.pill')).toHaveCount(0);

    // while the channel is open a further message does not leave it unread
    await postAs(omar, launch.id, 'third note');
    await expect(page.getByText('third note')).toBeVisible();
    await expect(link.locator('.pill')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a conversation set to "nothing" keeps a grey count and no bold label; a direct message is bold with a count', async ({ browser, playwright }) => {
  const channels = (await nadia.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels')).groups.flatMap((g) => g.channels);
  const launch = channels.find((c) => c.name.replace(/^#/, '') === 'launch-room')!;
  const put = await nadia.ctx.put(`/api/notifications/levels/${launch.id}`, { data: { level: 'nothing' }, headers: await nadia.headers() });
  expect(put.status()).toBe(200);
  const nadiaId = (await nadia.get<{ person: { id: string } }>('/api/session')).person.id;
  const dm = (await omar.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [nadiaId] })).dm;

  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    const link = row(page, 'launch-room');
    await expect(link).toBeVisible();
    await postAs(omar, launch.id, 'quiet note');
    await expect(link.locator('.pill')).toHaveText('1');
    await expect(link.locator('.pill')).toHaveClass(/\bg\b/);
    await expect(link).not.toHaveClass(/unread/);

    await postAs(omar, dm.channel.id, 'hello Nadia');
    const dmRow = page.locator(`[data-landmark="sidebar"] a.it[href$="/dm/${dm.channel.id}"]`);
    await expect(dmRow).toHaveClass(/unread/);
    await expect(dmRow.locator('.pill')).toHaveText('1');
    await dmRow.click();
    await expect(dmRow).not.toHaveClass(/unread/);
    await expect(dmRow.locator('.pill')).toHaveCount(0);

    // opening the quiet channel clears its count too
    await link.click();
    await expect(link.locator('.pill')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
