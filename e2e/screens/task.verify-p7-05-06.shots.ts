/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = 'https://manythreads.kahf.to';
const OUT = '/tmp/p0705-shots';
const STATE = join(OUT, 'state.json');
const T = { timeout: 20_000 };
const BOT = process.env.BOT ?? 'ws-probe';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
const STEP = process.env.STEP ?? 'create';
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

const BOT_MD = [
  '---', 'schema: 1', 'name: Probe Writer', 'role: Posts short updates to #dev and creates tasks when asked',
  'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'triggers:', '  - { type: conversation }', '  - { type: mention }',
  'capabilities:', '  native: [messages.post, messages.search, tasks.create, tasks.read]', '---', '',
  '# Probe Writer', '',
  'You help the Engineering team by posting updates to channels and creating tasks. When a person asks you to post a message to a channel, call the post tool with exactly their text. When they ask for a task, create it. Keep your replies to the person brief.', '',
].join('\n');

const wsUrl = (mode: string, sid?: string | null, bot = BOT): string => `/t/engineering/bots/${bot}/chat?view=workshop&mode=${mode}${sid ? `&ws=${sid}` : ''}`;
const api = (bot = BOT): string => `/api/teams/engineering/bots/${bot}/workshop/sessions`;

function summarize(s: any): string {
  const out: string[] = [`status=${s.status} mode=${s.mode} msgs=${s.messageCount ?? s.message_count} usage=${red(s.usage, 200)} message=${s.message ?? ''}`];
  for (const e of s.entries ?? []) {
    if (e.kind === 'person') out.push(`  PERSON: ${e.text.slice(0, 300)}`);
    else if (e.kind === 'reply') out.push(`  REPLY${e.rehearsal ? '(rehearsal)' : ''}: ${e.text.slice(0, 1500)}`);
    else if (e.kind === 'step') out.push(`  STEP ${e.tool} [${e.outcome}] badge=${e.badge} what=${e.what}`);
    else if (e.kind === 'proposal') out.push(`  PROPOSAL ${e.role} ${e.path} id=${e.proposalId} "${e.title}"`);
    else out.push(`  ${String(e.kind).toUpperCase()}: ${e.text}`);
  }
  return out.join('\n');
}

async function waitDone(page: Page, sid: string, maxSec = 420, bot = BOT): Promise<any> {
  const t0 = Date.now();
  let s: any = null;
  while (Date.now() - t0 < maxSec * 1000) {
    const r = await j(page, `${api(bot)}/${sid}`);
    s = r.body?.session;
    if (s && s.status !== 'working') { log(`done after ${Math.round((Date.now() - t0) / 1000)}s`); return s; }
    await page.waitForTimeout(4000);
  }
  log('TIMEOUT waiting'); return s;
}

/** Send one message through the page (UI). With no sid starts a new conversation in the mode. Returns the finished session. */
async function say(page: Page, mode: string, msg: string, tag: string, sid?: string | null): Promise<any> {
  await page.goto(wsUrl(mode, sid)); await expect(page.getByTestId('workshop-tab')).toBeVisible(T);
  await page.waitForTimeout(1500);
  if (!sid) await shoot(page, `${tag}-00-empty`);
  await page.getByTestId('ws-text').fill(msg);
  await shoot(page, `${tag}-01-typed`, false);
  await page.getByTestId('ws-send').click();
  if (!sid) { await page.waitForURL(/[?&]ws=/, { timeout: 30_000 }); sid = new URL(page.url()).searchParams.get('ws'); }
  await page.waitForTimeout(2000);
  await shoot(page, `${tag}-02-working`, false);
  const s = await waitDone(page, sid!);
  await page.waitForTimeout(3500);
  await shoot(page, `${tag}-03-done`);
  log(`${tag} sid=${sid}\n${summarize(s)}`);
  state[`${tag}_sid`] = sid; save();
  return s;
}

let omar: { ctx: BrowserContext; page: Page };
test('login', async ({ browser }) => { omar = await login(browser, process.env.WHO ?? 'OMAR'); });

