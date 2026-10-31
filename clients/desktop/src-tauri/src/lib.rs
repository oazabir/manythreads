//! The manythreads desktop shell: a native window around the live server.
//! The window loads the server's own pages (so sign-in, cookies and the page's security rules are exactly the browser's);
//! the shell adds native notifications, `manythreads://` links, one running copy, and a first screen for choosing the server.

mod server;

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
#[cfg(not(windows))]
use tauri::webview::DownloadEvent;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

use server::{Nav, Startup};

const MAIN: &str = "main";
const SERVER_ENV: &str = "MANYTHREADS_SERVER_URL";
/// The only native features a server's pages get: what the page's `Notification` replacement calls. Keep in step with `capabilities/remote-default.json`.
const NOTIFICATION_PERMISSIONS: [&str; 3] = ["notification:allow-is-permission-granted", "notification:allow-request-permission", "notification:allow-notify"];

/// What the shell remembers while it runs.
#[derive(Default)]
struct Shell {
    /// The server the window shows; `None` while the first screen is up.
    server: Mutex<Option<Url>>,
    /// A line for the first screen (for example, why the environment override was refused).
    notice: Mutex<Option<String>>,
    /// Origins that already have a capability built for them at run time.
    granted: Mutex<HashSet<String>>,
    /// When a sign-in through an identity provider began, while one is under way (see `server::track_sign_in`).
    sign_in: Mutex<Option<Instant>>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavedConfig {
    server_url: Option<String>,
}

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn load_saved(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(config_path(app)?).ok()?;
    serde_json::from_str::<SavedConfig>(&text).ok()?.server_url
}

/// Keeps the address for the next start. A failure is not fatal: the app still opens the server, and asks again next time.
fn save_server(app: &AppHandle, url: &Url) {
    let Some(path) = config_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(body) = serde_json::to_string_pretty(&SavedConfig { server_url: Some(server::origin_of(url)) }) {
        let _ = std::fs::write(path, body);
    }
}

/// Lets the pages of `server` use the shell's native features (notifications). The default server is covered by
/// `capabilities/remote-default.json`; any other one gets the same grant built here, because a capability file cannot name an address
/// that is only known when the app runs.
fn allow_server(app: &AppHandle, server: &Url) -> Result<(), String> {
    let origin = server::origin_of(server);
    if origin == server::DEFAULT_SERVER {
        return Ok(());
    }
    let shell = app.state::<Shell>();
    let mut granted = shell.granted.lock().unwrap();
    if granted.contains(&origin) {
        return Ok(());
    }
    let slug: String = origin.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let capability = serde_json::json!({
        "identifier": format!("remote-{slug}"),
        "description": "A server the person chose may raise native notifications.",
        "local": false,
        "windows": [MAIN],
        "remote": { "urls": [format!("{origin}/*")] },
        "permissions": NOTIFICATION_PERMISSIONS,
    });
    app.add_capability(capability.to_string()).map_err(|e| format!("The app could not prepare that server: {e}"))?;
    granted.insert(origin);
    Ok(())
}

fn picker_url() -> Url {
    // Where the bundled first screen lives: Windows serves it from http://tauri.localhost, the other systems from tauri://localhost.
    let text = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    Url::parse(text).expect("the first-screen address is valid")
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Tells the page whether the real window has the person's attention. WebView2 keeps reporting `visibilityState` "visible" and
/// `hasFocus()` true after the window is minimised or another app is in front, so the web client reads this instead
/// (`raiseAlert` in `clients/web/src/notifications/store.ts`).
fn tell_focus(app: &AppHandle, focused: bool) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.eval(format!("window.__manythreadsDesktopFocused = {focused};"));
    }
}

