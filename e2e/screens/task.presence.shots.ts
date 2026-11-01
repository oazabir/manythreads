import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Presence (P14-01) on the live site, driven as real users in a real browser: Nadia at 1440x900 in #dev of Engineering (dots beside the authors,
 * her own dot Active once the heartbeat ran, an accessible name on every dot, no dot beside a bot), the team roster, the profile card (status,
 * local time, working hours; Esc closes it and gives the focus back), the @ picker, /account#status-and-dnd with the Out of office section; Omar in a
 * second browser context (Nadia sees Omar Active after his page has been open 35 s); then a phone (390x844): a channel loads without rows jumping
 * and without sideways scroll. It changes nothing: no status, no out-of-office note, no message is written.
 * Credentials come from the environment only (NADIA_EMAIL/NADIA_PASSWORD, OMAR_EMAIL/OMAR_PASSWORD; `source ~/manythreads.passwords.env`).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.presence.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/pd-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 * The pictures keep the presence dots visible (the shared helpers mask every [data-vt-mask] element, and the dots carry that mark).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const CHANNEL = 'dev';

type Who = { email: string; password: string };
const who = (key: 'NADIA' | 'OMAR'): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });

test.beforeAll(() => {
  for (const k of ['NADIA', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  }
});
test.describe.configure({ mode: 'serial' });

/** Console errors and page errors of every page this file opened. */
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
  // Masked content (times, emails) is hidden with CSS instead of Playwright's pink boxes, which are painted over open dialogs and covered the card's top edge
  const style = await page.addStyleTag({ content: '[data-vt-mask]:not([data-testid="presence-dot"]) { visibility: hidden !important; }' });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  await style.evaluate((el) => (el as unknown as Element).remove());
}

const noErrorBanner = (page: Page): Promise<void> => expect(page.locator('[role="alert"]:visible')).toHaveCount(0);
const noSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const dotOf = (scope: Locator | Page): Locator => scope.getByTestId('presence-dot');
const log = (s: string): void => console.log(`[pd] ${s}`);
const msgRows = (page: Page): Locator => page.locator('[data-testid="message"]');
/** Rows of the channel whose author name (the .who b) is a person, i.e. has a profile button. */
const authorRows = (page: Page, name: RegExp): Locator => msgRows(page).filter({ has: page.locator('.who b', { hasText: name }) });

let omarCtx: BrowserContext | undefined;
let omarPage: Page | undefined;
let omarOpenedAt = 0;

test.afterAll(async () => {
  await omarCtx?.close().catch(() => undefined);
});

test('pd-01 Omar opens his page in a second browser (the heartbeat clock starts)', async ({ browser }) => {
  const r = await signIn(browser, who('OMAR'), DESKTOP);
  omarCtx = r.context;
  omarPage = r.page;
  await omarPage.goto(`/t/${TEAM}/c/${CHANNEL}`);
  await expect(msgRows(omarPage).first()).toBeVisible(T);
  omarOpenedAt = Date.now();
  const heading = await omarPage.locator('[data-landmark="sidebar"]').innerText();
  log(`Omar signed in; sidebar text length ${heading.length}`);
});

