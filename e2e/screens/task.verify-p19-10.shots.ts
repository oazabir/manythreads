/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/claude-0/-root-manythreads/079ca634-3c90-4571-b318-4602cc3894ca/scratchpad/v1910';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
const STEP = process.env.STEP ?? 'explore';

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
const j = async (page: Page, path: string, init?: { method?: string; data?: unknown }): Promise<any> => {
  const ck = await page.context().cookies();
  const csrf = (ck.find((c) => c.name === '__Host-manythreads_csrf') ?? ck.find((c) => c.name === 'manythreads_csrf'))?.value;
  const r = await page.request.fetch(path, { method: init?.method ?? 'GET', headers: csrf ? { 'x-csrf-token': csrf } : {}, ...(init?.data !== undefined ? { data: init.data } : {}) });
  const t = await r.text();
  let body: any = t; try { body = JSON.parse(t); } catch { /* text */ }
  return { status: r.status(), body };
};

let omar: { ctx: BrowserContext; page: Page };
test('login', async ({ browser }) => { omar = await login(browser, 'OMAR'); });

test('explore', async () => {
  test.skip(STEP !== 'explore');
  const { page } = omar;
  const a = await j(page, '/api/workspace/llm/aliases'); log(`aliases ${a.status} ${JSON.stringify(a.body).slice(0, 1500)}`);
  const t = await j(page, '/api/workspace/llm/alias-tests'); log(`alias-tests ${t.status} ${JSON.stringify(t.body).slice(0, 1500)}`);
  const r = await j(page, '/api/admin/bot-runners'); log(`runners ${r.status} ${JSON.stringify(r.body).replace(/"(key|apiKey)":"[^"]*"/g, '"$1":"<redacted>"').slice(0, 2500)}`);
  const bots = await j(page, '/api/teams/engineering/bots'); log(`bots ${bots.status} ${JSON.stringify(bots.body).slice(0, 2500)}`);
  const b = await j(page, '/api/teams/engineering/repo/blob?path=bots/brain/BOT.md'); log(`brain blob ${b.status} ${JSON.stringify(b.body).slice(0, 3000)}`);
  const tm = await j(page, '/api/teams'); log(`teams ${tm.status} ${JSON.stringify(tm.body).slice(0, 800)}`);
  const sp = await j(page, '/api/workspace/llm/spend'); log(`spend ${sp.status} ${JSON.stringify(sp.body).slice(0, 1500)}`);
});


test('s2b test runner', async () => {
  test.skip(STEP !== 's2b');
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(2500);
  const row = page.locator('[data-testid=runner-row][data-runner="probe-model"]');
  log(`2 row: ${await row.innerText().then((x) => x.replace(/\\s+/g, ' '))}`);
  await row.getByTestId('runner-test').click();
  await page.waitForTimeout(15_000);
  log(`2 test sentence: ${await text(page, '[data-testid=runner-status]')}`);
  log(`2 row after: ${await row.innerText().then((x) => x.replace(/\\s+/g, ' '))}`);
  await shoot(page, '2-test-result');
  const rr = await j(page, '/api/admin/bot-runners');
  const me = rr.body.items.find((x: any) => x.name === 'probe-model');
  log(`2 runner api: ${JSON.stringify({ name: me?.name, kind: me?.kind, modelAlias: me?.modelAlias, allTeams: me?.allTeams, teams: me?.teams?.map((t: any) => t.slug), status: me?.status, statusDetail: me?.statusDetail, hasKey: me?.hasKey, baseUrl: me?.baseUrl })}`);
});

const bm = (extra: string, runtimeCap: string, body: string): string => `---
schema: 1
name: ${extra}
role: Throwaway probe for the model runner.
kind: agent
runtime: hermes
visibility: team
triggers:
  - type: conversation
capabilities:
${runtimeCap}
memory:
  file: memory.md
  maxLines: 200
placement:
  runs_on: probe-model
---

${body}
`;

async function waitBot(page: Page, slug: string, secs = 90): Promise<any> {
  for (let i = 0; i < secs / 3; i++) {
    const b = await j(page, '/api/teams/engineering/bots');
    const f = b.body?.bots?.find((x: any) => x.slug === slug);
    if (f) return f;
    await page.waitForTimeout(3000);
  }
  return null;
}

test('s3 create probe-model', async () => {
  test.skip(STEP !== 's3');
  const { page } = omar;
  const content = bm('Probe model', '  native:\n    - memory.recall', 'You are a terse probe. Answer in one short sentence.');
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: 'bots/probe-model/BOT.md', op: 'put', content, baseBlobSha: null, title: 'P19-10 probe: throwaway bot probe-model', applyNow: true } });
  log(`3 commit ${c.status} ${JSON.stringify(c.body).slice(0, 600)}`);
  const f = await waitBot(page, 'probe-model', 60);
  log(`3 bot ${JSON.stringify(f && { slug: f.slug, status: f.status, invalid: f.invalid, placement: f.placement, conversational: f.conversational, runtime: f.runtime })}`);
  await page.goto('/t/engineering/bots');
  await page.waitForTimeout(3000);
  log(`3 bots page: ${(await text(page)).slice(0, 900)}`);
  await shoot(page, '3-bots-list');
});

