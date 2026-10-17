//! Reading a signed-in session out of a browser Orbit did not launch.
//!
//! The staged-profile copy in [`crate::browser`] works because it never
//! decrypts anything: cookies travel as ciphertext and the *same* browser —
//! same Keychain entry, same `Local State` — decrypts them later. That is also
//! its limit. Copied ciphertext from another Chromium browser fails to decrypt,
//! so listing Edge or Brave next to Chrome would be a button that reports
//! success and imports nothing.
//!
//! This module is the other half. Firefox writes cookie *values* in the clear,
//! so its session can be read directly; a Chromium-family browser's values are
//! AES-128-CBC over PBKDF2-SHA1 with a key derived from that browser's own Safe
//! Storage entry. Either way the result is handed back in the shape CDP
//! produces, so the existing WebView writer takes it unchanged — one import
//! path, two sources.
//!
//! What is deliberately *not* here: writing into another Chromium profile's
//! cookie database. A cookie that reaches the column's own store is one the
//! user can see and log out of; forging rows inside a foreign profile's SQLite
//! file is neither.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

// `openssl` (and the Safe Storage lookups below) are desktop-only in Cargo.toml:
// the mobile builds ship no server and no OpenSSL. Enumeration still compiles
// everywhere — the plaintext Firefox path needs neither — so the module only
// grows a boundary around the parts that decrypt.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use openssl::hash::{hash, MessageDigest};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use openssl::pkcs5::pbkdf2_hmac;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use openssl::symm::{decrypt, Cipher};

/// The `sqlite3` binary both import paths already depend on.
///
/// Resolved through `PATH` rather than pinned to `/usr/bin`: the staged-profile
/// copy that used to own this constant was macOS-shaped, and on a Linux box the
/// binary is just as often elsewhere.
pub(crate) const SQLITE3: &str = "sqlite3";

/// Chromium's fixed key derivation. The salt is not a secret; the iterations
/// are frozen by every existing database on disk.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CHROMIUM_SALT: &[u8] = b"saltysalt";
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CHROMIUM_ITERATIONS: usize = 1003;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CHROMIUM_KEY_LEN: usize = 16;
/// The IV is sixteen spaces, and has been since the format was introduced.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CHROMIUM_IV: [u8; 16] = [0x20; 16];
/// A modern Chromium database prefixes the plaintext with the SHA-256 of the
/// cookie's host, so a row moved to another host does not decrypt to a usable
/// value. It is not part of the value and must be stripped.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CHROMIUM_HOST_HASH_LEN: usize = 32;
/// Microseconds between 1601-01-01 (Chromium's epoch) and 1970-01-01.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CHROMIUM_EPOCH_OFFSET_SECONDS: f64 = 11_644_473_600.0;

/// Where a session can come from, and what reading it costs.
#[derive(Clone, Copy)]
pub enum Kind {
    /// A Chromium-family browser: ciphertext, decryptable with *its* Safe
    /// Storage entry.
    Chromium {
        /// The Keychain (or Secret Service) item this browser derives its key
        /// from. Each browser has its own — that is the whole reason a copy
        /// cannot be shared between them.
        service: &'static str,
    },
    /// Firefox stores cookie values in the clear in `cookies.sqlite`.
    Firefox,
}

/// One profile an import can come from.
#[derive(Clone)]
pub struct Source {
    pub browser: &'static str,
    pub profile: String,
    pub label: String,
    pub path: PathBuf,
    pub kind: Kind,
    /// The account the profile records, when it records one.
    pub account: Option<String>,
}

/// One Chromium-family browser worth looking for, and the root it lives in.
struct ChromiumRoot {
    browser: &'static str,
    /// Path under the platform's application-data directory.
    relative: &'static str,
    service: &'static str,
}

