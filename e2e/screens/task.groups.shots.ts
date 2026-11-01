import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Role tags as @mention groups (P14-03) on the live site, driven as real users in a real browser. Omar (workspace admin) gives Nadia and Rafi the team tag
 * `role:on-call` on Engineering's roster and tries the reserved words admin and here (a plain-words error, nothing written); Nadia types @ in #dev (the
 * picker shows the group row with "Group" and "2 people"), picks it and sends a message (the posted message shows the mention chip); Rafi (a holder) finds
 * the message in his notifications, Omar (not a holder) does not; the picker at 390x844. At the end the assignments and the tag are removed again.
 * Credentials come from the environment only (OMAR/NADIA/RAFI _EMAIL and _PASSWORD; `source ~/manythreads.passwords.env`).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.groups.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/gr-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const CHANNEL = 'dev';
let TAG = 'role:on-call';
let HANDLE = 'on-call';
const MARK = `groups-check-${Date.now().toString(36)}`;

type Who = { email: string; password: string };
type Key = 'NADIA' | 'OMAR' | 'RAFI';
const who = (key: Key): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });

test.beforeAll(() => {
  for (const k of ['NADIA', 'OMAR', 'RAFI'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  }
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];

async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<{ page: Page; context: BrowserContext }> {
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport,
    reducedMotion: 'reduce',
    ...(mobile ? { hasTouch: true, isMobile: true } : {}),
  });
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
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  const style = await page.addStyleTag({ content: '[data-vt-mask]:not([data-testid="presence-dot"]) { visibility: hidden !important; }' });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  await style.evaluate((el) => (el as unknown as Element).remove());
}

const log = (s: string): void => console.log(`[gr] ${s}`);
const noSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: `Message #${CHANNEL}` });
const pickerOf = (page: Page): Locator => page.getByRole('listbox', { name: 'People' });
const groupRow = (page: Page): Locator => pickerOf(page).locator(`[role="option"][data-group="${HANDLE}"]`);
const rowOf = (page: Page, key: Key): Locator => page.locator(`.person-row[data-person="${who(key).email}"]`);

let omar: { page: Page; context: BrowserContext } | undefined;
const assigned: Key[] = [];

async function tagsOf(page: Page): Promise<Array<{ name: string; closedBy?: string | null; mentionable?: boolean }>> {
  const res = await page.request.get(`/api/teams/${TEAM}/tags`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { tags: Array<{ name: string; closedBy?: string | null; mentionable?: boolean }> }).tags;
}
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}

test.afterAll(async () => {
  // belt and braces: whatever the tests left, drop it (the tag stays only if somebody else uses it, and then the API says so)
  if (omar) {
    try {
      const mine = (await tagsOf(omar.page)).find((t) => t.name === TAG);
      if (mine) {
        const res = await omar.page.request.delete(`/api/teams/${TEAM}/tags/${encodeURIComponent(TAG)}`, { headers: await csrf(omar.context) });
        log(`cleanup: DELETE ${TAG} -> ${res.status()}`);
      } else log(`cleanup: ${TAG} is gone`);
    } catch (e) {
      log(`cleanup failed: ${String(e).slice(0, 200)}`);
    }
  }
  await omar?.context.close().catch(() => undefined);
});

test('gr-01 Omar opens the Engineering roster and gives Nadia and Rafi the tag role:on-call', async ({ browser }) => {
  omar = await signIn(browser, who('OMAR'), DESKTOP);
  const { page, context } = omar;
  const existing = (await tagsOf(page)).map((t) => t.name);
  log(`existing team tags: ${existing.join(', ') || '(none)'}`);
  if (existing.includes(TAG)) {
    TAG = 'role:on-call-check';
    HANDLE = 'on-call-check';
  }
  expect(existing).not.toContain(TAG);
  void context;
  await page.goto(`/settings/team/${TEAM}/roster`);
  await expect(rowOf(page, 'NADIA')).toBeVisible(T);
  await expect(rowOf(page, 'RAFI')).toBeVisible(T);
  for (const key of ['NADIA', 'RAFI'] as const) {
    const row = rowOf(page, key);
    await row.locator('.tag-add input').fill(TAG);
    await row.locator('.tag-add button[type="submit"]').click();
    assigned.push(key);
    await expect(row.locator('.tagx', { hasText: TAG })).toBeVisible(T);
  }
  const listed = (await tagsOf(page)).find((t) => t.name === TAG);
  log(`tag listed: ${JSON.stringify(listed)}`);
  expect(listed?.mentionable).toBe(true);
  await shoot(page, 'gr-01-roster-role-tag-assigned');
});

