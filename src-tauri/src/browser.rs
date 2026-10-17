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
use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::cookie::{self as web_cookie, Cookie, SameSite};
use tauri::Manager;
use tauri::Emitter;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

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
    /// The process that owns the current tab — the *run*, not the short-lived
    /// `--browser-ensure` helper: a helper records its parent, which is the Pi
    /// extension actually working the tab. It is how `ensure` decides whether a
    /// previous tab may be closed (ours, or an owner that is gone) or must be
    /// left alone (another run is still using it). `0` marks a session file
    /// written before this field existed.
    #[serde(default)]
    pub target_owner_pid: u32,
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
// Cross-process lock
// ---------------------------------------------------------------------------

/// An exclusive lock over the browser home, held for the life of the value.
///
/// The launcher and the agent are different processes (`--browser-ensure`
/// spawns a second copy of this binary), and so are two concurrent agent runs.
/// An in-process `Mutex` cannot serialise them: without a file lock, two
/// helpers can start Chrome at the same time or swap the session's tab under
/// each other, and a profile import can pull the profile out from under a live
/// browser. `flock` on one file is the smallest thing that crosses processes.
struct SessionLock {
    /// Held for its own sake on Unix (dropping it releases `flock`); on other
    /// platforms it is a best-effort placeholder with the same lifetime.
    _file: std::fs::File,
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            unsafe {
                libc::flock(self._file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn lock_session() -> Result<SessionLock, String> {
    let dir = browser_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建浏览器目录：{error}"))?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        // Not truncating matters: the lock file's contents are irrelevant, and
        // truncating it on every lock would be a needless write on a shared file.
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("session.lock"))
        .map_err(|error| format!("无法打开浏览器锁：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        loop {
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
            if rc == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            // A signal can interrupt the wait; the lock itself is still the
            // right thing to be waiting for, so ask again.
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("无法锁定浏览器会话：{error}"));
        }
    }
    Ok(SessionLock { _file: file })
}

/// The process a new tab belongs to.
///
/// As the `--browser-ensure` helper this process is short-lived, so it names its
/// parent — the Pi extension that is actually driving the tab. In the app
/// process the parent is launchd, so the app names itself.
fn owner_pid() -> u32 {
    #[cfg(unix)]
    {
        if std::env::args().nth(1).as_deref() == Some(ENSURE_FLAG) {
            return unsafe { libc::getppid() } as u32;
        }
    }
    std::process::id()
}

/// Whether a previous tab may be closed by this run.
///
/// Closing another run's tab is the failure this guards: two agent runs share
/// one Chrome, and a run that changes URL must not take the other's page away.
/// `previous_owner` is the run the tab was made for; `owner_alive` says whether
/// it is still working. `0` is a session file from before owners were recorded.
fn may_close_target(previous_owner: u32, our_owner: u32, owner_alive: bool) -> bool {
    previous_owner == 0 || previous_owner == our_owner || !owner_alive
}

fn may_close_target_now(previous_owner: u32, our_owner: u32) -> bool {
    // Guarded: `process_alive(0)` is a signal to the caller's whole process
    // group, not a question about pid 0.
    let alive = previous_owner != 0 && process_alive(previous_owner as i32);
    may_close_target(previous_owner, our_owner, alive)
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
    read_session_file(&path)
}

/// Read a session file, treating anything unreadable as "no session".
///
/// A concurrent writer could have a torn file, or a disk could have a partial
/// one: `None` makes the caller fall back to launching a browser, which is a
/// recoverable state, while an error here would surface as a failed command for
/// a file nobody needs to keep.
fn read_session_file(path: &Path) -> Option<BrowserSession> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BrowserSession>(&text).ok()
}

fn write_session(session: &BrowserSession) -> Result<(), String> {
    let dir = browser_dir()?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("无法创建浏览器目录：{error}"))?;
    write_session_file(&dir.join("session.json"), session)
}