/// Browsers whose cookies can be decrypted and replayed.
///
/// Chrome itself is here even though the staged-copy path already handles it:
/// the copy is better (it also carries `Device Bound Sessions`), so the caller
/// prefers that and uses these entries for everything else.
const CHROMIUM_ROOTS: &[ChromiumRoot] = &[
    ChromiumRoot { browser: "Google Chrome", relative: "Google/Chrome", service: "Chrome Safe Storage" },
    ChromiumRoot { browser: "Google Chrome Beta", relative: "Google/Chrome Beta", service: "Chrome Safe Storage" },
    ChromiumRoot { browser: "Google Chrome Dev", relative: "Google/Chrome Dev", service: "Chrome Safe Storage" },
    ChromiumRoot { browser: "Google Chrome Canary", relative: "Google/Chrome Canary", service: "Chrome Safe Storage" },
    ChromiumRoot { browser: "Chromium", relative: "Chromium", service: "Chromium Safe Storage" },
    ChromiumRoot { browser: "Brave", relative: "BraveSoftware/Brave-Browser", service: "Brave Safe Storage" },
    ChromiumRoot { browser: "Microsoft Edge", relative: "Microsoft Edge", service: "Microsoft Edge Safe Storage" },
    ChromiumRoot { browser: "Microsoft Edge Beta", relative: "Microsoft Edge Beta", service: "Microsoft Edge Safe Storage" },
    ChromiumRoot { browser: "Vivaldi", relative: "Vivaldi", service: "Vivaldi Safe Storage" },
    ChromiumRoot { browser: "Arc", relative: "Arc/User Data", service: "Arc Safe Storage" },
];

/// The application-data directory each platform puts browser profiles under.
fn application_data(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support")
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Local"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
    }
}

/// Every Firefox profile directory that could hold a session.
///
/// `profiles.ini` is the only place that knows: it records the display name and
/// which profile is default, and a directory next to it may belong to a
/// disposable install (`Crash Reports`, `Pending Pings`). Same reasoning as the
/// Chromium `info_cache` read, one file format over.
fn firefox_roots(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "macos")]
    {
        roots.push(home.join("Library/Application Support/Firefox"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(roaming) = std::env::var_os("APPDATA") {
            roots.push(PathBuf::from(roaming).join("Mozilla/Firefox"));
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        roots.push(home.join(".mozilla/firefox"));
        // Snap and Flatpak installs keep their own copy; a user who has only
        // Firefox from a store would otherwise see an empty list.
        roots.push(home.join("snap/firefox/common/.mozilla/firefox"));
    }
    roots
}

/// One entry of a Firefox `profiles.ini`.
struct FirefoxProfile {
    name: String,
    path: String,
    relative: bool,
}

/// Parse `profiles.ini` into the profiles it declares.
///
/// Hand-written because the file is a two-level INI with no escaping rules, and
/// a full INI dependency would be more code than the parser.
fn parse_profiles_ini(text: &str) -> Vec<FirefoxProfile> {
    let mut profiles = Vec::new();
    let mut current: Option<FirefoxProfile> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            if let Some(profile) = current.take() {
                if !profile.path.is_empty() {
                    profiles.push(profile);
                }
            }
            // `[Install…]` sections name a default by path id, not a profile.
            current = Some(FirefoxProfile {
                name: String::new(),
                path: String::new(),
                relative: true,
            });
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let Some(profile) = current.as_mut() else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Name" => profile.name = value.to_string(),
            "Path" => profile.path = value.to_string(),
            "IsRelative" => profile.relative = value != "0",
            _ => {}
        }
    }
    if let Some(profile) = current.take() {
        if !profile.path.is_empty() {
            profiles.push(profile);
        }
    }
    profiles
}

/// Every importable profile on this machine: Chromium-family first (their
/// sessions travel intact more often), then Firefox.
///
/// A browser that is installed but has no cookie database is left out: offering
/// it would only produce an empty result.
pub fn sources(home: &Path) -> Vec<Source> {
    let mut sources = chromium_sources(&application_data(home));
    sources.extend(firefox_sources(home));
    sources
}

