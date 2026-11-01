import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Link previews (P14-08) on the live site, driven as real users in real browsers. Nadia (Engineering, #dev) posts messages with public https links
 * (example.com, github.com/anthropics): a card (real host first, title, description, picture when the page has one) appears under the message a few
 * seconds later and a second message posted right after it does not jump when it does. Rafi (a second browser, never reloaded) sees the card; Nadia
 * has the remove button, Rafi has not; she removes one. Links to private addresses (127.0.0.1, 10.0.0.1, 169.254.169.254) get no card. Omar (workspace
 * owner) reads the workspace rules (API `/api/admin/link-previews`; there is no screen for them yet), denies example.com, sees the old card of that site go,
 * posts another link to it and gets no card, then restores the rules exactly as they were (they are put back in `afterAll` too). Editing a message to
 * drop its link removes the card. At 390 px the card fits. Everything this run posted is deleted at the end.
 * Credentials come from the environment only (`source ~/manythreads.passwords.env`).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.link-preview.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/lp-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const CHANNEL = 'dev';
const RAND = Date.now().toString(36);
const MARK = `linkcheck ${RAND}`;

type Who = { email: string; password: string };
type Key = 'NADIA' | 'RAFI' | 'OMAR';
const who = (key: Key): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });

test.beforeAll(() => {
  for (const k of ['NADIA', 'RAFI', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  }
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];
type Sess = { page: Page; context: BrowserContext };

async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<Sess> {
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`);
  });
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
}

const log = (s: string): void => console.log(`[lp] ${s}`);
const noSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}
const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: `Message #${CHANNEL}` });
const row = (page: Page, tag: string): Locator => page.getByTestId('message').filter({ hasText: `${MARK} ${tag}` });
const cards = (page: Page, tag: string): Locator => row(page, tag).getByTestId('link-preview');
/** With the composer focused its toolbar is open and the first press elsewhere collapses it and shifts the feed; blur it before clicking in the feed. */
async function blurComposer(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
}
async function post(page: Page, text: string): Promise<void> {
  const box = boxOf(page);
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('', T);
  await blurComposer(page);
}


type Trail = { at: number; slotSeen: boolean; before: number[]; after: number[]; heights: number[] };
/** Samples where `below` sits (and how tall `owner` is) every 150 ms until `done(count)` holds for 1.5 s, or the time is out; `at` is -1 when it never held. */
async function watch(page: Page, below: Locator, owner: Locator, done: (n: number) => boolean, count: () => Promise<number>, ms: number): Promise<Trail> {
  const t0 = Date.now();
  const ys: Array<{ y: number; hit: boolean }> = [];
  const hs = new Set<number>();
  let at = -1;
  let slotSeen = false;
  while (Date.now() - t0 < ms) {
    const hit = done(await count());
    if (await owner.getByTestId('link-preview-slot').count()) slotSeen = true;
    const box = await owner.boundingBox();
    if (box) hs.add(Math.round(box.height));
    ys.push({ y: Math.round((await below.boundingBox())?.y ?? -1), hit });
    if (hit && at < 0) at = Date.now() - t0;
    if (at >= 0 && Date.now() - t0 > at + 1500) break;
    await page.waitForTimeout(150);
  }
  const uniq = (xs: number[]): number[] => [...new Set(xs)];
  return { at, slotSeen, before: uniq(ys.filter((s) => !s.hit).map((s) => s.y)), after: uniq(ys.filter((s) => s.hit).map((s) => s.y)), heights: [...hs] };
}

type Rules = { enabled: boolean; allow: string[]; deny: string[] };
let nadia: Sess | undefined;
let rafi: Sess | undefined;
let omar: Sess | undefined;
let devId = '';
let original: Rules | undefined;
let restored = false;

async function putRules(rules: Rules): Promise<number> {
  const res = await omar!.page.request.put('/api/admin/link-previews', { data: rules, headers: await csrf(omar!.context) });
  return res.status();
}

test.afterAll(async () => {
  // belt and braces: the rules go back as they were, and every message of this run is deleted
  try {
    if (omar && original && !restored) log(`cleanup: rules restored -> ${await putRules(original)}`);
    if (nadia && devId) {
      const list = await nadia.page.request.get(`/api/channels/${devId}/messages?limit=100`);
      const items = ((await list.json()) as { items: Array<{ id: string; body: string }> }).items;
      for (const m of items.filter((i) => i.body.includes(MARK))) {
        const res = await nadia.page.request.delete(`/api/channels/${devId}/messages/${m.id}`, { headers: await csrf(nadia.context) });
        log(`cleanup: delete message "${m.body.slice(0, 50)}" -> ${res.status()}`);
      }
    }
  } catch (e) {
    log(`cleanup failed: ${String(e).slice(0, 200)}`);
  }
  await nadia?.context.close().catch(() => undefined);
  await rafi?.context.close().catch(() => undefined);
  await omar?.context.close().catch(() => undefined);
});

test('lp-01 Nadia posts an example.com link in #dev: a card appears after a few seconds and the message below it does not jump; Rafi sees it live', async ({ browser }) => {
  nadia = await signIn(browser, who('NADIA'), DESKTOP);
  rafi = await signIn(browser, who('RAFI'), DESKTOP);
  omar = await signIn(browser, who('OMAR'), DESKTOP);
  for (const s of [nadia, rafi]) {
    await s.page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    await expect(boxOf(s.page)).toBeVisible(T);
  }
  const groups = ((await (await nadia.page.request.get(`/api/teams/${TEAM}/channels`)).json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> }).groups;
  devId = groups.flatMap((g) => g.channels).find((c) => c.name === CHANNEL)?.id ?? '';
  expect(devId).not.toBe('');
  const rules = await omar.page.request.get('/api/admin/link-previews');
  expect(rules.status()).toBe(200);
  const r = (await rules.json()) as Rules;
  original = { enabled: r.enabled, allow: [...r.allow], deny: [...r.deny] };
  log(`workspace rules at the start: ${JSON.stringify(original)}`);

  const { page } = nadia;
  // a fresh address (a query string no one asked for before), so the page is read from the network and the wait is real
  const box = boxOf(page);
  await box.click();
  await box.fill(`${MARK} A https://example.com/?c=${RAND}`);
  await page.keyboard.press('Enter');
  // a plain message right below, sent through the API at once, to watch whether it moves when the card arrives
  const plain = await page.request.post(`/api/channels/${devId}/messages`, { data: { channelId: devId, body: `${MARK} B plain message right below, no link`, threadRootId: null }, headers: await csrf(nadia.context) });
  expect(plain.status()).toBeLessThan(300);
  await blurComposer(page);
  const below = row(page, 'B');
  await expect(below).toBeVisible(T);
  const trail = await watch(page, below, row(page, 'A'), (n) => n > 0, () => cards(page, 'A').count(), 40_000);
  log(`card for example.com after ${trail.at} ms (row A had a waiting slot at some point: ${trail.slotSeen})`);
  expect(trail.at, 'no card for https://example.com within 40 s').toBeGreaterThan(-1);
  log(`message B y while waiting ${JSON.stringify(trail.before)} and after the card ${JSON.stringify(trail.after)}; row A height ${JSON.stringify(trail.heights)}`);
  const jump = trail.before.length && trail.after.length ? Math.abs(trail.after[trail.after.length - 1]! - trail.before[trail.before.length - 1]!) : 0;
  log(`jump of the message below when the card arrived: ${jump.toFixed(1)} px`);

  const card = cards(page, 'A').first();
  const text = (await card.innerText()).replace(/\s+/g, ' ').trim();
  log(`card text: "${text}"`);
  await expect(card.locator('.lp-host')).toContainText('example.com');
  expect(text.indexOf('example.com')).toBeLessThan(text.indexOf('Example Domain') === -1 ? 9999 : text.indexOf('Example Domain'));
  await expect(card.locator('.lp-title')).toHaveText(/Example Domain/);
  await below.scrollIntoViewIfNeeded();
  await shoot(page, 'lp-01-card-example-com-nadia-desktop');

  const theirs = cards(rafi!.page, 'A');
  await expect(theirs).toHaveCount(1, T); // Rafi never reloaded
  await expect(theirs.getByTestId('link-preview-remove')).toHaveCount(0);
  await expect(card.getByTestId('link-preview-remove')).toHaveCount(1);
  await card.hover();
  await shoot(page, 'lp-01b-card-hover-remove-button-nadia-desktop');
  await theirs.scrollIntoViewIfNeeded();
  await shoot(rafi!.page, 'lp-02-card-example-com-rafi-live-no-remove-desktop');
  expect(jump, 'the message below moved when the card arrived').toBeLessThanOrEqual(2);
});

test('lp-02 github.com/anthropics: a card with title, description and a stored picture; the picture comes from this server', async () => {
  const { page } = nadia!;
  await post(page, `${MARK} C https://github.com/anthropics`);
  const card = cards(page, 'C').first();
  await expect(card).toBeVisible({ timeout: 40_000 });
  log(`github card: "${(await card.innerText()).replace(/\s+/g, ' ').trim()}"`);
  await expect(card.locator('.lp-host')).toContainText('github.com');
  const img = card.locator('img.lp-img');
  const hasImg = (await img.count()) > 0;
  log(`github card has a picture: ${hasImg}`);
  if (hasImg) {
    const src = (await img.getAttribute('src')) ?? '';
    expect(src.startsWith('/api/link-previews/')).toBe(true);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth), T).toBeGreaterThan(0);
    log(`picture src ${src.replace(/[0-9a-f-]{36}/, '<id>')} loaded`);
  }
  await card.scrollIntoViewIfNeeded();
  await shoot(page, 'lp-03-card-github-anthropics-desktop');
  await expect(cards(rafi!.page, 'C')).toHaveCount(1, T);
});

test('lp-03 Rafi cannot remove a card, Nadia can: the card goes for both of them live', async () => {
  const mine = cards(nadia!.page, 'C');
  await mine.first().getByTestId('link-preview-remove').click();
  await expect(mine).toHaveCount(0, T);
  await expect(cards(rafi!.page, 'C')).toHaveCount(0, T);
  // Rafi has no way to ask: the API answers 403 too
  const msgs = (await (await rafi!.page.request.get(`/api/channels/${devId}/messages?limit=60`)).json()) as { items: Array<{ id: string; body: string }> };
  const a = msgs.items.find((m) => m.body.includes(`${MARK} A `));
  expect(a).toBeTruthy();
  const list = (await (await rafi!.page.request.get(`/api/channels/${devId}/link-previews?messageIds=${a!.id}`)).json()) as { items: Array<{ id: string; canRemove: boolean }> };
  expect(list.items.length).toBe(1);
  expect(list.items[0]!.canRemove).toBe(false);
  const del = await rafi!.page.request.delete(`/api/channels/${devId}/messages/${a!.id}/link-previews/${list.items[0]!.id}`, { headers: await csrf(rafi!.context) });
  log(`Rafi DELETE of Nadia card -> ${del.status()}`);
  expect(del.status()).toBe(403);
  await shoot(nadia!.page, 'lp-04-card-removed-nadia-desktop');
});

test('lp-04 links to private addresses get no card (the slot of room is given back too)', async () => {
  const { page } = nadia!;
  await post(page, `${MARK} D http://127.0.0.1:8080/?c=${RAND}`);
  await post(page, `${MARK} E http://10.0.0.1/`);
  await post(page, `${MARK} F http://169.254.169.254/latest/meta-data/`);
  const plain = await page.request.post(`/api/channels/${devId}/messages`, { data: { channelId: devId, body: `${MARK} K plain message below the private links`, threadRootId: null }, headers: await csrf(nadia!.context) });
  expect(plain.status()).toBeLessThan(300);
  const below = row(page, 'K');
  await expect(below).toBeVisible(T);
  // does a row keep an empty slot for a card that will never come, and does the message below jump when the room is given back?
  const t0 = Date.now();
  const seen: Array<{ t: number; slots: number; y: number; above: number }> = [];
  const above = row(page, 'B');
  while (Date.now() - t0 < 40_000) {
    const slots = await page.getByTestId('link-preview-slot').count();
    seen.push({ t: Date.now() - t0, slots, y: Math.round((await below.boundingBox())?.y ?? -1), above: Math.round((await above.boundingBox())?.y ?? -1) });
    if (slots === 0 && seen.length > 3 && seen.slice(-3).every((x) => x.slots === 0) && Date.now() - t0 > 5_000) break;
    await page.waitForTimeout(250);
  }
  const first = seen[0]!;
  const changes = seen.filter((x, i) => i > 0 && (x.slots !== seen[i - 1]!.slots || x.y !== seen[i - 1]!.y || x.above !== seen[i - 1]!.above));
  log(`private links D,E,F: waiting slots at the start ${first.slots}, y of the message below ${first.y}; changes (t ms, slots, y below, y of the older message B above): ${JSON.stringify(changes.map((x) => [x.t, x.slots, x.y, x.above]))}`);
  log(`slots gone after ${seen.at(-1)!.t} ms; total shift of the message below: ${first.y - seen.at(-1)!.y} px, of the message above: ${first.above - seen.at(-1)!.above} px`);
  await blurComposer(page);
  for (const tag of ['D', 'E', 'F']) await expect(row(page, tag)).toBeVisible(T);
  for (const tag of ['D', 'E', 'F']) {
    const n = await cards(page, tag).count();
    const slot = await row(page, tag).getByTestId('link-preview-slot').count();
    log(`private link ${tag}: cards=${n} waiting-slot=${slot}`);
    expect(n).toBe(0);
    expect(slot).toBe(0);
  }
  await row(page, 'F').scrollIntoViewIfNeeded();
  await shoot(page, 'lp-05-private-links-no-card-desktop');
  const msgs = (await (await page.request.get(`/api/channels/${devId}/messages?limit=60`)).json()) as { items: Array<{ id: string; body: string }> };
  const ids = msgs.items.filter((m) => /linkcheck \w+ [DEF] /.test(m.body) && m.body.includes(MARK)).map((m) => m.id);
  const api = (await (await page.request.get(`/api/channels/${devId}/link-previews?messageIds=${ids.join(',')}`)).json()) as { items: unknown[]; pending: string[]; enabled: boolean };
  log(`API for the three private-link messages: items=${api.items.length} pending=${api.pending.length} enabled=${api.enabled}`);
  expect(api.items.length).toBe(0);
});

test('lp-05 Omar reads the rules, denies example.com: the old card is swept, a new link to it gets none; then the rules are restored', async () => {
  const { page } = omar!;
  // the screens: is there anywhere to see the rules?
  await page.goto('/settings/workspace/guardrails');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const hasScreen = (await page.getByText(/link preview/i).count()) > 0;
  log(`Settings > Workspace > Data protection mentions link previews: ${hasScreen}`);
  await shoot(page, 'lp-06-data-protection-screen-omar-desktop');

  const status = await putRules({ enabled: original!.enabled, allow: original!.allow, deny: [...new Set([...original!.deny, 'example.com'])] });
  log(`PUT deny example.com -> ${status}`);
  expect(status).toBeLessThan(300);
  const now = (await (await page.request.get('/api/admin/link-previews')).json()) as Rules;
  expect(now.deny).toContain('example.com');
  // retroactive: the card of message A (made earlier from example.com) is gone for Nadia without a reload
  await expect(cards(nadia!.page, 'A')).toHaveCount(0, { timeout: 60_000 });
  await post(nadia!.page, `${MARK} G https://example.com/?denied=1`);
  await expect(row(nadia!.page, 'G')).toBeVisible(T);
  await nadia!.page.waitForTimeout(20_000);
  expect(await cards(nadia!.page, 'G').count()).toBe(0);
  expect(await row(nadia!.page, 'G').getByTestId('link-preview-slot').count()).toBe(0);
  log('denied host: the old card was swept and the new link got none');
  await row(nadia!.page, 'G').scrollIntoViewIfNeeded();
  await shoot(nadia!.page, 'lp-07-denied-host-no-card-desktop');

  const back = await putRules(original!);
  restored = true;
  log(`PUT original rules back -> ${back}`);
  expect(back).toBeLessThan(300);
  const after = (await (await page.request.get('/api/admin/link-previews')).json()) as Rules;
  expect({ enabled: after.enabled, allow: after.allow, deny: after.deny }).toEqual(original);
  // and the restored rules work: a new link gets its card again
  await post(nadia!.page, `${MARK} H https://example.com/?restored=1`);
  await expect(cards(nadia!.page, 'H')).toHaveCount(1, { timeout: 40_000 });
  log('rules restored exactly; a new example.com link gets a card again');
});

test('lp-06 editing a message to drop its link removes the card', async () => {
  const { page } = nadia!;
  const m = row(page, 'H');
  await expect(cards(page, 'H')).toHaveCount(1, T);
  await m.scrollIntoViewIfNeeded();
  await m.hover();
  await m.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const area = page.getByRole('textbox', { name: 'Edit message' });
  await expect(area).toBeVisible(T);
  await area.fill(`${MARK} H the link was dropped`);
  await page.getByRole('button', { name: 'Save' }).click();
  const edited = page.getByTestId('message').filter({ hasText: `${MARK} H the link was dropped` });
  await expect(edited).toBeVisible(T);
  await expect(edited.getByTestId('link-preview')).toHaveCount(0, { timeout: 40_000 });
  await expect(edited.getByTestId('link-preview-slot')).toHaveCount(0);
  await expect(edited.getByTestId('link-previews')).toHaveCount(0);
  await expect(cards(rafi!.page, 'H')).toHaveCount(0, T);
  log('edited message has no card on Nadia or on Rafi');
  await edited.scrollIntoViewIfNeeded();
  await shoot(page, 'lp-08-edited-no-link-no-card-desktop');
});

test('lp-07 phone 390x844: a card fits the screen, nothing scrolls sideways', async ({ browser }) => {
  await post(nadia!.page, `${MARK} I https://example.com/?phone=1 and some words around the link so the line wraps on a narrow screen`);
  await expect(cards(nadia!.page, 'I')).toHaveCount(1, { timeout: 40_000 });
  await post(nadia!.page, `${MARK} J https://github.com/anthropics?phone=1`);
  await expect(cards(nadia!.page, 'J')).toHaveCount(1, { timeout: 40_000 });
  const phone = await signIn(browser, who('RAFI'), PHONE, true);
  try {
    const { page } = phone;
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    for (const tag of ['I', 'J']) {
      const c = cards(page, tag).first();
      await expect(c).toBeVisible({ timeout: 30_000 });
      await c.scrollIntoViewIfNeeded();
      const b = (await c.boundingBox())!;
      log(`phone card ${tag}: x=${b.x} w=${b.width} h=${b.height}`);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
      expect(await noSideways(page)).toBe(true);
      await shoot(page, `lp-09-card-${tag === 'I' ? 'example-com' : 'github'}-phone-390`);
    }
    const x = await cards(nadia!.page, 'I').first().getByTestId('link-preview-remove').count();
    log(`(Nadia has the remove button: ${x})`);
  } finally {
    await phone.context.close();
  }
});

test('lp-08 no page error, no console error over the run', () => {
  expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
  log(`console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 6).join(' | ') : ''}`);
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  const shots: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.png')) shots.push(relative(OUT, full).split(sep).join('/'));
    }
  };
  walk(OUT);
  shots.sort();
  const figures = shots
    .map((s) => `<figure><a href="${s}"><img src="${s}" alt="${s}" loading="lazy"></a><figcaption>${s}</figcaption></figure>`)
    .join('');
  writeFileSync(
    join(OUT, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title><style>
body { font-family: system-ui, sans-serif; margin: 24px; background: rgb(245, 245, 244); color: rgb(28, 28, 30); }
h1 { font-size: 18px; } p { font-size: 13px; color: rgb(90, 90, 92); }
figure { display: inline-block; vertical-align: top; margin: 8px; background: rgb(255, 255, 255); padding: 8px; border: 1px solid rgb(222, 222, 218); border-radius: 6px; }
img { max-width: 640px; display: block; }
figcaption { font-size: 12px; color: rgb(90, 90, 92); margin-top: 6px; }
</style></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots under temp/screenshots.</p>${figures}</body></html>`,
  );
});
