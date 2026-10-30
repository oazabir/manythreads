import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Data protection (PLAN P10-04): a workspace admin opens Settings -> Workspace -> Data protection, adds a pattern of the workspace's own, tries a text in the
 * test box (the answer names what was found and never repeats it) and removes the pattern. A member has no menu entry and every route answers 403.
 * The key-shaped text is built from two halves so this file holds no key. Runs on desktop and at the phone width (no sideways scroll).
 */
let stack: Stack;
const KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;

test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('the admin adds a pattern, tries a text, and removes the pattern', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/guardrails');
  try {
    await expect(page.getByRole('heading', { name: 'Data protection', level: 1 })).toBeVisible();
    await expect(page.getByTestId('gr-dlp')).toBeVisible();
    await expect(page.getByTestId('gr-egress')).toBeVisible();
    await expect(page.getByTestId('gr-no-rules')).toBeVisible();

    await page.getByLabel('Name', { exact: true }).fill('ticket-code');
    await page.getByLabel('Pattern', { exact: true }).fill('TKT-[0-9]{4}');
    await page.getByRole('button', { name: 'Add pattern' }).click();
    await expect(page.getByText('Added ticket-code.')).toBeVisible();

    const box = page.getByTestId('gr-test');
    await box.getByLabel('Text to check').fill(`use ${KEY} for TKT-1234`);
    await box.getByRole('button', { name: 'Check' }).click();
    const result = page.getByTestId('gr-result');
    await expect(result).toBeVisible();
    await expect(result).toHaveAttribute('data-outcome', 'redact');
    const words = await result.innerText();
    expect(words).toContain('api-key');
    expect(words).toContain('ticket-code');
    expect(words).not.toContain(KEY);
    expect(words).not.toContain('TKT-1234');
    expect(await noSidewaysScroll(page)).toBe(true);

    await page.locator('li', { hasText: 'ticket-code' }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Removed ticket-code.')).toBeVisible();
    await expect(page.getByTestId('gr-no-rules')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a member gets 403 from every route and no Data protection entry in the menu', async ({ browser, playwright }) => {
  const nadia = await apiOn(playwright, stack, 'nadia');
  expect(await nadia.status('GET', '/api/admin/guardrails/dlp')).toBe(403);
  expect(await nadia.status('GET', '/api/admin/guardrails/egress')).toBe(403);
  expect(await nadia.status('POST', '/api/admin/guardrails/dlp/test', { text: 'hello', preset: 'standard' })).toBe(403);
  expect(await nadia.status('POST', '/api/admin/guardrails/dlp/rules', { name: 'sneaky', pattern: 'abc' })).toBe(403);
  await nadia.ctx.dispose();
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/');
  try {
    await expect(page.locator('[data-landmark="sidebar"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Data protection', exact: true })).toHaveCount(0);
    await page.goto(`${stack.origin}/settings/workspace/guardrails`);
    await expect(page.getByTestId('gr-dlp')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
