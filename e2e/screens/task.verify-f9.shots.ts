/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of feature 9 (P14-16 on-device speech, P14-17 voice messages), real engine (no FAKE_ASR on the live build).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-f9 --retries=0 --timeout=120000
 * Signs in through the form (env vars, never printed). It makes ONE throwaway private channel (Omar the only member) and archives it at the end;
 * its voice messages are deleted. Chromium gets a fake microphone that plays e2e/fixtures/speech/hello.wav (synthetic, not speech).
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/f9';
const TEAM = process.env['TEAM'] ?? 'engineering';
const WAV = fileURLToPath(new URL('../fixtures/speech/hello.wav', import.meta.url));
const CHAN = 'f9-voice-verify';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.use({ launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`] } });

const hosts = new Map<string, number>();
const modelReqs: string[] = [];
const violations: string[] = [];
const watch = (ctx: BrowserContext, tag: string): void => {
  ctx.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    const key = `${u.host}`;
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
    const body = r.postDataBuffer();
    if (u.host !== new URL(BASE).host) log(`FOREIGN HOST ${tag} ${r.method()} ${r.url()} body=${body?.length ?? 0}`);
    if (u.pathname.startsWith('/models/')) modelReqs.push(`${tag} ${r.method()} ${u.pathname.split('/').slice(-2).join('/')}`);
  });
  ctx.on('response', (r) => {
    if (r.status() >= 500) log(`SERVER ${r.status()} ${r.url()}`);
    if (new URL(r.url()).pathname.startsWith('/models/')) log(`model ${tag} ${r.status()} fromSW=${r.fromServiceWorker()} ${new URL(r.url()).pathname.split('/').slice(-1)[0]} len=${r.headers()['content-length'] ?? '?'}`);
  });
};
const wirePage = (page: Page, tag: string): void => {
  page.on('pageerror', (e) => log(`PAGEERROR ${tag} ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (/content security policy|refused to|violates/i.test(t)) { violations.push(`${tag} ${t.slice(0, 200)}`); log(`CSP-CONSOLE ${tag} ${t.slice(0, 200)}`); }
    else if (m.type() === 'error') log(`console.error ${tag} ${t.slice(0, 160)}`);
  });
  page.on('worker', (w) => log(`worker started ${tag} ${w.url().slice(0, 80)}`));
};
async function login(browser: Browser, who: string, w: number, h: number, mobile = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce', permissions: ['microphone'],
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  watch(ctx, `${w}`);
  const page = await ctx.newPage();
  wirePage(page, `${w}`);
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => console.log(`CSP-violation ${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
  return { ctx, page };
}
const shoot = async (page: Page, n: string): Promise<void> => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${n}.png`) });
  log(`shot ${n}`);
};
const csrf = async (ctx: BrowserContext): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
let omar: { ctx: BrowserContext; page: Page };
const api = async (method: string, path: string, data?: unknown): Promise<any> => {
  const r = await omar.page.request.fetch(path, { method, headers: await csrf(omar.ctx), ...(data === undefined ? {} : { data }) });
  const body = await r.json().catch(() => null);
  return { status: r.status(), body };
};
let channelId = '';
const dirOf = async (): Promise<any[]> => (await api('GET', `/api/teams/${TEAM}/channels`)).body.groups.flatMap((g: any) => g.channels);