/// Chromium-family profiles, named by the only file that lists them:
/// `Local State` → `profile.info_cache`.
///
/// A directory next to them is not a profile (`System Profile`, `Guest Profile`,
/// `Crashpad`), and offering one would be a button that imports nothing.
fn chromium_sources(data: &Path) -> Vec<Source> {
    let mut sources = Vec::new();
    for root in CHROMIUM_ROOTS {
        let directory = data.join(root.relative);
        let Ok(text) = std::fs::read_to_string(directory.join("Local State")) else {
            continue;
        };
        let Ok(state) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(cache) = state.pointer("/profile/info_cache").and_then(Value::as_object) else {
            continue;
        };
        for (profile, info) in cache {
            let path = directory.join(profile);
            if !path.join("Cookies").is_file() {
                continue;
            }
            let field = |key: &str| {
                info.get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            sources.push(Source {
                browser: root.browser,
                profile: profile.clone(),
                label: field("name").unwrap_or_else(|| profile.clone()),
                path,
                kind: Kind::Chromium { service: root.service },
                account: field("user_name").or_else(|| field("gaia_name")),
            });
        }
    }
    sources
}

/// Firefox profiles, from `profiles.ini`.
fn firefox_sources(home: &Path) -> Vec<Source> {
    let mut sources = Vec::new();
    for root in firefox_roots(home) {
        let Ok(text) = std::fs::read_to_string(root.join("profiles.ini")) else {
            continue;
        };
        for profile in parse_profiles_ini(&text) {
            let path = if profile.relative {
                root.join(&profile.path)
            } else {
                PathBuf::from(&profile.path)
            };
            if !path.join("cookies.sqlite").is_file() {
                continue;
            }
            sources.push(Source {
                browser: "Firefox",
                profile: path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| profile.path.clone()),
                label: if profile.name.is_empty() {
                    profile.path.clone()
                } else {
                    profile.name.clone()
                },
                path,
                kind: Kind::Firefox,
                account: None,
            });
        }
    }
    sources
}

/// How many cookies a source holds, for the list the picker shows.
pub fn cookie_count(source: &Source) -> Option<u64> {
    let (database, table) = match source.kind {
        Kind::Chromium { .. } => (source.path.join("Cookies"), "cookies"),
        Kind::Firefox => (source.path.join("cookies.sqlite"), "moz_cookies"),
    };
    count_rows(&database, table)
}

fn count_rows(database: &Path, table: &str) -> Option<u64> {
    let output = Command::new(SQLITE3)
        .arg(format!("file:{}?mode=ro", database.display()))
        .arg(format!("select count(*) from {table};"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// One `select … json` against a read-only copy of a database.
///
/// The database is opened with `mode=ro` and, when the browser is running, its
/// journal can be mid-write; a failed read is reported rather than retried with
/// a writable handle, because importing is not worth risking the user's profile.
fn query_json(database: &Path, sql: &str) -> Result<Vec<Value>, String> {
    let output = Command::new(SQLITE3)
        .arg("-json")
        .arg(format!("file:{}?mode=ro", database.display()))
        .arg(sql)
        .output()
        .map_err(|error| format!("无法运行 sqlite3：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读取 {} 失败：{}",
            database.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<Value>>(text).map_err(|error| format!("无法解析 cookie 表：{error}"))
}

/// Chromium's `sameSite` column as CDP's vocabulary.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn chromium_same_site(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_i64) {
        Some(2) => Some("Strict"),
        Some(1) => Some("Lax"),
        Some(0) => Some("None"),
        _ => None,
    }
}

/// Firefox's `sameSite` column as CDP's vocabulary.
fn firefox_same_site(value: Option<&Value>) -> Option<&'static str> {
    match value.and_then(Value::as_i64) {
        Some(2) => Some("Lax"),
        Some(1) => None, // Firefox's 1 is "unset"; CDP has no value for it.
        Some(0) => Some("None"),
        Some(3) => Some("Strict"),
        _ => None,
    }
}

/// Read every cookie a source holds, in the shape CDP produces.
///
/// That shape is the point: `browser::webkit_cookie` already turns it into a
/// WebKit cookie, so an imported session lands in the column through exactly
/// the code path a same-browser import uses.
pub fn read_cookies(source: &Source) -> Result<Vec<Value>, String> {
    match source.kind {
        Kind::Firefox => firefox_cookies(&source.path.join("cookies.sqlite")),
        Kind::Chromium { service } => chromium_source_cookies(&source.path, service),
    }
}

/// A Chromium profile needs that browser's own Safe Storage key, which only a
/// desktop build can ask the OS for.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn chromium_source_cookies(profile: &Path, service: &str) -> Result<Vec<Value>, String> {
    let password = safe_storage_password(service)?;
    chromium_cookies(&profile.join("Cookies"), &password)
}

/// Mobile has neither a keychain lookup nor OpenSSL. Firefox's plaintext store
/// still works, which is why enumeration stays compiled there.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn chromium_source_cookies(_profile: &Path, _service: &str) -> Result<Vec<Value>, String> {
    Err("从 Chromium 浏览器导入登录只在桌面端可用".to_string())
}

