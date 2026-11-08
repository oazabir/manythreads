/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live verification of the workspace Brain (P20-LV): Chat answers, Stop, Regenerate, notes, a routine and its Run now, the Brain settings page.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts verify-a2
 * Personas sign in through the sign-in form (EMAIL / PASSWORD variables of the environment, never printed). Everything the probe makes (test chats,
 * a test routine) is removed again in the last test.
 */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/verify-a2';
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

const chatRoots: string[] = [];
const bubbles = (page: Page, role: 'person' | 'bot') => page.locator(`[data-testid="chat-message"][data-role="${role}"]`);
const chatBox = (page: Page) => page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' });
const replies = (page: Page) => page.getByTestId('chat-reply-actions');
const failure = async (page: Page): Promise<string> => (await page.getByTestId('chat-main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(-400);

test('01 Nadia: Chat - hello, Stop on a long answer, Regenerate, notes', async ({ browser }) => {
  test.setTimeout(900_000);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/t/engineering/chat?bot=brain');
    await expect(page.getByTestId('chat-screen')).toBeVisible(T);
    const box = chatBox(page);
    await box.click();
    await box.fill('Verification run, hello, what can you do?');
    await box.press('Enter');
    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/, T);
    chatRoots.push(new URL(page.url()).searchParams.get('c') ?? '');
    const streamed = await page.getByTestId('chat-streaming').or(page.getByTestId('chat-stop')).isVisible({ timeout: 60_000 }).catch(() => false);
    log(`hello: streaming seen ${streamed}`);
    await shoot(page, '10-hello-sent', 'd', 'light');
    const answered = await replies(page).last().waitFor({ state: 'visible', timeout: 150_000 }).then(() => true, () => false);
    log(`hello: answered ${answered}; bot bubbles ${await bubbles(page, 'bot').count()}`);
    if (!answered) note(`Chat hello: no answer with reply actions in 150 s; screen ends: ${await failure(page)}`);
    else log(`hello answer: ${(await bubbles(page, 'bot').last().innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
    await shoot(page, '11-hello-answered', 'd', 'light');
    await shoot(page, '11-hello-answered', 'd', 'dark');
    if (!answered) return;

    // a long answer, Stop
    await box.click();
    await box.fill('Verification run, please ignore: write a long, detailed essay of at least 700 words on the history of tea, in eight paragraphs. Do not use any tools.');
    await box.press('Enter');
    const stop = page.getByTestId('chat-stop');
    const sawStop = await stop.waitFor({ state: 'visible', timeout: 90_000 }).then(() => true, () => false);
    await page.waitForTimeout(4000);
    await shoot(page, '12-long-streaming', 'd', 'light');
    if (sawStop) {
      await stop.click();
      await expect(page.getByTestId('chat-stopped')).toBeVisible({ timeout: 40_000 }).catch(() => note('Chat: after Stop, "You stopped this answer." did not appear within 40 s'));
      await shoot(page, '13-stopped', 'd', 'light');
    } else {
      note('Chat: no Stop button on the long answer (finished first or never started)');
      await replies(page).last().waitFor({ state: 'visible', timeout: 150_000 }).catch(() => undefined);
    }

    // notes
    await box.click();
    await box.fill('Verification run: what is in my notes?');
    await box.press('Enter');
    const notes = await replies(page).last().waitFor({ state: 'visible', timeout: 180_000 }).then(() => true, () => false);
    if (!notes) note(`Chat notes: no answer in 180 s; screen ends: ${await failure(page)}`);
    else log(`notes answer: ${(await bubbles(page, 'bot').last().innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
    await shoot(page, '14-notes-answered', 'd', 'light');

    // regenerate the last answer
    const regen = page.getByTestId('chat-regenerate');
    if (await regen.isVisible().catch(() => false)) {
      await regen.click();
      await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2', { timeout: 180_000 }).catch(() => note('Chat: Regenerate did not produce "2 / 2" within 180 s'));
      await shoot(page, '15-regenerated', 'd', 'light');
    } else note('Chat: no Regenerate button on the last answer');
  } finally {
    await ctx.close();
  }
});

let routineName = '';
test('02 Nadia: a routine in words, Run now, the output file', async ({ browser }) => {
  test.setTimeout(600_000);
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
    routineName = `Verify A2 ${sfx}`;
    await page.getByTestId('routine-name').fill(routineName);
    await page.getByTestId('routine-confirm').click();
    const row = page.locator('[data-testid="routine"]').filter({ hasText: routineName });
    await expect(row).toBeVisible(T);
    await shoot(page, '21-routine-created', 'd', 'light');
    await row.getByTestId('routine-run-now').click();
    await page.waitForTimeout(2000);
    await row.getByTestId('routine-toggle-runs').click().catch(() => undefined);
    let status = '';
    for (let i = 0; i < 40; i += 1) {
      status = (await row.getByTestId('routine-run-status').first().innerText({ timeout: 1500 }).catch(() => '')).trim();
      if (status && !/running|starting|queued|waiting/i.test(status)) break;
      await page.waitForTimeout(5000);
    }
    log(`routine run status: ${status}; row: ${(await row.innerText()).replace(/\s+/g, ' ').slice(0, 500)}`);
    if (!/done|ok|complete|finished|success|ready/i.test(status)) note(`Routine run did not complete: ${status}`);
    await shoot(page, '22-routine-run', 'd', 'light');
    await shoot(page, '22-routine-run', 'd', 'dark');
  } finally {
    await ctx.close();
  }
});

test('03 Omar: Brain settings page', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'OMAR');
  try {
    await page.goto('/settings/workspace/brain');
    await settle(page);
    log(`brain settings: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 500)}`);
    await shoot(page, '30-brain-settings', 'd', 'light');
  } finally {
    await ctx.close();
  }
});

test('99 cleanup: chats and the routine this probe made', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/account/routines');
    await settle(page);
    for (let i = 0; i < 5; i += 1) {
      const row = page.locator('[data-testid="routine"]').filter({ hasText: 'Verify A2 ' }).first();
      if ((await row.count()) === 0) break;
      await row.getByTestId('routine-delete').click();
      await row.getByTestId('routine-delete-yes').click();
      await page.waitForTimeout(1200);
    }
    await page.goto('/t/engineering/chat?bot=brain');
    await settle(page);
    // only chats this probe made (their first words are "Verification run"), found in the rail, never another of the person's chats
    for (let i = 0; i < 10; i += 1) {
      const any = page.getByTestId('chat-row').filter({ hasText: 'Verification run' }).first();
      if ((await any.count()) === 0) break;
      await any.hover();
      await any.getByTestId('chat-row-menu').click();
      await page.getByTestId('chat-menu-delete').click();
      await page.waitForTimeout(1200);
    }
  } finally {
    await ctx.close();
  }
});