test('create', async () => {
  test.skip(STEP !== 'create'); test.setTimeout(240_000);
  const { page } = omar;
  const c = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${BOT}/BOT.md`, op: 'put', content: BOT_MD, title: `P7 verifier: add ${BOT}`, applyNow: true } });
  log(`create ${c.status} ${c.status >= 400 ? red(c.body, 800) : c.body?.proposal?.proposal?.status}`);
  let b: any = null;
  for (let i = 0; i < 30 && !b; i++) { b = (await j(page, '/api/teams/engineering/bots')).body.bots?.find((x: any) => x.slug === BOT); if (!b) await page.waitForTimeout(3000); }
  log(`bot: ${red(b && { slug: b.slug, status: b.status, invalid: b.invalid, name: b.name, role: b.role })}`);
});

test('s1 tabs', async ({ browser }) => {
  test.skip(STEP !== 's1'); test.setTimeout(240_000);
  const { page } = omar;
  const focused = async (): Promise<string> => page.evaluate(() => { const e = document.activeElement as HTMLElement; return `${e.tagName}:${e.getAttribute('data-testid') ?? e.id}:${e.getAttribute('aria-selected')}`; });
  await page.goto(`/t/engineering/bots/${BOT}/chat`); await page.waitForTimeout(2500);
  await shoot(page, 's1-01-chat');
  log(`s1 chat url ${page.url()} tabs: chat=${await page.getByTestId('ws-view-chat').count()} workshop=${await page.getByTestId('ws-view-workshop').count()}`);
  const seqs: Array<[string, string]> = [['ws-view-chat', 'ArrowRight'], ['ws-view-workshop', 'Home'], ['ws-view-chat', 'End'], ['ws-view-workshop', 'ArrowLeft'], ['ws-view-chat', 'ArrowRight']];
  for (const [from, key] of seqs) {
    await page.getByTestId(from).focus();
    await page.keyboard.press(key); await page.waitForTimeout(400);
    const f1 = await focused(); await page.waitForTimeout(2500); const f2 = await focused();
    log(`s1 ${from} + ${key}: focus@0.4s=${f1} focus@3s=${f2} url=${page.url().replace(BASE, '')} workshop-visible=${await page.getByTestId('workshop-tab').count()}`);
    await shoot(page, `s1-02-${from}-${key}`, false);
  }
  // mode tabs
  await page.getByTestId('ws-mode-build').focus();
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'Home', 'End', 'ArrowLeft']) {
    await page.keyboard.press(k); await page.waitForTimeout(600);
    log(`s1 mode ${k}: focus=${await focused()} url=${page.url().replace(BASE, '')} data-mode=${await page.getByTestId('workshop-tab').getAttribute('data-mode')}`);
  }
  await page.getByTestId('ws-mode-live').focus(); await page.keyboard.press('End'); await page.waitForTimeout(600);
  await shoot(page, 's1-03-live-mode');
  const urlBefore = page.url();
  await page.reload(); await page.waitForTimeout(3000);
  log(`s1 reload: url same=${page.url() === urlBefore} (${page.url().replace(BASE, '')}) view=${await page.getByTestId('workshop-tab').count()} mode=${await page.getByTestId('workshop-tab').getAttribute('data-mode')} selected=${await page.getByTestId('ws-view-workshop').getAttribute('aria-selected')}`);
  await shoot(page, 's1-04-reloaded');
  await page.goBack(); await page.waitForTimeout(1500);
  log(`s1 back: url=${page.url().replace(BASE, '')} mode=${await page.getByTestId('workshop-tab').getAttribute('data-mode').catch(() => 'n/a')}`);
  // mobile
  const m = await login(browser, 'OMAR', 390, 800);
  for (const mode of ['build', 'rehearse', 'live']) {
    await m.page.goto(wsUrl(mode)); await m.page.waitForTimeout(2500);
    const sw = await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    log(`s1 mobile ${mode} scroll ${JSON.stringify(sw)}`);
    await shoot(m.page, `s1-05-mobile-${mode}`);
  }
  await m.page.goto(`/t/engineering/bots/${BOT}/chat`); await m.page.waitForTimeout(2500);
  log(`s1 mobile chat scroll ${JSON.stringify(await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })))}`);
  await shoot(m.page, 's1-06-mobile-chat');
  await m.ctx.close();
});

test('s2 build change', async () => {
  test.skip(STEP !== 's2'); test.setTimeout(900_000);
  const { page } = omar;
  const s = await say(page, 'build', 'Make the replies shorter: at most two sentences. Also change the role to: Posts updates to #dev: brief, with a "quoted" word # and tasks', 's2');
  const pids = (s.entries ?? []).filter((e: any) => e.kind === 'proposal').map((e: any) => e.proposalId);
  state.s2_pids = pids; save();
  for (const id of pids) {
    const d = await j(page, `/api/teams/engineering/proposals/${id}`);
    const b = d.body?.detail ?? d.body;
    log(`s2 proposal ${id} status=${(b?.proposal ?? b)?.status} path=${(b?.proposal ?? b)?.path} canApply=${b?.canApply}`);
    log(`s2 diff/content: ${red(b, 3500)}`);
  }
  const bots = (await j(page, '/api/teams/engineering/bots')).body.bots; const me = bots.find((x: any) => x.slug === BOT);
  log(`s2 bot BEFORE approve: name=${me.name} role=${me.role}`);
  await page.goto('/t/engineering/proposals'); await page.waitForTimeout(2500); await shoot(page, 's2-04-proposals'); log(`s2 proposals page: ${(await text(page)).slice(0, 800)}`);
  if (pids[0]) { await page.goto(`/t/engineering/proposals/${pids[0]}`); await page.waitForTimeout(2500); await shoot(page, 's2-05-proposal-detail'); log(`s2 detail text: ${(await text(page)).slice(0, 2500)}`); }
});

test('s2b approve', async () => {
  test.skip(STEP !== 's2b'); test.setTimeout(240_000);
  const { page } = omar;
  for (const id of state.s2_pids ?? []) {
    const a = await j(page, `/api/teams/engineering/proposals/${id}/approve`, { method: 'POST', data: {} }); log(`s2b approve ${id} ${a.status} ${a.status >= 400 ? red(a.body, 300) : (a.body?.proposal?.proposal ?? a.body?.proposal)?.status}`);
  }
  await page.waitForTimeout(8000);
  const me = (await j(page, '/api/teams/engineering/bots')).body.bots.find((x: any) => x.slug === BOT);
  log(`s2b bot AFTER approve: name=${JSON.stringify(me.name)} role=${JSON.stringify(me.role)} invalid=${red(me.invalid)}`);
  const one = await j(page, `/api/teams/engineering/bots/${BOT}`); log(`s2b detail ${red(one.body, 1500)}`);
});

test('s3 rehearse', async () => {
  test.skip(STEP !== 's3'); test.setTimeout(900_000);
  const { page } = omar;
  const s = await say(page, 'rehearse', 'Post this exact message in #dev: "REHEARSAL-MARKER-7731 deploy is done". Then create a task titled "REHEARSAL-TASK-7731 check the logs".', 's3');
  log(`s3 held/badge steps: ${(s.entries ?? []).filter((e: any) => e.kind === 'step').map((e: any) => `${e.tool}:${e.outcome}:${e.badge}`).join(' | ')}`);
  const badges = await page.getByTestId('ws-badge').allInnerTexts(); log(`s3 badges on page: ${JSON.stringify(badges)} reply-rehearsal attr: ${JSON.stringify(await page.getByTestId('ws-reply').evaluateAll((els) => els.map((e) => e.getAttribute('data-rehearsal'))))}`);
  log(`s3 usage line: ${await page.getByTestId('ws-usage').innerText().catch(() => '(none)')}`);
  await page.getByTestId('ws-usage').scrollIntoViewIfNeeded().catch(() => undefined);
  await shoot(page, 's3-04-after');
  const m = await login(page.context().browser()!, 'OMAR', 390, 800);
  await m.page.goto(wsUrl('rehearse', state.s3_sid)); await m.page.waitForTimeout(3500); await shoot(m.page, 's3-05-mobile');
  log(`s3 mobile scroll ${JSON.stringify(await m.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })))}`);
  await m.ctx.close();
  // spend page
  const sp = await j(page, '/api/workspace/llm/spend'); log(`s3 spend api ${sp.status} ${red(sp.body, 3000)}`);
  await page.goto('/settings/workspace/llm'); await page.waitForTimeout(3000);
  const sec = page.locator('#llm-spend').locator('xpath=ancestor::section');
  await sec.scrollIntoViewIfNeeded();
  log(`s3 spend section: ${(await sec.innerText()).replace(/\s+/g, ' ').slice(0, 2500)}`);
  await sec.screenshot({ path: join(OUT, 's3-06-spend.png') });
});

test('s4 member', async ({ browser }) => {
  test.skip(STEP !== 's4'); test.setTimeout(240_000);
  for (const who of ['PRIYA', 'NADIA']) {
    const u = await login(browser, who);
    await u.page.goto(wsUrl('rehearse')); await u.page.waitForTimeout(3000);
    log(`s4 ${who} url=${u.page.url().replace(BASE, '')} mode-rehearse aria-disabled=${await u.page.getByTestId('ws-mode-rehearse').getAttribute('aria-disabled')} selected=${await u.page.getByTestId('ws-mode-rehearse').getAttribute('aria-selected')}`);
    log(`s4 ${who} hint=${await u.page.getByTestId('ws-mode-rehearse-why').innerText().catch(() => '(none)')}`);
    log(`s4 ${who} send disabled/aria=${await u.page.getByTestId('ws-send').getAttribute('aria-disabled').catch(() => 'n/a')}`);
    await shoot(u.page, `s4-${who.toLowerCase()}-rehearse`);
    await u.page.goto(wsUrl('build')); await u.page.waitForTimeout(1500);
    await u.page.getByTestId('ws-mode-build').focus(); await u.page.keyboard.press('ArrowRight'); await u.page.waitForTimeout(800);
    log(`s4 ${who} after ArrowRight from build: selected-rehearse=${await u.page.getByTestId('ws-mode-rehearse').getAttribute('aria-selected')} focus=${await u.page.evaluate(() => (document.activeElement as HTMLElement).getAttribute('data-testid'))}`);
    const c = await j(u.page, api(), { method: 'POST', data: { mode: 'rehearse', text: 'hello' } });
    log(`s4 ${who} API create rehearse -> ${c.status} ${red(c.body, 300)}`);
    const sid = state.s3_sid;
    const msg = await j(u.page, `${api()}/${sid}/messages`, { method: 'POST', data: { text: 'hi' } }); log(`s4 ${who} post to omar rehearsal -> ${msg.status}`);
    const l = await j(u.page, api()); log(`s4 ${who} list -> ${l.status} ${red(l.body, 300)}`);
    await u.ctx.close();
  }
});

test('s5 live', async () => {
  test.skip(STEP !== 's5'); test.setTimeout(900_000);
  const { page } = omar;
  const s = await say(page, 'live', 'What did you do recently? Give me counts and which runs you can see.', 's5');
  const s2 = await (async () => { await page.goto(wsUrl('live', state.s5_sid)); await page.getByTestId('ws-text').fill('Show the last few runs of this bot and what each one read. Also tell me about runs of the marketing team.'); await page.getByTestId('ws-send').click(); await page.waitForTimeout(2000); const r = await waitDone(page, state.s5_sid); await page.waitForTimeout(3000); await shoot(page, 's5-04-followup'); log(`s5 followup\n${summarize(r)}`); return r; })();
  void s; void s2;
});

test('s5b live on brain', async () => {
  test.skip(STEP !== 's5b'); test.setTimeout(900_000);
  const { page } = omar;
  const r0 = await say(page, 'live', 'What did you do recently? How many runs, what started them and what did they read? Do you see any run of another team?', 's5b', null); void r0;
});

test('s6 learn', async () => {
  test.skip(STEP !== 's6'); test.setTimeout(1200_000);
  const { page } = omar;
  const a = await say(page, 'build', 'No, always sign your replies with the team name, "Engineering". That was wrong of you.', 's6a');
  state.s6a_pids = (a.entries ?? []).filter((e: any) => e.kind === 'proposal').map((e: any) => ({ id: e.proposalId, path: e.path, role: e.role })); save();
  const b = await say(page, 'build', 'Do not ask the lead for approval before posting.', 's6b', state.s6a_sid);
  state.s6b_pids = (b.entries ?? []).filter((e: any) => e.kind === 'proposal').map((e: any) => ({ id: e.proposalId, path: e.path, role: e.role })); save();
  const c = await say(page, 'build', "No, never use emoji in replies. And please don't make that a rule.", 's6c', state.s6a_sid);
  state.s6c_pids = (c.entries ?? []).filter((e: any) => e.kind === 'proposal').map((e: any) => ({ id: e.proposalId, path: e.path, role: e.role })); save();
  const open = await j(page, '/api/teams/engineering/proposals?status=open');
  log(`s6 open proposals: ${red((open.body?.proposals ?? []).map((x: any) => { const p = x.proposal ?? x; return { id: p.id, path: p.path, status: p.status }; }), 2500)}`);
});

test('s6d approve + files', async () => {
  test.skip(STEP !== 's6d'); test.setTimeout(300_000);
  const { page } = omar;
  const all = [...(state.s6a_pids ?? [])];  state.seen = all.map((x: any) => x.id); save();
  for (const p of all) {
    const d = await j(page, `/api/teams/engineering/proposals/${p.id}`); const pp = (d.body?.detail ?? d.body)?.proposal?.proposal ?? d.body?.proposal; log(`s6d DIFF ${p.role} ${p.path} note=${pp?.note?.slice(0, 300)} diff=${pp?.diff?.slice(0, 1200)} content=${pp?.content?.slice(0, 1200)} checks=${red(pp?.checks, 400)}`);
  }
  for (const p of all) {
    const a = await j(page, `/api/teams/engineering/proposals/${p.id}/approve`, { method: 'POST', data: {} }); log(`s6d approve ${p.role} ${p.path} ${a.status} ${a.status >= 400 ? red(a.body, 300) : (a.body?.proposal?.proposal ?? a.body?.proposal)?.status}`);
  }
  await page.waitForTimeout(6000);
  const tree = await j(page, `/api/teams/engineering/repo/tree?path=bots/${BOT}`); log(`s6d tree ${red(tree.body, 1200)}`);
  for (const f of ['lessons.md', 'evals']) { const r = await j(page, `/api/teams/engineering/repo/file?path=bots/${BOT}/${f}`); log(`s6d file ${f} ${r.status} ${red(r.body, 1500)}`); }
  const bm = await j(page, `/api/teams/engineering/repo/file?path=bots/${BOT}/BOT.md`); log(`s6d BOT.md ${bm.status} ${red(bm.body, 2500)}`);
});

test('s6e repeat', async () => {
  test.skip(STEP !== 's6e'); test.setTimeout(1500_000);
  const { page } = omar;
  const msgs = ["No, never use emoji in replies. And please don't make that a rule.", 'No, you must always sign replies with the team name Engineering.', 'Never use emoji in your replies. Make that a rule.'];
  for (const [i, m] of msgs.entries()) {
    const tag = `s6e${i + 1}`;
    const s = await say(page, 'build', m, tag, state.s6a_sid);
    const mine = (s.entries ?? []).slice(-12);
    const pids = (s.entries ?? []).filter((e: any) => e.kind === 'proposal' && !(state.seen ?? []).includes(e.proposalId)).map((e: any) => ({ id: e.proposalId, path: e.path, role: e.role }));
    state.seen = [...(state.seen ?? []), ...pids.map((x: any) => x.id)]; save(); void mine;
    log(`${tag} NEW proposals: ${red(pids)}`);
    for (const p of pids) {
      const d = await j(page, `/api/teams/engineering/proposals/${p.id}`); const pp = (d.body?.detail ?? d.body)?.proposal?.proposal ?? d.body?.proposal;
      log(`${tag} DIFF ${p.role} ${p.path}: ${pp?.diff?.slice(0, 1500)}`);
    }
    for (const p of pids) { const a = await j(page, `/api/teams/engineering/proposals/${p.id}/approve`, { method: 'POST', data: {} }); log(`${tag} approve ${p.role} ${a.status}`); }
    await page.waitForTimeout(6000);
  }
});

test('s7 privacy', async ({ browser }) => {
  test.skip(STEP !== 's7'); test.setTimeout(240_000);
  for (const who of ['PRIYA', 'TARIQ', 'NADIA']) {
    const u = await login(browser, who);
    for (const k of ['s2', 's3', 's5', 's6a']) {
      const sid = state[`${k}_sid`]; if (!sid) continue;
      const g = await j(u.page, `${api()}/${sid}`); const m = await j(u.page, `${api()}/${sid}/messages`, { method: 'POST', data: { text: 'hi' } }); const e = await j(u.page, `${api()}/${sid}/end`, { method: 'POST', data: {} });
      log(`s7 ${who} ${k}: GET ${g.status} POST msg ${m.status} end ${e.status}`);
    }
    if (who === 'PRIYA') { await u.page.goto(wsUrl('build', state.s2_sid)); await u.page.waitForTimeout(3500); log(`s7 PRIYA page: ${(await text(u.page)).slice(0, 600)}`); await shoot(u.page, 's7-priya-page'); }
    await u.ctx.close();
  }
});

test('s8 brain sanity', async () => {
  test.skip(STEP !== 's8'); test.setTimeout(600_000);
  const { page } = omar;
  await page.goto('/t/engineering/bots/brain/chat'); await page.waitForTimeout(3000);
  const before = (await text(page)).length;
  await page.locator('textarea').first().fill('P7 verifier sanity check: in one sentence, what is this team for?');
  await shoot(page, 's8-01-typed', false);
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(3000);
  const t0 = Date.now(); let t = '';
  while (Date.now() - t0 < 270_000) { t = await text(page); if (/Brain.*(Working|Thinking)/i.test(t) === false && t.length > before + 200 && Date.now() - t0 > 20_000) break; await page.waitForTimeout(5000); }
  await shoot(page, 's8-02-answer');
  log(`s8 after ${Math.round((Date.now() - t0) / 1000)}s page tail: ${t.slice(-900)}`);
});

test('endall', async () => {
  test.skip(STEP !== 'endall'); test.setTimeout(120_000);
  const { page } = omar;
  for (const bot of [BOT, 'brain']) {
    const l = await j(page, api(bot));
    for (const x of l.body?.sessions ?? []) { if (x.status === 'ready' || x.status === 'working') { const e = await j(page, `${api(bot)}/${x.id}/end`, { method: 'POST', data: {} }); log(`endall ${bot} ${x.mode} ${x.id} -> ${e.status}`); } }
  }
});

test('cleanup', async () => {
  test.skip(STEP !== 'cleanup'); test.setTimeout(240_000);
  const { page } = omar;
  const open = await j(page, '/api/teams/engineering/proposals?status=open');
  for (const x of open.body?.proposals ?? []) { const p = x.proposal ?? x; if (p.path?.startsWith(`bots/${BOT}/`)) { const w = await j(page, `/api/teams/engineering/proposals/${p.id}/withdraw`, { method: 'POST', data: {} }); log(`cleanup withdraw ${p.path} ${w.status}`); } }
  const del = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${BOT}/BOT.md`, op: 'delete', title: `P7 verifier: remove ${BOT}`, applyNow: true } });
  log(`cleanup delete BOT.md ${del.status} ${del.status >= 400 ? red(del.body, 400) : del.body?.proposal?.proposal?.status}`);
  for (const f of ['lessons.md', 'evals/lessons.yaml']) {
    const r = await j(page, '/api/teams/engineering/proposals', { method: 'POST', data: { path: `bots/${BOT}/${f}`, op: 'delete', title: `P7 verifier: remove ${BOT} ${f}`, applyNow: true } });
    log(`cleanup delete ${f} ${r.status} ${r.status >= 400 ? red(r.body, 300) : r.body?.proposal?.proposal?.status}`);
  }
  await page.waitForTimeout(8000);
  log(`cleanup bots now ${red((await j(page, '/api/teams/engineering/bots')).body.bots.map((b: any) => `${b.slug}:${b.status}`))}`);
  log(`cleanup tree ${red((await j(page, `/api/teams/engineering/repo/tree?path=bots`)).body, 1500)}`);
});
