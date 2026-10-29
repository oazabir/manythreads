import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * P14-14 on the live site: a lead makes an incoming webhook on #alerts, a build server posts to its public address (a generic JSON call and
 * a GitHub workflow_run), the messages arrive, and the webhook is switched off again (an old address then answers 404).
 * The address is redacted from the pictures' file names and the webhook is revoked in the same run.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-14-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };

test('an incoming webhook, end to end', async ({ browser, request }) => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  mkdirSync(OUT, { recursive: true });

  await page.goto('/t/engineering');
  await page.getByRole('link', { name: /alerts/ }).first().click();
  await page.getByTestId('webhooks-open').click();
  await page.getByTestId('webhook-name').fill('GitHub Actions');
  await page.getByTestId('webhook-create').click();
  const urlBox = page.getByTestId('webhook-url');
  await expect(urlBox).toBeVisible(T);
  const address = (await urlBox.textContent()) ?? '';
  expect(address).toContain('/hooks/');
  // the address is a secret: blank it in the picture
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-testid="webhook-url"], [data-testid="webhook-curl"]'))) el.textContent = 'https://manythreads.kahf.to/hooks/…/…  (redacted)';
  });
  await page.screenshot({ path: join(OUT, 'p14-14-01-dialog-address.png'), animations: 'disabled' });

  try {
    const generic = await request.post(address, { data: { title: 'Deploy finished', text: 'manythreads 22666274d390 is live', status: 'success', url: 'https://manythreads.kahf.to' } });
    expect(generic.status()).toBe(200);
    const gh = await request.post(address, {
      headers: { 'X-GitHub-Event': 'workflow_run' },
      data: {
        action: 'completed',
        workflow_run: { name: 'ci', conclusion: 'failure', head_branch: 'main', html_url: 'https://github.com/example/manythreads/actions/runs/1', head_sha: '6201095bb8b2', display_title: 'ENG-08: branch rule' },
        repository: { full_name: 'example/manythreads' },
      },
    });
    expect(gh.status()).toBe(200);
    const wrong = await request.post(address.replace(/\/[^/]+$/, '/mtwh_wrong'), { data: { text: 'x' } });
    expect(wrong.status()).toBe(404);

    await page.keyboard.press('Escape');
    await expect(page.getByText('Deploy finished').first()).toBeVisible(T);
    await expect(page.getByText(/workflow|ci/i).first()).toBeVisible(T);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(OUT, 'p14-14-02-messages-arrive.png'), animations: 'disabled' });
  } finally {
    // switch the webhook off again
    if (!(await page.getByTestId('webhook-revoke').first().isVisible())) await page.getByTestId('webhooks-open').click();
    await page.getByTestId('webhook-revoke').first().click();
    await page.getByTestId('webhook-revoke-confirm').click();
    await expect(page.getByTestId('webhooks-empty')).toBeVisible(T);
    const gone = await request.post(address, { data: { text: 'after revoke' } });
    expect(gone.status()).toBe(404);
  }
  await context.close();
});
