/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of feature 6 (P6-13 bot icon on cards, P6-14 custom board columns) and the search-screen padding.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-f6 --retries=0 --timeout=60000
 * Signs in through the form (env vars, never printed). Everything it creates is removed or closed at the end.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/f6';
const TEAM = process.env['TEAM'] ?? 'engineering';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });

async function login(browser: Browser, who: string, w: number, h: number): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) log(`SERVER ${r.status()} ${r.url()}`); });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
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

let omar: { ctx: BrowserContext; page: Page };
const api = async (method: string, path: string, data?: unknown): Promise<any> => {
  const r = await omar.page.request.fetch(path, { method, headers: await csrf(omar.ctx), ...(data === undefined ? {} : { data }) });
  const body = await r.json().catch(() => null);
  return { status: r.status(), body };
};

test('login + probe', async ({ browser }) => {
  omar = await login(browser, 'OMAR', 1440, 900);
  const b = await api('GET', `/api/teams/${TEAM}/boards`);
  log(`boards ${b.status} ${JSON.stringify((b.body?.items ?? []).map((x: any) => ({ id: x.id, name: x.name, cols: x.columns?.map((c: any) => c.name) })))}`);
  const bots = await api('GET', `/api/teams/${TEAM}/bots`);
  log(`bots ${bots.status} ${JSON.stringify((bots.body?.items ?? bots.body?.bots ?? []).map((x: any) => `${x.slug}:${x.status}`))}`);
  const t = await api('GET', `/api/teams/${TEAM}/tasks?limit=100`);
  log(`tasks ${t.status} total ${t.body?.total}`);
});

const BOARD = '00000000-0000-7000-8000-0000000c0020';
const cols = (page: Page): Promise<string[]> => page.getByTestId('board-column').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
let cardId = '';
let botCardId = '';

test('search screen padding 1440 and 390', async ({ browser }) => {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    const { ctx, page } = await login(browser, 'OMAR', w, h);
    await page.goto(`/t/${TEAM}/search?q=release`);
    await page.waitForTimeout(2500);
    const m = await page.evaluate(() => {
      const left = (el: Element | null): number | null => (el ? Math.round(el.getBoundingClientRect().left) : null);
      const main = document.querySelector('main') ?? document.body;
      const h = main.querySelector('h1');
      const input = main.querySelector('input');
      const row = main.querySelector('[data-testid*="result"], li, [role="listitem"], article');
      return { h1: left(h), input: left(input), row: left(row), main: left(main) };
    });
    log(`search ${w}: left edges ${JSON.stringify(m)}`);
    await shoot(page, `01-search-${w}`);
    await ctx.close();
  }
});

for (const [w, h] of [[1440, 900], [390, 844]] as const) {
  test(`board baseline ${w}`, async ({ browser }) => {
    const { ctx, page } = await login(browser, 'OMAR', w, h);
    await page.goto(`/t/${TEAM}/boards?board=${BOARD}`);
    await page.waitForTimeout(2500);
    log(`baseline ${w} columns ${JSON.stringify(await cols(page))}; controls: add=${await page.getByTestId('add-column').count()} menus=${await page.getByTestId('column-menu').count()}`);
    await shoot(page, `02-board-${w}`);
    await ctx.close();
  });
}

test('preclean leftovers from an earlier run', async () => {
  const b = (await api('GET', `/api/teams/${TEAM}/boards/${BOARD}`)).body.board;
  const t = await api('GET', `/api/teams/${TEAM}/tasks?limit=100`);
  for (const k of (t.body.items as any[]).filter((x) => x.title.startsWith('F6 verify card') && x.state !== 'done')) {
    log(`leftover card ${k.id} ${k.state}: move ${(await api('POST', `/api/teams/${TEAM}/boards/${BOARD}/move`, { taskId: k.id, to: 'in_progress' })).status}`);
    log(`complete ${(await api('POST', `/api/teams/${TEAM}/tasks/${k.id}/complete`, { summary: 'closed' })).status}`);
  }
  for (const c of b.columns.filter((x: any) => /^QA/.test(x.name))) log(`delete leftover column ${c.name} ${(await api('DELETE', `/api/teams/${TEAM}/boards/${BOARD}/columns/${c.id}`)).status}`);
});

