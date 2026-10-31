//! The browser tab's engine: a real web view, drawn by the OS.
//!
//! There are two ways to put a browser in a panel, and they are not the same
//! thing:
//!
//! * **A frame stream.** A separate browser process renders, and its pixels are
//!   encoded, sent and decoded into the panel. It is a real engine's output, but
//!   what the panel shows is an image of it — no native scrolling, no text
//!   selection, no IME, and every frame costs a JPEG.
//! * **A child web view.** The engine draws directly into the window. That is
//!   this module: `Window::add_child` gives the panel a real view, so the tab
//!   *is* the browser rather than a picture of one.
//!
//! On macOS the child view is WebKit (WKWebView). That is the honest trade:
//! WebKit is a real engine and it renders natively here, but it is *not* Blink,
//! so a page can behave as it does in Safari rather than as it does in Chrome.
//! There is no third option — another process's window cannot be embedded in
//! this one, which is why the Chrome path (`browser.rs`) can only ever mirror.
//!
//! A browser tab is a workspace tab like a file's, so there can be several at
//! once: one view per tab, keyed by the tab's id, and only the active one shown.
//! The page has no Tauri command access at all — it is in no capability — so
//! remote content cannot reach the app; the only channel runs the other way
//! (`browser_view_eval`).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl};

const BLANK: &str = "about:blank";

/// The scheme the page uses to ask for a new browser tab.
///
/// A web view drops new-window requests: `window.open` returns null and a
/// `target="_blank"` link does nothing at all (measured on a page with 48 of
/// them, which is exactly what "buttons work but links don't" is). Intercepting
/// them is what a browser does — it opens a tab — so the page reports the wanted
/// address through a scheme only we understand (`initialization_script`), the
/// navigation handler cancels it, and the app opens a real tab.
const NEW_TAB_SCHEME: &str = "orbit-tab";

/// The reserved tab name a run uses to ask for the column's agent tab.
///
/// Not a tab id: the app decides which id backs it, so a handed-over page (the
/// user's now) can retire one and the next run get a fresh one without the caller
/// knowing anything changed.
const AGENT_TAB: &str = "agent";

/// Installed into every page, before its own scripts: the shim above.
const NEW_TAB_SHIM: &str = r#"
(() => {
  const ask = (href) => {
    if (!href) return;
    const resolved = new URL(href, location.href).href;
    if (!/^https?:/i.test(resolved)) return;
    if ((window.__orbitAutomationClickUntil || 0) > Date.now()) location.href = resolved;
    else location.href = "orbit-tab:" + resolved;
  };
  const originalOpen = window.open;
  window.open = function (url, ...rest) {
    const href = typeof url === "string" ? url : url && url.href ? url.href : "";
    if (href) { ask(href); return null; }
    return originalOpen.call(window, url, ...rest);
  };
  document.addEventListener("click", (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest("a[target]") : null;
    if (!anchor || !anchor.href || anchor.target === "_self") return;
    event.preventDefault();
    ask(anchor.href);
  }, true);
})();
"#;

#[derive(Default)]
pub struct BrowserViewHost {
    tabs: Mutex<HashMap<String, Tab>>,
    /// The tab the user is looking at: what the agent's channel talks to when it
    /// does not name one.
    active: Mutex<String>,
    /// The agent's own tab, which sequential runs share.
    agent: Mutex<crate::browser_leases::BrowserLeases>,
    importing: std::sync::atomic::AtomicBool,
}

struct Tab {
    partition: Option<String>,
    view: Webview,
    /// The address we asked for. Deliberately *not* read back from the view:
    /// `Webview::url()` reaches wry's `url_from_webview`, which unwraps the
    /// WebKit URL — nil until the first load starts — so asking a just-created
    /// view for its URL panics.
    url: String,
    visible: bool,
    loading: bool,
    /// `wry` queues scripts (and *drops their callbacks*) until the first load
    /// finishes, so an eval sent too early hangs with nothing to show for it.
    loaded: bool,
    /// Where the view currently sits, in window-logical points: a trusted click
    /// is addressed in *screen* coordinates, so the view's own box is needed to
    /// turn a page point into one.
    rect: ViewRect,
}

impl Tab {
    fn status(&self) -> BrowserViewStatus {
        BrowserViewStatus {
            open: true,
            url: self.url.clone(),
            visible: self.visible,
            loading: self.loading,
            tab: String::new(),
        }
    }
}

/** Where a tab's page should sit, in window-logical pixels. */
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewStatus {
    pub open: bool,
    pub url: String,
    /// Whether the view is currently shown (a hidden tab keeps its page).
    pub visible: bool,
    pub loading: bool,
    /// The tab this status describes (the active one when the caller did not name
    /// one), so a client can address it afterwards.
    #[serde(default)]
    pub tab: String,
}

fn label_for(tab: &str) -> String {
    format!("browser-view-{}", tab.replace(|c: char| !c.is_ascii_alphanumeric(), "-"))
}

/// The web view's user agent.
///
/// Tauri's default macOS UA stops at `(KHTML, like Gecko)` — a real Safari also
/// says `Version/<n>.0 Safari/605.1.15`, and without that token sites treat the
/// client as unknown. (Measured: Baidu answered a search with a captcha page.)
/// This is genuine WebKit from the system, so naming the Safari version it
/// really is, is the honest fix; claiming to be Chrome would invite Blink-only
/// code paths WebKit cannot run.
fn user_agent() -> String {
    let version = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|text| text.trim().split('.').next().and_then(|major| major.parse::<u32>().ok()))
        .unwrap_or(15);
    // Apple aligned Safari's major with the OS year from macOS 26 on; before
    // that Safari ran three majors ahead of macOS (15 → 18).
    let safari = if version >= 26 { version } else { version + 3 };
    format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{safari}.0 Safari/605.1.15"
    )
}

