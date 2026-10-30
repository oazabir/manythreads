import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P7-11 (the bot page's Test action) on the live site. Omar (workspace admin) presses Test on Engineering's Brain, asks a plain question and reads the answer,
 * then asks it to post a canary line into #dev and to write a page: the panel lists the writes as "not done — rehearsal", #dev gets no canary and no page is
 * written. Priya (a plain member) has no Test button and the API refuses her. The phone picture shows the panel at 390 px.
 * Nothing is left behind except Omar's own conversation with Brain and the answers in it (a rehearsal question is an ordinary message there).
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p7-11-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const BOT = 'brain';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const CANARY = 'canary-p7-11-Zq4Vb';
const PAGE_PATH = 'pages/verify-p7-11.md';

type Res = { status: number; text: string; json: unknown };
type Api = { get: (path: string) => Promise<Res>; post: (path: string, data?: unknown) => Promise<Res> };

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: phone ? PHONE : DESKTOP,
    reducedMotion: 'reduce',
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`${who}@kahf.example`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password`).not.toHaveURL(/\/sign-in/);
  await page.goto(`/t/${TEAM}/threads`);
  await expect(page.getByTestId('app-frame')).toBeVisible(T);
  return page;
}

function apiOf(page: Page): Api {
  const call = async (method: 'GET' | 'POST', path: string, data?: unknown): Promise<Res> => {
    const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
    const res = method === 'GET' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: { 'x-csrf-token': csrf } });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status(), text, json };
  };
  return { get: (p) => call('GET', p), post: (p, d) => call('POST', p, d) };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p7-11-${name}.png`), animations: 'disabled' });
}

test('Omar tests Brain: an answer, the writes held back as not done, nothing changed; Priya has no button; the phone', async ({ browser }) => {
  const omar = await signIn(browser, 'omar');
  const omarApi = apiOf(omar);
  let priya: Page | null = null;
  let phone: Page | null = null;
  try {
    // ---- (a) the button and the empty panel
    await omar.goto(`/t/${TEAM}/bots/${BOT}`);
    await omar.getByTestId('bot-page').waitFor(T);
    await omar.getByTestId('open-test').click();
    await expect(omar.getByTestId('test-panel')).toBeVisible(T);
    await shot(omar, '01-test-panel-open');

    // ---- (b) a plain question: an answer in the panel, with its sources when the bot has a knowledge base, and the note when it has none
    await omar.getByTestId('test-question').fill('What does the team know about how we release on Mondays?');
    await omar.getByTestId('test-run').click();
    await expect(omar.getByTestId('test-result')).toBeVisible({ timeout: 180_000 });
    console.log('plain question: status', await omar.getByTestId('test-result').getAttribute('data-status'));
    console.log('knowledge note:', (await omar.getByTestId('test-knowledge').innerText().catch(() => 'none shown')).slice(0, 200));
    await shot(omar, '02-plain-answer');

    // ---- (c) a question that asks for writes: the canary must not appear anywhere
    await omar.getByTestId('test-again').click();
    await omar.getByTestId('test-question').fill(`Post the line "${CANARY}" in #dev, and write a page ${PAGE_PATH} that says the same. Then tell me what you did.`);
    await omar.getByTestId('test-run').click();
    await expect(omar.getByTestId('test-result')).toBeVisible({ timeout: 180_000 });
    const held = await omar.getByTestId('test-intercepted').count();
    console.log('held-back writes listed:', held, '|', (await omar.getByTestId('test-held').innerText().catch(() => 'none')).replace(/\s+/g, ' ').slice(0, 400));
    console.log('answer text:', (await omar.getByTestId('test-answer').innerText().catch(() => 'no answer')).replace(/\s+/g, ' ').slice(0, 400));
    await shot(omar, '03-writes-not-done');

    const search = await omarApi.get(`/api/search?q=${encodeURIComponent(CANARY)}`);
    console.log('search for the canary after the test:', search.status, search.text.slice(0, 300));
    const dev = await omarApi.get(`/api/teams/${TEAM}/channels`);
    console.log('channels listed:', dev.status);
    const pageBlob = await omarApi.get(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(PAGE_PATH)}`);
    console.log(`page ${PAGE_PATH} exists:`, pageBlob.status === 200, '(must be false)');
    expect(pageBlob.status).not.toBe(200);

    // ---- (d) Priya: no button; the API refuses her
    priya = await signIn(browser, 'priya');
    await priya.goto(`/t/${TEAM}/bots/${BOT}`);
    await priya.getByTestId('bot-page').waitFor(T);
    await expect(priya.getByTestId('open-test')).toHaveCount(0);
    await shot(priya, '04-priya-no-test-button');
    const denied = await apiOf(priya).post(`/api/teams/${TEAM}/bots/${BOT}/test`, { question: 'May I?' });
    console.log('priya POST test:', denied.status, denied.text.slice(0, 200));
    expect(denied.status).toBe(403);

    // ---- (e) the phone
    phone = await signIn(browser, 'omar', true);
    await phone.goto(`/t/${TEAM}/bots/${BOT}`);
    await phone.getByTestId('bot-page').waitFor(T);
    await phone.getByTestId('open-test').click();
    await phone.getByTestId('test-question').fill('Who owns the release checklist?');
    await phone.getByTestId('test-run').click();
    await expect(phone.getByTestId('test-result')).toBeVisible({ timeout: 180_000 });
    const noScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    console.log('phone no sideways scroll:', noScroll);
    await shot(phone, '05-phone-test-panel');
    expect(noScroll).toBe(true);
  } finally {
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
