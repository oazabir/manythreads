/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/claude-0/-root-manythreads/079ca634-3c90-4571-b318-4602cc3894ca/scratchpad/v19';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
const fivexx: string[] = [];

async function login(browser: Browser, who: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('response', (r) => { if (r.status() >= 500) { fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`); log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`); } });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { ctx, page };
}
const csrf = async (ctx: BrowserContext): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const shoot = async (page: Page, n: string): Promise<void> => { await page.waitForLoadState('networkidle').catch(() => undefined); await page.screenshot({ path: join(OUT, `${n}.png`) }); log(`shot ${n}`); };

let omar: { ctx: BrowserContext; page: Page };
test('login', async ({ browser }) => { omar = await login(browser, 'OMAR'); });

test('3 admin API + roles', async ({ browser }) => {
  const { page } = omar;
  const a = await page.request.get('/api/admin/bot-runners');
  const aj = (await a.json().catch(() => null)) as any;
  const arr = Array.isArray(aj) ? aj : aj?.runners ?? aj?.items;
  log(`GET /api/admin/bot-runners ${a.status()} isArray=${Array.isArray(aj)} keys=${Array.isArray(aj) ? 'array' : Object.keys(aj ?? {})}`);
  for (const r of arr ?? []) log(`  runner keys=${Object.keys(r).join(',')} name=${r.name} kind=${r.kind} state=${r.status ?? r.state} hasKey=${r.hasKey} baseUrl=${r.baseUrl === undefined ? 'absent' : 'PRESENT'}`);
  const o = await page.request.get('/api/admin/bot-runners/old-connections');
  const oj = (await o.json().catch(() => null)) as any;
  log(`GET old-connections ${o.status()}: ${JSON.stringify(oj).replace(/"(apiKey|baseUrl)":"[^"]*"/g, '"$1":"<redacted>"').slice(0, 900)}`);
  const m = await page.request.get('/api/teams/engineering/bot-runners');
  const mj = (await m.json().catch(() => null)) as any;
  log(`GET team bot-runners (admin) ${m.status()}: ${JSON.stringify(mj).slice(0, 700)}`);
  const mem = await page.request.get('/api/teams/engineering/members');
  const mm = (await mem.json().catch(() => null)) as any;
  log(`members ${mem.status()}: ${JSON.stringify(mm).slice(0, 1200)}`);
  void browser;
});

test('3b non-admin checks', async ({ browser }) => {
  for (const who of ['NADIA', 'RAFI', 'SAMEERA', 'TARIQ', 'PRIYA', 'LENA']) {
    if (!process.env[`${who}_EMAIL`]) continue;
    const u = await login(browser, who).catch((e) => { log(`${who} login failed ${String(e).slice(0, 80)}`); return null; });
    if (!u) continue;
    const adm = await u.page.request.get('/api/admin/bot-runners');
    const team = await u.page.request.get('/api/teams/engineering/bot-runners');
    const conns = await u.page.request.get('/api/teams/engineering/hermes/connections');
    const cj = (await conns.json().catch(() => null)) as any;
    const me = await u.page.request.get('/api/teams/engineering/members');
    const mj = (await me.json().catch(() => null)) as any;
    const mine = JSON.stringify(mj).includes('') ? '' : '';
    log(`${who}: admin ${adm.status()}, team runners ${team.status()}, connections list ${conns.status()} addrPresent=${JSON.stringify(cj).includes('baseUrl')} members ${me.status()} ${mine}`);
    if (team.status() === 200) {
      const post = await u.page.request.post('/api/teams/engineering/hermes/connections', { headers: await csrf(u.ctx), data: { name: `zz-probe-${sfx}`, baseUrl: 'http://127.0.0.1:9', apiKey: 'xxxxxxxxxxxx', agent: 'hermes' } });
      log(`${who}: POST hermes/connections ${post.status()} ${(await post.text()).slice(0, 200)}`);
      const tj = (await team.json()) as any;
      log(`${who}: team runners keys ${JSON.stringify((Array.isArray(tj) ? tj : tj.runners ?? tj.items ?? []).map((r: any) => Object.keys(r).join('|'))).slice(0, 300)}`);
    }
    await u.ctx.close();
  }
});

