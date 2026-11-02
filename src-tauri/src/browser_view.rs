//! Host-owned native Chromium child views. Tauri CEF draws each page directly
//! into its window; Pi attaches to that same page via scoped CDP/Playwright.
//! Page geometry and visibility belong to the UI, lifetime and profiles to Rust.
//! Remote pages have no Tauri command capabilities.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl,
};

const BLANK: &str = "about:blank";

/// The reserved tab name a run uses to ask for the column's agent tab.
///
/// Not a tab id: the app decides which id backs it, so a handed-over page (the
/// user's now) can retire one and the next run get a fresh one without the caller
/// knowing anything changed.
const AGENT_TAB: &str = "agent";

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
    audio_muted: bool,
    partition: Option<String>,
    view: Webview,
    /// Last observed address; page-load callbacks update it after redirects.
    url: String,
    requested_url: String,
    visible: bool,
    loading: bool,
    /// A backend-created page can exist before the tab strip subscribes.
    presented: bool,
}

impl Tab {
    fn status(&self) -> BrowserViewStatus {
        BrowserViewStatus {
            open: true,
            url: self.url.clone(),
            visible: self.visible,
            loading: self.loading,
            tab: String::new(),
            profile: self.partition.clone(),
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
    pub profile: Option<String>,
}

fn label_for(tab: &str) -> String {
    format!(
        "browser-view-{}",
        tab.replace(|c: char| !c.is_ascii_alphanumeric(), "-")
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
    if tab.is_empty() {
        active.to_string()
    } else {
        tab.to_string()
    }
}

/// The one place a tab argument is resolved, shared by every op on purpose.
///
/// Two resolvers is how "observe reads the active tab while the click goes to
/// the tab captured at open time" happened: the caller named a tab and half the
/// channel ignored it.
fn resolve_tab_id(host: &BrowserViewHost, tab: &str) -> Result<String, String> {
    let active = host
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    Ok(choose_tab_id(&active, tab))
}

fn with_tab<T>(
    host: &BrowserViewHost,
    tab: &str,
    run: impl FnOnce(&Tab) -> T,
) -> Result<T, String> {
    let id = resolve_tab_id(host, tab)?;
    let tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    let state = tabs
        .get(&id)
        .ok_or_else(|| "浏览器标签页尚未打开".to_string())?;
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
        .map(|state| BrowserViewStatus {
            tab: id.clone(),
            ..state.status()
        })
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
    background: Option<bool>,
) -> Result<BrowserViewStatus, String> {
    let wanted = url.as_deref().map(parse).transpose()?;
    let shown = visible.unwrap_or(true);
    if host.importing.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("正在导入浏览器资料，请稍后再试".into());
    }
    let partition = crate::browser::active_partition();
    let mut tabs = host.tabs.lock().map_err(|error| error.to_string())?;
    if !tabs.contains_key(&tab) && !shown && !background.unwrap_or(false) {
        // Nothing to hide: a tab that is not on screen must not create a view.
        return Ok(BrowserViewStatus::default());
    }
    if !tabs.contains_key(&tab) {
        let window = app
            .get_window("main")
            .ok_or_else(|| "主窗口不存在，无法放置浏览器视图".to_string())?;
        let target = wanted
            .clone()
            .unwrap_or_else(|| parse(BLANK).expect("about:blank parses"));
        let label = label_for(&tab);
        let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target.clone()))
            // The view is the browser: text is selected, dragged and zoomed by
            // Chromium, at the display's native scale.
            .zoom_hotkeys_enabled(true)
            // Without this, macOS eats the first click after the window loses
            // focus ("click-through"): the click activates the window and never
            // reaches the page, which reads as "clicking does nothing".
            .accept_first_mouse(true)
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
                        if let Some(state) =
                            tabs.values_mut().find(|state| state.view.label() == label)
                        {
                            state.loading = loading;
                            state.url = payload.url().to_string();
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
        if !shown {
            view.hide().map_err(|error| error.to_string())?;
        }
        tabs.insert(
            tab.clone(),
            Tab {
                audio_muted: false,
                partition,
                view,
                url: target.to_string(),
                requested_url: target.to_string(),
                visible: false,
                loading: target.as_str() != BLANK,
                presented: !background.unwrap_or(false),
            },
        );
        if tabs.len() == 1 {
            if let Ok(mut active) = host.active.lock() {
                *active = tab.clone();
            }
        }
    }
    let state = tabs.get_mut(&tab).expect("just inserted");
    if !background.unwrap_or(false) {
        state.presented = true;
    }
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
        if target.as_str() != state.requested_url && target.as_str() != BLANK {
            if target.as_str() != state.url {
                state
                    .view
                    .navigate(target.clone())
                    .map_err(|error| error.to_string())?;
                state.url = target.to_string();
            }
            state.requested_url = target.to_string();
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
    _background: Option<bool>,
) -> Result<BrowserViewStatus, String> {
    Err("手机端没有浏览器栏".to_string())
}

/// Tell the app which browser tab is in front: the agent's channel follows it.
#[tauri::command(async)]
pub fn browser_view_activate(
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
) -> Result<(), String> {
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
    let state = tabs
        .get_mut(&id)
        .ok_or_else(|| "浏览器标签页尚未打开".to_string())?;
    state.loading = true;
    state
        .view
        .navigate(target.clone())
        .map_err(|error| error.to_string())?;
    state.url = target.to_string();
    state.requested_url = target.to_string();
    Ok(state.status())
}

#[tauri::command(async)]
pub fn browser_view_go(
    _app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
    direction: String,
) -> Result<(), String> {
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        other => return Err(format!("未知方向 {other}")),
    };
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    view.eval(script).map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn browser_view_reload(
    _app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
) -> Result<(), String> {
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    view.reload().map_err(|error| error.to_string())
}

#[tauri::command(async)]
pub fn browser_view_stop(
    _app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
) -> Result<(), String> {
    let view = with_tab(&host, &tab, |state| state.view.clone())?;
    view.eval("window.stop()")
        .map_err(|error| error.to_string())
}

/// Mute the whole native page, including cross-origin frames and WebAudio.
/// Mutating <video>.muted would miss both and be undone by the site's player.
#[tauri::command(async)]
pub fn browser_view_set_audio_muted(
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
    muted: bool,
) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use cef::{ImplBrowser, ImplBrowserHost};
        use tauri_runtime_cef::WebviewCefExt;
        let view = with_tab(&host, &tab, |state| state.view.clone())?;
        view.with_cef_webview(move |page| {
            if let Some(browser) = page.browser().host() {
                browser.set_audio_muted(i32::from(muted));
            }
        })
        .map_err(|error| error.to_string())?;
        let id = resolve_tab_id(&host, &tab)?;
        if let Some(state) = host
            .tabs
            .lock()
            .map_err(|error| error.to_string())?
            .get_mut(&id)
        {
            state.audio_muted = muted;
        }
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (host, tab, muted);
        Err("浏览器执行需要桌面 Host".into())
    }
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
pub fn browser_view_status(
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
) -> BrowserViewStatus {
    status(&host, &tab)
}

#[cfg(desktop)]
#[tauri::command(async)]
pub fn browser_view_close(
    app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
) -> Result<(), String> {
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
        crate::browser_cdp::forget(&app, state.view.label());
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
    app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tabs: Vec<String>,
) -> Result<usize, String> {
    let keep: HashSet<&str> = tabs.iter().map(String::as_str).collect();
    let mut state = host.tabs.lock().map_err(|error| error.to_string())?;
    let stale: Vec<String> = state
        .keys()
        .filter(|tab| {
            !keep.contains(tab.as_str()) && state.get(*tab).is_some_and(|view| view.presented)
        })
        .cloned()
        .collect();
    for tab in &stale {
        if let Some(view) = state.remove(tab) {
            // Best effort: a view that refuses to close must not abort the sweep,
            // because the ones after it are just as orphaned.
            crate::browser_cdp::forget(&app, view.view.label());
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
    pub audio_muted: bool,
}

#[tauri::command(async)]
pub fn browser_view_page(
    app: AppHandle,
    host: tauri::State<'_, BrowserViewHost>,
    tab: String,
) -> Result<BrowserPage, String> {
    let (view, loading, audio_muted) = with_tab(&host, &tab, |state| {
        (state.view.clone(), state.loading, state.audio_muted)
    })?;
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
        title: page
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        url: page
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        loading,
        audio_muted,
    })
}

// ---------------------------------------------------------------------------
// The driving channel
// ---------------------------------------------------------------------------

/// Management requests share the authenticated loopback endpoint with CDP.
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
    url: Option<String>,
}