fn parse(url: &str) -> Result<Url, String> {
    let value = url.trim();
    let value = if value.is_empty() { BLANK } else { value };
    Url::parse(value).map_err(|error| format!("无效地址 {value}：{error}"))
}

/// The one rule for turning a tab argument into a tab id: an empty name means
/// "the tab the user is looking at", anything else is that exact tab.
fn choose_tab_id(active: &str, tab: &str) -> String {
    if tab.is_empty() { active.to_string() } else { tab.to_string() }
}

/// The one place a tab argument is resolved, shared by every op on purpose.
///
/// Two resolvers is how "observe reads the active tab while the click goes to
/// the tab captured at open time" happened: the caller named a tab and half the
/// channel ignored it.
fn resolve_tab_id(host: &BrowserViewHost, tab: &str) -> Result<String, String> {
    let active = host.active.lock().map_err(|error| error.to_string())?.clone();
    Ok(choose_tab_id(&active, tab))
}

fn with_tab<T>(host: &BrowserViewHost, tab: &str, run: impl FnOnce(&Tab) -> T) -> Result<T, String> {
    let id = resolve_tab_id(host, tab)?;
    let tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    let state = tabs.get(&id).ok_or_else(|| "浏览器标签页尚未打开".to_string())?;
    Ok(run(state))
}

fn status(host: &BrowserViewHost, tab: &str) -> BrowserViewStatus {
    with_tab_status(host, tab).unwrap_or_default()
}

fn with_tab_status(host: &BrowserViewHost, tab: &str) -> Result<BrowserViewStatus, String> {
    let id = resolve_tab_id(host, tab)?;
    let tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    Ok(tabs
        .get(&id)
        .map(|state| BrowserViewStatus { tab: id.clone(), ..state.status() })
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create the tab's view on first use, then keep it where the tab says it is.
///
/// `add_child`, `set_position`, `set_size` and show/hide are desktop window
/// APIs, so the phone gets the stub below rather than a module that cannot
/// build.
#[cfg(desktop)]
#[tauri::command(async)]
pub fn browser_view_sync(
    app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
    rect: ViewRect,
    url: Option<String>,
    visible: Option<bool>,
) -> Result<BrowserViewStatus, String> {
    let wanted = url.as_deref().map(parse).transpose()?;
    let shown = visible.unwrap_or(true);
    if host.importing.load(std::sync::atomic::Ordering::SeqCst) { return Err("正在导入浏览器资料，请稍后再试".into()); }
    let partition = crate::browser::active_partition();
    let mut tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    if tabs.get(&tab).is_some_and(|state| state.partition != partition) {
        if let Some(previous) = tabs.remove(&tab) { previous.view.close().map_err(|e| e.to_string())?; }
        forget_agent_tab(&host, &tab);
    }
    if !tabs.contains_key(&tab) && !shown {
        // Nothing to hide: a tab that is not on screen must not create a view.
        return Ok(BrowserViewStatus::default());
    }
    if !tabs.contains_key(&tab) {
        let window = app
            .get_window("main")
            .ok_or_else(|| "主窗口不存在，无法放置浏览器视图".to_string())?;
        let target = wanted.clone().unwrap_or_else(|| parse(BLANK).expect("about:blank parses"));
        let label = label_for(&tab);
        let app_for_new_tab = app.clone();
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target.clone()))
            // The view is the browser: text is selected, dragged and zoomed by
            // the OS, exactly as in Safari.
            .zoom_hotkeys_enabled(true)
            // Without this, macOS eats the first click after the window loses
            // focus ("click-through"): the click activates the window and never
            // reaches the page, which reads as "clicking does nothing".
            .accept_first_mouse(true)
            .initialization_script(NEW_TAB_SHIM)
            .on_navigation(move |url| {
                if url.scheme() != NEW_TAB_SCHEME {
                    return true;
                }
                // Everything after the scheme is the address the page asked for.
                let wanted = url.path().to_string();
                if wanted.is_empty() {
                    return false;
                }
                let _ = app_for_new_tab.emit("browser:open", serde_json::json!({ "url": wanted }));
                false
            })
            .user_agent(&user_agent())
            // Load events are the only signal the toolbar has for "still
            // fetching", and the only signal the driving channel has for
            // "scripts will be delivered".
            .on_page_load(move |webview, payload| {
                let app = webview.app_handle().clone();
                let loading = matches!(payload.event(), PageLoadEvent::Started);
                let label = webview.label().to_string();
                if let Some(host) = app.try_state::<BrowserViewHost>() {
                    if let Ok(mut tabs) = host.tabs.lock() {
                        // Found by label: the tab id is what the label was made
                        // from, and the closure cannot borrow the outer map.
                        if let Some(state) = tabs.values_mut().find(|state| state.view.label() == label) {
                            state.loading = loading;
                            // Wry emits Started at document commit, before
                            // optional images/video/subresources finish. Once
                            // this callback returns, evaluation is available.
                            state.loaded = true;
                        }
                    }
                }
            });
        let builder = configure_partition(builder, partition.as_deref())?;
        let view = window
            .add_child(
                builder,
                LogicalPosition::new(rect.x, rect.y),
                LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)),
            )
            .map_err(|error| format!("无法创建浏览器视图：{error}"))?;
        tabs.insert(
            tab.clone(),
            Tab {
                partition,
                view,
                url: target.to_string(),
                visible: false,
                loading: target.as_str() != BLANK,
                loaded: false,
                rect,
            },
        );
        if tabs.len() == 1 {
            if let Ok(mut active) = host.active.lock() {
                *active = tab.clone();
            }
        }
    }
    let state = tabs.get_mut(&tab).expect("just inserted");
    state.rect = rect;
    state
        .view
        .set_position(LogicalPosition::new(rect.x, rect.y))
        .map_err(|error| error.to_string())?;
    state
        .view
        .set_size(LogicalSize::new(rect.width.max(1.0), rect.height.max(1.0)))
        .map_err(|error| error.to_string())?;
    if let Some(target) = wanted {
        // `about:blank` is what an empty tab starts on; navigating away from it
        // is the caller's decision, so only act when they asked for a page.
        if target.as_str() != state.url && target.as_str() != BLANK {
            state.view.navigate(target.clone()).map_err(|error| error.to_string())?;
            state.url = target.to_string();
        }
    }
    if shown != state.visible {
        // Show/hide only on a change: re-showing on every placement can take the
        // keyboard away from the app's own fields (the address bar).
        match shown {
            true => state.view.show().map_err(|error| error.to_string())?,
            false => state.view.hide().map_err(|error| error.to_string())?,
        }
        state.visible = shown;
        eprintln!(
            "[view] tab {tab} {} rect={},{} {}x{}",
            if shown { "shown" } else { "hidden" },
            rect.x.round(),
            rect.y.round(),
            rect.width.round(),
            rect.height.round()
        );
    }
    Ok(state.status())
}

