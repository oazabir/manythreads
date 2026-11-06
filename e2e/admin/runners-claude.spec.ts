import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * Workspace → Runners → Claude Code sign-in (PLAN P19-06) end to end, with no real cluster and no real login. A local double of the Kubernetes API
 * (`startFakeK8s`) lets the claude-pods plugin start, so the list says `claudePodsAvailable`. The sign-in file is made up (the shape of the real one, canary
 * strings inside); the stand-in pod image is not involved.
 *
 * Shown: the Claude Code card can be picked only when Claude pods are on; a Claude runner starts as "Waiting for sign-in"; the upload form names what is missing
 * (no file, a file that is not a sign-in file, a login without the inference permission, the two ticks); the file lands byte for byte in the pod's Secret and nowhere
 * else (the page, the answer, the database); a second runner cannot take the same login; Remove puts the runner back to waiting. A plain member cannot reach the routes.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/settings/workspace/runners';
const CANARY = 'CANARY-E2E-9c41';

const fileText = (tag: string, scopes: string[] = ['user:inference', 'user:profile']): string =>
  `${JSON.stringify(
    {
      claudeAiOauth: { accessToken: `fake-access-${tag}-${CANARY}`, refreshToken: `fake-refresh-${tag}-${CANARY}`, expiresAt: Date.now() + 8 * 3600_000, scopes, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
      mcpOAuth: { 'notion|a': { accessToken: `n-${CANARY}` }, 'slack|b': { accessToken: `s-${CANARY}` } },
    },
    null,
    3,
  )}\n\n`;

let k8s: FakeK8s;
let stack: Stack;
let plain: Stack;
let teamId = '';
let runnerAId = '';

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

test('with Claude pods on, the Claude Code card can be picked and a new runner waits for a sign-in', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await page.getByTestId('runner-add').click();
    const card = page.getByTestId('runner-kind-claude_cli');
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute('aria-disabled', 'true');
    await card.click();
    const form = page.getByRole('dialog', { name: 'Add a runner: Claude Code' });
    await expect(form).toBeVisible();
    await expect(form).toContainText('Each Claude runner needs its own sign-in file');
    await page.getByLabel('Display name').fill('Claude A');
    await page.getByTestId('runner-teams-one').check();
    await page.getByTestId('runner-teams-select').selectOption({ label: 'Engineering' });
    await page.getByTestId('runner-add-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const row = page.locator('[data-testid="runner-row"][data-runner="claude-a"]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);
    await expect(row.getByTestId('runner-signin-open')).toBeVisible();
    runnerAId = (await stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'claude-a'"))[0]!.id;
  } finally {
    await context.close();
  }
});

test('the upload form names what is missing, takes a good file as it is, and the file is kept in the pod Secret only', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="claude-a"]');
    await row.getByTestId('runner-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Claude A' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('runner-signin-none')).toBeVisible();
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();

    const pick = (name: string, text: string) => dialog.getByTestId('runner-signin-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });

    await pick('notes.json', 'this is not json');
    await expect(dialog.getByTestId('runner-signin-invalid')).toHaveText('That is not a Claude sign-in file. Choose the .credentials.json from a Claude login.');
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();

    await pick('.credentials.json', fileText('a', ['user:profile']));
    await expect(dialog.getByTestId('runner-signin-invalid')).toContainText('user:inference');

    const good = fileText('a');
    await pick('.credentials.json', good);
    const preview = dialog.getByTestId('runner-signin-preview');
    await expect(preview).toContainText('Max plan · 20x');
    await expect(preview).toContainText('2 other sign-ins');
    await expect(dialog).not.toContainText(CANARY);
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();
    await dialog.getByTestId('runner-signin-terms').check();
    await expect(dialog.getByTestId('runner-signin-hint')).toContainText('other sign-ins');
    await expect(dialog.getByTestId('runner-signin-upload')).toBeDisabled();
    await dialog.getByTestId('runner-signin-others').check();
    await expect(dialog.getByTestId('runner-signin-upload')).toBeEnabled();
    await dialog.getByTestId('runner-signin-upload').click();

    await expect(dialog.getByTestId('runner-signin-current')).toContainText('Signed in: Max plan · 20x');
    await expect(page.getByTestId('runner-status')).toContainText('Claude A is signed in and starting.');
    await expect(page.locator('body')).not.toContainText(CANARY);

    // the Secret holds the bytes as chosen; the database holds metadata only
    const secret = k8s.secrets.get('manythreads-claude/claude-claude-a-credentials') ?? [...k8s.secrets.values()].find((s) => s.metadata.name === 'claude-claude-a-credentials');
    expect(secret).toBeDefined();
    expect(Buffer.from(secret!.data?.['.credentials.json'] ?? '', 'base64').toString('utf8')).toBe(good);
    const rows = await stack.sql<Record<string, unknown>>("SELECT * FROM app.bot_runners WHERE name = 'claude-a'");
    expect(rows[0]).toMatchObject({ plan_label: 'Max plan · 20x' });
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    const events = await stack.sql<Record<string, unknown>>("SELECT payload FROM app.events WHERE type LIKE 'claude_pod.%'");
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(events.length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('a second runner cannot take the same login; Remove puts the runner back to waiting; a member cannot reach the routes', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'claude-b', label: 'Claude B', kind: 'claude_cli', maxConcurrent: 1, teams: { teams: [teamId] } });
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const b = page.locator('[data-testid="runner-row"][data-runner="claude-b"]');
    await b.getByTestId('runner-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Claude B' });
    await dialog.getByTestId('runner-signin-file').setInputFiles({ name: '.credentials.json', mimeType: 'application/json', buffer: Buffer.from(fileText('a')) });
    await dialog.getByTestId('runner-signin-terms').check();
    await dialog.getByTestId('runner-signin-others').check();
    await dialog.getByTestId('runner-signin-upload').click();
    await expect(dialog.getByTestId('runner-form-error')).toContainText('every Claude runner needs its own sign-in file');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const a = page.locator('[data-testid="runner-row"][data-runner="claude-a"]');
    await a.getByTestId('runner-signin-open').click();
    const first = page.getByRole('dialog', { name: 'Sign-in for Claude A' });
    await first.getByTestId('runner-signin-remove').click();
    await first.getByTestId('runner-signin-remove-yes').click();
    await expect(first.getByTestId('runner-signin-none')).toBeVisible();
    await expect(a.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);
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
    await page.locator('[data-testid="runner-row"][data-runner="claude-a"]').getByTestId('runner-signin-open').click();
    await expect(page.getByRole('dialog', { name: 'Sign-in for Claude A' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('without Claude pods the Claude Code card stays shut and says why', async ({ browser, playwright }) => {
  plain = await startStack({ MANYTHREADS_STACK_SEED: 'repo' });
  const { page, context } = await openOn(browser, playwright, plain, 'omar', PATH);
  try {
    await page.getByTestId('runner-add').click();
    await expect(page.getByTestId('runner-kind-claude_cli')).toHaveAttribute('aria-disabled', 'true');
  } finally {
    await context.close();
  }
});