pub(crate) fn handle_request(
    app: &AppHandle,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request: ViewRequest = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let host = app.state::<BrowserViewHost>();
    match request.op.as_str() {
        #[cfg(desktop)]
        "cdp" => crate::browser_cdp::connect(app, &request.tab, &request.owner),
        "tabs" => {
            let (ids, current) = {
                let agent = host.agent.lock().map_err(|e| e.to_string())?;
                (agent.tabs(&request.scope), agent.current(&request.scope))
            };
            let tabs: Vec<_> = ids
                .into_iter()
                .map(|tab| status(&host, &tab))
                .filter(|tab| tab.open)
                .collect();
            let current = current.filter(|id| tabs.iter().any(|tab| &tab.tab == id));
            Ok(serde_json::json!({"currentTabId": current, "tabs": tabs}))
        }
        "acquire" => {
            if !status(&host, &request.tab).open {
                return Err("目标页面已关闭，请使用 browser_open".into());
            }
            if host.importing.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("正在导入浏览器资料，请稍后再试".into());
            }
            host.agent.lock().map_err(|e| e.to_string())?.acquire(
                &request.scope,
                &request.tab,
                &request.owner,
                Instant::now(),
            )?;
            Ok(serde_json::json!({"tab": request.tab}))
        }
        "releaseOwner" => {
            let tabs = host
                .agent
                .lock()
                .map_err(|e| e.to_string())?
                .release_owner(&request.scope, &request.owner);
            for tab in tabs {
                let _ = app.emit("browser:released", serde_json::json!({"tab": tab}));
            }
            Ok(serde_json::Value::Null)
        }
        "present" => {
            if !host
                .agent
                .lock()
                .map_err(|e| e.to_string())?
                .owns(&request.tab, &request.owner)
            {
                return Err("没有目标页面的操作权".into());
            }
            app.emit("browser:open", serde_json::json!({"tab": request.tab}))
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        "status" => {
            if !host
                .agent
                .lock()
                .map_err(|e| e.to_string())?
                .owns(&request.tab, &request.owner)
            {
                return Err("没有目标页面的操作权".into());
            }
            serde_json::to_value(status(&host, &request.tab)).map_err(|e| e.to_string())
        }
        "open" => {
            if request.scope.is_empty() || request.owner.is_empty() {
                return Err("打开任务页面需要 session 和 owner".into());
            }
            let url = request.url.unwrap_or_default();
            let origin = if request.new_tab {
                Some(format!("new:{}", request.owner))
            } else if url.is_empty() {
                None
            } else {
                Some(parse(&url)?.origin().ascii_serialization())
            };
            let preferred = if request.new_tab || request.tab == AGENT_TAB || request.tab.is_empty()
            {
                None
            } else {
                Some(request.tab.as_str())
            };
            let tab = claim_agent_tab(
                &host,
                &request.scope,
                origin.as_deref(),
                preferred,
                &request.owner,
            )?;
            // Create the native page before notifying React. Automation is ready
            // even during a renderer reload or before the tab strip subscribes.
            if let Err(error) = browser_view_sync(
                app.clone(),
                host.clone(),
                tab.clone(),
                ViewRect {
                    x: 0.0,
                    y: 0.0,
                    width: 1120.0,
                    height: 780.0,
                },
                Some(url.clone()),
                Some(false),
                Some(true),
            ) {
                forget_agent_tab(&host, &tab);
                return Err(error);
            }
            app.emit(
                "browser:open",
                serde_json::json!({"url": url, "tab": tab, "shared": true}),
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({"tab": tab, "shared": true}))
        }
        "release" => {
            release_agent_tab(&host, &request.tab, &request.owner)?;
            app.emit("browser:released", serde_json::json!({"tab": request.tab}))
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        other => Err(format!("未知操作 {other}")),
    }
}

/// Recover live native pages after a frontend reload without destroying tasks.
#[tauri::command(async)]
pub fn browser_view_restore(
    host: tauri::State<'_, BrowserViewHost>,
) -> Result<Vec<BrowserViewStatus>, String> {
    let tabs = host.tabs.lock().map_err(|e| e.to_string())?;
    Ok(tabs
        .iter()
        .map(|(id, state)| BrowserViewStatus {
            tab: id.clone(),
            ..state.status()
        })
        .collect())
}

fn claim_agent_tab(
    host: &BrowserViewHost,
    scope: &str,
    origin: Option<&str>,
    preferred: Option<&str>,
    owner: &str,
) -> Result<String, String> {
    let mut agent = host.agent.lock().map_err(|e| e.to_string())?;
    if host.importing.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("正在导入浏览器资料，请稍后再试".into());
    }
    Ok(agent.claim(scope, origin, preferred, owner, Instant::now(), new_tab_id))
}
fn release_agent_tab(host: &BrowserViewHost, tab: &str, owner: &str) -> Result<(), String> {
    if tab.is_empty() {
        return Err("释放操作权需要指定 tab".into());
    }
    let mut agent = host.agent.lock().map_err(|e| e.to_string())?;
    if !agent.release(tab, owner) {
        return Err("这项任务不再持有页面操作权".into());
    }
    Ok(())
}
fn forget_agent_tab(host: &BrowserViewHost, id: &str) {
    if let Ok(mut agent) = host.agent.lock() {
        agent.forget(id);
    }
}