fn open_outside(app: &AppHandle, url: &Url) {
    if server::may_open_outside(url) {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

fn current_server(app: &AppHandle) -> Option<Url> {
    app.state::<Shell>().server.lock().unwrap().clone()
}

fn set_server(app: &AppHandle, server: Option<Url>) {
    *app.state::<Shell>().server.lock().unwrap() = server;
}

/// Creates the one window. `target` is the page to open, or `None` for the first screen.
fn open_main(app: &AppHandle, target: Option<&Url>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN) {
        window.navigate(target.cloned().unwrap_or_else(picker_url))?;
        focus_main(app);
        return Ok(());
    }
    let url = match target {
        Some(u) => WebviewUrl::External(u.clone()),
        None => WebviewUrl::App("index.html".into()),
    };
    let on_navigate = app.clone();
    let on_new_window = app.clone();
    #[cfg(not(windows))]
    let on_download = app.clone();
    let builder = WebviewWindowBuilder::new(app, MAIN, url)
        .title("manythreads")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        // A page that has just loaded (a reload, a navigation) starts from the window's current state.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished && webview.label() == MAIN {
                let app = webview.app_handle();
                // On an error nothing is sent, so the web client falls back to its own check of the page.
                if let Some(focused) = app.get_webview_window(MAIN).and_then(|w| w.is_focused().ok()) {
                    tell_focus(app, focused);
                }
            }
        })
        .on_navigation(move |url| {
            let server = current_server(&on_navigate);
            let shell = on_navigate.state::<Shell>();
            let mut sign_in = shell.sign_in.lock().unwrap();
            *sign_in = server::track_sign_in(url, server.as_ref(), *sign_in);
            match server::classify_navigation(url, server.as_ref(), sign_in.is_some()) {
                Nav::Internal => true,
                Nav::External => {
                    open_outside(&on_navigate, url);
                    false
                }
                Nav::Blocked => false,
            }
        })
        .on_new_window(move |url, _features| {
            // A link that asks for a new window (target="_blank", window.open): the server's own pages open in this window, the rest outside.
            match server::classify_navigation(&url, current_server(&on_new_window).as_ref(), false) {
                Nav::Internal => {
                    if let Some(window) = on_new_window.get_webview_window(MAIN) {
                        let _ = window.navigate(url);
                    }
                }
                Nav::External => open_outside(&on_new_window, &url),
                Nav::Blocked => {}
            }
            NewWindowResponse::Deny
        });
    // macOS and Linux drop a download unless the app takes it; Windows shows its own download bubble, which this would replace.
    // Only files of the server are taken, into the Downloads folder, and shown there when they are done.
    #[cfg(not(windows))]
    let builder = builder.on_download(move |_, event| match event {
        DownloadEvent::Requested { url, .. } => current_server(&on_download).is_some_and(|s| url.origin() == s.origin()),
        DownloadEvent::Finished { path: Some(path), success: true, .. } => {
            let _ = on_download.opener().reveal_item_in_dir(path);
            true
        }
        _ => true,
    });
    builder.build()?;
    Ok(())
}

fn handle_deep_link(app: &AppHandle, link: &str) {
    focus_main(app);
    let Some(server) = current_server(app) else { return };
    if let Some(target) = server::deep_link_to_url(&server, link) {
        if let Some(window) = app.get_webview_window(MAIN) {
            let _ = window.navigate(target);
        }
    }
}

