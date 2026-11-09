import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn } from '../../support/stack-browser.ts';
import { SIZES, THEMES, openPage, settle } from '../support/vt.ts';

/*
 * Workspace → Runners → the Codex runner (PLAN P19-13): the Add-a-runner chooser with the Codex card open, and the Codex sign-in dialog with a made-up file chosen. Class W, own
 * baselines at 1440x900 and 390x844, light and dark: runners-codex-<chooser|signin>-<1440|390>-<light|dark>.png. Baselines are taken by the lead (wave 4), not by this file.
 */
const CANARY = 'CANARY-VISUAL-CODEX-1e08';
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown): string => `${b64({ alg: 'none' })}.${b64(payload)}.sig-${CANARY}`;
// a fixed expiry keeps the picture the same on every run
const FILE = `${JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }), access_token: jwt({ exp: 1_900_000_000 }), refresh_token: `rt-${CANARY}`, account_id: 'acct-visual' },
  last_refresh: '2026-11-01T10:00:00.000Z',
  extra_login: { token: CANARY },
})}\n`;

let k8s: FakeK8s;
let stack: Stack;
test.beforeAll(async ({ playwright }) => {
  k8s = await startFakeK8s();
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL: k8s.url });
  const teamId = (await stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'"))[0]!.id;
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'codex-visual', label: 'Codex visual', kind: 'codex_cli', maxConcurrent: 1, teams: { teams: [teamId] } });
  } finally {
    await api.ctx.dispose();
  }
});
test.afterAll(async () => {
  await stack?.stop();
  await k8s?.stop();
});

for (const [size, viewport] of Object.entries(SIZES)) {
  for (const theme of THEMES) {
    const mobile = size === '390';
    test(`runners codex ${size} ${theme} matches its baseline (W)`, async ({ browser }) => {
      const { page, close } = await openPage(browser, stack, 'omar', viewport, mobile, { theme });
      try {
        await page.goto('/settings/workspace/runners');
        await page.getByTestId('runner-add').click();
        await expect(page.getByTestId('runner-kind-codex_cli')).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`runners-codex-chooser-${size}-${theme}.png`, { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' });
        await page.keyboard.press('Escape');
        const row = page.locator('[data-testid="runner-row"][data-runner="codex-visual"]');
        await row.getByTestId('runner-signin-open').click();
        const dialog = page.getByRole('dialog', { name: 'Sign-in for Codex visual' });
        await dialog.getByTestId('runner-signin-file').setInputFiles({ name: 'auth.json', mimeType: 'application/json', buffer: Buffer.from(FILE) });
        await expect(dialog.getByTestId('runner-signin-preview')).toBeVisible();
        await dialog.getByTestId('runner-signin-terms').check();
        await settle(page);
        await expect(page).toHaveScreenshot(`runners-codex-signin-${size}-${theme}.png`, { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' });
      } finally {
        await close();
      }
    });
  }
}
