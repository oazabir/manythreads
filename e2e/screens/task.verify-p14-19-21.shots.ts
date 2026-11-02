/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/claude-0/-root-manythreads/079ca634-3c90-4571-b318-4602cc3894ca/scratchpad/v';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
let ctx: BrowserContext;
let page: Page;
const fivexx: string[] = [];
let cardId = '';
let boardId = '';
let chanId = '';
let chanName = '';

const csrf = async (): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const shoot = async (n: string): Promise<void> => { await page.waitForLoadState('networkidle').catch(() => undefined); await page.screenshot({ path: join(OUT, `${n}.png`) }); log(`shot ${n}`); };
const sideways = async (label: string): Promise<void> => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  log(`${label} scrollWidth ${w.sw} body ${w.bw} client ${w.cw} => ${w.sw <= w.cw ? 'OK' : 'SIDEWAYS'}`);
};

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) { fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`); log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`); } });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
});

test('A1 card checklist', async () => {
  const boards = (await (await page.request.get('/api/teams/engineering/boards')).json()) as any;
  boardId = boards.items[0].id;
  const res = await page.request.post('/api/teams/engineering/tasks', { headers: await csrf(), data: { title: `verify-p14-19 checklist ${sfx}`, description: 'Checklist:\n\n- [ ] one\n- [ ] two\n- [x] three', kind: 'content', priority: 'low', branch: `task/verify-${sfx}` } });
  log(`create card ${res.status()}`);
  cardId = ((await res.json()) as any).task.id;
  await page.goto(`/t/engineering/boards?board=${boardId}&card=${cardId}`);
  const desc = page.getByTestId('card-description');
  await expect(desc).toBeVisible(T);
  const list = desc.getByTestId('md-tasklist');
  await expect(list).toContainText('1 of 3 done');
  const boxes = list.getByRole('checkbox');
  log(`checkbox count ${await boxes.count()}; names: ${JSON.stringify(await boxes.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  await expect(list.getByRole('checkbox', { name: /: one$/ })).toHaveCount(1);
  await shoot('a1-01-before');
  // tick "one"; watch for flicker by sampling state
  const one = list.getByRole('checkbox', { name: /: one$/ });
  await page.evaluate(() => {
    const w = window as any; w.__states = [];
    const el = document.querySelector('[data-testid="card-description"] input[type=checkbox]') as HTMLInputElement;
    const rec = () => w.__states.push(el.checked);
    const obs = new MutationObserver(rec);
    obs.observe(el, { attributes: true });
    const iv = setInterval(() => { const e2 = document.querySelector('[data-testid="card-description"] input[type=checkbox]') as HTMLInputElement | null; w.__states.push(e2 ? e2.checked : 'gone'); }, 20);
    setTimeout(() => clearInterval(iv), 4000);
  });
  await one.click();
  await expect(list).toContainText('2 of 3 done', T);
  await page.waitForTimeout(2500);
  const states = (await page.evaluate(() => (window as any).__states)) as any[];
  const compact = states.filter((s, i) => i === 0 || s !== states[i - 1]);
  log(`first-box state sequence (deduped) ${JSON.stringify(compact)}`);
  const firstNow = await list.getByRole('checkbox').first().isChecked();
  log(`first box checked now ${firstNow}; names now ${JSON.stringify(await list.getByRole('checkbox').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`);
  const focusInfo = await page.evaluate(() => { const a = document.activeElement as HTMLElement; return { tag: a?.tagName, type: (a as HTMLInputElement)?.type, label: a?.getAttribute('aria-label') }; });
  log(`focus after tick ${JSON.stringify(focusInfo)}`);
  await expect(page.getByTestId('card-history')).toContainText(/ticked/i);
  log(`history text: ${(await page.getByTestId('card-history').innerText()).replace(/\n+/g, ' | ').slice(0, 400)}`);
  await shoot('a1-02-after-tick');
  await page.reload();
  await expect(page.getByTestId('card-description').getByTestId('md-tasklist')).toContainText('2 of 3 done', T);
  log('persisted after reload: 2 of 3 done');
  // keyboard untick
  const first = page.getByTestId('card-description').getByRole('checkbox').first();
  await first.focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('card-description').getByTestId('md-tasklist')).toContainText('1 of 3 done', T);
  const focus2 = await page.evaluate(() => { const a = document.activeElement as HTMLElement; return { tag: a?.tagName, label: a?.getAttribute('aria-label') }; });
  log(`untick via keyboard OK; focus ${JSON.stringify(focus2)}`);
  log(`history after untick: ${(await page.getByTestId('card-history').innerText()).replace(/\n+/g, ' | ').slice(0, 500)}`);
  await shoot('a1-03-unticked');
  // 390
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/engineering/boards?board=${boardId}&card=${cardId}`);
  await expect(page.getByTestId('card-description')).toBeVisible(T);
  await sideways('A1 390 card');
  await shoot('a1-04-390');
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('A2 message checklist read-only', async () => {
  chanName = `verify-p1419-${sfx}`;
  const c = await page.request.post('/api/teams/engineering/channels', { headers: await csrf(), data: { name: chanName } });
  log(`channel ${c.status()}`);
  chanId = ((await c.json()) as any).channel.id;
  const m = await page.request.post(`/api/channels/${chanId}/messages`, { headers: await csrf(), data: { channelId: chanId, body: 'List:\n\n- [ ] one\n- [ ] two\n- [x] three', threadRootId: null } });
  log(`message ${m.status()}`);
  await page.goto(`/t/engineering/c/${chanName}`);
  const list = page.getByTestId('md-tasklist');
  await expect(list).toBeVisible(T);
  const boxes = list.getByRole('checkbox');
  log(`message boxes ${await boxes.count()}, disabled: ${JSON.stringify(await boxes.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).disabled)))}`);
  await boxes.first().click({ force: true }).catch((e) => log(`click: ${String(e).slice(0, 80)}`));
  await page.waitForTimeout(800);
  log(`after force-click first checked=${await boxes.first().isChecked()}; progress ${await list.locator('.md-taskcount').innerText()}`);
  await shoot('a2-message');
});


let pagePath = '';
test('A3 page checklist tick', async () => {
  pagePath = `pages/verify-p14-19-${sfx}.md`;
  const w = await page.request.post('/api/teams/engineering/pages/write', { headers: await csrf(), data: { mode: 'create', path: pagePath, content: '# Verify checklist\n\nSome words.\n\n- [ ] alpha\n- [ ] beta\n- [x] gamma\n\nEnd.\n', message: 'verify P14-19 scratch page' } });
  log(`page create ${w.status()}`);
  await page.goto(`/t/engineering/files?open=${encodeURIComponent(pagePath)}`);
  const md = page.getByTestId('viewer-markdown');
  await expect(md).toBeVisible(T);
  await expect(md.locator('.md-prose')).toContainText('Verify checklist', T);
  const boxes = md.locator('input[type=checkbox]');
  log(`page boxes ${await boxes.count()} checked ${JSON.stringify(await boxes.evaluateAll((e) => e.map((x) => (x as HTMLInputElement).checked)))}`);
  await shoot('a3-01-page-before');
  const before = (await (await page.request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(pagePath)}`)).json()) as any;
  log('DOM: ' + (await md.locator('.md-prose ul').first().evaluate((e) => e.outerHTML)).slice(0, 900));
  page.on('console', (m) => log('console ' + m.type() + ' ' + m.text().slice(0, 200)));
  page.on('request', (r) => { if (r.method() !== 'GET') log('REQ ' + r.method() + ' ' + r.url()); });
  await boxes.first().click();
  await page.waitForTimeout(2500);
  log(`ui after tick checked ${JSON.stringify(await boxes.evaluateAll((e) => e.map((x) => (x as HTMLInputElement).checked)))}; save button: ${await md.getByRole('button', { name: 'Save' }).isDisabled().catch(() => 'n/a')}`);
  const after = (await (await page.request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(pagePath)}`)).json()) as any;
  log(`blob changed: ${before.commitSha !== after.commitSha}; content now: ${JSON.stringify(after.content)}`);
  await shoot('a3-02-page-after-tick');
  await page.reload();
  const md2 = page.getByTestId('viewer-markdown');
  await expect(md2.locator('.md-prose')).toContainText('Verify checklist', T);
  log(`after reload checked ${JSON.stringify(await md2.locator('input[type=checkbox]').evaluateAll((e) => e.map((x) => (x as HTMLInputElement).checked)))}`);
  await shoot('a3-03-page-reload');
  // author of the commit
  const h = await page.request.get(`/api/teams/engineering/repo/log?path=${encodeURIComponent(pagePath)}`);
  log(`repo log ${h.status()} ${(await h.text()).slice(0, 600)}`);
});

test('A4 bot audit tab', async () => {
  const bots = ((await (await page.request.get('/api/teams/engineering/bots')).json()) as any).bots.map((b: any) => b.slug) as string[];
  log(`bots ${bots.join(',')}`);
  let found = 0;
  for (const slug of bots.slice(0, 12)) {
    await page.goto(`/t/engineering/bots/${slug}?tab=audit`);
    await expect(page.getByTestId('pane-audit')).toBeVisible(T);
    await page.waitForTimeout(700);
    const txt = (await page.getByTestId('pane-audit').innerText()).replace(/\s+/g, ' ');
    const rep = await page.getByTestId('run-repairs').count();
    const err = /something went wrong|error|failed to load/i.test(txt) && !/\bfailed\b/.test(txt);
    log(`bot ${slug}: pane chars ${txt.length}, repair lines ${rep}, text: ${txt.slice(0, 160)}`);
    if (rep) { found++; await shoot(`a4-repairs-${slug}`); }
    if (slug === bots[0]) await shoot(`a4-audit-${slug}`);
    void err;
  }
  log(`bots with a "Formatting fixed" line: ${found}`);
});


test('A1b history after untick', async () => {
  boardId = ((await (await page.request.get('/api/teams/engineering/boards')).json()) as any).items[0].id;
  const all = (await (await page.request.get('/api/teams/engineering/tasks?limit=100')).json()) as any;
  const mine = all.items.filter((t: any) => String(t.title).startsWith('verify-p14-19 checklist'));
  log(`scratch cards found ${mine.length}`);
  for (const t of mine) { if (t.id !== mine[0].id) { const r = await page.request.patch(`/api/teams/engineering/tasks/${t.id}`, { headers: await csrf(), data: { state: 'done' } }); log(`done ${t.id.slice(0,8)} ${r.status()} ${r.status() >= 400 ? (await r.text()).slice(0,120) : ''}`); } }
  cardId = mine[0].id;
  await page.goto(`/t/engineering/boards?board=${boardId}&card=${cardId}`);
  await expect(page.getByTestId('card-history')).toContainText('created', T);
  log(`A1b history: ${(await page.getByTestId('card-history').innerText()).replace(/\n+/g, ' | ')}`);
  const st = await page.request.patch(`/api/teams/engineering/tasks/${cardId}`, { headers: await csrf(), data: { state: 'done' } });
  log(`move scratch card to done ${st.status()}`);
});

let projId = '';
test('B projects', async () => {
  const cdnLeak: string[] = [];
  await page.goto('/t/engineering/projects');
  await expect(page.getByTestId('projects-empty')).toBeVisible(T);
  await page.getByTestId('projects-add-open').click();
  const form = page.getByTestId('projects-add');
  await form.getByLabel('Name').fill(`verify-scratch-${sfx}`);
  await form.getByLabel('Repository address').fill('https://github.com/verify-owner/verify-scratch');
  await form.getByRole('button', { name: 'Add project' }).click();
  await page.waitForTimeout(2000);
  const row = page.getByTestId('projects-row').first();
  const added = await row.isVisible().catch(() => false);
  log(`project row visible ${added}`);
  if (!added) { log(`add form text: ${(await form.innerText()).replace(/\n+/g, ' | ')}`); await shoot('b-00-add-failed'); return; }
  projId = ((await (await page.request.get('/api/teams/engineering/projects')).json()) as any).items[0].id;
  const box = row.getByTestId('projects-publishing');
  await expect(box).toBeVisible(T);
  await shoot('b-01-projects');
  const share = box.getByTestId('projects-credential-share');
  log(`share checkbox visible ${await share.isVisible()}; role checkbox: ${await box.getByRole('checkbox', { name: /Use for every project of this team that lives under verify-owner/ }).count()}; text: ${(await share.innerText()).replace(/\s+/g, ' ')}`);
  log(`checkbox default checked: ${await share.locator('input').isChecked()}`);
  const submit = box.getByRole('button', { name: /Check and save/ });
  await box.getByLabel('GitHub username').fill('octocat');
  await box.getByLabel('GitHub token').fill('ghp_invalid');
  log(`short token 'ghp_invalid': submit disabled=${await submit.isDisabled()}; box text near form: ${(await box.innerText()).replace(/\s+/g, ' ').slice(0, 700)}`);
  await shoot('b-02-short-token');
  await box.getByLabel('GitHub token').fill('ghp_invalidinvalidinvalid1234');
  log(`20+ char invalid token: submit disabled=${await submit.isDisabled()}`);
  await submit.click();
  await page.waitForTimeout(6000);
  log(`after submit: ${(await row.innerText()).replace(/\s+/g, ' ').slice(0, 900)}`);
  log(`token field value now "${await box.getByLabel('GitHub token').inputValue().catch(() => '(form gone)')}"`);
  await shoot('b-03-after-invalid-submit');
  const p = (await (await page.request.get('/api/teams/engineering/projects')).json()) as any;
  log(`api: pushCredentialSetAt=${p.items[0].pushCredentialSetAt} status=${p.items[0].pushCredentialStatus} shared=${p.items[0].pushCredentialShared}; body mentions token: ${JSON.stringify(p).includes('ghp_invalid')}`);
  const html = await page.content();
  log(`page html contains token text: ${html.includes('ghp_invalidinvalid')}; any visible: ${(await page.locator('body').innerText()).includes('ghp_invalidinvalid')}`);
  // 390
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/t/engineering/projects');
  await expect(page.getByTestId('projects-publishing')).toBeVisible(T);
  await sideways('B 390 projects');
  await shoot('b-04-390');
  await page.setViewportSize({ width: 1280, height: 900 });
  void cdnLeak;
});

test('B TEAM.md', async () => {
  const r = await page.request.get('/api/teams/engineering/repo/blob?path=TEAM.md');
  const j = (await r.json()) as any;
  const c: string = j.content ?? '';
  log(`TEAM.md ${r.status()} has "Getting started (the lead)": ${c.includes('Getting started (the lead)')}; "Connect GitHub": ${c.includes('Connect GitHub')}`);
  await page.goto('/t/engineering/files?open=TEAM.md');
  await page.waitForTimeout(2500);
  await shoot('b-05-team-md');
});

test('cleanup', async () => {
  if (projId) { const r = await page.request.delete(`/api/teams/engineering/projects/${projId}`, { headers: await csrf() }); log(`delete project ${r.status()}`); }
  const tree = (await (await page.request.get('/api/teams/engineering/repo/tree?path=pages')).json()) as any;
  log(`tree: ${JSON.stringify(tree).slice(0, 300)}`);
  for (const e of (tree.entries ?? tree.items ?? []).filter((x: any) => String(x.path ?? x.name).includes('verify-p14-19'))) {
    const path = String(e.path ?? `pages/${e.name}`);
    const b = (await (await page.request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`)).json()) as any;
    const r = await page.request.post('/api/teams/engineering/repo/commit', { headers: await csrf(), data: { message: 'verify P14-19: remove scratch page', changes: [{ op: 'delete', path, baseBlobSha: b.blobSha }] } });
    log(`delete page ${path} ${r.status()}`);
  }
});

test.afterAll(async () => {
  log(`5xx seen: ${fivexx.length}`);
  if (chanId) { const r = await page.request.post(`/api/channels/${chanId}/archive`, { headers: await csrf() }); log(`archive channel ${r.status()}`); }
  await ctx?.close();
});