test('1 headers and CSP on app pages', async ({ browser }) => {
  // headers of a page (browser view)
  omar = await login(browser, 'OMAR', 1440, 900);
  const r = await omar.page.request.get('/');
  log(`/ headers: csp has wasm-unsafe-eval=${/'wasm-unsafe-eval'/.test(r.headers()['content-security-policy'] ?? '')}; permissions-policy=${r.headers()['permissions-policy']}`);
  // create/find the throwaway channel
  const ch = (await dirOf()).find((c) => c.name.replace(/^#/, '') === CHAN);
  if (!ch) {
    const c = await api('POST', `/api/teams/${TEAM}/channels`, { name: CHAN, purpose: 'Throwaway live check of voice messages (archived afterwards)', private: true });
    log(`create channel ${c.status}`);
    channelId = c.body.channel.id;
  } else {
    channelId = ch.id;
    log(`channel exists ${channelId}`);
  }
  // pages
  for (const [n, p] of [['channel', `/t/${TEAM}/c/${CHAN}`], ['boards', `/t/${TEAM}/boards`], ['search', `/t/${TEAM}/search?q=release`], ['threads', `/t/${TEAM}/threads`]] as const) {
    await omar.page.goto(p);
    await omar.page.waitForTimeout(2500);
    log(`page ${n} loaded: ${omar.page.url()}`);
    await shoot(omar.page, `01-${n}-1440`);
  }
  // sign-in page anonymous
  const anon = await browser.newContext({ baseURL: BASE });
  const ap = await anon.newPage();
  wirePage(ap, 'anon');
  await ap.goto('/sign-in');
  await ap.waitForTimeout(1500);
  await ap.screenshot({ path: join(OUT, '01-signin-1440.png') });
  await anon.close();
  log(`CSP violations so far: ${violations.length}`);
});

const hasPlayableState = async (page: Page): Promise<string> => (await page.getByTestId('voice-transcript-live').textContent().catch(() => '')) ?? '';

async function recordAndWatch(page: Page, label: string, seconds: number, shotPrefix: string | null): Promise<{ readyMs: number | null; text: string; lang: string; timeline: string[] }> {
  const mic = page.getByTestId('voice-mic');
  await mic.click();
  await expect(page.getByTestId('voice-recording')).toBeVisible();
  if (shotPrefix) await shoot(page, `${shotPrefix}-recording`);
  await page.waitForTimeout(seconds * 1000);
  const t0 = Date.now();
  await mic.click();
  await expect(page.getByTestId('voice-preview')).toBeVisible();
  const timeline: string[] = [];
  let last = '';
  let shotWorking = false;
  let readyMs: number | null = null;
  while (Date.now() - t0 < 100_000) {
    const working = await page.getByTestId('voice-transcript-working').count();
    const prog = working ? ((await page.getByTestId('voice-transcript-progress').textContent().catch(() => '')) ?? '') : '';
    const ready = await page.getByTestId('voice-transcript-text').count();
    const none = await page.getByTestId('voice-transcript-none').count();
    const s = ready ? 'READY' : none ? 'NONE' : working ? `WORKING ${prog}` : 'wait';
    if (s !== last) { timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`); last = s; }
    if (working && shotPrefix && !shotWorking) { shotWorking = true; await shoot(page, `${shotPrefix}-working`); }
    if (ready || none) { readyMs = Date.now() - t0; break; }
    await page.waitForTimeout(150);
  }
  const text = await page.getByTestId('voice-transcript-text').inputValue().catch(() => '');
  const lang = (await page.getByTestId('voice-transcript-language').textContent().catch(() => '')) ?? '';
  log(`${label}: ready after ${readyMs === null ? 'TIMEOUT' : (readyMs / 1000).toFixed(1) + ' s'}; transcript=${JSON.stringify(text)} lang="${lang}" live="${await hasPlayableState(page)}"`);
  log(`${label}: timeline ${timeline.join(' | ')}`);
  if (shotPrefix) await shoot(page, `${shotPrefix}-preview`);
  return { readyMs, text, lang, timeline };
}

test('2 desktop: real engine, first use, send, player, search', async () => {
  const { page, ctx } = omar;
  // an empty box shows the mic
  await page.goto(`/t/${TEAM}/c/${CHAN}`);
  await page.waitForTimeout(2000);
  const mic = page.getByTestId('voice-mic');
  await expect(mic).toBeVisible();
  const mb = await mic.boundingBox();
  log(`1440 mic button ${Math.round(mb!.width)}x${Math.round(mb!.height)} name="${await mic.getAttribute('aria-label')}"`);
  await shoot(page, '02-mic-empty-1440');
  log(`SW before: ${JSON.stringify(await page.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: await caches.keys() })))}`);

  // run 1: first use, real model
  const r1 = await recordAndWatch(page, 'run1 (cold, 3s)', 3, '03-run1-1440');
  log(`SW after run1: ${JSON.stringify(await page.evaluate(async () => { const ks = await caches.keys(); const out: Record<string, number> = {}; for (const k of ks) out[k] = (await (await caches.open(k)).keys()).length; return { regs: (await navigator.serviceWorker.getRegistrations()).length, caches: out }; }))}`);
  log(`model requests so far: ${modelReqs.length}`);
  // correct the words (the fixture is not speech) and send
  const box = page.getByTestId('voice-transcript-text');
  if (await box.count()) {
    const unique = 'quokkaverify';
    const base = await box.inputValue();
    await box.fill(`${base ? base + ' ' : ''}${unique} live check of voice messages`);
  }
  await page.getByTestId('voice-send').click();
  const row = page.locator('[data-testid="voice-player"]').last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await shoot(page, '04-sent-1440');
  log(`player name="${await row.getAttribute('aria-label')}" state=${await row.getAttribute('data-state')}`);
  const msg = page.locator('[data-testid="voice-player"]').last().locator('xpath=ancestor::*[contains(@class,"msg")][1]');
  log(`row note: ${JSON.stringify(await msg.getByTestId('voice-note').textContent().catch(() => null))}; text: ${JSON.stringify((await msg.locator('.txt').textContent().catch(() => ''))?.slice(0, 120))}`);

  // play / seek / speed
  await page.getByTestId('voice-play').last().click();
  await page.waitForTimeout(1500);
  log(`after play state=${await row.getAttribute('data-state')} pos=${await page.getByTestId('voice-seek').last().getAttribute('aria-valuenow')} text=${await page.getByTestId('voice-seek').last().getAttribute('aria-valuetext')}`);
  await shoot(page, '05-playing-1440');
  await page.getByTestId('voice-speed').last().click();
  log(`speed label ${await page.getByTestId('voice-speed').last().getAttribute('aria-label')}`);
  await page.getByTestId('voice-play').last().click();
  const seek = page.getByTestId('voice-seek').last();
  await seek.focus();
  await page.keyboard.press('Home');
  const home = await seek.getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowRight');
  const right = await seek.getAttribute('aria-valuenow');
  await page.keyboard.press('End');
  const end = await seek.getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowLeft');
  const left = await seek.getAttribute('aria-valuenow');
  log(`seek by keyboard: Home=${home} Right=${right} End=${end} Left=${left} valuetext="${await seek.getAttribute('aria-valuetext')}"`);
  await shoot(page, '06-seek-1440');

  // run 2: same page; service worker should serve the model
  modelReqs.length = 0;
  const r2 = await recordAndWatch(page, 'run2 (warm page, 3s)', 3, '07-run2-1440');
  log(`run2 model requests: ${modelReqs.length} ${modelReqs.slice(0, 8).join('; ')}`);
  await page.getByTestId('voice-discard').click();

  // run 3: fresh page in same context (worker is new, cache from SW), send without waiting
  const p3 = await ctx.newPage();
  wirePage(p3, 'p3');
  modelReqs.length = 0;
  await p3.goto(`/t/${TEAM}/c/${CHAN}`);
  await p3.waitForTimeout(2000);
  await p3.getByTestId('voice-mic').click();
  await p3.waitForTimeout(2500);
  await p3.getByTestId('voice-mic').click();
  const sn = p3.getByTestId('voice-send-now');
  let usedNow = false;
  try { await sn.waitFor({ state: 'visible', timeout: 4000 }); await shoot(p3, '08-send-now-visible-1440'); await sn.click(); usedNow = true; } catch { log('send-without-waiting: button not visible in time'); }
  if (usedNow) {
    await expect(p3.getByTestId('voice-no-transcript').last().or(p3.getByTestId('voice-player').last())).toBeVisible({ timeout: 20_000 });
    await shoot(p3, '09-sent-without-waiting-1440');
    log(`send-without-waiting: "No transcript" shown=${await p3.getByTestId('voice-no-transcript').count()}`);
    await p3.waitForTimeout(25_000);
    await shoot(p3, '10-after-late-transcript-1440');
    log(`send-without-waiting later: no-transcript count=${await p3.getByTestId('voice-no-transcript').count()} (late transcript from the page's engine, if still on the page)`);
  } else {
    await p3.getByTestId('voice-discard').click().catch(() => undefined);
  }
  log(`run3 model requests: ${modelReqs.length}`);
  await p3.close();

  // search
  await page.goto(`/t/${TEAM}/search?q=quokkaverify`);
  await page.waitForTimeout(3000);
  log(`search hits: ${await page.getByTestId('search-hit').count()}; text: ${JSON.stringify((await page.getByTestId('search-hit').first().innerText().catch(() => 'none')).replace(/\s+/g, ' ').slice(0, 200))}`);
  await shoot(page, '11-search-1440');
  void r1; void r2;
});

