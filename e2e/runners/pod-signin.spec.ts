import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeK8s, type FakeK8s } from '@manythreads/test-utils';
import { expect, test } from '@playwright/test';
import { parseConfig } from '../../tools/agent-bridge/src/config.ts';
import { startBridge, type Bridge } from '../../tools/agent-bridge/src/server.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn, PHONE } from '../support/stack-browser.ts';

/*
 * Workspace → Runners → a pod runner signed in from the page (PLAN P26-09, P26-10, P26-16a), with no real cluster and no real login. The stand-in of the Kubernetes API lets the claude-pods
 * plugin start; the pod's own bridge is a real agent bridge in this process that drives the fake ACP agent (the controller's test seam, NODE_ENV=test), so what the page, the server's proxy and
 * the bridge's sign-in do is all real, and only the agent's account is made up.
 *
 * Shown: a new pod runner has a Sign-in button that opens the agent dialog (no upload form); a Codex runner signs in with a device code and a Claude Code runner with a pasted code, the runner
 * turns Ready, the code is on no page text afterwards, and Sign out puts it back to waiting; the older upload of a file is one button inside the dialog; Codex full access is turned on with
 * its words shown first and allowed for a runner that serves two teams (each team has a pod of its own); a plain member cannot reach the routes; the dialog fits a phone.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const PATH = '/settings/workspace/runners';
const KEY = 'e2e-pod-signin-bridge-key-0001';
const FAKE_CLI = join(import.meta.dirname, '..', '..', 'tools', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = createRequire(import.meta.url).resolve('tsx/esm');
const PASS = ['FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];
const DEVICE_CODE = 'POD-98765';
const PASTED = 'E2E-POD-PASTED-CODE-77#state';

let dir: string;
let k8s: FakeK8s;
let bridge: Bridge;
let stack: Stack;
let teamId = '';
let otherTeamId = '';

const fake = (flavor: string, auth: Record<string, unknown>): void => {
  process.env['FAKE_ACP_FLAVOR'] = flavor;
  process.env['FAKE_ACP_STATE_DIR'] = join(dir, `fake-${flavor}`);
  process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify({ flavor, auth, scenarios: { hello: [{ do: 'text', text: 'hi' }] }, default: 'hello' });
};

/** The stand-in cluster starts no pods and answers every pod list with the same items: one Running pod makes the controller ask the bridge, which it does only for a pod that is up. */
const podRuns = (): void => {
  k8s.pods.push({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'agent-pod-1', namespace: 'bots', labels: { 'manythreads.io/pod': 'agent-pod' } }, status: { phase: 'Running' } });
};

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-pod-signin-'));
  const profile = (agent: string) => ({ agent, driver: 'acp', workdir: join(dir, `work-${agent}`), passEnv: PASS, acp: { command: process.execPath, args: ['--import', TSX, FAKE_CLI] } });
  const config = parseConfig({ profiles: { claude: profile('claude-code'), codex: profile('codex') }, killGraceSeconds: 0.5 });
  bridge = await startBridge({ config, apiKey: KEY, stateDir: join(dir, 'state'), port: 0, log: () => undefined, tmpRoot: dir });
  k8s = await startFakeK8s();
  podRuns();
  stack = await startStack({
    NODE_ENV: 'test',
    MANYTHREADS_STACK_SEED: 'repo',
    MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL: k8s.url,
    MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_URL: bridge.url,
    MANYTHREADS_CLAUDE_PODS_TEST_BRIDGE_KEY: KEY,
  });
  teamId = (await stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'"))[0]!.id;
  otherTeamId = (await stack.sql<{ id: string }>("SELECT id FROM app.teams WHERE slug <> 'engineering' ORDER BY slug LIMIT 1"))[0]!.id;
});
test.afterAll(async () => {
  await stack?.stop();
  await bridge?.close();
  await k8s?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('a Codex pod runner is signed in from the page with a device code, turns Ready, and signs out again', async ({ browser, playwright }) => {
  fake('codex', { signedIn: false, url: 'https://auth.example.test/device', deviceCode: DEVICE_CODE, pendingMs: 1500 });
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'codex-pod', label: 'Codex pod', kind: 'codex_cli', maxConcurrent: 1, teams: { teams: [teamId] } });
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="codex-pod"]');
    await expect(row.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);
    // a new pod runner offers the page's own sign-in, not an upload form
    await expect(row.getByTestId('runner-signin-open')).toHaveCount(0);
    await row.getByTestId('runner-agent-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Codex pod' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Codex is not signed in.');
    await expect(dialog.getByTestId('agent-auth-home')).toContainText('pod');
    await expect(dialog.getByTestId('runner-signin-file')).toHaveCount(0);

    await dialog.locator('[data-method="chat-gpt-device-code"]').click();
    await expect(dialog.getByTestId('agent-auth-code')).toHaveText(DEVICE_CODE);
    await expect(dialog.getByTestId('agent-auth-link')).toHaveAttribute('href', 'https://auth.example.test/device');
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Codex is signed in.', { timeout: 20_000 });
    await expect(page.getByTestId('runner-status')).toContainText('Codex pod is signed in.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(row.getByTestId('runner-state')).toHaveText(/Ready/, { timeout: 15_000 });

    // sign out asks first, then the runner waits for a sign-in again
    await row.getByTestId('runner-agent-signin-open').click();
    const again = page.getByRole('dialog', { name: 'Sign-in for Codex pod' });
    await again.getByTestId('agent-auth-logout').click();
    await expect(again.getByTestId('agent-auth-logout-words')).toContainText('out in its pod');
    await again.getByTestId('agent-auth-logout-yes').click();
    await expect(again.getByTestId('agent-auth-status')).toContainText('Codex is not signed in.');
    await again.getByRole('button', { name: 'Close' }).click();
    await expect(row.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test('a Claude Code pod runner is signed in with a pasted code, which is on no page afterwards', async ({ browser, playwright }) => {
  fake('claude', { signedIn: false, url: 'https://claude.example.test/cai/oauth/authorize?code=true&client_id=fake' });
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'claude-pod', label: 'Claude pod', kind: 'claude_cli', maxConcurrent: 1, teams: { teams: [teamId] } });
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="claude-pod"]');
    await row.getByTestId('runner-agent-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Claude pod' });
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Claude Code is not signed in.');
    await dialog.locator('[data-method="claude-ai-login"]').click();
    await expect(dialog.getByTestId('agent-auth-link')).toHaveAttribute('href', /claude\.example\.test/);
    await dialog.getByTestId('agent-auth-answer').fill(PASTED);
    await dialog.getByTestId('agent-auth-send').click();
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Claude Code is signed in.', { timeout: 20_000 });
    await expect(page.locator('body')).not.toContainText(PASTED);
    const events = await stack.sql<Record<string, unknown>>("SELECT payload FROM app.events WHERE type = 'bot_runner.agent_auth.changed'");
    expect(JSON.stringify(events)).not.toContain(PASTED);
    expect(events.length).toBeGreaterThan(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(row.getByTestId('runner-state')).toHaveText(/Ready/, { timeout: 15_000 });
  } finally {
    await context.close();
  }
});

