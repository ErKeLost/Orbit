//! Browser Use: the real Chrome behind the third column.
//!
//! The browser is **not** an iframe and **not** a Tauri child webview. It is an
//! Orbit-owned Chrome process with its own Blink engine, reached over the
//! DevTools protocol on a loopback port. The column renders its screencast
//! frames and forwards pointer/keyboard input back through `Input.*`, so the
//! page the user sees is the exact page the agent drives — same DOM, same
//! session, same viewport. An iframe could not do that (X-Frame-Options, no
//! DOM access cross-origin), and a child webview would be WebKit on macOS:
//! no DevTools protocol, no trusted input, and different rendering than the
//! browser the task will actually run in.
//!
//! This module owns only what needs a process and a port:
//!
//! * finding an installed Chromium-family browser and launching it headless,
//! * creating the owned tab and closing the previous one,
//! * the session file both sides read (`~/.pi/agent/browser/session.json`).
//!
//! The protocol work lives on the other side of that file: the dock
//! (`src/lib/browser.ts`) draws frames and forwards input, and the Pi
//! extension (`resources/browser-use/`) runs the agent loop. Both are CDP
//! clients of the same tab, which is why the session file, not this process,
//! is the shared source of truth.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The viewport the agent assumes when the dock is closed. The dock overrides
/// it with its own size while it is open, so the picture is never a scaled
/// lie about where a click lands.
pub const DEFAULT_VIEWPORT: (u32, u32) = (1120, 780);

/// Where the session file and the Chrome profile live. `~/.pi/agent` is the
/// one directory the Pi runtime, the extension and this app all already use.
const BROWSER_DIR: &str = ".pi/agent/browser";

/// A live Chrome instance plus the tab Orbit owns in it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    /// Loopback DevTools port. Chrome picks it (`--remote-debugging-port=0`),
    /// so two Orbit installs never fight over a fixed number.
    pub port: u16,
    /// The owned tab. Both clients attach to this target, never to "the first
    /// page", so a stray tab the user opens cannot be driven by accident.
    pub target_id: String,
    pub url: String,
    pub pid: u32,
    pub executable: String,
    pub started_at: u64,
    /// `Chrome/155.0.8059.79`, from `/json/version`.
    pub browser_version: String,
    /// The browser-level DevTools path from `DevToolsActivePort`
    /// (`/devtools/browser/<uuid>`). Clients attach here, not to the page
    /// endpoint: sessions are what make popups and multiple tabs reachable.
    pub browser_ws: String,
    /// Chrome's own user-agent string. The dock rewrites it when it hides
    /// headless mode from the page; keeping the raw value here means the
    /// rewrite has one implementation.
    pub user_agent: String,
}

#[derive(Default)]
pub struct BrowserHost {
    /// Serialises launch/attach. Chrome already refuses a second instance on
    /// the same profile, but a lost race here would still orphan a tab.
    lock: Mutex<()>,
}

// Tauri commands are `async` *attributes* on blocking bodies: finding a browser
// and waiting for a DevTools port takes seconds, and the main thread is where
// the dock is drawn.

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "找不到用户目录".to_string())
}

pub fn browser_dir() -> Result<PathBuf, String> {
    // `ORBIT_BROWSER_HOME` moves the whole browser home — session file and
    // Chrome profile — somewhere else. Tests use it so they can start a real
    // browser without touching the profile the user's own column is signed
    // into; a sandboxed run can use it for the same reason.
    if let Some(root) = std::env::var_os("ORBIT_BROWSER_HOME") {
        return Ok(PathBuf::from(root));
    }
    Ok(home_dir()?.join(BROWSER_DIR))
}

pub fn session_path() -> Result<PathBuf, String> {
    Ok(browser_dir()?.join("session.json"))
}

fn profile_dir() -> Result<PathBuf, String> {
    Ok(browser_dir()?.join("profile"))
}

// ---------------------------------------------------------------------------
// Finding a browser
// ---------------------------------------------------------------------------

