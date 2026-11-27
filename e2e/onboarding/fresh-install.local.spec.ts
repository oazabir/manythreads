import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { PERSONA_PASSWORD } from '@manythreads/test-utils';
import { startFakeLlm, type FakeLlm } from '../../tools/fake-llm/src/server.ts';
import { conversationStackEnv } from '../conversations/support.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import {
  enrolCommand,
  Journey,
  maskPage,
  readEnv,
  scrub,
  signInAndChoosePassword,
  skip,
  stepInfrastructure,
  stepModels,
  stepOrganization,
  stepSignin,
  stepTheme,
  wizardFirstView,
} from './journey-lib.ts';

/*
 * A small proof of the fresh-install journey's own helpers (task P38-05b) on an isolated stack, before the real run: the first sign-in that asks for a new password,
 * the wizard steps that need no cluster (look, organization, address, models with a stand-in model server, sign-in policy), the numbered screenshots, the masking, the
 * report with its skipped and failed steps, and the places a secret must never reach. What it cannot prove (servers, pods, bots on runners) needs a machine and a
 * cluster: that is the journey itself, run on the freshly installed site.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'the journey drives its own two sizes');

// the seeded first person of the isolated stack (the account the installer's first admin stands in for)
const ADMIN = ['omar', 'kahf.example'].join('@');
const GOOD = ['sk-p38', 'journey-key-0001'].join('');
const NEW_PASSWORD = ['journey', 'new', 'password', '42'].join('-');
let fake: FakeLlm;
let stack: Stack;
let out: string;

test.beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'journey-local-'));
  fake = await startFakeLlm({ masterKey: 'sk-fake', scenario: 'journey', providerKeys: { good: [GOOD], noQuota: [] } });
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_LITELLM_URL: fake.url, MANYTHREADS_LITELLM_MASTER_KEY: 'sk-fake' });
  // a fresh install: nothing ticked, no organization name, no runner; and the admin has the password the installer printed and must choose another
  await stack.sql('DELETE FROM app.onboarding_marks');
  await stack.sql('DELETE FROM app.onboarding_state');
  await stack.sql(`UPDATE app.workspaces SET name = 'My organization'`);
  await stack.sql('DELETE FROM app.bot_runners');
  await stack.sql(`UPDATE app.password_credentials SET must_change = true WHERE person_id = (SELECT id FROM app.people WHERE primary_email = '${ADMIN}')`);
});

test.afterAll(async () => {
  await stack?.stop();
  await fake?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

test('the journey helpers: first sign-in, wizard steps, numbered masked shots, a report that names skipped and failed steps', async ({ browser }) => {
  test.setTimeout(240_000);
  const env = readEnv({
    JOURNEY_URL: stack.origin,
    JOURNEY_ADMIN_EMAIL: ADMIN,
    JOURNEY_ADMIN_PASSWORD: PERSONA_PASSWORD,
    JOURNEY_NEW_PASSWORD: NEW_PASSWORD,
    JOURNEY_MODEL_PRESET: 'openai',
    JOURNEY_MODEL_KEY: GOOD,
    JOURNEY_ORG_NAME: 'Fresh Install Co',
    JOURNEY_SHOTS_DIR: out,
  });
  const context = await browser.newContext({ baseURL: env.url, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const j = new Journey(env, page);
  try {
    // the secrets never reach what the journey writes
    const scrubbed = scrub(`the password ${PERSONA_PASSWORD} and ${NEW_PASSWORD} at ${env.url}`, env);
    for (const secret of [PERSONA_PASSWORD, NEW_PASSWORD, env.url]) expect(scrubbed).not.toContain(secret);
    expect(scrub(`curl x | bash -s -- --enrol mte_${'a'.repeat(40)}`, env)).not.toContain('a'.repeat(40));
    expect(enrolCommand('https://site.example', `mte_${'b'.repeat(40)}`, null)).toBe(`curl -fsSL https://site.example/install/bridge.sh | sudo bash -s -- --enrol mte_${'b'.repeat(40)}`);

    expect((await j.step('sign-in', 'first sign-in', () => signInAndChoosePassword(j))).status).toBe('pass');
    expect((await j.step('wizard', 'the wizard opens', () => wizardFirstView(j), { needs: ['sign-in'] })).status).toBe('pass');
    expect((await j.step('theme', 'the look', () => stepTheme(j), { needs: ['sign-in'] })).status).toBe('pass');
    expect((await j.step('organization', 'the organization', () => stepOrganization(j), { needs: ['sign-in'] })).status).toBe('pass');
    expect((await j.step('infrastructure', 'the address', () => stepInfrastructure(j), { needs: ['sign-in'] })).status).toBe('pass');
    expect((await j.step('models', 'the models', () => stepModels(j), { needs: ['sign-in'] })).status).toBe('pass');
    expect((await j.step('signin-policy', 'sign-in policy', () => stepSignin(j), { needs: ['sign-in'] })).status).toBe('pass');

    // a step that cannot start is skipped with its reason, one that throws fails with a shot, and a step that needs a failed one is skipped by name
    const skipped = await j.step('no-server', 'a server that never comes', async () => skip('no server connected within 1 s'));
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'no server connected within 1 s' });
    const failed = await j.step('broken', 'a step that breaks', async () => {
      throw new Error(`the page said ${NEW_PASSWORD}`);
    });
    expect(failed.status).toBe('fail');
    expect(failed.reason).not.toContain(NEW_PASSWORD);
    const chained = await j.step('after-broken', 'needs the broken one', async () => 'never', { needs: ['broken'] });
    expect(chained).toMatchObject({ status: 'skipped', reason: 'needs "broken", which failed' });

    // masking draws a box over an address and an e-mail and takes them away again
    await page.setContent(`<body style="font:20px sans-serif"><p>Mail ${ADMIN}, open https://secret.example/path or 10.1.2.3:8080 now.</p><p>Plain words stay.</p></body>`);
    const masked = await maskPage(page, []);
    expect(masked.boxes).toBeGreaterThanOrEqual(3);
    await masked.remove();
    expect(await page.locator('[data-journey-mask]').count()).toBe(0);

    // the report and the numbered shots
    const report = JSON.parse(readFileSync(join(out, 'fresh-install-report.json'), 'utf8')) as { summary: { pass: number; fail: number; skipped: number }; site: string; steps: Array<{ id: string; seconds: number }> };
    expect(report.summary).toEqual({ pass: 7, fail: 1, skipped: 2 });
    expect(report.site).toBe('[hidden]');
    expect(report.steps.every((s) => typeof s.seconds === 'number')).toBe(true);
    const text = readFileSync(join(out, 'fresh-install-report.json'), 'utf8');
    for (const secret of [PERSONA_PASSWORD, NEW_PASSWORD, GOOD, new URL(env.url).host]) expect(text).not.toContain(secret);
    const shots = readdirSync(out).filter((f) => /^\d\d-.*-1440\.png$/.test(f));
    expect(shots.length).toBeGreaterThanOrEqual(12);
    expect(shots[0]).toMatch(/^01-sign-in-1440\.png$/);
    expect(existsSync(join(out, 'fail-broken.png'))).toBe(true);
    // the wizard reads what the steps did: the three aliases answered, the organization has its name, the first password was replaced
    const ws = await j.must('GET', '/api/workspace');
    expect(ws.workspace.name).toBe('Fresh Install Co');
    expect(j.summary()).toEqual({ pass: 7, fail: 1, skipped: 2 });
  } finally {
    await context.close();
  }
});
