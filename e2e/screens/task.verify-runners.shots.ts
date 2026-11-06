/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/*
 * Live view-only check of the Runners admin page (PLAN P19-04..08). Creates and changes nothing.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-runners --retries=0 --timeout=60000
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/runners';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`runners page ${w}`, async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const bad: string[] = [];
    page.on('response', (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`); });
    page.on('pageerror', (e) => bad.push(`PAGEERROR ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') bad.push(`console.error ${m.text().slice(0, 200)}`); });
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
    await page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
    await page.goto('/settings/workspace/runners');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(OUT, `runners-${w}.png`), fullPage: true });
    const rows = await page.getByTestId('runner-row').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-runner')}: ${(e as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 220)}`));
    log(`${w} rows ${rows.length}`); rows.forEach((r) => log(`  ${r}`));
    log(`${w} old=${await page.getByTestId('runner-old').count()} empty=${await page.getByTestId('runner-empty').count()} h-scroll=${await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)}`);
    const api = await page.request.get('/api/admin/bot-runners');
    const body: any = await api.json().catch(() => null);
    log(`api ${api.status()} ${JSON.stringify((body?.items ?? []).map((x: any) => `${x.name}:${x.kind}:${x.state ?? x.status}${x.node ? ':node=' + x.node : ''}`))}`);
    const nodes = await page.request.get('/api/admin/bot-runners/nodes');
    log(`nodes ${nodes.status()} ${JSON.stringify(await nodes.json().catch(() => null)).slice(0, 400)}`);
    // node choice (view only): open the editor of the first pod runner, do not save
    const open = page.getByTestId('runner-node-open').first();
    if (await open.count()) {
      await open.click();
      await page.waitForTimeout(1500);
      log(`node select options: ${JSON.stringify(await page.getByTestId('runner-node-select').first().locator('option').allInnerTexts().catch(() => 'n/a'))} state="${await page.getByTestId('runner-node-state').first().innerText().catch(() => 'n/a')}"`);
      await page.screenshot({ path: join(OUT, `node-${w}.png`), fullPage: true });
    } else log('no node control shown');
    // chooser: open, read the cards, cancel
    await page.keyboard.press('Escape');
    await page.getByTestId('runner-add').click();
    await page.waitForTimeout(800);
    for (const k of ['hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway']) {
      const c = page.getByTestId(`runner-kind-${k}`);
      log(`card ${k}: disabled=${await c.isDisabled().catch(() => 'n/a')} text="${(await c.innerText().catch(() => 'MISSING')).replace(/\s+/g, ' ')}"`);
    }
    await page.screenshot({ path: join(OUT, `chooser-${w}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    log(`${w} problems: ${JSON.stringify(bad)}`);
    await ctx.close();
  });
}

for (const [name, path] of [['board', '/t/engineering/boards'], ['threads', '/t/engineering/threads']] as const) {
  test(`spot check ${name}`, async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const bad: string[] = [];
    page.on('response', (r) => { if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`); });
    page.on('pageerror', (e) => bad.push(`PAGEERROR ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') bad.push(`console.error ${m.text().slice(0, 200)}`); });
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
    await page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
    await page.goto(path);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: join(OUT, `spot-${name}.png`) });
    log(`${name}: url ${page.url()} cards=${await page.getByTestId('board-card').count()} columns=${await page.getByTestId('board-column').count()} problems ${JSON.stringify(bad)}`);
    log(`${name} text: ${(await page.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
    await ctx.close();
  });
}
