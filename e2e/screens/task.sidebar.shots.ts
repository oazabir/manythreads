import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * The personal sidebar (P14-15) on the live site, driven as a real user (Nadia, Engineering): the sidebar as is, star a channel from its row
 * menu (a Starred group first, the channel listed once), unstar, sort by recent activity / name / team order, hide idle channels (the
 * "N quiet channels hidden" row), move a group with the options menu, reload to see every setting kept, then put Nadia's sidebar back as
 * found and check it through GET /api/teams/<slug>/sidebar-prefs. Then the same basics at 390x844 in the drawer.
 * Credentials come from the environment only (NADIA_EMAIL/NADIA_PASSWORD; `source ~/manythreads.passwords.env`).
 * It changes Nadia's own sidebar prefs and restores them. Run:
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.sidebar.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/sb-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const PREFS = `/api/teams/${TEAM}/sidebar-prefs`;

type Prefs = { starred: string[]; sort: string; hideIdle: boolean; groupOrder: string[] };
type Who = { email: string; password: string };
const nadia: Who = { email: process.env['NADIA_EMAIL'] ?? '', password: process.env['NADIA_PASSWORD'] ?? '' };

test.beforeAll(() => {
  if (!nadia.email || nadia.password.length < 8) throw new Error('NADIA_EMAIL / NADIA_PASSWORD are not set (source ~/manythreads.passwords.env)');
});

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
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

async function getPrefs(page: Page): Promise<Prefs> {
  const res = await page.request.get(`${BASE}${PREFS}`);
  expect(res.status(), 'GET sidebar-prefs').toBe(200);
  return (await res.json()) as Prefs;
}

/** Put prefs back through the API (a safety net: the UI restore is the main path). */
async function putPrefs(page: Page, body: Record<string, unknown>): Promise<number> {
  const cookies = await page.context().cookies(BASE);
  const csrf = (cookies.find((c) => c.name === '__Host-manythreads_csrf') ?? cookies.find((c) => c.name === 'manythreads_csrf'))?.value ?? '';
  return (await page.request.put(`${BASE}${PREFS}`, { data: body, headers: { 'x-csrf-token': csrf } })).status();
}

const sidebar = (page: Page): Locator => page.locator('[data-landmark="sidebar"]');
const rail = (page: Page): Locator => page.locator('#shell-rail');
const groupsOf = (root: Locator): Locator => root.locator('.channel-groups .group');
const row = (root: Locator, name: string): Locator => root.locator(`a.it[href$="/c/${name}"]`);
const noErrorBanner = (page: Page): Promise<void> => expect(page.locator('[role="alert"]:visible')).toHaveCount(0);

/** Each group (heading text) with the channels listed in it, top to bottom, plus the "N quiet channels hidden" row text if any. */
async function layout(root: Locator): Promise<Array<{ group: string; channels: string[]; hidden: string | null }>> {
  const out: Array<{ group: string; channels: string[]; hidden: string | null }> = [];
  for (const g of await groupsOf(root).all()) {
    const group = ((await g.locator('button.grp').first().innerText()) ?? '').replace(/\s+/g, ' ').trim();
    const channels = (await g.locator('a.it .it-label').allTextContents()).map((s) => s.trim());
    const hid = g.getByTestId('hidden-channels');
    const hidden = (await hid.count()) ? ((await hid.innerText()).replace(/\s+/g, ' ').trim()) : null;
    out.push({ group, channels, hidden });
  }
  return out;
}
const describe = (l: Awaited<ReturnType<typeof layout>>): string => l.map((g) => `${g.group}: [${g.channels.join(', ')}]${g.hidden ? ` {${g.hidden}}` : ''}`).join(' | ');
const allChannels = (l: Awaited<ReturnType<typeof layout>>): string[] => l.flatMap((g) => g.channels);

async function waitForList(root: Locator): Promise<void> {
  await expect(groupsOf(root).first()).toBeVisible(T);
  await expect(root.locator('a.it').first()).toBeVisible(T);
}

async function openOptions(page: Page, root: Locator): Promise<Locator> {
  await root.getByTestId('sidebar-options').click();
  const menu = page.getByTestId('sidebar-options-menu');
  await expect(menu).toBeVisible(T);
  return menu;
}
async function rowMenu(page: Page, root: Locator, name: string): Promise<Locator> {
  await row(root, name).hover();
  await row(root, name).locator('xpath=..').getByTestId('channel-row-menu').click();
  const menu = page.getByRole('menu', { name: `Options for #${name}` });
  await expect(menu).toBeVisible(T);
  return menu;
}
const noSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);