/// A phone has no browser column, so there is no view to place.
#[cfg(mobile)]
#[tauri::command(async)]
pub fn browser_view_sync(
    _app: AppHandle,
    _host: tauri::State<'_, BrowserViewHost>,
    _tab: String,
    _rect: ViewRect,
    _url: Option<String>,
    _visible: Option<bool>,
) -> Result<BrowserViewStatus, String> {
    Err("手机端没有浏览器栏".to_string())
}

/// Tell the app which browser tab is in front: the agent's channel follows it.
#[tauri::command(async)]
pub fn browser_view_activate(host: tauri::State<'_, BrowserViewHost>, tab: String) -> Result<(), String> {
    if let Ok(mut active) = host.active.lock() {
        *active = tab;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn browser_view_navigate(
    _app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
    url: String,
) -> Result<BrowserViewStatus, String> {
    let target = parse(&url)?;
    let id = resolve_tab_id(&host, &tab)?;
    let mut tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    let state = tabs.get_mut(&id).ok_or_else(|| "浏览器标签页尚未打开".to_string())?;
    state.loaded = false;
    state.loading = true;
    state.view.navigate(target.clone()).map_err(|error| error.to_string())?;
    state.url = target.to_string();
    Ok(state.status())
}

#[tauri::command(async)]
pub fn browser_view_go(_app: AppHandle, host: tauri::State<'_, BrowserViewHost>, tab: String, direction: String) -> Result<(), String> {
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        other => return Err(format!("未知方向 {other}")),
    };
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    view.eval(script).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn browser_view_reload(_app: AppHandle, host: tauri::State<'_, BrowserViewHost>, tab: String) -> Result<(), String> {
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    view.reload().map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn browser_view_stop(_app: AppHandle, host: tauri::State<'_, BrowserViewHost>, tab: String) -> Result<(), String> {
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    view.eval("window.stop()").map_err(|error| error.to_string())
}

/// Run a script in a tab's page and return its result as JSON.
///
/// This is the whole driving surface: reading the DOM, clicking, typing. The
/// page cannot call *us* — it is in no capability — so the channel only ever
/// goes one way.
#[tauri::command(async)]
pub fn browser_view_eval(
    app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
    script: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    eval_in(&app, view, script, timeout_ms.unwrap_or(10_000))
}

#[tauri::command(async)]
pub fn browser_view_status(host: tauri::State<'_, BrowserViewHost>, tab: String) -> BrowserViewStatus {
    status(&host, &tab)
}

#[cfg(desktop)]
#[tauri::command(async)]
pub fn browser_view_close(app: AppHandle, host: tauri::State<'_, BrowserViewHost>, tab: String) -> Result<(), String> {
    // An unnamed close would mean "whatever is in front", and the one caller that
    // closes tabs on its own (`a browser run taking its page back`) must never be
    // able to take the page the reader is on. Every caller names its tab today;
    // this keeps that true.
    if tab.trim().is_empty() {
        return Err("关闭浏览器标签页需要指定 tab".to_string());
    }
    let id = resolve_tab_id(&host, &tab)?;
    let mut tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    if let Some(state) = tabs.remove(&id) {
        state.view.close().map_err(|error| error.to_string())?;
    }
    // A tab that is gone cannot still be the one the user is looking at, and a
    // stale `active` makes every later op that does not name a tab fail with
    // "浏览器标签页尚未打开".
    if let Ok(mut active) = host.active.lock() {
        if *active == id {
            *active = tabs.keys().next().cloned().unwrap_or_default();
        }
    }
    drop(tabs);
    // A closed tab cannot be the agent's page either: the next run mints a fresh
    // one instead of asking for a page that no longer exists.
    forget_agent_tab(&host, &id);
    // The frontend owns the tab strip, so a view closed without telling it leaves
    // a tab with no page behind it. The agent's own tab — closed when its run ends
    // — is exactly that case, which is why this is announced rather than silent.
    let _ = app.emit("browser:close", serde_json::json!({ "tab": id }));
    Ok(())
}

/// A run finishing releases operation rights but never destroys the page the user is watching.
fn close_run_tab(app: AppHandle, host: tauri::State<'_, BrowserViewHost>, tab: String, owner: String) -> Result<(), String> {
    release_agent_tab(&host, &tab, &owner)?;
    let url = with_tab(&host, &tab, |state| state.url.clone()).unwrap_or_default();
    let _ = app.emit("browser:handoff", serde_json::json!({"tab":tab,"url":url}));
    Ok(())
}

/// Close every browser view whose tab the frontend no longer has.
///
/// The views are native child web views that **this** process owns, while the
/// **frontend** owns the tabs that describe them — the tab strip, the address
/// bar, the close button. A frontend reload rebuilds its state from nothing, so
/// every tab is gone, and nothing in the outgoing document gets to run a cleanup
/// handler on the way out. What that left behind was a page drawn on screen with
/// no tab, no address bar and no way to close it: two sides disagreeing about
/// what existed, with a live web view as the evidence.
///
/// Called once on startup with the tabs the frontend actually has, so the two
/// sides start out agreeing. Views the frontend does name are left alone: they
/// are about to be re-synced by their own component anyway, and closing them
/// would only make a live page flash blank.
#[cfg(desktop)]
#[tauri::command(async)]
pub fn browser_view_reconcile(
    host: tauri::State<'_, BrowserViewHost>,
    tabs: Vec<String>,
) -> Result<usize, String> {
    let keep: HashSet<&str> = tabs.iter().map(String::as_str).collect();
    let mut state = host.tabs.lock().map_err(|error| error.to_string())?;
    let stale: Vec<String> = state
        .keys()
        .filter(|tab| !keep.contains(tab.as_str()))
        .cloned()
        .collect();
    for tab in &stale {
        if let Some(view) = state.remove(tab) {
            // Best effort: a view that refuses to close must not abort the sweep,
            // because the ones after it are just as orphaned.
            let _ = view.view.close();
        }
    }
    if let Ok(mut active) = host.active.lock() {
        if stale.contains(&*active) {
            *active = state.keys().next().cloned().unwrap_or_default();
        }
    }
    drop(state);
    // A swept tab is not the agent's page any more: the next run must not be
    // handed an id that no longer exists (it looked like a reused tab while the
    // page behind it had been destroyed).
    for tab in &stale {
        forget_agent_tab(&host, tab);
    }
    Ok(stale.len())
}

/// Same as `browser_view_close`: reconciling views is a desktop operation.
#[cfg(mobile)]
#[tauri::command(async)]
pub fn browser_view_reconcile(
    _host: tauri::State<'_, BrowserViewHost>,
    _tabs: Vec<String>,
) -> Result<usize, String> {
    Ok(0)
}

/// Same as `browser_view_sync`: closing is a desktop view operation.
#[cfg(mobile)]
#[tauri::command(async)]
pub fn browser_view_close(
    _app: AppHandle,
    _host: tauri::State<'_, BrowserViewHost>,
    _tab: String,
) -> Result<(), String> {
    Err("手机端没有浏览器栏".to_string())
}

/// What a tab's own page says about itself, plus its load flag.
///
/// One command rather than two: the toolbar's title, its address and its
/// stop/reload button all come from the same poll, and the poll runs for every
/// tab every second and a half.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPage {
    pub title: String,
    pub url: String,
    pub loading: bool,
}

#[tauri::command(async)]
pub fn browser_view_page(app: AppHandle, host: tauri::State<'_, BrowserViewHost>, tab: String) -> Result<BrowserPage, String> {
    let (view, loading) = with_tab(&host, &tab, |state| (state.view.clone(), state.loading))?;
    let raw = eval_in(
        &app,
        view,
        "JSON.stringify({ title: document.title, url: location.href })".to_string(),
        5_000,
    )?;
    // `eval_in` answers with the JSON text of the evaluated value, which here is
    // itself JSON (the page stringifies it): unwrap one layer, then read it.
    let inner = serde_json::from_str::<serde_json::Value>(&raw).unwrap_or(serde_json::Value::Null);
    let text = match inner {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    };
    let page = serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null);
    Ok(BrowserPage {
        title: page.get("title").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
        url: page.get("url").and_then(serde_json::Value::as_str).unwrap_or_default().to_string(),
        loading,
    })
}

// ---------------------------------------------------------------------------
// The driving channel
// ---------------------------------------------------------------------------

/// One request, one reply, JSON lines over a unix socket.
///
/// The tabs live in this process; the agent's loop lives in the Pi extension,
/// which is a different process. The extension needs to read the page and act on
/// it, and this is the smallest honest way to let it: a socket in the browser
/// home (mode 0600, so it is the user's own), a handful of operations, and a
/// JSON answer. No ports, no tokens, no network.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewRequest {
    op: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    new_tab: bool,
    #[serde(default)]
    scope: String,
    #[serde(default)]
    tab: String,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
}

