//! Native Chromium profiles and verified Cookie import. Page lifetime and
//! automation live in browser_view and browser_cdp; no external browser is launched.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "找不到用户目录".to_string())
}
pub fn browser_dir() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("ORBIT_BROWSER_HOME") {
        return Ok(PathBuf::from(root));
    }
    Ok(home_dir()?.join(".pi/agent/browser"))
}
#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    pid > 0 && (unsafe { libc::kill(pid, 0) }) == 0
}
#[cfg(not(unix))]
fn process_alive(_pid: i32) -> bool {
    false
}

#[tauri::command]
pub fn browser_client_report(message: String) {
    eprintln!("[browser] {message}");
}

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
    /// Chromium-family cookies are sealed with the login keychain. Firefox is not.
    pub needs_keychain: bool,
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
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub skipped: u64,
    #[serde(default)]
    pub skipped_domains: Vec<String>,
    #[serde(default)]
    pub partition: Option<String>,
    /// The CEF root and import schema identify the destination store.
    #[serde(default)]
    pub store_identity: Option<String>,
}

/// Whether the source browser currently holds this profile.
fn profile_in_use(profile: &Path) -> bool {
    let lock = profile.parent().unwrap_or(profile).join("SingletonLock");
    let Ok(target) =
        std::fs::read_link(&lock).or_else(|_| std::fs::read_link(profile.join("SingletonLock")))
    else {
        return false;
    };
    target
        .to_string_lossy()
        .rsplit('-')
        .next()
        .and_then(|value| value.parse::<i32>().ok())
        .is_some_and(process_alive)
}

fn import_report_path() -> Result<PathBuf, String> {
    Ok(browser_dir()?.join("imports").join(format!(
        "{}.json",
        source_partition("store", &cookie_store_identity())
    )))
}

