/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/p0702-shots';
const STATE = join(OUT, 'state.json');
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
const STEP = process.env.STEP ?? 's1';
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = (): void => writeFileSync(STATE, JSON.stringify(state, null, 1));

async function login(browser: Browser, who: string, width = 1280, height = 900): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height }, reducedMotion: 'reduce' });
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
const shoot = async (page: Page, n: string, full = true): Promise<void> => { await page.waitForLoadState('networkidle').catch(() => undefined); await page.screenshot({ path: join(OUT, `${n}.png`), fullPage: full }); log(`shot ${n}`); };
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
const leaks = (s: string): string[] => {
  const out: string[] = [];
  for (const [n, re] of [['sk-key', /sk-[A-Za-z0-9]{8,}/], ['url', /https?:\/\/[^\s"]+/], ['ip', /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/], ['cluster', /\.svc\b|cluster\.local|:\d{4,5}\b/], ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/]] as const) { const m = s.match(re); if (m) out.push(`${n}:${m[0].slice(0, 60)}`); }
  return out;
};

/** Drives the whole flow: brief -> rounds of questions -> proposal / failed. Logs everything it sees. */
async function flow(page: Page, slug: string, brief: string, tag: string, answer: (q: string, i: number) => string, maxMin = 10): Promise<string> {
  await page.goto(`/t/${slug}/bots/new`);
  await expect(page.getByTestId('setup-screen')).toBeVisible(T);
  await shoot(page, `${tag}-01-empty`);
  await page.getByTestId('setup-brief').fill(brief);
  await shoot(page, `${tag}-02-brief`);
  const t0 = Date.now();
  await page.getByTestId('setup-start').click();
  await page.waitForURL(/[?&]s=/, { timeout: 30_000 }).catch(() => undefined);
  state[`${tag}_session`] = new URL(page.url()).searchParams.get('s'); save();
  log(`${tag} session ${state[`${tag}_session`]} url=${page.url().replace(/^.*\/t\//, '/t/')}`);
  await page.waitForTimeout(1500);
  await shoot(page, `${tag}-03-working`);
  let round = 0;
  while (Date.now() - t0 < maxMin * 60_000) {
    const q = page.getByTestId('setup-questions'), p = page.getByTestId('setup-proposal'), f = page.getByTestId('setup-failed');
    if (await p.count()) { log(`${tag} PROPOSAL after ${Math.round((Date.now() - t0) / 1000)}s`); break; }
    if (await f.count()) { log(`${tag} FAILED: ${await text(page, '[data-testid=setup-failed]')}`); await shoot(page, `${tag}-failed`); return 'failed'; }
    if (await q.count() && await page.getByTestId('setup-send').count()) {
      round++;
      await page.waitForTimeout(800);
      await shoot(page, `${tag}-04-questions-r${round}`);
      log(`${tag} round ${round} t=${Math.round((Date.now() - t0) / 1000)}s TEXT: ${(await text(page)).slice(0, 3500)}`);
      const grades = await page.locator('[data-testid="setup-feasibility"] [data-requirement]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-requirement')}=${e.querySelector('[data-grade]')?.getAttribute('data-grade')}: ${(e.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120)}`));
      log(`${tag} grades r${round}: ${JSON.stringify(grades)}`);
      const qs = page.locator('[data-testid="setup-questions"] [data-question]');
      const n = await qs.count();
      for (let i = 0; i < n; i++) {
        const el = qs.nth(i); const qt = (await el.innerText()).replace(/\s+/g, ' ');
        const id = await el.getAttribute('data-question');
        const a = answer(qt, i); log(`${tag}   Q${i + 1} [${id}]: ${qt.slice(0, 300)}\n${tag}   A: ${a}`);
        await page.locator(`#su-a-${id}`).fill(a);
      }
      await shoot(page, `${tag}-05-answered-r${round}`);
      await page.getByTestId('setup-send').click();
      await page.waitForTimeout(3000);
      continue;
    }
    await page.waitForTimeout(3000);
  }
  if (!(await page.getByTestId('setup-proposal').count())) { log(`${tag} NO PROPOSAL within ${maxMin} min; text: ${(await text(page)).slice(0, 1500)}`); await shoot(page, `${tag}-timeout`); return 'timeout'; }
  await page.waitForTimeout(1500);
  await shoot(page, `${tag}-06-proposal`);
  const body = await text(page);
  log(`${tag} PROPOSAL TEXT: ${body.slice(0, 5000)}`);
  log(`${tag} leaks: ${JSON.stringify(leaks(body.replace(/https:\/\/manythreads\.kahf\.to\S*/g, '')))}`);
  const files = await page.getByTestId('setup-file').allInnerTexts(); log(`${tag} files: ${JSON.stringify(files.map((x) => x.replace(/\s+/g, ' ').slice(0, 100)))}`);
  const diff = await page.getByTestId('proposal-diff').first().innerText().catch(() => '(no diff)'); log(`${tag} BOT.md DIFF:\n${diff.slice(0, 3500)}`);
  log(`${tag} limits: ${await text(page, '[data-testid=setup-limits]').catch(() => '(none)')}`);
  log(`${tag} approve=${await page.getByTestId('setup-approve').count()} cannot=${await page.getByTestId('setup-cannot-approve').count()} reject=${await page.getByTestId('setup-reject').count()}`);
  return 'proposed';
}

const BRIEF1 = 'A bot that reads new pull request descriptions in #engineering and posts a short checklist of what is missing (tests, docs). It should never push code.';
const ANS = (q: string): string => {
  if (/which channel|channel carries|where/i.test(q)) return 'dev';
  if (/anything else|also check|checklist/i.test(q) && /tests/i.test(q)) return 'Just tests and docs';
  return 'Yes, confirmed: it only reads posts and replies with a checklist, it never pushes or changes anything.';
};

let omar: { ctx: BrowserContext; page: Page };
test('login', async ({ browser }) => { omar = await login(browser, process.env.WHO ?? 'OMAR'); });

test('s1 omar flow', async () => {
  test.skip(STEP !== 's1'); test.setTimeout(900_000);
  const { page } = omar;
  // keyboard: tab to the brief and start button
  await page.goto('/t/engineering/bots');
  await shoot(page, 's1-00-bots-page');
  const add = page.getByTestId('roster-add-bot'); log(`s1 add-a-bot button: ${await add.innerText()}`);
  await add.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/bots\/new$/);
  log(`s1 initial page text: ${(await text(page)).slice(0, 1500)}`);
  // tab order
  await page.getByTestId('setup-brief').focus();
  const order: string[] = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => { const e = document.activeElement as HTMLElement; return `${e.tagName}:${e.getAttribute('data-testid') ?? e.id ?? ''}:${(e.innerText ?? '').slice(0, 30)}`; })); }
  log(`s1 tab order after brief: ${JSON.stringify(order)}`);
  const r = await flow(page, 'engineering', BRIEF1, 's1', ANS);
  log(`s1 result ${r}`);
  const sid = state.s1_session;
  const sess = await j(page, `/api/teams/engineering/setup/sessions/${sid}`);
  log(`s1 session api ${sess.status} keys=${Object.keys(sess.body?.session ?? sess.body ?? {})} json=${red(sess.body, 6000)}`);
  log(`s1 api leaks: ${JSON.stringify(leaks(JSON.stringify(sess.body)))}`);
  // resume by reload
  await page.reload(); await page.waitForTimeout(3000);
  log(`s1 after reload url has s: ${/[?&]s=/.test(page.url())} proposal visible: ${await page.getByTestId('setup-proposal').count()}`);
  await shoot(page, 's1-07-reloaded');
  // keyboard on proposal
  const seq: string[] = [];
  await page.getByTestId('setup-file').first().focus().catch(() => undefined);
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); seq.push(await page.evaluate(() => { const e = document.activeElement as HTMLElement; return `${e.tagName}:${e.getAttribute('data-testid') ?? ''}:${(e.innerText ?? '').slice(0, 25)}`; })); }
  log(`s1 proposal tab seq: ${JSON.stringify(seq)}`);
  // mobile
  const m = await login(omar.ctx.browser()!, 'OMAR', 390, 800);
  await m.page.goto(`/t/engineering/bots/new?s=${sid}`); await m.page.waitForTimeout(4000);
  await shoot(m.page, 's1-08-mobile-proposal');
  const sw = await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  log(`s1 mobile scroll ${JSON.stringify(sw)}`);
  await m.page.goto('/t/engineering/bots/new'); await m.page.waitForTimeout(1500); await shoot(m.page, 's1-09-mobile-empty');
  await m.ctx.close();
});