test('sb-01 desktop: star, sort, hide idle, move a group, persistence, restore', async ({ browser }) => {
  test.setTimeout(300_000);
  const { page, context } = await signIn(browser, nadia, DESKTOP);
  let initial: Prefs | undefined;
  const log = (s: string): void => console.log(`[sb] ${s}`);
  try {
    await page.goto(`/t/${TEAM}/threads`);
    const sb = sidebar(page);
    await waitForList(sb);
    initial = await getPrefs(page);
    log(`found prefs: starred=${initial.starred.length} sort=${initial.sort} hideIdle=${initial.hideIdle} groupOrder=${initial.groupOrder.length}`);
    const start = await layout(sb);
    log(`0 sidebar as is: ${describe(start)}`);
    await noErrorBanner(page);
    await shoot(page, 'sb-01-sidebar-as-is');
    await sb.screenshot({ path: join(OUT, 'sb-01b-sidebar-crop.png'), animations: 'disabled' });

    // 1. star a channel from its row menu
    const names = allChannels(start);
    expect(names.length, 'channels listed').toBeGreaterThan(0);
    const channel = ['dev', 'general'].find((n) => names.includes(n)) ?? names[0]!;
    const wasStarred = start.find((g) => g.group.toLowerCase().startsWith('starred'))?.channels.includes(channel) ?? false;
    expect(wasStarred, `#${channel} was not already starred (pick another by hand)`).toBe(false);
    const menu = await rowMenu(page, sb, channel);
    await shoot(page, 'sb-02-row-menu-open');
    await expect(menu.getByTestId('channel-row-star')).toHaveText(/Star/);
    await menu.getByTestId('channel-row-star').click();
    await expect.poll(async () => (await getPrefs(page)).starred.length, T).toBe(initial.starred.length + 1);
    const starred = await layout(sb);
    log(`1 after star #${channel}: ${describe(starred)}`);
    expect(starred[0]!.group.toLowerCase(), 'Starred group is first').toMatch(/^starred/);
    expect(starred[0]!.channels, 'starred group holds the channel').toContain(channel);
    expect(allChannels(starred).filter((n) => n === channel), `#${channel} listed once`).toHaveLength(1);
    await noErrorBanner(page);
    await shoot(page, 'sb-03-starred-group');

    // unstar
    const m2 = await rowMenu(page, sb, channel);
    await expect(m2.getByTestId('channel-row-star')).toHaveText(/Remove star/);
    await shoot(page, 'sb-04-row-menu-remove-star');
    await m2.getByTestId('channel-row-star').click();
    await expect.poll(async () => (await getPrefs(page)).starred.length, T).toBe(initial.starred.length);
    const unstarred = await layout(sb);
    log(`1b after unstar: ${describe(unstarred)}`);
    expect(allChannels(unstarred).filter((n) => n === channel)).toHaveLength(1);
    expect(describe(unstarred), 'unstar puts the sidebar back').toBe(describe(start));

    // 2. sort: recent, name, team order
    const orders: Record<string, string> = {};
    for (const sort of ['recent', 'name', 'team'] as const) {
      const m = await openOptions(page, sb);
      if (sort === 'recent') {
        const mb = (await m.boundingBox())!;
        log(`2 options menu box x=${Math.round(mb.x)} w=${Math.round(mb.width)} (sidebar x=${Math.round((await sb.boundingBox())!.x)})`);
        expect.soft(mb.x, 'the options menu starts inside the window (its left edge is not cut off)').toBeGreaterThanOrEqual(0);
        await shoot(page, 'sb-05-options-menu');
      }
      await m.getByTestId(`sort-${sort}`).click();
      await expect.poll(async () => (await getPrefs(page)).sort, T).toBe(sort);
      await page.waitForTimeout(400);
      const l = await layout(sb);
      orders[sort] = describe(l);
      log(`2 sort ${sort}: ${orders[sort]}`);
      await shoot(page, `sb-06-sort-${sort}`);
      if (sort === 'name') {
        for (const g of l) {
          const sorted = [...g.channels].sort((a, b) => a.localeCompare(b));
          expect(g.channels, `group ${g.group} is alphabetical`).toEqual(sorted);
        }
      }
      await noErrorBanner(page);
    }
    expect(orders['team'], 'back to team order = as found').toBe(describe(start));
    // the sort found is restored at the end; a sort other than team order at the start is rare, so put it back now
    if (initial.sort !== 'team') {
      const m = await openOptions(page, sb);
      await m.getByTestId(`sort-${initial.sort}`).click();
      await expect.poll(async () => (await getPrefs(page)).sort, T).toBe(initial!.sort);
    }

    // 3. hide idle channels
    const startedHidden = initial.hideIdle;
    expect(startedHidden, 'hide idle was off when found (turn it off by hand)').toBe(false);
    // star one channel and open another so we can check "stay visible"
    const mh = await openOptions(page, sb);
    await shoot(page, 'sb-07-options-menu-before-hide');
    await mh.getByTestId('hide-idle').click();
    await expect.poll(async () => (await getPrefs(page)).hideIdle, T).toBe(true);
    await page.waitForTimeout(400);
    const hid = await layout(sb);
    log(`3 hide idle on: ${describe(hid)}`);
    await shoot(page, 'sb-08-hide-idle-on');
    const hiddenRows = sb.getByTestId('hidden-channels');
    const hiddenCount = await hiddenRows.count();
    log(`3 hidden rows: ${hiddenCount}`);
    const unreadStillListed = await sb.locator('a.it.unread').count();
    log(`3 unread rows listed: ${unreadStillListed}`);
    if (hiddenCount > 0) {
      const first = hiddenRows.first();
      await expect(first).toHaveText(/\d+ quiet channels? hidden/);
      await expect(first).toHaveAttribute('aria-expanded', 'false');
      const before = allChannels(hid);
      await first.click();
      await expect(first).toHaveAttribute('aria-expanded', 'true');
      const expanded = await layout(sb);
      log(`3 expanded: ${describe(expanded)}`);
      await shoot(page, 'sb-09-hidden-expanded');
      const revealed = allChannels(expanded).filter((n) => !before.includes(n));
      expect(revealed.length, 'expanding lists the folded channels').toBeGreaterThan(0);
      // none of the folded ones is unread
      for (const n of revealed) await expect(row(sb, n), `#${n} folded away but unread`).not.toHaveClass(/unread/);
      // open one of the folded channels: it must stay listed once folded again (an open channel is never hidden)
      const openName = revealed[0]!;
      await row(sb, openName).click();
      await expect(page).toHaveURL(new RegExp(`/c/${openName}$`), T);
      await first.click().catch(() => undefined);
      await page.waitForTimeout(400);
      const after = await layout(sb);
      log(`3 after opening #${openName} and folding: ${describe(after)}`);
      expect(allChannels(after), `open channel #${openName} stays listed`).toContain(openName);
      await shoot(page, 'sb-10-open-channel-stays');
      // collapse check
      const again = sb.getByTestId('hidden-channels');
      if ((await again.count()) > 0 && (await again.first().getAttribute('aria-expanded')) === 'true') await again.first().click();
      if ((await again.count()) > 0) await expect(again.first()).toHaveAttribute('aria-expanded', 'false');
    } else {
      log('3 NOTE: no channel is idle for 30 days for Nadia, so no "quiet channels hidden" row appears');
    }
    // starred channels stay while hide idle is on
    const m3 = await rowMenu(page, sb, channel);
    await m3.getByTestId('channel-row-star').click();
    await expect.poll(async () => (await getPrefs(page)).starred.length, T).toBe(initial.starred.length + 1);
    const hs = await layout(sb);
    log(`3 hide idle + starred #${channel}: ${describe(hs)}`);
    expect(hs[0]!.channels, 'starred stays listed with hide idle on').toContain(channel);
    await shoot(page, 'sb-11-hide-idle-and-starred');

    // 4. move a group with the options menu
    const mg = await openOptions(page, sb);
    const ordRows = mg.locator('.sb-ord');
    const nGroups = await ordRows.count();
    log(`4 groups in the order list: ${nGroups}`);
    const namesBefore = (await ordRows.allTextContents()).map((s) => s.replace(/\s+/g, ' ').trim());
    await shoot(page, 'sb-12-options-menu-order');
    let moved = false;
    if (nGroups >= 2) {
      await expect(mg.getByTestId('group-up-0')).toBeDisabled();
      await mg.getByTestId('group-up-1').click();
      moved = true;
      await expect.poll(async () => (await getPrefs(page)).groupOrder.length, T).toBeGreaterThan(0);
      await page.waitForTimeout(400);
      const mv = await layout(sb);
      log(`4 after moving group 2 up: ${describe(mv)}; menu before: ${namesBefore.join(' / ')}`);
      await shoot(page, 'sb-13-group-moved');
    } else {
      log('4 NOTE: fewer than two groups; the move buttons are not offered');
      await page.keyboard.press('Escape');
    }
    await noErrorBanner(page);

    // 5. reload and confirm what persisted
    const savedBeforeReload = await getPrefs(page);
    const layoutBeforeReload = describe(await layout(sb));
    await page.reload();
    await waitForList(sb);
    const afterReload = await getPrefs(page);
    expect(afterReload.sort, 'sort kept').toBe(savedBeforeReload.sort);
    expect(afterReload.hideIdle, 'hide idle kept').toBe(true);
    expect(afterReload.starred, 'star kept').toEqual(savedBeforeReload.starred);
    expect(afterReload.groupOrder, 'group order kept').toEqual(savedBeforeReload.groupOrder);
    const reloaded = await layout(sb);
    log(`5 after reload: ${describe(reloaded)}`);
    expect(describe(reloaded), 'the sidebar after reload looks like before').toBe(layoutBeforeReload);
    const mr = await openOptions(page, sb);
    await expect(mr.getByTestId('hide-idle')).toHaveAttribute('aria-checked', 'true');
    await expect(mr.getByTestId('sort-team')).toHaveAttribute('aria-checked', 'true');
    await shoot(page, 'sb-14-after-reload-options');
    await page.keyboard.press('Escape');
    await shoot(page, 'sb-15-after-reload');
    expect(moved || nGroups < 2).toBe(true);

    // 6. restore through the UI: move the group back, hide idle off, unstar
    const mrest = await openOptions(page, sb);
    if (moved) await mrest.getByTestId('group-down-0').click();
    await expect(mrest).toBeVisible();
    await page.keyboard.press('Escape');
    const mq = await openOptions(page, sb);
    await mq.getByTestId('hide-idle').click();
    await expect.poll(async () => (await getPrefs(page)).hideIdle, T).toBe(false);
    const mu = await rowMenu(page, sb, channel);
    await mu.getByTestId('channel-row-star').click();
    await expect.poll(async () => (await getPrefs(page)).starred.length, T).toBe(initial.starred.length);
    await page.waitForTimeout(400);
    const restored = await layout(sb);
    log(`6 restored: ${describe(restored)}`);
    await shoot(page, 'sb-16-restored');
    expect(describe(restored), 'sidebar looks as found').toBe(describe(start));
    // the group order is explicit after a move; put the exact saved value back
    const nowPrefs = await getPrefs(page);
    if (JSON.stringify(nowPrefs.groupOrder) !== JSON.stringify(initial.groupOrder)) {
      log(`6 group order saved as ${nowPrefs.groupOrder.length} ids, found ${initial.groupOrder.length}; putting the found value back by API`);
      expect(await putPrefs(page, { groupOrder: initial.groupOrder }), 'PUT groupOrder').toBe(200);
    }
    const final = await getPrefs(page);
    expect(final).toEqual(initial);
    log('6 GET sidebar-prefs equals what was found');
  } finally {
    // safety net: whatever happened above, leave Nadia's prefs as found
    try {
      if (initial) {
        const now = await getPrefs(page);
        const body: Record<string, unknown> = {};
        const add = initial.starred.filter((id) => !now.starred.includes(id));
        const rem = now.starred.filter((id) => !initial!.starred.includes(id));
        if (add.length) body['starAdd'] = add;
        if (rem.length) body['starRemove'] = rem;
        if (now.sort !== initial.sort) body['sort'] = initial.sort;
        if (now.hideIdle !== initial.hideIdle) body['hideIdle'] = initial.hideIdle;
        if (JSON.stringify(now.groupOrder) !== JSON.stringify(initial.groupOrder)) body['groupOrder'] = initial.groupOrder;
        if (Object.keys(body).length) console.log(`[sb] safety-net restore: ${Object.keys(body).join(', ')} -> ${await putPrefs(page, body)}`);
      }
    } catch (e) {
      console.log(`[sb] safety-net restore failed: ${String(e).slice(0, 200)}`);
    }
    await context.close();
  }
});

