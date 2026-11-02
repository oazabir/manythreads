/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/claude-0/-root-manythreads/079ca634-3c90-4571-b318-4602cc3894ca/scratchpad/p0707-shots';
const T = { timeout: 20_000 };
const TEAM = process.env.TEAM ?? 'marketing';
const BOT = process.env.BOT ?? 'content-drafter';
const STEP = process.env.STEP ?? 'probe';
const WHO = process.env.WHO ?? 'TARIQ';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });

async function login(browser: Browser, who: string, width = 1280, height = 900): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('response', (r) => { if (r.status() >= 500) { errors.push(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`); log(`SERVER ${r.status()} ${r.url()}`); } });
  page.on('pageerror', (e) => { errors.push(`PAGEERROR ${e.message}`); log(`PAGEERROR ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(`CONSOLE ${m.text().slice(0, 300)}`); log(`CONSOLE.error ${m.text().slice(0, 300)}`); } });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { ctx, page, errors };
}
const shoot = async (page: Page, n: string, full = true): Promise<void> => { await page.waitForLoadState('networkidle').catch(() => undefined); await page.screenshot({ path: join(OUT, `${n}.png`), fullPage: full }); log(`shot ${n}`); };
const j = async (page: Page, path: string, init?: { method?: string; data?: unknown }): Promise<any> => {
  const ck = await page.context().cookies();
  const csrf = (ck.find((c) => c.name === '__Host-manythreads_csrf') ?? ck.find((c) => c.name === 'manythreads_csrf'))?.value;
  const r = await page.request.fetch(path, { method: init?.method ?? 'GET', headers: csrf ? { 'x-csrf-token': csrf } : {}, ...(init?.data !== undefined ? { data: init.data } : {}) });
  const t = await r.text();
  let body: any = t; try { body = JSON.parse(t); } catch { /* text */ }
  return { status: r.status(), body };
};
const red = (o: unknown, n = 3000): string => String(JSON.stringify(o)).replace(/"(key|apiKey|token)":"[^"]*"/g, '"$1":"<redacted>"').slice(0, n);
const wsUrl = (mode: string, sid?: string | null): string => `/t/${TEAM}/bots/${BOT}/chat?view=workshop&mode=${mode}${sid ? `&ws=${sid}` : ''}`;
const sw = (page: Page): Promise<{ sw: number; cw: number }> => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));

let me: { ctx: BrowserContext; page: Page; errors: string[] };
test('login', async ({ browser }) => { me = await login(browser, WHO); log(`logged in as ${WHO}`); });

test('probe', async () => {
  test.skip(STEP !== 'probe'); test.setTimeout(120_000);
  const { page } = me;
  const bot = await j(page, `/api/teams/${TEAM}/bots/${BOT}`);
  log(`bot ${bot.status} ${red(bot.body && { slug: bot.body.bot?.slug, status: bot.body.bot?.status, invalid: bot.body.bot?.invalid, canManage: bot.body.canManage, runtime: bot.body.bot?.runtime }, 600)}`);
  const tree = await j(page, `/api/teams/${TEAM}/repo/tree?path=bots/${BOT}`);
  log(`tree ${tree.status} ${red((tree.body.entries ?? []).map((e: any) => e.path), 800)}`);
  const tree2 = await j(page, `/api/teams/${TEAM}/repo/tree?path=bots/${BOT}/evals`);
  log(`tree evals ${tree2.status} ${red((tree2.body.entries ?? []).map((e: any) => e.path), 400)}`);
  for (const f of ['BRIEF.md', 'lessons.md', 'evals/launch-posts.yaml']) {
    const b = await j(page, `/api/teams/${TEAM}/repo/blob?path=bots/${BOT}/${f}`);
    log(`blob ${f} ${b.status}: ${red(String(b.body.content ?? b.body).slice(0, 700), 900)}`);
  }
  const ev = await j(page, `/api/teams/${TEAM}/bots/${BOT}/evals`);
  log(`evals ${ev.status} set=${ev.body.set} min=${ev.body.minScore} canRun=${ev.body.canRun} latest=${red(ev.body.latest && { score: ev.body.latest.score, ok: ev.body.latest.ok, mode: ev.body.latest.mode, cases: (ev.body.latest.cases ?? []).map((c: any) => `${c.id}:${c.verdict ?? c.passed}`) }, 700)} recent=${red((ev.body.recent ?? []).map((r: any) => `${r.mode}:${r.score}:${r.ok}`), 300)}`);
  log(`evals raw ${red(ev.body, 1800)}`);
  const bm = await j(page, `/api/teams/${TEAM}/repo/blob?path=bots/${BOT}/BOT.md`);
  log(`BOT.md ${red(String(bm.body.content).slice(0, 1500), 1700)}`);
  const rp = await j(page, `/api/teams/${TEAM}/bots/${BOT}/replay?days=7`);
  log(`replay ${rp.status} ${red(rp.body, 2500)}`);
  const ra = await j(page, `/api/teams/${TEAM}/bots/${BOT}/reassessments`);
  log(`reassessments ${ra.status} ${red(ra.body, 1500)}`);
  const runs = await j(page, `/api/teams/${TEAM}/bots/${BOT}/runs`);
  log(`runs ${runs.status} ${red(runs.body, 600)}`);
});

