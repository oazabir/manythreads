/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live verification of the workspace Brain, second round (P20-LV): a personal routine run to the end (status, output file, notice) and a Chat answer that cites a Personal note, then Regenerate.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts verify-a3
 * Personas sign in through the sign-in form (EMAIL / PASSWORD variables of the environment, never printed). Everything the probe makes (test chats,
 * a test routine) is removed again in the last test.
 */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/verify-a3';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

type Who = 'OMAR' | 'NADIA' | 'SAMEERA' | 'LENA';
type Vp = 'd' | 'm';
type Scheme = 'light' | 'dark';
const VIEW = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } } as const;
const states = new Map<Who, any>();
const findings: string[] = [];
const note = (s: string): void => {
  findings.push(s);
  log(`NOTE ${s}`);
};
const fivexx: string[] = [];

async function signIn(browser: Browser, who: Who): Promise<any> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: VIEW.d, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `sign in ${who}`).not.toHaveURL(/\/sign-in/, T);
  const st = await ctx.storageState();
  await ctx.close();
  return st;
}

async function open(browser: Browser, who: Who, vp: Vp = 'd', scheme: Scheme = 'light'): Promise<{ ctx: BrowserContext; page: Page }> {
  if (!states.has(who)) states.set(who, await signIn(browser, who));
  const ctx = await browser.newContext({
    baseURL: BASE,
    storageState: states.get(who),
    viewport: VIEW[vp],
    colorScheme: scheme,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    isMobile: vp === 'm',
    hasTouch: vp === 'm',
  });
  const page = await ctx.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) {
      fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => note(`PAGEERROR ${e.message.slice(0, 200)}`));
  return { ctx, page };
}

const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(700);
};
/** Screenshot, then flag horizontal scroll and the forbidden old product name in the visible text. */
async function shoot(page: Page, name: string, vp: Vp, scheme: Scheme): Promise<void> {
  await settle(page);
  const file = `${name}.${vp === 'd' ? '1440' : '390'}.${scheme}.png`;
  await page.screenshot({ path: join(OUT, file) });
  const info = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, text: document.body.innerText }));
  if (info.sw > info.cw + 1) note(`${file}: sideways scroll ${info.sw} > ${info.cw}`);
  if (/\u0645\u062c\u0644\u0633/.test(info.text)) note(`${file}: the old product name appears`);
  log(`shot ${file}`);
}
test.afterAll(async () => {
  log(`5xx responses: ${fivexx.length} ${fivexx.slice(0, 10).join(' | ')}`);
  writeFileSync(join(OUT, 'findings.txt'), findings.join('\n') + '\n');
});


const bubbles = (page: Page, role: 'person' | 'bot') => page.locator(`[data-testid="chat-message"][data-role="${role}"]`);
const chatBox = (page: Page) => page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' });
const replies = (page: Page) => page.getByTestId('chat-reply-actions');
const failure = async (page: Page): Promise<string> => (await page.getByTestId('chat-main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(-400);
/** How long the working indicator (Stop button / streaming bubble) stays after the answer's reply actions are shown. */
async function lingering(page: Page, what: string): Promise<void> {
  const t0 = Date.now();
  const stop = page.getByTestId('chat-stop');
  const gone = await stop.waitFor({ state: 'hidden', timeout: 90_000 }).then(() => true, () => false);
  log(`${what}: Stop button ${gone ? `gone after ${Math.round((Date.now() - t0) / 1000)}s` : 'STILL THERE after 90s'}; streaming bubble ${await page.getByTestId('chat-streaming').count()}`);
  if (!gone) note(`Chat: ${what}: the working indicator never went away`);
}
const NOTE_NAME = 'verify-a3-note.md';
/** The CSRF header a change needs (the cookie the sign-in set); a read needs none. */
const csrf = async (ctx: BrowserContext): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => /csrf/i.test(x.name));
  return c ? { 'x-csrf-token': c.value } : {};
};