#[cfg(unix)]
fn socket_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::browser::browser_dir()?.join("view.sock"))
}

/// Wrap one channel answer as JSON.
///
/// `wry` hands back the evaluation result as *JSON text*, and an evaluation that
/// produced nothing (or a value it could not serialize) comes back empty —
/// embedding that raw produced invalid JSON, which the caller then reported as
/// "unparseable response" instead of the real problem.
fn channel_reply(ok: bool, payload: Result<String, String>) -> String {
    let field = if ok { "result" } else { "error" };
    let value = match payload {
        // An empty result means the page answered with nothing (a script that
        // returns undefined, or a value WebKit could not serialize). `null` says
        // that plainly; `""` would look like a real empty string.
        Ok(text) if text.trim().is_empty() => "null".to_string(),
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(value) => value.to_string(),
            Err(_) => serde_json::Value::String(text).to_string(),
        },
        Err(error) => serde_json::Value::String(error).to_string(),
    };
    format!("{{\"ok\":{ok},\"{field}\":{value}}}")
}

fn handle(app: &AppHandle, request: ViewRequest) -> Result<String, String> {
    let host = app.state::<BrowserViewHost>();
    if ["status", "eval", "navigate", "go", "reload", "clickAt"].contains(&request.op.as_str()) && !request.owner.is_empty() {
        let agent = host.agent.lock().map_err(|e| e.to_string())?;
        if !agent.owns(&request.tab, &request.owner) { return Err("浏览器操作权已释放或属于另一项任务，请重新获取目标页面".into()); }
    } else if ["eval", "navigate", "go", "reload", "clickAt"].contains(&request.op.as_str()) { return Err("浏览器操作需要有效的 owner".into()); }
    match request.op.as_str() {
        "tabs" => {
            let (ids, current) = {
                let agent = host.agent.lock().map_err(|e| e.to_string())?;
                (agent.tabs(&request.scope), agent.current(&request.scope))
            };
            let tabs: Vec<_> = ids.into_iter().map(|tab| status(&host, &tab)).filter(|tab| tab.open).collect();
            let current = current.filter(|id| tabs.iter().any(|tab| &tab.tab == id));
            Ok(serde_json::json!({ "currentTabId": current, "tabs": tabs }).to_string())
        }
        "acquire" => {
            if !status(&host, &request.tab).open { return Err("目标页面已关闭，请使用 browser_open".into()); }
            if host.importing.load(std::sync::atomic::Ordering::SeqCst) { return Err("正在导入浏览器资料，请稍后再试".into()); }
            host.agent.lock().map_err(|e| e.to_string())?.acquire(&request.scope, &request.tab, &request.owner, Instant::now())?;
            Ok(serde_json::json!({ "tab": request.tab }).to_string())
        }
        "releaseOwner" => {
            let tabs = host.agent.lock().map_err(|e| e.to_string())?.release_owner(&request.scope, &request.owner);
            for tab in tabs { let _ = app.emit("browser:released", serde_json::json!({ "tab": tab })); }
            Ok("null".into())
        }
        "present" => {
            if !host.agent.lock().map_err(|e| e.to_string())?.owns(&request.tab, &request.owner) { return Err("没有目标页面的操作权".into()); }
            app.emit("browser:open", serde_json::json!({ "tab": request.tab })).map_err(|e| e.to_string())?;
            Ok("null".into())
        }
        "status" => serde_json::to_string(&status(&host, &request.tab)).map_err(|error| error.to_string()),
        "eval" => {
            let script = request.script.ok_or_else(|| "eval 缺少 script".to_string())?;
            let view = with_tab(&host, &request.tab, |state| state.view.clone())?;
            eval_in(app, view, script, request.timeout_ms.unwrap_or(10_000))
        }
        "navigate" => {
            let url = request.url.ok_or_else(|| "navigate 缺少 url".to_string())?;
            browser_view_navigate(app.clone(), host, request.tab, url)
                .and_then(|status| serde_json::to_string(&status).map_err(|error| error.to_string()))
        }
        "go" => {
            let direction = request.direction.unwrap_or_else(|| "back".to_string());
            browser_view_go(app.clone(), host, request.tab, direction).map(|_| "null".to_string())
        }
        "reload" => browser_view_reload(app.clone(), host, request.tab).map(|_| "null".to_string()),
        // Asking for a tab, never for a rectangle: the pane owns where its page
        // goes, and a caller that placed a view itself would leave one hanging
        // outside the layout with no tab to describe it (which is exactly what
        // happened when this op took a rect).
        "open" => {
            let url = request.url.unwrap_or_default();
            let wanted = request.tab.trim();
            // A run names the tab it wants. `agent` is the reserved name for the
            // column's agent tab: the app keeps one and hands it to sequential
            // runs, so the next run navigates the page the last one left instead
            // of adding a tab. Any other name is taken literally (a caller that
            // already knows which tab it wants, and the older behaviour).
            if request.owner.is_empty() { return Err("打开任务页面需要 owner".into()); }
            let origin = if request.new_tab { Some(format!("new:{}", request.owner)) } else if url.is_empty() { None } else { Some(parse(&url)?.origin().ascii_serialization()) };
            let preferred = if request.new_tab { None } else if wanted != AGENT_TAB && !wanted.is_empty() { Some(wanted.to_string()) } else { None };
            let tab = claim_agent_tab(&host, &request.scope, origin.as_deref(), preferred.as_deref(), &request.owner)?;
            let shared = true;
            app.emit(
                "browser:open",
                serde_json::json!({ "url": url, "tab": tab, "shared": shared }),
            )
            .map_err(|error| error.to_string())?;
            Ok(serde_json::json!({ "tab": tab, "shared": shared }).to_string())
        }
        // A run giving its page back without destroying it: the next run finds
        // the same tab, hence the same page and history. See `release_agent_tab`.
        "release" => {
            release_agent_tab(&host, &request.tab, &request.owner)?;
            app.emit("browser:released", serde_json::json!({"tab":request.tab})).map_err(|e| e.to_string())?;
            Ok("null".to_string())
        }
        // A run taking its page back. Not always a close: see `close_run_tab`.
        "close" => close_run_tab(app.clone(), host, request.tab, request.owner).map(|_| "null".to_string()),
        // A caller that already knows the page belongs to the person can say so
        // directly, instead of leaving it to the close-time check.
        "handoff" => {
            let id = resolve_tab_id(&host, &request.tab)?;
            let url = with_tab(&host, &request.tab, |state| state.url.clone())?;
            if let Ok(mut active) = host.active.lock() {
                *active = id.clone();
            }
            app.emit("browser:handoff", serde_json::json!({ "tab": id, "url": url }))
                .map_err(|error| error.to_string())?;
            Ok("null".to_string())
        }
        "geometry" => {
            let rect = with_tab(&host, &request.tab, |state| state.rect)?;
            let window = app.get_window("main").ok_or_else(|| "主窗口不存在".to_string())?;
            let outer = window.outer_position().map_err(|error| error.to_string())?;
            let inner = window.inner_position().map_err(|error| error.to_string())?;
            let scale = window.scale_factor().map_err(|error| error.to_string())?;
            Ok(serde_json::json!({
                "outerX": outer.x,
                "outerY": outer.y,
                "innerX": inner.x,
                "innerY": inner.y,
                "scale": scale,
                "rectX": rect.x,
                "rectY": rect.y,
                "rectW": rect.width,
                "rectH": rect.height,
            })
            .to_string())
        }
        // A *trusted* click at a page coordinate: a real mouse event from the
        // system, not a synthesized one. Everything scripts dispatch is
        // untrusted, which is why a JS-driven control (`window.open`, or a
        // handler that checks `isTrusted`) ignores it — measured on Baidu's
        // result links.
        "clickAt" => {
            let (x, y) = (request.x.unwrap_or(-1.0), request.y.unwrap_or(-1.0));
            trusted_click(app, &request.tab, x, y)
        }
        other => Err(format!("未知操作 {other}")),
    }
}