test('ui', async ({ browser }) => {
  test.skip(STEP !== 'ui'); test.setTimeout(180_000);
  const { page } = me;
  for (const mode of ['build', 'rehearse', 'live']) {
    await page.goto(wsUrl(mode)); await expect(page.getByTestId('workshop-tab')).toBeVisible(T); await page.waitForTimeout(2000);
    log(`ui ${mode}: reassess-line=${await page.getByTestId('ws-reassess-line').count()} reassess-full=${await page.getByTestId('ws-reassess').count()} replay=${await page.getByTestId('ws-replay').count()}`);
    await shoot(page, `ui-01-${mode}`);
  }
  // live: run replay
  await page.goto(wsUrl('live')); await expect(page.getByTestId('ws-replay')).toBeVisible(T);
  log(`replay section text: ${(await page.getByTestId('ws-replay').innerText()).replace(/\s+/g, ' ').slice(0, 700)}`);
  await page.getByTestId('ws-replay-run').click();
  await expect(page.getByTestId('ws-replay-result')).toBeVisible(T);
  await page.waitForTimeout(800);
  log(`result: ${(await page.getByTestId('ws-replay-result').innerText()).replace(/\s+/g, ' ').slice(0, 1500)}`);
  log(`changes=${await page.getByTestId('ws-replay-change').count()} verdicts=${JSON.stringify(await page.getByTestId('ws-replay-change').evaluateAll((els) => els.map((e) => e.getAttribute('data-verdict'))))}`);
  await shoot(page, 'ui-02-replay-desktop');
  // keyboard: focus the run button via keyboard and press Enter
  await page.getByTestId('ws-replay-days').focus(); await page.keyboard.press('Tab');
  log(`kbd: focus after Tab from days = ${await page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('data-testid'))}`);
  await page.keyboard.press('Enter'); await page.waitForTimeout(1500);
  log(`kbd: result still visible=${await page.getByTestId('ws-replay-result').isVisible()} announce="${await page.getByTestId('ws-replay-announce').innerText()}" focus=${await page.evaluate(() => (document.activeElement as HTMLElement).tagName + ':' + (document.activeElement as HTMLElement).textContent?.slice(0, 20))}`);
  log(`desktop scroll ${JSON.stringify(await sw(page))}`);
  // mobile
  const m = await login(browser, WHO, 390, 800);
  await m.page.goto(wsUrl('live')); await expect(m.page.getByTestId('ws-replay')).toBeVisible(T);
  await m.page.getByTestId('ws-replay-run').click(); await expect(m.page.getByTestId('ws-replay-result')).toBeVisible(T); await m.page.waitForTimeout(800);
  log(`mobile scroll ${JSON.stringify(await sw(m.page))}`);
  await shoot(m.page, 'ui-03-replay-mobile');
  for (const mode of ['build', 'rehearse']) { await m.page.goto(wsUrl(mode)); await m.page.waitForTimeout(2000); log(`mobile ${mode} scroll ${JSON.stringify(await sw(m.page))}`); }
  log(`errors desktop=${JSON.stringify(me.errors)} mobile=${JSON.stringify(m.errors)}`);
  await m.ctx.close();
});

test('estimate', async () => {
  test.skip(STEP !== 'estimate'); test.setTimeout(120_000);
  const { page } = me;
  const rp = await j(page, `/api/teams/${TEAM}/bots/${BOT}/replay?days=7`);
  const runs: any[] = rp.body.replay.fullReplayable ?? [];
  log(`fullReplayable=${runs.length} ${red(runs, 600)}`);
  if (!runs.length) return;
  const run = runs[0];
  const url = `/api/teams/${TEAM}/bots/${BOT}/replay/runs/${run.runId}/full`;
  const e1 = await j(page, url, { method: 'POST', data: {} });
  log(`estimate ${e1.status} ${red(e1.body, 1500)}`);
  const est = e1.body.estimate ?? e1.body;
  const wrong = await j(page, url, { method: 'POST', data: { confirm: { tokens: est.tokens ?? 0, token: 'wrong-token' } } });
  log(`wrong token ${wrong.status} ${red(wrong.body, 400)}`);
  const bare = await j(page, url, { method: 'POST', data: { confirm: { tokens: est.tokens ?? 0 } } });
  log(`bare number ${bare.status} ${red(bare.body, 400)}`);
  const text = await j(page, url, { method: 'POST', data: { text: 'hello' } });
  log(`text field ${text.status} ${red(text.body, 300)}`);
});