test('01 Nadia: a routine in words, Run now once, wait for the end, the output file', async ({ browser }) => {
  test.setTimeout(900_000);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/account/routines');
    await page.getByTestId('routine-new').click();
    await page.getByTestId('routine-sentence').fill('Every Monday at 9:00 AM write me one short sentence about the week ahead');
    await page.getByTestId('routine-propose').click();
    const plan = page.getByTestId('dialog-routine-plan');
    const err = page.getByTestId('routine-propose-error');
    await expect(plan.or(err)).toBeVisible({ timeout: 120_000 });
    if (await err.isVisible().catch(() => false)) {
      note(`Routines: proposing failed: ${(await err.innerText()).slice(0, 300)}`);
      await shoot(page, '20-routine-propose-failed', 'd', 'light');
      return;
    }
    log(`plan: ${(await plan.innerText()).replace(/\s+/g, ' ').slice(0, 500)}`);
    await shoot(page, '20-routine-plan', 'd', 'light');
    const routineName = `Verify A3 ${sfx}`;
    await page.getByTestId('routine-name').fill(routineName);
    await page.getByTestId('routine-confirm').click();
    const row = page.locator('[data-testid="routine"]').filter({ hasText: routineName });
    await expect(row).toBeVisible(T);
    await shoot(page, '21-routine-created', 'd', 'light');

    const list = async (): Promise<any[]> => ((await (await ctx.request.get('/api/me/scheduled-jobs')).json()) as any).items;
    const mine = (await list()).find((r) => r.name === routineName);
    expect(mine, 'the routine is in the API list').toBeTruthy();
    log(`routine id ${mine.id}; slug ${mine.slug}; output ${mine.outputPath}; mode ${mine.outputMode}; bot ${mine.botSlug}`);

    await row.getByTestId('routine-run-now').click();
    const t0 = Date.now();
    await page.waitForTimeout(2000);
    await row.getByTestId('routine-toggle-runs').click().catch(() => undefined);
    let run: any = null;
    let last = '';
    for (let i = 0; i < 70; i += 1) {
      const runs = (await (await ctx.request.get(`/api/me/scheduled-jobs/${mine.id}/runs`)).json()) as any;
      const items: any[] = runs.items ?? runs.runs ?? [];
      run = items[0] ?? null;
      const s = run ? `${run.status}` : 'no run yet';
      if (s !== last) log(`+${Math.round((Date.now() - t0) / 1000)}s run status: ${s}`);
      last = s;
      if (run && !/^(queued|running|starting|waiting|pending)$/i.test(run.status)) break;
      await page.waitForTimeout(5000);
    }
    log(`final run: ${JSON.stringify(run)}`);
    await shoot(page, '22-routine-run', 'd', 'light');
    if (!run || run.status !== 'done') note(`Routine run did not finish done: ${JSON.stringify(run)}`);

    // the output file in Personal files
    const outPath: string = run?.outputPath ?? mine.outputPath;
    const folder = outPath.split('/').slice(0, -1).join('/');
    const name = outPath.split('/').pop();
    const tree = await ctx.request.get(`/api/me/files/tree?path=${encodeURIComponent(folder)}`);
    log(`tree ${folder}: ${tree.status()} ${(await tree.text()).slice(0, 400)}`);
    const treeJson = (await tree.json().catch(() => null)) as any;
    const entry = (treeJson?.folder?.entries ?? treeJson?.entries ?? treeJson?.items ?? []).find?.((e: any) => e.name === name);
    if (!entry) note(`Routine output ${outPath} is NOT in Personal files`);
    else {
      const url: string = entry.contentUrl ?? `/api/me/files/${entry.fileId}/versions/current/content`;
      const body = await ctx.request.get(url);
      const text = (await body.text()).slice(0, 600);
      log(`output file ${outPath} (${body.status()}): ${JSON.stringify(text)}`);
      if (text.trim() === '') note(`Routine output ${outPath} is empty`);
    }
    // the DM / notice
    await page.goto('/account/routines');
    await settle(page);
    const rowAgain = page.locator('[data-testid="routine"]').filter({ hasText: routineName });
    log(`routine row: ${(await rowAgain.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)}`);
    await rowAgain.getByTestId('routine-toggle-runs').click().catch(() => undefined);
    await shoot(page, '23-routine-after', 'd', 'light');
    await shoot(page, '23-routine-after', 'd', 'dark');
    const notices = await ctx.request.get('/api/notifications?limit=10').catch(() => null);
    if (notices) log(`notifications: ${notices.status()} ${(await notices.text()).replace(/\s+/g, ' ').slice(0, 600)}`);
  } finally {
    await ctx.close();
  }
});