/// Firefox's cookies, whose values are stored in the clear.
fn firefox_cookies(database: &Path) -> Result<Vec<Value>, String> {
    let rows = query_json(
        database,
        "select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite from moz_cookies;",
    )?;
    let cookies = rows
        .iter()
        .filter_map(|row| {
            let host = row.get("host").and_then(Value::as_str)?;
            let name = row.get("name").and_then(Value::as_str)?;
            if host.is_empty() || name.is_empty() {
                return None;
            }
            let mut cookie = json!({
                "name": name,
                "value": row.get("value").and_then(Value::as_str).unwrap_or(""),
                "domain": host,
                "path": row.get("path").and_then(Value::as_str).unwrap_or("/"),
                "secure": row.get("isSecure").and_then(Value::as_i64).unwrap_or(0) != 0,
                "httpOnly": row.get("isHttpOnly").and_then(Value::as_i64).unwrap_or(0) != 0,
                // Firefox stores expiry in seconds since the epoch, and 0 means a
                // session cookie; CDP spells that as -1.
                "expires": match row.get("expiry").and_then(Value::as_i64).unwrap_or(0) {
                    0 => -1.0,
                    seconds => seconds as f64,
                },
            });
            if let Some(same_site) = firefox_same_site(row.get("sameSite")) {
                cookie["sameSite"] = json!(same_site);
            }
            Some(cookie)
        })
        .collect();
    Ok(cookies)
}

/// Chromium-family cookies: plaintext rows are taken as-is, encrypted ones are
/// decrypted with the source browser's own key.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn chromium_cookies(database: &Path, password: &str) -> Result<Vec<Value>, String> {
    // Columns that have been there since the format existed, plus the optional
    // one handled below.
    const COLUMNS: &str = "host_key, name, value, hex(encrypted_value) as encrypted, path, \
         expires_utc, is_secure, is_httponly, samesite";
    let rows = match query_json(database, &format!("select {COLUMNS}, is_partitioned from cookies;")) {
        Ok(rows) => rows,
        // A database written before partitioned cookies existed has no such
        // column. Dropping the filter is not a loss: there is nothing to skip.
        Err(error) if error.contains("no such column") => {
            query_json(database, &format!("select {COLUMNS} from cookies;"))?
        }
        Err(error) => return Err(error),
    };
    let mut cookies = Vec::new();
    let mut undecryptable = 0usize;
    for row in &rows {
        let Some(host) = row.get("host_key").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = row.get("name").and_then(Value::as_str) else {
            continue;
        };
        if host.is_empty() || name.is_empty() {
            continue;
        }
        // Partitioned cookies belong to a top-level site and mean nothing
        // outside it, which a flat store cannot express. Skipping them is
        // honest; importing them as first-party would sign the user into the
        // wrong context.
        if row.get("is_partitioned").and_then(Value::as_i64).unwrap_or(0) != 0 {
            continue;
        }
        let plaintext = row.get("value").and_then(Value::as_str).unwrap_or("");
        let value = if !plaintext.is_empty() {
            plaintext.to_string()
        } else {
            let Some(hex) = row.get("encrypted").and_then(Value::as_str) else {
                continue;
            };
            let Some(blob) = decode_hex(hex) else {
                undecryptable += 1;
                continue;
            };
            if blob.is_empty() {
                continue;
            }
            match decrypt_value(&blob, password, host) {
                Ok(value) => value,
                Err(_) => {
                    undecryptable += 1;
                    continue;
                }
            }
        };
        let mut cookie = json!({
            "name": name,
            "value": value,
            "domain": host,
            "path": row.get("path").and_then(Value::as_str).unwrap_or("/"),
            "secure": row.get("is_secure").and_then(Value::as_i64).unwrap_or(0) != 0,
            "httpOnly": row.get("is_httponly").and_then(Value::as_i64).unwrap_or(0) != 0,
            "expires": chromium_expiry(row.get("expires_utc")),
        });
        if let Some(same_site) = chromium_same_site(row.get("samesite")) {
            cookie["sameSite"] = json!(same_site);
        }
        cookies.push(cookie);
    }
    // Every encrypted row failing is a wrong key, not a few stale rows: saying so
    // is what keeps "0 imported" from looking like an empty browser.
    if cookies.is_empty() && undecryptable > 0 {
        return Err(format!(
            "{undecryptable} 个 cookie 都用这个浏览器的密钥解不开；请在系统钥匙串提示里允许访问后再试"
        ));
    }
    Ok(cookies)
}