/// Installed Chromium-family browsers, best first. Orbit ships no engine of
/// its own: a browser the user already has is the honest choice, and it is
/// also the one that carries their logins if they ever point Orbit at it.
fn candidates() -> Vec<PathBuf> {
    let mut list: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os("ORBIT_BROWSER_BINARY") {
        list.push(PathBuf::from(explicit));
    }
    #[cfg(target_os = "macos")]
    {
        let bundles = [
            "Google Chrome.app/Contents/MacOS/Google Chrome",
            "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
            "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
            "Chromium.app/Contents/MacOS/Chromium",
            "Brave Browser.app/Contents/MacOS/Brave Browser",
            "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "Vivaldi.app/Contents/MacOS/Vivaldi",
        ];
        for root in ["/Applications", "/System/Applications"] {
            for bundle in bundles {
                list.push(PathBuf::from(root).join(bundle));
            }
        }
        if let Ok(home) = home_dir() {
            for bundle in bundles {
                list.push(home.join("Applications").join(bundle));
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Linux and Windows: whatever is on PATH wins. Windows install paths
        // are deliberately absent — this feature is macOS-first (see
        // docs/BROWSER_USE.md) and a wrong guess would be worse than a clear
        // "not found".
        for name in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
            "brave-browser",
            "microsoft-edge",
        ] {
            list.push(PathBuf::from(name));
        }
    }
    list
}

pub fn find_browser() -> Result<PathBuf, String> {
    for candidate in candidates() {
        if candidate.is_absolute() {
            if candidate.is_file() {
                return Ok(candidate);
            }
            continue;
        }
        if let Some(found) = which(&candidate) {
            return Ok(found);
        }
    }
    Err("没有找到可用的浏览器内核。请安装 Google Chrome、Chromium、Brave 或 Edge，或用 ORBIT_BROWSER_BINARY 指定可执行文件".to_string())
}

fn which(name: &Path) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Talking to Chrome over loopback HTTP
// ---------------------------------------------------------------------------

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(400))
        .timeout(Duration::from_millis(2_000))
        .build()
}

fn get_json(url: &str) -> Option<Value> {
    let body = agent().get(url).call().ok()?.into_string().ok()?;
    serde_json::from_str::<Value>(&body).ok()
}