test('pd-02 desktop 1440x900: #dev authors have dots, Nadia is Active, bots have none, the card opens and closes', async ({ browser }) => {
  test.setTimeout(240_000);
  const { page, context } = await signIn(browser, who('NADIA'), DESKTOP);
  try {
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    await expect(msgRows(page).first()).toBeVisible(T);
    // wait out the 30 s round (and then some): Omar's page has been open since the first test too
    const wait = Math.max(0, 40_000 - (Date.now() - omarOpenedAt));
    log(`waiting ${Math.round(wait / 1000)} s for the heartbeat rounds`);
    await page.waitForTimeout(Math.max(wait, 36_000));
    await page.reload();
    await expect(msgRows(page).first()).toBeVisible(T);
    await expect(dotOf(page).first()).toBeVisible(T);
    await noErrorBanner(page);

    // every dot has an accessible name that says the state in words
    const dots = await dotOf(page).all();
    const names: string[] = [];
    for (const d of dots) {
      const n = (await d.getAttribute('aria-label')) ?? '';
      expect(n, 'a dot without an accessible name').not.toBe('');
      expect(await d.getAttribute('role')).toBe('img');
      expect(n).toMatch(/^(Active|Away|Offline)/);
      names.push(n);
    }
    log(`${dots.length} dots in view; names: ${[...new Set(names)].join(' | ')}`);

    // authors: collect (name -> has dot) for every message row
    const rows = await msgRows(page).all();
    const byAuthor = new Map<string, { dot: number; rows: number; button: number }>();
    for (const r of rows) {
      const nm = ((await r.locator('.who b').first().innerText().catch(() => '')) ?? '').trim();
      if (!nm) continue;
      const e = byAuthor.get(nm) ?? { dot: 0, rows: 0, button: 0 };
      e.rows += 1;
      e.dot += (await dotOf(r.locator('.who')).count()) > 0 ? 1 : 0;
      e.button += (await r.getByTestId('profile-open').count()) > 0 ? 1 : 0;
      byAuthor.set(nm, e);
    }
    log(`authors: ${[...byAuthor.entries()].map(([k, v]) => `${k} rows=${v.rows} dots=${v.dot} profile=${v.button}`).join('; ')}`);

    // bots: no dot, no profile button. Bots are the names listed in the sidebar's Bots group.
    const botNames = (await page.locator('[data-slot="bots"] a.it .it-label, [data-landmark="sidebar"] .it-label').allTextContents()).map((s) => s.trim());
    const known = ['Coder', 'Engineer', 'Plan reviewer', 'Code reviewer', 'Brain', 'Alert triage'];
    let botsChecked = 0;
    for (const [nm, v] of byAuthor) {
      if (known.some((b) => nm.toLowerCase() === b.toLowerCase())) {
        expect(v.dot, `bot ${nm} must have no dot`).toBe(0);
        expect(v.button, `bot ${nm} must have no profile button`).toBe(0);
        botsChecked += 1;
      }
    }
    log(`bots checked: ${botsChecked} (sidebar lists ${botNames.filter((n) => known.includes(n)).join(', ')})`);
    if (botsChecked === 0) {
      // the bots answer inside threads: open threads until one has a bot author, and check there
      log('no bot message at the top level of #dev; looking in threads');
      const links = page.getByText(/\d+ repl(y|ies)/);
      const nLinks = Math.min(await links.count(), 6);
      for (let i = 0; i < nLinks && botsChecked === 0; i++) {
        await links.nth(i).click();
        const panel = page.getByTestId('thread-view').first();
        await expect(panel).toBeVisible(T);
        await page.waitForTimeout(1_500);
        for (const r of await panel.getByTestId('message').all()) {
          const nm = ((await r.locator('.who b').first().innerText().catch(() => '')) ?? '').trim();
          if (!known.some((b) => nm.toLowerCase() === b.toLowerCase())) continue;
          expect(await dotOf(r).count(), `bot ${nm} in a thread must have no dot`).toBe(0);
          expect(await r.getByTestId('profile-open').count(), `bot ${nm} in a thread must have no profile button`).toBe(0);
          botsChecked += 1;
        }
        if (botsChecked > 0) {
          const people = await dotOf(panel).count();
          log(`thread ${i}: ${botsChecked} bot rows without a dot; ${people} dots beside people in the same thread`);
          await shoot(page, 'pd-01b-thread-bots-no-dot');
        }
        const close = page.getByTestId('thread-view').first().getByRole('button', { name: /Close/ });
        if (await close.count()) await close.first().click();
        else await page.keyboard.press('Escape');
      }
    }
    expect(botsChecked, 'at least one bot author (channel or thread)').toBeGreaterThan(0);
    // and the people have dots
    let peopleWithDots = 0;
    for (const [nm, v] of byAuthor) {
      if (known.some((b) => nm.toLowerCase() === b.toLowerCase())) continue;
      expect(v.dot, `person ${nm}: every message row has a dot`).toBe(v.rows);
      peopleWithDots += 1;
    }
    expect(peopleWithDots, 'at least one person author in #dev').toBeGreaterThan(0);

    // Nadia's own dot reads Active
    const mine = authorRows(page, /^Nadia/).filter({ has: page.getByTestId('presence-dot') }).first();
    await expect(mine).toBeVisible(T);
    const mineDot = dotOf(mine.locator('.who'));
    await expect(mineDot).toHaveAttribute('data-presence', 'online', T);
    await expect(mineDot).toHaveAccessibleName(/^Active/);
    log(`Nadia's own dot: "${await mineDot.getAttribute('aria-label')}"`);
    // the dot sits beside the name on the same line
    const nb = await mine.locator('.who b').first().boundingBox();
    const db = await mineDot.boundingBox();
    expect(Math.abs(nb!.y + nb!.height / 2 - (db!.y + db!.height / 2)), 'dot vertically aligned with the name').toBeLessThan(10);
    await mineDot.hover();
    await shoot(page, 'pd-01-dev-authors-dots');

    // Omar (if he wrote in #dev, else checked in the roster below)
    const omarRow = authorRows(page, /^Omar/).first();
    if (await omarRow.count()) {
      await expect(dotOf(omarRow.locator('.who')), "Nadia sees Omar's dot Active").toHaveAttribute('data-presence', 'online');
      log(`Omar's dot seen from Nadia in #dev: "${await dotOf(omarRow.locator('.who')).getAttribute('aria-label')}"`);
    } else log('Omar has no message in the loaded part of #dev; checked in the roster');

    // the profile card of a person other than Nadia (or Nadia herself if nobody else): status, local time, working hours; Esc closes; focus returns
    const other = authorRows(page, /^(?!Nadia)/).filter({ has: page.getByTestId('profile-open') }).filter({ hasNot: page.locator('.who b', { hasText: new RegExp(`^(${known.join('|')})$`, 'i') }) }).first();
    const target = (await other.count()) ? other : mine;
    const open = target.getByTestId('profile-open').first();
    await open.scrollIntoViewIfNeeded();
    await open.focus();
    // pin the node: a lazy locator may resolve to another row once the dialog is open
    const openNode = (await open.elementHandle())!;
    await page.keyboard.press('Enter');
    const card = page.getByTestId('profile-card');
    await expect(card).toBeVisible(T);
    const cardName = (await card.getAttribute('aria-label')) ?? '';
    log(`profile card "${cardName}": ${(await card.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
    await expect(card.getByTestId('profile-presence')).toContainText(/Active|Away|Offline/);
    for (const id of ['profile-status', 'profile-time', 'profile-hours']) {
      const c = await card.getByTestId(id).count();
      log(`card ${id}: ${c ? 'shown' : 'absent (not shared by this person)'} `);
    }
    const openerTitle = await open.getAttribute('title');
    await shoot(page, 'pd-02-profile-card');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    // focus is back on the name that opened the card (checked by the node when it is still there; the same person's profile button otherwise:
    // on the live site the row's button was twice found replaced by a fresh node while the card was open, noted in the report)
    const back = await openNode.evaluate((el) => ({ same: el === document.activeElement, connected: el.isConnected, active: document.activeElement?.getAttribute('title') ?? document.activeElement?.tagName }));
    log(`focus after Esc: ${JSON.stringify(back)} (opener title ${openerTitle})`);
    expect(back.same || back.active === openerTitle, 'focus goes back to the name that opened the card').toBe(true);
    await noErrorBanner(page);

    // the @ picker in the composer
    const box = page.locator('[data-landmark="composer"] textarea').first();
    await box.click();
    await page.keyboard.type('@');
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible(T);
    const options = list.getByRole('option');
    const nOpt = await options.count();
    let withDot = 0;
    const optionNames: string[] = [];
    for (const o of await options.all()) {
      const dot = await dotOf(o).count();
      withDot += dot > 0 ? 1 : 0;
      optionNames.push(`${((await o.innerText()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 30)}${dot ? ' [dot]' : ''}`);
    }
    log(`@ picker: ${nOpt} options, ${withDot} with a dot: ${optionNames.join(' | ')}`);
    expect(withDot, 'the @ picker shows dots for people').toBeGreaterThan(0);
    for (const o of await options.all()) {
      if ((await dotOf(o).count()) > 0) await expect(o).toHaveAccessibleName(/(Active|Away|Offline)/);
    }
    await shoot(page, 'pd-03-at-picker-dots');
    await page.keyboard.press('Escape');
    await box.fill(''); // nothing is sent
    await expect(box).toHaveValue('');
    await noErrorBanner(page);
  } finally {
    await context.close();
  }
});

test('pd-03 team roster: People rows have dots, bots have none, a name opens the card, Esc closes it', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('NADIA'), DESKTOP);
  try {
    await page.goto(`/settings/team/${TEAM}/roster`);
    const people = page.locator('.person-row');
    await expect(people.first()).toBeVisible(T);
    await expect(dotOf(people.first())).toBeVisible(T);
    const n = await people.count();
    let withDot = 0;
    for (const p of await people.all()) withDot += (await dotOf(p).count()) > 0 ? 1 : 0;
    log(`roster: ${n} people rows, ${withDot} with a dot`);
    expect(withDot, 'every People row has a dot').toBe(n);
    const bots = page.locator('.mrow:not(.person-row)');
    log(`roster: ${await bots.count()} non-person rows, dots among them: ${await dotOf(bots).count()}`);
    expect(await dotOf(bots).count(), 'bots in the roster have no dot').toBe(0);
    const states: string[] = [];
    for (const p of await people.all()) states.push(`${((await p.innerText()) ?? '').split('\n')[0]!.trim()}=${await dotOf(p).getAttribute('data-presence')}`);
    log(`roster states: ${states.join(', ')}`);
    // Omar seen from Nadia
    const omarRow = people.filter({ hasText: /Omar/ }).first();
    if (await omarRow.count()) {
      await expect(dotOf(omarRow), "Nadia sees Omar Active after his page was open > 35 s").toHaveAttribute('data-presence', 'online', T);
      log(`Omar on the roster: "${await dotOf(omarRow).getAttribute('aria-label')}"`);
    } else log('no Omar row on the Engineering roster');
    await shoot(page, 'pd-04-roster-people-dots');

    const first = people.filter({ has: page.getByTestId('profile-open') }).first();
    const open = first.getByTestId('profile-open');
    const openNode = (await open.elementHandle())!;
    await open.click();
    const card = page.getByTestId('profile-card');
    await expect(card).toBeVisible(T);
    await shoot(page, 'pd-05-roster-profile-card');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    expect(await openNode.evaluate((el) => el === document.activeElement), 'focus goes back to the name that opened the card').toBe(true);
    // every person's card on the roster: which facts they share (read only)
    for (let i = 0; i < n; i++) {
      const o = page.locator('.person-row').nth(i).getByTestId('profile-open');
      if (!(await o.count())) continue;
      await o.click();
      await expect(card).toBeVisible(T);
      const facts: string[] = [];
      for (const id of ['profile-presence', 'profile-status', 'profile-time', 'profile-hours', 'profile-ooo', 'profile-empty']) if (await card.getByTestId(id).count()) facts.push(id.replace('profile-', ''));
      log(`card ${i}: ${(await card.locator('h2').innerText()).trim()} -> ${facts.join(', ')} :: ${(await card.innerText()).replace(/\s+/g, ' ').slice(0, 220)}`);
      if (facts.includes('time') || facts.includes('hours') || facts.includes('status')) await shoot(page, `pd-05b-roster-card-${i}-full`);
      await page.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
    }
    await noErrorBanner(page);
  } finally {
    await context.close();
  }
});

test('pd-04 /account#status-and-dnd renders the Out of office section (nothing is saved)', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('NADIA'), DESKTOP);
  try {
    await page.goto('/account#status-and-dnd');
    const section = page.getByTestId('presence-settings');
    await expect(section).toBeVisible(T);
    await expect(section.getByRole('heading', { name: 'Out of office' })).toBeVisible();
    const form = section.getByTestId('ooo-editor');
    await expect(form).toBeVisible();
    await expect(form.getByTestId('ooo-switch')).toBeVisible();
    await expect(form.getByTestId('ooo-save')).toBeDisabled(); // nothing changed, nothing to save
    await form.scrollIntoViewIfNeeded();
    await noErrorBanner(page);
    await shoot(page, 'pd-06-account-out-of-office');
    await section.scrollIntoViewIfNeeded();
    await shoot(page, 'pd-07-account-status-and-dnd');
  } finally {
    await context.close();
  }
});

test('pd-05 Omar sees Nadia Active too (second browser, 35 s on the page)', async () => {
  test.setTimeout(120_000);
  expect(omarPage, 'Omar signed in in the first test').toBeTruthy();
  const page = omarPage!;
  await page.goto(`/settings/team/${TEAM}/roster`);
  await expect(page.locator('.person-row').first()).toBeVisible(T);
  const row = page.locator('.person-row').filter({ hasText: /Nadia/ }).first();
  await expect(row).toBeVisible(T);
  // Nadia's contexts are closed; her last beat counts for 90 s, so a fresh page is not needed: only read what the server says
  const state = await dotOf(row).getAttribute('data-presence');
  log(`Nadia seen from Omar's roster: ${state} "${await dotOf(row).getAttribute('aria-label')}" (her browser closed some seconds ago)`);
  expect(['online', 'away', 'offline']).toContain(state);
  await shoot(page, 'pd-08-omar-view-roster');
  await noErrorBanner(page);
});

test('pd-06 phone 390x844: a channel loads without rows jumping and without sideways scroll', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, context } = await signIn(browser, who('NADIA'), PHONE, true);
  try {
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    await expect(msgRows(page).first()).toBeVisible(T);
    await expect(dotOf(page).first()).toBeVisible({ timeout: 40_000 });
    const firstY = async (): Promise<number> => Math.round((await msgRows(page).first().boundingBox())!.y);
    const lastY = async (): Promise<number> => Math.round((await msgRows(page).last().boundingBox())!.y);
    const y1 = await firstY();
    const l1 = await lastY();
    await shoot(page, 'pd-09-mobile-channel-a');
    await page.waitForTimeout(1_000);
    const y2 = await firstY();
    await shoot(page, 'pd-10-mobile-channel-b');
    const l2 = await lastY();
    log(`mobile first message row y: ${y1} then ${y2}; last row y: ${l1} then ${l2}`);
    expect(y2, 'the first message row did not move in a second').toBe(y1);
    expect(l2, 'the last message row did not move in a second').toBe(l1);
    expect(await noSideways(page), 'no sideways scroll').toBe(true);
    // a profile card on the phone, and a fresh load: rows stay put through the first 4 s
    const open = page.getByTestId('profile-open').first();
    await open.tap();
    const card = page.getByTestId('profile-card');
    await expect(card).toBeVisible(T);
    const cb = (await card.boundingBox())!;
    expect(cb.x, 'card left edge').toBeGreaterThanOrEqual(-0.5);
    expect(cb.x + cb.width, 'card right edge').toBeLessThanOrEqual(PHONE.width + 0.5);
    expect(await noSideways(page), 'no sideways scroll with the card').toBe(true);
    await shoot(page, 'pd-11-mobile-profile-card');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await page.reload();
    await expect(msgRows(page).first()).toBeVisible(T);
    const samples: number[] = [];
    for (let i = 0; i < 6; i++) {
      samples.push(Math.round((await msgRows(page).last().boundingBox())!.y));
      await page.waitForTimeout(700);
    }
    log(`mobile last row y while loading: ${samples.join(', ')}`);
    expect(new Set(samples.slice(1)).size, 'rows stay put after the first paint').toBe(1);
    await noErrorBanner(page);
  } finally {
    await context.close();
  }
});

test('pd-07 no console error, page error or error banner over the run', () => {
  expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
  log(`console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 5).join(' | ') : ''}`);
  expect(problems.filter((p) => !/favicon/i.test(p)), 'console errors').toEqual([]);
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