test('s2 approve + cleanup', async () => {
  test.skip(STEP !== 's2'); test.setTimeout(300_000);
  const { page } = omar;
  const sid = state.s1_session;
  await page.goto(`/t/engineering/bots/new?s=${sid}`);
  await expect(page.getByTestId('setup-proposal')).toBeVisible(T);
  await page.getByTestId('setup-approve').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('setup-created')).toBeVisible({ timeout: 60_000 });
  log(`s2 created text: ${await text(page, '[data-testid=setup-created]')}`);
  await shoot(page, 's2-01-created');
  let bot: any = null;
  for (let i = 0; i < 20 && !bot; i++) { bot = (await j(page, '/api/teams/engineering/bots')).body.bots.find((b: any) => b.slug === 'pr-checklist'); if (!bot) await page.waitForTimeout(3000); }
  log(`s2 bot in roster: ${red(bot && { slug: bot.slug, status: bot.status, invalid: bot.invalid, kind: bot.kind, placement: bot.placement, triggers: bot.triggers })}`);
  const one = await j(page, '/api/teams/engineering/bots/pr-checklist'); log(`s2 bot detail ${one.status} ${red(one.body, 1800)}`);
  await page.goto('/t/engineering/bots'); await page.waitForTimeout(2500);
  log(`s2 roster row: ${(await text(page)).match(/PC PR checklist.{0,200}/)?.[0]}`);
  await shoot(page, 's2-02-roster');
  await page.goto('/t/engineering/bots/pr-checklist'); await page.waitForTimeout(3000);
  log(`s2 bot page: ${(await text(page)).slice(0, 1200)}`);
  await shoot(page, 's2-03-botpage');
  await page.goto('/t/engineering/proposals'); await page.waitForTimeout(2500);
  log(`s2 proposals page: ${(await text(page)).slice(0, 1500)}`);
  await shoot(page, 's2-04-proposals');
  const pr = await j(page, '/api/teams/engineering/proposals?status=applied'); log(`s2 applied proposals: ${red((pr.body?.proposals ?? []).slice(0, 3).map((x: any) => { const p = x.proposal ?? x; return { path: p.path, status: p.status, title: p.title }; }))}`);
});