async function chat(page: Page, slug: string, prompt: string, word: string, shotName: string, maxSecs = 90): Promise<void> {
  await page.goto(`/t/engineering/bots/${slug}/chat`);
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  await page.waitForTimeout(1500);
  const before = (await page.locator('main').innerText()).length;
  await box.fill(prompt);
  const t0 = Date.now();
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  let secs = -1;
  await page.waitForTimeout(2500);
  for (let i = 0; i < maxSecs; i++) {
    const txt = await page.locator('main').innerText();
    if (!txt.includes('is working on it')) { secs = Math.round((Date.now() - t0) / 1000); break; }
    await page.waitForTimeout(1000);
  }
  log(`${shotName} first-detect secs=${secs} (word=${word})`);
  await page.waitForTimeout(6000);
  const full = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  log(`${shotName} main-len before=${before} tail: ${full.slice(-900)}`);
  await shoot(page, shotName);
}

test('s4 chat probe-model', async () => {
  test.skip(STEP !== 's4');
  await chat(omar.page, 'probe-model', 'reply with the single word pongmodel', 'pongmodel', '4-chat-probe');
});

test('s5 chat probe-model memory', async () => {
  test.skip(STEP !== 's5');
  await chat(omar.page, 'probe-model', 'Use your memory recall tool to look for anything about "release process" and tell me in one sentence what you found or that nothing was found.', '', '5-chat-memory', 60);
});

test('s7 brain', async () => {
  test.skip(STEP !== 's7');
  await chat(omar.page, 'brain', 'reply with the single word pingmodelchk', 'pingmodelchk', '7-chat-brain', 120);
});

test('s4b poll', async () => {
  test.skip(STEP !== 's4b');
  const { page } = omar;
  await page.goto('/t/engineering/bots/probe-model/chat');
  await page.waitForTimeout(3000);
  for (let i = 0; i < 60; i++) { if (!(await page.locator('main').innerText()).includes('is working on it')) break; await page.waitForTimeout(1000); }
  log(`4b tail: ${(await text(page)).slice(-900)}`);
  await shoot(page, '4b-chat-probe-later');
});

test('s3b update probe-model with messages.post', async () => {
  test.skip(STEP !== 's3b');
  const { page } = omar;
  const content = bm('Probe model', '  native:\n    - messages.post\n    - memory.recall', 'You are a terse probe. Answer in one short sentence.');
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: 'bots/probe-model/BOT.md', op: 'put', content, title: 'P19-10 probe: add messages.post', applyNow: true } });
  log(`3b proposal ${c.status} status=${c.body?.proposal?.proposal?.status} ${JSON.stringify(c.body).slice(0, 300)}`);
  await page.waitForTimeout(8000);
  const f = (await j(page, '/api/teams/engineering/bots')).body.bots.find((x: any) => x.slug === 'probe-model');
  log(`3b bot ${JSON.stringify({ status: f.status, invalid: f.invalid, sha: f.definitionSha })}`);
});

test('s6 placement + shell', async () => {
  test.skip(STEP !== 's6');
  const { page } = omar;
  await page.goto('/t/engineering/bots/probe-model');
  await page.waitForTimeout(2500);
  await page.getByRole('navigation', { name: 'Bot sections' }).getByText('Placement', { exact: false }).first().click();
  await page.waitForTimeout(1500);
  log(`6 placement block: ${await text(page, '[data-testid=runs-on]').catch(() => '(no runs-on testid)')}`);
  log(`6 main: ${(await text(page)).slice(0, 900)}`);
  const sel = page.getByTestId('runs-on-select');
  if (await sel.count()) log(`6 select value=${await sel.inputValue()} options=${JSON.stringify(await sel.locator('option').allInnerTexts())}`);
  await shoot(page, '6-placement');
  const content = bm('Probe shell', '  runtime:\n    - shell\n  native:\n    - messages.post', 'You are a terse probe. Answer in one short sentence.');
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: 'bots/probe-shell/BOT.md', op: 'put', content, baseBlobSha: null, title: 'P19-10 probe: throwaway bot probe-shell', applyNow: true } });
  log(`6 proposal ${c.status} status=${c.body?.proposal?.proposal?.status} ${JSON.stringify(c.body).replace(/\\n/g, ' ').slice(0, 1500)}`);
  await page.waitForTimeout(6000);
  const list = (await j(page, '/api/teams/engineering/bots')).body.bots;
  const f = list.find((x: any) => x.slug === 'probe-shell');
  log(`6 probe-shell ${JSON.stringify(f && { status: f.status, invalid: f.invalid, placement: f.placement })}`);
  await page.goto('/t/engineering/bots');
  await page.waitForTimeout(3000);
  log(`6 bots page tail: ${(await text(page)).slice(-1200)}`);
  await shoot(page, '6-bots-list-with-shell');
  await page.goto('/t/engineering/bots/probe-shell');
  await page.waitForTimeout(3000);
  log(`6 shell page: ${(await text(page)).slice(0, 1200)}`);
  await shoot(page, '6-probe-shell-page');
});

