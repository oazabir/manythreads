import { expect, test, type Page } from '@playwright/test';
import { CONNECTION_ADMIN_ONLY } from '@manythreads/shared';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Team settings → Connections and Account → Connections (PLAN P8-06) end to end. A workspace admin adds a mailbox in the Add connection flow (Kubernetes is
 * listed but shut, with its reason), stores a credential, switches it on and off, changes it and removes it. The credential is typed once: it is in no page, no
 * answer of the API and no line the server wrote. A team member who is not an admin reads the list and one plain sentence that says who can add. The account
 * page shows a person's own connections (none yet) and the mail option that waits for the mail transport.
 *
 * One stack for the file (the specs write to it, in order).
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PASSWORD = 'mailbox-password-SENTINEL-4f2a91';
const PATH = '/settings/team/engineering/connections';

let stack: Stack;

const row = (page: Page, slug: string) => page.locator(`[data-testid="connection-row"][data-connection="${slug}"]`);

test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('an admin adds a mailbox: Kubernetes is shut with its reason, the credential goes in once and the row only says it is stored', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connections', exact: true })).toBeVisible();
    await expect(page.getByTestId('connection-empty')).toContainText('No connection yet');
    await expect(page.getByTestId('connection-status')).toHaveAttribute('role', 'status');

    await page.getByTestId('connection-add').click();
    const chooser = page.getByTestId('connection-add-chooser');
    await expect(chooser).toBeVisible();
    // the gallery lists what is built (a mailbox, SSH, Kubernetes) and, greyed with a reason, what is only planned (P16-01)
    await expect(page.getByTestId('connection-kind-kubernetes')).toBeVisible();
    await expect(page.getByTestId('connector-soon-hubspot')).toHaveText('Not available yet');
    await page.getByTestId('connection-kind-email').click();

    const form = page.getByTestId('connection-add-form');
    await form.getByLabel('Name').fill('Support mailbox');
    await expect(form.getByLabel('Short name')).toHaveValue('support-mailbox');
    await form.getByTestId('connection-credential').fill(PASSWORD);
    await expect(form.getByTestId('connection-credential')).toHaveAttribute('type', 'password');
    await page.getByTestId('connection-add-submit').click();

    await expect(form).toBeHidden();
    await expect(page.getByTestId('connection-status')).toContainText('Support mailbox was added and is on.');
    const mailbox = row(page, 'support-mailbox');
    await expect(mailbox.getByTestId('connection-state')).toHaveText(/On/);
    await expect(mailbox.getByTestId('connection-credential-line')).toContainText('A credential is stored. It cannot be shown again.');
    // the value is nowhere on the page
    expect(await page.content()).not.toContain(PASSWORD);
  } finally {
    await context.close();
  }
});

test('the API never hands the credential back, and nothing the server wrote holds it', async ({ playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const text = JSON.stringify(await omar.get('/api/teams/engineering/connections'));
    expect(text).toContain('support-mailbox');
    expect(text).not.toContain(PASSWORD);
    const inEvents = await stack.sql("SELECT 1 FROM app.events WHERE payload::text LIKE '%' || $1 || '%'", [PASSWORD]);
    expect(inEvents).toHaveLength(0);
    const audited = await stack.sql("SELECT payload->>'change' AS change FROM app.events WHERE type = 'connections.connection.changed' ORDER BY id");
    expect(audited.map((r) => r['change'])).toEqual(['created', 'credential_set', 'switched']);
  } finally {
    await omar.ctx.dispose();
  }
});

test('an admin switches it off and on, changes the name and the end date, and removes it', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const mailbox = row(page, 'support-mailbox');
    await mailbox.getByRole('switch', { name: 'Use Support mailbox' }).click();
    await expect(page.getByTestId('connection-status')).toContainText('Support mailbox is off.');
    await expect(mailbox.getByTestId('connection-state')).toHaveText(/Off/);
    await mailbox.getByRole('switch', { name: 'Use Support mailbox' }).click();
    await expect(page.getByTestId('connection-status')).toContainText('Support mailbox is on.');

    await mailbox.getByTestId('connection-change').click();
    const form = page.getByTestId('connection-change-form');
    await form.getByLabel('Name').fill('Sales mailbox');
    await form.getByLabel('Stops working on (optional)').fill('2099-12-31');
    await page.getByTestId('connection-change-submit').click();
    await expect(form).toBeHidden();
    await expect(row(page, 'support-mailbox')).toContainText('Sales mailbox');
    await expect(row(page, 'support-mailbox')).toContainText('Stops working');

    await row(page, 'support-mailbox').getByTestId('connection-remove').click();
    await page.getByTestId('connection-remove-confirm').click();
    await expect(page.getByTestId('connection-status')).toContainText('Sales mailbox was removed.');
    await expect(page.getByTestId('connection-empty')).toBeVisible();
    const left = await stack.sql('SELECT 1 FROM app.connection_secrets');
    expect(left).toHaveLength(0);
  } finally {
    await context.close();
  }
});

test('a team member who is not an admin reads the page and is told, in plain words, who can add a connection', async ({ browser, playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    await omar.post('/api/teams/engineering/connections', { kind: 'email', name: 'Shared mailbox' });
  } finally {
    await omar.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH);
  try {
    await expect(page.getByTestId('connection-admin-only')).toHaveText(CONNECTION_ADMIN_ONLY);
    await expect(page.getByTestId('connection-add')).toHaveCount(0);
    await expect(row(page, 'shared-mailbox')).toBeVisible();
    await expect(row(page, 'shared-mailbox').getByRole('switch')).toHaveCount(0);
    await expect(page.getByTestId('connection-change')).toHaveCount(0);
  } finally {
    await context.close();
  }
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await nadia.status('POST', '/api/teams/engineering/connections', { kind: 'email', name: 'Sneaky' })).toBe(403);
  } finally {
    await nadia.ctx.dispose();
  }
});

test('the account page lists a person’s own connections and says the mail option waits for the mail transport', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account');
  try {
    await page.getByTestId('account-connections-link').click();
    await expect(page).toHaveURL(/\/account\/connections$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
    await expect(page.getByTestId('my-connections-empty')).toBeVisible();
    await expect(page.getByTestId('my-mail')).toContainText('mail transport');
    await expect(page.getByTestId('my-mail-optin')).toBeDisabled();
  } finally {
    await context.close();
  }
});

test('the team page fits a phone without sideways scrolling', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Connections' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
