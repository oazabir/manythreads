/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of WP-F (P21-08 sidebar, P21-09 tab title/favicon, P21-10 jump to/search/bell, P21-11 Threads inbox).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-wpf --retries=0 --timeout=60000
 * Signs in as Omar and Nadia through the form (env vars, never printed). Nadia sends Omar one DM.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/wpf';
const TEAM = process.env['TEAM'] ?? 'engineering';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });

async function login(browser: Browser, who: string, w: number, h: number): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) log(`SERVER ${r.status()} ${r.url()}`); });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  log(`sign-in title: ${await page.title()}`);
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { ctx, page };
}
const shoot = async (page: Page, n: string): Promise<void> => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: join(OUT, `${n}.png`) });
  log(`shot ${n}`);
};
const csrf = async (ctx: BrowserContext): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const noSideways = async (page: Page, label: string): Promise<void> => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  log(`${label} scrollWidth ${w.sw} client ${w.cw} => ${w.sw <= w.cw ? 'OK' : 'SIDEWAYS'}`);
};
const favicon = (page: Page): Promise<string> => page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href.slice(0, 120) ?? 'none');
const txt = async (page: Page, sel: string, n = 900): Promise<string> =>
  (await page.locator(sel).first().innerText({ timeout: 3000 }).catch(() => 'MISSING')).replace(/\s+/g, ' ').slice(0, n);

let omar: { ctx: BrowserContext; page: Page };
let nadia: { ctx: BrowserContext; page: Page };
let me: any;

test('login both', async ({ browser }) => {
  omar = await login(browser, 'OMAR', 1440, 900);
  nadia = await login(browser, 'NADIA', 1440, 900);
  me = await (await omar.page.request.get('/api/session')).json();
  log(`session keys ${Object.keys(me).join(',')}`);
});


test('sidebar desktop: header, hint, folds, row menu', async () => {
  const { page } = omar;
  await page.goto(`/t/${TEAM}/threads`);
  await page.waitForTimeout(2500);
  log(`threads title ${await page.title()}`);
  log(`team-switch: ${await txt(page, '[data-landmark="team-switch"]')}`);
  log(`search hint: ${await txt(page, '[data-landmark="search"]')}`);
  await page.getByTestId('team-switch').or(page.locator('[data-landmark="team-switch"] button').first()).first().click().catch(() => log('team-switch click failed'));
  await page.waitForTimeout(500);
  log(`team menu: ${await txt(page, '[role="menu"]', 1200)}`);
  await shoot(page, '02-team-menu-1440');
  await page.keyboard.press('Escape');
  // folds
  const fold = async (name: string): Promise<boolean | null> => {
    const b = page.locator('[data-landmark="sidebar"]').getByRole('button', { name: new RegExp(`^${name}`, 'i') }).first();
    if (!(await b.count())) return null;
    return (await b.getAttribute('aria-expanded')) === 'true';
  };
  log(`folds before: channels=${await fold('Channels')} dms=${await fold('Direct messages')} bots=${await fold('Bots')}`);
  const dm = page.locator('[data-landmark="sidebar"]').getByRole('button', { name: /^Direct messages/i }).first();
  const wasOpen = await fold('Direct messages');
  await dm.click(); await page.waitForTimeout(400);
  log(`dm fold toggled: ${wasOpen} -> ${await fold('Direct messages')}`);
  await shoot(page, '03-folded-1440');
  await page.reload(); await page.waitForTimeout(2000);
  log(`dm fold after reload: ${await fold('Direct messages')} (persist ${(await fold('Direct messages')) === !wasOpen ? 'PASS' : 'FAIL'})`);
  await dm.click(); await page.waitForTimeout(300); // restore
  log(`dm fold restored: ${await fold('Direct messages')}`);
  // row menu
  const row = page.locator('[data-landmark="sidebar"] a[href$="/c/dev"]').first();
  await row.hover();
  const trig = page.locator('[data-landmark="sidebar"] [data-testid="channel-row-menu"]').nth(1);
  log(`channel row menus ${await page.getByTestId('channel-row-menu').count()} aria ${JSON.stringify(await page.getByTestId('channel-row-menu').evaluateAll((e) => e.slice(0, 3).map((x) => x.getAttribute('aria-label'))))}`);
  await shoot(page, '03b-row-hover-1440');
  await page.getByRole('button', { name: 'Options for dev' }).or(page.getByRole('button', { name: 'Options for #dev' })).first().click({ timeout: 4000 }).catch((e) => log(`row menu click failed ${String(e).slice(0, 80)}`));
  await page.waitForTimeout(400);
  log(`row menu: ${await txt(page, '[role="menu"]')}`);
  await shoot(page, '04-row-menu-1440');
  await page.keyboard.press('Escape');
  const dmTrig = page.locator('[data-sb-row]', { hasText: 'Nadia' }).locator('button[aria-haspopup="menu"]').first();
  await page.locator('[data-sb-row]', { hasText: 'Nadia' }).first().hover(); await dmTrig.click({ timeout: 3000 }).catch(() => log('dm row menu missing')); await page.waitForTimeout(300);
  log(`dm row menu: ${await txt(page, '[role="menu"]')}`);
  await page.keyboard.press('Escape');
  log(`add channel visible: ${await page.getByText('Add channel').first().isVisible()}; new message: ${await page.getByText('New message').first().isVisible()}`);
  // Alt+1 team switch
  await page.keyboard.press('Alt+1'); await page.waitForTimeout(800);
  log(`after Alt+1 url ${page.url()} title ${await page.title()}`);
  await page.keyboard.press('Alt+2'); await page.waitForTimeout(1200);
  log(`after Alt+2 url ${page.url()} title ${await page.title()}`);
  await page.goto(`/t/${TEAM}/threads`);
});