test('gr-02 a reserved word cannot be a tag: the roster says so in plain words and the API answers 400', async () => {
  const { page, context } = omar!;
  const row = rowOf(page, 'OMAR');
  for (const word of ['admin', 'here']) {
    await row.locator('.tag-add input').fill(`role:${word}`);
    await row.locator('.tag-add button[type="submit"]').click();
    const alert = page.locator('[role="alert"]:visible').first();
    await expect(alert).toBeVisible(T);
    const text = (await alert.innerText()).trim();
    log(`UI error for role:${word}: "${text}"`);
    expect(text).toContain('is kept for everyone-style mentions');
    if (word === 'admin') await shoot(page, 'gr-02-reserved-word-refused');
    await expect(row.locator('.tagx', { hasText: `role:${word}` })).toHaveCount(0);
  }
  // the API too (Omar's own person id from the session); a 400 writes nothing
  const me = (await (await page.request.get('/api/session')).json()) as { person: { id: string } };
  for (const word of ['admin', 'here', 'team']) {
    const res = await page.request.put(`/api/teams/${TEAM}/members/${me.person.id}/tags/${encodeURIComponent(`role:${word}`)}`, { headers: await csrf(context) });
    const body = (await res.text()).slice(0, 200);
    log(`API PUT role:${word} -> ${res.status()} ${body}`);
    expect(res.status()).toBe(400);
  }
  const names = (await tagsOf(page)).map((t) => t.name);
  expect(names).not.toContain('role:admin');
  expect(names).not.toContain('role:here');
  expect(names).not.toContain('role:team');
});

test('gr-03 Nadia types @ in #dev: the picker lists the group with a Group badge and "2 people"; picking it and sending shows the mention chip', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page, context } = await signIn(browser, who('NADIA'), DESKTOP);
  try {
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    const box = boxOf(page);
    await expect(box).toBeVisible(T);
    await box.click();
    await box.pressSequentially('@');
    await expect(pickerOf(page)).toBeVisible(T);
    const row = groupRow(page);
    await expect(row).toBeVisible(T);
    await expect(row).toContainText(`@${HANDLE}`);
    const badge = (await row.locator('.pk-badge').innerText()).trim();
    const hint = (await row.locator('.pk-hint').innerText()).trim();
    log(`group row: "${(await row.innerText()).replace(/\s+/g, ' ').trim()}" badge="${badge}" hint="${hint}"`);
    expect(badge).toBe('Group');
    expect(hint).toBe('2 people');
    const kinds = await pickerOf(page).getByRole('option').evaluateAll((els) => els.map((el) => (el.hasAttribute('data-group') ? 'group' : 'person')));
    log(`picker rows in order: ${kinds.join(',')}`);
    for (const closed of ['admin', 'here']) await expect(pickerOf(page).locator(`[role="option"][data-group="${closed}"]`)).toHaveCount(0);
    await shoot(page, 'gr-03-picker-group-row-desktop');

    await box.pressSequentially(HANDLE.slice(0, 4));
    await expect(groupRow(page)).toBeVisible(T);
    await shoot(page, 'gr-04-picker-narrowed-by-typing');
    await groupRow(page).click();
    await expect(box).toHaveValue(`@${HANDLE} `);
    await expect(pickerOf(page)).toHaveCount(0);
    await box.pressSequentially(`team check ${MARK}: please watch the deploy window (a test of group mentions)`);
    await shoot(page, 'gr-05-composer-with-group-picked');
    await page.keyboard.press('Enter');
    const message = page.locator('[data-testid="message"]').filter({ hasText: MARK });
    await expect(message).toHaveCount(1, T);
    const chip = message.locator(`span.m[data-mention="${HANDLE}"]`);
    await expect(chip).toHaveText(`@${HANDLE}`);
    await message.scrollIntoViewIfNeeded();
    await shoot(page, 'gr-06-posted-message-with-group-chip');
  } finally {
    await context.close();
  }
});