test('full', async () => {
  test.skip(STEP !== 'full'); test.setTimeout(480_000);
  const { page } = me;
  const rp = await j(page, `/api/teams/${TEAM}/bots/${BOT}/replay?days=7`);
  const runs: any[] = rp.body.replay.fullReplayable ?? [];
  expect(runs.length).toBeGreaterThan(0);
  const rowsBefore = async (): Promise<string> => { await page.goto(`/t/${TEAM}/bots/${BOT}/chat`); await page.waitForTimeout(3000); const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' '); return `rows=${await page.getByTestId('conversation-row').count()} brainReplies=${(txt.match(/Brain \d\d:\d\d/g) ?? []).length}`; };
  log(`chat before: ${await rowsBefore()}`);
  await page.goto(wsUrl('live')); await expect(page.getByTestId('ws-replay')).toBeVisible(T);
  await page.getByTestId('ws-replay-run').click(); await expect(page.getByTestId('ws-replay-result')).toBeVisible(T);
  await page.getByTestId('ws-full-ask').first().click();
  await expect(page.getByTestId('ws-estimate')).toBeVisible(T);
  log(`estimate ui: ${(await page.getByTestId('ws-estimate').innerText()).replace(/\s+/g, ' ')}`);
  log(`focus on estimate heading: ${await page.evaluate(() => document.activeElement?.id)}`);
  await shoot(page, 'full-01-estimate');
  const before = await j(page, `/api/teams/${TEAM}/proposals`);
  log(`proposals before ${before.status} ${red((before.body.proposals ?? before.body.items ?? []).length, 50)}`);
  await page.getByTestId('ws-full-confirm').click();
  await page.waitForURL(/mode=rehearse/, { timeout: 60_000 }).catch(() => log('no navigation to rehearse'));
  log(`url after confirm ${page.url().replace(BASE, '')}`);
  const sid = new URL(page.url()).searchParams.get('ws');
  const t0 = Date.now(); let s: any = null;
  while (sid && Date.now() - t0 < 400_000) {
    s = (await j(page, `/api/teams/${TEAM}/bots/${BOT}/workshop/sessions/${sid}`)).body?.session;
    if (s && s.status !== 'working') break;
    await page.waitForTimeout(4000);
  }
  log(`session ${s?.status} mode=${s?.mode} entries=${red((s?.entries ?? []).map((e: any) => `${e.kind}${e.rehearsal ? '(rehearsal)' : ''}:${String(e.text ?? e.tool ?? '').slice(0, 120)}`), 1500)}`);
  await page.waitForTimeout(3000);
  await shoot(page, 'full-02-rehearse-result');
  const after = await j(page, `/api/teams/${TEAM}/proposals`);
  log(`proposals after ${after.status} ${red((after.body.proposals ?? after.body.items ?? []).length, 50)}`);
  log(`chat after: ${await rowsBefore()}`);
});

test('run', async () => {
  test.skip(STEP !== 'run'); test.setTimeout(420_000);
  const { page } = me;
  await page.goto(`/t/${TEAM}/bots/${BOT}/chat`); await page.waitForTimeout(2500);
  if (await page.getByTestId('ws-view-chat').count()) await page.getByTestId('ws-view-chat').click();
  await page.waitForTimeout(1500);
  await shoot(page, 'run-00-start', false);
  const box = page.getByLabel(/^Message /);
  await box.fill('Verification check for the replay feature: in two short sentences, say what you can help the Marketing team with. No drafts needed.');
  await box.press('Enter');
  const t0 = Date.now(); let seen = '';
  while (Date.now() - t0 < 360_000) {
    await page.waitForTimeout(6000);
    const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    if (!/is thinking|is working|typing|Waiting for/i.test(txt) && txt.length > 0 && Date.now() - t0 > 20_000) { seen = txt; const r = await j(page, `/api/teams/${TEAM}/bots/${BOT}/replay?days=1`); log(`poll ${Math.round((Date.now()-t0)/1000)}s decisions=${r.body.replay?.counts?.total} runs=${r.body.replay?.runs}`); if (r.body.replay?.counts?.total > 0) break; }
  }
  await shoot(page, 'run-01-after');
  log(`page text: ${seen.slice(0, 900)}`);
});

