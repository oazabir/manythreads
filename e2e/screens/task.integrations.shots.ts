/* eslint-disable @typescript-eslint/no-explicit-any -- a live-site check reads loosely typed answers */
import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Live check of P14-14 Integrations on the deployed site (throwaway). Output: <OUT>/itg-*.png. Token is kept in memory only. */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/079ca634-3c90-4571-b318-4602cc3894ca/scratchpad/itg';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[itg] ${s}`);
type Who = { email: string; password: string };
const who = (k: string): Who => ({ email: process.env[`${k}_EMAIL`] ?? '', password: process.env[`${k}_PASSWORD`] ?? '' });
const name = `itg-${Date.now().toString(36)}`;
let room = '';
let token = '';
let otherRoom = '';
const hits: Array<{ headers: Record<string, any>; body: string }> = [];
let receiver: Server;

test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, user: Who, viewport = { width: 1280, height: 900 }): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('response', (r) => { if (r.status() >= 500) log(`SERVER ${r.status()} ${r.request().method()} ${r.url().replace(/\/hooks\/.*/, '/hooks/…')}`); });
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}
async function shoot(page: Page, n: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `itg-${n}.png`), animations: 'disabled' });
  log(`shot itg-${n}.png`);
}
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
}
async function slack(method: string, body: Record<string, unknown>, bearer: string | null = token): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api/slack/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const scroll = async (page: Page, label: string): Promise<void> => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  log(`${label} scrollWidth ${w.sw} vs clientWidth ${w.cw}`);
  expect.soft(w.sw, `${label} sideways scroll`).toBeLessThanOrEqual(w.cw);
};
const dialogBox = async (page: Page, label: string): Promise<void> => {
  const b = await page.getByTestId('webhooks-dialog').boundingBox();
  const vp = page.viewportSize()!;
  log(`${label} dialog box ${JSON.stringify(b)} viewport ${vp.width}x${vp.height}`);
  if (b) expect.soft(b.x + b.width, `${label} dialog right edge`).toBeLessThanOrEqual(vp.width + 1);
};

