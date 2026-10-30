//! The rules about addresses, kept free of any window or file so they can be tested alone:
//! which server addresses are accepted, how a `manythreads://` link becomes a page of the server,
//! and which navigations stay in the shell window.

use std::{
    fmt,
    time::{Duration, Instant},
};
use tauri::Url;

/// The server the picker offers first.
pub const DEFAULT_SERVER: &str = "https://manythreads.kahf.to";
/// The link scheme this app handles (`manythreads://...`).
pub const SCHEME: &str = "manythreads";

#[derive(Debug, PartialEq, Eq)]
pub enum ServerUrlError {
    Empty,
    NotAnAddress,
    NeedsHttps,
    HasLogin,
}

impl fmt::Display for ServerUrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ServerUrlError::Empty => "Type the address of your manythreads server.",
            ServerUrlError::NotAnAddress => "That does not look like a web address. It should look like https://chat.example.com.",
            ServerUrlError::NeedsHttps => "The address must start with https://. Plain http:// is allowed only for a server on this computer (localhost).",
            ServerUrlError::HasLogin => "Leave the user name and password out of the address. You sign in on the server itself.",
        })
    }
}

fn is_local_host(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]"))
}

/// Turns what a person typed into the server's origin (scheme, host, port; no path).
/// A bare host such as `chat.example.com` is read as `https://chat.example.com`.
pub fn parse_server_url(input: &str) -> Result<Url, ServerUrlError> {
    let typed = input.trim();
    if typed.is_empty() {
        return Err(ServerUrlError::Empty);
    }
    let full = if typed.contains("://") { typed.to_string() } else { format!("https://{typed}") };
    let url = Url::parse(&full).map_err(|_| ServerUrlError::NotAnAddress)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(ServerUrlError::NeedsHttps);
    }
    // A name of letters, digits, dots and dashes, or an IPv6 address: nothing a capability address pattern could read as a wildcard.
    let host = url.host_str().unwrap_or_default();
    if host.is_empty() || !(host.starts_with('[') || host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')) {
        return Err(ServerUrlError::NotAnAddress);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ServerUrlError::HasLogin);
    }
    if url.scheme() == "http" && !is_local_host(&url) {
        return Err(ServerUrlError::NeedsHttps);
    }
    Url::parse(&url.origin().ascii_serialization()).map_err(|_| ServerUrlError::NotAnAddress)
}

/// `https://host[:port]` of a server, the form a capability's remote URL list wants (with `/*` added by the caller).
pub fn origin_of(server: &Url) -> String {
    server.origin().ascii_serialization()
}

/// Maps a link such as `manythreads:///t/acme/channels/general?x=1` to the same path on the server.
/// Only a path of the server is accepted: the text after `manythreads:` (and an optional `//`) must start with a single `/`.
/// Anything that could name another host (`manythreads://evil.example/x`, `manythreads:////evil.example`, a backslash, a blank or control character)
/// gives `None`.
pub fn deep_link_to_url(server: &Url, link: &str) -> Option<Url> {
    let link = link.trim();
    let prefix_len = SCHEME.len() + 1;
    if link.len() < prefix_len || !link.is_char_boundary(prefix_len) || !link[..prefix_len].eq_ignore_ascii_case(&format!("{SCHEME}:")) {
        return None;
    }
    let mut rest = &link[prefix_len..];
    if let Some(after) = rest.strip_prefix("//") {
        rest = after;
    }
    if !rest.starts_with('/') || rest.starts_with("//") {
        return None;
    }
    if rest.chars().any(|c| c == '\\' || c.is_whitespace() || c.is_control()) {
        return None;
    }
    let target = Url::parse(&format!("{}{}", origin_of(server), rest)).ok()?;
    (target.origin() == server.origin()).then_some(target)
}

/// What the shell does with a navigation the page (or a link in it) asks for.
#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    /// Stay in the shell window.
    Internal,
    /// Hand it to the system browser (or mail program).
    External,
    /// Do nothing.
    Blocked,
}

fn is_app_page(url: &Url) -> bool {
    url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port().is_none())
}

/// How long a sign-in through an outside identity provider may take (the server keeps its half for ten minutes).
pub const SIGN_IN_WINDOW: Duration = Duration::from_secs(600);

