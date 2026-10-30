import { expect, test, type Page } from '@playwright/test';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { addBot, brainMd, conversationStackEnv } from '../conversations/support.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * PLAN P10-01 in the browser: the setup wizard on a fresh install. Omar (workspace admin) walks the nine steps on a stack of its own, with a
 * model stand-in behind the proxy address. What it proves: a step turns done only from a fact (a model that answered a test call, Brain on a
 * team, the first question sent), a wrong key shows its cause in plain words and keeps the step open, the first goal lands in Brain's conversation,
 * the sidebar card counts the same steps and can be put away only after that goal, and a member never sees any of it. Both layouts; only the
 * sidebar-card checks are desktop-only (on a phone the sidebar is a drawer).
 */
test.describe.configure({ mode: 'serial' });

const KEY = ['sk-p10', '01-e2e-key-0001'].join('');
let answer: string | { status: number; body: unknown } = 'ready';
let fake: FakeLlm;
let stack: Stack;

test.beforeAll(async () => {
  fake = await startFakeLlm({ masterKey: 'sk-fake', completion: () => answer });
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_LITELLM_URL: fake.url, MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake' });
  // the seeded world starts with its checklist already put away (so the screen baselines stay clean); a fresh install has none of that
  await stack.sql('DELETE FROM app.onboarding_marks');
  await stack.sql('DELETE FROM app.onboarding_state');
  // Engineering exists (the seed made it) but has no Brain, no provider and no model: the test adds them, so each step is seen turning done
});

test.afterAll(async () => {
  await stack?.stop();
  await fake?.close();
});

const count = (page: Page) => page.getByTestId('ob-count');
const step = (page: Page, id: string) => page.locator(`[data-landmark="steps"] [data-step="${id}"]`);