test('after', async () => {
  test.skip(STEP !== 'after'); test.setTimeout(120_000);
  const { page } = me;
  const rp = await j(page, `/api/teams/${TEAM}/bots/${BOT}/replay?days=7`);
  log(`replay ${rp.status} ${red(rp.body, 3500)}`);
  const b = await j(page, `/api/teams/${TEAM}/bots/${BOT}`);
  log(`bot ${red(b.body, 1800)}`);
});

test('audit', async () => {
  test.skip(STEP !== 'audit'); test.setTimeout(60_000);
  const { page } = me;
  const a = await j(page, `/api/admin/audit?limit=40`);
  const items: any[] = a.body.items ?? a.body.entries ?? a.body.events ?? [];
  log(`audit ${a.status} n=${items.length} keys=${Object.keys(a.body)}`);
  for (const e of items.slice(0, 25)) log(`  ${red({ at: e.at ?? e.createdAt, type: e.type ?? e.action, d: e.detail ?? e.payload ?? e.summary }, 300)}`);
});

test('evalreassess', async () => {
  test.skip(STEP !== 'evalreassess'); test.setTimeout(120_000);
  const { page } = me;
  const r = await j(page, `/api/teams/${TEAM}/bots/${BOT}/evals/run`, { method: 'POST', data: { mode: 'static' } });
  log(`eval run ${r.status} ${red(r.body, 500)}`);
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(3000); const ev = await j(page, `/api/teams/${TEAM}/bots/${BOT}/evals`); if (ev.body.latest) { log(`evals set=${red(ev.body.set, 200)} latest=${red(ev.body.latest, 1800)}`); break; } }
  const ra = await j(page, `/api/teams/${TEAM}/bots/${BOT}/reassessments`);
  log(`reassessments ${ra.status} ${red(ra.body, 800)}`);
  const cl = await j(page, `/api/teams/${TEAM}/bots/${BOT}/reassessments/00000000-0000-7000-8000-000000000999/close`, { method: 'POST', data: { answer: 'done' } });
  log(`close unknown id ${cl.status} ${red(cl.body, 300)}`);
  const clb = await j(page, `/api/teams/${TEAM}/bots/${BOT}/reassessments/00000000-0000-7000-8000-000000000999/close`, { method: 'POST', data: { answer: 'maybe' } });
  log(`close bad answer ${clb.status} ${red(clb.body, 300)}`);
  for (const mode of ['build', 'rehearse', 'live']) {
    await page.goto(wsUrl(mode)); await expect(page.getByTestId('workshop-tab')).toBeVisible(T); await page.waitForTimeout(2000);
    const txt = (await page.getByTestId('workshop-tab').innerText()).replace(/\s+/g, ' ');
    log(`${mode} text: ${txt.slice(0, 900)}`);
    await shoot(page, `ev-${mode}`);
  }
  await page.goto(`/t/${TEAM}/bots/${BOT}`); await page.waitForTimeout(2500); await shoot(page, 'ev-botpage');
});

test('focus', async () => {
  test.skip(STEP !== 'focus'); test.setTimeout(120_000);
  const { page } = me;
  await page.goto(wsUrl('live')); await expect(page.getByTestId('ws-replay')).toBeVisible(T);
  await page.getByTestId('ws-replay-run').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-replay-result')).toBeVisible(T);
  await page.getByTestId('ws-full-ask').first().focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('ws-estimate')).toBeVisible(T); await page.waitForTimeout(1000);
  log(`focus after estimate: ${await page.evaluate(() => `${document.activeElement?.tagName}#${document.activeElement?.id}`)}`);
  await page.keyboard.press('Tab');
  log(`next tab: ${await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))}`);
  await page.keyboard.press('Tab');
  log(`next tab: ${await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))}`);
  await page.keyboard.press('Enter'); await page.waitForTimeout(800);
  log(`after cancel (Enter): estimate visible=${await page.getByTestId('ws-estimate').count()} focus=${await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))}`);
  log(`errors ${JSON.stringify(me.errors)}`);
});

test('sessions', async () => {
  test.skip(STEP !== 'sessions'); test.setTimeout(120_000);
  const { page } = me;
  const l = await j(page, `/api/teams/${TEAM}/bots/${BOT}/workshop/sessions`);
  log(`sessions ${l.status} ${red(l.body, 800)}`);
  const first = (l.body.sessions ?? [])[0];
  if (first) { const s = (await j(page, `/api/teams/${TEAM}/bots/${BOT}/workshop/sessions/${first.id}`)).body.session; log(`first ${s.status} ${s.mode} ${red((s.entries ?? []).map((e: any) => `${e.kind}${e.rehearsal ? '(rehearsal)' : ''}:${String(e.text ?? e.tool ?? '').slice(0, 200)}`), 1200)} message=${s.message ?? ''}`); }
});
