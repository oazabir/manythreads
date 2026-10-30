import { createPublicKey, verify } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { APPROVALS_STACK_ENV, arrangeApprovals } from '../approvals/support.ts';
import { BOT_MD, definitionOf } from '../bots/support.ts';
import { PERSONA_PASSWORD, personaEmail } from '../support/env.ts';
import { applyGuarded, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * The Audit console (PLAN P10-05): a workspace admin opens Settings -> Workspace -> Audit and finds who did what, to what, and what was withheld.
 * The stack is its own because the spec writes: a real password sign-in, a guarded change applied through a proposal, and an approval decided.
 * A member gets 403 from the API and no menu entry. The export is signed; the file is checked here with the public key the way an auditor would.
 * Runs on desktop and at the phone width (the table becomes cards; no sideways scroll).
 */
let stack: Stack;
let approvalId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...APPROVALS_STACK_ENV });
  // a real sign-in (the test-only session route leaves no sign-in event) and a refused one
  const anon = await playwright.request.newContext({ baseURL: stack.origin });
  const ok = await anon.post('/api/auth/password/sign-in', { data: { email: personaEmail('omar'), password: PERSONA_PASSWORD } });
  expect(ok.status()).toBe(200);
  await anon.dispose();
  // a fresh context: the first sign-in left a session cookie, and the next write would then need its CSRF header
  const stranger = await playwright.request.newContext({ baseURL: stack.origin });
  const refused = await stranger.post('/api/auth/password/sign-in', { data: { email: personaEmail('nadia'), password: 'not-the-password' } });
  expect(refused.status()).toBe(401);
  await stranger.dispose();

  // a guarded change, applied through a proposal by the lead
  const omar = await apiOn(playwright, stack, 'omar');
  const base = await definitionOf(omar);
  const applied = await applyGuarded(omar, BOT_MD, `${base.content.trimEnd()}\n\nAlways say what changed.\n`, 'Say what changed', { baseBlobSha: base.blobSha });
  expect(applied.status, applied.text).toBeLessThan(300);
  await omar.ctx.dispose();

  // an approval, decided by the person it is addressed to
  const [arranged] = await arrangeApprovals(stack, [{ path: 'pages/audit-e2e.md', requester: 'nadia' }]);
  approvalId = arranged!.id;
  const rafi = await apiOn(playwright, stack, 'rafi');
  await rafi.post(`/api/teams/engineering/approvals/${approvalId}/approve`, { note: 'fine' });
  await rafi.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

const actions = (page: import('@playwright/test').Page) => page.locator('[data-testid="audit-table"] tbody tr').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-action')));

test('the admin sees the proposal applied, the approval decided and the sign-in, and filters to one', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/audit');
  try {
    await expect(page.getByTestId('audit-table')).toBeVisible();
    await expect.poll(() => actions(page), { timeout: 60_000 }).toEqual(expect.arrayContaining(['proposal.applied', 'approval.decided', 'sign_in.succeeded']));
    expect(await actions(page)).toContain('sign_in.failed');
    expect(await noSidewaysScroll(page)).toBe(true);

    await page.getByLabel('Did what').selectOption('proposal.applied');
    await expect.poll(async () => [...new Set(await actions(page))]).toEqual(['proposal.applied']);
    await expect(page.getByTestId('audit-table')).toContainText('Omar');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a filter with no match shows the empty state', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/audit');
  try {
    await expect(page.getByTestId('audit-table')).toBeVisible();
    await page.getByLabel('Outcome').selectOption('withheld');
    await expect(page.getByTestId('audit-empty')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a member gets 403 from the API and no Audit entry in the menu', async ({ browser, playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  expect(await nadia.status('GET', '/api/admin/audit')).toBe(403);
  expect(await nadia.status('POST', '/api/admin/audit/export', {})).toBe(403);
  expect(await nadia.status('GET', '/api/admin/audit/signing-key')).toBe(403);
  await nadia.ctx.dispose();
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/');
  try {
    await expect(page.locator('[data-landmark="sidebar"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Audit', exact: true })).toHaveCount(0);
    await page.goto(`${stack.origin}/settings/workspace/audit`);
    await expect(page.getByTestId('audit-table')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the export is signed, holds no message text, and is itself an audit row', async ({ playwright }) => {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    const res = await omar.ctx.post('/api/admin/audit/export', { data: {}, headers: await omar.headers() });
    expect(res.status(), await res.text()).toBe(200);
    const bytes = await res.body();
    const signature = Buffer.from(res.headers()['x-audit-signature']!, 'base64');
    const key = await omar.get<{ publicKeyPem: string; keyId: string }>('/api/admin/audit/signing-key');
    expect(res.headers()['x-audit-key-id']).toBe(key.keyId);
    expect(verify(null, bytes, createPublicKey(key.publicKeyPem), signature)).toBe(true);
    expect(verify(null, Buffer.concat([bytes, Buffer.from(' ')]), createPublicKey(key.publicKeyPem), signature)).toBe(false);
    const lines = bytes.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: 'manythreads.audit.export', contentBlind: true });
    expect(lines.length).toBeGreaterThan(3);
    await expect
      .poll(async () => (await omar.get<{ entries: Array<{ action: string }> }>('/api/admin/audit?action=audit.exported')).entries.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
  } finally {
    await omar.ctx.dispose();
  }
});

test('the Export button saves a file and offers the signature', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/audit');
  try {
    await expect(page.getByTestId('audit-table')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByTestId('audit-export').click();
    expect((await download).suggestedFilename()).toMatch(/\.ndjson$/);
    await expect(page.getByTestId('audit-export-done')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
