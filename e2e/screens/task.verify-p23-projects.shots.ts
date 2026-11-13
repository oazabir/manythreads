/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * Live view-only check of the Projects sidebar section and the Projects page (PLAN P23-02). Creates and changes nothing.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-p23-projects --retries=0 --timeout=90000
 */
const BASE = process.env['MANYTHREADS_URL'] ?? '';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/p23';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`projects ${w}`, async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const bad: string[] = [];
    page.on('response', (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`); });
    page.on('pageerror', (e) => bad.push(`PAGEERROR ${e.message}`));
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
    await page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
    await page.goto('/t/engineering/projects');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(OUT, `projects-${w}.png`), fullPage: true });
    const api = await page.request.get('/api/teams/engineering/projects');
    const body: any = await api.json().catch(() => null);
    log(`${w} api ${api.status()} ${JSON.stringify((body?.items ?? []).map((p: any) => `${p.name}:${p.provider}:${p.commitAs}:${p.pushCredentialStatus ?? ''}`))}`);
    log(`${w} sidebar section: ${await page.getByText('Projects', { exact: true }).count()} labels; links ${await page.locator('a[href*="/projects/"]').count()}`);
    const add = page.getByRole('button', { name: /add project|add a project|new project/i }).first();
    if (await add.count()) {
      await add.click();
      await page.waitForTimeout(800);
      log(`${w} form text: ${(await page.locator('form').first().innerText().catch(() => 'n/a')).replace(/\s+/g, ' ').slice(0, 600)}`);
      await page.screenshot({ path: join(OUT, `add-${w}.png`), fullPage: true });
      // type three addresses (nothing is submitted): the provider is read from the address, or asked for another host
      for (const [tag, url] of [['gitlab', 'https://gitlab.com/grp/sub/proj'], ['custom', 'https://git.example.org/grp/proj']] as const) {
        await page.getByLabel('Repository address').fill(url);
        await page.waitForTimeout(500);
        log(`${w} ${tag}: provider select=${await page.locator('select[id="pj-new-provider"]').count()} bot-username=${await page.getByTestId('projects-bot-username').count()} bot-token=${await page.getByTestId('projects-bot-token').count()} text="${(await page.locator('form').nth(0).innerText()).replace(/\s+/g, ' ').slice(0, 400)}"`);
        await page.screenshot({ path: join(OUT, `add-${tag}-${w}.png`), fullPage: true });
      }
    } else log(`${w} no add button`);
    log(`${w} h-scroll=${await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)} problems: ${JSON.stringify(bad)}`);
    await ctx.close();
  });
}