test('desktop column flow', async () => {
  const { page } = omar;
  const c = await api('POST', `/api/teams/${TEAM}/tasks`, { title: 'F6 verify card (temporary)', description: '', kind: 'other', priority: 'normal', branch: 'task/f6-verify', boardId: BOARD });
  log(`create card ${c.status}`);
  cardId = c.body.task.id;
  log(`claim ${(await api('POST', `/api/teams/${TEAM}/tasks/${cardId}/claim`)).status}`);
  await page.goto(`/t/${TEAM}/boards?board=${BOARD}`);
  await page.waitForTimeout(2500);
  await page.getByTestId('add-column').click();
  await page.getByTestId('add-column-name').fill('QA (verify)');
  await page.getByTestId('add-column-state').selectOption('verify');
  await shoot(page, '03-add-column-form-1440');
  await page.getByTestId('add-column-save').click();
  await expect(page.getByTestId('board-column')).toHaveCount(6, { timeout: 10_000 });
  log(`after add: ${JSON.stringify(await cols(page))}`);
  await shoot(page, '04-added-1440');
  const qa = (): ReturnType<Page['locator']> => page.locator('[data-testid="board-column"][aria-label="QA (verify)"]');
  // rename
  await qa().getByTestId('column-menu').click();
  log(`menu items: ${(await page.locator('[role="menu"], [role="group"]').first().innerText().catch(() => 'n/a')).replace(/\s+/g, ' | ')}`);
  await shoot(page, '05-menu-1440');
  await qa().getByTestId('column-rename').click();
  await page.getByTestId('column-rename-input').fill('QA renamed');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="board-column"][aria-label="QA renamed"]')).toBeVisible({ timeout: 8000 });
  log('rename OK');
  const qr = page.locator('[data-testid="board-column"][aria-label="QA renamed"]');
  // Alt+Left
  await page.getByRole('button', { name: 'Move column QA renamed' }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(1200);
  log(`Alt+Left live="${await page.getByTestId('board-live').innerText().catch(() => 'n/a')}" order ${JSON.stringify(await cols(page))}`);
  // menu Move left / right
  await qr.getByTestId('column-menu').click();
  await page.getByRole('button', { name: /Move left/ }).or(page.getByText('Move left')).first().click().catch((e) => log(`Move left click: ${String(e).slice(0, 100)}`));
  await page.waitForTimeout(1000);
  log(`after menu Move left: ${JSON.stringify(await cols(page))}`);
  if ((await qr.getByTestId('column-menu').getAttribute('aria-expanded')) !== 'true') await qr.getByTestId('column-menu').click();
  await page.getByRole('button', { name: /Move right/ }).or(page.getByText('Move right')).first().click().catch((e) => log(`Move right click: ${String(e).slice(0, 100)}`));
  await page.waitForTimeout(1000);
  log(`after menu Move right: ${JSON.stringify(await cols(page))}`);
  await page.reload(); await page.waitForTimeout(2000);
  log(`after reload: ${JSON.stringify(await cols(page))}`);
  // drag
  await page.locator(`[data-testid="board-card"][data-task="${cardId}"]`).dragTo(qr);
  await page.waitForTimeout(1500);
  await shoot(page, '06-dragged-1440');
  await page.reload(); await page.waitForTimeout(2500);
  const inQa = await page.locator('[data-testid="board-column"][aria-label="QA renamed"]').locator(`[data-testid="board-card"][data-task="${cardId}"]`).count();
  const inVerify = await page.locator('[data-testid="board-column"][aria-label="Verify"]').locator(`[data-testid="board-card"][data-task="${cardId}"]`).count();
  log(`persist after reload: card in QA=${inQa} card in Verify=${inVerify} => ${inQa === 1 && inVerify === 0 ? 'PASS' : 'FAIL'}`);
  await shoot(page, '07-persisted-1440');
  // delete refused
  const qr2 = page.locator('[data-testid="board-column"][aria-label="QA renamed"]');
  await qr2.getByTestId('column-menu').click();
  await qr2.getByTestId('column-delete').click();
  await qr2.getByTestId('column-delete-confirm').click().catch(() => undefined);
  await page.waitForTimeout(1000);
  log(`refusal: "${await page.getByTestId('board-refusal').innerText().catch(() => 'MISSING')}" columns ${(await cols(page)).length}`);
  await shoot(page, '08-refusal-1440');
});

test('non-manager member sees no controls', async ({ browser }) => {
  for (const who of ['NADIA', 'LENA']) {
    const m = await login(browser, who, 1440, 900);
    await m.page.goto(`/t/${TEAM}/boards?board=${BOARD}`);
    await m.page.waitForTimeout(2500);
    log(`${who}: columns ${(await cols(m.page)).length} grips=${await m.page.getByTestId('column-grip').count()} menus=${await m.page.getByTestId('column-menu').count()} add=${await m.page.getByTestId('add-column').count()}`);
    if (who === 'NADIA') await shoot(m.page, '09-member-1440');
    await m.ctx.close();
  }
});