let pagePath = '';
test('1 page tick', async () => {
  const { page, ctx } = omar;
  pagePath = `pages/verify-p19-02-${sfx}.md`;
  const w = await page.request.post('/api/teams/engineering/pages/write', { headers: await csrf(ctx), data: { mode: 'create', path: pagePath, content: '# Verify checklist\n\nSome words.\n\n- [ ] one\n- [ ] two\n- [x] three\n\nEnd.\n', message: 'verify P19-02 scratch page' } });
  log(`page create ${w.status()}`);
  const reqs: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET') reqs.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`/t/engineering/files?open=${encodeURIComponent(pagePath)}`);
  const md = page.getByTestId('viewer-markdown');
  await expect(md.locator('.md-prose')).toContainText('Verify checklist', T);
  const boxes = md.locator('input[type=checkbox]');
  const states = async (): Promise<string> => JSON.stringify(await boxes.evaluateAll((e) => e.map((x) => (x as HTMLInputElement).checked)));
  log(`boxes ${await boxes.count()} ${await states()}`);
  await shoot(page, '1-before');
  const blob = async (): Promise<any> => (await page.request.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent(pagePath)}`)).json();
  const b0 = await blob();
  await boxes.first().click();
  await page.waitForTimeout(3000);
  const save = await md.getByRole('button', { name: 'Save' }).isDisabled().catch(() => 'n/a (no button)');
  const b1 = await blob();
  log(`tick: ui ${await states()}; Save disabled=${save}; commit changed=${b0.commitSha !== b1.commitSha}; content ${JSON.stringify(b1.content)}`);
  log(`non-GET requests: ${JSON.stringify(reqs)}`);
  await shoot(page, '1-after-tick');
  await page.reload();
  await expect(md.locator('.md-prose')).toContainText('Verify checklist', T);
  log(`after reload ${await states()}`);
  await boxes.first().click();
  await page.waitForTimeout(3000);
  const b2 = await blob();
  log(`untick: ui ${await states()}; content ${JSON.stringify(b2.content)}`);
  await page.reload();
  await expect(md.locator('.md-prose')).toContainText('Verify checklist', T);
  log(`untick after reload ${await states()}`);
  const h = await page.request.get(`/api/teams/engineering/repo/log?path=${encodeURIComponent(pagePath)}`);
  log(`repo log ${h.status()} ${(await h.text()).replace(/"(email|sha|commitSha)":"[^"]*"/g, '').slice(0, 700)}`);
  await shoot(page, '1-after-untick-reload');
  // cleanup
  const b = await blob();
  const r = await page.request.post('/api/teams/engineering/repo/commit', { headers: await csrf(ctx), data: { message: 'verify P19-02: remove scratch page', changes: [{ op: 'delete', path: pagePath, baseBlobSha: b.blobSha }] } });
  log(`delete scratch page ${r.status()}`);
});

test('2 bots', async () => {
  const { page } = omar;
  await page.goto('/t/engineering/bots');
  await page.waitForTimeout(2500);
  log(`roster text: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  await shoot(page, '2-roster');
  await page.goto('/t/engineering/bots/brain');
  await page.waitForTimeout(2500);
  log(`brain page text: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
  await shoot(page, '2-brain-page');
  await page.goto('/t/engineering/bots/brain/chat');
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  const word = `pong${sfx}`;
  await box.fill(`say ${word} and nothing else`);
  const t0 = Date.now();
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  await shoot(page, '2-chat-sent');
  const msgs = page.getByTestId('message');
  const n0 = await msgs.count();
  let secs = -1;
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(1000);
    const txt = await page.locator('main').innerText();
    const occurrences = txt.split(word).length - 1;
    if (occurrences >= 2) { secs = Math.round((Date.now() - t0) / 1000); break; }
  }
  log(`brain reply seconds=${secs} (messages ${n0} -> ${await msgs.count()})`);
  log(`chat tail: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-400)}`);
  await shoot(page, '2-chat-answered');
});

test('4 agents screen', async ({ browser }) => {
  for (const who of ['OMAR', 'NADIA', 'RAFI', 'PRIYA']) {
    const u = who === 'OMAR' ? omar : await login(browser, who);
    const { page } = u;
    await page.goto('/t/engineering/agents');
    await page.waitForTimeout(3000);
    const txt = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const rows = await page.getByTestId('agents-row').count();
    const btns = await page.locator('main').getByRole('button').evaluateAll((e) => e.map((x) => x.textContent?.trim()));
    log(`${who} agents: rows=${rows} buttons=${JSON.stringify(btns)} adminNote=${txt.includes('An admin sets this up')} addr=${JSON.stringify(await page.locator('.ag-addr').allInnerTexts())}`);
    log(`${who} text: ${txt.slice(0, 350)}`);
    await shoot(page, `4-agents-${who}`);
    if (rows > 0) {
      const host = page.locator('[data-testid="agents-row"][data-connection="host"]');
      const tb = host.getByRole('button', { name: 'Test' });
      if (await tb.count()) {
        await tb.click();
        await expect(host.locator('.ag-result')).toBeVisible({ timeout: 60_000 });
        log(`${who} Test host: ${(await host.locator('.ag-result').innerText()).slice(0, 200)}`);
        await shoot(page, `4-agents-${who}-tested`);
      } else log(`${who}: no Test button on host`);
    }
    if (who !== 'OMAR') await u.ctx.close();
  }
});

test.afterAll(async () => { log(`5xx seen: ${fivexx.length} ${JSON.stringify(fivexx)}`); await omar?.ctx.close(); });

test('2b brain pong wait', async () => {
  const { page } = omar;
  await page.goto('/t/engineering/bots/brain/chat');
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  const word = `pong${sfx}b`;
  await box.fill(`say ${word} and nothing else`);
  const t0 = Date.now();
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  let secs = -1;
  for (let i = 0; i < 170; i++) {
    await page.waitForTimeout(1000);
    const txt = await page.locator('main').innerText();
    if (/Brain\s+\S*\s*\d\d:\d\d[\s\S]{0,80}pong/i.test(txt) || (txt.split(word).length - 1 >= 3)) { secs = Math.round((Date.now() - t0) / 1000); break; }
  }
  log(`brain2 reply seconds=${secs}`);
  log(`chat2: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-500)}`);
  await shoot(page, '2b-chat');
});
