import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * P21-09, the browser tab: the title says where the person is and how much waits ("(1) # dev — Engineering · Workspace"), the icon gets a dot
 * while something waits, a muted direct message does not count, and a page outside the shell still names itself. On a stack of its own: it
 * posts direct messages and reads them, which other specs on the shared server must not see.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout');
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

const icon = (page: Page): Promise<string | null> => page.locator('link#favicon').getAttribute('href');
const personId = async (api: StackApi): Promise<string> => (await api.get<{ person: { id: string } }>('/api/session')).person.id;
const dmWith = async (from: StackApi, to: StackApi): Promise<string> => (await from.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [await personId(to)] })).dm.channel.id;

test('the title names the page, the team and the workspace; the icon is the plain mark when nothing waits', async ({ browser, playwright }) => {
  const made = await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'tab-title' });
  expect(made.channel.id).toBeTruthy();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect(page).toHaveTitle(/^Threads — Engineering · .+/);
    expect(await icon(page)).toBe('/favicon.svg');

    await page.goto('/t/engineering/c/tab-title');
    await expect(page).toHaveTitle(/^# tab-title — Engineering · .+/);

    await page.goto('/t/engineering/boards');
    await expect(page).toHaveTitle(/^Boards — Engineering · .+/);
  } finally {
    await context.close();
  }
});

test('an unread direct message puts the count in the title and a dot on the icon; reading it takes both away', async ({ browser, playwright }) => {
  const dm = await dmWith(nadia, omar);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await postAs(nadia, dm, 'ping for the tab');
    // one message that is both a direct message and a bell item counts once
    await expect(page).toHaveTitle(/^\(1\) Threads — Engineering · /);
    await expect.poll(() => icon(page)).toMatch(/^data:image\/png/);
    await postAs(nadia, dm, 'a second ping');
    await expect(page).toHaveTitle(/^\(2\) Threads — Engineering · /);

    await page.locator(`[data-landmark="sidebar"] a.it[href$="/dm/${dm}"]`).click();
    // reading the conversation does not read the bell's items: the larger of the two counts stays until the bell is read too
    await expect(page).toHaveTitle(/^\(2\) Nadia — Engineering · /);
    await page.getByTestId('bell').click();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveTitle(/^Nadia — Engineering · |^Nadia · /);
    await expect.poll(() => icon(page)).toBe('/favicon.svg');
  } finally {
    await context.close();
  }
});

test('a muted direct message does not count', async ({ browser, playwright }) => {
  const dm = await dmWith(nadia, omar);
  const put = await omar.ctx.put(`/api/notifications/levels/${dm}`, { data: { level: 'nothing' }, headers: await omar.headers() });
  expect(put.status()).toBe(200);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await postAs(nadia, dm, 'quiet one');
    await expect(page.locator(`[data-landmark="sidebar"] a.it[href$="/dm/${dm}"] .pill`)).toHaveText('1');
    await expect(page).toHaveTitle(/^Threads — Engineering · /);
    expect(await icon(page)).toBe('/favicon.svg');
  } finally {
    await context.close();
    await omar.ctx.put(`/api/notifications/levels/${dm}`, { data: { level: 'all' }, headers: await omar.headers() });
  }
});

test('a page outside the shell names itself, and leaving the shell takes the count away', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/account/profile');
  try {
    await expect(page).toHaveTitle(/^Profile · .+/);
    await page.goto('/settings/workspace/general');
    await expect(page).toHaveTitle(/ · .+/);
    await expect(page).not.toHaveTitle(/^\(\d/);
    expect(await icon(page)).toBe('/favicon.svg');
  } finally {
    await context.close();
  }
});

test('the sign-in page names itself too', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: stack.origin });
  const page = await context.newPage();
  try {
    await page.goto('/sign-in');
    await expect(page).toHaveTitle(/^.+ · .+$/);
  } finally {
    await context.close();
  }
});