/// `/api/auth/oidc/<provider>/start` on the server: the page the "Sign in with ..." buttons go to. The server answers it with a redirect to the
/// identity provider, which later redirects back to `/api/auth/oidc/callback`.
fn is_sign_in_start(url: &Url, server: &Url) -> bool {
    url.origin() == server.origin()
        && url
            .path()
            .strip_prefix("/api/auth/oidc/")
            .and_then(|rest| rest.strip_suffix("/start"))
            .is_some_and(|provider| !provider.is_empty() && !provider.contains('/'))
}

/// Keeps track of a sign-in through an identity provider: it begins when the window goes to the server's start page and ends with the
/// next navigation to any other page of the server (the callback) or after [`SIGN_IN_WINDOW`]. `started` is when it began.
pub fn track_sign_in(url: &Url, server: Option<&Url>, started: Option<Instant>) -> Option<Instant> {
    match server {
        Some(s) if url.origin() == s.origin() => is_sign_in_start(url, s).then(Instant::now),
        _ => started.filter(|t| t.elapsed() < SIGN_IN_WINDOW),
    }
}

fn is_local_host_or_https(url: &Url) -> bool {
    url.scheme() == "https" || (url.scheme() == "http" && is_local_host(url))
}

/// `signing_in` is true while a sign-in through an identity provider is under way: the window may then visit the provider's own https pages
/// (Google, Microsoft, any OpenID Connect issuer) and come back. A page there has no capability, so it cannot call the app's native commands.
pub fn classify_navigation(url: &Url, server: Option<&Url>, signing_in: bool) -> Nav {
    match url.scheme() {
        "about" | "blob" => Nav::Internal,
        "mailto" => Nav::External,
        "http" | "https" | "tauri" => {
            if is_app_page(url) {
                return Nav::Internal;
            }
            match server {
                Some(s) if url.origin() == s.origin() => Nav::Internal,
                Some(_) if signing_in && is_local_host_or_https(url) => Nav::Internal,
                _ => Nav::External,
            }
        }
        _ => Nav::Blocked,
    }
}

