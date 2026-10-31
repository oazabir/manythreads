import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EXE, exeMissing, killTree, launch, setWindowState, sleep, stop, type Shell } from './shell.ts';

// Signed-in smoke test of the Tauri desktop shell: the real debug exe against a LIVE server, signed in as Omar (owner), with one
// direct message from Nadia (member) to prove that a mention raises a system alert. Credentials come from the environment only
// (OMAR_EMAIL, OMAR_PASSWORD, NADIA_EMAIL, NADIA_PASSWORD; MANYTHREADS_URL names the server, default https://manythreads.kahf.to).
//   set -a; source <(ssh devbox cat '~/manythreads.passwords.env'); set +a; pnpm e2e:desktop:signin
// Nothing secret is logged or recorded: the password is typed through page.evaluate (Playwright's call log would print a fill() value),
// no screenshot is taken, and signin.config.ts turns traces and videos off. The app runs with its own throw-away WebView2 profile
// (WEBVIEW2_USER_DATA_FOLDER), so the owner's real desktop session is never touched and nothing stays signed in on this machine.

const SERVER = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OMAR = { email: process.env['OMAR_EMAIL'] ?? '', password: process.env['OMAR_PASSWORD'] ?? '' };
const NADIA = { email: process.env['NADIA_EMAIL'] ?? '', password: process.env['NADIA_PASSWORD'] ?? '' };
const haveOmar = OMAR.email !== '' && OMAR.password !== '';
const haveNadia = NADIA.email !== '' && NADIA.password !== '';

test.skip(process.platform !== 'win32', 'The desktop shell test drives WebView2 and runs on Windows only.');
test.skip(exeMissing, `The debug exe is missing (${EXE}); build it first: pnpm -C clients/desktop bundle:debug`);
test.skip(!haveOmar, 'OMAR_EMAIL and OMAR_PASSWORD are not set; load them first (see docs/clients/desktop.md, "Build it").');

test.describe.configure({ mode: 'serial' });

// ---- the server API, from Node (a second client of the same server; the app is never driven this way) ------------------------------

interface Session {
  person: { id: string; name: string; email: string };
}
interface Prefs {
  mention: { inApp: boolean; browser: boolean };
  reply: { inApp: boolean; browser: boolean };
  dm: { inApp: boolean; browser: boolean };
  mutedChannels: string[];
}

/** One signed-in session over fetch: cookies and the CSRF header exactly as the web client sends them (clients/web/src/api/client.ts). */
class Api {
  private cookies = new Map<string, string>();
  private csrf: string | null = null;
  session: Session | null = null;