/// Chromium's `expires_utc` (microseconds since 1601) as CDP's seconds.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn chromium_expiry(value: Option<&Value>) -> f64 {
    let micros = value.and_then(Value::as_i64).unwrap_or(0);
    if micros <= 0 {
        return -1.0;
    }
    micros as f64 / 1_000_000.0 - CHROMIUM_EPOCH_OFFSET_SECONDS
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push((high * 16 + low) as u8);
    }
    Some(out)
}

/// The AES key a Chromium browser derives from its Safe Storage password.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn chromium_key(password: &str) -> [u8; CHROMIUM_KEY_LEN] {
    let mut key = [0u8; CHROMIUM_KEY_LEN];
    // SHA-1 and 1003 iterations are the format, not a choice: every database on
    // disk was written with them.
    pbkdf2_hmac(
        CHROMIUM_SALT,
        password.as_bytes(),
        CHROMIUM_ITERATIONS,
        MessageDigest::sha1(),
        &mut key,
    )
    .expect("pbkdf2 with a fixed digest cannot fail");
    key
}

/// Decrypt one `v10`/`v11` cookie value.
///
/// `host` is needed because a modern database prepends the SHA-256 of the
/// cookie's host to the plaintext; that prefix is stripped, and a value that
/// does not carry the right digest for its own host is treated as
/// undecryptable rather than imported under the wrong name.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn decrypt_value(blob: &[u8], password: &str, host: &str) -> Result<String, String> {
    let (version, ciphertext) = blob.split_at(blob.len().min(3));
    if ciphertext.is_empty() {
        return Err("加密值为空".to_string());
    }
    if version != b"v10" && version != b"v11" {
        // `v20` is Chrome's app-bound encryption (Windows): the key is sealed to
        // the browser binary itself, and no other process can legitimately
        // produce it. Guessing here would be worse than refusing.
        return Err(format!(
            "不认识的 cookie 加密格式「{}」；这个浏览器使用了应用绑定加密，暂不支持导入",
            String::from_utf8_lossy(version).trim()
        ));
    }
    let key = chromium_key(password);
    let mut plaintext = decrypt(Cipher::aes_128_cbc(), &key, Some(&CHROMIUM_IV), ciphertext)
        .map_err(|_| "解密失败：钥匙串里的密钥和这个浏览器的 cookie 不匹配".to_string())?;
    if plaintext.len() > CHROMIUM_HOST_HASH_LEN {
        let digest = hash(MessageDigest::sha256(), host.as_bytes())
            .map_err(|error| format!("无法计算 host 摘要：{error}"))?;
        if digest.as_ref() == &plaintext[..CHROMIUM_HOST_HASH_LEN] {
            plaintext.drain(..CHROMIUM_HOST_HASH_LEN);
        }
    }
    String::from_utf8(plaintext).map_err(|_| "解密结果不是文本".to_string())
}

/// The password a Chromium browser derives its key from.
///
/// macOS and Linux ask the system secret store, which is what makes the user's
/// "allow access" click the actual authorization: nothing here can read another
/// application's key without it.
#[cfg(target_os = "macos")]
pub fn safe_storage_password(service: &str) -> Result<String, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-w", "-s", service])
        .output()
        .map_err(|error| format!("无法运行 security：{error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "读不到钥匙串里的「{service}」：{}。请在钥匙串提示中点「允许」，或在「钥匙串访问」里把该条目的访问权限交给 Orbit",
            if detail.is_empty() { "项目不存在或已被拒绝".to_string() } else { detail }
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string())
}