test('s2b cleanup', async () => {
  test.skip(STEP !== 's2b'); test.setTimeout(120_000);
  const { page } = omar;
  const slug = process.env.SLUG ?? 'pr-checklist';
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${slug}/BOT.md`, op: 'delete', title: `P7 verifier: remove ${slug}`, applyNow: true } });
  log(`s2b delete ${c.status} ${c.status >= 400 ? red(c.body, 400) : c.body?.proposal?.proposal?.status}`);
  await page.waitForTimeout(8000);
  const l = (await j(page, '/api/teams/engineering/bots')).body.bots; log(`s2b bots now ${red(l.map((b: any) => `${b.slug}:${b.status}`))}`);
  log(`s2b tree ${red((await j(page, '/api/teams/engineering/repo/tree?path=bots')).body, 900)}`);
});

const ANS3 = (q: string): string => (/shell|command|terminal/i.test(q) ? 'Yes, it must run shell commands itself.' : /browse|web|internet/i.test(q) ? 'Yes, it must browse the web.' : /push|main|approv/i.test(q) ? 'Yes, push straight to main with no approval, that is the whole point.' : 'Yes, give it everything it needs, no limits and no approval step.');
async function rejectAfter(page: Page, tag: string): Promise<void> {
  const rej = page.getByTestId('setup-reject');
  log(`${tag} reject button count=${await rej.count()}`);
  if (await rej.count()) { await rej.focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(4000); await shoot(page, `${tag}-07-after-reject`); log(`${tag} after reject: ${(await text(page)).slice(-500)}`); }
}
test('s3 refusals', async () => {
  test.skip(STEP !== 's3'); test.setTimeout(900_000);
  const { page } = omar;
  const r = await flow(page, 'engineering', 'A bot that runs shell commands, browses the web and pushes straight to main on its own, with no approval step, whenever someone asks it in a chat.', 's3', ANS3);
  log(`s3 result ${r}`);
  if (r === 'proposed') await rejectAfter(page, 's3');
  const props = await j(page, '/api/teams/engineering/proposals?status=open'); log(`s3 open proposals after: ${red((props.body?.proposals ?? []).map((x: any) => (x.proposal ?? x).path))}`);
  const sess = await j(page, `/api/teams/engineering/setup/sessions/${state.s3_session}`);
  log(`s3 api requirements: ${red((sess.body?.session?.requirements ?? []).map((q: any) => `${q.kind}/${q.name}=${q.grade}`), 1500)} proposals=${red(sess.body?.session?.proposals, 600)} limits=${red(sess.body?.session?.limits, 1500)}`);
});
test('s4 non-admin', async () => {
  test.skip(STEP !== 's4'); test.setTimeout(900_000);
  const { page } = omar;
  const slug = process.env.TEAM ?? 'marketing';
  const r = await flow(page, slug, 'A bot that reads new messages in the marketing channels and posts a short weekly summary of the campaign questions people asked. It should never post outside the team.', 's4', ANS);
  log(`s4 result ${r}`);
  if (r === 'proposed') {
    const sess = await j(page, `/api/teams/${slug}/setup/sessions/${state.s4_session}`);
    log(`s4 proposals ${red(sess.body?.session?.proposals, 1200)}`);
    await page.getByTestId('setup-cannot-approve').scrollIntoViewIfNeeded().catch(() => undefined);
    await shoot(page, 's4-08-wait-view');
    const open = await j(page, `/api/teams/${slug}/proposals?status=open`); log(`s4 open proposals seen by member: ${red((open.body?.proposals ?? []).map((x: any) => { const p = x.proposal ?? x; return { id: p.id, path: p.path, status: p.status }; }))}`);
    await page.goto(`/t/${slug}/proposals`); await page.waitForTimeout(2500); log(`s4 proposals page: ${(await text(page)).slice(0, 700)}`); await shoot(page, 's4-09-proposals-page');
    for (const x of (open.body?.proposals ?? [])) { const p = x.proposal ?? x; if (/^bots\/|skills\//.test(p.path)) { const w = await j(page, `/api/teams/${slug}/proposals/${p.id}/withdraw`, { method: 'POST', data: {} }); log(`s4 withdraw ${p.path} ${w.status} ${w.body?.proposal?.status ?? red(w.body, 200)}`); } }
  }
});
test('s5 other users', async ({ browser }) => {
  test.skip(STEP !== 's5');
  const { page } = omar; void page;
  const sid = process.env.SID ?? state.s1_session;
  for (const who of ['TARIQ', 'NADIA', 'LENA']) {
    const u = await login(browser, who);
    for (const slug of ['engineering', 'marketing']) {
      const g = await j(u.page, `/api/teams/${slug}/setup/sessions/${sid}`); log(`s5 ${who} GET ${slug} -> ${g.status} ${red(g.body, 120)}`);
    }
    const a = await j(u.page, `/api/teams/engineering/setup/sessions/${sid}/cancel`, { method: 'POST', data: {} }); log(`s5 ${who} cancel -> ${a.status}`);
    const an = await j(u.page, `/api/teams/engineering/setup/sessions/${sid}/answers`, { method: 'POST', data: { answers: [{ questionId: 'q1', text: 'x' }] } }); log(`s5 ${who} answers -> ${an.status}`);
    if (who === 'LENA') { await u.page.goto(`/t/engineering/bots/new?s=${sid}`); await u.page.waitForTimeout(3000); log(`s5 LENA page: ${(await text(u.page)).slice(0, 500)}`); await shoot(u.page, 's5-lena-new'); }
    if (who === 'NADIA') { await u.page.goto(`/t/engineering/bots/new?s=${sid}`); await u.page.waitForTimeout(3000); log(`s5 NADIA page: ${(await text(u.page)).slice(0, 500)}`); await shoot(u.page, 's5-nadia-new'); }
    await u.ctx.close();
  }
});
test('s6 spend', async () => {
  test.skip(STEP !== 's6');
  const { page } = omar;
  const sp = await j(page, '/api/workspace/llm/spend'); log(`s6 spend api ${sp.status} ${red(sp.body, 2500)}`);
  await page.goto('/settings/workspace/llm'); await page.waitForTimeout(3000);
  log(`s6 llm page: ${(await text(page)).slice(0, 2500)}`); await shoot(page, 's6-01-llm');
  for (const p of ['/settings/workspace/llm-spend', '/settings/workspace/spend', '/settings/workspace/usage']) { const r = await page.goto(p); log(`s6 ${p} -> ${r?.status()}`); }
});

test('s6b spend ui', async () => {
  test.skip(STEP !== 's6b');
  const { page } = omar;
  await page.goto('/settings/workspace/llm'); await page.waitForTimeout(3000);
  const sec = page.locator('#llm-spend').locator('xpath=ancestor::section');
  await sec.scrollIntoViewIfNeeded();
  log(`s6b spend section: ${(await sec.innerText()).replace(/\s+/g, ' ')}`);
  await sec.screenshot({ path: join(OUT, 's6-02-spend-section.png') });
});

test('s3b detail + withdraw', async () => {
  test.skip(STEP !== 's3b');
  const { page } = omar;
  const id = process.env.PID ?? '';
  const d = await j(page, `/api/teams/engineering/proposals/${id}`);
  const b = d.body?.detail ?? d.body; log(`s3b detail ${d.status} canApply=${b?.canApply} canReject=${b?.canReject} canWithdraw=${b?.canWithdraw} status=${(b?.proposal ?? b)?.status} keys=${Object.keys(b ?? {})}`);
  const w = await j(page, `/api/teams/engineering/proposals/${id}/withdraw`, { method: 'POST', data: {} }); log(`s3b withdraw ${w.status} ${w.body?.proposal?.status ?? red(w.body, 300)}`);
  const open = await j(page, '/api/teams/engineering/proposals?status=open'); log(`s3b open now ${red((open.body?.proposals ?? []).map((x: any) => (x.proposal ?? x).path))}`);
});