pub(crate) struct ProfileImportGuard(AppHandle);
impl Drop for ProfileImportGuard {
    fn drop(&mut self) {
        self.0
            .state::<BrowserViewHost>()
            .importing
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
pub(crate) fn begin_profile_import(app: &AppHandle) -> Result<ProfileImportGuard, String> {
    let host = app.state::<BrowserViewHost>();
    let leases = host.agent.lock().map_err(|e| e.to_string())?;
    if leases.has_active() {
        return Err("浏览器任务还在运行，请等任务结束后再导入资料".into());
    }
    if host
        .importing
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err("已有浏览器资料正在导入".into());
    }
    Ok(ProfileImportGuard(app.clone()))
}

#[cfg(desktop)]
fn configure_partition(
    builder: WebviewBuilder<tauri::DynRuntime>,
    partition: Option<&str>,
) -> Result<WebviewBuilder<tauri::DynRuntime>, String> {
    if let Some(partition) = partition {
        u128::from_str_radix(partition, 16).map_err(|_| "浏览器资料标识无效")?;
    }
    // Native browsing must not share the application shell's request context.
    Ok(builder.data_directory(
        crate::browser::browser_dir()?
            .join("cef")
            .join(partition.unwrap_or("browser-default")),
    ))
}

#[cfg(desktop)]
pub(crate) fn profile_cookie_view(
    app: &AppHandle,
    partition: &str,
) -> Result<tauri::Webview, String> {
    let window = app.get_window("main").ok_or("主窗口不存在")?;
    let label = format!("cookie-import-{}", uuid::Uuid::new_v4());
    let builder = configure_partition(
        WebviewBuilder::new(label, WebviewUrl::External(parse(BLANK)?)),
        Some(partition),
    )?;
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(-10000.0, -10000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    view.hide().map_err(|e| e.to_string())?;
    Ok(view)
}
#[cfg(mobile)]
pub(crate) fn profile_cookie_view(
    _app: &AppHandle,
    _partition: &str,
) -> Result<tauri::Webview, String> {
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
    let mixed =
        nanos ^ (u64::from(std::process::id()) << 32) ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("browser:{:08x}", mixed as u32)
}

fn eval_in(
    app: &AppHandle,
    view: Webview,
    script: String,
    timeout_ms: u64,
) -> Result<String, String> {
    #[cfg(desktop)]
    {
        let result = crate::browser_cdp::command(
            app,
            &view,
            "Runtime.evaluate",
            serde_json::json!({"expression":script,"returnByValue":true,"awaitPromise":true,"timeout":timeout_ms.clamp(100,120000)}),
            Duration::from_millis(timeout_ms.clamp(100, 120000) + 500),
        )?;
        if result.get("exceptionDetails").is_some() {
            return Err(result["exceptionDetails"].to_string());
        }
        Ok(result["result"]["value"].to_string())
    }
    #[cfg(mobile)]
    {
        let _ = (app, view, script, timeout_ms);
        Err("浏览器执行需要桌面 Host".into())
    }
}

#[cfg(desktop)]
pub(crate) fn cdp_view(app: &AppHandle, tab: &str, owner: &str) -> Result<Webview, String> {
    let host = app.state::<BrowserViewHost>();
    if !host
        .agent
        .lock()
        .map_err(|e| e.to_string())?
        .owns(tab, owner)
    {
        return Err("Native browser lease is no longer owned by this operation".into());
    }
    with_tab(&host, tab, |state| state.view.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_tabs_never_follow_the_active_page() {
        assert_eq!(choose_tab_id("a", "b"), "b");
        assert_eq!(choose_tab_id("a", ""), "a");
    }
    #[test]
    fn generated_tabs_have_distinct_identities() {
        assert_ne!(new_tab_id(), new_tab_id());
    }
}
