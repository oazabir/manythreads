import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/*
 * Live check of P21-12 (page header), P21-13 (plain words), P21-20 (look tokens), read-only.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-p21-12-13-20 --retries=0 --timeout=60000
 * Signs in as Omar through the form (credentials from the environment; never printed). Creates nothing; starts no bot run.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/v211220';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
const fivexx: string[] = [];
const JARGON = ['BOT.md', 'TEAM.md', 'bots/', 'routines/', 'slug', 'frontmatter', 'uuid', 'YAML', 'markdown'];
const T = '/t/engineering';
const pages: Array<[string, string, boolean]> = [
  ['boards', `${T}/boards`, true], ['org', `${T}/org`, true], ['jobs', `${T}/jobs`, true], ['recipes', `${T}/recipes`, true],
  ['agents', `${T}/agents`, true], ['projects', `${T}/projects`, true], ['proposals', `${T}/proposals`, true], ['bots', `${T}/bots`, true],
  ['memory', `${T}/memory`, true], ['files', `${T}/files`, true], ['approvals', `${T}/approvals`, true], ['threads', `${T}/threads`, true],
  ['set-roster', '/settings/team/engineering/roster', true], ['set-workspace', '/settings/workspace/general', false],
  ['set-signin', '/settings/workspace/sign-in', false], ['set-teams', '/teams', false], ['set-llm', '/settings/workspace/llm', false],
  ['set-audit', '/settings/workspace/audit', false], ['set-usage', '/settings/workspace/usage', false], ['account', '/account', false],
  ['channel', `${T}/c/general`, false],
];
let page: Page;
const shoot = async (n: string): Promise<void> => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${n}.png`) });
};
const audit = async (name: string, w: number, team: boolean): Promise<void> => {
  const r = await page.evaluate((jargon) => {
    const vis = (e: Element): boolean => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden'; };
    const h1 = Array.from(document.querySelectorAll('h1')).filter(vis).map((e) => (e.textContent ?? '').trim().slice(0, 40));
    const crumbs = Array.from(document.querySelectorAll('nav.crumbs li')).filter(vis).map((e) => (e.textContent ?? '').trim());
    const text = (document.querySelector('main') as HTMLElement | null)?.innerText ?? '';
    const hits = jargon.filter((j) => text.includes(j));
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) hits.push('raw-id');
    const small: Record<string, number> = {};
    document.querySelectorAll('main *').forEach((e) => { if (e.children.length === 0 && (e.textContent ?? '').trim() && vis(e)) { const f = parseFloat(getComputedStyle(e).fontSize); if (f < 12) small[f + ''] = (small[f + ''] ?? 0) + 1; } });
    const bells = Array.from(document.querySelectorAll('[aria-label*="otification" i]')).filter(vis).length;
    const clipped = Array.from(document.querySelectorAll('main h1, main .ph-desc, main button, main a')).filter((e) => vis(e) && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible' && getComputedStyle(e).textOverflow !== 'ellipsis').length;
    return { h1, crumbs, hits, small, bells, clipped, ph: document.querySelectorAll('[data-landmark="page-header"]').length, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  }, JARGON);
  const pass = r.h1.length === 1;
  if (team) log(`${r.hits.length ? 'FAIL' : 'PASS'} jargon ${name}@${w}: ${JSON.stringify(r.hits)}`);
  log(`${pass ? 'PASS' : 'FAIL'} h1 ${name}@${w}: h1=${JSON.stringify(r.h1)} crumbs=${JSON.stringify(r.crumbs)} pageHeaders=${r.ph} bells=${r.bells} scrollW=${r.sw}/${r.cw} clippedCtl=${r.clipped} small<12px=${JSON.stringify(r.small)}${team ? ` jargon=${JSON.stringify(r.hits)}` : ''}`);
};

test('sign in', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) { fivexx.push(`${r.status()} ${r.url()}`); log(`SERVER ${r.status()} ${r.url()}`); } });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
});

for (const [name, path, team] of pages) {
  test(`shots ${name}`, async () => {
    for (const w of [1440, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
      await page.goto(path);
      await page.waitForTimeout(800);
      if (name === 'files') {
        const f = page.locator('main [role="treeitem"], main [data-testid*="file-row"], main [data-testid*="tree"] a, main a[href*="files"]').first();
        if (await f.count()) await f.click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(800);
      }
      await audit(name, w, team);
      await shoot(`${name}-${w}`);
      if (name === 'bots' && w === 1440) {
        const href = await page.locator('main a[href*="/bots/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '').find((h) => /\/bots\/[^/]+$/.test(h) && !h.endsWith('/new')) ?? '');
        log(`first bot href ${href}`);
        for (const bw of [1440, 390]) {
          await page.setViewportSize({ width: bw, height: bw === 390 ? 844 : 900 });
          if (href) await page.goto(href);
          await page.waitForTimeout(800);
          await audit('botpage', bw, true);
          await shoot(`botpage-${bw}`);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    }
  });
}

test('skip link and focus rings', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${T}/boards`);
  await page.waitForTimeout(800);
  await page.keyboard.press('Tab');
  const skip = page.locator('a.skip-link');
  const box = await skip.boundingBox();
  const onScreen = !!box && box.y >= -1 && box.y < 200 && box.width > 0;
  await shoot('skip-link-focused');
  await page.keyboard.press('Enter');
  const focusedId = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName);
  log(`${onScreen && focusedId === 'content' ? 'PASS' : 'FAIL'} skip link visible=${onScreen} focus after Enter=${focusedId}`);
  const ring = async (loc: ReturnType<Page['locator']>, n: string): Promise<void> => {
    await loc.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const s = await loc.evaluate((e) => { const c = getComputedStyle(e); return { outline: `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor}`, shadow: c.boxShadow.slice(0, 120), fv: e.matches(':focus-visible') }; });
    log(`ring ${n}: ${JSON.stringify(s)}`);
    await loc.screenshot({ path: join(OUT, `ring-${n}.png`) }).catch(() => undefined);
    await page.screenshot({ path: join(OUT, `ring-${n}-full.png`) });
    if (n === 'rail-search') {
      const rr = await loc.evaluate((e) => { const d = (x: Element | null) => { if (!x) return null; const c = getComputedStyle(x); return { outline: c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0 && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(c.outlineColor), shadow: c.boxShadow !== 'none', tag: x.tagName, cls: x.className.toString().slice(0, 40) }; }; return { input: d(e), parent: d(e.parentElement), grand: d(e.parentElement?.parentElement ?? null) }; });
      const rings = [rr.input, rr.parent, rr.grand].filter((x) => x && (x.outline || x.shadow)).length;
      log(`${rings === 1 ? 'PASS' : 'FAIL'} rail search ring count=${rings} ${JSON.stringify(rr)}`);
    }
  };
  await ring(page.locator('[data-landmark="sidebar"] a').nth(2), 'sidebar-link');
  await ring(page.locator('[data-landmark="search"] input').first(), 'rail-search');
  await page.goto('/account');
  await page.waitForTimeout(800);
  const inp = page.locator('main input:not([type=hidden]):not([type=checkbox])').first();
  if (await inp.count()) await ring(inp, 'account-input');
});

test('approvals pane text, files header, inbox', async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${T}/approvals`);
  await page.waitForTimeout(800);
  const apTxt = await page.locator('main').innerText();
  log(`${apTxt.includes('Select a request') ? 'PASS' : 'FAIL'} approvals empty pane shows 'Select a request'`);
  log(`approvals text: ${JSON.stringify(((await page.locator('main').innerText()) ?? '').slice(0, 400))}`);
  await page.goto(`${T}/files`);
  await page.waitForTimeout(800);
  log(`files text: ${JSON.stringify(((await page.locator('main').innerText()) ?? '').slice(0, 500))}`);
  log(`5xx: ${fivexx.length}`);
});

test('files with a file open', async () => {
  for (const w of [1440, 390]) {
    await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
    await page.goto(`${T}/files`);
    await page.waitForTimeout(800);
    for (const folder of ['pages/', 'reports/']) {
      const row = page.locator('main').getByText(folder, { exact: true }).last();
      if (await row.count()) { await row.dblclick({ timeout: 3000 }).catch(() => undefined); await page.waitForTimeout(700); }
    }
    const files = page.locator('main [data-testid^="file-row"], main [role="row"] a, main [role="row"]');
    log(`files rows visible ${await files.count()}`);
    const target = page.locator('main [role="row"]').filter({ hasNotText: /\/$/ }).filter({ hasNotText: 'Name' }).first();
    if (await target.count()) await target.click({ timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    log(`file view ${w}: header=${JSON.stringify((await page.locator('[data-testid="file-view"], [data-testid="file-preview"]').first().innerText({ timeout: 2000 }).catch(() => 'none')).slice(0, 300))}`);
    await shoot(`files-open-${w}`);
  }
});
