/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live verification of Bundle B (Phase 21: the dark theme and the Appearance setting, avatars in Jump to / search / the bell, the Activity page, the
 * phone shell with its bottom bar, skeletons and empty states, Boards / Jobs / Org / Memory, message runs and the Compact density, and the Bundle A defects
 * that were fixed with it) on the deployed site.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts verify-bundle-b
 * Personas sign in through the sign-in form (<WHO>_EMAIL / <WHO>_PASSWORD from the environment, never printed). Shots go to MANYTHREADS_SHOTS_DIR
 * (default: verify-b/ in the scratchpad) as `<nn>-<name>.<1440|390>.<light|dark>.png`; every one is meant to be looked at. Each check writes a `PASS` or
 * a `FAIL` line (the list is in `results.txt`); the last test fails when one failed, after the clean-up. Everything the probe makes (a `verify-b-run`
 * channel, a test routine, a test chat, a direct message from Nadia, a look chosen for Omar) is removed or put back at the end and again in `afterAll`,
 * and an earlier failed run's leftovers are removed first.
 * A dark shot must not be the light page: the root says `data-theme="dark"` and the body background is not the light one (checked on every route).
 */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/verify-b';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

type Who = 'OMAR' | 'NADIA' | 'SAMEERA' | 'TARIQ';
type Vp = 'd' | 'm';
type Scheme = 'light' | 'dark';
const VIEW = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } } as const;
/** tokens.css `--paper` in each theme, as the browser reports it. */
const PAPER: Record<Scheme, string> = { light: 'rgb(237, 238, 240)', dark: 'rgb(15, 18, 22)' };
const states = new Map<Who, any>();
const results: string[] = [];
const fivexx: string[] = [];
let cleanDone = false;
/** The direct messages the probe's people made with each other, for the clean-up. */
const dmIds: string[] = [];

const pass = (name: string, detail = ''): void => {
  results.push(`PASS ${name}${detail ? ` (${detail})` : ''}`);
  log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
};
const fail = (name: string, detail: string): void => {
  results.push(`FAIL ${name}: ${detail}`);
  log(`FAIL ${name}: ${detail}`);
};
/** Records a check without stopping the probe: the rest of the screens are still looked at. */
function check(name: string, ok: boolean, detail = ''): boolean {
  if (ok) pass(name, detail);
  else fail(name, detail);
  return ok;
}

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