test('spend', async () => {
  test.skip(STEP !== 'spend');
  const { page } = omar;
  const sp = await j(page, '/api/workspace/llm/spend'); log(`spend ${sp.status} ${JSON.stringify(sp.body)}`);
  await page.goto('/settings/workspace/llm');
  await page.waitForTimeout(3000);
  const loc = page.locator('[data-testid=llm-spend-by-bot]');
  log(`spend by bot table: ${(await loc.count()) ? await text(page, '[data-testid=llm-spend-by-bot]') : '(none)'}`);
  log(`spend by team table: ${(await page.locator('[data-testid=llm-spend-by-team]').count()) ? await text(page, '[data-testid=llm-spend-by-team]') : '(none)'}`);
  await loc.scrollIntoViewIfNeeded().catch(() => undefined);
  await shoot(page, '9-spend');
});

test('s6b existing bot goes invalid', async () => {
  test.skip(STEP !== 's6b');
  const { page } = omar;
  const au = await j(page, '/api/admin/audit?limit=40');
  log(`6b audit status=${au.status} ${JSON.stringify((au.body?.items ?? au.body?.entries ?? au.body)).replace(/\\n/g, ' ').slice(0, 200)}`);
  const hits = JSON.stringify(au.body).match(/probe-shell[^}]{0,400}/g);
  log(`6b audit probe-shell hits: ${JSON.stringify(hits)?.slice(0, 1500)}`);
  const content = bm('Probe model', '  runtime:\n    - shell\n  native:\n    - messages.post\n    - memory.recall', 'You are a terse probe. Answer in one short sentence.');
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: 'bots/probe-model/BOT.md', op: 'put', content, title: 'P19-10 probe: probe-model asks for shell', applyNow: true } });
  log(`6b proposal ${c.status} status=${c.body?.proposal?.proposal?.status} checks=${JSON.stringify(c.body?.proposal?.proposal?.checks)}`);
  await page.waitForTimeout(8000);
  const f = (await j(page, '/api/teams/engineering/bots')).body.bots.find((x: any) => x.slug === 'probe-model');
  log(`6b probe-model ${JSON.stringify({ status: f.status, invalid: f.invalid })}`);
  await page.goto('/t/engineering/bots/probe-model');
  await page.waitForTimeout(3000);
  log(`6b page: ${(await text(page)).slice(0, 900)}`);
  await shoot(page, '6b-probe-model-invalid');
  await page.goto('/t/engineering/bots');
  await page.waitForTimeout(3000);
  await shoot(page, '6b-bots-list-invalid');
  log(`6b list probe row: ${(await text(page)).match(/Probe model.{0,300}/)?.[0]}`);
});

test('s8 cleanup', async () => {
  test.skip(STEP !== 's8');
  const { page } = omar;
  const pm = (await j(page, '/api/teams/engineering/bots')).body.bots.find((b: any) => b.slug === 'probe-model');
  log(`8 probe-model bot id=${pm?.id}`);
  for (const slug of ['probe-model', 'probe-shell']) {
    const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${slug}/BOT.md`, op: 'delete', title: `P19-10 probe: remove throwaway bot ${slug}`, applyNow: true } });
    log(`8 delete ${slug} ${c.status} status=${c.body?.proposal?.proposal?.status} ${c.status >= 400 ? JSON.stringify(c.body) : ''}`);
  }
  await page.waitForTimeout(8000);
  const list = (await j(page, '/api/teams/engineering/bots')).body.bots;
  log(`8 bots now ${JSON.stringify(list.map((b: any) => `${b.slug}:${b.status}`))}`);
  const tree = await j(page, '/api/teams/engineering/repo/tree?path=bots');
  log(`8 repo bots tree ${tree.status} ${JSON.stringify(tree.body).slice(0, 700)}`);
  await page.goto('/settings/workspace/runners');
  await page.waitForTimeout(2500);
  const row = page.locator('[data-testid=runner-row][data-runner="probe-model"]');
  log(`8 runner row: ${await row.innerText().then((x) => x.replace(/\\s+/g, ' '))}`);
  await row.getByTestId('runner-delete').click();
  await shoot(page, '8-delete-dialog');
  log(`8 delete dialog: ${await text(page, '[role=dialog]')}`);
  await page.getByTestId('runner-delete-confirm').click();
  await page.waitForTimeout(3000);
  log(`8 after delete status=${await text(page, '[data-testid=runner-status]')} rows=${JSON.stringify(await page.getByTestId('runner-row').evaluateAll((e) => e.map((x) => x.getAttribute('data-runner'))))}`);
  await shoot(page, '8-after-delete');
  await page.goto('/t/engineering/bots');
  await page.waitForTimeout(3000);
  log(`8 bots page: ${(await text(page)).slice(0, 200)} ... probe present=${(await text(page)).includes('Probe')}`);
  await shoot(page, '8-bots-final');
});
