import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';

/**
 * Pictures of the live site for the phase record. Personas sign in exactly like people do: the sign-in page's email and
 * password form. The password is a random one-off the screenshots workflow set through the server's admin CLI
 * (docs/deploy.md); it comes from the environment, is only ever typed into that form and is never printed.
 * Output: <MANYTHREADS_SHOTS_DIR>/{desktop,mobile}/<name>.png (default e2e/screens/out).
 * Selectors are roles, labels, data-landmark and data-testid only; the content they look for is the demo seed (seed v3,
 * docs/testing.md): Nadia's "Deploy plan" thread in #dev, Rafi's unread thread reply and DM, Lena's grant on #releases.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? join(import.meta.dirname, 'out');

const EMAIL = { omar: 'omar@kahf.example', nadia: 'nadia@kahf.example', rafi: 'rafi@kahf.example', lena: 'lena@kahf.example' } as const;
type Persona = keyof typeof EMAIL;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

test.beforeAll(() => {
  if (PASSWORD.length < 12) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the one-off password of the screenshot personas)');
});

// One real sign-in per persona and worker; later screens start from the cookies it produced.
const signedIn = new Map<Persona, Promise<NonNullable<BrowserContextOptions['storageState']>>>();

async function signInThroughTheForm(browser: Browser, persona: Persona): Promise<NonNullable<BrowserContextOptions['storageState']>> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(EMAIL[persona]);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // the form leaves /sign-in once the session exists; a refusal would show an alert instead
    await expect(page, `password sign-in as ${persona} (was the one-off password set?)`).not.toHaveURL(/\/sign-in/);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/** A browser context signed in as the persona (or anonymous when `persona` is null). */
async function open(browser: Browser, persona: Persona | null, viewport: { width: number; height: number }, mobile: boolean): Promise<Page> {
  let storageState: BrowserContextOptions['storageState'];
  if (persona) {
    let state = signedIn.get(persona);
    if (!state) signedIn.set(persona, (state = signInThroughTheForm(browser, persona)));
    storageState = await state;
  }
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: 'reduce',
    ...(storageState ? { storageState } : {}),
  });
  return context.newPage();
}

type Prepare = (page: Page) => Promise<void>;

/** Opens `path`, lets `prepare` arrange the screen (open a panel, search, ...), then saves <OUT>/<kind>/<name>.png. */
async function shoot(page: Page, kind: 'desktop' | 'mobile', name: string, path: string, prepare?: Prepare): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  if (prepare) await prepare(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  const dir = join(OUT, kind);
  mkdirSync(dir, { recursive: true });
  // Dynamic regions (times, ids) carry data-vt-mask: painted over so a re-run differs only when the screen does.
  await page.screenshot({ path: join(dir, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
  await page.context().close();
}

const content = (page: Page) => page.locator('[data-landmark="content"]');
const panel = (page: Page) => page.locator('[data-landmark="right-panel"]');

/** The channel is on screen with its messages (the first page of the history has loaded). */
const channelReady: Prepare = async (page) => {
  await expect(page.getByTestId('channel-view')).toBeVisible();
  await expect(page.getByTestId('message').first()).toBeVisible();
};

/** Opens the "Deploy plan" thread (root by Nadia, 12 replies) in the right panel, beside the channel. */
const openDeployPlan: Prepare = async (page) => {
  await channelReady(page);
  const root = content(page).getByTestId('message').filter({ hasText: 'Deploy plan: cache TTL' });
  await root.getByRole('button', { name: /\d+ repl(y|ies)/ }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('thread-view')).toContainText('Deploy plan: cache TTL');
  await expect(panel(page).getByTestId('message').nth(1)).toBeVisible(); // at least one reply
  // the panel opens at the newest reply; show the thread from its root (scroll whichever ancestor of the root scrolls)
  await panel(page).getByTestId('message').first().evaluate((el) => {
    for (let n: Element | null = el.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 1) n.scrollTop = 0;
  });
};

/**
 * Rafi's inbox on its Unread tab. The Followed tab opens the first thread by itself, which reads it; the Unread tab leaves
 * everything unread, so the picture shows the unread count and the sidebar badge.
 */
const UNREAD_INBOX = '/t/engineering/threads?tab=unread';
const inboxReady: Prepare = async (page) => {
  await expect(page.getByTestId('threads-inbox')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Unread/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('thread-row').first()).toBeVisible();
};

/** A typo on purpose: "rolback" finds the rollback messages through trigram matching. */
const searchRolback: Prepare = async (page) => {
  const box = page.locator('[data-landmark="search"]').getByRole('searchbox');
  await box.fill('rolback');
  await box.press('Enter');
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'rolback');
  await expect(page.getByTestId('search-hit').first()).toBeVisible();
};

/** Rafi's conversation with Nadia, opened from "Direct messages" in the sidebar. */
const openNadiaDm: Prepare = async (page) => {
  await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Nadia/ }).first().click();
  await expect(page).toHaveURL(/\/dm\//);
  await expect(page.getByTestId('message').first()).toBeVisible();
};

/** The phone's menu drawer, open over the channel. */
const openDrawer: Prepare = async (page) => {
  await channelReady(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByTestId('app-frame')).toHaveAttribute('data-drawer', 'open');
};

interface Screen {
  name: string;
  persona: Persona | null;
  path: string;
  prepare?: Prepare;
}

const SCREENS: Screen[] = [
  { name: 'sign-in', persona: null, path: '/sign-in' },
  { name: 'teams', persona: 'omar', path: '/teams' },
  { name: 'roster', persona: 'omar', path: '/settings/team/engineering/roster' },
  { name: 'members', persona: 'omar', path: '/settings/workspace/members' },
  { name: 'account', persona: 'nadia', path: '/account' },
  { name: 'settings-sign-in', persona: 'omar', path: '/settings/workspace/sign-in' },
  { name: 'teams-guest', persona: 'lena', path: '/teams' },
  // phase 3: conversations
  { name: 'channel-dev-thread', persona: 'nadia', path: '/t/engineering/c/dev', prepare: openDeployPlan },
  { name: 'threads-inbox', persona: 'rafi', path: UNREAD_INBOX, prepare: inboxReady },
  { name: 'search-rolback', persona: 'nadia', path: '/t/engineering/c/dev', prepare: searchRolback },
  { name: 'dm', persona: 'rafi', path: UNREAD_INBOX, prepare: openNadiaDm },
  { name: 'guest-releases', persona: 'lena', path: '/t/engineering/c/releases', prepare: channelReady },
];

const MOBILE_SCREENS: Screen[] = [
  { name: 'sign-in', persona: null, path: '/sign-in' },
  { name: 'members', persona: 'omar', path: '/settings/workspace/members' },
  { name: 'guest-releases', persona: 'lena', path: '/t/engineering/c/releases', prepare: channelReady },
  { name: 'channel-dev', persona: 'nadia', path: '/t/engineering/c/dev', prepare: channelReady },
  { name: 'channel-dev-drawer', persona: 'nadia', path: '/t/engineering/c/dev', prepare: openDrawer },
];

for (const s of SCREENS) {
  test(`desktop ${s.name}`, async ({ browser }) => {
    await shoot(await open(browser, s.persona, DESKTOP, false), 'desktop', s.name, s.path, s.prepare);
  });
}

for (const s of MOBILE_SCREENS) {
  test(`mobile ${s.name}`, async ({ browser }) => {
    await shoot(await open(browser, s.persona, MOBILE, true), 'mobile', s.name, s.path, s.prepare);
  });
}