test.beforeAll(async () => {
  receiver = createServer((req, res) => {
    const ch: Buffer[] = [];
    req.on('data', (c: Buffer) => ch.push(c));
    req.on('end', () => { hits.push({ headers: req.headers, body: Buffer.concat(ch).toString() }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"text":"itg reply from receiver"}'); });
  });
  await new Promise<void>((r) => receiver.listen(9099, '0.0.0.0', r));
});
test.afterAll(async () => { receiver?.closeAllConnections(); await new Promise<void>((r) => receiver?.close(() => r())); });

test('1 member has no button; lead has dialog with three tabs (1280 and 390)', async ({ browser }) => {
  const omar = await signIn(browser, who('OMAR'));
  const h = await csrf(omar.context);
  for (const n of [name, `${name}-b`]) {
    const res = await omar.page.request.post('/api/teams/engineering/channels', { data: { name: n }, headers: h });
    log(`create ${n} -> ${res.status()}`);
    const id = ((await res.json()) as any).channel.id as string;
    if (n === name) room = id; else otherRoom = id;
  }
  const post = await omar.page.request.post(`/api/channels/${room}/messages`, { data: { channelId: room, body: 'Welcome to the scratch room', threadRootId: null }, headers: h });
  log(`welcome post ${post.status()}`);

  const nadia = await signIn(browser, who('NADIA'));
  await nadia.page.request.post(`/api/channels/${room}/join`, { headers: await csrf(nadia.context) });
  await nadia.page.goto(`/t/engineering/c/${name}`);
  await expect(nadia.page.getByText('Welcome to the scratch room')).toBeVisible(T);
  await expect(nadia.page.getByTestId('webhooks-open')).toHaveCount(0);
  log('member: no Integrations button');
  await shoot(nadia.page, '01-member-1280');
  await nadia.context.close();

  await omar.page.goto(`/t/engineering/c/${name}`);
  await omar.page.getByTestId('webhooks-open').click();
  const d = omar.page.getByTestId('webhooks-dialog');
  await expect(d.getByRole('tab')).toHaveText(['Incoming webhooks', 'Outgoing webhooks', 'API tokens']);
  await shoot(omar.page, '02-lead-dialog-1280-incoming');
  await dialogBox(omar.page, '1280');
  await omar.page.keyboard.press('Escape');
  await omar.context.close();

  // 390
  const m = await signIn(browser, who('OMAR'), { width: 390, height: 844 });
  await m.page.goto(`/t/engineering/c/${name}`);
  await expect(m.page.getByText('Welcome to the scratch room')).toBeVisible(T);
  await scroll(m.page, '390 channel');
  await shoot(m.page, '03-lead-channel-390');
  const btn = m.page.getByTestId('webhooks-open');
  log(`390 button visible=${await btn.isVisible()}`);
  await btn.click();
  await expect(m.page.getByTestId('webhooks-dialog').getByRole('tab')).toHaveCount(3);
  await scroll(m.page, '390 dialog incoming');
  await dialogBox(m.page, '390 incoming');
  await shoot(m.page, '04-lead-dialog-390-incoming');
  await m.page.getByTestId('integrations-tab-tokens').click();
  await scroll(m.page, '390 tokens');
  await dialogBox(m.page, '390 tokens');
  await shoot(m.page, '05-dialog-390-tokens');
  await m.page.getByTestId('integrations-tab-outgoing').click();
  await scroll(m.page, '390 outgoing');
  await dialogBox(m.page, '390 outgoing');
  await shoot(m.page, '06-dialog-390-outgoing');
  await m.context.close();
});

test('2 token via UI, Slack API calls', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('OMAR'));
  await page.goto(`/t/engineering/c/${name}`);
  await page.getByTestId('webhooks-open').click();
  await page.getByTestId('integrations-tab-tokens').click();
  await page.getByTestId('token-name').fill('Itg script');
  await page.getByTestId('token-create').click();
  const box = page.getByTestId('token-secret');
  await expect(box).toBeVisible(T);
  token = ((await box.textContent()) ?? '').trim();
  log(`token shape ok=${/^mtat_[A-Za-z0-9_-]{43}$/.test(token)}`);
  const curl = (await page.getByTestId('token-curl').textContent()) ?? '';
  log(`curl sample channel field: ${/channel[^,]{0,80}/.exec(curl.replace(token, '<T>'))?.[0]}`);
  await shoot(page, '07-token-shown-1280');   // note: token visible only in this local screenshot
  await page.getByRole('button', { name: 'I have copied it' }).click();
  await expect(page.getByTestId('token-row')).toContainText('Itg script');
  await shoot(page, '08-token-row-1280');
  await page.keyboard.press('Escape');

  const a = await slack('auth.test', {});
  log(`auth.test ${a.status} ok=${a.json?.ok} keys=${Object.keys(a.json ?? {})}`);
  expect(a.json.ok).toBe(true);
  const p = await slack('chat.postMessage', { channel: room, text: 'hello *bold*' });
  log(`postMessage ${p.status} ok=${p.json?.ok} err=${p.json?.error}`);
  expect(p.json.ok).toBe(true);
  const ts = p.json.ts as string;
  const msg = page.locator('[data-testid="message"]', { hasText: 'hello' });
  await expect(msg).toBeVisible(T);
  log(`bold rendered as <strong>: ${await msg.locator('strong, b').count()}; Webhook mark: ${(await msg.textContent())?.includes('Webhook')}`);
  await shoot(page, '09-posted-message-1280');
  const u = await slack('chat.update', { channel: room, ts, text: 'edited by token' });
  log(`update ${u.status} ok=${u.json?.ok} err=${u.json?.error}`);
  await expect(page.locator('[data-testid="message"]', { hasText: 'edited by token' })).toBeVisible(T);
  const r = await slack('reactions.add', { channel: room, timestamp: ts, name: 'tada' });
  log(`reactions.add ${r.status} ok=${r.json?.ok} err=${r.json?.error}`);
  await expect(page.locator('[data-testid="message"]', { hasText: 'edited by token' })).toContainText('🎉', T);
  await shoot(page, '10-edited-reacted-1280');
  // by name
  const pn = await slack('chat.postMessage', { channel: `#${name}`, text: 'posted by #name' });
  log(`postMessage by #name ${pn.status} ok=${pn.json?.ok} err=${pn.json?.error}`);
  // not scoped channel
  const o = await slack('chat.postMessage', { channel: otherRoom, text: 'should be refused' });
  log(`unscoped channel ${o.status} ok=${o.json?.ok} err=${o.json?.error}`);
  expect(o.json.ok).toBe(false);
  const bad = await slack('auth.test', {}, 'mtat_' + 'x'.repeat(43));
  log(`bad token ${bad.status} ${JSON.stringify(bad.json)}`);
  await context.close();
});