/// Only these links are handed to the system; a page cannot make the shell open a file or a program.
pub fn may_open_outside(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// Where the shell starts.
#[derive(Debug, PartialEq, Eq)]
pub enum Startup {
    Server(Url),
    Picker { notice: Option<String> },
}

/// `env` is `MANYTHREADS_SERVER_URL` (it wins, and is never saved); `saved` is the address kept from the last run.
pub fn pick_startup(env: Option<&str>, saved: Option<&str>) -> Startup {
    if let Some(value) = env.filter(|v| !v.trim().is_empty()) {
        return match parse_server_url(value) {
            Ok(url) => Startup::Server(url),
            Err(e) => Startup::Picker { notice: Some(format!("MANYTHREADS_SERVER_URL is not usable. {e}")) },
        };
    }
    match saved.map(parse_server_url) {
        Some(Ok(url)) => Startup::Server(url),
        Some(Err(_)) | None => Startup::Picker { notice: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Url {
        Url::parse("https://manythreads.kahf.to").unwrap()
    }

    fn parse_ok(s: &str) -> String {
        origin_of(&parse_server_url(s).unwrap())
    }

    #[test]
    fn accepts_https_and_keeps_only_the_origin() {
        assert_eq!(parse_ok("https://chat.example.com"), "https://chat.example.com");
        assert_eq!(parse_ok("  https://chat.example.com/some/path?x=1#y "), "https://chat.example.com");
        assert_eq!(parse_ok("chat.example.com"), "https://chat.example.com");
        assert_eq!(parse_ok("https://chat.example.com:8443/"), "https://chat.example.com:8443");
    }

    #[test]
    fn http_only_for_this_computer() {
        assert_eq!(parse_ok("http://localhost:3000"), "http://localhost:3000");
        assert_eq!(parse_ok("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000");
        assert_eq!(parse_ok("http://[::1]:3000"), "http://[::1]:3000");
        assert_eq!(parse_server_url("http://chat.example.com"), Err(ServerUrlError::NeedsHttps));
        assert_eq!(parse_server_url("http://localhost.evil.com"), Err(ServerUrlError::NeedsHttps));
        assert_eq!(parse_server_url("http://127.0.0.1.evil.com"), Err(ServerUrlError::NeedsHttps));
    }

    #[test]
    fn refuses_other_things() {
        assert_eq!(parse_server_url("   "), Err(ServerUrlError::Empty));
        assert_eq!(parse_server_url("ftp://chat.example.com"), Err(ServerUrlError::NeedsHttps));
        assert_eq!(parse_server_url("file:///etc/passwd"), Err(ServerUrlError::NeedsHttps));
        assert_eq!(parse_server_url("javascript://x"), Err(ServerUrlError::NeedsHttps));
        assert_eq!(parse_server_url("https://user:pw@chat.example.com"), Err(ServerUrlError::HasLogin));
        assert_eq!(parse_server_url("https://user@chat.example.com"), Err(ServerUrlError::HasLogin));
        assert_eq!(parse_server_url("https://"), Err(ServerUrlError::NotAnAddress));
        assert_eq!(parse_server_url("https://exa mple.com"), Err(ServerUrlError::NotAnAddress));
        assert_eq!(parse_server_url("https://*.example.com"), Err(ServerUrlError::NotAnAddress));
        assert_eq!(parse_server_url("https://exa(mple.com"), Err(ServerUrlError::NotAnAddress));
    }

    #[test]
    fn deep_links_map_to_paths_of_the_server() {
        let s = server();
        let go = |l: &str| deep_link_to_url(&s, l).map(|u| u.to_string());
        assert_eq!(go("manythreads:///t/acme/c/general"), Some("https://manythreads.kahf.to/t/acme/c/general".into()));
        assert_eq!(go("manythreads:///open?thread=1&x=a%20b"), Some("https://manythreads.kahf.to/open?thread=1&x=a%20b".into()));
        assert_eq!(go("manythreads:/t/acme"), Some("https://manythreads.kahf.to/t/acme".into()));
        assert_eq!(go("MANYTHREADS:///x#frag"), Some("https://manythreads.kahf.to/x#frag".into()));
        assert_eq!(go("manythreads:///"), Some("https://manythreads.kahf.to/".into()));
    }

    #[test]
    fn deep_links_cannot_leave_the_server() {
        let s = server();
        for bad in [
            "manythreads://evil.example/x",
            "manythreads://evil.example",
            "manythreads:////evil.example/x",
            "manythreads://evil.example@manythreads.kahf.to/x",
            "manythreads:///\\evil.example",
            "manythreads:///x y",
            "manythreads:///x\n/y",
            "manythreads:",
            "manythreads://",
            "manythreads:path",
            "https://evil.example/x",
            "javascript:alert(1)",
            "other:///x",
            "",
            "é",
        ] {
            assert_eq!(deep_link_to_url(&s, bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn deep_link_with_dot_segments_stays_on_the_server() {
        let s = server();
        let u = deep_link_to_url(&s, "manythreads:///a/../../b").unwrap();
        assert_eq!(u.origin(), s.origin());
        assert_eq!(u.path(), "/b");
    }

    #[test]
    fn navigation_stays_on_the_server_only() {
        let s = server();
        let nav = |u: &str| classify_navigation(&Url::parse(u).unwrap(), Some(&s), false);
        assert_eq!(nav("https://manythreads.kahf.to/t/acme"), Nav::Internal);
        assert_eq!(nav("https://manythreads.kahf.to:8443/"), Nav::External);
        assert_eq!(nav("http://manythreads.kahf.to/"), Nav::External);
        assert_eq!(nav("https://manythreads.kahf.to.evil.example/"), Nav::External);
        assert_eq!(nav("https://github.com/x"), Nav::External);
        assert_eq!(nav("mailto:a@b.c"), Nav::External);
        assert_eq!(nav("tauri://localhost/index.html"), Nav::Internal);
        assert_eq!(nav("http://tauri.localhost/index.html"), Nav::Internal);
        assert_eq!(nav("https://tauri.localhost/index.html"), Nav::External);
        assert_eq!(nav("http://tauri.localhost:8080/index.html"), Nav::External);
        assert_eq!(nav("about:blank"), Nav::Internal);
        assert_eq!(nav("blob:https://manythreads.kahf.to/1234"), Nav::Internal);
        assert_eq!(nav("file:///c:/windows/system32/calc.exe"), Nav::Blocked);
        assert_eq!(nav("ms-msdt:/id"), Nav::Blocked);
        assert_eq!(nav("javascript:alert(1)"), Nav::Blocked);
    }

    #[test]
    fn with_no_server_every_web_address_is_external() {
        let u = Url::parse("https://manythreads.kahf.to/").unwrap();
        assert_eq!(classify_navigation(&u, None, false), Nav::External);
    }

    #[test]
    fn sign_in_start_is_only_the_servers_own_start_page() {
        let s = server();
        let is = |u: &str| is_sign_in_start(&Url::parse(u).unwrap(), &s);
        assert!(is("https://manythreads.kahf.to/api/auth/oidc/0190aaaa-bbbb/start"));
        assert!(is("https://manythreads.kahf.to/api/auth/oidc/0190aaaa-bbbb/start?returnTo=%2Ft%2Facme"));
        assert!(!is("https://manythreads.kahf.to/api/auth/oidc/callback"));
        assert!(!is("https://manythreads.kahf.to/api/auth/oidc//start"));
        assert!(!is("https://manythreads.kahf.to/api/auth/oidc/a/b/start"));
        assert!(!is("https://evil.example/api/auth/oidc/x/start"));
        assert!(!is("https://manythreads.kahf.to/sign-in"));
    }

    #[test]
    fn sign_in_lets_the_identity_provider_in_and_ends_at_the_callback() {
        let s = server();
        let url = |u: &str| Url::parse(u).unwrap();
        let idp = url("https://accounts.google.com/o/oauth2/v2/auth?client_id=1");
        // Outside a sign-in an outside page goes to the system browser.
        assert_eq!(classify_navigation(&idp, Some(&s), false), Nav::External);
        // The start page opens the sign-in; the provider stays in the window while it lasts.
        let started = track_sign_in(&url("https://manythreads.kahf.to/api/auth/oidc/p1/start"), Some(&s), None);
        assert!(started.is_some());
        assert_eq!(classify_navigation(&idp, Some(&s), true), Nav::Internal);
        // The provider's own pages keep it going; the callback on the server ends it.
        assert_eq!(track_sign_in(&idp, Some(&s), started), started);
        assert_eq!(track_sign_in(&url("https://manythreads.kahf.to/api/auth/oidc/callback?code=1"), Some(&s), started), None);
        // Even during a sign-in: no plain http to another host, no other schemes, no sign-in without a server.
        assert_eq!(classify_navigation(&url("http://idp.example/"), Some(&s), true), Nav::External);
        assert_eq!(classify_navigation(&url("http://localhost:8080/google/auth"), Some(&s), true), Nav::Internal);
        assert_eq!(classify_navigation(&url("file:///c:/x"), Some(&s), true), Nav::Blocked);
        assert_eq!(classify_navigation(&idp, None, true), Nav::External);
        // A sign-in that nobody finished runs out.
        let old = Instant::now().checked_sub(SIGN_IN_WINDOW + Duration::from_secs(1));
        assert_eq!(track_sign_in(&idp, Some(&s), old), None);
        assert_eq!(track_sign_in(&idp, None, started), started);
    }

    #[test]
    fn only_web_and_mail_links_leave_the_shell() {
        assert!(may_open_outside(&Url::parse("https://a.example").unwrap()));
        assert!(may_open_outside(&Url::parse("mailto:a@b.c").unwrap()));
        assert!(!may_open_outside(&Url::parse("file:///x").unwrap()));
        assert!(!may_open_outside(&Url::parse("ms-msdt:/id").unwrap()));
    }

    #[test]
    fn startup_prefers_env_then_saved_then_picker() {
        assert_eq!(pick_startup(Some("https://a.example"), Some("https://b.example")), Startup::Server(Url::parse("https://a.example").unwrap()));
        assert_eq!(pick_startup(None, Some("https://b.example")), Startup::Server(Url::parse("https://b.example").unwrap()));
        assert_eq!(pick_startup(Some(""), Some("https://b.example")), Startup::Server(Url::parse("https://b.example").unwrap()));
        assert_eq!(pick_startup(None, None), Startup::Picker { notice: None });
        assert_eq!(pick_startup(None, Some("http://evil.example")), Startup::Picker { notice: None });
        assert!(matches!(pick_startup(Some("http://evil.example"), Some("https://b.example")), Startup::Picker { notice: Some(_) }));
    }
}