/// Write a session file atomically.
///
/// The temp name carries the pid and a timestamp because a **fixed**
/// `session.json.tmp` is itself a cross-process race: two writers would
/// interleave into the same temp file and rename each other's half-written
/// bytes into place. Readers only ever see the old file or the new one, so a
/// torn read is impossible.
fn write_session_file(path: &Path, session: &BrowserSession) -> Result<(), String> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir).map_err(|error| format!("无法创建浏览器目录：{error}"))?;
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_else(|| "session.json".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temporary = dir.join(format!("{name}.{}-{nanos}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(session).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, body).map_err(|error| format!("无法写入浏览器会话：{error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("无法保存浏览器会话：{error}"))
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
        session.target_owner_pid = owner_pid();
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
        target_owner_pid: owner_pid(),
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
///
/// Wrapped in the cross-process lock: two `--browser-ensure` helpers running at
/// once must not both decide there is no browser and both launch one.
pub fn ensure(url: Option<&str>) -> Result<BrowserSession, String> {
    let _guard = lock_session()?;
    ensure_locked(url)
}

fn ensure_locked(url: Option<&str>) -> Result<BrowserSession, String> {
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
        let previous_owner = session.target_owner_pid;
        session.target_id = create_target(session.port, url)?;
        session.url = url.to_string();
        session.target_owner_pid = owner_pid();
        write_session(&session)?;
        // Only close a tab that is ours or whose run is gone. Closing one that
        // still belongs to a live run would take that run's page away mid-task:
        // this is the concurrency bug the owner field exists to stop.
        if may_close_target_now(previous_owner, session.target_owner_pid) {
            close_target(session.port, &previous);
        }
        return Ok(session);
    }
    launch(url.map(str::trim).filter(|value| !value.is_empty()).unwrap_or("about:blank"))
}

/// Stop the browser process itself, freeing the profile it holds.
///
/// Forced, and deliberately not the same thing as [`close`]: an import must stop
/// the browser even while another run is attached, because the profile cannot be
/// copied while Chrome holds it open and writes its cookies back.
fn stop_browser() -> Result<(), String> {
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

/// Close the browser, but never another live run's browser.
///
/// One Chrome serves every agent run (one profile, one DevTools port), so an
/// unconditional stop here would end a run that is still working. When the
/// current tab's owner is a live process that is not us, this leaves the browser
/// alone; otherwise it stops it, which is what the dock's close button means.
/// The import path uses [`stop_browser`] directly because it *must* force the
/// browser down.
pub fn close() -> Result<(), String> {
    let _guard = lock_session()?;
    let foreign_live = read_session()
        .map(|session| {
            let our_owner = owner_pid();
            session.target_owner_pid != 0
                && session.target_owner_pid != our_owner
                && process_alive(session.target_owner_pid as i32)
        })
        .unwrap_or(false);
    if foreign_live {
        eprintln!("[browser] 另一个运行还在这台浏览器上，保留浏览器只关本进程的标签页");
        return Ok(());
    }
    stop_browser()
}

pub fn status() -> Result<Option<BrowserSession>, String> {
    // Locked because `live_session` repairs a missing tab and writes the session
    // file back; that write must not race a launcher's.
    let _guard = lock_session()?;
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
// Importing a session from another browser
// ---------------------------------------------------------------------------

/// SQLite's own CLI. `.backup` is the online backup API: it takes a read lock
/// and walks the pages, so a database the *source* browser currently holds open
/// still yields a whole snapshot. A plain file copy does not — it can catch the
/// file mid-transaction and produce a database that will not open.
const SQLITE3: &str = "/usr/bin/sqlite3";

/// One profile a session can be imported from. `path` is the profile directory
/// (`…/Google/Chrome/Default`), which is what the cookies live in.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub browser: String,
    pub profile: String,
    /// What to call this in the UI: the profile's own name, or its directory.
    pub label: String,
    pub path: String,
    /// Cookies found, or `None` when the database could not be read at all.
    pub cookies: Option<u64>,
    /// The account the profile records, when it records one.
    pub account: Option<String>,
    /// Whether the browser is running right now.
    pub running: bool,
}

/// What an import actually brought over.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub browser: String,
    pub profile: String,
    /// Cookies that reached the browser the **column** renders.
    ///
    /// Not the count in Chrome's profile: the two are different questions, and
    /// answering the wrong one is how an import could report 3 778 cookies while
    /// the agent was still signed out of everything.
    pub cookies: u64,
    /// Whether a device-bound session came with it.
    ///
    /// It has to come with it or Chrome culls the auth cookies outright — but
    /// it is not enough on its own either: a device-bound session (Google's
    /// DBSC, among others) needs a private key that never leaves the profile
    /// that created it, so those sites still ask the user to sign in once.
    pub device_bound: bool,
    pub imported_at: u64,
    /// Always true in a report this version writes: a report exists only once
    /// both halves landed.
    ///
    /// Absent marks one written by the version that reported after the profile
    /// copy alone — a copy that could not make the session usable, and that then
    /// suppressed every later offer. Treating it as "not imported" is what lets
    /// those users be asked again.
    #[serde(default)]
    pub synced: bool,
}

/// The one browser an import can come from: the one Orbit actually launches,
/// and where its user-data directory lives.
///
/// Import is offerable for exactly one browser, and it is this one. macOS derives
/// each browser's cookie key from its **own** Keychain entry — "Chrome Safe
/// Storage" and "Microsoft Edge Safe Storage" are different keys — so cookies
/// copied out of a *different* browser fail to decrypt and the target drops them
/// on startup. Listing Edge next to Chrome would be a button that reports success
/// and imports nothing.
fn importable_browser(home: &Path) -> Option<(&'static str, PathBuf)> {
    let executable = find_browser().ok()?;
    let file = executable.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    let (display, relative) = match file {
        "Google Chrome" => ("Google Chrome", "Google/Chrome"),
        "Google Chrome Beta" => ("Google Chrome Beta", "Google/Chrome Beta"),
        "Google Chrome Dev" => ("Google Chrome Dev", "Google/Chrome Dev"),
        "Google Chrome Canary" => ("Google Chrome Canary", "Google/Chrome Canary"),
        "Chromium" => ("Chromium", "Chromium"),
        "Brave Browser" => ("Brave", "BraveSoftware/Brave-Browser"),
        "Microsoft Edge" => ("Microsoft Edge", "Microsoft Edge"),
        "Microsoft Edge Beta" => ("Microsoft Edge Beta", "Microsoft Edge Beta"),
        "Vivaldi" => ("Vivaldi", "Vivaldi"),
        _ => return None,
    };
    Some((display, home.join("Library/Application Support").join(relative)))
}

/// The profiles of one browser, from the only place that knows: `Local State`.
///
/// A profile is a directory *and* an entry in `profile.info_cache`. Listing
/// directories alone would offer `System Profile` and `Guest Profile` as if they
/// were the user's.
fn profile_entries(root: &Path) -> Vec<(String, Option<String>, Option<String>)> {
    let Ok(text) = std::fs::read_to_string(root.join("Local State")) else {
        return Vec::new();
    };
    let Ok(state) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(cache) = state.get("profile").and_then(|profile| profile.get("info_cache")).and_then(Value::as_object) else {
        return Vec::new();
    };
    cache
        .iter()
        .map(|(directory, info)| {
            let text = |key: &str| info.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
            (directory.clone(), text("name"), text("user_name").or_else(|| text("gaia_name")))
        })
        .collect()
}

/// Whether the source browser currently holds this profile.
fn profile_in_use(profile: &Path) -> bool {
    let Ok(target) = std::fs::read_link(profile.join("SingletonLock")) else {
        return false;
    };
    target
        .to_string_lossy()
        .rsplit('-')
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .is_some_and(process_alive)
}

fn snapshot_database(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
    }
    let _ = std::fs::remove_file(target);
    let script = format!(".backup '{}'", target.display().to_string().replace('\'', "''"));
    let output = Command::new(SQLITE3)
        .arg(format!("file:{}?mode=ro", source.display()))
        .arg(script)
        .output()
        .map_err(|error| format!("无法运行 sqlite3：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "快照 {} 失败：{}",
            source.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn count_cookies(database: &Path) -> Option<u64> {
    let output = Command::new(SQLITE3)
        .arg(format!("file:{}?mode=ro", database.display()))
        .arg("select count(*) from cookies;")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

fn import_report_path() -> Result<PathBuf, String> {
    Ok(browser_dir()?.join("import.json"))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Every profile the launcher's browser has that carries something to import.
#[tauri::command(async)]
pub fn browser_import_sources() -> Result<Vec<ImportSource>, String> {
    let home = home_dir()?;
    let Some((browser, root)) = importable_browser(&home) else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut sources = Vec::new();
    for (profile, name, account) in profile_entries(&root) {
        let path = root.join(&profile);
        if !path.is_dir() {
            continue;
        }
        let cookies = count_cookies(&path.join("Cookies"));
        // A profile with no cookie database is not a login anyone can import,
        // and offering it would only produce an empty result.
        if cookies.is_none() && !path.join("Cookies").is_file() {
            continue;
        }
        sources.push(ImportSource {
            browser: browser.to_string(),
            profile: profile.clone(),
            label: name.unwrap_or_else(|| profile.clone()),
            path: path.display().to_string(),
            cookies,
            account,
            running: profile_in_use(&path),
        });
    }
    Ok(sources)
}

/// What the copy half produced, before anything has reached the column.
struct CopyOutcome {
    browser: String,
    profile: String,
    device_bound: bool,
}

/// Copy one browser's session into the profile Orbit's browser uses.
///
/// Copy one browser's session into the profile Orbit's browser uses.
///
/// Taken by name rather than by path: the frontend may only name a browser and a
/// profile that [`browser_import_sources`] reported, so no caller can talk this
/// into reading an arbitrary file off the disk.
///
/// Half of an import, and deliberately not a command of its own any more: the
/// profile copy is invisible to the browser the column actually renders, and a
/// command that wrote a report here would say "imported" about a session nobody
/// could use.
fn copy_profile(browser: &str, profile: &str) -> Result<CopyOutcome, String> {
    // The lock is held across the whole copy: an import mutates the very
    // directory a concurrent `--browser-ensure` reads.
    let _guard = lock_session()?;
    let home = home_dir()?;
    let (available, root) = importable_browser(&home)
        .ok_or_else(|| "没有找到可导入的浏览器内核；Orbit 需要装一个 Chromium 系浏览器才能导入登录".to_string())?;
    // The list the frontend picked from was built for this same browser, so a
    // mismatch means it is stale — not that the caller may name another one.
    if browser != available {
        return Err(format!("当前可导入的是 {available}，不是 {browser}"));
    }
    let source = root.join(profile);
    if !source.is_dir() {
        return Err(format!("找不到要导入的 profile：{}", source.display()));
    }

    let target = profile_dir()?;
    // Unconditionally, and not only when a session file says so: Chrome holds this
    // profile open and writes its cookies back on the way out, which would undo
    // the copy. `stop_browser()` is forced — unlike `close()` — because the
    // profile cannot be copied while any Chrome still holds it, and it is also
    // the only path that clears an orphan: a browser still running after its
    // session file was lost, exactly the case a `live_session().is_some()` guard
    // would miss.
    stop_browser()?;

    // A staging directory next to the target: everything is produced and checked
    // there first, and only then moved into place. A failure mid-copy leaves the
    // target profile exactly as it was instead of half old and half new.
    let staging = browser_dir()?.join("import-staging");
    let _ = std::fs::remove_dir_all(&staging);
    if let Err(error) = std::fs::create_dir_all(staging.join("Default")) {
        return Err(format!("无法创建导入暂存目录：{error}"));
    }

    let staged = stage_profile(&source, &target, &staging);
    let result = match staged {
        Ok(device_bound) => commit_staged(&staging, &target, device_bound).map(|()| CopyOutcome {
            browser: browser.to_string(),
            profile: profile.to_string(),
            device_bound,
        }),
        Err(error) => Err(error),
    };
    // Always: a leftover staging directory would be read as a candidate next
    // time, and its cookies are already installed or rejected by now.
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// Produce a complete, verified copy in `staging`, without touching `target`.
///
/// Returns whether a device-bound session came with it. Everything that can
/// fail — reading the source database, finding no cookies, copying — fails here,
/// while the target is still untouched.
fn stage_profile(source: &Path, target: &Path, staging: &Path) -> Result<bool, String> {
    std::fs::create_dir_all(staging.join("Default")).map_err(|error| format!("无法创建导入暂存目录：{error}"))?;

    // `Local State` is the profile list and the OS-crypt bookkeeping. Only ever
    // written for a target that has none: overwriting it with the source's would
    // make the target forget its own profiles, and, on builds that record key
    // derivation there, its own cookies.
    let source_state = source.with_file_name("Local State");
    if !target.join("Local State").is_file() && source_state.is_file() {
        std::fs::copy(&source_state, staging.join("Local State"))
            .map_err(|error| format!("复制 Local State 失败：{error}"))?;
    }

    snapshot_database(&source.join("Cookies"), &staging.join("Default/Cookies"))?;
    let copied = count_cookies(&staging.join("Default/Cookies")).unwrap_or(0);
    // A copy that produced an unreadable or empty database is not an import, and
    // saying so here is what keeps it from being reported as one.
    if copied == 0 {
        return Err(format!("{} 里没有可导入的 cookie", source.display()));
    }

    // The device-bound session records. Without these Chrome culls `SID` and the
    // other `__Secure-*PSID*` cookies on startup — measured, not assumed — which
    // is the difference between "the session came over" and "every Google site
    // asks you to sign in again".
    let bound = source.join("Device Bound Sessions");
    let device_bound = bound.is_file();
    if device_bound {
        std::fs::copy(&bound, staging.join("Default/Device Bound Sessions"))
            .map_err(|error| format!("复制 Device Bound Sessions 失败：{error}"))?;
    }
    Ok(device_bound)
}

/// Move a verified staging directory into the target profile.
///
/// Rename is atomic within the same directory, and cookies are moved **last**:
/// the decisive artifact is what makes an import real, and a failure before it
/// leaves no cookie in the target. Device Bound Sessions go before cookies
/// because cookies without their bound sessions are culled on startup.
fn commit_staged(staging: &Path, target: &Path, device_bound: bool) -> Result<(), String> {
    std::fs::create_dir_all(target.join("Default")).map_err(|error| format!("无法创建资料目录：{error}"))?;
    let state = staging.join("Local State");
    if state.is_file() {
        std::fs::rename(&state, target.join("Local State")).map_err(|error| format!("安装 Local State 失败：{error}"))?;
    }
    if device_bound {
        std::fs::rename(
            staging.join("Default/Device Bound Sessions"),
            target.join("Default/Device Bound Sessions"),
        )
        .map_err(|error| format!("安装 Device Bound Sessions 失败：{error}"))?;
    }
    std::fs::rename(staging.join("Default/Cookies"), target.join("Default/Cookies"))
        .map_err(|error| format!("安装 Cookies 失败：{error}"))?;
    Ok(())
}

/// Copy a session and hand it to the browser the column renders — the whole
/// import, and the only thing that writes a report.
///
/// One command rather than two because the two halves are one outcome. A report
/// written after the copy alone claimed success for a session the agent could not
/// use, and then suppressed every later offer: the worst of both, a silent
/// failure and a silenced retry.
#[tauri::command]
pub async fn browser_import_session(
    app: tauri::AppHandle,
    browser: String,
    profile: String,
) -> Result<ImportReport, String> {
    let copied = copy_profile(&browser, &profile)?;
    let cookies = sync_cookies(&app).await? as u64;
    let report = ImportReport {
        browser: copied.browser,
        profile: copied.profile,
        cookies,
        device_bound: copied.device_bound,
        imported_at: now_seconds(),
        synced: true,
    };
    let path = import_report_path()?;
    let text = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("无法写入 {}：{error}", path.display()))?;
    Ok(report)
}

/// The last import, or `None` when nothing has ever been imported. This is what
/// decides whether the first-run prompt is still owed.
#[tauri::command(async)]
pub fn browser_import_state() -> Result<Option<ImportReport>, String> {
    let Ok(text) = std::fs::read_to_string(import_report_path()?) else {
        return Ok(None);
    };
    // A report without `synced` came from the version that wrote one after the
    // profile copy alone. It does not mean the session is usable, so it does not
    // count as an import — which is what lets those users be offered it again.
    Ok(serde_json::from_str::<ImportReport>(&text).ok().filter(|report| report.synced))
}

// ---------------------------------------------------------------------------
// Handing the imported session to the column's own browser
// ---------------------------------------------------------------------------

/// The cookies Orbit's browser holds, straight from the browser itself.
///
/// Deliberately not decrypted here. Chrome's cookie values are sealed with the
/// macOS Keychain entry for **its own** identity, and reimplementing that
/// (Keychain read, PBKDF2, AES-CBC, and whatever the next Chrome changes it to)
/// is a standing liability. Chrome already knows how to open its own database,
/// so the import copies the profile and then asks the browser for the plaintext
/// over the same DevTools protocol the agent drives it with.
/// `async` on purpose, and not merely convenient: this is called from inside
/// Tauri's own runtime, where building a second one and blocking on it panics
/// ("Cannot start a runtime from within a runtime") on a worker thread that
/// nothing is catching — which leaves the caller's promise unsettled forever, and
/// looks exactly like an import stuck at "导入中" with no error anywhere.
async fn cdp_cookies(session: &BrowserSession) -> Result<Vec<Value>, String> {
    let url = format!("ws://127.0.0.1:{}{}", session.port, session.browser_ws);
    (async move {
        let (mut socket, _) = connect_async(&url)
            .await
            .map_err(|error| format!("无法连接浏览器调试口：{error}"))?;
        socket
            .send(Message::text(r#"{"id":1,"method":"Storage.getCookies"}"#.to_string()))
            .await
            .map_err(|error| format!("发送 CDP 请求失败：{error}"))?;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            // Bounded per read, not only per iteration. `socket.next()` returns
            // when a frame arrives or the socket closes — a socket that stays open
            // and silent would park here forever, and the deadline above would
            // never be reached. That is the same shape of hang as the nested
            // runtime: a caller waiting on a promise that can no longer settle.
            let frame = match tokio::time::timeout(remaining, socket.next()).await {
                Ok(Some(Ok(frame))) => frame,
                Ok(Some(Err(error))) => return Err(format!("读取 CDP 响应失败：{error}")),
                Ok(None) => break,
                Err(_) => break,
            };
            let Message::Text(text) = frame else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value.get("id").and_then(Value::as_i64) != Some(1) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(format!("浏览器拒绝了取 cookie：{error}"));
            }
            return Ok(value
                .pointer("/result/cookies")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default());
        }
        Err("浏览器没有在超时前返回 cookie".to_string())
    })
    .await
}

/// One CDP cookie row as the cookie crate's type, which is what WebKit takes.
fn webkit_cookie(value: &Value) -> Option<Cookie<'static>> {
    let name = value.get("name").and_then(Value::as_str)?;
    let raw = value.get("value").and_then(Value::as_str).unwrap_or("");
    let mut cookie = Cookie::new(name.to_string(), raw.to_string());
    if let Some(domain) = value.get("domain").and_then(Value::as_str) {
        cookie.set_domain(webkit_domain(domain));
    }
    cookie.set_path(
        value
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("/")
            .to_string(),
    );
    if value.get("secure").and_then(Value::as_bool).unwrap_or(false) {
        cookie.set_secure(true);
    }
    if value.get("httpOnly").and_then(Value::as_bool).unwrap_or(false) {
        cookie.set_http_only(true);
    }
    match value.get("sameSite").and_then(Value::as_str) {
        Some("Strict") => cookie.set_same_site(SameSite::Strict),
        Some("Lax") => cookie.set_same_site(SameSite::Lax),
        Some("None") => cookie.set_same_site(SameSite::None),
        _ => {}
    }
    // A session cookie (`expires` of -1) stays one: it is what the source browser
    // had, and inventing an expiry would be a different cookie.
    let expires = value.get("expires").and_then(Value::as_f64).unwrap_or(-1.0);
    if expires > 0.0 {
        if let Ok(at) = web_cookie::time::OffsetDateTime::from_unix_timestamp(expires as i64) {
            cookie.set_expires(at);
        }
    }
    Some(cookie)
}

/// The domain string the `cookie` crate must hold, so WebKit receives the one
/// the source browser had.
///
/// `Cookie::domain()` strips **one** leading dot (`cookie-0.18.2/src/lib.rs:777`),
/// and `wry` builds the `NSHTTPCookie`'s `Domain` from exactly that accessor
/// (`wry-0.55.1/src/wkwebview/mod.rs:1116`). Handing it `.google.com` is therefore
/// how a domain cookie silently becomes a host-only cookie for `google.com` —
/// and `accounts.google.com`, `mail.google.com` and every other subdomain stop
/// being signed in, which is precisely the login the import exists to bring over.
///
/// Doubling the dot is the one value whose round trip is the source string; the
/// assertion on `domain()` in the tests is what keeps that true if the
/// dependency's normalisation ever changes.
fn webkit_domain(domain: &str) -> String {
    if domain.starts_with('.') {
        format!(".{domain}")
    } else {
        // No leading dot is a host-only cookie, and stays one.
        domain.to_string()
    }
}

/// How often the import says where it is.
const PROGRESS_EVERY: usize = 25;
/// Where an import has got to, for the banner that started it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    done: usize,
    total: usize,
}

/// Read Chrome's cookies and write them into the store the column reads.
///
/// The two browsers keep **separate stores** — Chrome's is a directory under
/// `~/.pi/agent/browser`, the column is WebKit's — so copying the profile only
/// gets the cookies as far as Chrome. This is the other half, and it goes through
/// `WKHTTPCookieStore` (via `Webview::set_cookie`), which is the only way to write
/// the httpOnly cookies every real login depends on: a script cannot set those,
/// and neither can a file copy, because the formats are different engines'.
///
/// WebKit's store is the default one, shared by every web view in the app, so
/// writing through the main web view is writing to the store the browser column
/// reads.
///
/// Not a command of its own: re-syncing is re-importing, and a second entry point
/// that nothing calls is a second thing to keep correct. A real `async fn` rather
/// than a sync one marked `(async)`, because the latter still runs inside Tauri's
/// runtime, where a nested `block_on` panics on a worker thread and leaves the
/// caller waiting forever.
async fn sync_cookies(app: &tauri::AppHandle) -> Result<usize, String> {
    let session = ensure(None)?;
    let values = cdp_cookies(&session).await?;
    let total = values.len();
    let webview = app
        .get_webview("main")
        .ok_or_else(|| "主窗口不存在，无法写入 cookie".to_string())?;
    let mut written = 0usize;
    for (index, value) in values.iter().enumerate() {
        // One event per 25 cookies: one per cookie would be 3 778 promises the
        // banner cannot paint anyway.
        if index % PROGRESS_EVERY == 0 {
            let _ = app.emit("orbit://browser/import-progress", ImportProgress { done: index, total });
        }
        let Some(cookie) = webkit_cookie(value) else {
            continue;
        };
        if webview.set_cookie(cookie).is_ok() {
            written += 1;
        }
    }
    let _ = app.emit("orbit://browser/import-progress", ImportProgress { done: total, total });
    if written == 0 && total > 0 {
        return Err(format!("{total} 个 cookie 全部写入失败"));
    }
    Ok(written)
}
// ---------------------------------------------------------------------------
// Helper invocation: `Orbit --browser-ensure [--url <url>]`
// ---------------------------------------------------------------------------

const ENSURE_FLAG: &str = "--browser-ensure";
const CLOSE_FLAG: &str = "--browser-close";
const STATUS_FLAG: &str = "--browser-status";
/// Prints what an import could come from. Exists so the one question the settings
/// page cannot answer from a screenshot — "is the list empty, or is the list
/// not being asked for" — is one command away from an answer.
const SOURCES_FLAG: &str = "--browser-import-sources";

/// The Pi extension drives the same browser the dock shows, and it is a
/// separate process: it cannot call a Tauri command. Instead it runs the app
/// binary it was spawned by with one of these flags, which prints the session
/// as JSON on stdout. That keeps the launch flags in exactly one place.
pub fn exec_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = args.first()?;
    if ![ENSURE_FLAG, CLOSE_FLAG, STATUS_FLAG, SOURCES_FLAG].contains(&flag.as_str()) {
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
        SOURCES_FLAG => browser_import_sources()
            .and_then(|sources| serde_json::to_string(&sources).map_err(|error| error.to_string())),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("orbit-browser-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A profile is a directory *and* an entry in `profile.info_cache`, and only
    /// `Local State` knows the second half. `System Profile` and `Guest Profile`
    /// are directories that must never be offered as the user's own.
    #[test]
    fn profiles_come_from_local_state_not_from_directories() {
        let root = scratch("profiles");
        std::fs::create_dir_all(root.join("Default")).unwrap();
        std::fs::create_dir_all(root.join("System Profile")).unwrap();
        std::fs::write(
            root.join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"erkelost","user_name":"me@example.com"},"Profile 1":{"name":"Work"}}}}"#,
        )
        .unwrap();

        let entries = profile_entries(&root);
        let mut directories: Vec<&str> = entries.iter().map(|(directory, _, _)| directory.as_str()).collect();
        directories.sort();
        assert_eq!(directories, vec!["Default", "Profile 1"]);

        let default = entries.iter().find(|(directory, ..)| directory == "Default").unwrap();
        assert_eq!(default.1.as_deref(), Some("erkelost"));
        assert_eq!(default.2.as_deref(), Some("me@example.com"));
        // A profile with no signed-in account reports none rather than guessing
        // one from the display name.
        assert_eq!(entries.iter().find(|(directory, ..)| directory == "Profile 1").unwrap().2, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_or_unreadable_local_state_offers_nothing() {
        let root = scratch("profiles-broken");
        assert!(profile_entries(&root).is_empty());
        std::fs::write(root.join("Local State"), "not json").unwrap();
        assert!(profile_entries(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A source root is always under the user's own home and inside the
    /// launcher's browser directory: a path this could be talked into reading
    /// anywhere else is the one thing the by-name import exists to prevent.
    /// Live, not hermetic: it needs a Chrome already running on Orbit's own
    /// profile. `cargo test -- --ignored cdp_cookies`
    ///
    /// This is the half of the import that cannot be unit-tested away — a
    /// WebSocket handshake, one CDP call, and Chrome's own JSON shape — so it is
    /// worth one test that fails loudly when that shape moves.
    #[test]
    #[ignore = "requires a browser already running on Orbit's profile"]
    fn cdp_cookies_reads_a_live_session() {
        let session = read_session().expect("no session file: start the browser first");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        let cookies = runtime.block_on(cdp_cookies(&session)).expect("CDP read failed");
        assert!(!cookies.is_empty(), "Chrome returned no cookies at all");
        assert!(cookies.iter().filter_map(webkit_cookie).count() > 0, "not one cookie survived the mapping");
        let with_domain = cookies
            .iter()
            .filter(|cookie| cookie.get("name").and_then(Value::as_str).is_some() && cookie.get("domain").and_then(Value::as_str).is_some())
            .count();
        assert_eq!(with_domain, cookies.len(), "every CDP row carries a name and a domain");
    }

    /// A real row keeps its flags and its date: losing either turns a login into
    /// a cookie that WebKit will not send.
    #[test]
    fn a_real_cookie_row_maps_with_its_flags_intact() {
        let row = serde_json::json!({
            "name": "SID",
            "value": "abc",
            "domain": ".google.com",
            "path": "/",
            "expires": 1_791_000_000.0,
            "httpOnly": true,
            "secure": true,
            "sameSite": "Lax"
        });
        let cookie = webkit_cookie(&row).expect("a well-formed row maps");
        assert_eq!(cookie.name(), "SID");
        // The leading dot has to survive to WebKit: `wry` builds the
        // `NSHTTPCookie`'s domain from `cookie.domain()`, which strips one dot
        // (`webkit_domain`). Without this, a `.google.com` cookie reaches WebKit
        // as `google.com` and no subdomain is signed in.
        assert_eq!(cookie.domain(), Some(".google.com"));
        assert_eq!(cookie.http_only(), Some(true));
        assert_eq!(cookie.secure(), Some(true));
        assert_eq!(cookie.same_site(), Some(SameSite::Lax));
        assert!(cookie.expires_datetime().is_some(), "a dated cookie must keep its date");

        // A flag Chrome did not set stays absent rather than being invented: a
        // non-secure, session cookie is exactly that.
        let plain = webkit_cookie(&serde_json::json!({
            "name": "t", "value": "v", "domain": "a.com", "path": "/", "expires": -1.0
        }))
        .expect("a minimal row maps");
        assert_eq!(plain.secure(), None);
        assert_eq!(plain.http_only(), None);
        assert!(plain.expires_datetime().is_none());
    }

    /// A session cookie must stay a session cookie, and a row without a name is
    /// not a cookie at all.
    #[test]
    fn session_cookies_and_nameless_rows_are_handled() {
        let session = serde_json::json!({ "name": "t", "value": "v", "domain": "a.com", "path": "/", "expires": -1.0 });
        assert!(webkit_cookie(&session).unwrap().expires_datetime().is_none());
        assert!(webkit_cookie(&serde_json::json!({ "value": "v" })).is_none());
    }

    /// A host-only cookie (no leading dot) must stay host-only: doubling every
    /// domain would hand WebKit a dot it never had.
    #[test]
    fn a_host_only_domain_is_left_alone() {
        let row = serde_json::json!({ "name": "t", "value": "v", "domain": "example.com", "path": "/" });
        assert_eq!(webkit_cookie(&row).unwrap().domain(), Some("example.com"));
        assert_eq!(webkit_domain(".a.com"), "..a.com");
        assert_eq!(webkit_domain("a.com"), "a.com");
    }

    #[test]
    fn the_importable_root_is_the_launched_browser_only() {
        let home = PathBuf::from("/tmp/orbit-home");
        let Some((display, root)) = importable_browser(&home) else {
            // No Chromium-family browser installed here: nothing to assert, and
            // the empty source list is the correct answer.
            return;
        };
        assert!(!display.is_empty());
        let base = home.join("Library/Application Support");
        assert!(root.starts_with(&base));
        // Exactly the browser's own directory, never the shared parent: the
        // latter would make every installed browser's profiles candidates again.
        assert_ne!(root, base);
    }

    fn sample_session() -> BrowserSession {
        BrowserSession {
            port: 1234,
            target_id: "TARGET".to_string(),
            url: "https://example.com".to_string(),
            pid: 99,
            executable: "/Applications/Chrome".to_string(),
            started_at: 1,
            browser_version: "Chrome/1".to_string(),
            browser_ws: "/devtools/browser/x".to_string(),
            user_agent: "UA".to_string(),
            target_owner_pid: 7,
        }
    }

    fn sqlite_available() -> bool {
        Command::new(SQLITE3)
            .arg("-version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    /// A session file must appear whole or not at all, and must not leave behind
    /// a temp file another writer could collide on.
    #[test]
    fn a_session_write_is_atomic_and_leaves_no_temp_files() {
        let root = scratch("session-write");
        let path = root.join("session.json");
        write_session_file(&path, &sample_session()).unwrap();
        let read = read_session_file(&path).expect("the written session reads back");
        assert_eq!(read.target_id, "TARGET");
        assert_eq!(read.target_owner_pid, 7);
        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|entry| entry.file_name().to_string_lossy().to_string()))
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A torn or absent session file is "no session", never an error the caller
    /// has to recover from.
    #[test]
    fn a_corrupt_session_reads_as_no_session() {
        let root = scratch("session-corrupt");
        let path = root.join("session.json");
        std::fs::write(&path, "{ half a file").unwrap();
        assert!(read_session_file(&path).is_none());
        assert!(read_session_file(&root.join("missing.json")).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The three branches that decide whether a previous tab may be closed: ours,
    /// another live run's (hands off), and a run that is gone (clean up).
    #[test]
    fn a_previous_tab_is_closed_only_when_ours_or_the_owner_is_gone() {
        assert!(may_close_target(42, 42, true), "our own tab");
        assert!(!may_close_target(42, 7, true), "another live run's tab is not ours to close");
        assert!(may_close_target(42, 7, false), "a dead run's tab is cleaned up");
        assert!(may_close_target(0, 7, false), "a session from before owners existed");
    }

    /// Staging must never overwrite a `Local State` the target already has, and
    /// the target stays untouched until the verified staging is committed.
    #[test]
    fn staging_never_overwrites_the_targets_local_state() {
        if !sqlite_available() {
            eprintln!("skip: sqlite3 unavailable");
            return;
        }
        let root = scratch("stage-local-state");
        let source = root.join("source/Default");
        let target = root.join("target");
        let staging = root.join("staging");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.with_file_name("Local State"), "from-source").unwrap();
        std::fs::write(target.join("Local State"), "target-own").unwrap();
        let created = Command::new(SQLITE3)
            .arg(source.join("Cookies"))
            .arg("create table cookies (host_key text, name text, value text); insert into cookies values ('a.com','SID','x');")
            .status()
            .unwrap();
        assert!(created.success());

        let device_bound = stage_profile(&source, &target, &staging).unwrap();
        assert!(!device_bound);
        // Staging does not touch the target, and it deliberately does not stage
        // the source's Local State over the target's own.
        assert_eq!(std::fs::read_to_string(target.join("Local State")).unwrap(), "target-own");
        assert!(!staging.join("Local State").is_file());

        commit_staged(&staging, &target, device_bound).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("Local State")).unwrap(), "target-own");
        assert!(target.join("Default/Cookies").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A target that has no `Local State` gets the source's, so a first import
    /// into a fresh profile still carries the profile list.
    #[test]
    fn a_target_without_local_state_is_given_one() {
        if !sqlite_available() {
            eprintln!("skip: sqlite3 unavailable");
            return;
        }
        let root = scratch("stage-fresh-target");
        let source = root.join("source/Default");
        let target = root.join("target");
        let staging = root.join("staging");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.with_file_name("Local State"), "from-source").unwrap();
        Command::new(SQLITE3)
            .arg(source.join("Cookies"))
            .arg("create table cookies (host_key text, name text, value text); insert into cookies values ('a.com','SID','x');")
            .status()
            .unwrap();

        let device_bound = stage_profile(&source, &target, &staging).unwrap();
        assert_eq!(std::fs::read_to_string(staging.join("Local State")).unwrap(), "from-source");
        commit_staged(&staging, &target, device_bound).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("Local State")).unwrap(), "from-source");
        let _ = std::fs::remove_dir_all(&root);
    }
}
