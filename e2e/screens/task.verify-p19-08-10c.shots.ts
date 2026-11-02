/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/p1908-shots';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
const STEP = process.env.STEP ?? 'a1';

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
const red = (o: unknown, n = 2500): string => String(JSON.stringify(o)).replace(/"(key|apiKey)":"[^"]*"/g, '"$1":"<redacted>"').slice(0, n);

let omar: { ctx: BrowserContext; page: Page };
test('login', async ({ browser }) => { omar = await login(browser, 'OMAR'); });

test('a1 create pod runner + api', async () => {
  test.skip(STEP !== 'a1');
  const { page } = omar;
  const n = await j(page, '/api/admin/bot-runners/nodes'); log(`a1 nodes ${n.status} ${red(n.body)}`);
  const l = await j(page, '/api/admin/bot-runners'); log(`a1 runners ${l.status} ${red(l.body?.items?.map((x: any) => `${x.name}:${x.kind}:${x.node}`))}`);
  if (!l.body.items.find((x: any) => x.name === 'probe-pod1908')) {
    const c = await j(page, '/api/admin/bot-runners', { method: 'POST', data: { name: 'probe-pod1908', label: 'Probe pod 1908', kind: 'hermes_pod', enabled: false, teams: { teams: [] } } });
    log(`a1 create ${c.status} ${red(c.body)}`);
  }
  const l2 = await j(page, '/api/admin/bot-runners'); const r = l2.body.items.find((x: any) => x.name === 'probe-pod1908');
  log(`a1 runner ${red(r)}`);
  const n2 = await j(page, `/api/admin/bot-runners/nodes?runnerId=${r.id}`); log(`a1 nodes for runner ${n2.status} ${red(n2.body)}`);
});

test('a2 ui picker', async () => {
  test.skip(STEP !== 'a2');
  const { page } = omar;
  await page.goto('/settings/workspace/runners');
  await expect(page.getByRole('heading', { name: 'Runners', level: 1 })).toBeVisible(T);
  await page.waitForTimeout(2500);
  log(`a2 page: ${(await text(page)).slice(0, 800)}`);
  await shoot(page, 'a2-1-runners-page');
  const row = page.locator('[data-testid=runner-row][data-runner="probe-pod1908"]');
  log(`a2 row: ${await row.innerText().then((x) => x.replace(/\s+/g, ' '))}`);
  await row.getByTestId('runner-node-open').click();
  await expect(page.getByTestId('runner-node-dialog')).toBeVisible(T);
  await page.waitForTimeout(2000);
  const sel = page.getByTestId('runner-node-select');
  log(`a2 select value=${await sel.inputValue()} options=${JSON.stringify(await sel.locator('option').allInnerTexts())}`);
  log(`a2 dialog: ${await text(page, '[data-testid=runner-node-dialog]')}`);
  await shoot(page, 'a2-2-machine-dialog');
  await sel.selectOption({ label: (await sel.locator('option').allInnerTexts()).find((t) => t.includes('ubuntu-vm')) ?? '' });
  await shoot(page, 'a2-3-chosen');
  await page.getByTestId('runner-node-save').click();
  await page.waitForTimeout(3000);
  log(`a2 confirm dialog visible=${await page.getByTestId('runner-node-confirm').count()}`);
  log(`a2 status: ${await text(page, '[data-testid=runner-status]').catch(() => '(none)')}`);
  log(`a2 row after: ${await row.innerText().then((x) => x.replace(/\s+/g, ' '))}`);
  await shoot(page, 'a2-4-after-save');
  const l2 = await j(page, '/api/admin/bot-runners'); log(`a2 api node=${l2.body.items.find((x: any) => x.name === 'probe-pod1908').node}`);
});

test('a3 clear + delete', async () => {
  test.skip(STEP !== 'a3');
  const { page } = omar;
  const l = await j(page, '/api/admin/bot-runners'); const r = l.body.items.find((x: any) => x.name === 'probe-pod1908');
  const p = await j(page, `/api/admin/bot-runners/${r.id}/node`, { method: 'PUT', data: { node: null } }); log(`a3 clear ${p.status} node=${p.body?.runner?.node}`);
  const bad = await j(page, `/api/admin/bot-runners/${r.id}/node`, { method: 'PUT', data: { node: 'nope-node' } }); log(`a3 bad node ${bad.status} ${red(bad.body)}`);
  const d = await j(page, `/api/admin/bot-runners/${r.id}`, { method: 'DELETE' }); log(`a3 delete ${d.status} ${red(d.body)}`);
  const l2 = await j(page, '/api/admin/bot-runners'); log(`a3 runners now ${red(l2.body.items.map((x: any) => x.name))}`);
});