/// `GET /json/version` doubles as the liveness probe: a port in a stale
/// session file that no longer answers is not a running browser.
fn version(port: u16) -> Option<(String, String)> {
    let value = get_json(&format!("http://127.0.0.1:{port}/json/version"))?;
    Some((
        value.get("Browser").and_then(Value::as_str).unwrap_or_default().to_string(),
        value
            .get("User-Agent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    ))
}

fn targets(port: u16) -> Vec<Value> {
    get_json(&format!("http://127.0.0.1:{port}/json/list"))
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
}

/// `PUT /json/new?<url>` is the only way to add a tab without speaking CDP.
/// Chrome takes everything after the `?` verbatim, so the URL is passed raw:
/// percent-encoding it would open the encoded string as the address.
fn create_target(port: u16, url: &str) -> Result<String, String> {
    let response = agent()
        .put(&format!("http://127.0.0.1:{port}/json/new?{url}"))
        .call()
        .map_err(|error| format!("无法在浏览器中新建标签页：{error}"))?;
    let body = response
        .into_string()
        .map_err(|error| format!("浏览器返回了无法读取的新标签页：{error}"))?;
    let value = serde_json::from_str::<Value>(&body)
        .map_err(|error| format!("浏览器返回了无法解析的新标签页：{error}"))?;
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "浏览器没有返回新标签页的 id".to_string())
}

fn close_target(port: u16, target_id: &str) {
    let _ = agent()
        .get(&format!("http://127.0.0.1:{port}/json/close/{target_id}"))
        .call();
}

// ---------------------------------------------------------------------------
// Session file
// ---------------------------------------------------------------------------

pub fn read_session() -> Option<BrowserSession> {
    let path = session_path().ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BrowserSession>(&text).ok()
}

fn write_session(session: &BrowserSession) -> Result<(), String> {
    let dir = browser_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建浏览器目录：{error}"))?;
    let path = dir.join("session.json");
    let temporary = dir.join("session.json.tmp");
    let body = serde_json::to_string_pretty(session).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, body).map_err(|error| format!("无法写入浏览器会话：{error}"))?;
    std::fs::rename(&temporary, &path).map_err(|error| format!("无法保存浏览器会话：{error}"))
}

fn clear_session() {
    if let Ok(path) = session_path() {
        let _ = std::fs::remove_file(path);
    }
}

/// The live session, repaired if the tab it names is gone. Returns `None` when
/// there is no browser, or when the recorded port belongs to something else.
pub fn live_session() -> Option<BrowserSession> {
    let mut session = read_session()?;
    let (version_string, user_agent) = version(session.port)?;
    if !version_string.is_empty() {
        session.browser_version = version_string;
    }
    if !user_agent.is_empty() {
        session.user_agent = user_agent;
    }
    let known = targets(session.port);
    let ours = known
        .iter()
        .any(|target| target.get("id").and_then(Value::as_str) == Some(session.target_id.as_str()));
    if !ours {
        // The tab was closed (by the user, or by a page that navigated away
        // and got replaced). The browser is still ours, so reopen the same URL
        // instead of pretending the session ended.
        let url = session.url.clone();
        session.target_id = create_target(session.port, &url).ok()?;
        let _ = write_session(&session);
    }
    Some(session)
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/// Flags that make one Orbit-owned Chrome behave like a browser the agent can
/// drive without a window: no first-run noise, no throttled background
/// rendering (the tab is never "visible"), and a private profile so the user's
/// own Chrome session is untouched.
pub fn launch_args(profile: &Path, url: &str) -> Vec<String> {
    vec![
        // New headless shares the real Chrome's rendering and input stack; it
        // is a different mode, not a different engine.
        if headful() { "--start-maximized".to_string() } else { "--headless=new".to_string() },
        "--remote-debugging-port=0".to_string(),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--no-service-autorun".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-component-update".to_string(),
        "--disable-features=Translate,MediaRouter,OptimizationHints".to_string(),
        // The owned tab is a background tab by construction. Without these,
        // requestAnimationFrame drops to 1 Hz and live UI never settles.
        "--disable-background-timer-throttling".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--hide-crash-restore-bubble".to_string(),
        // Chrome's own diagnostics, which is what `chrome.log` above collects.
        "--enable-logging=stderr".to_string(),
        format!("--window-size={},{}", DEFAULT_VIEWPORT.0, DEFAULT_VIEWPORT.1),
        url.to_string(),
    ]
}

// Origins allowed to open the DevTools socket.
//
// Deliberately a list and not `*`: the port is loopback-only, but `*` would
// let any page in the user's *other* browser attach to the profile this one
// holds. Extend with `ORBIT_BROWSER_ALLOW_ORIGINS` when a dev server runs
// somewhere else.
//
// The scale Chrome rasters at. 2 matches a Retina display; lowering it trades
// sharpness for smaller frames.

/// The pid of a Chrome that holds this profile while no session file points at
/// it: the launcher was killed, the machine slept, or the session file was
/// removed after a failed start. It is identified by the process's own command
/// line naming *our* profile directory — the user's own Chrome never uses it, so
/// this can only be an Orbit browser that lost its paperwork.
#[cfg(unix)]
fn orphan_owner(profile: &Path) -> Option<i32> {
    let target = std::fs::read_link(profile.join("SingletonLock")).ok()?;
    let pid = target.to_string_lossy().rsplit('-').next()?.parse::<i32>().ok()?;
    if unsafe { libc::kill(pid, 0) } != 0 {
        return None;
    }
    let output = Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&output.stdout);
    line.contains(profile.to_string_lossy().as_ref()).then_some(pid)
}

#[cfg(not(unix))]
fn orphan_owner(_profile: &Path) -> Option<i32> {
    None
}

/// Ask a process to stop, politely or forcefully.
///
/// Unix has signals, and SIGTERM is what lets Chrome flush its profile on the
/// way out. Windows has no SIGTERM: the same request is `taskkill` without `/F`
/// (post the close message), and `/F` for the version that does not ask.
#[cfg(unix)]
fn stop_process(pid: i32, force: bool) {
    unsafe {
        libc::kill(pid, if force { libc::SIGKILL } else { libc::SIGTERM });
    }
}

#[cfg(windows)]
fn stop_process(pid: i32, force: bool) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    let _ = command.output();
}

/// Whether a pid is still there, which Unix answers with signal 0.
///
/// Windows has no such question, so there `false` means "stop waiting" rather
/// than "it is gone". Nothing on Windows depends on the answer: `orphan_owner`
/// cannot identify a browser there in the first place, and the wait in `close`
/// polls Chrome's own debug port instead.
#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    (unsafe { libc::kill(pid, 0) }) == 0
}