async function open(browser: Browser, who: Who, vp: Vp = 'd', scheme: Scheme = 'light', init?: () => void): Promise<{ ctx: BrowserContext; page: Page }> {
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
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) {
      fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message.slice(0, 200)}`));
  return { ctx, page };
}

const csrf = async (ctx: BrowserContext): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => /csrf/i.test(x.name));
  return c ? { 'x-csrf-token': c.value } : {};
};
const api = async (ctx: BrowserContext, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<{ status: number; json: any }> => {
  const res = await ctx.request.fetch(path, { method, ...(data !== undefined ? { data } : {}), headers: await csrf(ctx) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status(), json };
};
const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(700);
};
const tag = (vp: Vp, scheme: Scheme): string => `${vp === 'd' ? '1440' : '390'}.${scheme}`;
async function shoot(page: Page, name: string, vp: Vp, scheme: Scheme): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT, `${name}.${tag(vp, scheme)}.png`) });
  log(`shot ${name}.${tag(vp, scheme)}`);
}
const rootLook = (page: Page): Promise<{ theme: string | null; paper: string; ink: string }> =>
  page.evaluate(() => ({ theme: document.documentElement.getAttribute('data-theme'), paper: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }));
const sideways = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

/** Puts Omar's saved look back (System, Comfortable): what he had before the probe. */
async function restoreLook(browser: Browser): Promise<void> {
  const { ctx } = await open(browser, 'OMAR');
  try {
    const r = await api(ctx, 'PUT', '/api/me/appearance', { theme: 'system', density: 'comfortable' });
    log(`look put back: ${r.status}`);
  } finally {
    await ctx.close();
  }
}

/** Archives the channels this probe (or an earlier one) made, deletes its routines and its chat, as the person who made them. */
async function clean(browser: Browser): Promise<void> {
  if (cleanDone) return;
  const omar = await open(browser, 'OMAR');
  try {
    const dir = await api(omar.ctx, 'GET', '/api/teams/engineering/channels');
    const names: Array<{ id: string; name: string }> = ((dir.json?.groups ?? []) as any[]).flatMap((g) => g.channels ?? []);
    for (const c of names.filter((x) => /^#?verify-b-/.test(x.name))) {
      const r = await api(omar.ctx, 'POST', `/api/channels/${c.id}/archive`);
      log(`archived ${c.name}: ${r.status}`);
    }
  } finally {
    await omar.ctx.close();
  }
  const nadia = await open(browser, 'NADIA');
  try {
    const jobs = await api(nadia.ctx, 'GET', '/api/me/scheduled-jobs');
    for (const j of ((jobs.json?.items ?? []) as any[]).filter((x) => /^Verify B /.test(x.name ?? ''))) {
      const r = await api(nadia.ctx, 'DELETE', `/api/me/scheduled-jobs/${j.id}`);
      log(`routine ${j.name} deleted: ${r.status}`);
    }
    await nadia.page.goto('/t/engineering/chat?bot=brain');
    await settle(nadia.page);
    for (let i = 0; i < 4; i += 1) {
      const row = nadia.page.getByTestId('chat-row').filter({ hasText: 'Verification run' }).first();
      if ((await row.count()) === 0) break;
      await row.hover();
      await row.getByTestId('chat-row-menu').click();
      await nadia.page.getByTestId('chat-menu-delete').click();
      await nadia.page.waitForTimeout(1000);
    }
    // the direct message the probe sent Omar: its own messages only
    for (const dm of dmIds) {
      const list = await api(nadia.ctx, 'GET', `/api/channels/${dm}/messages?limit=30`);
      for (const m of ((list.json?.items ?? list.json?.messages ?? []) as any[]).filter((x) => /^verify-b /.test(x.body ?? x.bodyPlain ?? ''))) {
        const r = await api(nadia.ctx, 'DELETE', `/api/channels/${dm}/messages/${m.id}`);
        log(`probe message deleted: ${r.status}`);
      }
    }
  } finally {
    await nadia.ctx.close();
  }
  await restoreLook(browser);
  cleanDone = true;
}
test.beforeAll(async ({ browser }) => {
  // an earlier run that stopped half way leaves nothing behind
  await clean(browser).catch((e: Error) => log(`pre-clean: ${e.message.slice(0, 160)}`));
  cleanDone = false;
});
test.afterAll(async ({ browser }) => {
  await clean(browser).catch((e: Error) => log(`CLEANUP FAILED ${e.message.slice(0, 200)}`));
  log(`5xx responses: ${fivexx.length} ${fivexx.slice(0, 10).join(' | ')}`);
  writeFileSync(join(OUT, 'results.txt'), results.join('\n') + '\n');
});

test('01 Omar: Account, Appearance, Dark: no light frame on reload, and it holds on a phone', async ({ browser }) => {
  // the first animation frame of every load records what the root and the body are painted with
  const record = (): void => {
    const frames: Array<{ theme: string | null; body: string }> = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const tick = (): void => {
      frames.push({ theme: document.documentElement.getAttribute('data-theme'), body: document.body ? getComputedStyle(document.body).backgroundColor : '' });
      if (frames.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  // the device says light; the person's own choice is Dark and must win
  const { ctx, page } = await open(browser, 'OMAR', 'd', 'light', record);
  try {
    await page.goto('/account/appearance');
    await expect(page.getByTestId('appearance-theme')).toBeVisible(T);
    await shoot(page, '01-appearance-before', 'd', 'light');
    await page.getByTestId('appearance-theme-dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark', T);
    await shoot(page, '02-appearance-dark', 'd', 'dark');
    await page.reload();
    await expect(page.getByTestId('app-frame')).toBeVisible(T);
    await expect.poll(() => page.evaluate(() => (window as any).__frames?.length ?? 0), T).toBeGreaterThanOrEqual(20);
    const frames: Array<{ theme: string | null; body: string }> = await page.evaluate(() => (window as any).__frames);
    check('01 dark chosen on a light device survives a reload with no light frame', frames.every((f) => f.theme === 'dark') && frames.every((f) => f.body !== PAPER.light), JSON.stringify(frames.slice(0, 2)));
    const look = await rootLook(page);
    check('01 the dark page paints the dark paper', look.paper === PAPER.dark, look.paper);
    // the choice is the person's, not the device's: a fresh context with a light device reads Dark from the session
    const second = await open(browser, 'OMAR', 'd', 'light');
    try {
      await second.page.goto('/t/engineering/threads');
      await expect(second.page.getByTestId('app-frame')).toBeVisible(T);
      check('01 a new browser (light device) shows Dark: the choice is stored with the person', (await rootLook(second.page)).theme === 'dark');
    } finally {
      await second.ctx.close();
    }
    const phone = await open(browser, 'OMAR', 'm', 'light');
    try {
      await phone.page.goto('/t/engineering/threads');
      await expect(phone.page.getByTestId('app-frame')).toBeVisible(T);
      await shoot(phone.page, '03-threads-dark-choice', 'm', 'dark');
      check('01 the choice holds at 390', (await rootLook(phone.page)).paper === PAPER.dark);
    } finally {
      await phone.ctx.close();
    }
    // Light is chosen for the second pass of every later check
    await page.goto('/account/appearance');
    await page.getByTestId('appearance-theme-light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light', T);
    check('01 Light chosen again', (await rootLook(page)).paper === PAPER.light);
  } finally {
    await ctx.close();
  }
});

/** Routes of the route scan: [name, path, phone only]. A path with `{channel}` is made from the channel list. */
const ROUTES: Array<[string, string]> = [
  ['threads', '/t/engineering/threads'],
  ['channel', '/t/engineering/c/{channel}'],
  ['messages', '/t/engineering/dms'],
  ['activity', '/t/engineering/activity'],
  ['search', '/t/engineering/search?q=release'],
  ['files-team', '/t/engineering/files'],
  ['files-personal', '/files'],
  ['boards', '/t/engineering/boards'],
  ['org', '/t/engineering/org'],
  ['jobs', '/t/engineering/jobs'],
  ['approvals', '/t/engineering/approvals'],
  ['bots', '/t/engineering/bots'],
  ['recipes', '/t/engineering/recipes'],
  ['memory', '/t/engineering/memory'],
  ['knowledge', '/t/engineering/knowledge'],
  ['chat', '/t/engineering/chat'],
  ['settings-general', '/settings/workspace/general'],
  ['settings-members', '/settings/workspace/members'],
  ['settings-health', '/settings/workspace/health'],
  ['settings-audit', '/settings/workspace/audit'],
  ['settings-usage', '/settings/workspace/usage'],
  ['account-profile', '/account/profile'],
  ['account-appearance', '/account/appearance'],
  ['account-notifications', '/account/notifications'],
  ['account-security', '/account/security'],
  ['account-bots', '/account/bots'],
  ['account-routines', '/account/routines'],
  ['account-actions', '/account/action-items'],
  ['teams', '/teams'],
];

test('02 Omar: the route scan, light and dark, at 1440 and 390', async ({ browser }) => {
  test.setTimeout(1_500_000);
  const first = await open(browser, 'OMAR');
  let channel = 'general';
  try {
    const dir = await api(first.ctx, 'GET', '/api/teams/engineering/channels');
    const names: string[] = ((dir.json?.groups ?? []) as any[]).flatMap((g) => g.channels ?? []).map((c: any) => String(c.name).replace(/^#/, ''));
    channel = names.includes('general') ? 'general' : (names[0] ?? 'general');
  } finally {
    await first.ctx.close();
  }
  const papers: Record<string, Partial<Record<Scheme, string>>> = {};
  let n = 0;
  for (const vp of ['d', 'm'] as Vp[]) {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      // the saved look is System for the scan, so the device decides: the same route is the light page in one pass and the dark page in the other
      const { ctx, page } = await open(browser, 'OMAR', vp, scheme);
      try {
        await api(ctx, 'PUT', '/api/me/appearance', { theme: 'system', density: 'comfortable' });
        for (const [name, raw] of ROUTES) {
          if (name === 'activity' && vp === 'd') continue; // the Activity page is the phone's; the bell is its wide twin
          const path = raw.replace('{channel}', channel);
          n += 1;
          const label = `02 ${name} ${tag(vp, scheme)}`;
          const resp = await page.goto(path).catch(() => null);
          await settle(page);
          const status = resp?.status() ?? 0;
          const look = await rootLook(page);
          const h1 = await page.locator('h1:visible').count();
          const loading = await page.getByText(/^Loading…?$/).filter({ visible: true }).count();
          const problems: string[] = [];
          if (status >= 500) problems.push(`status ${status}`);
          if (look.theme !== scheme) problems.push(`data-theme ${look.theme}`);
          if (look.paper !== PAPER[scheme]) problems.push(`paper ${look.paper}`);
          if (h1 !== 1) problems.push(`${h1} visible h1`);
          if (loading > 0) problems.push('still says Loading');
          if (await sideways(page)) problems.push('scrolls sideways');
          (papers[name] ??= {})[scheme] = look.paper + look.ink;
          if (vp === 'm' && /^\/t\/engineering\/(c\/|dms|threads|activity)/.test(path)) {
            const small = await page.evaluate(() =>
              Array.from(document.querySelectorAll('.chead button'))
                .filter((e) => (e as HTMLElement).offsetParent !== null)
                .map((e) => ({ n: e.getAttribute('aria-label') ?? '', w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height }))
                .filter((s) => s.w < 39.5 || s.h < 39.5),
            );
            if (small.length > 0) problems.push(`header controls under 40 px: ${small.map((s) => s.n).join(', ')}`);
            const searchIcons = await page.locator('.chead button[aria-label*="earch"], .chead button[aria-label="Find"]').count();
            if (searchIcons > 1) problems.push(`${searchIcons} search icons in the header`);
          }
          check(label, problems.length === 0, problems.join('; '));
          // a picture of the main ones, the rest is checked without a shot to keep the folder readable
          if (['threads', 'channel', 'boards', 'org', 'jobs', 'memory', 'bots', 'approvals', 'recipes', 'settings-health', 'account-appearance', 'files-team', 'chat', 'activity'].includes(name)) await shoot(page, `10-${name}`, vp, scheme);
        }
      } finally {
        await ctx.close();
      }
    }
  }
  // a dark shot is not the light page: for every route the two passes differ in background and in ink
  const same = Object.entries(papers).filter(([, p]) => p.light !== undefined && p.light === p.dark).map(([name]) => name);
  check('02 on every route the dark page differs from the light page', same.length === 0, same.join(', '));
  log(`route scan: ${n} loads`);
  // the sign-in page, signed out
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const ctx = await browser.newContext({ baseURL: BASE, viewport: VIEW.d, colorScheme: scheme, ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    try {
      await page.goto('/sign-in');
      await expect(page.getByLabel('Email')).toBeVisible(T);
      await shoot(page, '11-signin', 'd', scheme);
      const look = await rootLook(page);
      check(`02 sign-in signed out ${scheme}`, look.theme === scheme && look.paper === PAPER[scheme], `${look.theme} ${look.paper}`);
    } finally {
      await ctx.close();
    }
  }
});

test('03 Omar: Compact is at most 70% as tall as Comfortable (a probe channel, eight messages)', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'OMAR');
  try {
    const name = `verify-b-run-${sfx}`;
    const made = await api(ctx, 'POST', '/api/teams/engineering/channels', { name });
    const id: string = made.json?.channel?.id;
    check('03 probe channel made', made.status < 300 && !!id, `status ${made.status}`);
    for (let i = 1; i <= 8; i += 1) await api(ctx, 'POST', `/api/channels/${id}/messages`, { channelId: id, body: `verify-b run line ${i}`, threadRootId: null });
    const heightOf = async (density: 'comfortable' | 'compact'): Promise<number> => {
      await api(ctx, 'PUT', '/api/me/appearance', { theme: 'light', density });
      await page.goto(`/t/engineering/c/${name}`);
      await expect(page.getByTestId('message')).toHaveCount(8, T);
      await settle(page);
      return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="message"]')) as HTMLElement[];
        return rows[rows.length - 1]!.getBoundingClientRect().bottom - rows[0]!.getBoundingClientRect().top;
      });
    };
    const comfortable = await heightOf('comfortable');
    await shoot(page, '20-run-comfortable', 'd', 'light');
    const compact = await heightOf('compact');
    await shoot(page, '21-run-compact', 'd', 'light');
    check('03 Compact height is at most 70% of Comfortable', compact <= comfortable * 0.7, `${Math.round(compact)} px against ${Math.round(comfortable)} px`);
    await api(ctx, 'PUT', '/api/me/appearance', { theme: 'light', density: 'comfortable' });
    const archived = await api(ctx, 'POST', `/api/channels/${id}/archive`);
    check('03 probe channel archived', archived.status < 300, `status ${archived.status}`);
  } finally {
    await ctx.close();
  }
});

/** One finger from (x0, y0) to (x1, y1): what a real swipe sends the browser. */
async function swipe(page: Page, from: [number, number], to: [number, number], hold = 0): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number) => [{ x, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(...from) });
  if (hold > 0) await page.waitForTimeout(hold);
  for (let i = 1; i <= 6; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6) });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test('04 the phone: bottom bar, Messages badge, Activity, edge swipe, swipe to reply, long press', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const { ctx, page } = await open(browser, 'OMAR', 'm', scheme);
    try {
      await api(ctx, 'PUT', '/api/me/appearance', { theme: 'system', density: 'comfortable' });
      await page.goto('/t/engineering/threads');
      const bar = page.getByRole('navigation', { name: 'Main' });
      await expect(bar).toBeVisible(T);
      const labels = await bar.locator('.bb-item .bb-label').allTextContents();
      check(`04 bottom bar has five entries (${scheme})`, labels.join(',') === 'Home,Messages,Activity,Search,You', labels.join(','));
      await shoot(page, '30-bottom-bar', 'm', scheme);
      if (scheme === 'light') {
        // Nadia writes Omar a direct message: the Messages entry gets a badge of 1 and Activity lists a mention with a count
        const nadia = await open(browser, 'NADIA');
        try {
          const me = await api(ctx, 'GET', '/api/session');
          const dm = await api(nadia.ctx, 'POST', '/api/dms', { personIds: [me.json.person.id] });
          const channelId: string = dm.json?.dm?.channel?.id;
          dmIds.push(channelId);
          const badge = bar.getByTestId('bar-messages').locator('.pill');
          for (let tries = 0; tries < 4 && (await badge.count()) === 0; tries += 1) {
            await api(nadia.ctx, 'POST', `/api/channels/${channelId}/messages`, { channelId, body: `verify-b hello ${tries}`, threadRootId: null });
            await badge.waitFor({ timeout: 6000 }).catch(() => undefined);
          }
          check('04 Messages shows a badge for an unread direct message', (await badge.count()) > 0 && /^[1-9]/.test((await badge.first().innerText()).trim()), (await badge.first().innerText().catch(() => 'none')).trim());
          await shoot(page, '31-bar-badge', 'm', scheme);
          await bar.getByRole('link', { name: /Messages/ }).click();
          await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible(T);
          await shoot(page, '32-messages', 'm', scheme);
          // a mention: Nadia mentions Omar in a probe channel's message; Activity lists it with a count
          const made = await api(ctx, 'POST', '/api/teams/engineering/channels', { name: `verify-b-act-${sfx}` });
          const chan: string = made.json?.channel?.id;
          await api(ctx, 'POST', `/api/channels/${chan}/join`).catch(() => undefined);
          await api(nadia.ctx, 'POST', `/api/channels/${chan}/join`).catch(() => undefined);
          await api(nadia.ctx, 'POST', `/api/channels/${chan}/messages`, { channelId: chan, body: 'verify-b @Omar can you look at this', threadRootId: null });
          await page.waitForTimeout(2500);
          await bar.getByRole('link', { name: /Activity/ }).click();
          await expect(page).toHaveURL(/\/activity$/, T);
          await settle(page);
          const activity = (await page.locator('[data-landmark="content"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
          check('04 Activity lists the mention', /verify-b|Omar|mention/i.test(activity), activity.slice(0, 120));
          const counts = await bar.getByTestId('bar-activity').locator('.pill').allInnerTexts().catch(() => [] as string[]);
          check('04 Activity entry carries a count', counts.length > 0, counts.join(','));
          await shoot(page, '33-activity', 'm', scheme);
        } finally {
          await nadia.ctx.close();
        }
      }
      // the edge swipe opens the drawer; the same swipe from the middle does not
      await page.goto('/t/engineering/threads');
      await expect(bar).toBeVisible(T);
      await swipe(page, [150, 300], [320, 304]);
      await page.waitForTimeout(400);
      check(`04 a swipe from the middle does not open the drawer (${scheme})`, (await page.locator('.frame').getAttribute('data-drawer')) !== 'open');
      await swipe(page, [4, 400], [180, 410]);
      await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'open', T).then(() => pass(`04 edge swipe opens the drawer (${scheme})`), () => fail(`04 edge swipe opens the drawer (${scheme})`, 'the drawer did not open'));
      await shoot(page, '34-drawer', 'm', scheme);
    } finally {
      await ctx.close();
    }
  }
  // swipe right on a message opens its thread; a long press opens the reactions (nothing is added)
  const { ctx, page } = await open(browser, 'OMAR', 'm', 'light');
  try {
    const made = await api(ctx, 'POST', '/api/teams/engineering/channels', { name: `verify-b-touch-${sfx}` });
    const id: string = made.json?.channel?.id;
    await api(ctx, 'POST', `/api/channels/${id}/messages`, { channelId: id, body: 'verify-b swipe me', threadRootId: null });
    await page.goto(`/t/engineering/c/verify-b-touch-${sfx}`);
    const row = page.getByTestId('message').filter({ hasText: 'verify-b swipe me' });
    await expect(row).toBeVisible(T);
    await settle(page);
    // the finger goes down on the words of the message, not on the author's name (a name is a button and keeps its own touch behaviour)
    const box = (await row.getByText('verify-b swipe me').boundingBox())!;
    await swipe(page, [box.x + 10, box.y + box.height / 2], [box.x + 210, box.y + box.height / 2 + 2]);
    const opened = await page.getByTestId('thread-view').waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
    check('04 a swipe right on a message opens its thread to reply', opened);
    await shoot(page, '35-swipe-reply', 'm', 'light');
    if (opened) {
      await page.getByRole('button', { name: 'Close panel' }).click().catch(() => undefined);
      await expect(page.getByTestId('thread-view')).toBeHidden(T).catch(() => undefined);
    }
    await swipe(page, [box.x + 20, box.y + box.height / 2], [box.x + 21, box.y + box.height / 2], 700);
    await page.waitForTimeout(500);
    const picker = await page.getByRole('menu').or(page.getByRole('dialog')).first().isVisible().catch(() => false);
    check('04 a long press on a message opens the reactions', picker);
    await shoot(page, '36-long-press', 'm', 'light');
    check('04 the long press added no reaction', (await row.locator('.rx:not(.rx-add)').count()) === 0);
    await page.keyboard.press('Escape');
  } finally {
    await ctx.close();
  }
});

test('05 a three-message DM, a long channel name at 390, Sameera\'s rail search, the files crumb trail', async ({ browser }) => {
  const nadia = await open(browser, 'NADIA');
  const omar = await open(browser, 'OMAR', 'm', 'light');
  try {
    // a direct message with three messages: no pill sits over "Today"
    const me = await api(omar.ctx, 'GET', '/api/session');
    const dm = await api(nadia.ctx, 'POST', '/api/dms', { personIds: [me.json.person.id] });
    const dmId: string = dm.json?.dm?.channel?.id;
    dmIds.push(dmId);
    for (let i = 1; i <= 3; i += 1) await api(nadia.ctx, 'POST', `/api/channels/${dmId}/messages`, { channelId: dmId, body: `verify-b three ${i}`, threadRootId: null });
    await omar.page.goto('/t/engineering/dms');
    await settle(omar.page);
    await omar.page.getByTestId('messages-screen').getByRole('link', { name: /Nadia/ }).first().click();
    await expect(omar.page.getByTestId('message').first()).toBeVisible(T);
    await settle(omar.page);
    const overlaps = await omar.page.evaluate(() => {
      const pills = Array.from(document.querySelectorAll('.vlist-pill, [data-testid="jump-first-unread"], [data-testid="jump-latest"], [data-testid="day-pill"]')).filter((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement[];
      const days = Array.from(document.querySelectorAll('[data-testid="day-divider"]')) as HTMLElement[];
      const hits: string[] = [];
      for (const p of pills) for (const d of days) {
        const a = p.getBoundingClientRect();
        const b = d.getBoundingClientRect();
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) hits.push(`${p.getAttribute('data-testid') ?? p.className} over ${d.textContent?.trim()}`);
      }
      return hits;
    });
    check('05 a three-message DM: no pill over the day line', overlaps.length === 0, overlaps.join('; '));
    await shoot(omar.page, '40-dm-three', 'm', 'light');

    // a probe channel with a 40-character name: the full name reads at 390
    const longName = `verify-b-${sfx}-${'long-name-'.repeat(3)}`.slice(0, 40);
    const made = await api(omar.ctx, 'POST', '/api/teams/engineering/channels', { name: longName });
    check('05 long-named probe channel made', made.status < 300, `status ${made.status}`);
    await omar.page.goto(`/t/engineering/c/${longName}`);
    await expect(omar.page.locator('.chead .chd-name')).toBeVisible(T);
    const shown = (await omar.page.locator('.chead .chd-name').innerText()).replace(/\s+/g, '');
    check('05 a 40-character channel name reads in full at 390', shown.replace(/^#/, '').includes(longName), shown);
    await shoot(omar.page, '41-long-name', 'm', 'light');
    if (made.json?.channel?.id) await api(omar.ctx, 'POST', `/api/channels/${made.json.channel.id}/archive`);
  } finally {
    await omar.ctx.close();
    await nadia.ctx.close();
  }
  // Sameera on Customer support: the rail search shows an ellipsis or the whole text, never a cut glyph
  const sameera = await open(browser, 'SAMEERA', 'd', 'light');
  try {
    await sameera.page.goto('/');
    await settle(sameera.page);
    const teamLink = sameera.page.locator('[data-landmark="sidebar"]').first();
    await expect(teamLink).toBeVisible(T);
    const input = sameera.page.locator('[data-landmark="search"]').getByRole('searchbox');
    const overflow = await input.evaluate((el) => getComputedStyle(el).textOverflow);
    const title = await sameera.page.locator('[data-landmark="search"]').getAttribute('title');
    check('05 the rail search ends in an ellipsis and keeps the whole text in a tooltip', overflow === 'ellipsis' && /^Search /.test(title ?? ''), `${overflow}; ${title}`);
    await shoot(sameera.page, '42-sameera-rail', 'd', 'light');
  } finally {
    await sameera.ctx.close();
  }
  // the files crumb trail has a "/" between every pair
  const files = await open(browser, 'OMAR', 'd', 'light');
  try {
    await files.page.goto('/files');
    await settle(files.page);
    // the root has one crumb; a folder inside it makes two, with a "/" between them
    await files.page.getByTestId('file-row').filter({ hasText: 'Notes' }).first().click();
    await expect(files.page).toHaveURL(/path=Notes/, T);
    await settle(files.page);
    const crumbs = files.page.getByTestId('breadcrumb').first();
    const text = (await crumbs.innerText().catch(() => '')).replace(/\s+/g, ' ');
    const parts = text.split('/').map((s) => s.trim()).filter(Boolean);
    check('05 the files crumb trail shows "/" between the crumbs', parts.length >= 2, text);
    await shoot(files.page, '43-files-crumbs', 'd', 'light');
  } finally {
    await files.ctx.close();
  }
});

test('06 Nadia: Chat with Brain: no reply actions while the answer is written, they appear when it is done, no "Citation:" line', async ({ browser }) => {
  test.setTimeout(480_000);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/t/engineering/chat?bot=brain');
    await expect(page.getByTestId('chat-screen')).toBeVisible(T);
    const box = page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' });
    await box.click();
    await box.fill('Verification run, please ignore: in two short paragraphs, say what a channel is for. Do not use any tools.');
    await box.press('Enter');
    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/, T);
    // while it is live: no reply actions on that answer
    let early = 0;
    let sawLive = false;
    const start = Date.now();
    while (Date.now() - start < 150_000) {
      const live = (await page.getByTestId('chat-streaming').count()) + (await page.getByTestId('chat-stop').count());
      if (live > 0) {
        sawLive = true;
        early += await page.getByTestId('chat-reply-actions').count();
      }
      if ((await page.getByTestId('chat-reply-actions').count()) > 0 && live === 0) break;
      await page.waitForTimeout(250);
    }
    if (sawLive) check('06 no reply actions while the answer is being written', early === 0, `${early} sightings`);
    else log('06 the answer finished before it could be sampled live (not counted)');
    await expect(page.getByTestId('chat-reply-actions').last()).toBeVisible({ timeout: 150_000 }).then(() => pass('06 reply actions appear when the answer is done'), () => fail('06 reply actions appear when the answer is done', 'none within 150 s'));
    const body = (await page.locator('[data-testid="chat-message"][data-role="bot"]').last().innerText().catch(() => '')).split('\n');
    check('06 the answer has no line starting with "Citation:"', !body.some((l) => /^\s*Citation:/i.test(l)), body.slice(0, 3).join(' / ').slice(0, 120));
    await shoot(page, '50-chat-answer', 'd', 'light');
  } finally {
    await ctx.close();
  }
  // Account, Security: the chip reads "Email and password" with a check
  const sec = await open(browser, 'NADIA', 'd', 'light');
  try {
    await sec.page.goto('/account/security');
    await expect(sec.page.getByTestId('signin-method').first()).toBeVisible(T);
    const chip = ((await sec.page.getByTestId('signin-method').first().getAttribute('aria-label')) ?? '') + ' ' + (await sec.page.getByTestId('signin-method').first().innerText());
    check('06 the Security chip reads Email and password', /email and password/i.test(chip), chip.replace(/\s+/g, ' ').trim().slice(0, 100));
    await shoot(sec.page, '51-security-chip', 'd', 'light');
  } finally {
    await sec.ctx.close();
  }
});

test('07 Nadia: a routine in words is written by the assistant; create it, then delete it: no Routines folder is left', async ({ browser }) => {
  test.setTimeout(420_000);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/account/routines');
    await page.getByTestId('routine-new').click();
    await page.getByTestId('routine-sentence').fill('Every weekday at 7, list what needs a reply');
    await page.getByTestId('routine-propose').click();
    const plan = page.getByTestId('dialog-routine-plan');
    const err = page.getByTestId('routine-propose-error');
    await expect(plan.or(err)).toBeVisible({ timeout: 120_000 });
    if (await err.isVisible().catch(() => false)) {
      fail('07 a routine in words reaches the model', (await err.innerText()).slice(0, 200));
      return;
    }
    const planText = (await plan.innerText()).replace(/\s+/g, ' ');
    check('07 the plan was written by the assistant, not by plain rules', (await page.getByTestId('routine-by-rules').count()) === 0 && !/was not available|plain rules/i.test(planText), planText.slice(0, 160));
    await shoot(page, '60-routine-plan', 'd', 'light');
    const name = `Verify B ${sfx}`;
    await page.getByTestId('routine-name').fill(name);
    await page.getByTestId('routine-confirm').click();
    const row = page.locator('[data-testid="routine"]').filter({ hasText: name });
    await expect(row).toHaveCount(1, T);
    const pause = row.getByTestId('routine-pause');
    if (await pause.isVisible().catch(() => false)) await pause.click();
    const jobs = await api(ctx, 'GET', '/api/me/scheduled-jobs');
    const mine = ((jobs.json?.items ?? []) as any[]).find((j) => j.name === name);
    check('07 the routine exists', !!mine);
    const slug: string = mine?.slug ?? '';
    const folderBefore = await api(ctx, 'GET', '/api/me/files/tree?path=Routines');
    log(`Routines folder before delete: ${folderBefore.status} ${JSON.stringify(folderBefore.json).slice(0, 200)}`);
    await shoot(page, '61-routine-created', 'd', 'light');
    await row.getByTestId('routine-delete').click();
    await row.getByTestId('routine-delete-yes').click();
    await expect(page.locator('[data-testid="routine"]').filter({ hasText: name })).toHaveCount(0, T);
    await page.waitForTimeout(2500);
    const folderAfter = await api(ctx, 'GET', '/api/me/files/tree?path=Routines');
    const entries: any[] = folderAfter.json?.folder?.entries ?? folderAfter.json?.entries ?? folderAfter.json?.items ?? [];
    check('07 the deleted routine left no folder in Personal', slug !== '' && !entries.some((e) => e.name === slug), `${slug}; ${entries.map((e) => e.name).join(',')}`);
  } finally {
    await ctx.close();
  }
});

test('08 Tariq (Marketing): empty Boards and Jobs, the org chart grid; Omar: Memory preview, Jump to, the bell', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    for (const vp of ['d', 'm'] as Vp[]) {
      const { ctx, page } = await open(browser, 'TARIQ', vp, scheme);
      try {
        for (const [name, path] of [['boards', '/t/marketing/boards'], ['jobs', '/t/marketing/jobs'], ['org', '/t/marketing/org']] as const) {
          await page.goto(path);
          await expect(page.locator('h1:visible')).toHaveCount(1, T);
          await settle(page);
          const text = (await page.locator('[data-landmark="content"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
          const look = await rootLook(page);
          check(`08 Marketing ${name} ${tag(vp, scheme)}`, look.paper === PAPER[scheme] && !(await sideways(page)), text.slice(0, 90));
          await shoot(page, `70-marketing-${name}`, vp, scheme);
        }
      } finally {
        await ctx.close();
      }
    }
  }
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const { ctx, page } = await open(browser, 'OMAR', 'd', scheme);
    try {
      await page.goto('/t/engineering/memory');
      await expect(page.locator('h1:visible')).toHaveCount(1, T);
      await settle(page);
      const rows = page.locator('[data-testid="concept-row"], [data-testid="memory-concept"]');
      if ((await rows.count()) > 0) {
        await rows.first().click();
        await settle(page);
      }
      await shoot(page, '71-memory-preview', 'd', scheme);
      // Jump to: avatars beside people and bots
      await page.keyboard.press('Control+k');
      const jump = page.getByRole('dialog').first();
      await expect(jump).toBeVisible(T);
      await page.keyboard.type('a');
      await page.waitForTimeout(700);
      const avatars = await jump.locator('.av, [data-testid="avatar"]').count();
      check(`08 Jump to shows avatars (${scheme})`, avatars > 0, `${avatars} avatars`);
      await shoot(page, '72-jump-to', 'd', scheme);
      await page.keyboard.press('Escape');
      // the bell
      await page.getByTestId('bell').click();
      await expect(page.getByTestId('notifications-popover')).toBeVisible(T);
      await shoot(page, '73-bell', 'd', scheme);
      check(`08 the bell opens with Unread and All (${scheme})`, (await page.getByTestId('notifications-popover').locator('.ntf-tabs button').count()) === 2);
    } finally {
      await ctx.close();
    }
  }
});

test('99 cleanup and verdict: probe leftovers removed, Omar\'s look put back, no check failed', async ({ browser }) => {
  cleanDone = false;
  await clean(browser);
  const failed = results.filter((r) => r.startsWith('FAIL'));
  log(`${results.length - failed.length} PASS, ${failed.length} FAIL`);
  writeFileSync(join(OUT, 'results.txt'), results.join('\n') + '\n');
  expect(failed, failed.join('\n')).toEqual([]);
  expect(fivexx, '5xx responses').toEqual([]);
});