  async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${SERVER}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size > 0 ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const set of res.headers.getSetCookie()) {
      const pair = set.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      this.cookies.set(name, value);
      if (/^(?:__Host-)?manythreads_csrf$/.test(name)) this.csrf = decodeURIComponent(value);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json: json as T };
  }

  /** Never put the response into an error: only the method, path and status. */
  async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T>(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} answered ${r.status}`);
    return r.json;
  }

  async signIn(who: { email: string; password: string }): Promise<Session> {
    const r = await this.call<Session>('POST', '/api/auth/password/sign-in', { email: who.email, password: who.password });
    if (r.status !== 200) throw new Error(`Password sign-in answered ${r.status}`);
    this.session = r.json;
    return r.json;
  }

  async signOut(): Promise<void> {
    if (this.cookies.size === 0) return;
    await this.call('POST', '/api/auth/sign-out').catch(() => undefined);
    this.cookies.clear();
    this.csrf = null;
  }
}

/** The `@handle` that names a person in a message: the local part of the email, else the slug of the name (packages/shared/src/markup/handles.ts). */
function handleOf(s: Session): string {
  const local = (s.person.email.split('@')[0] ?? '').toLowerCase();
  if (/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(local)) return local;
  return s.person.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

// ---- the app window -------------------------------------------------------------------------------------------------------------

const SIDEBAR = 'nav[aria-label="Sidebar"]'; // clients/web/src/shell/Shell.tsx
const FOOT_NAME = '.foot-name'; // the signed-in person's name in the sidebar foot (shell/AccountMenu.tsx)
const PASSWORD = 'input[type="password"][name="password"]'; // clients/web/src/screens/SignIn.tsx
const EMAIL = 'input[name="email"]';

/** Waits for the sign-in form or the app shell, whichever the window shows first. */
async function settle(page: Page): Promise<'sign-in' | 'shell'> {
  const form = page.locator(PASSWORD);
  const shell = page.locator(SIDEBAR);
  await form.or(shell).first().waitFor({ state: 'visible', timeout: 60_000 });
  return (await shell.isVisible()) ? 'shell' : 'sign-in';
}

/** Sets a field the way typing does for a React input, without Playwright's call log ever holding the value. */
async function setField(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** The app's own sign-out: account menu (the gear in the sidebar foot), then "Sign out" (shell/AccountMenu.tsx). */
async function signOutInApp(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/, { timeout: 30_000 });
  await expect(page.locator(PASSWORD)).toBeVisible({ timeout: 30_000 });
}

/** Closes the app the way a user does (the browser process flushes its cookie store), then makes sure nothing is left. */
async function restart(shell: Shell): Promise<void> {
  try {
    const cdp = await shell.browser.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(() => undefined);
  } catch {
    /* fall through to the kill */
  }
  const until = Date.now() + 8000;
  while (shell.child.exitCode === null && Date.now() < until) await sleep(250);
  await shell.browser.close().catch(() => undefined);
  killTree(shell.child);
  await sleep(1500);
}

const focusReport = (page: Page) => page.evaluate(() => (window as unknown as { __manythreadsDesktopFocused?: boolean }).__manythreadsDesktopFocused);

// ---- the cases ------------------------------------------------------------------------------------------------------------------

test.describe('desktop app signed in (live server)', () => {
  let shell: Shell | undefined;
  let profile: string | undefined;
  const env = () => ({ APPDATA: profile!, WEBVIEW2_USER_DATA_FOLDER: join(profile!, 'webview2'), MANYTHREADS_SERVER_URL: SERVER });

  test.afterAll(async () => {
    try {
      // A failed case may leave the window signed in: end that session through the app so the server does not keep it either.
      if (shell && shell.child.exitCode === null) {
        const page = shell.page();
        if (await page.locator(SIDEBAR).isVisible().catch(() => false)) await signOutInApp(page).catch(() => undefined);
      }
    } finally {
      await stop(shell);
      if (profile) rmSync(profile, { recursive: true, force: true });
    }
  });

  test('1. signs in through the sign-in form', async () => {
    profile = mkdtempSync(join(tmpdir(), 'manythreads-desktop-signin-'));
    shell = await launch(env());
    let page = shell.page();
    if ((await settle(page)) === 'shell') await signOutInApp(page); // a window that is already signed in starts from the form
    page = shell.page();

    await setField(page, EMAIL, OMAR.email);
    await setField(page, PASSWORD, OMAR.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.locator(SIDEBAR)).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).not.toMatch(/\/sign-in/);
    expect(new URL(page.url()).origin).toBe(new URL(SERVER).origin);
    await expect(page.locator(FOOT_NAME)).not.toHaveText('', { timeout: 15_000 });
  });

  test('2. the session survives a restart of the app', async () => {
    await restart(shell!);
    shell = await launch(env());
    const page = shell.page();
    expect(await settle(page)).toBe('shell');
    await expect(page.locator(PASSWORD)).toHaveCount(0);
    expect(new URL(page.url()).pathname).not.toMatch(/\/sign-in/);
  });

  test('3. a mention raises a system alert', async () => {
    test.skip(!haveNadia, 'NADIA_EMAIL and NADIA_PASSWORD are not set; the mention case needs a second person to write.');
    const page = shell!.page();
    const omar = new Api();
    const nadia = new Api();
    let originalPrefs: Prefs | null = null;
    let sent: { channelId: string; messageId: string } | null = null;
    let minimised = false;
    try {
      // Omar's switch for system alerts on mentions (Settings, Notifications): the live push carries `browser: true` only when it is on
      // (clients/web/src/notifications/store.ts, raiseAlert). It is put back at the end.
      const me = await omar.signIn(OMAR);
      originalPrefs = await omar.ok<Prefs>('GET', '/api/notifications/prefs');
      if (!originalPrefs.mention.browser) {
        await omar.ok('PUT', '/api/notifications/prefs', { ...originalPrefs, mention: { ...originalPrefs.mention, browser: true } });
      }

      // The page records every Notification the app raises and still passes it on, so the real alert shows too.
      await page.evaluate(() => {
        const w = window as unknown as { __alerts?: { title: string; body: string }[]; Notification: typeof Notification };
        if (w.__alerts) return;
        const alerts: { title: string; body: string }[] = [];
        const Original = w.Notification;
        const Wrapped = function (this: unknown, title: string, options?: NotificationOptions) {
          alerts.push({ title: String(title), body: String(options?.body ?? '') });
          return new Original(title, options);
        } as unknown as typeof Notification;
        Wrapped.prototype = Original.prototype;
        Object.defineProperty(Wrapped, 'permission', { get: () => Original.permission });
        Wrapped.requestPermission = Original.requestPermission.bind(Original);
        w.__alerts = alerts;
        w.Notification = Wrapped;
      });
      expect(await page.evaluate(() => Notification.permission), 'the shell grants the page system alerts').toBe('granted');

      // raiseAlert stays quiet while the window has the person's attention. The window is on the start page (not the DM) and is really
      // minimised; the shell then reports the window as not focused to the page (WebView2 itself keeps saying visible and focused).
      // A real click in the window gives it operating-system focus (a freshly started process is not in front); the page must hear `true`,
      // which also proves that focus moving into the WebView2 child window does not report the app as unfocused.
      setWindowState(shell!, 'click');
      await expect.poll(() => focusReport(page), { timeout: 10_000, message: 'the shell did not report the open window as focused' }).toBe(true);
      setWindowState(shell!, 'minimise');
      minimised = true;
      await expect.poll(() => focusReport(page), { timeout: 10_000, message: 'the shell did not report the minimised window as unfocused' }).toBe(false);
      await sleep(2000); // the app's live connection is up before the message is sent

      // Nadia writes to Omar in their direct message, naming him.
      await nadia.signIn(NADIA);
      const stamp = Date.now().toString();
      const opened = await nadia.ok<{ dm: { channel: { id: string } } }>('POST', '/api/dms', { personIds: [me.person.id] });
      const channelId = opened.dm.channel.id;
      const message = await nadia.ok<{ id: string }>('POST', `/api/channels/${channelId}/messages`, {
        channelId,
        body: `@${handleOf(me)} desktop app check ${stamp}`,
        threadRootId: null,
      });
      sent = { channelId, messageId: message.id };

      await expect
        .poll(
          async () => {
            const alerts = await page.evaluate(() => (window as unknown as { __alerts: { title: string; body: string }[] }).__alerts);
            return alerts.some((a) => a.title.includes(stamp) || a.body.includes(stamp));
          },
          { timeout: 30_000, intervals: [500, 1000], message: 'no Notification mentioning the test message was raised within 30 s' },
        )
        .toBe(true);

      // Back in front and clicked into: the page must be told it has the person's attention again (a Focused(false) for the
      // WebView2 child window would raise alerts for what the person is looking at).
      setWindowState(shell!, 'click');
      minimised = false;
      await expect.poll(() => focusReport(page), { timeout: 10_000, message: 'the page was not told the restored, clicked window is focused' }).toBe(true);
    } finally {
      if (minimised) setWindowState(shell!, 'restore');
      if (sent) await nadia.call('DELETE', `/api/channels/${sent.channelId}/messages/${sent.messageId}`).catch(() => undefined);
      if (originalPrefs) await omar.call('PUT', '/api/notifications/prefs', originalPrefs).catch(() => undefined);
      await nadia.signOut();
      await omar.signOut();
    }
  });

  test('4. signs out through the app', async () => {
    if (shell!.child.exitCode !== null) shell = await launch(env());
    const page = shell!.page();
    expect(await settle(page)).toBe('shell');
    await signOutInApp(page);
    expect(new URL(page.url()).pathname).toMatch(/\/sign-in/);
  });
});