/// Linux keeps the same secret in the Secret Service or KWallet.
#[cfg(all(unix, not(target_os = "macos"), not(any(target_os = "android", target_os = "ios"))))]
pub fn safe_storage_password(service: &str) -> Result<String, String> {
    let application = service.replace(" Safe Storage", "").to_lowercase();
    let output = Command::new("secret-tool")
        .args(["lookup", "application", &application])
        .output()
        .map_err(|error| format!("无法运行 secret-tool：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "读不到系统密钥库里的「{service}」；请确认 gnome-keyring 或 KWallet 已解锁"
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string())
}

/// Windows seals the key to the user account through DPAPI and, on current
/// builds, to the browser binary through app-bound encryption. Neither is
/// reachable from here, and a wrong key would only look like an empty import.
#[cfg(windows)]
pub fn safe_storage_password(_service: &str) -> Result<String, String> {
    Err("Windows 上的 Chromium 密钥由 DPAPI 和应用绑定加密保护，暂不支持从这些浏览器导入".to_string())
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;
    use openssl::symm::{encrypt, Cipher};

    const PASSWORD: &str = "orbit-test-password";

    fn seal(plaintext: &[u8], host: &str) -> Vec<u8> {
        let key = chromium_key(PASSWORD);
        let mut payload = Vec::new();
        // The modern layout: SHA-256 of the host, then the value.
        payload.extend_from_slice(hash(MessageDigest::sha256(), host.as_bytes()).unwrap().as_ref());
        payload.extend_from_slice(plaintext);
        let mut blob = b"v10".to_vec();
        blob.extend_from_slice(&encrypt(Cipher::aes_128_cbc(), &key, Some(&CHROMIUM_IV), &payload).unwrap());
        blob
    }

    #[test]
    fn a_modern_value_decrypts_and_drops_the_host_prefix() {
        let blob = seal(b"session-token", ".example.test");
        assert_eq!(decrypt_value(&blob, PASSWORD, ".example.test").unwrap(), "session-token");
    }

    #[test]
    fn an_old_value_without_the_host_prefix_still_decrypts() {
        let key = chromium_key(PASSWORD);
        let mut blob = b"v11".to_vec();
        blob.extend_from_slice(&encrypt(Cipher::aes_128_cbc(), &key, Some(&CHROMIUM_IV), b"legacy").unwrap());
        assert_eq!(decrypt_value(&blob, PASSWORD, ".example.test").unwrap(), "legacy");
    }

    #[test]
    fn the_wrong_password_is_an_error_not_garbage() {
        let blob = seal(b"session-token", ".example.test");
        assert!(decrypt_value(&blob, "the-other-browsers-key", ".example.test").is_err());
    }

    #[test]
    fn app_bound_encryption_is_named_instead_of_guessed() {
        let error = decrypt_value(b"v20\x01\x02\x03", PASSWORD, ".example.test").unwrap_err();
        assert!(error.contains("应用绑定"), "{error}");
    }

    #[test]
    fn profiles_ini_names_the_profiles_it_declares() {
        let profiles = parse_profiles_ini(
            "[Install4F1]\nDefault=abcd.default\nLocked=1\n\n[Profile1]\nName=Work\nIsRelative=1\nPath=Profiles/abcd.work\nDefault=1\n\n[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abcd.default\n",
        );
        // `[Install…]` has no Path, so it is not a profile.
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "Work");
        assert_eq!(profiles[0].path, "Profiles/abcd.work");
        assert!(profiles[0].relative);
        assert_eq!(profiles[1].path, "Profiles/abcd.default");
    }

    #[test]
    fn an_absolute_firefox_profile_path_is_not_joined_to_the_root() {
        let profiles = parse_profiles_ini("[Profile0]\nName=Elsewhere\nIsRelative=0\nPath=/tmp/elsewhere\n");
        assert!(!profiles[0].relative);
    }

    #[test]
    fn chromium_expiry_converts_to_unix_seconds() {
        // 2024-01-01T00:00:00Z in Chromium's microseconds.
        let micros = (1_704_067_200.0 + CHROMIUM_EPOCH_OFFSET_SECONDS) * 1_000_000.0;
        let seconds = chromium_expiry(Some(&json!(micros as i64)));
        assert!((seconds - 1_704_067_200.0).abs() < 1.0, "{seconds}");
        // A session cookie is negative, not the epoch.
        assert_eq!(chromium_expiry(Some(&json!(0))), -1.0);
    }

    #[test]
    fn hex_round_trips_and_rejects_odd_input() {
        assert_eq!(decode_hex("4f72626974").unwrap(), b"Orbit");
        assert!(decode_hex("abc").is_none());
        assert!(decode_hex("zz").is_none());
    }
}
