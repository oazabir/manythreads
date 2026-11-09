/* eslint-disable @typescript-eslint/no-explicit-any -- live probe: the answers of the site and of the stand-ins are read as loose JSON */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { sendWebhook } from '../../tools/fake-saas/src/providers/sender.ts';
import { PERSONA_PASSWORD, personaEmail, type PersonaKey } from '../support/env.ts';

/*
 * Live verification of Bundle D (connectors: work-app triggers, planned rooms, documents from apps, chat apps, the admin screens, offboarding). PLAN P16-12, plan section 7.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts verify-bundle-d --retries=0 --workers=1
 * and, with the throwaway stage release up (tools/devbox/stage.sh up: a port-forward on 18080, tools/fake-saas on 10.0.2.15:18090-18091), the same command with
 *   MANYTHREADS_STAGE_URL=http://127.0.0.1:18080 FAKE_SAAS_CONTROL=http://10.0.2.15:18091
 *
 * SAFETY (the owner approved only the throwaway stage release for live checks):
 *  - Block A runs against PRODUCTION and is READ-ONLY. It signs in (each person once), opens pages and dialogs and reads. Every browser context it opens for production aborts any
 *    request that is not GET/HEAD/OPTIONS, and `api()` refuses a non-GET call on a production context; the only other request it makes is one POST that cannot write: a work-app door and
 *    a chat-app door given a random id, which both answer 404 for an address that does not exist. It makes no endpoint, bot, channel, connection, plan or message, and
 *    sends no webhook to a real address. Nothing in block A is cleaned up because nothing is made.
 *  - Block B (and everything that writes) runs ONLY against the stage release. It refuses to run unless MANYTHREADS_STAGE_URL and FAKE_SAAS_CONTROL both point at a loopback or private
 *    address (never a public host, never the production host), the stand-ins' control port answers (fake-saas never runs in production), and the two are not the production address.
 * Block B's things are named `verify-d-*` and removed at the end (a reset of the stage is `tools/devbox/stage.sh down`).
 * Persons of block A sign in through the sign-in form (<WHO>_EMAIL / <WHO>_PASSWORD from the environment, never printed); block B uses the personas of the test seed.
 * Shots go to MANYTHREADS_SHOTS_DIR (default temp/screenshots/verify-d) as `<nn>-<name>.<1440|390>.<light|dark>.png`; every one is meant to be looked at.
 * Each check writes `PASS`, `FAIL` or `SKIPPED: reason` (the list is in `results.txt`); the last test fails when a check failed. Nothing here is known to pass.
 */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const STAGE = (process.env['MANYTHREADS_STAGE_URL'] ?? '').replace(/\/+$/, '');
const CONTROL = (process.env['FAKE_SAAS_CONTROL'] ?? '').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'verify-d');
const SYNC_WAIT_MIN = Number(process.env['VERIFY_D_SYNC_WAIT_MIN'] ?? '11');
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

type Who = 'OMAR' | 'NADIA' | 'RAFI' | 'SAMEERA' | 'PRIYA' | 'LENA';
type Vp = 'd' | 'm';
type Scheme = 'light' | 'dark';
type Site = 'prod' | 'stage';
const VIEW = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } } as const;
const results: string[] = [];
const fivexx: string[] = [];
const browsers = new Map<string, Browser>();
const states = new Map<string, any>();
let stageUp = false;
let stageWhy = 'MANYTHREADS_STAGE_URL is not set';

/** A loopback or private-network host: the only kind of address the stage may have (the devbox's port-forward, the stand-ins at 10.0.2.15). */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
/** Why `url` may not be used as the stage (empty: it may). The production address, any public host and any address that is not plain http(s) are refused. */
function whyNotStage(url: string, what: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${what} (${url}) is not an address`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${what} (${url}) is not an http address`;
  if (!isPrivateHost(u.hostname)) return `${what} (${url}) is not a loopback or private address: block B only ever runs against the throwaway stage`;
  if (new URL(BASE).host === u.host) return `${what} (${url}) is the address block A runs against`;
  return '';
}

const pass = (name: string, detail = ''): void => {
  results.push(`PASS ${name}${detail ? ` (${detail})` : ''}`);
  log(`PASS ${name}${detail ? ` (${detail})` : ''}`);
};
const fail = (name: string, detail: string): void => {
  results.push(`FAIL ${name}: ${detail}`);
  log(`FAIL ${name}: ${detail}`);
};
const skip = (name: string, reason: string): void => {
  results.push(`SKIPPED ${name}: ${reason}`);
  log(`SKIPPED ${name}: ${reason}`);
};
function check(name: string, ok: boolean, detail = ''): boolean {
  if (ok) pass(name, detail);
  else fail(name, detail);
  return ok;
}

const origin = (site: Site): string => (site === 'prod' ? BASE : STAGE);
const credentials = (site: Site, who: Who): { email: string; password: string } =>
  site === 'prod' ? { email: process.env[`${who}_EMAIL`] ?? '', password: process.env[`${who}_PASSWORD`] ?? '' } : { email: personaEmail(who.toLowerCase() as PersonaKey), password: PERSONA_PASSWORD };

async function browserFor(site: Site): Promise<Browser> {
  const have = browsers.get(site);
  if (have) return have;
  const b = await chromium.launch();
  browsers.set(site, b);
  return b;
}

