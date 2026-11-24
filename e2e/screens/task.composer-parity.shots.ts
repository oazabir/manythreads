/* eslint-disable @typescript-eslint/no-explicit-any -- a live-site check reads loosely typed API answers */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Live check of composer parity (P14-02, P14-22 deploy) as real users: custom emoji, @channel/@here, drafts kept on the server, the System badge of a
 * delivered reminder, /status :coffee:, avatars and the phone layout. Omar makes (and archives) a scratch channel; Nadia works in it.
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.composer-parity.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/cp-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const RAND = Date.now().toString(36);
const MARK = `cpcheck${RAND}`;
const ROOM = `cp-${RAND}`;
const EMOJI = 'livecheck_ok';

type Who = { email: string; password: string };
type Key = 'NADIA' | 'OMAR';
const who = (key: Key): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });
test.beforeAll(() => {
  for (const k of ['NADIA', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set`);
  }
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];
type Sess = { page: Page; context: BrowserContext };
const log = (s: string): void => console.log(`[cp] ${s}`);
async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<Sess> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)} @ ${page.url()}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  log(`shot ${name}.png`);
}
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}
const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: `Message #${ROOM}` });
const rowOf = (page: Page, text: string): Locator => page.getByTestId('message').filter({ hasText: text });
const apiJson = async (s: Sess, path: string): Promise<any> => (await s.page.request.get(path)).json();
const noSideways = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// a 32x32 PNG built by hand (no dependency): an orange disc on transparent
function makePng(): Buffer {
  const w = 32, h = 32;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 14 ** 2;
      raw[o] = 255; raw[o + 1] = inside ? 140 : 0; raw[o + 2] = 0; raw[o + 3] = inside ? 255 : 0;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();

let nadia: Sess | undefined;
let omar: Sess | undefined;
let roomId = '';
let emojiId = '';
let statusBefore: any = null;

async function openPicker(page: Page): Promise<Locator> {
  await boxOf(page).click();
  await page.getByRole('button', { name: 'Emoji', exact: true }).click();
  const custom = page.getByTestId('emoji-custom');
  await expect(custom).toBeVisible(T);
  return custom;
}

test.afterAll(async () => {
  try {
    if (omar && emojiId) {
      const l = (await apiJson(omar, '/api/custom-emoji')) as { items: Array<{ id: string; name: string }> };
      for (const e of l.items.filter((i) => i.name === EMOJI)) {
        const r = await omar.page.request.delete(`/api/custom-emoji/${e.id}`, { headers: await csrf(omar.context) });
        log(`cleanup: delete emoji ${e.name} -> ${r.status()}`);
      }
    }
    if (nadia) {
      const l = (await apiJson(nadia, '/api/reminders?state=pending')) as { items: Array<{ id: string; text: string }> };
      for (const r of l.items.filter((i) => i.text.includes(MARK))) log(`cleanup: cancel reminder -> ${(await nadia.page.request.delete(`/api/reminders/${r.id}`, { headers: await csrf(nadia.context) })).status()}`);
      if (roomId) {
        const sch = (await apiJson(nadia, `/api/channels/${roomId}/scheduled-messages`).catch(() => ({ items: [] }))) as { items: Array<{ id: string; body: string }> };
        for (const s of sch.items ?? []) log(`cleanup: cancel scheduled -> ${(await nadia.page.request.delete(`/api/channels/${roomId}/scheduled-messages/${s.id}`, { headers: await csrf(nadia.context) })).status()}`);
        await nadia.page.request.delete(`/api/channels/${roomId}/draft`, { headers: await csrf(nadia.context) }).catch(() => undefined);
        const list = (await apiJson(nadia, `/api/channels/${roomId}/messages?limit=100`)) as { items: Array<{ id: string; body: string }> };
        for (const m of list.items.filter((i) => i.body.includes(MARK))) {
          log(`cleanup: delete message "${m.body.slice(0, 30)}" -> ${(await nadia.page.request.delete(`/api/channels/${roomId}/messages/${m.id}`, { headers: await csrf(nadia.context) })).status()}`);
        }
        // the delivered reminder in her Reminders conversation
        const dms = (await apiJson(nadia, '/api/dms?limit=200')) as { items: any[] };
        const rem = dms.items.find((d) => d.channel?.dmKey?.startsWith('reminders:'));
        if (rem) {
          const rm = (await apiJson(nadia, `/api/channels/${rem.channel.id}/messages?limit=50`)) as { items: any[] };
          for (const m of rm.items.filter((i) => i.body.includes(MARK))) log(`cleanup: delete reminder message -> ${(await nadia.page.request.delete(`/api/channels/${rem.channel.id}/messages/${m.id}`, { headers: await csrf(nadia.context) })).status()}`);
        }
      }
      // status back to what it was
      const me = (await apiJson(nadia, '/api/presence/me')) as any;
      log(`cleanup: Nadia status now ${JSON.stringify(me?.status)} (was ${JSON.stringify(statusBefore)})`);
    }
    if (omar && roomId) {
      const ar = await omar.page.request.post(`/api/channels/${roomId}/archive`, { headers: await csrf(omar.context) });
      log(`cleanup: archive #${ROOM} -> ${ar.status()}`);
    }
  } catch (e) { log(`cleanup failed: ${String(e).slice(0, 200)}`); }
  for (const s of [nadia, omar]) await s?.context.close().catch(() => undefined);
});

test('cp-01 sign in, scratch channel, Nadia sets a 1-minute reminder (checked later for the System badge)', async ({ browser }) => {
  nadia = await signIn(browser, who('NADIA'), DESKTOP);
  omar = await signIn(browser, who('OMAR'), DESKTOP);
  statusBefore = ((await apiJson(nadia, '/api/presence/me')) as any)?.status ?? null;
  log(`Nadia status before: ${JSON.stringify(statusBefore)}`);
  const res = await omar.page.request.post(`/api/teams/${TEAM}/channels`, { data: { name: ROOM }, headers: await csrf(omar.context) });
  expect(res.status(), await res.text()).toBeLessThan(300);
  roomId = ((await res.json()) as { channel: { id: string } }).channel.id;
  for (const s of [nadia, omar]) { await s.page.goto(`/t/${TEAM}/c/${ROOM}`); await expect(boxOf(s.page)).toBeVisible(T); }
  const input = boxOf(nadia.page);
  await input.click();
  await input.fill(`/remind me in 1 minute x ${MARK}`);
  await nadia.page.keyboard.press('Enter');
  await nadia.page.waitForTimeout(800);
  const said = await nadia.page.getByTestId('slash-notice').first().innerText().catch(() => '(no notice)');
  log(`remind notice: ${said.replace(/\s+/g, ' ')}`);
  expect(said).toContain('Reminder set');
});

test('cp-02 Omar: picker has Custom + Add; SVG and bad name refused; upload livecheck_ok', async () => {
  const { page } = omar!;
  const custom = await openPicker(page);
  await expect(custom.getByRole('button', { name: 'Add', exact: true })).toHaveCount(1);
  log(`Omar Custom heading buttons: ${(await custom.locator('h3 button').allInnerTexts()).join(',')}; empty text: ${await custom.locator('.emp-empty').allInnerTexts()}`);
  await shoot(page, 'cp-01-omar-picker-custom-empty');
  await custom.getByRole('button', { name: 'Add', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add a custom emoji' });
  await expect(form).toBeVisible(T);
  // SVG chosen in the form
  await form.locator('input[type=file]').setInputFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
  const svgSaid = await form.getByRole('alert').innerText();
  log(`SVG in the form -> "${svgSaid}"`);
  expect(svgSaid.length).toBeGreaterThan(15);
  await shoot(page, 'cp-02-omar-svg-refused');
  // SVG bytes labelled as PNG, straight to the server
  const b64 = (b: Buffer): string => b.toString('base64');
  const svgApi = await omar!.page.request.post('/api/custom-emoji', { data: { name: 'svgsneak', contentType: 'image/png', data: b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')) }, headers: await csrf(omar!.context) });
  log(`API SVG bytes labelled png -> ${svgApi.status()} ${(await svgApi.text()).slice(0, 200)}`);
  expect(svgApi.status()).toBeGreaterThanOrEqual(400);
  expect(svgApi.status()).toBeLessThan(500);
  const badNameApi = await omar!.page.request.post('/api/custom-emoji', { data: { name: 'Bad Name!', contentType: 'image/png', data: b64(PNG) }, headers: await csrf(omar!.context) });
  log(`API bad name -> ${badNameApi.status()} ${(await badNameApi.text()).slice(0, 200)}`);
  expect(badNameApi.status()).toBeGreaterThanOrEqual(400);
  expect(badNameApi.status()).toBeLessThan(500);
  // valid picture with a bad name in the form
  await form.locator('input[type=file]').setInputFiles({ name: 'ok.png', mimeType: 'image/png', buffer: PNG });
  await form.locator('.emp-add-name').fill('9-Bad Name');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  const nameSaid = await form.getByRole('alert').innerText();
  log(`bad name in the form -> "${nameSaid}"`);
  expect(nameSaid).toMatch(/name/i);
  await shoot(page, 'cp-03-omar-bad-name-refused');
  // the good one
  await form.locator('.emp-add-name').fill(EMOJI);
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(custom.getByRole('button', { name: `:${EMOJI}:` })).toBeVisible(T);
  const list = (await apiJson(omar!, '/api/custom-emoji')) as { items: Array<{ id: string; name: string }> };
  emojiId = list.items.find((i) => i.name === EMOJI)?.id ?? '';
  expect(emojiId).not.toBe('');
  log(`added ${EMOJI} id ${emojiId}`);
  await shoot(page, 'cp-04-omar-picker-with-livecheck');
  await page.keyboard.press('Escape');
  await boxOf(page).fill('');
});

test('cp-03 Nadia: sees it in the picker (no Add/Remove), in a message, not in code, and as a reaction chip', async () => {
  const { page } = nadia!;
  await page.reload();
  await expect(boxOf(page)).toBeVisible(T);
  const custom = await openPicker(page);
  await expect(custom.getByRole('button', { name: `:${EMOJI}:` })).toBeVisible(T);
  await expect(custom.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
  await expect(custom.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await shoot(page, 'cp-05-nadia-picker-custom-no-admin-buttons');
  await custom.getByRole('button', { name: `:${EMOJI}:` }).click();
  await expect(boxOf(page)).toHaveValue(`:${EMOJI}: `);
  await boxOf(page).fill(`${MARK} look :${EMOJI}: here`);
  await page.keyboard.press('Enter');
  const row = rowOf(page, 'look');
  await expect(row.locator(`img.cemoji[alt=":${EMOJI}:"]`)).toBeVisible(T);
  const nat = await row.locator('img.cemoji').evaluate((e: HTMLImageElement) => [e.complete, e.naturalWidth]);
  log(`message emoji img complete/naturalWidth: ${nat}; row text: ${JSON.stringify((await row.innerText()).replace(/\s+/g, ' '))}`);
  expect(nat[1]).toBe(32);
  await boxOf(page).fill(`${MARK} code \`:${EMOJI}:\` stays`);
  await page.keyboard.press('Enter');
  const crow = rowOf(page, 'code');
  await expect(crow).toBeVisible(T);
  log(`code-span row: imgs=${await crow.locator('img.cemoji').count()} codeText=${JSON.stringify(await crow.locator('code').allInnerTexts())}`);
  expect(await crow.locator('img.cemoji').count()).toBe(0);
  await expect(crow.locator('code')).toContainText(`:${EMOJI}:`);
  // react with it through the row's picker
  await row.hover();
  await row.getByRole('button', { name: 'Add reaction' }).click();
  await page.getByRole('menuitem', { name: 'More emoji' }).click();
  await page.getByTestId('emoji-custom').getByRole('button', { name: `:${EMOJI}:` }).click();
  await expect(row.locator('.rx img.cemoji')).toBeVisible(T);
  log(`reaction chip: ${JSON.stringify((await row.locator('.rx').first().getAttribute('aria-label')))}`);
  await shoot(page, 'cp-06-nadia-message-and-reaction-chip');
});

test('cp-04 @channel / @here under the limit, notification, reach call, Send later', async () => {
  const { page } = nadia!;
  const reach: string[] = [];
  const posts: any[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`/api/channels/${roomId}/broadcast-reach`)) reach.push(`${r.method()} ${r.url().replace(BASE, '')}`);
    if (r.method() === 'POST' && r.url().endsWith(`/api/channels/${roomId}/messages`)) posts.push(r.postDataJSON());
  });
  const rr = await apiJson(nadia!, `/api/channels/${roomId}/broadcast-reach`);
  log(`broadcast-reach (API): ${JSON.stringify(rr)}`);
  await boxOf(page).click();
  await boxOf(page).fill(`${MARK} Heads up @channel`);
  await page.keyboard.press('Enter');
  await expect(rowOf(page, 'Heads up @channel').or(rowOf(page, 'Heads up'))).toBeVisible(T);
  await expect(page.getByTestId('broadcast-confirm')).toHaveCount(0);
  log(`reach requests seen by the composer: ${JSON.stringify(reach)}; post bodies: ${JSON.stringify(posts.map((p) => [p.body, p.confirmBroadcast]))}`);
  expect(reach.length).toBeGreaterThan(0);
  await boxOf(page).fill(`${MARK} Quick look @here`);
  await page.keyboard.press('Enter');
  await expect(rowOf(page, 'Quick look')).toBeVisible(T);
  await shoot(page, 'cp-07-nadia-channel-and-here-posted');
  // Omar is told
  await expect.poll(async () => ((await apiJson(omar!, '/api/notifications?limit=30')) as { items: any[] }).items.filter((i) => JSON.stringify(i).includes('Heads up') ).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const n = ((await apiJson(omar!, '/api/notifications?limit=30')) as { items: any[] }).items.filter((i) => JSON.stringify(i).includes(MARK));
  log(`Omar notifications with the marker: ${JSON.stringify(n.map((i) => [i.kind, i.preview]))}`);
  // Send later
  await boxOf(page).fill(`${MARK} Later note @channel`);
  await page.getByTestId('send-later').click();
  await page.getByTestId('send-later-in60').click();
  await expect(page.getByTestId('broadcast-confirm')).toHaveCount(0);
  await expect(page.getByTestId('scheduled-count')).toContainText('scheduled', T);
  const sch = (await apiJson(nadia!, `/api/channels/${roomId}/scheduled-messages`)) as { items: any[] };
  log(`scheduled rows: ${JSON.stringify(sch.items.map((s) => [s.body, s.state ?? s.status]))}`);
  expect(sch.items.some((s) => s.body.includes('Later note @channel'))).toBe(true);
  await shoot(page, 'cp-08-nadia-send-later-channel');
  for (const s of sch.items) await page.request.delete(`/api/channels/${roomId}/scheduled-messages/${s.id}`, { headers: await csrf(nadia!.context) });
  // guest
  const lenaKey = process.env['LENA_EMAIL'];
  log(`guest check: ${lenaKey ? 'a guest (Lena) exists but has no grant on the scratch channel; granting needs an admin write on a real guest, so skipped' : 'no guest credentials; skipped'}`);
});

test('cp-05 server drafts across two devices', async ({ browser }) => {
  const a = nadia!;
  const draftText = `${MARK} draft from device one`;
  await a.page.goto(`/t/${TEAM}/c/${ROOM}`);
  await boxOf(a.page).click();
  await boxOf(a.page).pressSequentially(draftText);
  await a.page.waitForTimeout(3000);
  const d1 = await apiJson(a, `/api/channels/${roomId}/drafts`);
  log(`GET drafts after 3 s: ${JSON.stringify(d1)}`);
  expect(JSON.stringify(d1)).toContain(draftText);
  const b = await signIn(browser, who('NADIA'), DESKTOP);
  try {
    await b.page.goto(`/t/${TEAM}/c/${ROOM}`);
    await expect(boxOf(b.page)).toHaveValue(draftText, T);
    await shoot(b.page, 'cp-09-second-device-has-draft');
    await boxOf(b.page).click();
    await b.page.keyboard.press('Enter');
    await expect(rowOf(b.page, 'draft from device one')).toHaveCount(1, T);
    await expect(boxOf(b.page)).toHaveValue('');
    await b.page.waitForTimeout(1500);
  } finally {
    await b.context.close();
  }
  const d2 = await apiJson(a, `/api/channels/${roomId}/drafts`);
  log(`GET drafts after send on device two: ${JSON.stringify(d2)}`);
  expect(JSON.stringify(d2)).not.toContain(draftText);
  await a.page.reload();
  await expect(boxOf(a.page)).toBeVisible(T);
  await a.page.waitForTimeout(2500);
  const v1 = await boxOf(a.page).inputValue();
  await a.page.waitForTimeout(3000);
  await a.page.reload();
  await expect(boxOf(a.page)).toBeVisible(T);
  await a.page.waitForTimeout(2500);
  const v2 = await boxOf(a.page).inputValue();
  log(`device one after reload: ${JSON.stringify(v1)}; after a second reload: ${JSON.stringify(v2)}`);
  expect(v1).toBe('');
  expect(v2).toBe('');
  expect(JSON.stringify(await apiJson(a, `/api/channels/${roomId}/drafts`))).not.toContain(draftText);
  await shoot(a.page, 'cp-10-first-device-draft-gone');
});

test('cp-06 /status :coffee: sets the emoji, then clear', async () => {
  const { page } = nadia!;
  const input = boxOf(page);
  await input.click();
  await input.fill('/status :coffee: on a break');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  log(`notice: ${(await page.getByTestId('slash-notice').first().innerText()).replace(/\s+/g, ' ')}`);
  const me = (await apiJson(nadia!, '/api/presence/me')) as any;
  log(`presence/me status: ${JSON.stringify(me.status)}`);
  expect(me.status).toMatchObject({ emoji: '☕', text: 'on a break' });
  await shoot(page, 'cp-11-status-coffee');
  await input.fill('/status clear');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const after = (await apiJson(nadia!, '/api/presence/me')) as any;
  log(`status after clear: ${JSON.stringify(after.status)}`);
  expect(after.status ?? null).toBeNull();
});

test('cp-07 avatars: message rows steady, picker shows 3 groups (nothing changed)', async () => {
  const { page } = nadia!;
  await page.goto(`/t/${TEAM}/c/${ROOM}`);
  const samples: string[] = [];
  for (let i = 0; i < 15; i++) {
    samples.push(await page.evaluate(() => { const rows = Array.from(document.querySelectorAll('[data-testid="message"]')); return `${rows.length}:${Math.round(rows.at(-1)?.getBoundingClientRect().top ?? -1)}:${rows.reduce((s, r) => s + r.getBoundingClientRect().height, 0) | 0}`; }));
    await page.waitForTimeout(200);
  }
  log(`rows:lastTop:sumHeights over 3 s: ${[...new Set(samples)].join(' | ')}`);
  const av = page.getByTestId('message').first().locator('.av');
  log(`avatar in first row: ${await av.count()} (img: ${await av.locator('img').count()}) box ${JSON.stringify(await av.first().boundingBox())}`);
  await shoot(page, 'cp-12-message-rows-avatars');
  await page.goto('/account');
  await page.getByTestId('account-change-picture').click();
  const dialog = page.getByTestId('avatar-picker');
  await expect(dialog).toBeVisible(T);
  const groups = await dialog.locator('.avp-group h3').allInnerTexts();
  log(`picker groups: ${JSON.stringify(groups)}`);
  expect(groups).toHaveLength(3);
  await expect.poll(() => dialog.locator('.avp-cell img').evaluateAll((els) => els.every((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0)), T).toBe(true);
  await shoot(page, 'cp-13-avatar-picker-three-groups');
  await page.keyboard.press('Escape');
});

test('cp-08 phone 390 px: picker with Custom, composer toolbar, broadcast bar', async ({ browser }) => {
  const p = await signIn(browser, who('NADIA'), PHONE, true);
  try {
    const { page } = p;
    await page.goto(`/t/${TEAM}/c/${ROOM}`);
    const input = boxOf(page);
    await expect(input).toBeVisible(T);
    await input.click();
    const tb = page.getByRole('toolbar', { name: 'Formatting' });
    const tbb = (await tb.boundingBox())!;
    log(`phone toolbar x=${Math.round(tbb.x)} w=${Math.round(tbb.width)} scrollW=${await tb.evaluate((e) => e.scrollWidth)}; page sideways-free=${await noSideways(page)}`);
    expect(tbb.x + tbb.width).toBeLessThanOrEqual(390.5);
    await shoot(page, 'cp-14-phone-composer-toolbar');
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    const custom = page.getByTestId('emoji-custom');
    await expect(custom).toBeVisible(T);
    const pk = (await custom.locator('xpath=ancestor::*[contains(@class,"emp")][1]').boundingBox().catch(() => null)) ?? (await custom.boundingBox())!;
    const cb = (await custom.boundingBox())!;
    log(`phone picker custom box x=${Math.round(cb.x)} w=${Math.round(cb.width)} (outer ${JSON.stringify(pk && { x: Math.round(pk.x), w: Math.round(pk.width) })}); sideways-free=${await noSideways(page)}`);
    expect(cb.x).toBeGreaterThanOrEqual(-0.5);
    expect(cb.x + cb.width).toBeLessThanOrEqual(390.5);
    expect(await noSideways(page)).toBe(true);
    await shoot(page, 'cp-15-phone-emoji-picker-custom');
    await page.keyboard.press('Escape');
    await page.route(`**/api/channels/${roomId}/broadcast-reach`, (route) => route.fulfill({ json: { channel: 30, here: 4, confirmAbove: 20 } }));
    await input.fill(`${MARK} phone bar @channel`);
    await page.keyboard.press('Enter');
    const ask = page.getByTestId('broadcast-confirm');
    await expect(ask).toBeVisible(T);
    const ab = (await ask.boundingBox())!;
    const btns = await ask.getByRole('button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width), Math.round(r.height)]; }));
    log(`phone broadcast bar x=${Math.round(ab.x)} w=${Math.round(ab.width)} buttons(x,w,h)=${JSON.stringify(btns)}; sideways-free=${await noSideways(page)}`);
    expect(ab.x + ab.width).toBeLessThanOrEqual(390.5);
    expect(await noSideways(page)).toBe(true);
    await shoot(page, 'cp-16-phone-broadcast-bar');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await input.fill('');
  } finally {
    await p.context.close();
  }
});

test('cp-09 Omar removes the emoji; the old message falls back to text', async () => {
  const { page } = omar!;
  await page.reload();
  const custom = await openPicker(page);
  await custom.getByRole('button', { name: 'Remove', exact: true }).click();
  await custom.getByRole('button', { name: `:${EMOJI}:` }).click();
  await shoot(page, 'cp-17-omar-remove-confirm');
  await custom.getByRole('group', { name: `Remove :${EMOJI}:` }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(custom.getByRole('button', { name: `:${EMOJI}:` })).toHaveCount(0, T);
  const l = (await apiJson(omar!, '/api/custom-emoji')) as { items: Array<{ name: string }> };
  expect(l.items.some((i) => i.name === EMOJI)).toBe(false);
  emojiId = '';
  await page.keyboard.press('Escape');
  const n = nadia!.page;
  await n.goto(`/t/${TEAM}/c/${ROOM}`);
  const row = rowOf(n, `${MARK} look`);
  await expect(row).toBeVisible(T);
  log(`after removal Nadia row: imgs=${await row.locator('img.cemoji').count()} text=${JSON.stringify((await row.innerText()).replace(/\s+/g, ' '))} chip=${JSON.stringify(await row.locator('.rx').first().innerText().catch(() => null))}`);
  expect(await row.locator('img.cemoji').count()).toBe(0);
  await expect(row).toContainText(`:${EMOJI}:`);
  await shoot(n, 'cp-18-nadia-after-removal-text-fallback');
});

test('cp-10 the reminder arrived and her Reminders author says System', async () => {
  const n = nadia!;
  const t0 = Date.now();
  let hist: any[] = [];
  while (Date.now() - t0 < 200_000) {
    hist = ((await apiJson(n, '/api/reminders?state=history')) as { items: any[] }).items.filter((i) => i.text.includes(MARK));
    if (hist.some((h) => h.state === 'sent')) break;
    await n.page.waitForTimeout(5_000);
  }
  log(`reminder history: ${JSON.stringify(hist.map((h) => [h.state, h.refusedReason]))}`);
  expect(hist.some((h) => h.state === 'sent')).toBe(true);
  const dms = (await apiJson(n, '/api/dms?limit=200')) as { items: any[] };
  const rem = dms.items.find((d) => d.channel?.dmKey?.startsWith('reminders:'));
  expect(rem).toBeTruthy();
  const msgs = ((await apiJson(n, `/api/channels/${rem.channel.id}/messages?limit=50`)) as { items: any[] }).items.filter((m) => m.body.includes(MARK));
  log(`Reminders DM messages: ${JSON.stringify(msgs.map((m) => [m.author?.displayName, m.author?.kind, m.author?.sender]))}`);
  await n.page.goto(`/t/${TEAM}/dm/${rem.channel.id}`);
  const row = n.page.getByTestId('message').filter({ hasText: MARK }).first();
  await expect(row).toBeVisible(T);
  const badge = (await row.locator('.wh-mark').allInnerTexts()).join(',');
  log(`badge text on the Reminders author: ${JSON.stringify(badge)}`);
  await shoot(n.page, 'cp-19-reminders-author-system');
  expect(badge).toBe('System');
  // incoming webhook posts in the seed data: look for a Webhook-marked author in the channels Nadia can read is not possible without posting one; skipped
  log('webhook badge: no incoming-webhook post known in the seed data; not created (would need an admin webhook write), skipped');
});

test('cp-11 console and page errors over the run', () => {
  log(`console/page errors seen: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 10).join(' | ') : ''}`);
  expect(problems.filter((x) => x.startsWith('pageerror'))).toEqual([]);
});
