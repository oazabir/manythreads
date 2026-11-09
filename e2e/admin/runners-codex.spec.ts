import { createHash } from 'node:crypto';
import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * Workspace → Runners → Codex sign-in (PLAN P19-13) end to end, with no real cluster and no real login. A local double of the Kubernetes API (`startFakeK8s`) lets the
 * claude-pods plugin start, so the list says `claudePodsAvailable` (one switch for both pods). The sign-in file is made up (the key names of a ChatGPT login file, made-up
 * values, canary strings inside every token); the stand-in pod image is not involved and no real Codex runs.
 *
 * Shown: the Codex card can be picked only when pods are on; a Codex runner starts as "Waiting for sign-in"; the upload form names what is missing (not a Codex file, a file with
 * an API key, the two ticks) and reads the plan in the browser; the file lands byte for byte in the pod's Secret (SHA-256 equal) and nowhere else (the page, the database, the
 * events); a second runner cannot take the same login; Remove puts the runner back to waiting. A plain member cannot reach the routes.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/settings/workspace/runners';
const CANARY = 'CANARY-E2E-CODEX-5d27';

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.sig-${CANARY}`;

/** A made-up ChatGPT login file. `account` tells two logins apart; `extra` adds entries beyond the ones Codex writes. */
const fileText = (account: string, over: Record<string, unknown> = {}): string =>
  `${JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' }, email: `someone-${CANARY}@example.test` }),
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 8 * 3600, tag: CANARY }),
        refresh_token: `fake-refresh-${account}-${CANARY}`,
        account_id: `acct-${account}`,
      },
      last_refresh: new Date().toISOString(),
      extra_login: { token: `x-${CANARY}` },
      second_extra: 1,
      ...over,
    },
    null,
    2,
  )}\n`;

let k8s: FakeK8s;
let stack: Stack;
let plain: Stack;
let teamId = '';
let runnerAId = '';

const secretOf = (name: string) => [...k8s.secrets.values()].find((s) => s.metadata.name === name);

test.beforeAll(async () => {
  k8s = await startFakeK8s();
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL: k8s.url });
  teamId = (await stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'"))[0]!.id;
});
test.afterAll(async () => {
  await stack?.stop();
  await plain?.stop();
  await k8s?.stop();
});

test('with pods on, the Codex card can be picked and a new runner waits for a sign-in', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await page.getByTestId('runner-add').click();
    const card = page.getByTestId('runner-kind-codex_cli');
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute('aria-disabled', 'true');
    await card.click();
    const form = page.getByRole('dialog', { name: 'Add a runner: Codex' });
    await expect(form).toBeVisible();
    await expect(form).toContainText('Each Codex runner needs its own sign-in file');
    await page.getByLabel('Display name').fill('Codex A');
    await page.getByTestId('runner-teams-one').check();
    await page.getByTestId('runner-teams-select').selectOption({ label: 'Engineering' });
    await page.getByTestId('runner-add-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const row = page.locator('[data-testid="runner-row"][data-runner="codex-a"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);
    await expect(row.getByTestId('runner-signin-open')).toBeVisible();
    runnerAId = (await stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'codex-a'"))[0]!.id;
  } finally {
    await context.close();
  }
});

test('the upload form names what is missing, takes a good file as it is, and the file is kept in the pod Secret only', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="codex-a"]');
    await row.getByTestId('runner-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Codex A' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('runner-signin-none')).toBeVisible();
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();

    const pick = (name: string, text: string) => dialog.getByTestId('runner-signin-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });

    await pick('notes.json', 'this is not json');
    await expect(dialog.getByTestId('runner-signin-invalid')).toHaveText('That is not a Codex sign-in file. Choose the auth.json from a Codex login with a ChatGPT account.');
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();

    // a file with an API key is refused whole, and the sentence does not repeat the key
    await pick('auth.json', fileText('a', { OPENAI_API_KEY: `sk-live-${CANARY}` }));
    await expect(dialog.getByTestId('runner-signin-invalid')).toContainText('API key');
    await expect(dialog).not.toContainText(CANARY);
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();

    const good = fileText('a');
    await pick('auth.json', good);
    const preview = dialog.getByTestId('runner-signin-preview');
    await expect(preview).toContainText('ChatGPT Pro plan');
    await expect(preview).toContainText('2 other entries');
    await expect(dialog).not.toContainText(CANARY);
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();
    await dialog.getByTestId('runner-signin-terms').check();
    await expect(dialog.getByTestId('runner-signin-hint')).toContainText('other entries');
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();
    await dialog.getByTestId('runner-signin-others').check();
    await expect(dialog.getByTestId('runner-signin-upload')).toBeEnabled();
    await dialog.getByTestId('runner-signin-upload').click();

    await expect(dialog.getByTestId('runner-signin-current')).toContainText('Signed in: ChatGPT Pro plan');
    await expect(page.getByTestId('runner-status')).toContainText('Codex A is signed in and starting.');
    await expect(page.locator('body')).not.toContainText(CANARY);

    // the Secret holds the bytes as chosen (same SHA-256); the database and the events hold metadata only
    const secret = secretOf('codex-codex-a-credentials');
    expect(secret).toBeDefined();
    const stored = Buffer.from(secret!.data?.['auth.json'] ?? '', 'base64');
    expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(good).digest('hex'));
    expect(stored.toString('utf8')).toBe(good);
    // the Claude Secret of the same runner name does not exist: the two kinds keep to their own names
    expect(secretOf('claude-codex-a-credentials')).toBeUndefined();
    const rows = await stack.sql<Record<string, unknown>>("SELECT * FROM app.bot_runners WHERE name = 'codex-a'");
    expect(rows[0]).toMatchObject({ plan_label: 'ChatGPT Pro plan' });
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    const events = await stack.sql<Record<string, unknown>>("SELECT payload FROM app.events WHERE type LIKE 'codex_pod.%'");
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(events.length).toBeGreaterThan(0);
    const audit = await stack.sql<Record<string, unknown>>('SELECT * FROM app.audit_events');
    expect(JSON.stringify(audit)).not.toContain(CANARY);
  } finally {
    await context.close();
  }
});

test('a second runner cannot take the same login; Remove puts the runner back to waiting; a member cannot reach the routes', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'codex-b', label: 'Codex B', kind: 'codex_cli', maxConcurrent: 1, teams: { teams: [teamId] } });
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const b = page.locator('[data-testid="runner-row"][data-runner="codex-b"]');
    await b.getByTestId('runner-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Codex B' });
    // the same account with a renewed refresh token is still the same login
    await dialog.getByTestId('runner-signin-file').setInputFiles({ name: 'auth.json', mimeType: 'application/json', buffer: Buffer.from(fileText('a', { last_refresh: new Date(Date.now() + 1000).toISOString() })) });
    await dialog.getByTestId('runner-signin-terms').check();
    await dialog.getByTestId('runner-signin-others').check();
    await dialog.getByTestId('runner-signin-upload').click();
    await expect(dialog.getByTestId('runner-form-error')).toContainText('every Codex runner needs its own sign-in file');
    await expect(page.locator('body')).not.toContainText(CANARY);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(secretOf('codex-codex-b-credentials')).toBeUndefined();

    const a = page.locator('[data-testid="runner-row"][data-runner="codex-a"]');
    await a.getByTestId('runner-signin-open').click();
    const first = page.getByRole('dialog', { name: 'Sign-in for Codex A' });
    await first.getByTestId('runner-signin-remove').click();
    await first.getByTestId('runner-signin-remove-yes').click();
    await expect(first.getByTestId('runner-signin-none')).toBeVisible();
    await expect(a.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);
    expect(secretOf('codex-codex-a-credentials')).toBeUndefined();
    await page.keyboard.press('Escape');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
  const member = await apiOn(playwright, stack, 'nadia');
  try {
    expect([403, 404]).toContain(await member.status('GET', '/api/admin/bot-runners'));
    expect([403, 404]).toContain(await member.status('POST', `/api/admin/bot-runners/${runnerAId}/check`));
  } finally {
    await member.ctx.dispose();
  }
});

test('the sign-in dialog fits a phone', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE, mobile: true });
  try {
    await page.locator('[data-testid="runner-row"][data-runner="codex-a"]').getByTestId('runner-signin-open').click();
    await expect(page.getByRole('dialog', { name: 'Sign-in for Codex A' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('without pods the Codex card stays shut and says why', async ({ browser, playwright }) => {
  plain = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
  const { page, context } = await openOn(browser, playwright, plain, 'omar', PATH);
  try {
    await page.getByTestId('runner-add').click();
    const card = page.getByTestId('runner-kind-codex_cli');
    await expect(card).toHaveAttribute('aria-disabled', 'true');
    await expect(card).toContainText('Not turned on in this install.');
  } finally {
    await context.close();
  }
});
