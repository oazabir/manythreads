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
  // two more in a row: the console folds the three into "Omar signed in ×3"
  for (let i = 0; i < 2; i += 1) {
    const again = await playwright.request.newContext({ baseURL: stack.origin });
    expect((await again.post('/api/auth/password/sign-in', { data: { email: personaEmail('omar'), password: PERSONA_PASSWORD } })).status()).toBe(200);
    await again.dispose();
  }
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

test('repeated sign-ins fold into one row that opens; Who and Outcome are chips; the header stays in view', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(120_000); // the audit rows arrive from the event outbox: the first wait below is allowed 60 s
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/audit');
  try {
    await expect(page.getByTestId('audit-table')).toBeVisible();
    const toggle = page.getByTestId('audit-fold-toggle').filter({ hasText: 'Signed in ×3' });
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    await expect(toggle).toHaveAccessibleName(/Omar signed in ×3/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('tr.audit-sub')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('tr.audit-sub[data-action="sign_in.succeeded"]')).toHaveCount(3);
    expect(await noSidewaysScroll(page)).toBe(true);
    await toggle.click();
    await expect(page.locator('tr.audit-sub')).toHaveCount(0);

    // Who: a chip toggles, pressing it again clears. The rows must change to Omar's alone; an empty list would also pass "every row is Omar's", so it must hold some.
    const omarChip = page.getByRole('group', { name: 'Who' }).getByRole('button', { name: 'Omar', exact: true });
    await expect(omarChip).toHaveAttribute('aria-pressed', 'false');
    await omarChip.click();
    await expect(omarChip).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => {
        const who = await page.locator('[data-testid="audit-table"] tbody tr .audit-who').allTextContents();
        return who.length > 0 && who.every((t) => t === 'Omar');
      })
      .toBe(true);
    await omarChip.click();
    await expect(omarChip).toHaveAttribute('aria-pressed', 'false');
    // the other person (the refused sign-in was Nadia's address) is back in the list
    await expect.poll(async () => (await page.locator('[data-testid="audit-table"] tbody tr .audit-who').allTextContents()).includes('Nadia')).toBe(true);

    // Outcome: Refused keeps the refused sign-in (the audit maps sign_in.failed to the "denied" outcome, worded Refused) and drops the done ones.
    // Poll for both halves together: the list before the click already holds the failed row, so a lone "contains" would pass on the old list.
    const refused = page.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'Refused', exact: true });
    await refused.click();
    await expect(refused).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () => {
        const seen = await actions(page);
        return seen.includes('sign_in.failed') && !seen.includes('sign_in.succeeded') && !seen.includes('proposal.applied');
      })
      .toBe(true);
    await expect(page.locator('tr.audit-fold')).toHaveCount(0);
    await refused.click();
    await expect(refused).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await actions(page)).includes('sign_in.succeeded')).toBe(true);

    // the column heads are sticky (on a phone the head row is hidden and each cell carries its own label)
    if (!isMobile) await expect(page.locator('.audit-table th').first()).toHaveCSS('position', 'sticky');
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a filter with no match shows the empty state', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/audit');
  try {
    await expect(page.getByTestId('audit-table')).toBeVisible();
    const withheld = page.getByRole('group', { name: 'Outcome' }).getByRole('button', { name: 'Withheld', exact: true });
    await withheld.click();
    await expect(withheld).toHaveAttribute('aria-pressed', 'true');
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