test('DM rows open + active state; titles; unread DM', async () => {
  const { page } = omar;
  await page.goto(`/t/${TEAM}/threads`); await page.waitForTimeout(1500);
  const dmRow = page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Nadia/ }).first();
  await dmRow.click(); await page.waitForTimeout(1500);
  log(`dm url ${page.url()} title ${await page.title()}`);
  log(`dm row aria-current=${await dmRow.getAttribute('aria-current')} class=${await dmRow.getAttribute('class')}`);
  await shoot(page, '05-dm-active-1440');
  // Nadia sends Omar a DM; Omar sits on a channel
  const dmId = page.url().split('/dm/')[1]?.split(/[?#]/)[0] ?? '';
  const chans = await (await omar.page.request.get('/api/channels')).json().catch(() => null);
  log(`dmId ${dmId} channels api keys ${chans ? Object.keys(chans).join(',') : 'n/a'}`);
  await page.goto(`/t/${TEAM}/c/dev`); await page.waitForTimeout(1500);
  await nadia.page.goto(`/t/${TEAM}/dm/${dmId}`); await nadia.page.waitForTimeout(1500);
  const box = nadia.page.getByRole('textbox').last();
  await box.click(); await nadia.page.keyboard.type(`verify wpf ping ${Date.now().toString(36)}`); await nadia.page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  log(`title with unread DM: ${await page.title()}`);
  log(`favicon with unread: ${await favicon(page)}`);
  log(`sidebar DM row: ${await txt(page, '[data-landmark="sidebar"] >> text=Nadia')}`);
  await shoot(page, '06-unread-dm-1440');
  const fav = await page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? '');
  if (fav.startsWith('data:image/png;base64,')) (await import('node:fs')).writeFileSync(join(OUT, 'favicon-unread.png'), Buffer.from(fav.split(',')[1] ?? '', 'base64'));
  // a person with nothing unread: the plain icon
  const plain = await nadia.page.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? '');
  if (plain.startsWith('data:image/png;base64,')) (await import('node:fs')).writeFileSync(join(OUT, 'favicon-nadia.png'), Buffer.from(plain.split(',')[1] ?? '', 'base64'));
  log(`nadia title ${await nadia.page.title()} favicon same as omar: ${plain === fav}`);
  await page.screenshot({ path: join(OUT, '06b-unread-fav.png'), clip: { x: 0, y: 580, width: 250, height: 100 } });
});