test('a fresh install walks to the first answer from Brain; the card counts the same steps and is put away only at the end', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(240_000);
  const omarApi = await apiOn(playwright, stack, 'omar');
  const headers = await omarApi.headers();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/onboarding', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    // ---- what a new admin sees first: the facts that are already true, and nothing else ticked
    await expect(page.getByRole('heading', { name: 'Finish setting up', exact: true })).toBeVisible();
    await expect(step(page, 'bootstrap')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'teams')).toHaveAttribute('data-done', 'true');
    for (const id of ['signin', 'models', 'bots', 'launch']) await expect(step(page, id)).toHaveAttribute('data-done', 'false');
    await expect(count(page)).toHaveText(/^2 of 9/);
    await expect(step(page, 'launch').locator('textarea')).toHaveCount(0); // no Brain yet: nothing to ask
    expect(await noSidewaysScroll(page)).toBe(true);
    if (!isMobile) {
      // the card sits in the team sidebar and counts the same steps
      await page.goto('/t/engineering/threads');
      await expect(page.getByTestId('setup-card-count')).toHaveText('2 of 9');
      await expect(page.locator('[data-landmark="setup-checklist"]')).toContainText('Next: Sign-in methods');
      await page.goto('/onboarding');
      await expect(count(page)).toHaveText(/^2 of 9/);
    }

    // ---- the server refuses to put the checklist away before the first goal
    const early = await omarApi.ctx.post('/api/workspace/onboarding/dismiss', { data: {}, headers });
    expect(early.status()).toBe(409);

    // ---- step 1: a password-only workspace can say so (a decision, recorded) and take it back
    await step(page, 'signin').getByRole('button', { name: 'Passwords only is what we want', exact: true }).click();
    await expect(step(page, 'signin')).toHaveAttribute('data-done', 'true');
    await expect(count(page)).toHaveText(/^3 of 9/);
    await step(page, 'signin').getByRole('button', { name: 'Undo, I will add single sign-on', exact: true }).click();
    await expect(step(page, 'signin')).toHaveAttribute('data-done', 'false');
    await step(page, 'signin').getByRole('button', { name: 'Passwords only is what we want', exact: true }).click();
    await expect(step(page, 'signin')).toHaveAttribute('data-done', 'true');

    // ---- step 2: a saved key is not a working key. No test yet, so not done even after the model is connected.
    const created = await omarApi.ctx.post('/api/workspace/llm/providers', { data: { name: 'OpenAI', kind: 'openai', apiKey: KEY }, headers });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const providerId = ((await created.json()) as { provider: { id: string } }).provider.id;
    const bound = await omarApi.ctx.put('/api/workspace/llm/aliases/smart', { data: { providerId, model: 'gpt-4o', fallbacks: [] }, headers });
    expect(bound.status(), await bound.text()).toBe(200);
    // a save is not tested for ten seconds (the proxy may still hold the old settings): the test moves the save into the past instead of waiting
    await stack.sql(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
    await stack.sql(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
    await page.getByRole('button', { name: 'Check again', exact: true }).first().click();
    await expect(step(page, 'models')).toHaveAttribute('data-done', 'false');
    const smart = step(page, 'models').locator('[data-alias="smart"]');
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-test-state', 'untested');

    // a wrong key: the cause is named in plain words, the provider's own text is not repeated, the step stays open
    answer = { status: 401, body: { error: { message: 'Incorrect API key provided: vendor-detail-should-not-show' } } };
    await smart.getByRole('button', { name: 'Test the smart alias', exact: true }).click();
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-test-state', 'failed');
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-cause', 'auth');
    await expect(smart).toContainText(/key/i);
    await expect(smart).not.toContainText('vendor-detail-should-not-show');
    await expect(step(page, 'models')).toHaveAttribute('data-done', 'false');

    // the same alias answering: done, from a real call the stand-in saw
    answer = 'ready';
    const callsBefore = fake.state.calls.filter((c) => c.path === '/chat/completions').length;
    await smart.getByRole('button', { name: 'Test the smart alias', exact: true }).click();
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-test-state', 'ok');
    await expect(step(page, 'models')).toHaveAttribute('data-done', 'true');
    expect(fake.state.calls.filter((c) => c.path === '/chat/completions').length).toBeGreaterThan(callsBefore);
    await expect(count(page)).toHaveText(/^4 of 9/);

    // ---- step 6: Brain on the team (added the way a lead adds it: through the team's repo)
    await addBot(stack, omarApi, 'brain', brainMd(['What is blocking the release?']));
    await step(page, 'bots').getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(step(page, 'bots')).toHaveAttribute('data-done', 'true');
    await expect(count(page)).toHaveText(/^5 of 9/);

    // ---- optional steps are rows that tell the truth and can be set aside, never ticked
    await expect(step(page, 'infrastructure')).toHaveAttribute('data-done', 'false'); // this stack is plain http
    await step(page, 'servers').getByRole('button', { name: 'We do not need this', exact: true }).click();
    await expect(step(page, 'servers')).toHaveAttribute('data-status', 'skipped');
    await expect(step(page, 'servers')).toHaveAttribute('data-done', 'false');
    await expect(count(page)).toHaveText(/^6 of 9/);

    // ---- step 8: the first goal goes to Brain and the person lands in that conversation
    const goal = 'What should a new person on this team read first?';
    const box = step(page, 'launch').locator('textarea');
    await expect(box).toBeVisible();
    await box.fill(goal);
    await step(page, 'launch').getByRole('button', { name: 'Ask Brain', exact: true }).click();
    await expect(page).toHaveURL(/\/t\/engineering\/bots\/brain\/chat\?thread=[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByText(goal).first()).toBeVisible({ timeout: 30_000 });
    const state = (await (await omarApi.ctx.get('/api/workspace/onboarding')).json()) as { state: { launch: { channelId: string } | null; dismissedAt: string | null } };
    expect(state.state.launch).not.toBeNull();
    expect(state.state.dismissedAt).toBeNull();

    // ---- everything required is done: the wizard offers to put the checklist away (and the sidebar card does too, on a desktop)
    await page.goto('/onboarding');
    await expect(step(page, 'launch')).toHaveAttribute('data-done', 'true');
    await expect(count(page)).toHaveText(/^7 of 9/);
    await expect(page.locator('[data-landmark="finish"]')).toContainText('Everything required is done');
    if (!isMobile) {
      await page.goto('/t/engineering/threads');
      await expect(page.locator('[data-landmark="setup-checklist"]')).toHaveAttribute('data-finished', 'true');
      await expect(page.getByTestId('setup-card-count')).toHaveText('7 of 9');
      await page.locator('[data-landmark="setup-checklist"]').getByRole('button', { name: 'Put it away', exact: true }).click();
      await expect(page.locator('[data-landmark="setup-checklist"]')).toHaveCount(0);
    } else {
      expect(await noSidewaysScroll(page)).toBe(true);
      await page.locator('[data-landmark="finish"]').getByRole('button', { name: 'Put the checklist away', exact: true }).click();
    }
    await expect
      .poll(async () => ((await (await omarApi.ctx.get('/api/workspace/onboarding')).json()) as { state: { dismissedAt: string | null } }).state.dismissedAt, { timeout: 15_000 })
      .not.toBeNull();
    await page.goto('/onboarding');
    await expect(page.locator('[data-landmark="finish"]')).toContainText('The checklist is put away');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
    await omarApi.ctx.dispose();
  }
});

test('a plain member sees no checklist and the routes refuse them', async ({ browser, playwright, isMobile }) => {
  const priyaApi = await apiOn(playwright, stack, 'priya');
  const headers = await priyaApi.headers();
  expect((await priyaApi.ctx.get('/api/workspace/onboarding')).status()).toBeGreaterThanOrEqual(403);
  expect((await priyaApi.ctx.post('/api/workspace/onboarding/dismiss', { data: {}, headers })).status()).toBeGreaterThanOrEqual(403);
  expect((await priyaApi.ctx.post('/api/workspace/llm/aliases/smart/test', { data: {}, headers })).status()).toBeGreaterThanOrEqual(403);
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/engineering/threads', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(page.getByTestId('app-frame')).toBeVisible();
    await expect(page.locator('[data-landmark="setup-checklist"]')).toHaveCount(0);
  } finally {
    await context.close();
    await priyaApi.ctx.dispose();
  }
});