/// The first screen asks `GET /healthz` of the address; a manythreads server answers `{"status":"ok", ...}`.
fn check_server(server: &Url) -> Result<(), String> {
    let host = server.host_str().unwrap_or("that address").to_string();
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(8))).build().into();
    let endpoint = format!("{}/healthz", server::origin_of(server));
    let not_reachable = format!("Could not reach {host}. Check the address and your internet connection.");
    let not_ours = format!("{host} answered, but it does not look like a manythreads server.");
    match agent.get(&endpoint).call() {
        Ok(mut response) => {
            let text = response.body_mut().read_to_string().map_err(|_| not_ours.clone())?;
            let json: serde_json::Value = serde_json::from_str(&text).map_err(|_| not_ours.clone())?;
            if json.get("status").and_then(|s| s.as_str()) == Some("ok") {
                Ok(())
            } else {
                Err(not_ours)
            }
        }
        Err(ureq::Error::StatusCode(_)) => Err(not_ours),
        Err(_) => Err(not_reachable),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickerState {
    default_url: String,
    saved_url: Option<String>,
    notice: Option<String>,
}

#[tauri::command]
fn default_server(app: AppHandle, shell: State<'_, Shell>) -> PickerState {
    PickerState {
        default_url: server::DEFAULT_SERVER.to_string(),
        saved_url: load_saved(&app),
        notice: shell.notice.lock().unwrap().take(),
    }
}

#[tauri::command]
async fn connect_server(app: AppHandle, url: String) -> Result<(), String> {
    let server = server::parse_server_url(&url).map_err(|e| e.to_string())?;
    let probe = server.clone();
    tauri::async_runtime::spawn_blocking(move || check_server(&probe)).await.map_err(|e| e.to_string())??;
    allow_server(&app, &server)?;
    save_server(&app, &server);
    set_server(&app, Some(server.clone()));
    open_main(&app, Some(&server)).map_err(|e| e.to_string())
}

fn change_server(app: &AppHandle) {
    set_server(app, None);
    let _ = open_main(app, None);
}

fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let change = MenuItem::with_id(app, "change-server", "Change server…", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let app_menu = Submenu::with_items(app, "manythreads", true, &[&change, &separator, &quit])?;
    // Without an Edit menu, copy and paste shortcuts do not work in the window on macOS.
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit])?)?;
    app.on_menu_event(|app, event| {
        if event.id() == "change-server" {
            change_server(app);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The single-instance plugin comes first. A second launch (for example by clicking a manythreads:// link) hands its
        // arguments to the first copy, which the deep-link plugin turns into an open-URL event, and then exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        // Without its own link-click script: that script would swallow target="_blank" clicks and ask the app to open them, which a server's page may not do.
        // Such links reach `on_new_window` above instead.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Shell::default())
        .on_window_event(|window, event| {
            if window.label() != MAIN {
                return;
            }
            match event {
                WindowEvent::Focused(focused) => tell_focus(window.app_handle(), *focused),
                // Once the page itself has been clicked, WebView2 holds the focus and minimising the window sends no `Focused(false)`;
                // the resize that comes with minimising and restoring is the signal then.
                WindowEvent::Resized(_) => match window.is_minimized() {
                    Ok(true) => tell_focus(window.app_handle(), false),
                    Ok(false) if window.is_focused().unwrap_or(false) => tell_focus(window.app_handle(), true),
                    _ => {}
                },
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![default_server, connect_server])
        .setup(|app| {
            let handle = app.handle().clone();
            install_menu(&handle)?;

            // Installed builds register the link scheme with the system; Linux AppImages and Windows development runs do it here.
            #[cfg(target_os = "linux")]
            let _ = app.deep_link().register_all();
            #[cfg(all(windows, debug_assertions))]
            let _ = app.deep_link().register_all();

            let env = std::env::var(SERVER_ENV).ok();
            match server::pick_startup(env.as_deref(), load_saved(&handle).as_deref()) {
                Startup::Server(server) => {
                    allow_server(&handle, &server)?;
                    set_server(&handle, Some(server.clone()));
                    // A link that started the app opens its page straight away.
                    let first = app
                        .deep_link()
                        .get_current()
                        .ok()
                        .flatten()
                        .and_then(|urls| urls.iter().find_map(|u| server::deep_link_to_url(&server, u.as_str())))
                        .unwrap_or(server);
                    open_main(&handle, Some(&first))?;
                }
                Startup::Picker { notice } => {
                    *handle.state::<Shell>().notice.lock().unwrap() = notice;
                    open_main(&handle, None)?;
                }
            }

            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&links, url.as_str());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the manythreads app failed to start");
}
