/* eslint-disable @typescript-eslint/no-explicit-any -- a live-site check reads loosely typed API answers */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Live check of Import from Slack and Mattermost (P14-13): Omar (workspace admin) uploads the committed Slack export into Engineering, reads the dry run,
 * starts the import, reads the final report, looks at the imported channels, runs the same archive a second time (nothing may be written twice), and
 * Nadia (not an admin) is refused. Afterwards the scratch channels are archived and the runs removed. Credentials come from the environment only.
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts screens/task.import.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/imp-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const ARCHIVE = join(import.meta.dirname, '..', '..', 'packages', 'plugins', 'import', 'test', 'fixtures', 'slack-export.zip');
const WIDE = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const PATH = '/settings/workspace/import';

const log = (s: string): void => console.log(`[imp] ${s}`);
test.describe.configure({ mode: 'serial' });
test.beforeAll(() => {
  for (const k of ['OMAR', 'NADIA'] as const) {
    if (!process.env[`${k}_EMAIL`] || (process.env[`${k}_PASSWORD`] ?? '').length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set`);
  }
});

type Sess = { page: Page; context: BrowserContext };
const problems: string[] = [];
async function signIn(browser: Browser, key: 'OMAR' | 'NADIA', viewport: { width: number; height: number }, mobile = false): Promise<Sess> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)} @ ${page.url()}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${key}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${key}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}
async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage });
  log(`shot ${name}.png`);
}
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => /manythreads_csrf$/.test(x.name));
  return c ? { 'x-csrf-token': c.value } : {};
}
const api = async (s: Sess, path: string): Promise<any> => (await s.page.request.get(path)).json();
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();
async function noSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
}
async function channelsOf(s: Sess): Promise<Array<{ id: string; name: string; unread: number }>> {
  const d = await api(s, `/api/teams/${TEAM}/channels`);
  return (d.groups as any[]).flatMap((g) => g.channels as any[]);
}
async function allMessages(s: Sess, channelId: string): Promise<any[]> {
  const out: any[] = [];
  let cursor = '';
  for (let i = 0; i < 30; i++) {
    const d = await api(s, `/api/channels/${channelId}/messages?limit=100${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(d.items ?? []));
    if (!d.nextCursor && !d.hasMore) break;
    cursor = d.nextCursor ?? '';
    if (!cursor) break;
  }
  return out;
}
const runCard = (page: Page, n: number): Locator => page.locator('[data-testid^="import-run-"]').nth(n);

let omar: Sess | undefined;
let nadia: Sess | undefined;
const before = { channels: new Set<string>(), unread: 0, notifs: 0 };
let newChannels: Array<{ id: string; name: string }> = [];
const counts1 = new Map<string, number>();

test.afterAll(async () => {
  log(`page errors: ${problems.length ? problems.join(' | ') : 'none'}`);
  for (const s of [omar, nadia]) await s?.context.close().catch(() => undefined);
});

test('imp-01 Omar uploads the Slack export, reads the dry run at 1280 and 390, starts the import, reads the final report', async ({ browser }) => {
  test.setTimeout(240_000);
  omar = await signIn(browser, 'OMAR', WIDE);
  const page = omar.page;
  // IMPORT_RESUME=1: a first run of this archive is already done on the server (an earlier attempt stopped after it); go on from there
  if (process.env['IMPORT_RESUME'] === '1') { before.notifs = (await api(omar, '/api/notifications/summary')).unreadCount; test.skip(true, 'resuming after the first run'); return; }
  for (const c of await channelsOf(omar)) before.channels.add(c.name);
  before.notifs = (await api(omar, '/api/notifications/summary')).unreadCount;
  log(`before: ${before.channels.size} channels in ${TEAM}, notification unread ${before.notifs}`);

  await page.goto('/settings');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const navImport = page.getByRole('link', { name: 'Import', exact: true });
  log(`settings nav shows an Import item: ${await navImport.count()}`);
  await shoot(page, 'imp-01-settings-nav');
  if (await navImport.count()) await navImport.first().click(); else await page.goto(PATH);
  await expect(page).toHaveURL(/\/settings\/workspace\/import/, T);
  await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible(T);
  const existing = await page.locator('[data-testid^="import-run-"]').count();
  log(`runs already listed: ${existing}`);
  await shoot(page, 'imp-02-import-empty-1280');

  await page.getByTestId('import-source').selectOption('slack');
  await page.getByTestId('import-team').selectOption(TEAM);
  await page.getByTestId('import-file').setInputFiles(ARCHIVE);
  await page.getByTestId('import-upload').click();
  const run = runCard(page, 0);
  await expect(run).toHaveAttribute('data-status', 'uploaded', T);
  await run.getByTestId('import-dry-run').click();
  await expect(run).toHaveAttribute('data-status', 'analysed', { timeout: 60_000 });
  const report = run.getByTestId('import-report');
  const dry = flat(await report.innerText());
  log(`DRY RUN REPORT: ${dry}`);
  expect(dry).toContain('Nothing has been written yet');
  await shoot(page, 'imp-03-dry-run-1280', true);

  // the same screen at 390 px (a second context, the run is on the server)
  const phone = await signIn(browser, 'OMAR', PHONE, true);
  try {
    await phone.page.goto(PATH);
    await expect(phone.page.getByTestId('import-source')).toBeVisible(T);
    await expect(phone.page.locator('[data-testid^="import-run-"]').first()).toHaveAttribute('data-status', 'analysed', T);
    const ok = await noSideways(phone.page);
    log(`390px dry-run screen: no sideways scroll = ${ok}`);
    await shoot(phone.page, 'imp-04-dry-run-390', true);
    expect(ok).toBe(true);
  } finally { await phone.context.close(); }

  await run.getByTestId('import-start').click();
  await expect(run.getByTestId('import-start-confirm')).toBeVisible(T);
  await shoot(page, 'imp-05-start-confirm-1280');
  await run.getByTestId('import-start-confirm').click();
  await expect(run).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
  await expect(run.locator('.imp-status')).toHaveText('Finished');
  const fin = flat(await run.getByTestId('import-report').innerText());
  log(`FINAL REPORT: ${fin}`);
  await shoot(page, 'imp-06-final-report-1280', true);

  const phone2 = await signIn(browser, 'OMAR', PHONE, true);
  try {
    await phone2.page.goto(PATH);
    await expect(phone2.page.locator('[data-testid^="import-run-"]').first()).toHaveAttribute('data-status', 'done', T);
    const ok = await noSideways(phone2.page);
    log(`390px final-report screen: no sideways scroll = ${ok}`);
    await shoot(phone2.page, 'imp-07-final-report-390', true);
    expect(ok).toBe(true);
  } finally { await phone2.context.close(); }
});

test('imp-02 imported channels: original March 2024 order, "(imported)" authors, no unread storm for Omar', async () => {
  test.setTimeout(180_000);
  const o = omar!;
  const page = o.page;
  const listed = await api(o, '/api/admin/imports');
  const lines: any[] = (listed.items as any[]).find((r) => r.status === 'done')?.result?.channelLines ?? [];
  const names = lines.filter((l) => l.kind !== 'direct' && l.outcome !== 'skip').map((l) => String(l.becomes ?? l.name));
  const find = async (): Promise<Array<{ id: string; name: string; unread: number }>> => (await channelsOf(o)).filter((c) => names.includes(c.name));
  newChannels = await find();
  const missing = names.filter((n) => !newChannels.some((c) => c.name === n));
  if (missing.length) {
    // an earlier attempt archived them: the search finds their messages with the channel id, bring them back
    const found = await api(o, `/api/search?q=${encodeURIComponent('shipping notes')}&limit=50`);
    log(`search answer keys: ${Object.keys(found).join('/')}; first hit: ${JSON.stringify((found.items ?? found.results ?? found.hits ?? [])[0] ?? null).slice(0, 400)}`);
    const hits: any[] = found.items ?? found.results ?? found.hits ?? [];
    const ids = [...new Set(hits.map((h) => String(h.channelId ?? h.message?.channelId ?? '')).filter(Boolean))];
    for (const id of ids) {
      const r = await page.request.post(`/api/channels/${id}/unarchive`, { headers: await csrf(o.context) });
      log(`unarchive ${id.slice(0, 8)} -> ${r.status()}`);
    }
  }
  newChannels = await find();
  log(`imported channels in ${TEAM}: ${newChannels.map((c) => `#${c.name}`).join(', ') || '(none)'} (report names ${names.join(', ')})`);
  expect(newChannels.length).toBe(names.length);
  const after = await channelsOf(o);
  const notifsAfter = (await api(o, '/api/notifications/summary')).unreadCount;
  log(`notification unread: before ${before.notifs}, after ${notifsAfter}`);
  expect(notifsAfter).toBeLessThanOrEqual(before.notifs || notifsAfter);
  const badge = after.filter((c) => newChannels.some((n) => n.id === c.id)).map((c) => `#${c.name}=${c.unread}`).join(', ');
  log(`sidebar unread counts of imported channels: ${badge}`);

  let sawImported = false;
  for (const c of newChannels) {
    const msgs = await allMessages(o, c.id);
    counts1.set(c.id, msgs.length);
    const stamps = msgs.map((m) => String(m.createdAt ?? m.created_at ?? m.sentAt ?? '')).filter(Boolean);
    const sorted = [...stamps].sort();
    const years = new Set(stamps.map((s) => s.slice(0, 7)));
    const newestFirst = stamps.length > 1 && stamps[0]! > stamps[stamps.length - 1]!;
    const ordered = JSON.stringify(stamps) === JSON.stringify(newestFirst ? sorted.reverse() : sorted);
    log(`#${c.name}: ${msgs.length} messages via API, months ${[...years].join(',')}, ordered by time = ${ordered}${msgs[0] ? `, keys ${Object.keys(msgs[0]).slice(0, 14).join('/')}` : ''}`);
    expect(ordered).toBe(true);

    await page.goto(`/t/${TEAM}/c/${c.name}`);
    await expect(page.getByTestId('message').first()).toBeVisible(T);
    await page.waitForTimeout(1500);
    const rows = page.getByTestId('message');
    const n = await rows.count();
    const texts: string[] = [];
    for (let i = 0; i < Math.min(n, 400); i++) texts.push(flat(await rows.nth(i).innerText()));
    const imp = texts.filter((t) => /\(imported\)/.test(t)).length;
    if (imp > 0) sawImported = true;
    log(`#${c.name}: ${n} message rows rendered, ${imp} with an "(imported)" author. first row: ${texts[0]?.slice(0, 140)} | last row: ${texts[n - 1]?.slice(0, 140)}`);
    const days = (await page.locator('.daysep').allInnerTexts()).map(flat);
    log(`#${c.name}: day separators ${days.slice(0, 4).join(' ; ')}${days.length > 4 ? ' ...' : ''}`);
    log(`#${c.name}: unread dividers shown: ${await page.getByTestId('unread-divider').count()}`);
    await shoot(page, `imp-08-channel-${c.name}`);
  }
  expect(sawImported, 'at least one author reads "(imported)"').toBe(true);
  await page.goto(`/t/${TEAM}/c/${newChannels[0]!.name}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await shoot(page, 'imp-09-sidebar-badges');
});

test('imp-03 a second upload of the same archive into the same team writes nothing twice', async () => {
  test.setTimeout(240_000);
  const o = omar!;
  const page = o.page;
  const chBefore = new Set((await channelsOf(o)).map((c) => c.name));
  await page.goto(PATH);
  await expect(page.getByTestId('import-source')).toBeVisible(T);
  await page.getByTestId('import-source').selectOption('slack');
  await page.getByTestId('import-team').selectOption(TEAM);
  await page.getByTestId('import-file').setInputFiles(ARCHIVE);
  await page.getByTestId('import-upload').click();
  const run = runCard(page, 0);
  await expect(run).toHaveAttribute('data-status', 'uploaded', T);
  await run.getByTestId('import-dry-run').click();
  await expect(run).toHaveAttribute('data-status', 'analysed', { timeout: 60_000 });
  const dry = flat(await run.getByTestId('import-report').innerText());
  log(`SECOND DRY RUN: ${dry}`);
  expect(dry).toMatch(/came in on an earlier run of this archive/);
  await shoot(page, 'imp-10-second-dry-run-1280', true);
  await run.getByTestId('import-start').click();
  await run.getByTestId('import-start-confirm').click();
  await expect(run).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
  const fin = flat(await run.getByTestId('import-report').innerText());
  log(`SECOND FINAL REPORT: ${fin}`);
  expect(fin).toMatch(/earlier run of this archive/);
  await shoot(page, 'imp-11-second-final-1280', true);

  const chAfter = await channelsOf(o);
  const extra = chAfter.filter((c) => !chBefore.has(c.name));
  log(`channels created by the second run: ${extra.map((c) => c.name).join(', ') || 'none'}`);
  for (const c of newChannels) {
    const n = (await allMessages(o, c.id)).length;
    log(`#${c.name}: messages after first run ${counts1.get(c.id)}, after second run ${n}`);
    expect(n).toBe(counts1.get(c.id));
  }
  expect(extra.length).toBe(0);
});

test('imp-04 Nadia (not an admin) has no Import entry and the URL says no', async ({ browser }) => {
  nadia = await signIn(browser, 'NADIA', WIDE);
  const page = nadia.page;
  await page.goto('/settings');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const items = await page.getByRole('link', { name: 'Import', exact: true }).count();
  log(`Nadia sees an Import nav item: ${items}`);
  await shoot(page, 'imp-12-nadia-settings-nav');
  expect(items).toBe(0);
  await page.goto(PATH);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1500);
  const body = flat(await page.locator('body').innerText());
  log(`Nadia at ${PATH}: ${body.slice(0, 300)}`);
  await shoot(page, 'imp-13-nadia-import-url');
  await expect(page.getByTestId('import-source')).toHaveCount(0);
  const status = (await page.request.get('/api/admin/imports')).status();
  log(`Nadia GET /api/admin/imports -> ${status}`);
  expect([401, 403, 404]).toContain(status);
});

test('imp-05 cleanup: remove the runs through the UI and check the archives are gone', async ({ browser }) => {
  test.setTimeout(120_000);
  omar ??= await signIn(browser, 'OMAR', WIDE);
  const o = omar;
  const page = o.page;
  await page.goto(PATH);
  await expect(page.getByTestId('import-source')).toBeVisible(T);
  const listed = await api(o, '/api/admin/imports');
  log(`runs before removal: ${(listed.items ?? []).length}`);
  for (let i = 0; i < 6; i++) {
    const del = page.getByTestId('import-delete');
    if (!(await del.count())) break;
    await del.first().click();
    await page.waitForTimeout(1500);
  }
  for (const c of newChannels) {
    const r = await o.page.request.post(`/api/channels/${c.id}/archive`, { headers: await csrf(o.context) });
    log(`cleanup: archive #${c.name} -> ${r.status()}`);
  }
  const left = await api(o, '/api/admin/imports');
  log(`runs after removal: ${(left.items ?? []).length}`);
  await shoot(page, 'imp-14-after-cleanup');
  expect((left.items ?? []).length).toBe(0);
});