fn claim_agent_tab(host: &BrowserViewHost, scope: &str, origin: Option<&str>, preferred: Option<&str>, owner: &str) -> Result<String, String> {
    let mut agent = host.agent.lock().map_err(|e| e.to_string())?;
    if host.importing.load(std::sync::atomic::Ordering::SeqCst) { return Err("正在导入浏览器资料，请稍后再试".into()); }
    Ok(agent.claim(scope, origin, preferred, owner, Instant::now(), new_tab_id))
}
fn release_agent_tab(host: &BrowserViewHost, tab: &str, owner: &str) -> Result<(), String> {
    if tab.is_empty() { return Err("释放操作权需要指定 tab".into()); }
    let mut agent = host.agent.lock().map_err(|e| e.to_string())?;
    if !agent.release(tab, owner) { return Err("这项任务不再持有页面操作权".into()); }
    Ok(())
}
fn forget_agent_tab(host: &BrowserViewHost, id: &str) {
    if let Ok(mut agent) = host.agent.lock() { agent.forget(id); }
}

pub(crate) struct ProfileImportGuard(AppHandle);
impl Drop for ProfileImportGuard {
    fn drop(&mut self) {
        self.0.state::<BrowserViewHost>().importing.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
pub(crate) fn begin_profile_import(app: &AppHandle) -> Result<ProfileImportGuard, String> {
    let host = app.state::<BrowserViewHost>();
    let leases = host.agent.lock().map_err(|e| e.to_string())?;
    if leases.has_active() { return Err("浏览器任务还在运行，请等任务结束后再导入资料".into()); }
    if host.importing.swap(true, std::sync::atomic::Ordering::SeqCst) { return Err("已有浏览器资料正在导入".into()); }
    Ok(ProfileImportGuard(app.clone()))
}

#[cfg(desktop)]
fn configure_partition(builder: WebviewBuilder<tauri::Wry>, partition: Option<&str>) -> Result<WebviewBuilder<tauri::Wry>, String> {
    let Some(partition) = partition else { return Ok(builder); };
    let id = u128::from_str_radix(partition, 16).map_err(|_| "浏览器资料标识无效")?;
    #[cfg(target_os = "macos")]
    {
        static VERSION: std::sync::LazyLock<u32> = std::sync::LazyLock::new(|| std::process::Command::new("sw_vers").arg("-productVersion").output().ok()
            .and_then(|result| String::from_utf8(result.stdout).ok()).and_then(|value| value.split('.').next().and_then(|major| major.trim().parse::<u32>().ok())).unwrap_or(0));
        if *VERSION < 14 { return Err("独立浏览器资料需要 macOS 14 或更新版本".into()); }
        Ok(builder.data_store_identifier(id.to_be_bytes()))
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = id; Ok(builder.data_directory(crate::browser::browser_dir()?.join("webview-profiles").join(partition))) }
}

#[cfg(desktop)]
pub(crate) fn profile_cookie_view(app: &AppHandle, partition: &str) -> Result<tauri::Webview, String> {
    let window = app.get_window("main").ok_or("主窗口不存在")?;
    let label = format!("cookie-import-{}", uuid::Uuid::new_v4());
    let builder = configure_partition(WebviewBuilder::new(label, WebviewUrl::External(parse(BLANK)?)), Some(partition))?;
    let view = window.add_child(builder, LogicalPosition::new(-10000.0, -10000.0), LogicalSize::new(1.0, 1.0)).map_err(|e| e.to_string())?;
    view.hide().map_err(|e| e.to_string())?;
    Ok(view)
}
#[cfg(mobile)]
pub(crate) fn profile_cookie_view(_app: &AppHandle, _partition: &str) -> Result<tauri::Webview, String> {
    Err("浏览器资料导入仅在桌面端可用".into())
}

/// A tab id this process mints for a caller that did not name one.
///
/// No RNG dependency: nanos, pid and a counter mixed together are unique for
/// this process, and the caller immediately names the id back on every op, so
/// the only property that matters is that two ids never collide within a run.
fn new_tab_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    let mixed = nanos ^ (u64::from(std::process::id()) << 32) ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("browser:{:08x}", mixed as u32)
}

fn eval_in(app: &AppHandle, view: Webview, script: String, timeout_ms: u64) -> Result<String, String> {
    let budget = timeout_ms.clamp(100, 120_000);
    // Wait for document commit. Earlier, Wry queues the script but drops its
    // callback. Waiting for all resources instead stalls on ads and media.
    let ready_deadline = Instant::now() + Duration::from_millis(budget);
    loop {
        let loaded = match view.label().strip_prefix("browser-view-") {
            Some(_) => app
                .try_state::<BrowserViewHost>()
                .map(|host| {
                    let tabs = host.tabs.lock();
                    match tabs {
                        Ok(tabs) => tabs
                            .values()
                            .find(|state| state.view.label() == view.label())
                            .map(|state| state.loaded)
                            .unwrap_or(true),
                        Err(_) => true,
                    }
                })
                .unwrap_or(true),
            None => true,
        };
        if loaded {
            break;
        }
        if Instant::now() > ready_deadline {
            return Err("页面还没有加载完成，稍后再试".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let (sender, receiver) = mpsc::channel::<String>();
    view.eval_with_callback(script, move |result| {
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(ready_deadline.saturating_duration_since(Instant::now()))
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => "页面脚本没有在超时前返回结果".to_string(),
            mpsc::RecvTimeoutError::Disconnected => "页面尚未就绪或已关闭，求值回调被释放；请重新读取页面".to_string(),
        })
}

/// Serve the driving channel for the life of the app.
///
/// A stale socket file is removed first: a crashed process cannot unlink its own
/// socket, and leaving it would make every later run fail to bind.
#[cfg(unix)]
pub fn serve(app: AppHandle) {
    let path = match socket_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[view] 无法确定视图通道位置：{error}");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!("[view] 无法创建浏览器通道目录：{error}");
            return;
        }
    }
    let _ = std::fs::remove_file(&path);
    let listener = match std::os::unix::net::UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[view] 无法监听 {}：{error}", path.display());
            return;
        }
    };
    // Owner-only: this channel can run scripts in a page the user is signed into.
    let _ = std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600));
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(mut stream) = connection else { continue };
            let app = app.clone();
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader, Write};
                let mut reader = BufReader::new(match stream.try_clone() {
                    Ok(copy) => copy,
                    Err(_) => return,
                });
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                    return;
                }
                let reply = match serde_json::from_str::<ViewRequest>(&line) {
                    Ok(request) => match handle(&app, request) {
                        Ok(result) => channel_reply(true, Ok(result)),
                        Err(error) => channel_reply(false, Err(error)),
                    },
                    Err(error) => channel_reply(false, Err(format!("请求格式错误：{error}"))),
                };
                let _ = stream.write_all(reply.as_bytes());
                let _ = stream.write_all(b"\n");
                let _ = stream.flush();
            });
        }
    });
}

