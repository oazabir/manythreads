import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Connected accounts (`/settings/connections`, PLAN P8-02) end to end. The stack has a Google app set up (a made-up client id and secret) and no Microsoft or
 * Notion app. Google is listed as not connected with its read-only services ticked, Microsoft and Notion say plainly that they are not set up on this server and
 * cannot be started. Connect asks the server for the provider's page and sends the browser there (the spec answers that address itself, so nothing leaves the
 * machine). The way back from a provider, `?connected=` or `?connect_error=`, is turned into a sentence and then taken out of the address. The page links to
 * the account Connections screen and back. A phone fits the width.
 *
 * No real sign-in happens, so there is nothing to disconnect on the real stack: the disconnect call is read as an API answer ("nothing was connected").
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/settings/connections';
let stack: Stack;

const provider = (page: Page, id: string) => page.locator(`[data-testid="person-provider"][data-provider="${id}"]`);

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

test('the page lists every provider of the catalog (Google first); the two without an app say they are not set up and cannot be started', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH);
  try {
    await expect(page.getByRole('heading', { level: 1, name: 'Connected accounts' })).toBeVisible();
    await expect(page.getByTestId('person-provider')).toHaveCount(11);
    await expect(page.getByTestId('person-status')).toHaveAttribute('role', 'status');

    const google = provider(page, 'google');
    await expect(google).toHaveAttribute('data-configured', 'true');
    await expect(google).toHaveAttribute('data-connected', 'false');
    await expect(google.getByTestId('person-state')).toHaveText(/Not connected/);
    await expect(google.getByTestId('person-connect')).toBeEnabled();
    await expect(google.getByTestId('person-disconnect')).toHaveCount(0);
    // reads are ticked to begin with, mail and anything that changes something outside are not
    await expect(google.locator('[data-service="drive"] input')).toBeChecked();
    await expect(google.locator('[data-service="gmail"] input')).not.toBeChecked();
    await expect(google.locator('[data-service="calendar_write"] input')).not.toBeChecked();

    for (const id of ['microsoft', 'notion']) {
      const p = provider(page, id);
      await expect(p).toHaveAttribute('data-configured', 'false');
      await expect(p.getByTestId('person-state')).toHaveText(/Not set up on this server/);
      await expect(p.getByTestId('person-not-configured')).toContainText('is not set up on this server yet');
      await expect(p.getByTestId('person-not-configured')).toContainText('/api/me/connections/');
      await expect(p.getByTestId('person-connect')).toBeDisabled();
    }
    // the secret is nowhere on the page
    expect(await page.content()).not.toContain('SENTINEL');
  } finally {
    await context.close();
  }
});

test('Connect asks the server for the provider’s page and sends the browser there with what was ticked', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH);
  try {
    let asked: URL | null = null;
    await page.route('https://accounts.google.com/**', async (route) => {
      asked = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Provider</title><p>provider page</p>' });
    });
    const google = provider(page, 'google');
    await google.locator('[data-service="calendar"] input').uncheck();
    const started = page.waitForResponse((r) => r.url().endsWith('/api/me/connections/google/start') && r.request().method() === 'POST');
    await google.getByTestId('person-connect').click();
    const response = await started;
    expect(response.status()).toBe(200);
    // the read-only services are ticked to begin with (the catalog may start more than Drive); the one unticked and the mail and write ones are not sent
    const sent = (JSON.parse(response.request().postData() ?? '{}') as { services: string[] }).services;
    expect(sent).toContain('drive');
    for (const off of ['calendar', 'gmail', 'calendar_write']) expect(sent).not.toContain(off);
    await expect(page.getByText('provider page')).toBeVisible();
    expect(asked).not.toBeNull();
    const url = asked as unknown as URL;
    expect(url.searchParams.get('client_id')).toBe('e2e-google-client-id');
    expect(url.searchParams.get('redirect_uri')).toContain('/api/me/connections/google/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.toString()).not.toContain('SENTINEL');
  } finally {
    await context.close();
  }
});

test('a provider that is not set up refuses Connect with a plain sentence, and Disconnect with nothing connected says so', async ({ playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const res = await nadia.ctx.post('/api/me/connections/microsoft/start', { data: {}, headers: await nadia.headers() });
    expect(res.status()).toBe(409);
    expect(await res.text()).toContain('not set up');
    const gone = await nadia.ctx.delete('/api/me/connections/google', { headers: await nadia.headers() });
    expect(gone.status()).toBe(200);
    expect(await gone.json()).toEqual({ disconnected: false });
  } finally {
    await nadia.ctx.dispose();
  }
});

test('the way back from a provider is said in plain words, and then taken out of the address', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', `${PATH}?connected=google`);
  try {
    await expect(page.getByTestId('person-result')).toHaveText('Google is connected.');
    await expect(page).toHaveURL((u) => u.search === '');
    await page.reload();
    await expect(page.getByTestId('person-provider')).toHaveCount(11);
    await expect(page.getByTestId('person-result')).toHaveCount(0);
  } finally {
    await context.close();
  }
  const cases: Array<[string, string]> = [
    ['denied', 'You chose not to allow access, so nothing was connected.'],
    ['expired', 'That sign-in took too long or was already used. Start again.'],
    ['not_configured', 'That provider is not set up on this server yet.'],
    ['wrong_person', 'That sign-in was started by someone else.'],
  ];
  for (const [code, words] of cases) {
    const again = await openOn(browser, playwright, stack, 'nadia', `${PATH}?connect_error=${code}`);
    try {
      await expect(again.page.getByTestId('person-result')).toContainText(words);
      await expect(again.page.getByTestId('person-result')).not.toContainText(code);
      await expect(again.page).toHaveURL((u) => u.search === '');
    } finally {
      await again.context.close();
    }
  }
});

test('the page and the account Connections screen link to each other', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH);
  try {
    await page.getByTestId('person-other-link').getByRole('link').click();
    await expect(page).toHaveURL(/\/account\/connections$/);
    await page.getByTestId('account-connected-link').getByRole('link').click();
    await expect(page).toHaveURL(/\/settings\/connections$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Connected accounts' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('on a phone the page fits the width', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH, { viewport: PHONE, mobile: true });
  try {
    await expect(page.getByTestId('person-provider')).toHaveCount(11);
    await expect(provider(page, 'microsoft').getByTestId('person-not-configured')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