test('gr-04 Rafi (a holder) is told: a notification names the message; Omar (not a holder) gets none', async ({ browser }) => {
  test.setTimeout(180_000);
  const rafi = await signIn(browser, who('RAFI'), DESKTOP);
  try {
    const { page } = rafi;
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    await expect(page.locator('[data-testid="message"]').filter({ hasText: MARK })).toHaveCount(1, T);
    await expect.poll(async () => JSON.stringify(await (await page.request.get('/api/notifications')).json()), T).toContain(MARK);
    const bell = page.getByTestId('bell');
    log(`Rafi bell label: ${await bell.getAttribute('aria-label')}`);
    await bell.click();
    const pop = page.getByTestId('notifications-popover');
    await expect(pop).toBeVisible(T);
    const first = pop.getByTestId('notification').filter({ hasText: MARK });
    await expect(first.first()).toBeVisible(T);
    log(`Rafi notification text: "${(await first.first().innerText()).replace(/\s+/g, ' ').trim().slice(0, 200)}" unread=${await first.first().getAttribute('data-unread')}`);
    await shoot(page, 'gr-07-rafi-notification-for-group');
  } finally {
    await rafi.context.close();
  }
  const o = omar!;
  const body = JSON.stringify(await (await o.page.request.get('/api/notifications')).json());
  log(`Omar (non-holder) notifications mention the message: ${body.includes(MARK)}`);
  expect(body).not.toContain(MARK);
  await o.page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  await expect(o.page.locator('[data-testid="message"]').filter({ hasText: MARK })).toHaveCount(1, T);
  await o.page.getByTestId('bell').click();
  await expect(o.page.getByTestId('notifications-popover')).toBeVisible(T);
  await expect(o.page.getByTestId('notification').filter({ hasText: MARK })).toHaveCount(0);
  await shoot(o.page, 'gr-08-omar-non-holder-no-notification');
});

test('gr-05 phone 390x844: the picker with its group row stays inside the screen', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('NADIA'), PHONE, true);
  try {
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    const box = boxOf(page);
    await expect(box).toBeVisible(T);
    await box.click();
    await box.pressSequentially('@');
    const list = pickerOf(page);
    await expect(groupRow(page)).toBeVisible(T);
    const frame = (await list.boundingBox())!;
    log(`phone picker frame: ${JSON.stringify(frame)}`);
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(PHONE.width);
    expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.y + frame.height).toBeLessThanOrEqual(PHONE.height);
    const rows = list.getByRole('option');
    for (let i = 0; i < (await rows.count()); i++) {
      const r = rows.nth(i);
      const rb = (await r.boundingBox())!;
      const label = (await r.innerText()).replace(/\s+/g, ' ').trim();
      expect(rb.x + rb.width, label).toBeLessThanOrEqual(PHONE.width);
      expect(await r.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${label}: row scrolls`).toBe(true);
      for (const part of ['.pk-name', '.pk-badge', '.pk-hint']) {
        const el = r.locator(part);
        if ((await el.count()) === 0) continue;
        expect(await el.first().evaluate((n) => n.scrollWidth <= n.clientWidth + 1), `${label} ${part}: text cut`).toBe(true);
      }
    }
    expect(await noSideways(page)).toBe(true);
    await shoot(page, 'gr-09-picker-group-row-phone-390');
    // leave nothing behind: clear the composer, send nothing
    await box.fill('');
  } finally {
    await context.close();
  }
});

test('gr-06 cleanup: remove the tag from Nadia and Rafi on the roster, then drop the tag itself', async () => {
  const { page, context } = omar!;
  await page.goto(`/settings/team/${TEAM}/roster`);
  for (const key of ['NADIA', 'RAFI'] as const) {
    const row = rowOf(page, key);
    await expect(row).toBeVisible(T);
    await row.locator(`.tagx:has-text("${TAG}") .tag-x`).click();
    await expect(row.locator('.tagx', { hasText: TAG })).toHaveCount(0, T);
  }
  await shoot(page, 'gr-10-roster-after-cleanup');
  const after = (await tagsOf(page)).find((t) => t.name === TAG);
  log(`tag after removing the assignments: ${JSON.stringify(after ?? null)}`);
  if (after) {
    const res = await page.request.delete(`/api/teams/${TEAM}/tags/${encodeURIComponent(TAG)}`, { headers: await csrf(context) });
    log(`DELETE ${TAG} -> ${res.status()}`);
    expect(res.status()).toBeLessThan(300);
  }
  expect((await tagsOf(page)).map((t) => t.name)).not.toContain(TAG);
});

test('gr-07 no page error, no console error over the run', () => {
  expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
  log(`console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 5).join(' | ') : ''}`);
  expect(problems.filter((p) => !/favicon|status of 400/i.test(p)), 'console errors (the two 400s are the reserved words tried on purpose)').toEqual([]);
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