/// Whether a page point may be delivered as a screen click, given the view's box
/// and the main window's content box.
///
/// An injected click goes to whichever window is in front, so a point that is no
/// longer inside the window — it moved, the pane was resized, the user switched
/// apps — would land in someone else's lap. Refusing is the only safe answer.
fn click_is_inside(rect: ViewRect, x: f64, y: f64, inner: (f64, f64)) -> bool {
    if x < 0.0 || y < 0.0 || x > rect.width || y > rect.height {
        return false;
    }
    if rect.x < 0.0 || rect.y < 0.0 {
        return false;
    }
    rect.x + rect.width <= inner.0 + 1.0 && rect.y + rect.height <= inner.1 + 1.0
}

/// Click once, through the system, at a point inside a tab's page.
///
/// `x`/`y` are CSS pixels inside the view; the window's own position turns them
/// into screen points, which is the space the input backend speaks. This is the
/// same injection the phone's screen channel uses, so it rides the existing
/// accessibility grant instead of a second permission.
#[cfg(target_os = "macos")]
fn trusted_click(app: &AppHandle, tab: &str, x: f64, y: f64) -> Result<String, String> {
    use xa11y::Point;
    // Physical mouse input is global, even when two Pi sessions are running.
    static POINTER: Mutex<()> = Mutex::new(());
    let _pointer = POINTER.lock().map_err(|e| e.to_string())?;
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("clickAt 需要页面内的 x/y".to_string());
    }
    let host = app.state::<BrowserViewHost>();
    let rect = with_tab(&host, tab, |state| state.rect)?;
    if !(0.0..=rect.width).contains(&x) || !(0.0..=(rect.height)).contains(&y) {
        return Err(format!("({x}, {y}) 不在视图范围内 {}x{}", rect.width, rect.height));
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    // Activate first, exactly as the desktop pointer path does: an injected
    // click goes to whatever window is in front, so delivering one without
    // focusing puts it in someone else's lap — and the page sees nothing. A
    // focus that fails is not something to shrug off: the next step would then
    // deliver the click to whichever app *is* in front.
    window
        .set_focus()
        .map_err(|error| format!("无法激活主窗口，未点击：{error}"))?;
    std::thread::sleep(Duration::from_millis(180));
    // Re-read the geometry *after* the wait. The window can move, the pane can be
    // resized and the user can switch apps while the loop waits; a point
    // computed from a stale origin is a click at the wrong place.
    let origin = window.inner_position().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let inner = (size.width as f64 / scale, size.height as f64 / scale);
    let (rect, visible) = with_tab(&host, tab, |state| (state.rect, state.visible))?;
    if !visible { return Err("目标页面当前不可见，未点击；请先显示该页面".into()); }
    if !click_is_inside(rect, x, y, inner) {
        return Err("浏览器视图已不在主窗口内，未点击".to_string());
    }
    if !window.is_focused().unwrap_or(false) {
        return Err("主窗口不再处于前台，未点击".to_string());
    }
    let screen_x = (origin.x as f64 / scale + rect.x + x).round() as i32;
    let screen_y = (origin.y as f64 / scale + rect.y + y).round() as i32;
    let input = xa11y::input_sim().map_err(|error| error.to_string())?;
    // xa11y-macos 0.15 down/up put their Quartz events at (0,0).
    // click(point) carries this point on both events, rather than assuming
    // Quartz will substitute the cursor location for a button-only event.
    input.mouse().click(Point::new(screen_x, screen_y)).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "x": screen_x, "y": screen_y }).to_string())
}

