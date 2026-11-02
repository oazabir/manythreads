/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/claude-0/-root-manythreads/079ca634-3c90-4571-b318-4602cc3894ca/scratchpad/v1904';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });

async function login(browser: Browser, who: string, width = 1280): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { ctx, page };
}
const shoot = async (page: Page, n: string): Promise<void> => { await page.waitForLoadState('networkidle').catch(() => undefined); await page.screenshot({ path: join(OUT, `${n}.png`) }); log(`shot ${n}`); };
const text = async (page: Page, sel = 'main'): Promise<string> => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ');

let omar: { ctx: BrowserContext; page: Page };
test('login', async ({ browser }) => { omar = await login(browser, 'OMAR'); });

test('1 page + 390', async ({ browser }) => {
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await expect(page.getByRole('heading', { name: 'Runners', level: 1 })).toBeVisible(T);
  await page.waitForTimeout(2500);
  log(`1 page text: ${(await text(page)).slice(0, 1200)}`);
  log(`rows=${await page.getByTestId('runner-row').count()}`);
  await shoot(page, '1-desktop');
  const nav = await page.locator('nav').allInnerTexts();
  log(`nav has Runners: ${nav.join(' ').includes('Runners')}`);
  const u = await login(browser, 'OMAR', 390);
  await u.page.goto('/settings/workspace/runners');
  await expect(u.page.getByRole('heading', { name: 'Runners', level: 1 })).toBeVisible(T);
  await u.page.waitForTimeout(2500);
  await shoot(u.page, '1-mobile390');
  const sw = await u.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bsw: document.body.scrollWidth }));
  log(`390 scroll ${JSON.stringify(sw)} horizontalScroll=${sw.sw > sw.cw}`);
  await u.ctx.close();
});