test('the older way, a sign-in file, is one button inside the dialog', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="claude-pod"]');
    await row.getByTestId('runner-agent-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Claude pod' });
    await dialog.getByTestId('agent-auth-use-file').click();
    const file = page.getByRole('dialog', { name: 'Sign-in for Claude pod' });
    await expect(file.getByTestId('runner-signin-file')).toBeVisible();
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});

test('Codex full access shows its words first, turns on for a one-team runner and for a runner that serves two teams (each team has its own pod)', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'codex-two', label: 'Codex two teams', kind: 'codex_cli', maxConcurrent: 1, teams: { teams: [teamId, otherTeamId] } });
  } finally {
    await api.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="codex-pod"]');
    await expect(page.locator('[data-testid="runner-row"][data-runner="claude-pod"]').getByTestId('runner-full-access-open')).toHaveCount(0);
    // a Codex runner of one team starts with full access on (the owner's decision); turning it off asks nothing more
    await expect(row.getByTestId('runner-full-access-badge')).toBeVisible();
    await row.getByTestId('runner-full-access-open').click();
    await page.getByRole('dialog', { name: 'Full access for Codex pod' }).getByTestId('runner-full-access-confirm').click();
    await expect(page.getByTestId('runner-status')).toContainText('no longer has full access');
    await expect(row.getByTestId('runner-full-access-badge')).toHaveCount(0);

    // turning it on shows its words first
    await row.getByTestId('runner-full-access-open').click();
    const dialog = page.getByRole('dialog', { name: 'Full access for Codex pod' });
    await expect(dialog.getByTestId('runner-full-access-words')).toHaveText(
      'Full access: Codex runs commands without asking. It is held by its pod: the pod reaches the site and the internet on port 443, and no other address in the cluster.',
    );
    await dialog.getByTestId('runner-full-access-confirm').click();
    await expect(page.getByTestId('runner-status')).toContainText('Codex pod now has full access.');
    await expect(row.getByTestId('runner-full-access-badge')).toBeVisible();
    const rows = await stack.sql<{ full_access: boolean }>("SELECT full_access FROM app.bot_runners WHERE name = 'codex-pod'");
    expect(rows[0]?.full_access).toBe(true);
    const audit = await stack.sql<Record<string, unknown>>('SELECT * FROM app.audit_events');
    expect(JSON.stringify(audit)).toMatch(/full access/i);

    // two teams (P26-21): each team has a pod of its own, so full access is not refused; the page says what the teams share
    const two = page.locator('[data-testid="runner-row"][data-runner="codex-two"]');
    await expect(two.getByTestId('runner-full-access-badge')).toBeVisible();
    await expect(two.getByTestId('runner-shared-signin-note')).toHaveText("Teams on this runner share its sign-in and its plan's limits.");
    await expect(row.getByTestId('runner-shared-signin-note')).toHaveCount(0);
    await two.getByTestId('runner-full-access-open').click();
    await page.getByRole('dialog', { name: 'Full access for Codex two teams' }).getByTestId('runner-full-access-confirm').click();
    await expect(two.getByTestId('runner-full-access-badge')).toHaveCount(0);
    await two.getByTestId('runner-full-access-open').click();
    const again = page.getByRole('dialog', { name: 'Full access for Codex two teams' });
    await again.getByTestId('runner-full-access-confirm').click();
    await expect(page.getByTestId('runner-status')).toContainText('Codex two teams now has full access.');
    await expect(two.getByTestId('runner-full-access-badge')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a runner shared by two teams lists both teams and both teams\' bots, says what the teams share, and is signed in once for all of them (P26-21)', async ({ browser, playwright }) => {
  fake('codex', { signedIn: false, url: 'https://auth.example.test/device', deviceCode: DEVICE_CODE, pendingMs: 1500 });
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await api.post('/api/admin/bot-runners', { name: 'codex-duo', label: 'Codex duo', kind: 'codex_cli', maxConcurrent: 1, teams: { teams: [teamId, otherTeamId] } });
  } finally {
    await api.ctx.dispose();
  }
  // one bot of each team is placed on the runner (a team lead's BOT.md does this in life; the count is what the page reads)
  const ws = (await stack.sql<{ id: string }>('SELECT id FROM app.workspaces LIMIT 1'))[0]!.id;
  for (const [team, slug] of [[teamId, 'duo-one'], [otherTeamId, 'duo-two']] as const) {
    await stack.sql(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, triggers, model_aliases, placement)
       VALUES ($1, $2, $3, $3, '', 'agent', 'rules', 'team', repeat('a', 64), 'active', '[{"type":"mention"}]'::jsonb, ARRAY['smart'], '{"runs_on":"codex-duo"}'::jsonb)`,
      [ws, team, slug],
    );
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const row = page.locator('[data-testid="runner-row"][data-runner="codex-duo"]');
    // both teams are on the list, both bots are counted, and the page says what the teams share
    const names = await stack.sql<{ name: string }>('SELECT name FROM app.teams WHERE id = ANY($1::uuid[]) ORDER BY name', [[teamId, otherTeamId]]);
    for (const n of names) await expect(row.getByTestId('runner-teams')).toContainText(n.name);
    await expect(row.getByTestId('runner-bots')).toHaveText('2 bots');
    await expect(row.getByTestId('runner-shared-signin-note')).toHaveText("Teams on this runner share its sign-in and its plan's limits.");
    await expect(row.getByTestId('runner-state')).toHaveText(/Waiting for sign-in/);

    // the same words in the Teams dialog, then one sign-in for the runner
    await row.getByTestId('runner-teams-open').click();
    await expect(page.getByRole('dialog').getByTestId('runner-shared-signin-note')).toBeVisible();
    await page.keyboard.press('Escape');
    await row.getByTestId('runner-agent-signin-open').click();
    const dialog = page.getByRole('dialog', { name: 'Sign-in for Codex duo' });
    await dialog.locator('[data-method="chat-gpt-device-code"]').click();
    await expect(dialog.getByTestId('agent-auth-code')).toHaveText(DEVICE_CODE);
    await expect(dialog.getByTestId('agent-auth-status')).toContainText('Codex is signed in.', { timeout: 20_000 });
    await expect(page.getByTestId('runner-status')).toContainText('Codex duo is signed in.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(row.getByTestId('runner-state')).toHaveText(/Ready/, { timeout: 15_000 });
    // one runner, one sign-in: there is no second runner or second sign-in for the second team
    expect((await stack.sql<{ n: number }>("SELECT count(*)::int AS n FROM app.bot_runners WHERE name = 'codex-duo'"))[0]!.n).toBe(1);
    const signins = await stack.sql<Record<string, unknown>>("SELECT payload FROM app.events WHERE type = 'bot_runner.agent_auth.changed' AND payload::text LIKE '%codex-duo%'");
    expect(signins.length).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('a member cannot reach the routes, and the dialog fits a phone', async ({ browser, playwright }) => {
  const member = await apiOn(playwright, stack, 'nadia');
  try {
    const id = (await stack.sql<{ id: string }>("SELECT id FROM app.bot_runners WHERE name = 'codex-pod'"))[0]!.id;
    expect([403, 404]).toContain(await member.status('GET', `/api/admin/bot-runners/${id}/agent-auth`));
    expect([403, 404]).toContain(await member.status('POST', `/api/admin/bot-runners/${id}/agent-auth/logout`));
  } finally {
    await member.ctx.dispose();
  }
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE, mobile: true });
  try {
    await page.locator('[data-testid="runner-row"][data-runner="codex-pod"]').getByTestId('runner-agent-signin-open').click();
    await expect(page.getByRole('dialog', { name: 'Sign-in for Codex pod' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
