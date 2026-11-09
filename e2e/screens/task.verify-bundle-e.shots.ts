/* eslint-disable @typescript-eslint/no-explicit-any -- live probe: the answers of the site are read as loose JSON */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live, READ-ONLY check of Bundle E on the production site (PLAN P19-12, E12): the Runners page lists what the API lists, the Add chooser shows Claude Code and Codex shut with
 * "Not turned on in this install." (the owner has not turned the pods on), System health says "Replica lag: no standby" (one database, no Barman bucket yet), and no page throws, answers
 * a 5xx or scrolls sideways. It makes nothing: the browser context aborts every request that is not GET, HEAD or OPTIONS, and `api()` refuses anything else.
 *
 * Run (the lead does; the password is a one-off that task-shots.sh rotates away afterwards):
 *   .\tools\devbox\Remote.ps1 'bash tools/devbox/task-shots.sh omar@kahf.example task.verify-bundle-e.shots.ts'
 * or by hand: MANYTHREADS_LIVE_PASSWORD=... MANYTHREADS_URL=https://manythreads.kahf.to pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-bundle-e --retries=0 --workers=1
 * Shots go to MANYTHREADS_SHOTS_DIR (default temp/screenshots/verify-e) as `<name>.<1440|390>.<light|dark>.png`; results.txt lists PASS / FAIL per check. Nothing here is known to pass.
 */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? process.env['OMAR_PASSWORD'] ?? '';
const EMAIL = process.env['OMAR_EMAIL'] ?? 'omar@kahf.example';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'verify-e');
const T = { timeout: 20_000 };
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const VIEW = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } } as const;
const results: string[] = [];
const problems: string[] = [];
const note = (ok: boolean, name: string, detail = ''): void => {
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`;
  results.push(line);
  console.log(`[e] ${line}`);
};

async function signedIn(browser: Browser, width: 1440 | 390, scheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (use tools/devbox/task-shots.sh)');
  const context = await browser.newContext({ baseURL: BASE, viewport: VIEW[width], colorScheme: scheme, reducedMotion: 'reduce', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
  // Read-only by construction: anything that could write is aborted, except the sign-in form's own POST (a session is the only thing it makes).
  await context.route('**/*', (route) => {
    const req = route.request();
    const m = req.method();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
    if (m === 'POST' && new URL(req.url()).pathname === '/api/auth/password/sign-in') return route.continue();
    problems.push(`blocked ${m} ${new URL(req.url()).pathname}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message.slice(0, 160)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error ${m.text().slice(0, 160)}`);
  });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { context, page };
}

async function api(page: Page, path: string, method = 'GET'): Promise<{ status: number; body: any }> {
  if (method !== 'GET') throw new Error(`read-only probe: refusing ${method} ${path}`);
  const res = await page.request.get(path);
  return { status: res.status(), body: await res.json().catch(() => null) };
}

const sideways = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

for (const width of [1440, 390] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`Runners page and the Add chooser at ${width} ${scheme}`, async ({ browser }) => {
      const { context, page } = await signedIn(browser, width, scheme);
      try {
        const tag = `${width}.${scheme}`;
        await page.goto('/settings/workspace/runners');
        await expect(page.getByTestId('runner-add')).toBeVisible(T);
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: join(OUT, `runners.${tag}.png`), fullPage: true });

        // the page lists the same runners the API lists
        const listed = await api(page, '/api/admin/bot-runners');
        const apiNames: string[] = (listed.body?.items ?? []).map((r: any) => r.name as string).sort();
        const shown: string[] = (await page.getByTestId('runner-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-runner') ?? ''))).sort();
        note(listed.status === 200 && JSON.stringify(shown) === JSON.stringify(apiNames), `runners page lists the API's runners ${tag}`, `page ${shown.join(',') || 'none'} / api ${apiNames.join(',') || 'none'}`);

        // no address, key or sign-in field in what the admin list says about a runner
        const body = JSON.stringify(listed.body ?? {});
        const leaks = ['"apiKey"', '"accessToken"', '"refreshToken"', 'sk-ant-', 'secret_id', 'credentials_sha256'].filter((n) => body.includes(n));
        note(leaks.length === 0, `admin runner list holds no key or token field ${tag}`, leaks.join(','));

        // the chooser: open it, read the five cards, close it
        await page.getByTestId('runner-add').click();
        await expect(page.getByTestId('runner-kind-claude_cli')).toBeVisible(T);
        for (const kind of ['claude_cli', 'codex_cli'] as const) {
          const card = page.getByTestId(`runner-kind-${kind}`);
          const text = (await card.innerText()).replace(/\s+/g, ' ');
          const disabled = await card.isDisabled().catch(() => false);
          note(text.includes('Not turned on in this install.') && disabled, `${kind} card is shut with its reason ${tag}`, `disabled=${String(disabled)} "${text.slice(0, 120)}"`);
        }
        for (const kind of ['hermes_gateway', 'hermes_pod', 'llm_gateway'] as const) note((await page.getByTestId(`runner-kind-${kind}`).count()) === 1, `${kind} card is offered ${tag}`);
        await page.screenshot({ path: join(OUT, `chooser.${tag}.png`), fullPage: true });
        note(!(await sideways(page)), `runners page does not scroll sideways ${tag}`);
        await page.keyboard.press('Escape');
      } finally {
        await context.close();
      }
    });

    test(`System health at ${width} ${scheme}`, async ({ browser }) => {
      const { context, page } = await signedIn(browser, width, scheme);
      try {
        const tag = `${width}.${scheme}`;
        await page.goto('/settings/workspace/health');
        await expect(page.getByText('System health').first()).toBeVisible(T);
        await expect(page.getByText('Loading…')).toHaveCount(0, T);
        await page.waitForLoadState('networkidle');
        const text = (await page.locator('main').innerText().catch(() => page.locator('body').innerText())).replace(/\s+/g, ' ');
        note(/Replica lag\s*no standby/i.test(text), `System health says "Replica lag: no standby" ${tag}`, text.match(/Replica lag.{0,40}/i)?.[0] ?? 'row not found');
        note(!(await sideways(page)), `System health does not scroll sideways ${tag}`);
        await page.screenshot({ path: join(OUT, `health.${tag}.png`), fullPage: true });
      } finally {
        await context.close();
      }
    });
  }
}

test('the walk made no 5xx, page error or console error, and tried no write', async () => {
  writeFileSync(join(OUT, 'results.txt'), `${results.join('\n')}\n\nproblems:\n${problems.join('\n') || 'none'}\n`);
  const failed = results.filter((r) => r.startsWith('FAIL'));
  expect(problems, 'problems seen while walking').toEqual([]);
  expect(failed, `failed checks (see ${join(OUT, 'results.txt')})`).toEqual([]);
});