test('3 phone 390: mic 44px, record, preview, send, search', async ({ browser }) => {
  const { ctx, page } = await login(browser, 'OMAR', 390, 844, true);
  try {
    await page.goto(`/t/${TEAM}/c/${CHAN}`);
    await page.waitForTimeout(2500);
    const mic = page.getByTestId('voice-mic');
    await expect(mic).toBeVisible();
    const mb = await mic.boundingBox();
    log(`390 mic button ${Math.round(mb!.width)}x${Math.round(mb!.height)}`);
    await shoot(page, '12-mic-empty-390');
    const r = await recordAndWatch(page, 'phone run (fresh context, cold)', 3, '13-phone-390');
    void r;
    const box = page.getByTestId('voice-transcript-text');
    if (await box.count()) await box.fill('quokkaphone check from the phone width');
    await page.getByTestId('voice-send').or(page.getByTestId('voice-send-now')).first().click();
    await expect(page.getByTestId('voice-player').last()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    await shoot(page, '14-sent-390');
    await page.getByTestId('voice-play').last().click();
    await page.waitForTimeout(1200);
    await shoot(page, '15-playing-390');
    log(`390 play state ${await page.getByTestId('voice-player').last().getAttribute('data-state')}`);
    await page.goto(`/t/${TEAM}/search?q=quokkaphone`);
    await page.waitForTimeout(3000);
    log(`390 search hits ${await page.getByTestId('search-hit').count()}`);
    await shoot(page, '16-search-390');
  } finally {
    await ctx.close();
  }
});

test('4 /dev/speech bench', async () => {
  const { page } = omar;
  await page.goto('/dev/speech');
  await page.waitForTimeout(1500);
  await page.getByTestId('speech-device').click();
  await page.waitForTimeout(1000);
  log(`device facts: ${JSON.stringify((await page.getByTestId('speech-facts').innerText()).replace(/\s+/g, ' ').slice(0, 400))}`);
  await shoot(page, '17-dev-speech-1440');
  await page.getByTestId('speech-file').setInputFiles(WAV);
  await page.getByTestId('speech-run').click();
  const t0 = Date.now();
  for (let i = 0; i < 100; i++) {
    const rows = await page.getByTestId('speech-row').count();
    const st = await page.getByTestId('speech-status').innerText();
    if (i % 10 === 0) log(`bench ${((Date.now() - t0) / 1000).toFixed(0)}s rows=${rows} status="${st}"`);
    if (rows >= 4 && !/\.\.\.|…$/.test(st)) break;
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(1000);
  log(`bench table: ${JSON.stringify((await page.getByTestId('speech-results').innerText()).replace(/\s+/g, ' ').slice(0, 1500))}`);
  await shoot(page, '18-dev-speech-results-1440');
  await page.screenshot({ path: join(OUT, '18b-dev-speech-full-1440.png'), fullPage: true });
});

test('5 cleanup', async () => {
  const items = (await api('GET', `/api/channels/${channelId}/messages?limit=100`)).body?.items ?? [];
  for (const m of items) log(`delete message ${m.id.slice(0, 8)} -> ${(await api('DELETE', `/api/channels/${channelId}/messages/${m.id}`)).status}`);
  log(`archive channel -> ${(await api('POST', `/api/channels/${channelId}/archive`)).status}`);
  log(`hosts contacted: ${JSON.stringify([...hosts.entries()])}`);
  log(`CSP violations total: ${violations.length} ${violations.join(' || ')}`);
});