test('quick switcher', async () => {
  const { page } = omar;
  await page.keyboard.press('Control+k'); await page.waitForTimeout(900);
  log(`switcher list: ${await txt(page, '[data-testid="quick-switcher-list"]', 1500)}`);
  log(`options ${await page.getByTestId('quick-switcher-option').count()}`);
  const names = await page.getByTestId('quick-switcher-option').allInnerTexts();
  log(`option names ${JSON.stringify(names.map((n) => n.replace(/\s+/g, ' ').slice(0, 40)))}`);
  await shoot(page, '07-switcher-1440');
  const chips = page.getByRole('dialog').getByRole('button');
  log(`dialog buttons ${JSON.stringify(await chips.allInnerTexts())}`);
  const act = (): Promise<string> => page.evaluate(() => { const a = document.activeElement as HTMLElement; return `${a.tagName}:${(a.textContent ?? a.getAttribute('placeholder') ?? '').slice(0, 25)}:${a.getAttribute('aria-pressed') ?? a.getAttribute('aria-selected') ?? ''}`; });
  const seq: string[] = [await act()];
  const chip = (): Promise<string> => page.getByRole('dialog').locator('[aria-pressed="true"], [aria-selected="true"][role="tab"], .on').first().innerText({ timeout: 1500 }).catch(() => '?');
  seq.length = 0;
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); seq.push(`${await chip()}|${await act()}`); }
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); seq.push(`${await chip()}|${await act()}`); }
  log(`tab cycle ${JSON.stringify(seq)}`);
  await shoot(page, '08-switcher-tab-1440');
  await page.keyboard.type('nadia'); await page.waitForTimeout(700);
  log(`nadia options: ${JSON.stringify((await page.getByTestId('quick-switcher-option').allInnerTexts()).map((n) => n.replace(/\s+/g, ' ')))}`);
  await shoot(page, '09-switcher-nadia-1440');
  await page.keyboard.press('Escape');
});

test('search see-all, bell', async () => {
  const { page } = omar;
  await page.goto(`/t/${TEAM}/c/dev`); await page.waitForTimeout(1200);
  const sbox = page.locator('[data-landmark="search"]').getByRole('searchbox').or(page.locator('[data-landmark="search"] input')).first();
  await sbox.click(); await sbox.fill('release'); await sbox.press('Enter'); await page.waitForTimeout(2500);
  log(`search panel: ${await txt(page, '[data-testid="search-results"]', 600)}`);
  await shoot(page, '10-search-popover-1440');
  const see = page.getByText(/See all results/i).first();
  log(`see all present ${await see.count()}`);
  await see.click({ timeout: 4000 }).catch(() => log('see all click failed'));
  await page.waitForTimeout(1500);
  log(`search url ${page.url()} title ${await page.title()}`);
  await shoot(page, '11-search-page-1440');
  await page.goto(`/t/${TEAM}/search?q=release`); await page.waitForTimeout(2000);
  log(`direct search title ${await page.title()} text ${await txt(page, '[data-landmark="content"]', 500)}`);
  // bell
  await page.getByTestId('bell').click(); await page.waitForTimeout(900);
  log(`bell popover: ${await txt(page, '[data-testid="notifications-popover"]', 900)}`);
  await shoot(page, '12-bell-unread-1440');
  const all = page.getByTestId('notifications-popover').getByRole('tab', { name: /All/ }).or(page.getByTestId('notifications-popover').getByRole('button', { name: /^All/ })).first();
  await all.click().catch(() => log('All tab click failed')); await page.waitForTimeout(700);
  log(`bell All: ${await txt(page, '[data-testid="notifications-popover"]', 1200)}`);
  await shoot(page, '13-bell-all-1440');
  await page.keyboard.press('Escape');
});