test('3 outgoing webhook to localhost:9099', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('OMAR'));
  await page.goto(`/t/engineering/c/${name}`);
  await page.getByTestId('webhooks-open').click();
  await page.getByTestId('integrations-tab-outgoing').click();
  await page.getByTestId('outgoing-name').fill('Itg hook');
  await page.getByTestId('outgoing-url').fill('http://localhost:9099');
  await page.getByTestId('outgoing-words').fill('itgtrigger');
  await page.getByTestId('outgoing-create').click();
  await page.waitForTimeout(2000);
  const note = await page.getByTestId('outgoing-note').innerText().catch(() => '(no note)');
  const rows = await page.getByTestId('outgoing-row').count();
  log(`outgoing localhost: rows=${rows} note="${note}"`);
  await shoot(page, '11-outgoing-localhost-1280');
  await context.close();
});

test('4 revoke in UI; token refused', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('OMAR'));
  await page.goto(`/t/engineering/c/${name}`);
  await page.getByTestId('webhooks-open').click();
  await page.getByTestId('integrations-tab-tokens').click();
  await expect(page.getByTestId('token-row')).toContainText('calls so far', T);
  await shoot(page, '12-token-used-1280');
  await page.getByTestId('token-revoke').click();
  await shoot(page, '13-revoke-confirm-1280');
  await page.getByTestId('token-revoke-confirm').click();
  await expect(page.getByTestId('tokens-empty')).toBeVisible(T);
  const a = await slack('auth.test', {});
  log(`after revoke auth.test ${a.status} ${JSON.stringify(a.json)}`);
  const p = await slack('chat.postMessage', { channel: room, text: 'after revoke' });
  log(`after revoke post ${p.status} ${JSON.stringify(p.json)}`);
  expect(p.json.ok).toBe(false);
  await context.close();
});

test('5 digest settings announce status and busy', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('OMAR'));
  await page.goto('/account');
  const block = page.getByTestId('notification-digest');
  await expect(block).toBeVisible(T);
  const sw = block.getByRole('switch', { name: 'Send me an email about what I missed' });
  const before = await sw.getAttribute('aria-checked');
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="notification-digest"]')!;
    (window as any).__rec = [];
    const snap = (why: string): void => {
      const sw = el.querySelector('[role=switch]') as HTMLElement | null;
      const st = Array.from(el.querySelectorAll('[role=status],[aria-live]')).map((e) => (e.textContent ?? '').trim());
      (window as any).__rec.push({ why, busy: el.getAttribute('aria-busy') ?? sw?.getAttribute('aria-busy') ?? el.querySelector('[aria-busy]')?.getAttribute('aria-busy'), dis: sw?.hasAttribute('disabled') || sw?.getAttribute('aria-disabled'), st });
    };
    new MutationObserver(() => snap('mut')).observe(el, { subtree: true, attributes: true, childList: true, characterData: true });
    snap('start');
  });
  // slow the save so busy is observable
  await page.route('**/api/notifications/digest', async (route) => { if (route.request().method() !== 'GET') await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
  log(`live regions in block: ${await block.locator('[aria-live],[role=status]').count()}`);
  await sw.click();
  await page.waitForTimeout(400);
  await shoot(page, '14-digest-saving-1280');
  await page.waitForTimeout(2000);
  const rec = await page.evaluate(() => (window as any).__rec);
  const uniq = JSON.stringify(rec.map((r: any) => ({ busy: r.busy, dis: r.dis, st: r.st })).filter((r: any, i: number, a: any[]) => i === 0 || JSON.stringify(r) !== JSON.stringify(a[i - 1])));
  log(`toggle ${before} -> ${await sw.getAttribute('aria-checked')}; state changes: ${uniq}`);
  await shoot(page, '15-digest-saved-1280');
  // restore
  await sw.click();
  await page.waitForTimeout(2500);
  log(`restored to ${await sw.getAttribute('aria-checked')} (was ${before})`);
  await context.close();
});

test('6 cleanup scratch channels', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('OMAR'));
  const h = await csrf(context);
  for (const id of [room, otherRoom]) {
    const r = await page.request.post(`/api/channels/${id}/archive`, { headers: h });
    log(`archive ${id} -> ${r.status()}`);
  }
  await context.close();
});