test('2 test existing', async () => {
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(2500);
  const row = page.getByTestId('runner-row').first();
  if (!(await row.count())) { log('2 no runner rows to test'); return; }
  await row.getByTestId('runner-test').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible(T);
  await shoot(page, '2-test-dialog');
  await dlg.getByTestId('runner-test-run').click();
  await expect(dlg.getByTestId('runner-test-result')).not.toBeEmpty({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  log(`2 result ok=${await dlg.getByTestId('runner-test-result').getAttribute('data-ok')} text=${await text(page, '[data-testid=runner-test-result]')}`);
  await shoot(page, '2-test-result');
  await dlg.getByRole('button', { name: 'Close' }).click();
  log(`2 row after: ${await text(page, '[data-testid=runner-row]')}`);
});

test('3 add/test/delete probe', async () => {
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(1500);
  for (const addr of ['http://127.0.0.1:9', 'http://192.0.2.1:8642']) {
    await page.getByTestId('runner-add').first().click();
    const dlg = page.getByRole('dialog');
    if (addr.includes('127')) {
      await shoot(page, '3-chooser');
      await dlg.getByTestId('runner-kind-claude_cli').click({ force: true });
      log(`3 after click Claude Code: still chooser=${await page.getByTestId('runner-add-chooser').count()} aria-disabled=${await dlg.getByTestId('runner-kind-claude_cli').getAttribute('aria-disabled')} codex aria-disabled=${await dlg.getByTestId('runner-kind-codex_cli').getAttribute('aria-disabled')}`);
    }
    await dlg.getByTestId('runner-kind-hermes_gateway').click();
    await dlg.getByLabel('Display name').fill('probe-p1904');
    log(`3 short name value=${await dlg.getByLabel('Short name').inputValue()}`);
    await dlg.getByLabel('Address').fill(addr);
    await dlg.getByLabel('Key', { exact: true }).fill('dummy-key-xyz-123456');
    if (addr.includes('127')) await shoot(page, '3-add-form');
    await dlg.getByTestId('runner-add-submit').click();
    await page.waitForTimeout(3500);
    const err = await page.getByTestId('runner-form-error').allInnerTexts();
    const open = await page.getByTestId('runner-add-form').isVisible().catch(() => false);
    log(`3 addr=${addr} error=${JSON.stringify(err)} formStillOpen=${open} keyFieldValue=${open ? await dlg.getByLabel('Key', { exact: true }).inputValue() === '' ? '(emptied)' : '(kept)' : 'n/a'}`);
    await shoot(page, addr.includes('127') ? '3-after-submit-loopback' : '3-after-submit-testnet');
    if (!open) break;
    await dlg.getByRole('button', { name: 'Back' }).click().catch(() => undefined);
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  }
  log(`3 status: ${await text(page, '[data-testid=runner-status]')}`);
  log(`3 list: ${await text(page, '[data-testid=runner-list]').catch(() => '(none)')}`);
});

test('3b probe test/edit/delete', async () => {
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(2500);
  const row = page.locator('[data-testid=runner-row][data-runner^="probe-p1904"]');
  if (!(await row.count())) { log('3b probe row absent'); return; }
  await row.getByTestId('runner-test').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('runner-test-run').click();
  await expect(dlg.getByTestId('runner-test-result')).not.toBeEmpty({ timeout: 90_000 });
  await page.waitForTimeout(1000);
  log(`3b probe test ok=${await dlg.getByTestId('runner-test-result').getAttribute('data-ok')} text=${await text(page, '[data-testid=runner-test-result]')}`);
  await shoot(page, '3b-probe-test');
  await dlg.getByRole('button', { name: 'Close' }).click();
  await row.getByTestId('runner-edit-open').click();
  const e = page.getByRole('dialog');
  await shoot(page, '3b-edit');
  const vals = await e.locator('input').evaluateAll((els) => els.map((x) => `${(x as HTMLInputElement).type}:${(x as HTMLInputElement).value}`));
  const html = await page.content();
  log(`3b edit input values=${JSON.stringify(vals.map((v) => v.replace(/dummy-key-xyz-123456/, '<<KEY LEAK>>')))} keyInDom=${html.includes('dummy-key-xyz-123456')}`);
  await e.getByTestId('runner-edit-close').click();
  await row.getByTestId('runner-delete').click();
  await shoot(page, '3b-delete-dialog');
  await page.getByTestId('runner-delete-confirm').click();
  await page.waitForTimeout(2500);
  log(`3b after delete: status=${await text(page, '[data-testid=runner-status]')} probeRows=${await row.count()}`);
  await shoot(page, '3b-after-delete');
});

test('4 teams control', async () => {
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(2500);
  const row = page.getByTestId('runner-row').first();
  if (!(await row.count())) { log('4 no runner rows'); return; }
  const before = await text(page, '[data-testid=runner-row]');
  await row.getByTestId('runner-teams-open').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByTestId('runner-teams-control')).toBeVisible(T);
  log(`4 dialog: ${await text(page, '[role=dialog]')}`);
  log(`4 radios checked=${JSON.stringify(await dlg.locator('input[type=radio]').evaluateAll((e) => e.map((x) => (x as HTMLInputElement).checked)))} checkboxes=${await dlg.locator('input[type=checkbox]').count()}`);
  await shoot(page, '4-teams');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(800);
  const after = await text(page, '[data-testid=runner-row]');
  log(`4 unchanged=${before === after}`);
  log(`4 before=${before.slice(0, 300)}`);
});

test('5 non-admin', async ({ browser }) => {
  const u = await login(browser, 'NADIA');
  await u.page.goto('/settings/workspace/runners');
  await u.page.waitForTimeout(3000);
  log(`5 url=${u.page.url()} text=${(await text(u.page, 'body')).slice(0, 500)}`);
  log(`5 controls: add=${await u.page.getByTestId('runner-add').count()} rows=${await u.page.getByTestId('runner-row').count()}`);
  await shoot(u.page, '5-nadia');
  const r = await u.page.request.get('/api/admin/bot-runners');
  log(`5 GET /api/admin/bot-runners ${r.status()} ${(await r.text()).slice(0, 200)}`);
  await u.ctx.close();
});

test('6 placement', async () => {
  const { page } = omar;
  await page.goto('/t/engineering/bots/brain');
  await page.waitForTimeout(2500);
  await page.getByRole('navigation', { name: 'Bot sections' }).getByText('Placement', { exact: false }).first().click();
  const sel = page.getByTestId('runs-on-select');
  await expect(sel).toBeVisible(T);
  const opts = await sel.locator('option').allInnerTexts();
  log(`6 options=${JSON.stringify(opts)} value=${await sel.inputValue()} label-for=${await page.locator('label[for]').filter({ hasText: 'Runs on' }).count()}`);
  log(`6 block text: ${await text(page, '[data-testid=runs-on]')}`);
  await shoot(page, '6-placement');
  await sel.focus();
  log(`6 focused=${await sel.evaluate((e) => document.activeElement === e)}`);
  await page.keyboard.press('Tab');
  log(`6 after Tab active=${await page.evaluate(() => document.activeElement?.tagName + ':' + (document.activeElement as any)?.id)}`);
  await page.keyboard.press('Shift+Tab');
  log(`6 shift-tab back on select=${await sel.evaluate((e) => document.activeElement === e)}`);
  await shoot(page, '6-placement-focus');
  const saves = await page.getByRole('button', { name: /Save|Discard/ }).allInnerTexts();
  log(`6 buttons ${JSON.stringify(saves)} (no change made)`);
});

test('7 bot answers', async () => {
  const { page } = omar;
  await page.goto('/t/engineering/bots/brain/chat');
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  const word = `pong${sfx}`;
  await box.fill(`say ${word} and nothing else`);
  const t0 = Date.now();
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  let secs = -1;
  for (let i = 0; i < 125; i++) {
    await page.waitForTimeout(1000);
    const txt = await page.locator('main').innerText();
    if (txt.split(word).length - 1 >= 2) { secs = Math.round((Date.now() - t0) / 1000); break; }
  }
  log(`7 secs=${secs}`);
  log(`7 tail: ${(await text(page)).slice(-600)}`);
  await shoot(page, '7-chat');
});
test.afterAll(async () => { await omar?.ctx.close(); });

test('6a survey bots', async () => {
  const { page } = omar;
  for (const team of ['engineering', 'marketing', 'customer-support']) {
    await page.goto(`/t/${team}/bots`);
    await page.waitForTimeout(2500);
    const hrefs = await page.locator(`a[href^="/t/${team}/bots/"]`).evaluateAll((e) => [...new Set(e.map((x) => (x as HTMLAnchorElement).getAttribute('href')))]);
    log(`6a ${team} links ${JSON.stringify(hrefs)}`);
    for (const h of hrefs) {
      const slug = h!.split('/')[4];
      if (!slug || slug === 'new') continue;
      await page.goto(`/t/${team}/bots/${slug}?tab=placement`);
      await page.waitForTimeout(1800);
      await page.getByTestId('tab-placement').click().catch(() => undefined);
      await page.waitForTimeout(800);
      const ro = await page.getByTestId('runs-on-select').count();
      const old = await page.getByTestId('old-placement').count();
      const rd = await page.getByTestId('runs-on-readonly').count();
      log(`6a ${team}/${slug}: select=${ro} old=${old} readonly=${rd}`);
    }
  }
});

test('6b select via probe runner (draft only, never saved)', async () => {
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(1500);
  await page.getByTestId('runner-add').first().click();
  let dlg = page.getByRole('dialog');
  await dlg.getByTestId('runner-kind-hermes_gateway').click();
  await dlg.getByLabel('Display name').fill('probe-p1904');
  await dlg.getByLabel('Address').fill('http://192.0.2.1:8642');
  await dlg.getByLabel('Key', { exact: true }).fill('dummy-key-xyz-123456');
  await dlg.getByTestId('runner-add-submit').click();
  await page.waitForTimeout(2500);
  const row = page.locator('[data-testid=runner-row][data-runner^="probe-p1904"]');
  await row.getByTestId('runner-teams-open').click();
  dlg = page.getByRole('dialog');
  await dlg.getByTestId('runner-teams-several').check();
  await dlg.locator('label.check', { hasText: 'Engineering' }).locator('input').check();
  await dlg.getByTestId('runner-teams-save').click();
  await page.waitForTimeout(2500);
  log(`6b probe row: ${await text(page, '[data-testid=runner-row]')}`);
  await shoot(page, '6b-probe-shared');
  try {
    await page.goto('/t/engineering/bots/brain');
    await page.getByTestId('tab-placement').click();
    await page.waitForTimeout(1500);
    const mv = page.getByTestId('move-to-runner');
    log(`6b move button enabled=${await mv.isEnabled()}`);
    await shoot(page, '6b-old-placement');
    await mv.click();
    const sel = page.getByTestId('runs-on-select');
    await expect(sel).toBeVisible(T);
    log(`6b options=${JSON.stringify(await sel.locator('option').allInnerTexts())} value=${await sel.inputValue()}`);
    log(`6b block: ${await text(page, '[data-testid=runs-on]')}`);
    await sel.focus();
    log(`6b focused=${await sel.evaluate((e) => document.activeElement === e)}`);
    await page.keyboard.press('Tab');
    log(`6b after Tab: ${await page.evaluate(() => `${document.activeElement?.tagName}:${(document.activeElement as HTMLElement)?.getAttribute('aria-label') ?? (document.activeElement as HTMLElement)?.innerText?.slice(0, 30)}`)}`);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowUp');
    log(`6b after ArrowUp value=${await sel.inputValue()}`);
    await shoot(page, '6b-runs-on-select');
    const disc = page.getByRole('button', { name: 'Discard changes' });
    log(`6b discard enabled=${await disc.isEnabled()}`);
    await disc.click();
    await page.waitForTimeout(1000);
    log(`6b after discard: old-placement=${await page.getByTestId('old-placement').count()} select=${await page.getByTestId('runs-on-select').count()}`);
    await shoot(page, '6b-after-discard');
  } finally {
    await page.goto('/settings/workspace/runners');
    await page.waitForTimeout(2500);
    const r2 = page.locator('[data-testid=runner-row][data-runner^="probe-p1904"]');
    if (await r2.count()) {
      await r2.getByTestId('runner-delete').click();
      await page.getByTestId('runner-delete-confirm').click();
      await page.waitForTimeout(2500);
      log(`6b cleanup: ${await text(page, '[data-testid=runner-status]')} left=${await r2.count()}`);
    }
  }
});

test('7b bot answers (robust)', async () => {
  const { page } = omar;
  await page.goto('/t/engineering/bots/brain/chat');
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  const word = `ping${sfx}x`;
  await box.fill(`reply with the single word ${word}`);
  const t0 = Date.now();
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  let secs = -1;
  let last = '';
  for (let i = 0; i < 125; i++) {
    await page.waitForTimeout(1000);
    const msgs = await page.getByTestId('message').allInnerTexts();
    last = msgs.map((m) => m.replace(/\s+/g, ' ')).join(' || ');
    const working = (await page.locator('main').innerText()).includes('is working on it');
    if (msgs.length >= 2 && !working) { secs = Math.round((Date.now() - t0) / 1000); break; }
  }
  log(`7b secs=${secs}`);
  log(`7b messages: ${last.slice(-900)}`);
  await shoot(page, '7b-chat');
});