test('titles', async () => {
  const { page } = omar;
  for (const [n, u] of [['channel', `/t/${TEAM}/c/dev`], ['threads', `/t/${TEAM}/threads`], ['settings', '/settings'], ['account', '/account'], ['teams', '/teams'], ['search', `/t/${TEAM}/search?q=a`], ['approvals', `/t/${TEAM}/approvals`], ['files', `/t/${TEAM}/files`]] as const) {
    await page.goto(u); await page.waitForTimeout(1500);
    log(`TITLE ${n} (${page.url().replace(BASE, '')}): ${await page.title()}`);
  }
  const anon = await page.context().browser()!.newContext({ baseURL: BASE });
  const ap = await anon.newPage(); await ap.goto('/sign-in'); log(`TITLE signed-out sign-in: ${await ap.title()}`); await anon.close();
});

test('earlier gaps: teams, proposals, roster', async () => {
  const { page } = omar;
  await page.goto('/teams'); await page.waitForTimeout(1500);
  log(`teams text: ${await txt(page, 'main, [data-landmark="content"]', 500)}`);
  await shoot(page, '14-teams-1440');
  await page.goto(`/t/${TEAM}/proposals`); await page.waitForTimeout(2000);
  const prop = await txt(page, 'main, [data-landmark="content"]', 1500);
  log(`proposals text: ${prop}`);
  log(`proposals yaml/.md names: ${JSON.stringify(prop.match(/\S+\.(ya?ml|md)\b/g))}`);
  await shoot(page, '15-proposals-1440');
  for (const u of [`/t/${TEAM}/roster`, `/t/${TEAM}/bots`, `/t/${TEAM}/team`]) {
    await page.goto(u); await page.waitForTimeout(1500);
    log(`${u} -> ${page.url().replace(BASE, '')} : ${await txt(page, 'main, [data-landmark="content"]', 500)}`);
  }
  await page.goto(`/settings/team/${TEAM}/template`); await page.waitForTimeout(2000);
  log(`template page: ${await txt(page, 'main, [data-landmark="content"]', 500)}`);
  log(`template cnt: ${await page.locator('.cnt').first().innerText({ timeout: 2000 }).catch(() => 'none')} font=${await page.locator('.cnt').first().evaluate((e) => getComputedStyle(e).fontFamily.slice(0, 40)).catch(() => '?')}`);
  await shoot(page, '16-roster-1440');
});

test('mobile 390', async ({ browser }) => {
  const m = await login(browser, 'OMAR', 390, 844);
  const { page } = m;
  for (const [n, u] of [['teams', '/teams'], ['threads', `/t/${TEAM}/threads`], ['channel', `/t/${TEAM}/c/dev`], ['search', `/t/${TEAM}/search?q=release`], ['proposals', `/t/${TEAM}/proposals`], ['settings', '/settings']] as const) {
    await page.goto(u); await page.waitForTimeout(2000);
    await noSideways(page, `390 ${n}`);
    await shoot(page, `20-${n}-390`);
  }
  await page.goto(`/t/${TEAM}/threads`); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Open menu' }).first().click({ timeout: 5000 }).catch(() => log('390 menu button not found'));
  await page.waitForTimeout(700);
  await shoot(page, '21-sidebar-390');
  await page.keyboard.press('Escape');
  const bell = page.getByTestId('bell'); if (await bell.count()) { await bell.click().catch(() => undefined); await page.waitForTimeout(700); await shoot(page, '22-bell-390'); await page.keyboard.press('Escape'); }
  await m.ctx.close();
});

test.afterAll(async () => { await omar?.ctx.close(); await nadia?.ctx.close(); });
