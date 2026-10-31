# The manythreads desktop app

The desktop app is a window of its own around your manythreads server. It shows the same pages as the browser, and adds system
alerts, `manythreads://` links and a single running copy. It lives in `clients/desktop` and is built with Tauri 2 (a toolkit that
wraps a web page in a native window; the page is drawn by the web view that comes with the operating system).

Windows, macOS and Linux builds exist. They are **not signed** yet (see "What is not done").

## Install and open

1. Get an installer from the `desktop` workflow of the repository (Actions, "desktop", the run's artifacts), or build one yourself (below).
2. Install and open it. If no server is saved, a first screen asks for the address. It shows `https://manythreads.kahf.to`; change it to your own
   server if you have one, and press **Connect**.
3. The app asks the address for `/healthz` (the server's "I am running" page). If the address does not answer, or answers
   something that is not manythreads, the screen says so in plain words and nothing is saved.
4. After **Connect** the window opens the server and you sign in as in the browser. The address is kept in `config.json` in the
   app's settings folder (on Windows `%APPDATA%\to.kahf.manythreads`), so next time the app opens straight into the server.

An address must start with `https://`. Plain `http://` is accepted only for a server on the same computer (`localhost`, `127.0.0.1`).

To go back to the first screen: menu **manythreads**, **Change server…**.

The environment variable `MANYTHREADS_SERVER_URL` overrides the saved address for one run (it is not saved). Tests use it.

## Notifications

The page already asks for permission and raises alerts through the browser's `Notification` object. The app replaces that object with
one that shows a system alert, so the page needs no change: **Account, Notifications, "Alerts while manythreads is open"** works as in the browser.
On Windows permission is always given; on macOS the system asks the first time.

Browser push (alerts while the app is closed) is not used in the app. The settings page says so instead of offering a switch that cannot work.

The page raises an alert only when the person is looking elsewhere. WebView2 keeps saying the page is visible and focused when the window is minimised, so the shell tells the page the real window focus (`window.__manythreadsDesktopFocused`, set on every focus change and after each page load) and the web client uses that inside the app.

A system alert does not bring the window to the front when pressed: the notification plugin gives no click event on desktop yet.

## Links

`manythreads://` links open the same path on your server in the app: `manythreads:///t/acme/channels/general` opens
`<server>/t/acme/channels/general`. The text after `manythreads:` must be a path starting with `/`. A link that names another site
(`manythreads://evil.example/...`) is ignored. If the app is already running, the link goes to the running window.

## Other links and downloads

Pages of your server open in the window. A link to any other site opens in your normal browser, never inside the app.
Files of your server (the **Download** button) are saved to the Downloads folder. On Windows the system's own download bubble shows them;
on macOS and Linux the app saves the file and shows it in the folder when it is done (not yet run on those systems).

## When the server is down

The app opens the saved server straight away, so a server that is down shows the web view's own "cannot reach this page" screen.
Use menu **manythreads**, **Change server…** to go back to the first screen, or reload when the server is back.

## Sign-in

Password sign-in and sign-in with an outside identity provider (Google, Microsoft, any OpenID Connect provider) both work in the window.
When you press a "Sign in with ..." button, the window goes to the server's `/api/auth/oidc/<provider>/start` page, which sends it on to the
provider. For up to ten minutes after that the window may show the provider's own `https://` pages (`http://` only for `localhost`) instead of
handing them to your browser, and the sign-in ends when the window comes back to any page of your server (the callback). Outside that
time every other site opens in your normal browser. A provider's page has no access to the app's native features.

## Build it

You need Node 22 with pnpm, Rust (rustup), and on Windows the Visual Studio Build Tools with the "Desktop development with C++" part. On Linux install
`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev libxdo-dev`.

```
pnpm install
pnpm -C clients/desktop dev          # run it with the first screen or MANYTHREADS_SERVER_URL
pnpm -C clients/desktop test         # the Rust unit tests (address rules, link mapping)
pnpm -C clients/desktop bundle:debug  # installers, fast and unoptimised
pnpm -C clients/desktop bundle        # installers for release, in src-tauri/target/release/bundle
```

Smoke test (Windows only, needs the debug exe and the internet): `pnpm -C clients/desktop bundle:debug` then `pnpm e2e:desktop`. It starts the built `manythreads-desktop.exe` with a WebView2 DevTools port, drives it with Playwright over CDP against https://manythreads.kahf.to (anonymous only, no sign-in) and checks the sign-in page, notifications, that the page cannot call the first-screen commands, `manythreads://` links, the navigation guard and the first-run screen. It skips itself when the exe is missing (`MANYTHREADS_DESKTOP_EXE` points it elsewhere) and is not part of `pnpm e2e` or the devbox CI. A copy of the app must not be running; the first-run case writes and then removes `config.json`.

Signed-in smoke test (Windows only, needs the debug exe and the live server): `pnpm e2e:desktop:signin`. It runs `e2e/desktop/tauri-signin.spec.ts` and reads the sign-in details only from the environment (`MANYTHREADS_URL`, default https://manythreads.kahf.to; `OMAR_EMAIL` and `OMAR_PASSWORD` for the owner; `NADIA_EMAIL` and `NADIA_PASSWORD` for a member). In Git Bash:

```
set -a; source <(ssh devbox cat '~/manythreads.passwords.env'); set +a; pnpm e2e:desktop:signin
```

It signs in through the app's own form, restarts the app and checks the session is still there, then signs out through the account menu. Every case skips with a message when `OMAR_*` is missing (the mention case also needs `NADIA_*`). The mention case posts one direct message from Nadia to Omar that names him, waits for the system alert the app raises (the window is really minimised, by Win32 `ShowWindow`, so the shell reports it as not focused), and then deletes the message. It also turns Omar's "system alert on mentions" switch on for the run if it is off, and puts it back. The app runs with a throw-away profile (`WEBVIEW2_USER_DATA_FOLDER` in a temporary folder), so your own desktop session is untouched, and the test records no trace, video or screenshot because the password is typed. `pnpm e2e:desktop` stays anonymous only.

The script is called `bundle`, not `build`, on purpose: `pnpm build` at the repository root runs every package's `build`, and that must not need Rust.

The `desktop` workflow builds unsigned installers for the three systems. It runs only when started by hand or when a tag
named `desktop-v...` is pushed.

## How it is put together

- The window loads the live server directly instead of a copy of the web client, so sign-in, cookies and the server's security rules behave as in a browser.
- The page may call the app's native features only through a capability (a list of permissions per address). `capabilities/remote-default.json` grants
  the three notification calls the page's `Notification` replacement makes (not `notification:default`) to `https://manythreads.kahf.to`; for any other server the app builds the same grant when it starts, from the address you chose (`allow_server` in `src-tauri/src/lib.rs`).
  The two commands of the first screen (`default_server`, `connect_server`) are granted only to the bundled screen, never to a server's page.
- The server's pages limit where a page may connect (`connect-src 'self'`). Tauri's fast channel to the app is therefore refused there, and Tauri
  falls back to its message channel (`postMessage`), which the page policy does not cover. Notifications work through that fallback.
- Pure rules (address checks, link mapping, which navigations stay) are in `src-tauri/src/server.rs` with unit tests.
- The window remembers its size and place. Its minimum size is 900 by 600.

## What is not done

- Installers are unsigned: Windows shows a SmartScreen warning, macOS needs "Open anyway". No auto-update.
- Clicking a system alert does not focus the window.
- Web Push (the settings page says that alerts come while the app is open).
- Speech input (a separate task).
- The icon is a placeholder drawn for this task.
- Not yet run on macOS and Linux (the workflow builds them).
