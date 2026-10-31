import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { EXE, IDENTIFIER, ROOT, exeMissing, launch, secondLaunch, sleep, stop, type Shell, type TauriWindow } from './shell.ts';

// Smoke test of the Tauri desktop shell (PLAN P10-11): the real built debug exe, driven over CDP (WebView2 opens a DevTools port when
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS carries --remote-debugging-port), against the LIVE site. Anonymous only: it never signs in.
//   pnpm -C clients/desktop bundle:debug && pnpm e2e:desktop
// Windows only. Not part of `pnpm e2e` (see desktop.config.ts). The signed-in counterpart is tauri-signin.spec.ts.

const SERVER = 'https://manythreads.kahf.to';
const SHOT = join(ROOT, 'temp/screenshots/desktop-sign-in.png');

test.skip(process.platform !== 'win32', 'The desktop shell smoke test drives WebView2 and runs on Windows only.');
test.skip(exeMissing, `The debug exe is missing (${EXE}); build it first: pnpm -C clients/desktop bundle:debug`);

test.describe.configure({ mode: 'serial' });

test.describe('server window (live site, anonymous)', () => {
  let shell: Shell | undefined;
  let appData: string;

  test.beforeAll(async () => {
    appData = mkdtempSync(join(tmpdir(), 'manythreads-desktop-'));
    shell = await launch({ APPDATA: appData, MANYTHREADS_SERVER_URL: SERVER });
  });

  test.afterAll(async () => {
    await stop(shell);
    rmSync(appData, { recursive: true, force: true });
  });

  test('a. opens the live server and shows the sign-in form', async () => {
    const page = shell!.page();
    await page.waitForURL(/^https:\/\/manythreads\.kahf\.to\/(sign-in|login)/, { timeout: 60_000 });
    await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 30_000 });
    expect((await page.title()).length).toBeGreaterThan(0);
    await expect(page.locator('body')).toContainText(/sign in/i);
    mkdirSync(dirname(SHOT), { recursive: true });
    await page.screenshot({ path: SHOT });
  });

  test('b. native notifications work from the page', async () => {
    const page = shell!.page();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as TauriWindow).__TAURI_INTERNALS__), { timeout: 15_000 }).toBe('object');
    await expect.poll(() => page.evaluate(() => Notification.permission), { timeout: 15_000 }).toBe('granted');
    const result = await page.evaluate(async () => {
      let constructed = 'ok';
      try {
        new Notification('manythreads smoke', { body: 'test' });
      } catch (e) {
        constructed = String(e);
      }
      let ipc = 'ok';
      try {
        await (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke('plugin:notification|notify', { options: { title: 'manythreads smoke', body: 'test' } });
      } catch (e) {
        ipc = String(e);
      }
      return { constructed, ipc };
    });
    expect(result).toEqual({ constructed: 'ok', ipc: 'ok' });
  });

  test('c. the page cannot call the first-screen or core commands', async () => {
    const page = shell!.page();
    const calls: [string, Record<string, unknown>][] = [
      ['default_server', {}],
      ['connect_server', { url: 'https://example.com' }],
      ['plugin:opener|open_url', { url: 'https://example.com' }],
      ['plugin:opener|open_path', { path: 'C:\\Windows\\System32\\calc.exe' }],
      ['plugin:window-state|save_window_state', { flags: 255 }],
      ['plugin:deep-link|get_current', {}],
    ];
    for (const [cmd, args] of calls) {
      const outcome = await page.evaluate(
        async ([c, a]) => {
          try {
            await (window as unknown as TauriWindow).__TAURI_INTERNALS__.invoke(c, a);
            return 'resolved';
          } catch (e) {
            return `rejected: ${String(e)}`;
          }
        },
        [cmd, args] as const,
      );
      expect(outcome, cmd).toMatch(/^rejected/);
    }
    // Still on the server: nothing above navigated the window.
    expect(shell!.page().url()).toContain('manythreads.kahf.to');
  });

  test('d. a manythreads:// link goes to the running window; a link to another host is ignored', async () => {
    const page = shell!.page();
    const code = await secondLaunch(shell!, 'manythreads:///sign-in?from=smoke');
    expect(code).not.toBeNull();
    await page.waitForURL(`${SERVER}/sign-in?from=smoke`, { timeout: 30_000 });
    // A link that names another host changes nothing.
    await secondLaunch(shell!, 'manythreads://evil.example/x');
    await sleep(3000);
    expect(shell!.page().url()).toBe(`${SERVER}/sign-in?from=smoke`);
  });

  test('e. the window does not leave the server for another site', async () => {
    const page = shell!.page();
    await page.evaluate(() => {
      location.href = 'https://example.com/';
    });
    await sleep(5000);
    // The shell hands the link to the system browser (a side effect of this test); the window itself stays.
    expect(new URL(shell!.page().url()).origin).toBe(SERVER);
  });
});

test.describe('server picker (first run)', () => {
  let shell: Shell | undefined;
  let appData: string;
  let realConfig: string;
  let realExisted = false;

  test.beforeAll(() => {
    appData = mkdtempSync(join(tmpdir(), 'manythreads-desktop-'));
    realConfig = join(process.env['APPDATA'] ?? '', IDENTIFIER, 'config.json');
    realExisted = existsSync(realConfig);
  });

  test.afterAll(async () => {
    await stop(shell);
    // APPDATA may not isolate the app (Windows looks the folder up by id); remove a config this test wrote into the real folder.
    if (!realExisted) rmSync(dirname(realConfig), { recursive: true, force: true });
    rmSync(appData, { recursive: true, force: true });
  });

  test('f. shows the default address, refuses http, connects and saves', async () => {
    test.skip(realExisted, `A saved server exists at ${realConfig}; not touching it.`);
    const env: NodeJS.ProcessEnv = { APPDATA: appData, MANYTHREADS_SERVER_URL: '' };
    shell = await launch(env);
    const page = shell.page();
    const input = page.locator('#url');
    await expect(input).toHaveValue(SERVER, { timeout: 30_000 });

    await input.fill('http://example.com');
    await page.locator('#connect').click();
    await expect(page.locator('#notice')).toContainText(/https/i, { timeout: 15_000 });

    await input.fill(SERVER);
    await page.locator('#connect').click();
    await page.waitForURL(/^https:\/\/manythreads\.kahf\.to\//, { timeout: 60_000 });

    const saved = [join(appData, IDENTIFIER, 'config.json'), realConfig].find((p) => existsSync(p));
    expect(saved, 'config.json was written').toBeTruthy();
    expect(JSON.parse(readFileSync(saved!, 'utf8'))).toEqual({ serverUrl: SERVER });
    console.log(`config.json written to ${saved!.startsWith(appData) ? 'the isolated APPDATA' : 'the real APPDATA (isolation not honoured)'}`);
  });
});