test('phone 390: column menu not clipped', async ({ browser }) => {
  const { ctx, page } = await login(browser, 'OMAR', 390, 844);
  await page.goto(`/t/${TEAM}/boards?board=${BOARD}`);
  await page.waitForTimeout(2500);
  await shoot(page, '10-board-390');
  const qr = page.locator('[data-testid="board-column"][aria-label="QA renamed"]');
  await qr.scrollIntoViewIfNeeded();
  await qr.getByTestId('column-menu').click();
  await page.waitForTimeout(500);
  const menu = qr.getByRole('group').first();
  const items = await qr.locator('[data-testid^="column-"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return `${e.getAttribute('data-testid')}:${Math.round(r.left)}-${Math.round(r.right)},${Math.round(r.top)}-${Math.round(r.bottom)}`; }));
  log(`390 menu items (vw 390, vh 844): ${items.join(' ')}; group visible ${await menu.isVisible().catch(() => false)}`);
  await shoot(page, '11-menu-390');
  await page.keyboard.press('Escape');
  // Move left by menu at 390
  await qr.getByTestId('column-menu').click();
  await page.getByText('Move left').first().click().catch(() => log('390 Move left missing'));
  await page.waitForTimeout(800);
  log(`390 after Move left ${JSON.stringify(await cols(page))}`);
  await ctx.close();
});

test('cleanup columns and card', async () => {
  const b = (await api('GET', `/api/teams/${TEAM}/boards/${BOARD}`)).body.board;
  const col = b.columns.find((c: any) => /^QA/.test(c.name));
  // move the card out (to Verify's own column by state), then delete the column
  const mv = await api('POST', `/api/teams/${TEAM}/boards/${BOARD}/move`, { taskId: cardId, to: 'in_progress' });
  log(`move out ${mv.status}`);
  const { page } = omar;
  await page.goto(`/t/${TEAM}/boards?board=${BOARD}`);
  await page.waitForTimeout(2500);
  const qr = page.locator('[data-testid="board-column"][aria-label="QA renamed"]');
  await qr.getByTestId('column-menu').click();
  await qr.getByTestId('column-delete').click();
  await qr.getByTestId('column-delete-confirm').click().catch(() => undefined);
  await page.waitForTimeout(1500);
  log(`after delete columns ${JSON.stringify(await cols(page))} (col existed ${!!col})`);
  await shoot(page, '12-after-delete-1440');
  const done = await api('POST', `/api/teams/${TEAM}/tasks/${cardId}/complete`, { summary: 'verification card, closed' });
  log(`complete card ${done.status}`);
});

test('bot icon: real run on a card', async ({ browser }) => {
  const c = await api('POST', `/api/teams/${TEAM}/tasks`, { title: 'F6 bot icon check (temporary)', description: 'Reply with the single word ok. Do nothing else.', kind: 'other', priority: 'low', branch: 'task/f6-bot-icon', boardId: BOARD });
  botCardId = c.body.task.id;
  log(`bot card ${c.status}`);
  const h = await api('POST', `/api/teams/${TEAM}/tasks/${botCardId}/handoff`, { toBotSlug: 'plan-reviewer', mode: 'bot', note: 'Reply with the single word ok.', strict: false });
  log(`handoff ${h.status} pending=${h.body?.pendingApproval} ${h.status >= 400 ? JSON.stringify(h.body).slice(0, 200) : ''}`);
  const { ctx, page } = await login(browser, 'OMAR', 1440, 900);
  await page.goto(`/t/${TEAM}/boards?board=${BOARD}&card=${botCardId}`);
  let seen = false;
  const t0 = Date.now();
  for (let i = 0; i < 40; i += 1) {
    const act = await api('GET', `/api/teams/${TEAM}/tasks/activity`);
    const n = await page.locator(`[data-testid="board-card"][data-task="${botCardId}"] [data-testid="bot-activity"]`).count();
    const p = await page.getByTestId('card-panel').getByTestId('bot-activity').count();
    log(`t+${Math.round((Date.now() - t0) / 1000)}s activity=${JSON.stringify(act.body).slice(0, 160)} card-icon=${n} panel-icon=${p}`);
    if (n > 0 && !seen) {
      seen = true;
      log(`icon label: ${await page.locator('[data-testid="bot-activity"]').first().getAttribute('aria-label')}`);
      await shoot(page, '13-bot-icon-1440');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(800);
      await shoot(page, '14-bot-icon-390');
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    if (seen && n === 0) { log('icon gone after run'); await shoot(page, '15-bot-icon-gone-1440'); break; }
    await page.waitForTimeout(3000);
  }
  log(`seen=${seen}`);
  const ev = await api('GET', `/api/teams/${TEAM}/tasks/${botCardId}`);
  log(`card state ${ev.body?.task?.state} owner ${JSON.stringify(ev.body?.task?.ownerId ?? ev.body?.task?.owner)?.slice(0, 80)}`);
  await ctx.close();
});

test('cleanup bot card', async () => {
  const t = (await api('GET', `/api/teams/${TEAM}/tasks/${botCardId}`)).body.task;
  log(`bot card state ${t.state}`);
  if (t.state === 'done') return;
  if (t.state === 'open') log(`claim ${(await api('POST', `/api/teams/${TEAM}/tasks/${botCardId}/claim`)).status}`);
  const r = await api('POST', `/api/teams/${TEAM}/tasks/${botCardId}/complete`, { summary: 'verification card, closed' });
  log(`complete ${r.status} ${r.status >= 400 ? JSON.stringify(r.body).slice(0, 200) : ''}`);
});

test('bot icon: push without reload', async ({ browser }) => {
  if (!botCardId) botCardId = ((await api('GET', `/api/teams/${TEAM}/tasks?limit=100`)).body.items as any[]).find((x) => x.title.startsWith('F6 bot icon check'))?.id ?? '';
  const { ctx, page } = await login(browser, 'OMAR', 1440, 900);
  page.on('websocket', (ws) => {
    log(`ws open ${ws.url().slice(0, 80)}`);
    ws.on('framereceived', (f) => { const p = String(f.payload); if (/activity/.test(p)) log(`WS frame ${p.slice(0, 160)}`); });
  });
  await page.goto(`/t/${TEAM}/boards?board=${BOARD}&card=${botCardId}`);
  await page.waitForTimeout(3000);
  const icon = page.locator(`[data-testid="board-card"][data-task="${botCardId}"] [data-testid="bot-activity"]`);
  log(`icon before (should be 0 after reload): ${await icon.count()}`);
  for (const act of ['release', 'claim']) { const r = await api('POST', `/api/teams/${TEAM}/tasks/${botCardId}/${act}`); log(`${act} ${r.status} ${r.status >= 400 ? JSON.stringify(r.body).slice(0, 150) : ''}`); }
  const h = await api('POST', `/api/teams/${TEAM}/tasks/${botCardId}/handoff`, { toBotSlug: 'plan-reviewer', mode: 'bot', note: 'Reply ok.', strict: false });
  log(`handoff2 ${h.status} ${h.status >= 400 ? JSON.stringify(h.body).slice(0, 150) : ''} ; handoff2 ${h.status}`);
  const t0 = Date.now();
  let appeared = -1; let gone = -1;
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(3000);
    const n = await icon.count();
    const act = (await api('GET', `/api/teams/${TEAM}/tasks/activity`)).body.items.length;
    if (n > 0 && appeared < 0) appeared = Math.round((Date.now() - t0) / 1000);
    if (appeared >= 0 && n === 0) { gone = Math.round((Date.now() - t0) / 1000); break; }
    if (appeared >= 0 && act === 0 && gone < 0 && i % 5 === 0) log(`server idle but icon still shown at t+${Math.round((Date.now() - t0) / 1000)}s`);
    if (i % 3 === 0) log(`t+${Math.round((Date.now() - t0) / 1000)}s server-active=${act} icon=${n}`);
  }
  log(`no-reload: appeared at ${appeared}s, gone at ${gone}s`);
  await ctx.close();
});

test('cleanup bot card 2', async () => {
  const id = ((await api('GET', `/api/teams/${TEAM}/tasks?limit=100`)).body.items as any[]).filter((x) => /^F6 /.test(x.title) && x.state !== 'done');
  for (const k of id) {
    for (const [a, body] of [['release', undefined], ['claim', undefined], ['complete', { summary: 'verification card, closed' }]] as const) {
      const r = await api('POST', `/api/teams/${TEAM}/tasks/${k.id}/${a}`, body);
      log(`${k.title} ${a} ${r.status}`);
    }
  }
  const left = ((await api('GET', `/api/teams/${TEAM}/tasks?limit=100`)).body.items as any[]).filter((x) => /^F6 /.test(x.title)).map((x) => `${x.title}:${x.state}`);
  log(`F6 cards now ${JSON.stringify(left)}`);
  const b = (await api('GET', `/api/teams/${TEAM}/boards/${BOARD}`)).body.board;
  log(`board columns ${JSON.stringify(b.columns.map((c: any) => c.name))}; activity ${JSON.stringify((await api('GET', `/api/teams/${TEAM}/tasks/activity`)).body)}`);
});