test('02 Nadia: a new chat that cites a Personal note, then Regenerate', async ({ browser }) => {
  test.setTimeout(900_000);
  const { ctx, page } = await open(browser, 'NADIA');
  let fileId = '';
  try {
    const up = await ctx.request.post(`/api/me/files?folderPath=Notes&name=${NOTE_NAME}&conflict=version`, {
      data: Buffer.from('My favourite colour is teal\n'),
      headers: { 'content-type': 'text/markdown', ...(await csrf(ctx)) },
    });
    log(`note upload: ${up.status()}`);
    if (up.ok()) fileId = ((await up.json()) as any).id ?? '';
    expect(up.ok(), 'note saved').toBe(true);

    await page.goto('/t/engineering/chat?bot=brain');
    await expect(page.getByTestId('chat-screen')).toBeVisible(T);
    // a NEW chat: the chat screen starts empty at /chat?bot=brain, so the first send creates it
    const box = chatBox(page);
    await box.click();
    await box.fill('Verification run: what is in my notes?');
    await box.press('Enter');
    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/, T);
    log(`new chat ${new URL(page.url()).searchParams.get('c')}`);
    const done = await replies(page).last().waitFor({ state: 'visible', timeout: 240_000 }).then(() => true, () => false);
    if (!done) note(`Chat notes: no complete answer in 240 s; screen ends: ${await failure(page)}`);
    const answerText = (await bubbles(page, 'bot').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    log(`notes answer: ${answerText.slice(0, 500)}`);
    log(`reply actions visible; Stop visible right now: ${await page.getByTestId('chat-stop').isVisible().catch(() => false)}`);
    await shoot(page, '30-notes-answered', 'd', 'light');
    await lingering(page, 'notes');
    await shoot(page, '30b-notes-settled', 'd', 'light');
    const cites = await page.getByTestId('citation-personal').count();
    log(`citation-personal chips: ${cites}; mentions teal: ${/teal/i.test(answerText)}`);
    if (cites === 0) note('Chat notes: no citation-personal chip on the answer');
    if (!/teal/i.test(answerText)) note('Chat notes: the answer does not mention teal');
    if (!done) return;

    await page.getByTestId('chat-regenerate').click();
    const pos = page.getByTestId('chat-variant-pos');
    const ok2 = await expect(pos).toHaveText('2 / 2', { timeout: 240_000 }).then(() => true, () => false);
    if (!ok2) note(`Chat: Regenerate did not produce "2 / 2" in 240 s (position says ${await pos.innerText().catch(() => 'none')}); screen ends: ${await failure(page)}`);
    await replies(page).last().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => undefined);
    const second = (await bubbles(page, 'bot').last().innerText().catch(() => '')).replace(/\s+/g, ' ');
    log(`second version: ${second.slice(0, 400)}`);
    await lingering(page, 'regenerated');
    await shoot(page, '31-regenerated', 'd', 'light');
    log(`citation-personal chips after: ${await page.getByTestId('citation-personal').count()}`);
    const prev = page.getByTestId('chat-variant-prev');
    if (await prev.isEnabled().catch(() => false)) {
      await prev.click();
      await page.waitForTimeout(1500);
      log(`after previous: ${await pos.innerText()}`);
      await shoot(page, '32-first-version', 'd', 'light');
    }
  } finally {
    if (fileId) log(`note delete: ${(await ctx.request.delete(`/api/me/files/${fileId}`, { headers: await csrf(ctx) })).status()}`);
    await ctx.close();
  }
});

test('99 cleanup: chats, routines and notes this probe made', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/account/routines');
    await settle(page);
    for (let i = 0; i < 5; i += 1) {
      const row = page.locator('[data-testid="routine"]').filter({ hasText: 'Verify A3 ' }).first();
      if ((await row.count()) === 0) break;
      await row.getByTestId('routine-delete').click();
      await row.getByTestId('routine-delete-yes').click();
      await page.waitForTimeout(1200);
    }
    await page.goto('/t/engineering/chat?bot=brain');
    await settle(page);
    for (let i = 0; i < 10; i += 1) {
      const any = page.getByTestId('chat-row').filter({ hasText: 'Verification run' }).first();
      if ((await any.count()) === 0) break;
      await any.hover();
      await any.getByTestId('chat-row-menu').click();
      await page.getByTestId('chat-menu-delete').click();
      await page.waitForTimeout(1200);
    }
    // deleting a routine leaves its routine.yaml (and any output file) in Personal files: tidy what this probe made there
    const routines = (await (await ctx.request.get('/api/me/files/tree?path=Routines')).json().catch(() => null)) as any;
    for (const f of (routines?.entries ?? []).filter((e: any) => e.kind === 'folder' && /^(verify-a3-|write-me-one-short-sentence)/.test(e.name))) {
      const inner = (await (await ctx.request.get(`/api/me/files/tree?path=${encodeURIComponent(f.path)}`)).json().catch(() => null)) as any;
      for (const e of inner?.entries ?? []) if (e.kind === 'file') await ctx.request.delete(`/api/me/files/${e.fileId}`, { headers: await csrf(ctx) });
      await ctx.request.delete(`/api/me/files/folders?path=${encodeURIComponent(f.path)}`, { headers: await csrf(ctx) });
    }
    const tree = (await (await ctx.request.get('/api/me/files/tree?path=Notes')).json().catch(() => null)) as any;
    for (const e of tree?.folder?.entries ?? []) if (e.name === NOTE_NAME && e.fileId) await ctx.request.delete(`/api/me/files/${e.fileId}`, { headers: await csrf(ctx) });
  } finally {
    await ctx.close();
  }
});
