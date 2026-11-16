import { expect, test, type Page } from '@playwright/test';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../tools/fake-hermes-gateway/src/server.ts';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { conversationStackEnv } from '../conversations/support.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * PLAN P10-01 and Phase 27 in the browser: the setup wizard on a fresh install. Omar (workspace admin) walks the steps on a stack of its own, with the fake model
 * server behind the gateway address. What it proves: a step turns done only from a fact (a model that answered a test call, a runner that answered a real question,
 * Brain's answer), a key without quota and a wrong key show their cause in plain words and keep the step open, a working runner is required, the look can be tried
 * from the wizard, the page opens where the person stopped, and a member never sees any of it. Both layouts; the sidebar-card checks are desktop-only (on a phone the
 * sidebar is a drawer). The Hermes pod the wizard offers needs a cluster; here the offer is checked and the runner proof runs on a model-alias runner.
 */
test.describe.configure({ mode: 'serial' });

const GOOD = ['sk-p27', 'good-e2e-key-0001'].join('');
const NO_QUOTA = ['sk-p27', 'quota-e2e-key-0002'].join('');
const BAD = ['sk-p27', 'bad-e2e-key-0003'].join('');
const GATEWAY_KEY = ['wizard-stand-in', 'key-0001'].join('-');
let fake: FakeLlm;
let gateway: FakeHermesGateway;
let stack: Stack;

test.beforeAll(async () => {
  gateway = await startFakeHermesGateway({ profiles: {}, script: (run) => [{ type: 'finish', output: `Hello from the stand-in on the profile ${run.profile}.` }] });
  // the profiles a gateway runner is asked for: `default` (the Runners page's own check) and Brain's (the profile rule is the bot's name)
  for (const profile of ['default', 'brain']) gateway.setProfile(profile, { apiKey: GATEWAY_KEY });
  fake = await startFakeLlm({ masterKey: 'sk-fake', scenario: 'journey', providerKeys: { good: [GOOD], noQuota: [NO_QUOTA] } });
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_HERMES_ALLOWED_HOSTS: '127.0.0.1', MANYTHREADS_LITELLM_URL: fake.url, MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake' });
  // the seeded world starts with its checklist put away and its organization named; a fresh install has neither
  await stack.sql('DELETE FROM app.onboarding_marks');
  await stack.sql('DELETE FROM app.onboarding_state');
  await stack.sql(`UPDATE app.workspaces SET name = 'My organization'`);
  await stack.sql('DELETE FROM app.bot_runners');
});

test.afterAll(async () => {
  await stack?.stop();
  await fake?.close();
  await gateway?.close();
});

const step = (page: Page, id: string) => page.locator(`[data-landmark="steps"] [data-step="${id}"]`);
// a save is not tested for ten seconds (the model proxy may still hold the old settings): the test moves the save into the past instead of waiting
const settle = async () => {
  await stack.sql(`UPDATE app.llm_aliases SET updated_at = updated_at - interval '1 minute'`);
  await stack.sql(`UPDATE app.llm_providers SET updated_at = updated_at - interval '1 minute'`);
};
const shot = async (page: Page, name: string, isMobile: boolean) => {
  await page.screenshot({ path: `test-results-g1/onboarding-journey/${name}-${isMobile ? '390' : '1440'}.png`, fullPage: false });
};

test('a fresh install walks to Brain\'s answer; a working runner is required; the page opens where the person stopped', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(300_000);
  const omarApi = await apiOn(playwright, stack, 'omar');
  const headers = await omarApi.headers();
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/onboarding', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    // ---- what a new admin sees first: one step open, the first required one that is still to do
    await expect(page.getByRole('heading', { name: 'Finish setting up', exact: true })).toBeVisible();
    await expect(step(page, 'bootstrap')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'organization')).toHaveAttribute('data-done', 'false');
    await expect(step(page, 'organization')).toHaveAttribute('data-open', 'true');
    for (const id of ['theme', 'models', 'runners', 'launch']) await expect(step(page, id)).toHaveAttribute('data-open', 'false');
    await expect(page.locator('.ob-progress')).toHaveCSS('position', 'sticky');
    expect(await noSidewaysScroll(page)).toBe(true);
    await shot(page, '01-first-open', isMobile);

    // ---- an address names a step: it opens there, and "Continue" moves on
    await page.goto('/onboarding?step=theme');
    await expect(step(page, 'theme')).toHaveAttribute('data-open', 'true');
    await expect(step(page, 'organization')).toHaveAttribute('data-open', 'false');
    // a look chosen here is the person's own and is saved at once
    await page.getByTestId('ob-theme-palette-harbor').click();
    await expect(step(page, 'theme')).toHaveAttribute('data-done', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'harbor');
    await shot(page, '02-theme', isMobile);
    await page.getByTestId('ob-theme-palette-classic').click();
    await expect(step(page, 'theme')).toHaveAttribute('data-done', 'false');
    await page.getByTestId('ob-theme-keep').click();
    await expect(step(page, 'theme')).toHaveAttribute('data-done', 'true');
    await step(page, 'theme').getByTestId('ob-continue-theme').click();
    await expect(step(page, 'organization')).toHaveAttribute('data-open', 'true');

    // ---- the organization: a name of its own turns the step done
    await page.getByTestId('ob-org-name').fill('Kahf Software');
    await page.getByTestId('ob-org-save').click();
    await expect(step(page, 'organization')).toHaveAttribute('data-done', 'true');
    const ws = (await (await omarApi.ctx.get('/api/workspace')).json()) as { workspace: { name: string; timeZone: string | null } };
    expect(ws.workspace.name).toBe('Kahf Software');
    expect(ws.workspace.timeZone).not.toBeNull();

    // ---- address and HTTPS: optional, tells the truth, never ticked on plain http
    await page.goto('/onboarding?step=infrastructure');
    await expect(step(page, 'infrastructure')).toContainText('set-domain');
    await expect(step(page, 'infrastructure')).toHaveAttribute('data-done', 'false');

    // ---- models: a key without quota and a wrong key name their cause; a good key binds the three aliases and a test turns the step done
    await page.goto('/onboarding?step=models');
    await expect(step(page, 'models')).toHaveAttribute('data-done', 'false');
    await page.getByTestId('ob-preset-openai').click();
    await page.getByTestId('ob-model-key').fill(NO_QUOTA);
    await page.getByTestId('ob-model-connect').click();
    const smart = step(page, 'models').locator('[data-alias="smart"]');
    await expect(smart).toBeVisible();
    await expect(page.getByTestId('ob-models-form')).toHaveCount(0);
    await settle();
    await smart.getByRole('button', { name: 'Test the smart alias', exact: true }).click();
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-test-state', 'failed');
    await expect(step(page, 'models')).toHaveAttribute('data-done', 'false');
    await page.getByTestId('ob-model-another').click();
    await page.getByTestId('ob-preset-openai').click();
    await page.getByTestId('ob-model-key').fill(BAD);
    await page.getByTestId('ob-model-connect').click();
    await expect(page.getByTestId('ob-models-form')).toHaveCount(0);
    await settle();
    await smart.getByRole('button', { name: 'Test the smart alias', exact: true }).click();
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-cause', 'auth');
    await expect(smart).not.toContainText(BAD);
    await page.getByTestId('ob-model-another').click();
    await page.getByTestId('ob-preset-openai').click();
    await page.getByTestId('ob-model-key').fill(GOOD);
    await page.getByTestId('ob-model-connect').click();
    await expect(page.getByTestId('ob-models-form')).toHaveCount(0);
    await settle();
    await smart.getByRole('button', { name: 'Test the smart alias', exact: true }).click();
    await expect(smart.locator('[data-test-state]')).toHaveAttribute('data-test-state', 'ok');
    await expect(step(page, 'models')).toHaveAttribute('data-done', 'true');
    for (const alias of ['smart', 'fast', 'code']) await expect(step(page, 'models').locator(`[data-alias="${alias}"]`)).toBeVisible();
    // the monthly spending limit was set with the first key
    const limits = (await (await omarApi.ctx.get('/api/workspace/llm/limits')).json()) as { limits: Array<{ scope: string; window: string }> };
    expect(limits.limits.some((l) => l.scope === 'workspace' && l.window === 'month')).toBe(true);
    await shot(page, '03-models', isMobile);

    // ---- teams: every template is shown; the ones that exist say so
    await page.goto('/onboarding?step=teams');
    await expect(step(page, 'teams')).toHaveAttribute('data-done', 'true');
    await expect(step(page, 'teams').locator('[data-template]').first()).toBeVisible();
    expect(await step(page, 'teams').locator('[data-template]').count()).toBeGreaterThanOrEqual(5);
    await expect(step(page, 'teams').getByTestId('ob-template-engineering')).toBeChecked();

    // ---- runners: none exists, so the step is open, not done, and offers a Hermes pod on the models connected above
    await page.goto('/onboarding?step=runners');
    await expect(step(page, 'runners')).toHaveAttribute('data-done', 'false');
    await expect(step(page, 'runners').getByTestId('ob-runner-offer')).toBeVisible();
    await expect(step(page, 'runners').getByTestId('ob-runner-deploy')).toBeEnabled();
    // the required step cannot be walked past
    await expect(step(page, 'runners').getByTestId('ob-continue-runners')).toBeDisabled();
    await shot(page, '04-runner-offer', isMobile);
    // a runner that is ready is still not enough (a Hermes gateway the stand-in answers for): it has to answer a real question
    const made = await omarApi.ctx.post('/api/admin/bot-runners', { data: { name: 'house', label: 'House Hermes', kind: 'hermes_gateway', baseUrl: gateway.url, apiKey: GATEWAY_KEY, teams: { all: true } }, headers });
    expect(made.status(), await made.text()).toBe(201);
    // the Runners page's own "Test": the gateway answers, so the runner turns ready
    const runnerId = ((await made.json()) as { runner: { id: string } }).runner.id;
    const reach = await omarApi.ctx.post(`/api/admin/bot-runners/${runnerId}/test`, { data: { profile: 'brain' }, headers });
    expect(reach.status(), await reach.text()).toBe(200);
    expect(((await reach.json()) as { ok: boolean }).ok, await reach.text()).toBe(true);
    await page.goto('/onboarding?step=runners');
    await expect(step(page, 'runners').locator('[data-runner="house"]')).toHaveAttribute('data-ready', 'true');
    await expect(step(page, 'runners')).toHaveAttribute('data-done', 'false');
    await step(page, 'runners').getByTestId('ob-runner-prove-house').click();
    await expect(step(page, 'runners').getByTestId('ob-runner-proven')).toBeVisible({ timeout: 90_000 });
    await expect(step(page, 'runners')).toHaveAttribute('data-done', 'true');
    // the proof is a fact the server keeps, and it made the runner the place bots run
    const state = (await (await omarApi.ctx.get('/api/workspace/onboarding')).json()) as { state: { marks: Array<{ step: string; kind: string; refId: string | null }> } };
    expect(state.state.marks.find((m) => m.step === 'runners')).toMatchObject({ kind: 'checked' });
    await page.goto('/onboarding?step=bots');
    await expect(step(page, 'bots')).toHaveAttribute('data-done', 'true');
    await shot(page, '05-runner-proven', isMobile);

    // ---- optional steps are rows that tell the truth and can be set aside, never ticked
    await page.goto('/onboarding?step=servers');
    await step(page, 'servers').getByTestId('ob-aside-servers').click();
    await expect(step(page, 'servers')).toHaveAttribute('data-status', 'skipped');
    await expect(step(page, 'servers')).toHaveAttribute('data-done', 'false');

    // ---- Brain answers: the question goes to Brain, its run card shows in the step, and the step is done by the answer
    await page.goto('/onboarding?step=launch');
    await expect(step(page, 'launch')).toHaveAttribute('data-done', 'false');
    await step(page, 'launch').getByTestId('ob-launch-ask').click();
    await expect(step(page, 'launch').getByTestId('ob-runs')).toBeVisible({ timeout: 60_000 });
    await expect(step(page, 'launch')).toHaveAttribute('data-done', 'true', { timeout: 90_000 }).catch(async (e: Error) => {
      const st = (await (await omarApi.ctx.get('/api/workspace/onboarding')).json()) as { state: { launch: { messageId: string | null } | null } };
      const runs = await omarApi.ctx.get(`/api/threads/${st.state.launch?.messageId}/runs`);
      throw new Error(`${e.message}\nRUNS: ${await runs.text()}`);
    });
    await shot(page, '06-brain-answered', isMobile);

    // ---- every required step is done: the wizard offers to put the checklist away
    await page.goto('/onboarding');
    await expect(page.locator('[data-landmark="finish"]')).toContainText('Everything required is done');
    if (!isMobile) {
      await page.goto('/t/engineering/threads');
      await expect(page.locator('[data-landmark="setup-checklist"]')).toHaveAttribute('data-finished', 'true');
      await page.locator('[data-landmark="setup-checklist"]').getByRole('button', { name: 'Put it away', exact: true }).click();
      await expect(page.locator('[data-landmark="setup-checklist"]')).toHaveCount(0);
    } else {
      expect(await noSidewaysScroll(page)).toBe(true);
      await page.locator('[data-landmark="finish"]').getByRole('button', { name: 'Put the checklist away', exact: true }).click();
    }
    await expect
      .poll(async () => ((await (await omarApi.ctx.get('/api/workspace/onboarding')).json()) as { state: { dismissedAt: string | null } }).state.dismissedAt, { timeout: 15_000 })
      .not.toBeNull();
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
  expect((await priyaApi.ctx.put('/api/workspace/onboarding/marks/runners', { data: { kind: 'checked', refId: '33333333-3333-4333-8333-333333333333' }, headers })).status()).toBeGreaterThanOrEqual(403);
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