#[cfg(not(target_os = "macos"))]
fn trusted_click(_app: &AppHandle, _tab: &str, _x: f64, _y: f64) -> Result<String, String> {
    Err("可信点击目前只在 macOS 上可用".to_string())
}

#[cfg(test)]
mod tests {
    use super::{channel_reply, choose_tab_id, click_is_inside, new_tab_id, ViewRect};

    /// A named tab is that tab, even when it is not the one the user is looking
    /// at: this is the whole bug behind "observe read one tab, the click hit
    /// another".
    #[test]
    fn a_named_tab_is_not_the_active_tab() {
        assert_eq!(choose_tab_id("browser:aaaa1111", "browser:bbbb2222"), "browser:bbbb2222");
        assert_eq!(choose_tab_id("browser:aaaa1111", ""), "browser:aaaa1111");
    }

    /// The generated ids are well-formed and distinct, because the caller names
    /// one back on every later op and a collision would address the wrong page.
    #[test]
    fn generated_tab_ids_are_unique_and_well_formed() {
        let first = new_tab_id();
        let second = new_tab_id();
        assert_eq!(first.len(), "browser:".len() + 8);
        assert!(first.starts_with("browser:"));
        assert!(first["browser:".len()..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(first, second);
    }

    /// A view that has drifted outside the window, or a wholly off-screen point,
    /// must never become a screen click.
    #[test]
    fn a_click_outside_the_window_is_refused() {
        let rect = ViewRect { x: 100.0, y: 50.0, width: 400.0, height: 300.0 };
        // Inside the window (needs room for the view's own box).
        assert!(click_is_inside(rect, 10.0, 10.0, (1280.0, 840.0)));
        // The pane has been pushed past the window edge.
        assert!(!click_is_inside(ViewRect { x: 1000.0, ..rect }, 10.0, 10.0, (1280.0, 840.0)));
        // A point outside the view's own box.
        assert!(!click_is_inside(rect, -1.0, 10.0, (1280.0, 840.0)));
        assert!(!click_is_inside(rect, 10.0, 999.0, (1280.0, 840.0)));
        // A negative view origin (a hidden pane) is not clickable.
        assert!(!click_is_inside(ViewRect { x: -5.0, ..rect }, 10.0, 10.0, (1280.0, 840.0)));
    }

    #[test]
    fn an_empty_evaluation_is_still_valid_json() {
        // The real failure: an empty result was embedded raw, producing
        // `{"ok":true,"result":}` and the caller reported "unparseable response"
        // instead of "the page returned nothing".
        let reply = channel_reply(true, Ok(String::new()));
        assert_eq!(reply, r#"{"ok":true,"result":null}"#);
    }

    #[test]
    fn a_json_result_is_embedded_as_json() {
        assert_eq!(channel_reply(true, Ok("42".into())), r#"{"ok":true,"result":42}"#);
        assert_eq!(
            channel_reply(true, Ok(r#"{"title":"百度"}"#.into())),
            r#"{"ok":true,"result":{"title":"百度"}}"#
        );
    }

    #[test]
    fn a_non_json_result_stays_a_string() {
        assert_eq!(
            channel_reply(true, Ok("[object Promise]".into())),
            r#"{"ok":true,"result":"[object Promise]"}"#
        );
        assert_eq!(
            channel_reply(false, Err("坏掉了".into())),
            r#"{"ok":false,"error":"坏掉了"}"#
        );
    }
}

/// Non-unix platforms have no browser tab yet, so there is nothing to serve.
#[cfg(not(unix))]
pub fn serve(_app: AppHandle) {}
