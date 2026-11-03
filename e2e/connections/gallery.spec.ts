import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * The Add connection gallery and the sign-in apps (PLAN P16-01, P16-02) end to end. The gallery lists the connector catalog with a search and nine shelves; what is
 * built can be added (a mailbox) or connected by each person (Google), what is only planned is greyed with its reason and does nothing. A workspace admin enters
 * the app a provider signs people in with; the secret is typed once, is in no page and no answer, and a person then sees the provider as set up.
 *
 * The sign-in against a provider itself (PKCE, incremental scopes, renewal, revoke) needs a provider to answer; it is covered against the fake provider in
 * packages/plugins/connections/test/oauth-helper.test.ts, and what only a real Google or Microsoft can confirm is listed in docs/plugins/connections.md.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const SECRET = 'workspace-microsoft-secret-SENTINEL-91c7';
let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({
    MANYTHREADS_STACK_SEED: 'repo',
    MANYTHREADS_OAUTH_GOOGLE_CLIENT_ID: 'e2e-google-client-id',
    MANYTHREADS_OAUTH_GOOGLE_CLIENT_SECRET: 'e2e-google-client-secret-SENTINEL',
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('search finds a connector by what it does, a shelf narrows the list, and a connector that is not built yet is greyed with its reason', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/team/engineering/connections');
  try {
    await page.getByTestId('connection-add').click();
    const gallery = page.getByTestId('connector-gallery');
    await expect(gallery).toBeVisible();
    await expect(page.getByTestId('connector-card-email')).toBeVisible();

    await page.getByTestId('connector-search').fill('calendar');
    await expect(page.getByTestId('connector-card-google')).toBeVisible();
    await expect(page.getByTestId('connector-card-microsoft')).toBeVisible();
    await expect(page.getByTestId('connector-card-ssh')).toHaveCount(0);

    await page.getByTestId('connector-search').fill('');
    await page.getByTestId('connector-category-tickets').click();
    await expect(page.getByTestId('connector-category-tickets')).toHaveAttribute('aria-pressed', 'true');
    const freshdesk = page.getByTestId('connector-card-freshdesk');
    await expect(freshdesk).toHaveAttribute('data-status', 'planned');
    await expect(page.getByTestId('connector-soon-freshdesk')).toHaveText('Not available yet');
    await expect(freshdesk.locator('.cg-reason')).not.toBeEmpty();
    // a planned connector offers no button at all
    await expect(freshdesk.getByRole('button')).toHaveCount(0);
    await expect(freshdesk.getByRole('link')).toHaveCount(0);

    await page.getByTestId('connector-category-all').click();
    await page.getByTestId('connector-search').fill('zzzzqq');
    await expect(page.getByTestId('connector-empty')).toBeVisible();
    await expect(page.getByTestId('connector-count')).toHaveText('0 connectors');
  } finally {
    await context.close();
  }
});

test('a connector each person signs in to sends them to their connected accounts', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/team/engineering/connections');
  try {
    await page.getByTestId('connection-add').click();
    await page.getByTestId('connector-search').fill('google');
    await page.getByTestId('connector-personal-google').click();
    await expect(page).toHaveURL(/\/settings\/connections$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Connected accounts' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('an admin enters the Microsoft app: the secret goes in once, is never shown again, and people then see Microsoft as set up', async ({ browser, playwright }) => {
  const admin = await openOn(browser, playwright, stack, 'omar', '/settings/connections/apps');
  try {
    const page = admin.page;
    await expect(page.getByRole('heading', { level: 1, name: 'Sign-in apps' })).toBeVisible();
    const card = page.locator('[data-testid="oauth-app"][data-provider="microsoft"]');
    await expect(card).toHaveAttribute('data-source', 'none');
    await expect(card).toContainText('/api/me/connections/microsoft/callback');
    await card.getByTestId('oauth-app-edit').click();
    const form = card.getByTestId('oauth-app-form');
    await form.getByLabel('Client id').fill('e2e-microsoft-client-id');
    await form.getByTestId('oauth-app-secret').fill(SECRET);
    await expect(form.getByTestId('oauth-app-secret')).toHaveAttribute('type', 'password');
    await form.getByTestId('oauth-app-save').click();
    await expect(card).toHaveAttribute('data-source', 'workspace');
    await expect(card.getByTestId('oauth-app-client')).toContainText('e2e-microsoft-client-id');
    await expect(card.getByTestId('oauth-app-client')).toContainText('cannot be shown');
    expect(await page.content()).not.toContain(SECRET);
  } finally {
    await admin.context.close();
  }

  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const listed = JSON.stringify(await omar.get('/api/admin/connections/oauth-apps'));
    expect(listed).toContain('e2e-microsoft-client-id');
    expect(listed).not.toContain(SECRET);
    expect(await stack.sql("SELECT 1 FROM app.events WHERE payload::text LIKE '%' || $1 || '%'", [SECRET])).toHaveLength(0);
    expect(await stack.sql("SELECT 1 FROM app.connection_oauth_apps WHERE workspace_id IS NOT NULL AND row_to_json(connection_oauth_apps)::text LIKE '%' || $1 || '%'", [SECRET])).toHaveLength(0);
    expect(await stack.sql('SELECT 1 FROM app.connection_oauth_app_secrets')).toHaveLength(1);
  } finally {
    await omar.ctx.dispose();
  }

  const person = await openOn(browser, playwright, stack, 'nadia', '/settings/connections');
  try {
    const microsoft = person.page.locator('[data-testid="person-provider"][data-provider="microsoft"]');
    await expect(microsoft).toHaveAttribute('data-configured', 'true');
    await expect(microsoft.getByTestId('person-connect')).toBeEnabled();
  } finally {
    await person.context.close();
  }
});

test('only a workspace admin can reach the sign-in apps', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/settings/connections/apps');
  try {
    await expect(page.getByTestId('oauth-apps')).toHaveCount(0);
  } finally {
    await context.close();
  }
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    expect(await nadia.status('GET', '/api/admin/connections/oauth-apps')).toBe(403);
  } finally {
    await nadia.ctx.dispose();
  }
});

test('the gallery fits a phone', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/team/engineering/connections', { viewport: PHONE, mobile: true });
  try {
    await page.getByTestId('connection-add').click();
    await expect(page.getByTestId('connector-gallery')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