fn cookie_store_identity() -> String {
    browser_dir()
        .map(|path| path.join("cef").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "orbit-cef".into())
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Discover supported browser profiles without launching an external browser.
#[tauri::command(async)]
pub fn browser_import_sources() -> Result<Vec<ImportSource>, String> {
    let home = home_dir()?;
    Ok(crate::cookie_import::sources(&home)
        .into_iter()
        .map(|source| ImportSource {
            browser: source.browser.to_string(),
            profile: source.profile.clone(),
            label: source.label.clone(),
            path: source.path.display().to_string(),
            cookies: crate::cookie_import::cookie_count(&source),
            account: source.account.clone(),
            running: profile_locked(
                &source.path,
                matches!(source.kind, crate::cookie_import::Kind::Firefox),
            ),
            needs_keychain: matches!(source.kind, crate::cookie_import::Kind::Chromium { .. }),
        })
        .collect())
}

/// Whether another browser is holding this profile open right now.
///
/// Chromium marks it with the same `SingletonLock` the launcher's browser uses;
/// Firefox writes a `lock` symlink next to its `cookies.sqlite`. Neither stops a
/// read — both databases are opened read-only — but the picker is the place to
/// warn that a copy taken now may miss what the running browser has not written.
fn profile_locked(path: &Path, firefox: bool) -> bool {
    if firefox {
        return path.join("lock").exists();
    }
    profile_in_use(path)
}

static IMPORT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Read a consistent source snapshot and verify cookies in the actual panel store.
#[tauri::command]
pub async fn browser_import_session(
    app: tauri::AppHandle,
    browser: String,
    profile: String,
    keychain_password: Option<String>,
) -> Result<ImportReport, String> {
    let _guard = IMPORT_LOCK
        .try_lock()
        .map_err(|_| "已有浏览器导入正在进行，请等它结束")?;
    let _profile_guard = crate::browser_view::begin_profile_import(&app)?;
    let partition = source_partition(&browser, &profile);
    let home = home_dir()?;
    let source = crate::cookie_import::sources(&home)
        .into_iter()
        .find(|source| source.browser == browser && source.profile == profile)
        .ok_or_else(|| format!("找不到导入来源 {browser} / {profile}，请刷新列表"))?;
    // Keychain prompts and SQLite reads can block; keep the async runtime responsive.
    let read = tauri::async_runtime::spawn_blocking(move || {
        crate::cookie_import::read_cookies(&source, keychain_password.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    if read.cookies.is_empty() {
        return Err(format!(
            "{browser} 的这个 profile 没有可导入的普通 Cookie（跳过 {} 个）",
            read.skipped
        ));
    }
    let writer = app.clone();
    let target_partition = partition.clone();
    let (cookies, skipped, skipped_domains) = tauri::async_runtime::spawn_blocking(move || {
        let view = crate::browser_view::profile_cookie_view(&writer, &target_partition)?;
        let result = write_webview_cookies(&writer, &view, read);
        #[cfg(desktop)]
        {
            crate::browser_cdp::forget(&writer, view.label());
            let _ = view.close();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())??;
    let report = ImportReport {
        browser,
        profile,
        cookies: cookies as u64,
        device_bound: false,
        imported_at: now_seconds(),
        synced: true,
        version: 5,
        skipped: skipped as u64,
        skipped_domains,
        partition: Some(partition),
        store_identity: Some(cookie_store_identity()),
    };
    let path = import_report_path()?;
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(path.parent().ok_or("导入记录目录不存在")?)
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text)
        .and_then(|_| std::fs::rename(&temp, &path))
        .map_err(|e| format!("无法保存导入结果：{e}"))?;
    if let Ok(mut active) = ACTIVE_PARTITION.write() {
        *active = report.partition.clone();
    }
    Ok(report)
}

/// The last import, or `None` when nothing has ever been imported. This is what
/// decides whether the first-run prompt is still owed.
#[tauri::command(async)]
pub fn browser_import_state(app: tauri::AppHandle) -> Result<Option<ImportReport>, String> {
    let Some(report) = read_import_report()? else {
        return Ok(None);
    };
    // The shared report is not proof that this app's native cookie store was
    // populated. Legacy records cannot identify it, so offer a fresh import.
    if !report_matches_store(&report, &cookie_store_identity()) {
        return Ok(None);
    }
    let view = crate::browser_view::profile_cookie_view(
        &app,
        report
            .partition
            .as_deref()
            .ok_or("导入记录缺少浏览器资料标识")?,
    )?;
    let cookies = native_cookies(&app, &view);
    #[cfg(desktop)]
    {
        crate::browser_cdp::forget(&app, view.label());
        let _ = view.close();
    }
    Ok(if cookies?.is_empty() {
        None
    } else {
        Some(report)
    })
}

fn report_matches_store(report: &ImportReport, identity: &str) -> bool {
    report.version >= 5 && report.store_identity.as_deref() == Some(identity)
}

fn read_import_report() -> Result<Option<ImportReport>, String> {
    let legacy = browser_dir()?.join("import.json");
    let Ok(text) =
        std::fs::read_to_string(import_report_path()?).or_else(|_| std::fs::read_to_string(legacy))
    else {
        return Ok(None);
    };
    // A report without `synced` came from the version that wrote one after the
    // profile copy alone. It does not mean the session is usable, so it does not
    // count as an import — which is what lets those users be offered it again.
    Ok(serde_json::from_str::<ImportReport>(&text)
        .ok()
        .filter(|report| {
            report.synced && report.version >= 3 && report.cookies > 0 && report.partition.is_some()
        }))
}

static ACTIVE_PARTITION: std::sync::LazyLock<std::sync::RwLock<Option<String>>> =
    std::sync::LazyLock::new(|| {
        std::sync::RwLock::new(
            read_import_report()
                .ok()
                .flatten()
                .filter(|report| report_matches_store(report, &cookie_store_identity()))
                .and_then(|report| report.partition),
        )
    });
pub(crate) fn active_partition() -> Option<String> {
    ACTIVE_PARTITION.read().ok().and_then(|value| value.clone())
}
fn source_partition(browser: &str, profile: &str) -> String {
    // Stable FNV-1a identity; source names are metadata, never secret material.
    let mut hash = 0x6c62272e07bb014262b821756295c58du128;
    for byte in browser.bytes().chain([0]).chain(profile.bytes()) {
        hash ^= byte as u128;
        hash = hash.wrapping_mul(0x0000000001000000000000000000013b);
    }
    format!("{hash:032x}")
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

/// Keep Chromium's CookieParam fields, including host-only domains, SameSite
/// and real expiration. CHIPS cookies need their original partition context.
fn native_cookie(row: &Value) -> Option<Value> {
    if row.get("partitionKey").is_some() || row["partitionKeyOpaque"] == true {
        return None;
    }
    if row["name"].as_str().is_none_or(str::is_empty)
        || row["domain"].as_str().is_none_or(str::is_empty)
    {
        return None;
    }
    let mut cookie = serde_json::Map::new();
    for field in [
        "name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite",
    ] {
        if let Some(value) = row.get(field) {
            cookie.insert(field.into(), value.clone());
        }
    }
    if cookie
        .get("expires")
        .and_then(Value::as_f64)
        .is_some_and(|expires| expires <= 0.0)
    {
        cookie.remove("expires");
    }
    Some(Value::Object(cookie))
}

fn native_cookies(app: &tauri::AppHandle, view: &tauri::Webview) -> Result<Vec<Value>, String> {
    #[cfg(desktop)]
    {
        // getCookies without URLs only sees cookies for about:blank. The page
        // target's Network domain reads all cookies in its own request context.
        // Storage with browserContextId requires a browser-level CDP target.
        let result = crate::browser_cdp::command(
            app,
            view,
            "Network.getAllCookies",
            serde_json::json!({}),
            Duration::from_secs(5),
        )?;
        result["cookies"]
            .as_array()
            .cloned()
            .ok_or_else(|| "Chromium 没有返回 Cookie".into())
    }
    #[cfg(mobile)]
    {
        let _ = (app, view);
        Err("浏览器资料导入需要桌面 Host".into())
    }
}

fn write_webview_cookies(
    app: &tauri::AppHandle,
    view: &tauri::Webview,
    mut read: crate::cookie_import::CookieRead,
) -> Result<(usize, usize, Vec<String>), String> {
    #[cfg(desktop)]
    {
        let total = read.cookies.len();
        let mut expected = Vec::new();
        for (index, row) in read.cookies.iter().enumerate() {
            if index % PROGRESS_EVERY == 0 {
                let _ = app.emit(
                    "orbit://browser/import-progress",
                    ImportProgress { done: index, total },
                );
            }
            let Some(cookie) = native_cookie(row) else {
                read.skipped += 1;
                continue;
            };
            if crate::browser_cdp::command(
                app,
                view,
                "Network.setCookies",
                serde_json::json!({"cookies": [cookie]}),
                Duration::from_secs(5),
            )
            .is_ok()
            {
                expected.push(cookie);
            } else {
                read.skipped += 1;
            }
        }
        let retained = native_cookies(app, view)?;
        let written = expected
            .iter()
            .filter(|row| {
                retained.iter().any(|stored| {
                    ["name", "value", "domain", "path"]
                        .iter()
                        .all(|field| stored[*field] == row[*field])
                        && ["secure", "httpOnly", "sameSite"].iter().all(|field| {
                            row.get(*field).is_none_or(|value| stored[*field] == *value)
                        })
                        && row
                            .get("expires")
                            .and_then(Value::as_f64)
                            .is_none_or(|expires| {
                                stored["expires"]
                                    .as_f64()
                                    .is_some_and(|value| (value - expires).abs() < 1.0)
                            })
                })
            })
            .count();
        read.skipped += expected.len() - written;
        let _ = app.emit(
            "orbit://browser/import-progress",
            ImportProgress { done: total, total },
        );
        if written == 0 {
            return Err("导入后没有可验证的 Chromium Cookie".into());
        }
        flush_cookie_store(view)?;
        Ok((
            written,
            read.skipped,
            read.skipped_domains.into_iter().collect(),
        ))
    }
    #[cfg(mobile)]
    {
        let _ = (app, view, read);
        Err("浏览器资料导入需要桌面 Host".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_an_import_for_the_current_cef_store_can_suppress_the_offer() {
        let legacy = serde_json::json!({"browser":"Chrome","profile":"Default","cookies":3000,"deviceBound":false,"importedAt":1,"synced":true,"version":3,"partition":"98f7388fda4ff680a58b9f0273fe5bed"});
        let mut report: ImportReport = serde_json::from_value(legacy).unwrap();
        assert!(!report_matches_store(&report, "ai.pi.gui"));
        report.version = 5;
        report.store_identity = Some("orbit".into());
        assert!(report_matches_store(&report, "orbit"));
        assert!(!report_matches_store(&report, "ai.pi.gui"));
        assert_ne!(
            source_partition("store", "orbit"),
            source_partition("store", "ai.pi.gui")
        );
    }

    #[test]
    fn source_profiles_have_stable_distinct_cookie_partitions() {
        assert_eq!(
            source_partition("Chrome", "Work"),
            source_partition("Chrome", "Work")
        );
        assert_ne!(
            source_partition("Chrome", "Work"),
            source_partition("Chrome", "Personal")
        );
        assert_ne!(
            source_partition("Chrome", "Work"),
            source_partition("Edge", "Work")
        );
        assert_eq!(source_partition("Chrome", "Work").len(), 32);
    }

    #[test]
    fn partitioned_rows_are_never_imported_as_first_party_cookies() {
        assert!(native_cookie(&serde_json::json!({"name":"sid","value":"v","domain":".test","partitionKey":{"topLevelSite":"https://other.test"}})).is_none());
    }
}

#[cfg(desktop)]
fn flush_cookie_store(view: &tauri::Webview) -> Result<(), String> {
    use cef::*;
    use std::sync::mpsc;
    use tauri_runtime_cef::WebviewCefExt;
    wrap_completion_callback! {
        struct CookiesFlushed { done: mpsc::SyncSender<Result<(), String>> }
        impl CompletionCallback {
            fn on_complete(&self) { let _ = self.done.try_send(Ok(())); }
        }
    }
    let (tx, rx) = mpsc::sync_channel(1);
    view.with_cef_webview(move |view| {
        let manager = view
            .browser()
            .host()
            .and_then(|host| host.request_context())
            .and_then(|context| context.cookie_manager(None));
        let Some(manager) = manager else {
            let _ = tx.try_send(Err("Chromium Cookie 存储不可用".into()));
            return;
        };
        let mut callback = CookiesFlushed::new(tx.clone());
        if manager.flush_store(Some(&mut callback)) == 0 {
            let _ = tx.try_send(Err("Chromium Cookie 持久化失败".into()));
        }
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?
}