async function signIn(site: Site, who: Who): Promise<any> {
  const browser = await browserFor(site);
  const ctx = await browser.newContext({ baseURL: origin(site), viewport: VIEW.d, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const c = credentials(site, who);
  if (!c.email || c.password.length < 8) throw new Error(`${who}_EMAIL / ${who}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(c.email);
  await page.getByLabel('Password', { exact: true }).fill(c.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `sign in ${who} on ${site}`).not.toHaveURL(/\/sign-in/, T);
  const st = await ctx.storageState();
  await ctx.close();
  return st;
}

interface Opened {
  ctx: BrowserContext;
  page: Page;
}
const siteOf = new WeakMap<BrowserContext, Site>();
const blockedWrites: string[] = [];
/** The page's own background beacons (who is online, the read marker, Cloudflare's analytics beacon): production drops them like any write, and they are counted, not reported as a write the probe tried. */
const BEACON = /\/api\/presence(?:\?|$)|\/api\/read-state\/mark(?:\?|$)|\/cdn-cgi\/rum(?:\?|$)/;
let beaconsDropped = 0;
async function open(who: Who, vp: Vp = 'd', scheme: Scheme = 'light', site: Site = 'prod'): Promise<Opened> {
  if (site === 'stage' && !stageUp) throw new Error(`refusing to open the stage: ${stageWhy}`);
  const browser = await browserFor(site);
  const key = `${site}:${who}`;
  if (!states.has(key)) states.set(key, await signIn(site, who));
  const ctx = await browser.newContext({
    baseURL: origin(site),
    storageState: states.get(key),
    viewport: VIEW[vp],
    colorScheme: scheme,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    isMobile: vp === 'm',
    hasTouch: vp === 'm',
  });
  siteOf.set(ctx, site);
  if (site === 'prod') {
    // production is read-only: a page that tries to write anything (a read marker, a heartbeat) has that request dropped and noted
    await ctx.route('**/*', (route) => {
      const m = route.request().method();
      if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return route.continue();
      if (BEACON.test(route.request().url())) {
        beaconsDropped += 1;
        return route.abort('blockedbyclient');
      }
      blockedWrites.push(`${m} ${route.request().url()}`);
      log(`BLOCKED write on production: ${m} ${route.request().url()}`);
      return route.abort('blockedbyclient');
    });
  }
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
const api = async (ctx: BrowserContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<{ status: number; json: any }> => {
  if (method !== 'GET' && siteOf.get(ctx) !== 'stage') throw new Error(`refusing ${method} ${path}: only the stage may be written to`);
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
const sideways = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function poll<R>(fn: () => Promise<R | null | undefined | false>, ms: number, every = 2500): Promise<R | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() + every > end) return null;
    await sleep(every);
  }
}

/** A call to the stand-ins' control port (stage only). */
async function fake(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<any> {
  if (!stageUp) throw new Error(`refusing to call the stand-ins: ${stageWhy}`);
  const res = await fetch(`${CONTROL}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* The screens of block A. Each step opens its screens through `go` and checks them; the plates test (step 08) runs the same `go` in the four looks.                              */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

interface Screen {
  name: string;
  who: Who;
  go: (page: Page) => Promise<boolean>;
}
const screens: Screen[] = [];
const visible = (page: Page, id: string, timeout = 15_000): Promise<boolean> => page.getByTestId(id).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

screens.push({
  name: '01-gallery',
  who: 'OMAR',
  go: async (page) => {
    await page.goto('/settings/team/engineering/connections');
    if (!(await visible(page, 'connection-add'))) return false;
    await page.getByTestId('connection-add').click();
    return visible(page, 'connector-gallery');
  },
});
screens.push({
  name: '02-admin-connectors',
  who: 'OMAR',
  go: async (page) => {
    await page.goto('/settings/workspace/connections');
    return visible(page, 'connectors-admin');
  },
});
screens.push({
  name: '03-admin-people',
  who: 'OMAR',
  go: async (page) => {
    await page.goto('/settings/workspace/connections?tab=people');
    return visible(page, 'people-scopes');
  },
});
screens.push({
  name: '04-schedule-dialog',
  who: 'NADIA',
  go: async (page) => {
    await page.goto('/t/engineering/c/dev');
    if (!(await visible(page, 'schedule-open'))) return false;
    await page.getByTestId('schedule-open').click();
    return visible(page, 'schedule-dialog');
  },
});
screens.push({
  name: '05-admin-chat-apps',
  who: 'OMAR',
  go: async (page) => {
    await page.goto('/settings/workspace/chat-apps');
    return visible(page, 'chat-apps-admin');
  },
});
screens.push({
  name: '06-account-chat-apps',
  who: 'NADIA',
  go: async (page) => {
    await page.goto('/account/chat-apps');
    return (await visible(page, 'chat-apps-account-none', 8_000)) || (await visible(page, 'chat-apps-account', 8_000));
  },
});
screens.push({
  name: '07-offboard-dialog',
  who: 'OMAR',
  go: async (page) => {
    await page.goto('/settings/workspace/members');
    const row = page.getByTestId('member-row').filter({ hasText: 'Lena' });
    if (!(await row.first().waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) return false;
    await row.getByTestId('member-menu').click();
    await page.getByTestId('member-remove-connections').click();
    return visible(page, 'offboard-dialog');
  },
});

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* Clean-up                                                                                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

const made = { channelId: '', endpoints: [] as string[], botSlug: 'verify-d-responder' };
let cleanDone = false;

/** STAGE ONLY. Deletes the probe's addresses, removes the probe bot and archives its channels. Safe to run twice; also runs at the start of a rerun. Production is never touched. */
async function clean(): Promise<void> {
  if (cleanDone || !stageUp) return;
  const omar = await open('OMAR', 'd', 'light', 'stage');
  try {
    const dir = await api(omar.ctx, 'GET', '/api/teams/engineering/channels');
    const named: Array<{ id: string; name: string }> = ((dir.json?.groups ?? []) as any[]).flatMap((g) => g.channels ?? []).filter((x: any) => /^#?verify-d-/.test(x.name));
    for (const c of named) {
      const hooks = await api(omar.ctx, 'GET', `/api/channels/${c.id}/provider-hooks`);
      for (const e of (hooks.json?.endpoints ?? []) as any[]) log(`deleted address ${e.slug}: ${(await api(omar.ctx, 'DELETE', `/api/provider-hooks/${e.id}`)).status}`);
    }
    for (const id of made.endpoints) await api(omar.ctx, 'DELETE', `/api/provider-hooks/${id}`);
    const bots = await api(omar.ctx, 'GET', '/api/teams/engineering/bots');
    if (((bots.json?.bots ?? []) as any[]).some((b) => b.slug === made.botSlug)) {
      const r = await api(omar.ctx, 'POST', '/api/teams/engineering/proposals', { path: `bots/${made.botSlug}/BOT.md`, op: 'delete', title: `verify-d: remove the probe bot ${made.botSlug}`, applyNow: true });
      log(`removed bot ${made.botSlug}: ${r.status}`);
    }
    for (const c of named) log(`archived ${c.name}: ${(await api(omar.ctx, 'POST', `/api/channels/${c.id}/archive`)).status}`);
  } finally {
    await omar.ctx.close();
  }
  cleanDone = true;
}

test.beforeAll(async () => {
  // the stage is checked FIRST: nothing below writes unless it is the throwaway stage
  if (!STAGE) stageWhy = 'MANYTHREADS_STAGE_URL is not set';
  else if (!CONTROL) stageWhy = 'FAKE_SAAS_CONTROL is not set';
  else {
    const refused = whyNotStage(STAGE, 'MANYTHREADS_STAGE_URL') || whyNotStage(CONTROL, 'FAKE_SAAS_CONTROL');
    if (refused) stageWhy = `REFUSED: ${refused}`;
    else {
      const up = await fetch(`${STAGE}/api/health`).then((r) => r.status < 500, () => false);
      const ctl = await fetch(`${CONTROL}/__fake/health`).then((r) => r.status < 300, () => false);
      stageUp = up && ctl;
      stageWhy = stageUp ? '' : `the stage (${STAGE}) or the stand-ins (${CONTROL}) do not answer`;
    }
  }
  if (stageWhy) log(`block B is off: ${stageWhy}`);
  await clean().catch((e: Error) => log(`pre-clean: ${e.message.slice(0, 160)}`));
  cleanDone = false;
});
test.afterAll(async () => {
  await clean().catch((e: Error) => log(`clean: ${e.message.slice(0, 160)}`));
  for (const b of browsers.values()) await b.close().catch(() => undefined);
});

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* Block A: production, READ-ONLY                                                                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

test('A01 the gallery as Omar (a lead of Engineering): the new apps are cards, and "calendar" finds the calendar apps', async () => {
  const o = await open('OMAR');
  try {
    const ok = await screens[0]!.go(o.page);
    if (!ok) {
      skip('A01 gallery', 'Omar has no Add connection button on Engineering or the gallery did not open');
      return;
    }
    for (const id of ['confluence', 'dropbox', 'box', 'telegram', 'whatsapp', 'slack', 'teams']) {
      const status = await o.page.getByTestId(`connector-card-${id}`).getAttribute('data-status').catch(() => null);
      check(`A01 ${id} is available`, status === 'available', String(status));
    }
    await o.page.getByTestId('connector-search').fill('calendar');
    check('A01 search "calendar" finds Google and Microsoft', (await o.page.getByTestId('connector-card-google').count()) === 1 && (await o.page.getByTestId('connector-card-microsoft').count()) === 1);
    await shoot(o.page, 'A01-gallery-calendar', 'd', 'light');
  } finally {
    await o.ctx.close();
  }
});

test('A02 Omar, Settings, Connections: Connectors and People have real numbers, and no address in People', async () => {
  const o = await open('OMAR');
  try {
    check('A02 Connectors tab opens', await screens[1]!.go(o.page));
    const rows = await o.page.getByTestId('connector-row').count();
    check('A02 Connectors has rows', rows > 0, `${rows} rows`);
    const text = await o.page.getByTestId('connectors-admin').innerText();
    check('A02 Connectors shows numbers', /\d/.test(text));
    check('A02 People tab opens', await screens[2]!.go(o.page));
    // the box is there before its rows are read: wait for a row or the empty message
    await o.page.locator('[data-testid="person-connection"], :text("No one has connected")').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    const people = await o.page.getByTestId('people-scopes').innerText();
    check('A02 People shows no @', !people.includes('@'));
    check('A02 People has rows or says nobody has connected', (await o.page.getByTestId('person-connection').count()) > 0 || /No one has connected/.test(people), `${await o.page.getByTestId('person-connection').count()} rows`);
  } finally {
    await o.ctx.close();
  }
});

test('A03 Nadia in #dev, Schedule a room: the connect-your-calendar message', async () => {
  const o = await open('NADIA');
  try {
    if (!check('A03 the dialog opens', await screens[3]!.go(o.page))) return;
    const connect = o.page.getByTestId('schedule-connect');
    // the dialog asks which calendars the person has before it shows the message
    const shown = await connect.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true, () => false);
    if (shown) check('A03 the message says to connect a calendar', /Connect your Google or Microsoft calendar/.test(await connect.innerText()));
    else skip('A03 connect message', 'Nadia already has a calendar connected on production');
    await shoot(o.page, 'A03-schedule-dialog', 'd', 'light');
  } finally {
    await o.ctx.close();
  }
});

test('A04 the Knowledge tab as Omar: "Add from a connected app" opens, and says to connect first or offers the folders (nothing is added)', async () => {
  const o = await open('OMAR');
  try {
    await o.page.goto('/t/engineering/knowledge');
    const row = o.page.getByTestId('team-knowledge-row').first();
    if (!(await row.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) return skip('A04 knowledge', 'Engineering has no knowledge base to open');
    await row.click();
    const add = o.page.getByTestId('connector-add');
    if (!(await add.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) return skip('A04 knowledge', 'the add-from-an-app button is not shown for this base');
    await add.click();
    const none = o.page.getByTestId('connector-none');
    const picker = o.page.getByTestId('connector-form');
    const state = await Promise.race([none.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'none'), picker.waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'picker')]).catch(() => 'neither');
    // Omar may have a real Drive connected on production: then the picker is the right answer. Either way the dialog is the new one.
    check('A04 the dialog opens with "connect first" or the picker', state !== 'neither', state);
    if (state === 'none') check('A04 it names Confluence, Dropbox and Box', /Confluence, Dropbox or Box/.test(await none.innerText()));
    await shoot(o.page, 'A04-knowledge-connect-first', 'd', 'light');
  } finally {
    await o.ctx.close();
  }
});

test('A05 the real door of a work app (production is read-only: not called here)', async () => {
  skip('A05 the 404 of an unknown address, the signed refusals, the duplicate, the 413 and the origin card', 'every one of them is a POST to the door; production gets no POST from this probe, they run against the stage in B00');
});

test('A06 chat apps: four "Not set up", Nadia is told no chat app is switched on yet', async () => {
  const omar = await open('OMAR');
  const nadia = await open('NADIA');
  try {
    check('A06 the admin page opens', await screens[4]!.go(omar.page));
    for (const p of ['telegram', 'whatsapp', 'slack', 'teams']) {
      const text = await omar.page.getByTestId(`chat-app-${p}`).innerText().catch(() => '');
      check(`A06 ${p} is not set up`, /Not set up/i.test(text), text.slice(0, 40).replace(/\s+/g, ' '));
    }
    check('A06 the account page opens', await screens[5]!.go(nadia.page));
    check('A06 it says no chat app is switched on yet', /No chat app is switched on yet/.test(await nadia.page.locator('main').innerText()));
  } finally {
    await omar.ctx.close();
    await nadia.ctx.close();
  }
});

test('A07 Members, Lena, "Remove their connections": the preview opens, then Cancel', async () => {
  const o = await open('OMAR');
  try {
    if (!check('A07 the preview opens', await screens[6]!.go(o.page))) return;
    // the preview is read when the dialog opens; wait for it to be drawn (a GET: nothing is changed by looking)
    const state = await Promise.race([
      o.page.getByTestId('offboard-own').waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'own'),
      o.page.getByTestId('offboard-nothing').waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'nothing'),
    ]).catch(() => 'neither');
    check('A07 the preview says what will be removed, or that there is nothing', state !== 'neither', state);
    await o.page.getByTestId('offboard-dialog').getByRole('button', { name: /^(Cancel|Close)$/ }).click();
    check('A07 Cancel closes it', (await o.page.getByTestId('offboard-dialog').count()) === 0);
  } finally {
    await o.ctx.close();
  }
});

test('A08 the plates of 1 to 7 at 1440 and 390, light and dark', async () => {
  for (const vp of ['d', 'm'] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      for (const s of screens) {
        const o = await open(s.who, vp, scheme);
        try {
          const ok = await s.go(o.page);
          if (!ok) {
            skip(`A08 ${s.name} ${tag(vp, scheme)}`, 'the screen did not open for this person');
            continue;
          }
          await shoot(o.page, `A08-${s.name}`, vp, scheme);
          if (vp === 'm') check(`A08 ${s.name} no sideways scroll at 390 (${scheme})`, !(await sideways(o.page)));
          if (scheme === 'dark') check(`A08 ${s.name} is drawn dark`, (await o.page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark' || (await o.page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)));
        } finally {
          await o.ctx.close();
        }
      }
    }
  }
});

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */
/* Block B: the STAGE ONLY (refused unless the addresses are loopback/private; see whyNotStage)                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ */

const gateB = (name: string): boolean => {
  if (stageUp) return true;
  skip(name, stageWhy);
  return false;
};
const stageEmail = (who: Who): string => personaEmail(who.toLowerCase() as PersonaKey);

test('B00 a work app calls the stage door: the whole refusal table, and one bot post with the origin card', async () => {
  if (!gateB('B00 provider door')) return;
  const omar = await open('OMAR', 'd', 'light', 'stage');
  // Sameera is in Customer support only: she cannot read an Engineering channel (Priya, who is in Engineering, could)
  const outsider = await open('SAMEERA', 'd', 'light', 'stage');
  try {
    const channel = await api(omar.ctx, 'POST', '/api/teams/engineering/channels', { name: `verify-d-hooks-${sfx}` });
    made.channelId = String(channel.json?.channel?.id ?? channel.json?.id ?? '');
    if (!check('B00 the probe channel is made', made.channelId !== '', `${channel.status}`)) return;
    const secret = `verify-d-${sfx}-signing-secret-0001`;
    const generic = await api(omar.ctx, 'POST', `/api/channels/${made.channelId}/provider-hooks`, { provider: 'generic', slug: 'verify-d-generic', name: 'verify-d generic' });
    const zen = await api(omar.ctx, 'POST', `/api/channels/${made.channelId}/provider-hooks`, { provider: 'zendesk', slug: 'verify-d-hooks', name: 'verify-d zendesk', signingSecret: secret });
    const genericId = String(generic.json?.endpoint?.id ?? '');
    const zenId = String(zen.json?.endpoint?.id ?? '');
    made.endpoints.push(genericId, zenId);
    if (!check('B00 the generic and zendesk addresses are made', generic.status === 201 && zen.status === 201, `${generic.status} ${zen.status}`)) return;
    const genericSecret = String(generic.json?.signingSecret ?? '');
    check('B00 the generic secret is shown once and is not in the listing', genericSecret.length >= 16 && !JSON.stringify((await api(omar.ctx, 'GET', `/api/channels/${made.channelId}/provider-hooks`)).json).includes(genericSecret));

    // the probe bot: listens for ticket.created on the zendesk address
    const botMd = [
      '---', 'schema: 1', 'name: verify-d responder', 'role: Reads a new ticket and says what it saw', 'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'visibility: team',
      'triggers:', '  - type: webhook', '    connection: verify-d-hooks', '    event: ticket.created', 'capabilities:', '  native: [messages.post]', '---', '', '# verify-d responder', '', 'Probe bot of the Bundle D check; removed at the end.', '',
    ].join('\n');
    const prop = await api(omar.ctx, 'POST', '/api/teams/engineering/proposals', { path: `bots/${made.botSlug}/BOT.md`, op: 'put', content: botMd, title: 'verify-d: probe bot', applyNow: true });
    check('B00 the probe bot is set up', prop.status < 300, `${prop.status}`);
    const loaded = await poll(async () => ((await api(omar.ctx, 'GET', '/api/teams/engineering/bots')).json?.bots ?? []).some((b: any) => b.slug === made.botSlug), 90_000, 3000);
    check('B00 the loader loaded the probe bot', loaded === true);

    const door = (id: string): string => `${STAGE}/hooks/apps/${id}`;
    const send = async (o: Parameters<typeof sendWebhook>[0]): Promise<number[]> => (await sendWebhook(o)).responses.map((r) => r.status);
    const base = { provider: 'zendesk' as const, url: door(zenId), secret, kind: 'ticket.created', title: `verify-d ticket ${sfx}` };
    const first = await sendWebhook({ ...base, deliveryId: `verify-d-${sfx}-1` });
    check('B00 a signed ticket.created is 200', first.responses[0]?.status === 200, String(first.responses[0]?.status));
    const again = await sendWebhook({ ...base, deliveryId: `verify-d-${sfx}-1` });
    check('B00 the repeat is 200 duplicate', again.responses[0]?.status === 200 && /duplicate/.test(again.responses[0]?.body ?? ''), `${again.responses[0]?.status} ${again.responses[0]?.body.slice(0, 60)}`);
    for (const tamper of ['body', 'stale', 'unsigned'] as const) check(`B00 ${tamper} is 401`, (await send({ ...base, tamper }))[0] === 401);
    check('B00 an unknown id is 404', (await fetch(door('00000000-0000-4000-8000-0000000d0404'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status === 404);
    const revoked = await api(omar.ctx, 'DELETE', `/api/provider-hooks/${genericId}`);
    made.endpoints = made.endpoints.filter((x) => x !== genericId);
    const goneAnswer = await fetch(door(genericId), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    const unknownAnswer = await fetch(door('00000000-0000-4000-8000-0000000d0405'), { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    check('B00 a revoked id is the same 404 as an unknown one', revoked.status === 200 && goneAnswer.status === 404 && (await goneAnswer.text()) === (await unknownAnswer.text()));
    const tg = await fetch(`${STAGE}/hooks/bridges/telegram/${crypto.randomUUID()}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    check('B00 the Telegram door of an unknown account is 404', tg.status === 404, String(tg.status));
    check('B00 1.5 MB is 413', (await send({ ...base, padBytes: 1_500_000 }))[0] === 413);

    const posted = await poll(async () => {
      const list = await api(omar.ctx, 'GET', `/api/channels/${made.channelId}/messages`);
      const items = ((list.json?.items ?? []) as any[]).filter((m) => m.author?.kind === 'bot' && m.meta?.runId);
      return items.length >= 1 ? items : null;
    }, 180_000, 5000);
    if (posted === null) skip('B00 within 3 minutes there is a bot post', 'the stage answers bot runs with the demo stand-in model (fake-llm), which has no scenario for a ticket; the run itself is covered by e2e/connections/zendesk-trigger.spec.ts against the Hermes stand-in');
    else {
      check('B00 exactly one bot post', posted.length === 1, `${posted.length}`);
      const runId = String(posted[0].meta.runId);
      const origin = await api(omar.ctx, 'GET', `/api/runs/${runId}/origin`);
      check('B00 the origin route names Zendesk and the title', origin.status === 200 && /zendesk/i.test(JSON.stringify(origin.json)) && JSON.stringify(origin.json).includes(`verify-d ticket ${sfx}`), `${origin.status}`);
      check('B00 Sameera, who cannot read the channel, gets 404', (await api(outsider.ctx, 'GET', `/api/runs/${runId}/origin`)).status === 404);
      await omar.page.goto(`/t/engineering/c/verify-d-hooks-${sfx}`);
      const card = omar.page.getByTestId('run-origin').first();
      const shown = await card.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
      check('B00 the card "What started this run · Zendesk" is on the page', shown && /What started this run · Zendesk/.test(await card.innerText()));
      if (shown) {
        await omar.page.getByTestId('run-origin-toggle').first().click();
        await shoot(omar.page, 'B00-run-origin-card', 'd', 'light');
      }
    }
  } finally {
    await omar.ctx.close();
    await outsider.ctx.close();
  }
});

test('B01 connect fake Google with Drive only, then add Calendar: the second consent asks for the calendar scopes alone', async () => {
  if (!gateB('B01 incremental consent')) return;
  // Nadia is already connected by the seed, so a person without Google (Priya) makes the first sign-in
  await fake('POST', '/__fake/sign-in-as', { email: stageEmail('PRIYA') });
  const o = await open('PRIYA', 'd', 'light', 'stage');
  try {
    await o.page.goto('/settings/connections');
    const google = o.page.locator('[data-testid="person-provider"][data-provider="google"]');
    await google.waitFor({ state: 'visible', timeout: 20_000 });
    for (const s of ['gmail', 'calendar', 'calendar_write']) await google.locator(`[data-service="${s}"] input`).uncheck();
    await google.locator('[data-service="drive"] input').check();
    await google.getByTestId('person-connect').click();
    await expect(google).toHaveAttribute('data-connected', 'true', T);
    const consents = async (): Promise<any[]> => ((await fake('GET', '/__fake/state')).workspace?.consents ?? []).filter((c: any) => c.provider === 'google');
    const first = (await consents()).at(-1);
    check('B01 the first consent has Drive and no calendar', !!first && first.scopes.some((s: string) => /drive/.test(s)) && !first.scopes.some((s: string) => /calendar/.test(s)));
    await o.page.goto('/settings/connections');
    await google.locator('[data-service="drive"] input').uncheck();
    await google.locator('[data-service="calendar"] input').check();
    await google.getByTestId('person-connect').click();
    await expect(o.page.getByTestId('person-result')).toBeVisible(T);
    const second = (await consents()).at(-1);
    check('B01 the second consent asks for the calendar scopes alone', !!second && second.scopes.some((s: string) => /calendar/.test(s)) && !second.scopes.some((s: string) => /drive/.test(s)));
    await shoot(o.page, 'B01-incremental-consent', 'd', 'light');
  } finally {
    await o.ctx.close();
  }
});

let plannedId = '';
test('B02 schedule a room at now+5.5 minutes: the event with the join link, the chip, the bell, Join, and the time change after the sync', async () => {
  if (!gateB('B02 planned room')) return;
  const nadia = await open('NADIA', 'd', 'light', 'stage');
  const rafi = await open('RAFI', 'd', 'light', 'stage');
  try {
    await nadia.page.goto('/t/engineering/c/design');
    await nadia.page.getByTestId('schedule-open').click();
    await expect(nadia.page.getByTestId('schedule-dialog')).toBeVisible(T);
    // the next whole minute after now + 5.5 minutes, so the reminder (five minutes ahead) is due within about 90 seconds
    const at = new Date(Math.ceil((Date.now() + 5.5 * 60_000) / 60_000) * 60_000);
    const two = (n: number): string => String(n).padStart(2, '0');
    await nadia.page.getByTestId('schedule-title').fill('verify-d design review');
    await nadia.page.getByTestId('schedule-date').fill(`${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`);
    await nadia.page.getByTestId('schedule-time').fill(`${two(at.getHours())}:${two(at.getMinutes())}`);
    await nadia.page.getByTestId('schedule-people').getByLabel(/Rafi/).check();
    await nadia.page.getByTestId('schedule-outside').fill('guest@outside.test');
    await nadia.page.getByTestId('schedule-save').click();
    await expect(nadia.page.getByTestId('schedule-dialog')).toHaveCount(0, T);

    const state = await fake('GET', '/__fake/state');
    // createdEventDetails runs index for index with createdEvents (both are appended together by the stand-in)
    const events: any[] = state.workspace.createdEvents ?? [];
    const at0 = events.map((e: any) => e.title).lastIndexOf('verify-d design review');
    const event = at0 >= 0 ? events[at0] : undefined;
    const found = at0 >= 0 ? (state.workspace.createdEventDetails ?? [])[at0] : undefined;
    const detail = found && found.account === stageEmail('NADIA') ? found : undefined;
    check('B02 the event is at the fake calendar with Rafi and the outside guest', !!event && (event.guests ?? []).includes(stageEmail('RAFI')) && (event.guests ?? []).includes('guest@outside.test'));
    check('B02 the event has the /join/ link', !!detail && /\/join\//.test(detail.description) && /\/join\//.test(detail.location));
    plannedId = /\/join\/([0-9a-f-]{36})/.exec(detail?.description ?? '')?.[1] ?? '';
    await nadia.page.reload();
    const chip = nadia.page.getByTestId('scheduled-chip').filter({ hasText: /verify-d design review/ });
    check('B02 the chip is in the header', await chip.first().isVisible().catch(() => false));
    await shoot(nadia.page, 'B02-scheduled-chip', 'd', 'light');

    const bell = await poll(async () => {
      const n = await api(rafi.ctx, 'GET', '/api/notifications');
      return JSON.stringify(n.json ?? {}).includes('meeting_soon') && JSON.stringify(n.json).includes('verify-d design review') ? true : null;
    }, 150_000, 5000);
    check('B02 Rafi gets "starts in 5 minutes" within 90 s of the window', bell === true);
    if (plannedId) {
      await rafi.page.goto(`/join/${plannedId}`);
      await expect(rafi.page.getByTestId('join-scheduled')).toBeVisible(T);
      await rafi.page.getByTestId('join-scheduled-go').click();
      const connected = await rafi.page.getByTestId('call-dock').waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
      check('B02 Join opens the room', connected);
      await shoot(rafi.page, 'B02-joined', 'd', 'light');
    } else skip('B02 Join', 'the join link was not read from the event');

    // the organizer moves the event at her calendar; the ten-minute sync brings the new time into the plan
    if (event && detail) {
      const eventId = String(detail.eventId);
      const startsAt = new Date(new Date(event.start).getTime() + 3 * 3_600_000).toISOString();
      const endsAt = new Date(new Date(event.end).getTime() + 3 * 3_600_000).toISOString();
      await fake('PATCH', `/__fake/accounts/${encodeURIComponent(stageEmail('NADIA'))}`, { events: [{ id: eventId, title: event.title, start: startsAt, end: endsAt, guests: event.guests, description: detail.description, location: detail.location }] });
      if (plannedId) {
        const moved = await poll(async () => {
          const plan = await api(nadia.ctx, 'GET', `/api/scheduled-meetings/${plannedId}`);
          return plan.status === 200 && Math.abs(new Date(JSON.stringify(plan.json).match(/"startsAt":"([^"]+)"/)?.[1] ?? 0).getTime() - new Date(startsAt).getTime()) < 60_000 ? true : null;
        }, SYNC_WAIT_MIN * 60_000, 15_000);
        check(`B02 the plan takes the new time within ${SYNC_WAIT_MIN} minutes`, moved === true);
      }
    }
  } finally {
    await nadia.ctx.close();
    await rafi.ctx.close();
  }
});

test('B03 the free-time tool through the gateway', async () => {
  if (!gateB('B03 free time')) return;
  skip('B03 calendar.find_free_time', 'a person tool is called with a bot run\'s token, and the stage runs a stand-in model that never chooses tools; the tool is covered through the gateway by packages/plugins/connections/test/free-time-tool.test.ts');
});

test('B04 a Drive source on the handbook: the shared document comes in, the two-person one does not, public brings it in, Personal holds it, Priya cannot find it', async () => {
  if (!gateB('B04 documents')) return;
  const omar = await open('OMAR', 'd', 'light', 'stage');
  const nadia = await open('NADIA', 'd', 'light', 'stage');
  const priya = await open('PRIYA', 'd', 'light', 'stage');
  try {
    const detail = async (): Promise<any> => (await api(omar.ctx, 'GET', '/api/teams/engineering/knowledge/handbook')).json;
    const d0 = await detail();
    const names = (d0.documents ?? []).map((x: any) => x.name);
    check('B04 On-call guide is in and Design review notes is not', names.includes('On-call guide') && !names.includes('Design review notes'), names.join(', '));
    check('B04 one document is counted as left out', (d0.sources ?? []).find((s: any) => s.kind === 'connector')?.skippedLimited === 1);
    const found = (await api(priya.ctx, 'GET', `/api/teams/engineering/knowledge/handbook/search?q=${encodeURIComponent('open questions on the icon set')}`)).json;
    check("B04 Priya's search does not find the two-person document", !JSON.stringify(found).includes('Design review notes'));
    await omar.page.goto('/t/engineering/knowledge?base=handbook');
    await visible(omar.page, 'connector-source');
    await shoot(omar.page, 'B04-handbook-source', 'd', 'light');

    await fake('PUT', '/__fake/drive/doc-handbook-limited/permissions', { account: stageEmail('OMAR'), permissions: [{ type: 'anyone' }] });
    await api(omar.ctx, 'POST', '/api/teams/engineering/knowledge/handbook/resync', {});
    const both = await poll(async () => (((await detail()).documents ?? []).length === 2 ? true : null), 90_000, 3000);
    check('B04 public at the app brings the second document in', both === true);

    await api(nadia.ctx, 'POST', '/api/me/knowledge', { slug: 'verify-d-notes', name: 'verify-d notes' });
    await fake('PATCH', `/__fake/accounts/${encodeURIComponent(stageEmail('NADIA'))}`, {
      files: [
        { id: 'folder-verify-d', name: 'verify-d folder', mimeType: 'application/vnd.google-apps.folder', modified: new Date().toISOString(), text: '' },
        { id: 'doc-verify-d', name: 'verify-d two-person', mimeType: 'text/plain', modified: new Date().toISOString(), parentId: 'folder-verify-d', permissions: [{ type: 'user', email: stageEmail('OMAR') }], text: 'The osprey plan is for two people only.\n' },
      ],
    });
    const added = await api(nadia.ctx, 'POST', '/api/me/knowledge/verify-d-notes/connector-sources', { provider: 'google_drive', root: 'folder-verify-d', label: 'verify-d folder' });
    check("B04 Nadia's Personal source is added", added.status < 300, `${added.status}`);
    const inPersonal = await poll(async () => (((await api(nadia.ctx, 'GET', '/api/me/knowledge/verify-d-notes')).json?.documents ?? []).length === 1 ? true : null), 90_000, 3000);
    check("B04 Nadia's Personal base holds the two-person document", inPersonal === true);
    const hidden = await api(priya.ctx, 'GET', `/api/teams/engineering/knowledge/handbook/search?q=osprey`);
    check("B04 Priya's search does not find it", !JSON.stringify(hidden.json).includes('osprey'));
  } finally {
    await api(nadia.ctx, 'DELETE', '/api/me/knowledge/verify-d-notes').catch(() => undefined);
    await omar.ctx.close();
    await nadia.ctx.close();
    await priya.ctx.close();
  }
});

test('B05 Telegram: an unlinked person is refused, a code links, "via Telegram" in #support, the reply reaches the fake once, a DM answers', async () => {
  if (!gateB('B05 telegram')) return;
  const priya = await open('PRIYA', 'd', 'light', 'stage');
  const sameera = await open('SAMEERA', 'd', 'light', 'stage');
  try {
    const sentTo = async (chat: number | string): Promise<string[]> => ((await fake('GET', '/__fake/state')).telegram.sent ?? []).filter((m: any) => String(m.chatId) === String(chat)).map((m: any) => m.text);
    await fake('POST', '/__fake/telegram/send', { fromUserId: 999_001, text: 'verify-d stranger' });
    const refused = await poll(async () => ((await sentTo(999_001)).length === 1 ? true : null), 30_000, 1500);
    check('B05 an unlinked person is answered once with how to link', refused === true && /link/i.test((await sentTo(999_001))[0] ?? ''));

    const code = await api(priya.ctx, 'POST', '/api/me/bridges/telegram/link-code', {});
    check('B05 Priya gets an eight-digit code', /^\d{8}$/.test(String(code.json?.code ?? '')));
    await fake('POST', '/__fake/telegram/send', { fromUserId: 800_001, text: `/start ${String(code.json?.code)}`, username: 'priya_tg' });
    const linked = await poll(async () => (((await api(priya.ctx, 'GET', '/api/me/bridges')).json?.identities ?? []).length > 0 ? true : null), 30_000, 1500);
    check('B05 the code links Priya', linked === true);

    await fake('POST', '/__fake/telegram/send', { fromUserId: 700_001, chatId: -1_001_000_000_001, chatType: 'supergroup', chatTitle: 'Kahf support', text: 'verify-d group hello' });
    await sameera.page.goto('/t/customer-support/c/support');
    const via = sameera.page.getByTestId('message').filter({ hasText: 'verify-d group hello' }).getByTestId('message-via');
    check('B05 "via Telegram" is on the message in #support', await via.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false));
    await shoot(sameera.page, 'B05-message-via', 'd', 'light');

    const text = `verify-d reply ${sfx}`;
    const chans = await api(sameera.ctx, 'GET', '/api/teams/customer-support/channels');
    const supportId = String(((chans.json?.groups ?? []) as any[]).flatMap((g) => g.channels ?? []).find((c: any) => /support/.test(c.name))?.id ?? '');
    await api(sameera.ctx, 'POST', `/api/channels/${supportId}/messages`, { body: text });
    const out = await poll(async () => ((await sentTo(-1_001_000_000_001)).filter((t) => t.includes(text)).length >= 1 ? true : null), 60_000, 2000);
    check('B05 the reply reaches the fake', out === true);
    await sleep(8000);
    check('B05 it reaches the fake once', (await sentTo(-1_001_000_000_001)).filter((t) => t.includes(text)).length === 1);

    const before = (await sentTo(700_001)).length;
    await fake('POST', '/__fake/telegram/send', { fromUserId: 700_001, text: 'What is on my plate today?' });
    const dm = await poll(async () => ((await sentTo(700_001)).length > before ? true : null), 180_000, 4000);
    check('B05 a direct message to the bot is answered', dm === true);
    skip('B05 Slack and Teams once each', 'their accounts need credentials an admin types and callbacks the stand-ins call; the doors are covered against the stand-ins in packages/plugins/bridges/test');
  } finally {
    await priya.ctx.close();
    await sameera.ctx.close();
  }
});

test('B06 deactivate Lena and Rafi: connections gone within a minute, the grant revoked at the fake, reactivate restores nothing', async () => {
  if (!gateB('B06 offboarding')) return;
  const omar = await open('OMAR', 'd', 'light', 'stage');
  try {
    const members = (await api(omar.ctx, 'GET', '/api/workspace/members')).json?.members ?? [];
    const id = (name: string): string => String(members.find((m: any) => m.displayName === name)?.personId ?? '');
    const peopleOf = async (name: string): Promise<number> => (((await api(omar.ctx, 'GET', '/api/admin/connections/people')).json?.people ?? []) as any[]).filter((p) => String(p.personName).includes(name)).length;
    const revokedBefore = ((await fake('GET', '/__fake/state')).workspace?.revoked ?? []).length;
    for (const name of ['Lena', 'Rafi']) {
      const had = await peopleOf(name);
      const off = await api(omar.ctx, 'PATCH', `/api/workspace/members/${id(name)}`, { status: 'suspended' });
      check(`B06 ${name} is deactivated`, off.status === 200, `${off.status}`);
      const gone = await poll(async () => ((await peopleOf(name)) === 0 ? true : null), 90_000, 3000);
      check(`B06 ${name}'s ${had} connection(s) are gone within a minute`, had > 0 && gone === true);
      const back = await api(omar.ctx, 'PATCH', `/api/workspace/members/${id(name)}`, { status: 'active' });
      check(`B06 ${name} is reactivated and gets nothing back`, back.status === 200 && (await peopleOf(name)) === 0);
    }
    const revokedAfter = ((await fake('GET', '/__fake/state')).workspace?.revoked ?? []).length;
    check('B06 the fake saw a revoke call (Rafi’s Google; Microsoft has no revoke address)', revokedAfter > revokedBefore);
    skip('B06 a team connection moves to a new owner', 'no persona of the test seed is both a lead of a team and expendable; the move is covered by packages/plugins/connections/test/offboard.test.ts');
    await omar.page.goto('/settings/workspace/members');
    await shoot(omar.page, 'B06-members', 'd', 'light');
  } finally {
    await omar.ctx.close();
  }
});

test('99 cleanup and verdict', async () => {
  await clean();
  const failed = results.filter((r) => r.startsWith('FAIL'));
  const skipped = results.filter((r) => r.startsWith('SKIPPED'));
  writeFileSync(join(OUT, 'results.txt'), `${results.join('\n')}\n${fivexx.length > 0 ? `\n5xx seen:\n${fivexx.join('\n')}\n` : ''}\nthe page's own beacons dropped on production (presence, read marker, analytics): ${beaconsDropped}\n${blockedWrites.length > 0 ? `\nwrites to production that the guard stopped (must be empty):\n${blockedWrites.join('\n')}\n` : ''}`);
  log(`${results.length - failed.length - skipped.length} passed, ${skipped.length} skipped, ${failed.length} failed, ${fivexx.length} server errors`);
  expect(blockedWrites, 'the production guard stopped a write').toEqual([]);
  expect(failed, failed.join('\n')).toEqual([]);
});