#[cfg(not(unix))]
fn process_alive(_pid: i32) -> bool {
    false
}

/// Stop an orphaned Orbit browser and clear the lock it left behind, so the next
/// launch is a normal launch instead of "Chrome exited with 21" forever.
fn clear_orphan(profile: &Path) {
    let Some(pid) = orphan_owner(profile) else {
        return;
    };
    stop_process(pid, false);
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if !process_alive(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if process_alive(pid) {
        stop_process(pid, true);
        std::thread::sleep(Duration::from_millis(300));
    }
    clear_stale_singleton(profile);
}

/// Chrome refuses to start when the profile's `SingletonLock` outlives the
/// process that made it, and a killed instance always leaves one behind — which
/// means the browser column can never start again and no error says why. The
/// lock names its owner (`host-pid`), so a dead owner's lock is cleared here and
/// a live one is left alone.
fn clear_stale_singleton(profile: &Path) {
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else {
        return;
    };
    let pid = target
        .to_string_lossy()
        .rsplit('-')
        .next()
        .and_then(|value| value.parse::<i32>().ok());
    let alive = pid.is_some_and(process_alive);
    if alive {
        return;
    }
    for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
}

/// A visible Chrome window instead of headless. Some sites refuse headless
/// regardless of how the user-agent reads; this is the escape hatch, and the
/// column mirrors the same tab either way.
fn headful() -> bool {
    matches!(
        std::env::var("ORBIT_BROWSER_HEADFUL").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// Start Chrome and return the session. Blocks until the DevTools port is
/// known and the owned tab exists.
fn launch(url: &str) -> Result<BrowserSession, String> {
    let executable = find_browser()?;
    let profile = profile_dir()?;
    std::fs::create_dir_all(&profile).map_err(|error| format!("无法创建浏览器资料目录：{error}"))?;
    // `launch` only runs when no live session answered, so a Chrome still holding
    // this profile is an orphan: adopting it is impossible without its port, and
    // leaving it makes every launch fail.
    clear_orphan(&profile);
    clear_stale_singleton(&profile);
    // A leftover DevToolsActivePort from a previous run would be read as this
    // run's port, so it is removed before the process starts.
    let port_file = profile.join("DevToolsActivePort");
    let _ = std::fs::remove_file(&port_file);

    // Chrome's stderr is kept: it is where a refused DevTools connection, a
    // crashed renderer, or a profile that another instance owns shows up, and
    // none of those are visible from Orbit otherwise. `chrome.log` sits next to
    // the profile and is appended to on every launch.
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(profile.with_file_name("chrome.log"))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null());
    let mut child: Child = Command::new(&executable)
        .args(launch_args(&profile, url))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        // Detach: Chrome outlives the helper process the extension spawns, and
        // `browser_close` is what ends it.
        .spawn()
        .map_err(|error| format!("无法启动浏览器内核 {executable:?}：{error}"))?;

    let deadline = Instant::now() + Duration::from_secs(20);
    let (port, browser_ws) = loop {
        if let Ok(text) = std::fs::read_to_string(&port_file) {
            let mut lines = text.lines();
            if let (Some(port), Some(path)) = (lines.next(), lines.next()) {
                if let Ok(port) = port.trim().parse::<u16>() {
                    let path = path.trim();
                    if !path.is_empty() {
                        break (port, path.to_string());
                    }
                }
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            // Chrome refuses to start on a profile another instance holds. The
            // instance that does own it will have written the port file, so
            // this is only fatal when no port ever appears.
            return Err(format!(
                "浏览器内核已退出（{status}）。如果本机已有同一个资料目录的实例，请先关闭它，或删除 {}",
                profile.display()
            ));
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err(format!("浏览器内核在 20 秒内没有暴露 DevTools 端口（{executable:?}）"));
        }
        std::thread::sleep(Duration::from_millis(40));
    };

    // `/json/version` answers before the first target is listed, so the tab is
    // created only once the port is real.
    let (browser_version, user_agent) = version(port).ok_or_else(|| "浏览器 DevTools 端口无响应".to_string())?;
    let target_id = create_target(port, url)?;
    let session = BrowserSession {
        port,
        target_id,
        url: url.to_string(),
        pid: child.id(),
        executable: executable.display().to_string(),
        started_at: unix_ms(),
        browser_version,
        browser_ws,
        user_agent,
    };
    write_session(&session)?;
    Ok(session)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// The one entry point both callers share: reuse a live browser, move it to a
/// new URL when asked, and launch one when there is none.
pub fn ensure(url: Option<&str>) -> Result<BrowserSession, String> {
    if let Some(mut session) = live_session() {
        let Some(url) = url.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(session);
        };
        if url == session.url {
            return Ok(session);
        }
        // A new URL means a new tab, not a navigation: the old page may be
        // mid-task, and the dock attaches to the tab this returns.
        let previous = session.target_id.clone();
        session.target_id = create_target(session.port, url)?;
        session.url = url.to_string();
        write_session(&session)?;
        close_target(session.port, &previous);
        return Ok(session);
    }
    launch(url.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("about:blank"))
}

pub fn close() -> Result<(), String> {
    let Some(session) = read_session() else {
        clear_session();
        // A browser whose session file is gone is still a running browser, and
        // "close" has to mean closed: this is the only way back from an orphan
        // that would otherwise block every later launch.
        if let Ok(profile) = profile_dir() {
            clear_orphan(&profile);
        }
        return Ok(());
    };
    clear_session();
    // Ask nicely, then make sure. Chrome flushes its profile on the way out —
    // SIGTERM on Unix, a posted close on Windows — which is what keeps logins in
    // the profile usable next time.
    stop_process(session.pid as i32, false);
    // Chrome flushes its profile on the way out; killing it too early leaves
    // the singleton files that make the next launch refuse to start.
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if version(session.port).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    stop_process(session.pid as i32, true);
    if let Ok(profile) = profile_dir() {
        clear_stale_singleton(&profile);
    }
    Ok(())
}

pub fn status() -> Result<Option<BrowserSession>, String> {
    Ok(live_session())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn browser_status() -> Result<Option<BrowserSession>, String> {
    status()
}

#[tauri::command(async)]
pub fn browser_open(
    state: tauri::State<'_, BrowserHost>,
    url: Option<String>,
) -> Result<BrowserSession, String> {
    let _guard = state.lock.lock().map_err(|error| error.to_string())?;
    ensure(url.as_deref().map(str::trim).filter(|value| !value.is_empty()))
}

#[tauri::command(async)]
pub fn browser_close() -> Result<(), String> {
    close()
}

/// A column-side failure, on stderr.
///
/// The banner in the column is for the person in front of it; this line is for
/// whoever has to explain why the column went blank. Without it a failed attach
/// is invisible on the desktop: nothing in the app's own logs says it happened.
#[tauri::command]
pub fn browser_client_report(message: String) {
    eprintln!("[browser] {message}");
}

// ---------------------------------------------------------------------------
// Helper invocation: `Orbit --browser-ensure [--url <url>]`
// ---------------------------------------------------------------------------

const ENSURE_FLAG: &str = "--browser-ensure";
const CLOSE_FLAG: &str = "--browser-close";
const STATUS_FLAG: &str = "--browser-status";

/// The Pi extension drives the same browser the dock shows, and it is a
/// separate process: it cannot call a Tauri command. Instead it runs the app
/// binary it was spawned by with one of these flags, which prints the session
/// as JSON on stdout. That keeps the launch flags in exactly one place.
pub fn exec_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = args.first()?;
    if ![ENSURE_FLAG, CLOSE_FLAG, STATUS_FLAG].contains(&flag.as_str()) {
        return None;
    }
    let url = args
        .iter()
        .position(|arg| arg == "--url")
        .and_then(|index| args.get(index + 1))
        .cloned();
    let result = match flag.as_str() {
        ENSURE_FLAG => ensure(url.as_deref()).and_then(|session| {
            serde_json::to_string(&session).map_err(|error| error.to_string())
        }),
        STATUS_FLAG => status().and_then(|session| match session {
            Some(session) => serde_json::to_string(&session).map_err(|error| error.to_string()),
            None => Ok("null".to_string()),
        }),
        _ => close().map(|_| "null".to_string()),
    };
    match result {
        Ok(body) => {
            println!("{body}");
            Some(0)
        }
        Err(error) => {
            eprintln!("{error}");
            Some(1)
        }
    }
}