const bm = (name: string, native: string[], runsOn?: string): string => `---
schema: 1
name: ${name}
role: Throwaway probe for the model runner.
kind: agent
runtime: hermes
visibility: team
triggers:
  - type: conversation
capabilities:
  native:
${native.map((n) => `    - ${n}`).join('\n')}
memory:
  file: memory.md
  maxLines: 200
${runsOn ? `placement:\n  runs_on: ${runsOn}\n` : ''}---

You are a terse probe. Answer in one short sentence.
`;
const RUN = 'probe-model1908';
async function waitBot(page: Page, slug: string, secs = 60): Promise<any> {
  for (let i = 0; i < secs / 3; i++) {
    const b = await j(page, '/api/teams/engineering/bots');
    const f = b.body?.bots?.find((x: any) => x.slug === slug);
    if (f) return f;
    await page.waitForTimeout(3000);
  }
  return null;
}
const propose = (page: Page, slug: string, native: string[], runsOn: string | undefined, title: string): Promise<any> =>
  j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${slug}/BOT.md`, op: 'put', content: bm(slug, native, runsOn), baseBlobSha: null, title, applyNow: true } });

test('b0 explore', async () => {
  test.skip(STEP !== 'b0');
  const { page } = omar;
  const a = await j(page, '/api/workspace/llm/aliases'); log(`aliases ${a.status} ${red(a.body, 1200)}`);
  const tm = await j(page, '/api/teams'); log(`teams ${tm.status} ${red(tm.body, 900)}`);
  const bots = await j(page, '/api/teams/engineering/bots'); log(`bots ${red(bots.body?.bots?.map((b: any) => `${b.slug}:${b.status}:${b.invalid}`))}`);
  const sp = await j(page, '/api/workspace/llm/spend'); log(`spend ${sp.status} ${red(sp.body, 1500)}`);
});

test('b1 create model runner', async () => {
  test.skip(STEP !== 'b1');
  const { page } = omar;
  const tm = await j(page, '/api/teams'); const eng = (tm.body.teams ?? tm.body.items ?? tm.body).find((t: any) => t.slug === 'engineering');
  const c = await j(page, '/api/admin/bot-runners', { method: 'POST', data: { name: RUN, label: 'Probe model 1908', kind: 'llm_gateway', modelAlias: process.env.ALIAS ?? 'fast', enabled: true, teams: { teams: [eng.id] } } });
  log(`b1 create ${c.status} ${red(c.body)}`);
});

test('b2 nopost on model runner', async () => {
  test.skip(STEP !== 'b2');
  const { page } = omar;
  const c = await propose(page, 'probe-nopost', ['memory.recall'], RUN, 'P19-10c probe: bot that cannot post on model runner');
  log(`b2 proposal ${c.status} status=${c.body?.proposal?.proposal?.status} checks=${red(c.body?.proposal?.proposal?.checks, 1800)}`);
  log(`b2 full ${red(c.body, 2500)}`);
  await page.waitForTimeout(6000);
  const f = (await j(page, '/api/teams/engineering/bots')).body.bots.find((x: any) => x.slug === 'probe-nopost');
  log(`b2 bot ${red(f && { status: f.status, invalid: f.invalid, placement: f.placement })}`);
  await page.goto('/t/engineering/bots'); await page.waitForTimeout(3000);
  log(`b2 list tail: ${(await text(page)).slice(-600)}`);
  await shoot(page, 'b2-1-bots-list');
  if (f) { await page.goto('/t/engineering/bots/probe-nopost'); await page.waitForTimeout(3000); log(`b2 page: ${(await text(page)).slice(0, 900)}`); await shoot(page, 'b2-2-nopost-page'); }
});

test('b3 picker for nopost bot (no runs_on)', async () => {
  test.skip(STEP !== 'b3');
  const { page } = omar;
  const c = await propose(page, 'probe-nopost2', ['memory.recall'], undefined, 'P19-10c probe: bot that cannot post, no runner chosen');
  log(`b3 proposal ${c.status} status=${c.body?.proposal?.proposal?.status}`);
  await waitBot(page, 'probe-nopost2');
  await page.goto('/t/engineering/bots/probe-nopost2');
  await page.waitForTimeout(2500);
  await page.getByRole('navigation', { name: 'Bot sections' }).getByText('Placement', { exact: false }).first().click();
  await page.waitForTimeout(1500);
  log(`b3 runs-on: ${await text(page, '[data-testid=runs-on]').catch(() => '(none)')}`);
  const sel = page.getByTestId('runs-on-select');
  if (await sel.count()) {
    const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => `${(o as HTMLOptionElement).text} | disabled=${(o as HTMLOptionElement).disabled}`));
    log(`b3 options ${JSON.stringify(opts)}`);
  }
  await shoot(page, 'b3-1-picker-nopost');
});

test('b4 proposal not applied (check)', async () => {
  test.skip(STEP !== 'b4');
  const { page } = omar;
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: 'bots/probe-nopost3/BOT.md', op: 'put', content: bm('probe-nopost3', ['memory.recall'], RUN), baseBlobSha: null, title: 'P19-10c probe: proposal check only', applyNow: false } });
  log(`b4 proposal ${c.status} ${red(c.body, 3000)}`);
});

test('b5 post-capable bot on model runner', async () => {
  test.skip(STEP !== 'b5');
  const { page } = omar;
  const c = await propose(page, 'probe-post', ['messages.post', 'memory.recall'], RUN, 'P19-10c probe: bot that may post on model runner');
  log(`b5 proposal ${c.status} status=${c.body?.proposal?.proposal?.status} checks=${red(c.body?.proposal?.proposal?.checks, 1500)}`);
  const f = await waitBot(page, 'probe-post');
  log(`b5 bot ${red(f && { status: f.status, invalid: f.invalid, placement: f.placement })}`);
});

async function chat(page: Page, slug: string, prompt: string, shotName: string, maxSecs = 90): Promise<void> {
  await page.goto(`/t/engineering/bots/${slug}/chat`);
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  await page.waitForTimeout(1500);
  await box.fill(prompt);
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForTimeout(2500);
  for (let i = 0; i < maxSecs; i++) { if (!(await page.locator('main').innerText()).includes('is working on it')) break; await page.waitForTimeout(1000); }
  await page.waitForTimeout(6000);
  log(`${shotName} tail: ${(await text(page)).slice(-700)}`);
  await shoot(page, shotName);
}
test('b6 chat post bot', async () => { test.skip(STEP !== 'b6'); await chat(omar.page, 'probe-post', 'reply with the single word pong1908', 'b6-chat-probe-post'); });
test('b7 chat brain', async () => { test.skip(STEP !== 'b7'); await chat(omar.page, 'brain', 'reply with the single word brain1908', 'b7-chat-brain', 120); });

test('b8 spend', async () => {
  test.skip(STEP !== 'b8');
  const { page } = omar;
  const sp = await j(page, '/api/workspace/llm/spend'); log(`spend ${sp.status} ${red(sp.body, 2500)}`);
  await page.goto('/settings/workspace/llm'); await page.waitForTimeout(3000);
  for (const id of ['llm-spend-by-bot', 'llm-spend-by-team']) log(`${id}: ${(await page.locator(`[data-testid=${id}]`).count()) ? await text(page, `[data-testid=${id}]`) : '(none)'}`);
  await page.locator('[data-testid=llm-spend-by-bot]').scrollIntoViewIfNeeded().catch(() => undefined);
  await shoot(page, 'b8-spend');
});

test('b9 cleanup', async () => {
  test.skip(STEP !== 'b9');
  const { page } = omar;
  const bots = (await j(page, '/api/teams/engineering/bots')).body.bots.filter((b: any) => /^probe-/.test(b.slug));
  log(`b9 probe bots ${red(bots.map((b: any) => b.slug))}`);
  const props = await j(page, '/api/teams/engineering/proposals?status=open'); log(`b9 open proposals ${red(props.body, 600)}`);
  for (const pr of (props.body?.proposals ?? props.body?.items ?? [])) {
    const x = pr.proposal ?? pr;
    if (/probe-/.test(x.path ?? '')) { const w = await j(page, `/api/teams/engineering/proposals/${x.id}/withdraw`, { method: 'POST', data: {} }); log(`b9 withdraw ${x.path} ${w.status}`); }
  }
  const tree = await j(page, '/api/teams/engineering/repo/tree?path=bots'); log(`b9 tree before ${red(tree.body, 900)}`);
  for (const slug of ['probe-nopost', 'probe-nopost2', 'probe-nopost3', 'probe-post']) {
    const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${slug}/BOT.md`, op: 'delete', title: `P19-10c probe: remove ${slug}`, applyNow: true } });
    log(`b9 delete ${slug} ${c.status} ${c.status >= 400 ? red(c.body, 300) : c.body?.proposal?.proposal?.status}`);
  }
  await page.waitForTimeout(8000);
  const l = (await j(page, '/api/teams/engineering/bots')).body.bots; log(`b9 bots now ${red(l.map((b: any) => `${b.slug}:${b.status}`))}`);
  const tree2 = await j(page, '/api/teams/engineering/repo/tree?path=bots'); log(`b9 tree after ${red(tree2.body, 900)}`);
  const rr = await j(page, '/api/admin/bot-runners'); const r = rr.body.items.find((x: any) => x.name === RUN);
  if (r) { const d = await j(page, `/api/admin/bot-runners/${r.id}`, { method: 'DELETE' }); log(`b9 runner delete ${d.status} ${red(d.body, 300)}`); }
  log(`b9 runners ${red((await j(page, '/api/admin/bot-runners')).body.items.map((x: any) => x.name))}`);
});