test('sb-02 mobile 390x844: drawer, options menu, star and unstar from the row menu', async ({ browser }) => {
  test.setTimeout(180_000);
  const { page, context } = await signIn(browser, nadia, PHONE, true);
  let initial: Prefs | undefined;
  const log = (s: string): void => console.log(`[sb] ${s}`);
  try {
    await page.goto(`/t/${TEAM}/threads`);
    initial = await getPrefs(page);
    expect(await noSideways(page), 'no sideways scroll before the drawer').toBe(true);
    await shoot(page, 'sb-20-mobile-closed');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'open', T);
    const r = rail(page);
    await waitForList(r);
    expect(await noSideways(page), 'no sideways scroll with the drawer open').toBe(true);
    const start = await layout(r);
    log(`m0 drawer: ${describe(start)}`);
    await shoot(page, 'sb-21-mobile-drawer');

    const inside = async (loc: Locator, what: string): Promise<void> => {
      const box = (await loc.boundingBox())!;
      expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(PHONE.width + 0.5);
    };
    const options = r.getByTestId('sidebar-options');
    await expect(options).toBeVisible();
    await inside(options, 'options button');
    await options.tap();
    const menu = page.getByTestId('sidebar-options-menu');
    await expect(menu).toBeVisible(T);
    await inside(menu, 'options menu');
    expect(await noSideways(page), 'no sideways scroll with the options menu open').toBe(true);
    await shoot(page, 'sb-22-mobile-options-menu');
    // close it by choosing the sort already in force (a no-op; Esc is not used here: with the drawer open it closes the drawer first and leaves this menu open, noted in the report)
    await menu.getByTestId(`sort-${initial.sort}`).tap();
    await expect(menu).toBeHidden();

    const names = allChannels(start);
    const channel = ['general', 'dev'].find((n) => names.includes(n)) ?? names[0]!;
    const more = r.locator('.sb-row').filter({ has: page.locator(`a[href$="/c/${channel}"]`) }).getByTestId('channel-row-menu');
    await expect(more).toBeVisible();
    await inside(more, 'row menu button');
    await more.tap();
    const rm = page.getByRole('menu', { name: `Options for #${channel}` });
    await expect(rm).toBeVisible(T);
    await inside(rm, 'row menu');
    await shoot(page, 'sb-23-mobile-row-menu');
    await rm.getByTestId('channel-row-star').tap();
    await expect.poll(async () => (await getPrefs(page)).starred.length, T).toBe(initial.starred.length + 1);
    const st = await layout(r);
    log(`m1 starred #${channel}: ${describe(st)}`);
    expect(st[0]!.group.toLowerCase()).toMatch(/^starred/);
    expect(allChannels(st).filter((n) => n === channel)).toHaveLength(1);
    expect(await noSideways(page), 'no sideways scroll with a Starred group').toBe(true);
    await shoot(page, 'sb-24-mobile-starred');

    const more2 = r.locator('.sb-row').filter({ has: page.locator(`a[href$="/c/${channel}"]`) }).getByTestId('channel-row-menu');
    await more2.tap();
    const rm2 = page.getByRole('menu', { name: `Options for #${channel}` });
    await expect(rm2.getByTestId('channel-row-star')).toHaveText(/Remove star/);
    await rm2.getByTestId('channel-row-star').tap();
    await expect.poll(async () => (await getPrefs(page)).starred.length, T).toBe(initial.starred.length);
    expect(describe(await layout(r))).toBe(describe(start));
    expect(await noSideways(page), 'no sideways scroll after unstar').toBe(true);
    await noErrorBanner(page);
    await shoot(page, 'sb-25-mobile-unstarred');
    expect(await getPrefs(page)).toEqual(initial);
  } finally {
    try {
      if (initial) {
        const now = await getPrefs(page);
        const rem = now.starred.filter((id) => !initial!.starred.includes(id));
        const add = initial.starred.filter((id) => !now.starred.includes(id));
        if (rem.length || add.length) console.log(`[sb] mobile safety-net restore -> ${await putPrefs(page, { ...(add.length ? { starAdd: add } : {}), ...(rem.length ? { starRemove: rem } : {}) })}`);
      }
    } catch (e) {
      console.log(`[sb] mobile safety-net restore failed: ${String(e).slice(0, 200)}`);
    }
    await context.close();
  }
});

test('sb-03 no console error, page error or error banner over the run', () => {
  expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
  console.log(`[sb] console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 5).join(' | ') : ''}`);
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
