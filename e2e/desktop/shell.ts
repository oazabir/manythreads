import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

// Shared by the desktop shell specs (tauri-smoke.spec.ts, tauri-signin.spec.ts): launch the built debug exe with a WebView2 DevTools
// port, attach Playwright over CDP, kill the whole process tree.

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
export const EXE = process.env['MANYTHREADS_DESKTOP_EXE'] ?? join(ROOT, 'clients/desktop/src-tauri/target/debug/manythreads-desktop.exe');
export const IDENTIFIER = 'to.kahf.manythreads';
export const exeMissing = process.platform === 'win32' && !existsSync(EXE);

export const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });

/** What the page sees of the shell (the browser side of the evaluate callbacks). */
export interface TauriWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kills the process and every child (the WebView2 helpers) by process tree. */
export const killTree = (child: ChildProcess | undefined) => {
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
};

export interface Shell {
  child: ChildProcess;
  browser: Browser;
  env: NodeJS.ProcessEnv;
  /** The window's page (the first one that is not about:blank). */
  page: () => Page;
}

/** The process environment without the test accounts' variables, so the exe and its WebView2 helpers never inherit a password. */
const cleanEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([k]) => !/^(OMAR|NADIA)_/.test(k)));

export async function launch(env: NodeJS.ProcessEnv): Promise<Shell> {
  const port = await freePort();
  const full = { ...cleanEnv(env), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
  const child = spawn(EXE, [], { env: full, stdio: 'ignore' });
  const deadline = Date.now() + 60_000;
  let browser: Browser | undefined;
  while (!browser) {
    if (child.exitCode !== null) throw new Error(`The shell exited early with code ${child.exitCode}`);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
    } catch (e) {
      if (Date.now() > deadline) {
        killTree(child);
        throw new Error(`No DevTools port after 60 s: ${String(e)}`);
      }
      await sleep(500);
    }
  }
  const page = () => {
    const real = browser!
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url() !== 'about:blank');
    if (!real) throw new Error('The shell has no page yet');
    return real;
  };
  // The window may open about:blank first; wait for a real page.
  while (
    !browser
      .contexts()
      .flatMap((c) => c.pages())
      .some((p) => p.url() !== 'about:blank')
  ) {
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error('The window never showed a page');
    }
    await sleep(300);
  }
  return { child, browser, env: full, page };
}

/** Runs the exe a second time (a link click does that); the single-instance plugin hands the argument to the first copy. */
export function secondLaunch(shell: Shell, arg: string): Promise<number | null> {
  return new Promise((ok, fail) => {
    const second = spawn(EXE, [arg], { env: shell.env, stdio: 'ignore' });
    const timer = setTimeout(() => {
      killTree(second);
      fail(new Error('The second launch did not exit within 30 s'));
    }, 30_000);
    second.once('exit', (code) => {
      clearTimeout(timer);
      ok(code);
    });
  });
}

/**
 * Minimises or restores the app's real main window (the one titled `manythreads`; the single-instance plugin has a hidden window of
 * its own) by process id, with user32 ShowWindow. `click` raises it above the other windows, restores it and then makes a real mouse click in the middle of the window (SetCursorPos, mouse_event), which
 * is what gives the WebView2 area genuine operating-system focus; a CDP click does not. CDP `Browser.setWindowBounds` does not do this to a Tauri window.
 */
export function setWindowState(shell: Shell, state: 'minimise' | 'restore' | 'click'): void {
  const script = `
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  public struct RECT { public int L, T, R, B; }
}
'@
$target = ${shell.child.pid}
$cmd = ${state === 'minimise' ? 6 : 9}
$click = ${state === 'click' ? '$true' : '$false'}
[Win]::EnumWindows({ param($h, $p)
  $owner = 0
  [Win]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
  if ($owner -eq $target -and [Win]::IsWindowVisible($h)) {
    $text = New-Object System.Text.StringBuilder 256
    [Win]::GetWindowText($h, $text, 256) | Out-Null
    if ($text.ToString() -eq 'manythreads') { if ($click) { [Win]::ShowWindow($h, 6) | Out-Null; Start-Sleep -Milliseconds 500 } # a minimise first raises it above the other windows
      [Win]::ShowWindow($h, $cmd) | Out-Null
      if ($click) {
        Start-Sleep -Milliseconds 800
        $r = New-Object Win+RECT
        [Win]::GetWindowRect($h, [ref]$r) | Out-Null
        [Win]::SetCursorPos([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2)) | Out-Null
        [Win]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [Win]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      }
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
`;
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    stdio: 'ignore',
  });
  if (run.status !== 0) throw new Error(`Could not ${state} the window (PowerShell exit ${run.status})`);
}

export async function stop(shell: Shell | undefined) {
  if (!shell) return;
  await shell.browser.close().catch(() => undefined);
  killTree(shell.child);
  await sleep(1000);
}

