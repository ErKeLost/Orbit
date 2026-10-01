//! Pi RPC framing: official docs/rpc.md. Tauri streaming: Channel, not broadcast events.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, path::BaseDirectory, AppHandle, Manager, State};

struct Worker {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    cwd: PathBuf,
}

fn safe_pi_diagnostic(lines: &[String], home: &Path) -> Option<String> {
    let sensitive = [
        "authorization",
        "bearer ",
        "api_key",
        "apikey",
        "token=",
        "secret",
        "password",
    ];
    let useful = [
        "error",
        "cannot find",
        "not found",
        "failed",
        "missing",
        "syntax",
        "module",
        "enoent",
        "unsupported",
    ];
    let home = home.to_string_lossy();
    let mut selected = lines
        .iter()
        .rev()
        .filter_map(|line| {
            let lower = line.to_ascii_lowercase();
            if sensitive.iter().any(|needle| lower.contains(needle))
                || !useful.iter().any(|needle| lower.contains(needle))
            {
                return None;
            }
            let compact = line
                .replace(home.as_ref(), "~")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!compact.is_empty()).then(|| compact.chars().take(500).collect::<String>())
        })
        .take(2)
        .collect::<Vec<_>>();
    selected.reverse();
    (!selected.is_empty()).then(|| selected.join(" · "))
}
#[derive(Default)]
pub struct Bridge(Arc<Mutex<HashMap<String, Worker>>>);
fn remove_worker_if_current(
    workers: &Mutex<HashMap<String, Worker>>,
    project: &str,
    child: &Arc<Mutex<Child>>,
) -> bool {
    let Ok(mut workers) = workers.lock() else {
        return false;
    };
    let current = workers
        .get(project)
        .is_some_and(|worker| Arc::ptr_eq(&worker.child, child));
    if current {
        workers.remove(project);
    }
    current
}
impl Bridge {
    pub fn send(&self, project: &str, command: Value) -> Result<(), String> {
        if !command.is_object() || command.get("type").and_then(Value::as_str).is_none() {
            return Err("RPC command requires a type".into());
        }
        let mut slot = self.0.lock().map_err(|e| e.to_string())?;
        // The UI may restore an older project path spelling (for example a
        // trailing slash) while the worker keeps the canonical directory.
        // Resolve that alias before reporting a missing connection. Exact
        // connection ids still win so concurrent sessions remain isolated.
        let key = if slot.contains_key(project) {
            project.to_owned()
        } else {
            let canonical = PathBuf::from(project).canonicalize().ok();
            slot.iter()
                .find_map(|(id, worker)| {
                    canonical
                        .as_deref()
                        .filter(|path| *path == worker.cwd.as_path())
                        .map(|_| id.clone())
                })
                .ok_or("项目尚未连接")?
        };
        let worker = slot.get_mut(&key).ok_or("项目尚未连接")?;
        let mut bytes = serde_json::to_vec(&command).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        worker
            .stdin
            .write_all(&bytes)
            .and_then(|_| worker.stdin.flush())
            .map_err(|e| e.to_string())
    }

    pub fn connections(&self) -> Vec<Value> {
        let Ok(workers) = self.0.lock() else {
            return Vec::new();
        };
        let mut connections = workers
            .iter()
            .map(|(id, worker)| {
                json!({
                    "id": id,
                    "cwd": worker.cwd.to_string_lossy(),
                })
            })
            .collect::<Vec<_>>();
        connections.sort_unstable_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
        connections
    }

    pub fn stop_project(&self, project: &str) {
        if let Ok(mut workers) = self.0.lock() {
            if let Some(worker) = workers.remove(project) {
                drop(worker.stdin);
                if let Ok(mut child) = worker.child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
    pub fn stop(&self) {
        let projects = self
            .0
            .lock()
            .map(|workers| workers.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for project in projects {
            self.stop_project(&project);
        }
    }
}

#[cfg(unix)]
fn executable(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("无效的可执行文件名称".into());
    }
    let configured = std::env::var_os("SHELL").map(PathBuf::from);
    let shells = configured
        .into_iter()
        .chain(["/bin/zsh", "/bin/bash", "/bin/sh"].map(PathBuf::from));
    for shell in shells {
        if !shell.is_file() {
            continue;
        }
        for mode in ["-lc", "-lic"] {
            let Ok(found) = Command::new(&shell)
                .args([mode, &format!("command -v {name}")])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
            else {
                continue;
            };
            if let Some(path) = String::from_utf8_lossy(&found.stdout)
                .lines()
                .rev()
                .map(PathBuf::from)
                .find(|path| path.is_file())
            {
                return Ok(path);
            }
        }
    }
    Err(format!("找不到 {name}，请在终端安装后重试"))
}
#[cfg(windows)]
fn executable(name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("无效的可执行文件名称".into());
    }
    if let Ok(found) = Command::new("where.exe").arg(name).output() {
        if let Some(path) = String::from_utf8_lossy(&found.stdout)
            .lines()
            .map(PathBuf::from)
            .find(|path| path.is_file())
        {
            return Ok(path);
        }
    }
    let script = format!("Get-Command {name} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source");
    if let Ok(found) = Command::new("powershell.exe")
        .args(["-NoLogo", "-Command", &script])
        .output()
    {
        if let Some(path) = String::from_utf8_lossy(&found.stdout)
            .lines()
            .map(str::trim)
            .map(PathBuf::from)
            .find(|path| path.is_file())
        {
            return Ok(path);
        }
    }
    if name == "pi" {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            let candidate = PathBuf::from(app_data).join("npm/pi.cmd");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("找不到 {name}，请在终端安装后重试"))
}
fn pi_path() -> Result<PathBuf, String> {
    let launcher = executable("pi")?;
    #[cfg(windows)]
    if matches!(
        launcher
            .extension()
            .and_then(|extension| extension.to_str()),
        Some("cmd" | "ps1")
    ) {
        if let Some(parent) = launcher.parent() {
            let script =
                parent.join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
            if script.is_file() {
                return script.canonicalize().map_err(|error| error.to_string());
            }
        }
    }
    launcher.canonicalize().map_err(|error| error.to_string())
}

/// Resolve the Pi CLI that belongs to a project before consulting PATH.
///
/// Orbit is shipped with the Pi package as a regular project dependency. A
/// Finder-launched app may not inherit the user's shell PATH, and a globally
/// installed CLI can silently drift from the RPC types bundled with Orbit.
/// Walking ancestors also supports workspaces where the selected directory is
/// a package nested below the repository root.
fn bundled_pi_path(cwd: &std::path::Path) -> Option<PathBuf> {
    let mut current = Some(cwd);
    while let Some(directory) = current {
        for relative in [
            "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
            "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        ] {
            let candidate = directory.join(relative);
            if candidate.is_file() {
                return candidate.canonicalize().ok().or(Some(candidate));
            }
        }
        current = directory.parent();
    }
    None
}

fn app_pi_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resolve("resources/pi-runtime/cli.js", BaseDirectory::Resource)
        .ok()
        .filter(|path| path.is_file())
}

fn pi_path_for_project(
    app: Option<&AppHandle>,
    cwd: &std::path::Path,
) -> Result<(PathBuf, &'static str), String> {
    if let Some(path) = app.and_then(app_pi_path) {
        return Ok((path, "bundled"));
    }
    if let Some(path) = bundled_pi_path(cwd) {
        return Ok((path, "project"));
    }
    Ok((pi_path()?, "global"))
}

fn pi_version(node: &std::path::Path, pi: &std::path::Path) -> Option<String> {
    let output = Command::new(node).arg(pi).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}
fn node_version(node: &Path) -> Result<String, String> {
    const REQUIRED: (u32, u32) = (22, 19);
    let output = Command::new(node)
        .arg("--version")
        .output()
        .map_err(|error| format!("Orbit 内置 Node 无法启动：{error}"))?;
    let version = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_start_matches('v')
        .to_string();
    let mut parts = version
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    let detected = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    if !output.status.success() || detected < REQUIRED {
        return Err(format!(
            "Orbit 内置 Node 需要 >= {}.{}，当前为 {}",
            REQUIRED.0, REQUIRED.1, version
        ));
    }
    Ok(version)
}

fn bundled_node_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    app.path()
        .resolve(
            format!("resources/node-runtime/{name}"),
            BaseDirectory::Resource,
        )
        .map_err(|error| format!("无法定位 Orbit 内置 Node：{error}"))
        .and_then(|path| {
            path.is_file()
                .then_some(path)
                .ok_or_else(|| "Orbit 内置 Node 缺失，请重新安装应用".into())
        })
}

fn require_file(path: &Path, label: &str) -> Result<(), String> {
    path.is_file()
        .then_some(())
        .ok_or_else(|| format!("Orbit 运行资源缺失：{label}（{}）", path.display()))
}

fn require_dir(path: &Path, label: &str) -> Result<(), String> {
    path.is_dir()
        .then_some(())
        .ok_or_else(|| format!("Orbit 运行资源缺失：{label}（{}）", path.display()))
}

#[derive(Clone)]
struct RuntimePaths {
    home: PathBuf,
    agent_dir: PathBuf,
    sessions_dir: PathBuf,
    resources_dir: PathBuf,
    node: PathBuf,
    host_node: PathBuf,
    node_version: String,
    pi: PathBuf,
    pi_source: &'static str,
    pi_version: String,
    node_modules: PathBuf,
    extension: PathBuf,
}

impl RuntimePaths {
    fn resolve(app: &AppHandle, cwd: &Path) -> Result<Self, String> {
        let home = home_dir()?;
        let agent_dir = home.join(".pi/agent");
        let sessions_dir = agent_dir.join("sessions");
        let resources_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("无法定位 Orbit resources：{error}"))?
            .join("resources");
        let host_node = bundled_node_path(app)?;
        let node_version = node_version(&host_node)?;
        let node = orbit_process_node(host_node.clone(), app, &node_version)?;
        let (pi, pi_source) = pi_path_for_project(Some(app), cwd)?;
        if pi_source != "bundled" {
            return Err("Orbit 内置 Pi runtime 缺失，请重新安装应用".into());
        }
        let node_modules = resources_dir.join("node_modules");
        let extension = resources_dir.join("gui-extension.ts");
        for (path, label) in [
            (&pi, "Pi CLI"),
            (&resources_dir.join("pi-runtime/index.js"), "Pi SDK"),
            (&extension, "GUI extension"),
            (
                &resources_dir.join("context-payload.ts"),
                "Context payload helper",
            ),
            (&resources_dir.join("workspace.ts"), "Workspace extension"),
            (
                &resources_dir.join("subagents/index.ts"),
                "Subagent extension",
            ),
            (
                &resources_dir.join("computer-use/mode.ts"),
                "Computer use extension",
            ),
            (
                &node_modules.join("@typesafe-ai/sdk/package.json"),
                "TypeSafe SDK",
            ),
            (
                &node_modules.join("@mariozechner/clipboard/package.json"),
                "Clipboard runtime",
            ),
        ] {
            require_file(path, label)?;
        }
        #[cfg(target_os = "macos")]
        require_file(
            &resources_dir.join("computer-use/ax_control"),
            "Accessibility worker",
        )?;
        require_dir(&node_modules, "Node modules")?;
        let pi_version = pi_version(&node, &pi)
            .ok_or_else(|| "Orbit 内置 Pi runtime 无法启动，请重新安装应用".to_string())?;
        Ok(Self {
            home,
            agent_dir,
            sessions_dir,
            resources_dir: resources_dir.clone(),
            node,
            host_node,
            node_version,
            pi,
            pi_source,
            pi_version,
            node_modules,
            extension,
        })
    }

    fn diagnostics(&self, cwd: &Path) -> Value {
        json!({
            "home": &self.home,
            "agentDir": &self.agent_dir,
            "sessionsDir": &self.sessions_dir,
            "resourcesDir": &self.resources_dir,
            "node": &self.node,
            "hostNode": &self.host_node,
            "nodeVersion": &self.node_version,
            "pi": &self.pi,
            "piVersion": &self.pi_version,
            "piSource": self.pi_source,
            "nodeModules": &self.node_modules,
            "extension": &self.extension,
            "cwd": cwd,
        })
    }
}

fn orbit_process_node(node: PathBuf, app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        return macos_orbit_agent(&node, app, version);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(node)
    }
}

#[cfg(target_os = "macos")]
fn macos_orbit_agent(node: &Path, app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    static SETUP: Mutex<()> = Mutex::new(());
    if node.file_name().is_some_and(|name| name == "Orbit Agent") {
        return Ok(node.to_path_buf());
    }
    let _guard = SETUP
        .lock()
        .map_err(|_| "Orbit Agent 初始化锁已损坏".to_string())?;
    let bundle_name = if cfg!(debug_assertions) {
        "Orbit Agent Dev.app"
    } else {
        "Orbit Agent.app"
    };
    let app = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位 Orbit 应用目录：{error}"))?
        .join(format!("runtime/{bundle_name}"));
    let executable = app.join("Contents/MacOS/Orbit Agent");
    let plist = app.join("Contents/Info.plist");
    let marker = app.join("Contents/Resources/orbit-node-version");
    let source = fs::canonicalize(node).unwrap_or_else(|_| node.to_path_buf());
    let fingerprint = format!(
        "{version}\n{}\n",
        fs::metadata(&source)
            .map_err(|error| error.to_string())?
            .len()
    );
    if executable.is_file()
        && plist.is_file()
        && fs::read_to_string(&marker).ok().as_deref() == Some(&fingerprint)
    {
        return Ok(executable);
    }
    let parent = app.parent().ok_or("Orbit Agent runtime 路径无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 Orbit Agent 目录：{error}"))?;
    let temporary = parent.join(format!(
        ".orbit-agent-{}-{}",
        std::process::id(),
        thread::current().name().unwrap_or("runtime")
    ));
    if temporary.exists() {
        fs::remove_dir_all(&temporary)
            .map_err(|error| format!("无法清理 Orbit Agent 临时目录：{error}"))?;
    }
    let temporary_macos = temporary.join("Contents/MacOS");
    let temporary_resources = temporary.join("Contents/Resources");
    fs::create_dir_all(&temporary_macos)
        .map_err(|error| format!("无法创建 Orbit Agent 运行时：{error}"))?;
    fs::create_dir_all(&temporary_resources)
        .map_err(|error| format!("无法创建 Orbit Agent 资源目录：{error}"))?;
    let temporary_executable = temporary_macos.join("Orbit Agent");
    fs::copy(&source, &temporary_executable)
        .map_err(|error| format!("无法安装 Orbit Agent 运行时：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary_executable, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("无法设置 Orbit Agent 权限：{error}"))?;
    }
    fs::write(temporary.join("Contents/Info.plist"), r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Orbit</string>
  <key>CFBundleExecutable</key>
  <string>Orbit Agent</string>
  <key>CFBundleIdentifier</key>
  <string>ai.pi.gui.agent</string>
  <key>CFBundleName</key>
  <string>Orbit</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
"#).map_err(|error| format!("无法写入 Orbit Agent 信息：{error}"))?;
    fs::write(temporary_resources.join("orbit-node-version"), &fingerprint)
        .map_err(|error| format!("无法写入 Orbit Agent 版本：{error}"))?;
    let status = Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-", "--identifier", "ai.pi.gui.agent"])
        .arg(&temporary)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("无法签名 Orbit Agent：{error}"))?;
    if !status.success() {
        let _ = fs::remove_dir_all(&temporary);
        return Err("无法签名 Orbit Agent".into());
    }
    if app.exists() {
        fs::remove_dir_all(&app).map_err(|error| format!("无法更新 Orbit Agent：{error}"))?;
    }
    fs::rename(&temporary, &app).map_err(|error| format!("无法启用 Orbit Agent：{error}"))?;
    Ok(executable)
}

fn apply_orbit_runtime_env(
    command: &mut Command,
    node: &Path,
    pi: &Path,
    pi_source: &str,
    pi_version: &str,
    node_modules: &Path,
) {
    command
        .env("ORBIT_HOST_BUNDLE_ID", "ai.pi.gui")
        .env("ORBIT_AGENT_BUNDLE_ID", "ai.pi.gui.agent")
        .env("ORBIT_PI_CLI_PATH", pi)
        .env("ORBIT_PI_NODE_PATH", node)
        .env("ORBIT_PI_SOURCE", pi_source)
        .env("JITI_FS_CACHE", "false");
    command.env("ORBIT_PI_VERSION", pi_version);
    if let Ok(key_path) = typesafe_key_path() {
        command.env("ORBIT_TYPESAFE_KEY_PATH", key_path);
    }
    // Extension imports are resolved only from Orbit's pinned resources.
    // User NODE_PATH entries can contain incompatible copies of these packages.
    command.env("NODE_PATH", node_modules);
}
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "找不到用户目录".into())
}
fn typesafe_key_path() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("typesafe-api-key"))
}
fn typesafe_api_key() -> Option<String> {
    if let Ok(key) = std::env::var("TYPESAFE_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            return Some(key);
        }
    }
    let mut paths = Vec::new();
    if let Ok(path) = typesafe_key_path() {
        paths.push(path);
    }
    if let Ok(home) = home_dir() {
        paths.push(home.join(".typesafe-api-key"));
        paths.push(home.join(".pi/typesafe-api-key"));
    }
    for path in paths {
        if let Ok(text) = fs::read_to_string(path) {
            let key = text.trim().to_string();
            if !key.is_empty() {
                return Some(key);
            }
        }
    }
    None
}
fn write_secret_file(path: &std::path::Path, value: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    fs::write(path, value).map_err(|e| format!("写入密钥失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}
#[tauri::command]
pub fn computer_use_key_status() -> Result<Value, String> {
    Ok(json!({ "hasKey": typesafe_api_key().is_some() }))
}

/// Absolute paths of files currently on the clipboard (Finder ⌘C → composer ⌘V).
/// Each platform reads its native pasteboard; an empty clipboard yields [].
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    let (program, args) = if cfg!(target_os = "macos") {
        let script = "on run\n  set out to \"\"\n  try\n    set theItems to the clipboard as «class furl»\n    if class of theItems is list then\n      repeat with p in theItems\n        set out to out & POSIX path of p & linefeed\n      end repeat\n    else\n      set out to POSIX path of theItems & linefeed\n    end if\n  end try\n  return out\nend run";
        (
            "/usr/bin/osascript",
            vec!["-e".to_string(), script.to_string()],
        )
    } else if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }".to_string(),
            ],
        )
    } else {
        (
            "xclip",
            vec![
                "-o".to_string(),
                "-selection".to_string(),
                "clipboard".to_string(),
                "-t".to_string(),
                "text/uri-list".to_string(),
            ],
        )
    };
    let Ok(output) = Command::new(program).args(args).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let path = line.strip_prefix("file://").unwrap_or(line);
            let path = percent_decode(path);
            let trimmed = path.trim_start_matches("/ cyclical"); // no-op guard for odd xclip output
            if trimmed.starts_with('/') || trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|value| u8::from_str_radix(value, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// Read a dragged file as a base64 image attachment. Returns an error for
/// non-image paths so the caller can attach them by path instead.
#[tauri::command]
pub fn read_file_attachment(path: String) -> Result<Value, String> {
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let extension = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let Some(mime) = mime_for_extension(&extension) else {
        return Err(format!("not an image: {path}"));
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path))?;
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(json!({ "name": name, "data": data, "mimeType": mime }))
}
#[tauri::command]
pub fn save_computer_use_key(api_key: Option<String>) -> Result<Value, String> {
    let path = typesafe_key_path()?;
    match api_key.map(|value| value.trim().to_string()) {
        Some(key) if !key.is_empty() => write_secret_file(&path, &key)?,
        _ => {
            if path.exists() {
                fs::remove_file(&path).map_err(|e| format!("删除密钥失败：{e}"))?;
            }
        }
    }
    Ok(json!({ "hasKey": typesafe_api_key().is_some() }))
}
fn project(cwd: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|e| format!("工作目录不可用：{e}"))?;
    if !path.is_dir() {
        return Err("请选择文件夹".into());
    }
    Ok(path)
}

fn remove_jsonl_files(root: &Path) -> Result<usize, String> {
    if !root.exists() {
        return Ok(0);
    }
    let mut removed = 0;
    for entry in fs::read_dir(root).map_err(|error| format!("读取 Pi 会话目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取 Pi 会话目录失败：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 Pi 会话条目失败：{error}"))?;
        if file_type.is_dir() {
            removed += remove_jsonl_files(&path)?;
        } else if file_type.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            fs::remove_file(&path).map_err(|error| format!("删除 Pi 会话失败：{error}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn collect_project_files(
    root: &std::path::Path,
    current: &std::path::Path,
    output: &mut Vec<String>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".env.example"
            || matches!(name.as_str(), "node_modules" | "target" | "dist" | "build")
        {
            continue;
        }
        if path.is_dir() {
            collect_project_files(root, &path, output);
        } else if path.is_file() {
            if let Ok(relative) = path.strip_prefix(root) {
                output.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
        if output.len() >= 10000 {
            return;
        }
    }
}

fn valid_provider_id(provider: &str) -> bool {
    !provider.is_empty()
        && provider
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn read_json_file(path: PathBuf, label: &str) -> Result<Value, String> {
    serde_json::from_str(&fs::read_to_string(path).map_err(|_| format!("{label} 不可读"))?)
        .map_err(|_| format!("{label} 不是有效 JSON"))
}

fn complete_model_cost(model: &mut Value) -> usize {
    let Some(cost) = model.get_mut("cost").and_then(Value::as_object_mut) else {
        return 0;
    };
    let mut changed = 0;
    for field in ["input", "output", "cacheRead", "cacheWrite"] {
        if !cost.contains_key(field) {
            cost.insert(field.into(), Value::from(0.0));
            changed += 1;
        }
    }
    if let Some(tiers) = cost.get_mut("tiers").and_then(Value::as_array_mut) {
        for tier in tiers {
            let Some(tier) = tier.as_object_mut() else {
                continue;
            };
            for field in ["input", "output", "cacheRead", "cacheWrite"] {
                if !tier.contains_key(field) {
                    tier.insert(field.into(), Value::from(0.0));
                    changed += 1;
                }
            }
        }
    }
    changed
}

fn repair_custom_model_costs(dir: &std::path::Path) -> Result<usize, String> {
    let path = dir.join("models.json");
    if !path.exists() {
        return Ok(0);
    }
    let mut config = read_json_file(path.clone(), "Pi models.json")?;
    let mut changed = 0;
    if let Some(providers) = config.get_mut("providers").and_then(Value::as_object_mut) {
        for provider in providers.values_mut() {
            if let Some(models) = provider.get_mut("models").and_then(Value::as_array_mut) {
                for model in models {
                    changed += complete_model_cost(model);
                }
            }
        }
    }
    if changed > 0 {
        let backup = dir.join("models.json.pi-gui.bak");
        if !backup.exists() {
            fs::copy(&path, backup).map_err(|e| format!("备份 Pi models.json 失败：{e}"))?;
        }
        fs::write(
            &path,
            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    }
    Ok(changed)
}

async fn fetch_model_catalog(
    base_url: &str,
    models_url: Option<&str>,
    api_key: &str,
    api: &str,
    auth_header: bool,
) -> Result<Value, String> {
    let base_url = base_url.trim_end_matches('/');
    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("Base URL 必须是 HTTP(S) 地址".into());
    }
    let endpoint = models_url
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_string())
        .unwrap_or_else(|| format!("{base_url}/models"));
    if !(endpoint.starts_with("https://") || endpoint.starts_with("http://")) {
        return Err("模型列表接口必须是 HTTP(S) 地址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let request = client.get(endpoint);
    let request = if api_key.is_empty() || !auth_header {
        request
    } else if api == "anthropic-messages" {
        request
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
    } else {
        request.bearer_auth(api_key)
    };
    let response = request
        .send()
        .await
        .map_err(|e| format!("模型目录请求失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("模型目录返回错误：{e}"))?;
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("模型目录响应不是有效 JSON：{e}"))
}

// ==================== 模型元数据归一化 ====================
// 单一管道：models.dev 目录是基础事实层，provider 接口返回的字段直接覆盖其上。
// 各家目录格式的字段别名（OpenRouter、Vercel Gateway、OpenAI/Anthropic 官方、各类中转站）
// 只在 normalize_provider_model 一处处理；价格统一为美元/百万 tokens。

#[derive(Default)]
struct ModelMeta {
    name: Option<String>,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
    input_modalities: Option<Vec<String>>,
    output_modalities: Option<Vec<String>>,
    reasoning: Option<bool>,
    thinking_levels: Option<Vec<(String, String)>>,
    pricing: Option<serde_json::Map<String, Value>>,
}

fn meta_strings(value: Option<&Value>) -> Option<Vec<String>> {
    let items = value?.as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    })?;
    (!items.is_empty()).then_some(items)
}

/// 十进制字面量精确移位："0.0000001" ×1e6 → 0.1（f64 乘法会产生 0.09999999999999999）。
/// 返回 None 表示不是纯十进制字面量，调用方回退到 parse + 乘法。
fn decimal_scaled(text: &str, places: usize) -> Option<f64> {
    let text = text.trim();
    let (negative, text) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let (int_part, frac_part) = match text.split_once('.') {
        Some((int_part, frac_part)) => (int_part, frac_part),
        None => (text, ""),
    };
    if !int_part
        .bytes()
        .chain(frac_part.bytes())
        .all(|byte| byte.is_ascii_digit())
        || int_part.is_empty() && frac_part.is_empty()
    {
        return None;
    }
    let mut digits = String::with_capacity(int_part.len() + frac_part.len() + places);
    digits.push_str(int_part);
    digits.push_str(frac_part);
    let point = int_part.len() + places;
    while digits.len() < point {
        digits.push('0');
    }
    let value = if point >= digits.len() {
        digits.parse::<f64>().ok()?
    } else {
        let (head, tail) = digits.split_at(point);
        format!("{head}.{tail}").parse::<f64>().ok()?
    };
    Some(if negative { -value } else { value })
}

/// pricing/cost 对象 → 统一「美元/百万 tokens」费率。
/// 字符串价格是 per-token 十进制字面量（OpenRouter），直接移位 ×1e6；
/// 数字价格已是 per-M（models.dev）或按 scale 放大。
fn meta_pricing(
    pricing: &Value,
    rates: &[(&str, &str)],
    scale: f64,
) -> Option<serde_json::Map<String, Value>> {
    let object = pricing.as_object()?;
    let mut cost = serde_json::Map::from_iter(
        ["input", "output", "cacheRead", "cacheWrite"]
            .map(|field| (field.to_string(), Value::from(0.0))),
    );
    let mut known = false;
    for (source, target) in rates {
        let Some(raw) = object.get(*source) else {
            continue;
        };
        let value = match raw {
            Value::Number(number) => number.as_f64().map(|value| value * scale),
            Value::String(text) => decimal_scaled(text, 6)
                .or_else(|| text.parse::<f64>().ok().map(|value| value * scale)),
            _ => None,
        };
        if let Some(value) = value {
            cost.insert((*target).to_string(), Value::from(value));
            known = true;
        }
    }
    known.then_some(cost)
}

/// 目录条目里的模态字段：OpenRouter 用 architecture.{dir}_modalities，
/// 部分目录用顶层 {dir}_modalities 或 modalities.{dir}。
fn meta_modalities(item: &Value, direction: &str) -> Option<Vec<String>> {
    meta_strings(
        item.get("architecture")
            .and_then(|value| value.get(format!("{direction}_modalities"))),
    )
    .or_else(|| meta_strings(item.get(format!("{direction}_modalities"))))
    .or_else(|| {
        meta_strings(
            item.get("modalities")
                .and_then(|value| value.get(direction)),
        )
    })
}

/// capability_tags（部分中转站只提供 tags）推导模态。
fn meta_modalities_from_tags(item: &Value, direction: &str) -> Option<Vec<String>> {
    let tags = meta_strings(item.get("capability_tags"))?;
    let mut modalities = Vec::new();
    if tags
        .iter()
        .any(|tag| matches!(tag.as_str(), "chat" | "text" | "completion"))
    {
        modalities.push("text".to_string());
    }
    let image = if direction == "input" {
        tags.iter()
            .any(|tag| matches!(tag.as_str(), "vision" | "image" | "image_input"))
    } else {
        tags.iter().any(|tag| tag == "image_generation")
    };
    if image {
        modalities.push("image".to_string());
    }
    (!modalities.is_empty()).then_some(modalities)
}

/// provider 目录条目 → 规范元数据。
fn normalize_provider_model(item: &Value) -> ModelMeta {
    let mut meta = ModelMeta {
        name: item
            .get("name")
            .or_else(|| item.get("display_name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        context_window: item
            .get("context_length")
            .or_else(|| item.get("context_window"))
            .and_then(Value::as_u64),
        max_output_tokens: item
            .get("max_output_tokens")
            .or_else(|| item.get("max_tokens"))
            .and_then(Value::as_u64),
        input_modalities: meta_modalities(item, "input")
            .or_else(|| meta_modalities_from_tags(item, "input")),
        output_modalities: meta_modalities(item, "output")
            .or_else(|| meta_modalities_from_tags(item, "output")),
        reasoning: item.get("reasoning").and_then(Value::as_bool),
        thinking_levels: None,
        pricing: item.get("pricing").and_then(|pricing| {
            meta_pricing(
                pricing,
                &[
                    ("prompt", "input"),
                    ("completion", "output"),
                    ("input_cache_read", "cacheRead"),
                    ("input_cache_write", "cacheWrite"),
                ],
                1_000_000.0,
            )
        }),
    };
    if meta.reasoning.is_none() {
        if let Some(levels) = meta_strings(
            item.get("reasoning")
                .and_then(|value| value.get("supported_efforts")),
        ) {
            meta.reasoning = Some(true);
            meta.thinking_levels = Some(
                levels
                    .into_iter()
                    .map(|level| (level.clone(), level))
                    .collect(),
            );
        }
    }
    meta
}

/// models.dev 条目 → 规范元数据（cost 本身就是美元/百万 tokens）。
fn normalize_modelsdev_model(entry: &Value) -> ModelMeta {
    ModelMeta {
        name: entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        context_window: entry
            .get("limit")
            .and_then(|limit| limit.get("context"))
            .and_then(Value::as_u64),
        max_output_tokens: entry
            .get("limit")
            .and_then(|limit| limit.get("output"))
            .and_then(Value::as_u64),
        input_modalities: meta_strings(
            entry.get("modalities").and_then(|value| value.get("input")),
        ),
        output_modalities: meta_strings(
            entry
                .get("modalities")
                .and_then(|value| value.get("output")),
        ),
        reasoning: entry.get("reasoning").and_then(Value::as_bool),
        thinking_levels: None,
        pricing: entry.get("cost").and_then(|cost| {
            meta_pricing(
                cost,
                &[
                    ("input", "input"),
                    ("output", "output"),
                    ("cache_read", "cacheRead"),
                    ("cache_write", "cacheWrite"),
                ],
                1.0,
            )
        }),
    }
}

/// 用 models.dev 的数据填充接口未返回的字段。
fn merge_meta(base: &mut ModelMeta, fill: ModelMeta) {
    base.name = base.name.take().or(fill.name);
    base.context_window = base.context_window.take().or(fill.context_window);
    base.max_output_tokens = base.max_output_tokens.take().or(fill.max_output_tokens);
    base.input_modalities = base.input_modalities.take().or(fill.input_modalities);
    base.output_modalities = base.output_modalities.take().or(fill.output_modalities);
    base.reasoning = base.reasoning.take().or(fill.reasoning);
    base.thinking_levels = base.thinking_levels.take().or(fill.thinking_levels);
    base.pricing = base.pricing.take().or(fill.pricing);
}

impl ModelMeta {
    fn to_json(&self) -> Value {
        let mut value = serde_json::Map::new();
        if let Some(name) = &self.name {
            value.insert("name".into(), Value::from(name.as_str()));
        }
        if let Some(context_window) = self.context_window {
            value.insert("context_window".into(), Value::from(context_window));
        }
        if let Some(max_output_tokens) = self.max_output_tokens {
            value.insert("max_output_tokens".into(), Value::from(max_output_tokens));
        }
        if let Some(inputs) = &self.input_modalities {
            value.insert("input_modalities".into(), json!(inputs));
        }
        if let Some(outputs) = &self.output_modalities {
            value.insert("output_modalities".into(), json!(outputs));
        }
        if let Some(reasoning) = self.reasoning {
            value.insert("reasoning".into(), Value::from(reasoning));
        }
        if let Some(levels) = &self.thinking_levels {
            value.insert(
                "thinking_levels".into(),
                Value::Object(
                    levels
                        .iter()
                        .map(|(key, level)| (key.clone(), Value::from(level.as_str())))
                        .collect(),
                ),
            );
        }
        if let Some(pricing) = &self.pricing {
            value.insert("pricing".into(), Value::Object(pricing.clone()));
        }
        Value::Object(value)
    }
}

/// models.dev 目录的进程内缓存（TTL 1 小时）。拉取失败时元数据留空，不阻塞模型列表。
static MODELSDEV_CACHE: Mutex<Option<(std::time::Instant, Value)>> = Mutex::new(None);
const MODELSDEV_TTL: Duration = Duration::from_secs(60 * 60);

async fn modelsdev_catalog() -> Option<Value> {
    if let Some((at, catalog)) = MODELSDEV_CACHE.lock().ok().and_then(|guard| guard.clone()) {
        if at.elapsed() < MODELSDEV_TTL {
            return Some(catalog);
        }
    }
    let catalog = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .ok()?
        .get("https://models.dev/api.json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    if catalog.as_object().is_some() {
        if let Ok(mut guard) = MODELSDEV_CACHE.lock() {
            *guard = Some((std::time::Instant::now(), catalog.clone()));
        }
        return Some(catalog);
    }
    None
}

fn modelsdev_model<'a>(models: &'a Value, id: &str) -> Option<&'a Value> {
    if let Some(entry) = models.get(id) {
        return Some(entry);
    }
    // OpenRouter 等目录用 "z-ai/glm-4.6" 这类带前缀的 id，models.dev 按 "glm-4.6" 索引
    let short = id.rsplit('/').next()?;
    (short != id).then(|| models.get(short)).flatten()
}

fn normalized_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn normalized_endpoint(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

/// 只根据运行时配置和目录自身的数据定位模型，不维护厂商或域名映射表。
fn modelsdev_lookup<'a>(
    catalog: &'a Value,
    provider: &str,
    base_url: &str,
    id: &str,
) -> Option<&'a Value> {
    let providers = catalog.as_object()?;
    let endpoint = normalized_endpoint(base_url);
    let provider_id = normalized_identifier(provider);
    let namespace = id
        .split_once('/')
        .map(|(prefix, _)| normalized_identifier(prefix));
    let matches_identity = |key: &str, item: &Value, expected: &str| {
        normalized_identifier(key) == expected
            || item
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|value| normalized_identifier(value) == expected)
    };
    let model = |item: &'a Value| {
        item.get("models")
            .and_then(|models| modelsdev_model(models, id))
    };

    providers
        .iter()
        .find_map(|(_, item)| {
            item.get("api")
                .and_then(Value::as_str)
                .filter(|api| normalized_endpoint(api) == endpoint)
                .and_then(|_| model(item))
        })
        .or_else(|| {
            providers.iter().find_map(|(key, item)| {
                matches_identity(key, item, &provider_id)
                    .then(|| model(item))
                    .flatten()
            })
        })
        .or_else(|| {
            namespace.as_deref().and_then(|namespace| {
                providers.iter().find_map(|(key, item)| {
                    matches_identity(key, item, namespace)
                        .then(|| model(item))
                        .flatten()
                })
            })
        })
}

/// 模型目录归一化管道：provider 接口字段优先，缺失字段由 models.dev 补齐，
/// 输出统一规范条目（id + 元数据 + raw 原始条目）。
async fn normalized_model_catalog(
    provider: &str,
    base_url: &str,
    models_url: Option<&str>,
    api_key: &str,
    api: &str,
    auth_header: bool,
) -> Result<Value, String> {
    let raw = fetch_model_catalog(base_url, models_url, api_key, api, auth_header).await?;
    let dev = modelsdev_catalog().await;
    let Some(items) = raw.get("data").and_then(Value::as_array) else {
        return Ok(raw);
    };
    let mut data = Vec::with_capacity(items.len());
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let mut meta = normalize_provider_model(item);
        if let Some(entry) = dev
            .as_ref()
            .and_then(|dev| modelsdev_lookup(dev, provider, base_url, id))
        {
            merge_meta(&mut meta, normalize_modelsdev_model(entry));
        }
        let mut entry = meta.to_json();
        entry["id"] = Value::from(id);
        entry["raw"] = item.clone();
        data.push(entry);
    }
    Ok(json!({"object": "list", "data": data}))
}

/// 规范条目 → Pi models.json 模型条目（sync 用）。Pi 会据此驱动上下文窗口与 token 预算。
fn pi_model_from_meta(entry: &Value) -> Option<Value> {
    let id = entry.get("id").and_then(Value::as_str)?.to_string();
    let mut model = json!({"id": id});
    if let Some(name) = entry.get("name").and_then(Value::as_str) {
        model["name"] = Value::from(name);
    }
    let input = entry
        .get("input_modalities")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| *value == "text" || *value == "image")
                .map(Value::from)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !input.is_empty() {
        model["input"] = Value::Array(input);
    }
    if let Some(context) = entry
        .get("context_window")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
    {
        model["contextWindow"] = Value::from(context);
    }
    if let Some(max_tokens) = entry
        .get("max_output_tokens")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
    {
        model["maxTokens"] = Value::from(max_tokens);
    }
    if let Some(reasoning) = entry.get("reasoning").and_then(Value::as_bool) {
        model["reasoning"] = Value::from(reasoning);
    }
    if let Some(levels) = entry
        .get("thinking_levels")
        .and_then(Value::as_object)
        .filter(|levels| !levels.is_empty())
    {
        model["reasoning"] = Value::from(true);
        model["thinkingLevelMap"] = Value::Object(levels.clone());
    }
    if let Some(pricing) = entry.get("pricing").and_then(Value::as_object) {
        let mut cost = serde_json::Map::from_iter(
            ["input", "output", "cacheRead", "cacheWrite"]
                .map(|field| (field.to_string(), Value::from(0.0))),
        );
        for (key, value) in pricing {
            cost.insert(key.clone(), value.clone());
        }
        model["cost"] = Value::Object(cost);
    }
    Some(model)
}

pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".pi/agent"))
}

pub(crate) fn sessions_dir() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("sessions"))
}

fn provider_store_path(dir: &std::path::Path) -> PathBuf {
    dir.join("pi-gui-providers.json")
}

fn settings_path(dir: &std::path::Path) -> PathBuf {
    dir.join("settings.json")
}

fn project_trust_mode(value: &Value) -> &'static str {
    match value.get("defaultProjectTrust").and_then(Value::as_str) {
        Some("always") => "always",
        Some("never") => "never",
        _ => "ask",
    }
}

#[tauri::command]
pub fn get_project_trust_mode() -> Result<String, String> {
    let dir = agent_dir()?;
    let path = settings_path(&dir);
    if !path.exists() {
        return Ok("ask".into());
    }
    Ok(project_trust_mode(&read_json_file(path, "Pi settings.json")?).into())
}

#[tauri::command]
pub fn set_project_trust_mode(mode: String) -> Result<String, String> {
    if !matches!(mode.as_str(), "ask" | "always" | "never") {
        return Err("无效的项目权限模式".into());
    }
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 Pi 配置目录失败：{e}"))?;
    let path = settings_path(&dir);
    let mut settings = if path.exists() {
        read_json_file(path.clone(), "Pi settings.json")?
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    settings["defaultProjectTrust"] = Value::from(mode.clone());
    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi settings.json 失败：{e}"))?;
    Ok(mode)
}

fn load_provider_store(dir: &std::path::Path) -> Result<Value, String> {
    let path = provider_store_path(dir);
    if path.exists() {
        read_json_file(path, "Orbit Provider 配置")
    } else {
        Ok(json!({"providers": {}}))
    }
}

fn write_provider_store(dir: &std::path::Path, store: &Value) -> Result<(), String> {
    let path = provider_store_path(dir);
    fs::write(
        &path,
        serde_json::to_string_pretty(store).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Provider 配置失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 Provider 配置权限失败：{e}"))?;
    }
    Ok(())
}

fn stored_api_key(auth: &Value, provider: &str) -> Option<String> {
    auth.get(provider)
        .and_then(|item| item.get("key"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn supported_api(api: &str) -> bool {
    matches!(
        api,
        "openai-completions"
            | "openai-responses"
            | "anthropic-messages"
            | "google-generative-ai"
            | "azure-openai-responses"
            | "mistral-conversations"
    )
}

#[tauri::command]
pub async fn discover(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = home_dir()?;
        let runtime = RuntimePaths::resolve(&app, &home)?;
        Ok(runtime.diagnostics(&home))
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Query the OpenAI-compatible provider catalog configured in Pi's own files.
/// The API key is read and used only inside this process and is never returned.
#[tauri::command]
pub async fn list_provider_models(provider: String) -> Result<Value, String> {
    let dir = agent_dir()?;
    let models = read_json_file(dir.join("models.json"), "Pi models.json")?;
    let provider_config = models
        .get("providers")
        .and_then(|items| items.get(&provider))
        .ok_or_else(|| format!("Pi 未配置 provider：{provider}"))?;
    let base_url = provider_config
        .get("baseUrl")
        .and_then(Value::as_str)
        .ok_or("该 provider 没有 baseUrl")?;
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let api = provider_config
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    let auth_header = provider_config
        .get("authHeader")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let models_url = provider_config.get("modelsUrl").and_then(Value::as_str);
    normalized_model_catalog(
        &provider,
        base_url,
        models_url,
        &stored_api_key(&auth, &provider).unwrap_or_default(),
        api,
        auth_header,
    )
    .await
}

#[tauri::command]
pub async fn list_provider_profiles() -> Result<Value, String> {
    let dir = agent_dir()?;
    let models = read_json_file(dir.join("models.json"), "Pi models.json")
        .unwrap_or_else(|_| json!({"providers": {}}));
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let settings =
        read_json_file(dir.join("settings.json"), "Pi settings.json").unwrap_or_else(|_| json!({}));
    let default_provider = settings.get("defaultProvider").and_then(Value::as_str);
    let default_model = settings.get("defaultModel").and_then(Value::as_str);
    let store = load_provider_store(&dir).unwrap_or_else(|_| json!({"providers": {}}));
    let mut ids = std::collections::BTreeSet::new();
    if let Some(providers) = models.get("providers").and_then(Value::as_object) {
        ids.extend(providers.keys().cloned());
    }
    if let Some(providers) = store.get("providers").and_then(Value::as_object) {
        ids.extend(providers.keys().cloned());
    }
    let profiles = ids.into_iter().map(|id| {
        let config = models.get("providers").and_then(|items| items.get(&id)).unwrap_or(&Value::Null);
        let saved = store.get("providers").and_then(|items| items.get(&id)).unwrap_or(&Value::Null);
        json!({
            "id": id,
            "name": saved.get("name").and_then(Value::as_str).or_else(|| config.get("name").and_then(Value::as_str)),
            "baseUrl": saved.get("baseUrl").and_then(Value::as_str).or_else(|| config.get("baseUrl").and_then(Value::as_str)),
            "modelsUrl": saved.get("modelsUrl").and_then(Value::as_str).or_else(|| config.get("modelsUrl").and_then(Value::as_str)),
            "api": saved.get("api").and_then(Value::as_str).or_else(|| config.get("api").and_then(Value::as_str)),
            "authHeader": saved.get("authHeader").and_then(Value::as_bool).or_else(|| config.get("authHeader").and_then(Value::as_bool)),
            "isDefault": default_provider == Some(id.as_str()),
            "defaultModel": if default_provider == Some(id.as_str()) { default_model } else { saved.get("defaultModel").and_then(Value::as_str) },
            "models": config.get("models").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "hasApiKey": stored_api_key(&auth, &id).is_some(),
            "modelCount": config.get("models").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
        })
    }).collect::<Vec<_>>();
    Ok(Value::Array(profiles))
}

#[tauri::command]
pub async fn probe_provider_models(
    provider: String,
    base_url: String,
    api: String,
    api_key: Option<String>,
    auth_header: bool,
    models_url: Option<String>,
) -> Result<Value, String> {
    if !valid_provider_id(&provider) {
        return Err("Provider ID 只能包含字母、数字、-、_、.".into());
    }
    if !supported_api(&api) {
        return Err("不支持的 Pi API 类型".into());
    }
    let dir = agent_dir()?;
    let auth = read_json_file(dir.join("auth.json"), "Pi auth.json").unwrap_or_else(|_| json!({}));
    let key = api_key
        .filter(|value| !value.trim().is_empty())
        .or_else(|| stored_api_key(&auth, &provider))
        .unwrap_or_default();
    normalized_model_catalog(
        &provider,
        &base_url,
        models_url.as_deref(),
        &key,
        &api,
        auth_header,
    )
    .await
}

#[tauri::command]
pub async fn save_provider(
    provider: String,
    name: Option<String>,
    base_url: String,
    models_url: Option<String>,
    api: String,
    api_key: Option<String>,
    auth_header: bool,
) -> Result<Value, String> {
    if !valid_provider_id(&provider) {
        return Err("Provider ID 只能包含字母、数字、-、_、.".into());
    }
    if !supported_api(&api) {
        return Err("不支持的 Pi API 类型".into());
    }
    let dir = agent_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建 Pi 配置目录：{e}"))?;
    let path = dir.join("models.json");
    let mut config = if path.exists() {
        read_json_file(path.clone(), "Pi models.json")?
    } else {
        json!({"providers": {}})
    };
    let providers = config
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or("Pi models.json 缺少 providers 对象")?;
    let mut provider_config = providers
        .get(&provider)
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !provider_config.is_object() {
        provider_config = json!({});
    }
    provider_config["baseUrl"] = Value::from(base_url.trim_end_matches('/'));
    if let Some(value) = models_url.as_ref().filter(|value| !value.trim().is_empty()) {
        provider_config["modelsUrl"] = Value::from(value.trim_end_matches('/'));
    } else {
        provider_config
            .as_object_mut()
            .map(|object| object.remove("modelsUrl"));
    }
    provider_config["api"] = Value::from(api.clone());
    provider_config["authHeader"] = Value::from(auth_header);
    if let Some(value) = name.as_ref().filter(|value| !value.trim().is_empty()) {
        provider_config["name"] = Value::from(value.as_str());
    }
    providers.insert(provider.clone(), provider_config);
    if path.exists() {
        let _ = fs::copy(&path, path.with_extension("json.bak"));
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    if let Some(key) = api_key.as_ref().filter(|value| !value.trim().is_empty()) {
        let auth_path = dir.join("auth.json");
        let mut auth = if auth_path.exists() {
            read_json_file(auth_path.clone(), "Pi auth.json")?
        } else {
            json!({})
        };
        auth[&provider] = json!({"type":"api_key","key":key});
        fs::write(
            &auth_path,
            serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 Pi auth.json 失败：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&auth_path, fs::Permissions::from_mode(0o600));
        }
    }
    let mut store = load_provider_store(&dir)?;
    let providers = store
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .ok_or("Provider 配置缺少 providers 对象")?;
    let previous_key = providers
        .get(&provider)
        .and_then(|value| value.get("apiKey"))
        .cloned();
    let previous_default_model = providers
        .get(&provider)
        .and_then(|value| value.get("defaultModel"))
        .cloned();
    let normalized_models_url = models_url
        .as_deref()
        .map(|value| value.trim().trim_end_matches('/'))
        .filter(|value| !value.is_empty());
    let mut entry = json!({"name":name,"baseUrl":base_url.trim_end_matches('/'),"modelsUrl":normalized_models_url,"api":api,"authHeader":auth_header});
    if let Some(key) = api_key
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| Value::from(value.as_str()))
        .or(previous_key)
    {
        entry["apiKey"] = key;
    }
    if let Some(model) = previous_default_model {
        entry["defaultModel"] = model;
    }
    providers.insert(provider.clone(), entry);
    write_provider_store(&dir, &store)?;
    Ok(
        json!({"id":provider,"hasApiKey": read_json_file(dir.join("auth.json"), "Pi auth.json").ok().and_then(|auth| stored_api_key(&auth, &provider)).is_some()}),
    )
}

#[tauri::command]
pub fn delete_provider(provider: String) -> Result<Value, String> {
    if !valid_provider_id(&provider) {
        return Err("Provider ID 只能包含字母、数字、-、_.".into());
    }
    let dir = agent_dir()?;
    let models_path = dir.join("models.json");
    let auth_path = dir.join("auth.json");
    let settings_path = settings_path(&dir);
    let mut models = models_path.exists().then(|| read_json_file(models_path.clone(), "Pi models.json")).transpose()?;
    let mut auth = auth_path.exists().then(|| read_json_file(auth_path.clone(), "Pi auth.json")).transpose()?;
    let mut store = load_provider_store(&dir)?;
    let mut settings = settings_path.exists().then(|| read_json_file(settings_path.clone(), "Pi settings.json")).transpose()?;
    let models_removed = models.as_mut().and_then(|value| value.get_mut("providers")).and_then(Value::as_object_mut).and_then(|items| items.remove(&provider)).is_some();
    let auth_removed = auth.as_mut().and_then(Value::as_object_mut).and_then(|items| items.remove(&provider)).is_some();
    let store_removed = store.get_mut("providers").and_then(Value::as_object_mut).and_then(|items| items.remove(&provider)).is_some();
    let default_removed = settings.as_ref().and_then(|value| value.get("defaultProvider")).and_then(Value::as_str) == Some(provider.as_str());
    if !(models_removed || auth_removed || store_removed || default_removed) {
        return Err(format!("Provider 不存在：{provider}"));
    }
    if default_removed {
        if let Some(object) = settings.as_mut().and_then(Value::as_object_mut) {
            object.remove("defaultProvider");
            object.remove("defaultModel");
        }
    }
    if models_removed {
        fs::write(&models_path, serde_json::to_string_pretty(&models).map_err(|e| e.to_string())? + "\n")
            .map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    }
    if auth_removed {
        fs::write(&auth_path, serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())? + "\n")
            .map_err(|e| format!("写入 Pi auth.json 失败：{e}"))?;
    }
    if store_removed { write_provider_store(&dir, &store)?; }
    if default_removed {
        fs::write(&settings_path, serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n")
            .map_err(|e| format!("写入 Pi settings.json 失败：{e}"))?;
    }
    Ok(json!({"id": provider, "deleted": true}))
}
#[tauri::command]
pub async fn sync_provider_models(provider: String) -> Result<Value, String> {
    let catalog = list_provider_models(provider.clone()).await?;
    let remote = catalog
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if remote.is_empty() {
        return Err("模型目录缺少 data 数组或没有模型".into());
    }
    let dir = agent_dir()?;
    let path = dir.join("models.json");
    let mut config = read_json_file(path.clone(), "Pi models.json")?;
    let provider_config = config
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .and_then(|items| items.get_mut(&provider))
        .ok_or_else(|| format!("Pi 未配置 provider：{provider}"))?;
    let existing = provider_config
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let models = remote
        .iter()
        .filter_map(pi_model_from_meta)
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err("模型目录没有可同步的模型".into());
    }
    provider_config["models"] = Value::Array(models.clone());
    let backup = path.with_extension("json.bak");
    let _ = fs::copy(&path, backup);
    let serialized = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())? + "\n";
    fs::write(&path, serialized).map_err(|e| format!("写入 Pi models.json 失败：{e}"))?;
    let first_model_id = models
        .first()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str);
    Ok(
        json!({"provider":provider,"count":models.len(),"previous":existing.len(),"firstModelId":first_model_id}),
    )
}

fn set_default_model_in(
    dir: &std::path::Path,
    provider: String,
    model_id: String,
) -> Result<Value, String> {
    if !valid_provider_id(&provider) || model_id.trim().is_empty() {
        return Err("Provider 和模型 ID 不能为空".into());
    }
    let models_path = dir.join("models.json");
    let mut models = read_json_file(models_path.clone(), "Pi models.json")?;
    let provider_config = models
        .get_mut("providers")
        .and_then(Value::as_object_mut)
        .and_then(|providers| providers.get_mut(&provider))
        .ok_or_else(|| format!("Pi 未配置 provider：{provider}"))?;
    if !provider_config.get("models").is_some_and(Value::is_array) {
        provider_config["models"] = Value::Array(Vec::new());
    }
    let model_list = provider_config
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("Pi provider 没有模型列表：{provider}"))?;
    let exists = model_list
        .iter()
        .any(|model| model.get("id").and_then(Value::as_str) == Some(model_id.as_str()));
    if !exists {
        model_list.push(json!({"id": model_id, "input": ["text"]}));
        fs::write(
            &models_path,
            serde_json::to_string_pretty(&models).map_err(|e| e.to_string())? + "\n",
        )
        .map_err(|e| format!("写入 Pi 自定义模型失败：{e}"))?;
    }

    let path = settings_path(&dir);
    let mut settings = if path.exists() {
        read_json_file(path.clone(), "Pi settings.json")?
    } else {
        json!({})
    };
    if !settings.is_object() {
        settings = json!({});
    }
    settings["defaultProvider"] = Value::from(provider.clone());
    settings["defaultModel"] = Value::from(model_id.clone());
    fs::write(
        &path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("写入 Pi 默认模型失败：{e}"))?;
    let mut store = load_provider_store(dir)?;
    if let Some(entry) = store.get_mut("providers").and_then(Value::as_object_mut).and_then(|providers| providers.get_mut(&provider)) {
        entry["defaultModel"] = Value::from(model_id.clone());
        write_provider_store(dir, &store)?;
    }
    Ok(json!({"provider":provider,"id":model_id}))
}

#[tauri::command]
pub fn set_default_model(provider: String, model_id: String) -> Result<Value, String> {
    set_default_model_in(&agent_dir()?, provider, model_id)
}

#[cfg(test)]
mod default_model_tests {
    use super::*;

    #[test]
    fn persists_default_model_without_losing_other_settings() {
        let dir = std::env::temp_dir().join(format!("pi-gui-model-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("models.json"),
            r#"{"providers":{"llmgate":{"models":[{"id":"codex-auto-review"}]}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"theme":"dark","defaultProvider":"jamerly","defaultModel":"old"}"#,
        )
        .unwrap();

        set_default_model_in(&dir, "llmgate".into(), "codex-auto-review".into()).unwrap();
        let settings = read_json_file(dir.join("settings.json"), "settings").unwrap();
        assert_eq!(settings["defaultProvider"], "llmgate");
        assert_eq!(settings["defaultModel"], "codex-auto-review");
        assert_eq!(settings["theme"], "dark");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn adds_a_manually_entered_default_model_to_the_provider() {
        let dir =
            std::env::temp_dir().join(format!("pi-gui-manual-model-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("models.json"),
            r#"{"providers":{"relay":{"baseUrl":"https://example.com/v1"}}}"#,
        )
        .unwrap();

        set_default_model_in(&dir, "relay".into(), "private-model-v2".into()).unwrap();
        let models = read_json_file(dir.join("models.json"), "models").unwrap();
        assert_eq!(
            models["providers"]["relay"]["models"][0]["id"],
            "private-model-v2"
        );
        let settings = read_json_file(dir.join("settings.json"), "settings").unwrap();
        assert_eq!(settings["defaultProvider"], "relay");
        assert_eq!(settings["defaultModel"], "private-model-v2");

        let _ = fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod custom_model_cost_tests {
    use super::*;

    #[test]
    fn repairs_incomplete_costs_that_make_pi_reject_models_json() {
        let dir = std::env::temp_dir().join(format!("pi-gui-cost-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("models.json"), r#"{"providers":{"relay":{"models":[{"id":"a","input":["text","image"],"cost":{"input":1,"output":2}},{"id":"b","input":["text","image"],"cost":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4}}]}}}"#).unwrap();

        assert_eq!(repair_custom_model_costs(&dir).unwrap(), 2);
        let config = read_json_file(dir.join("models.json"), "models").unwrap();
        let models = config["providers"]["relay"]["models"].as_array().unwrap();
        assert_eq!(
            models[0]["cost"],
            json!({"input":1,"output":2,"cacheRead":0.0,"cacheWrite":0.0})
        );
        assert_eq!(
            models[1]["cost"],
            json!({"input":1,"output":2,"cacheRead":3,"cacheWrite":4})
        );
        assert!(dir.join("models.json.pi-gui.bak").exists());
        assert_eq!(repair_custom_model_costs(&dir).unwrap(), 0);

        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;

    fn dev_catalog() -> Value {
        json!({
            "zhipuai": {"api": "https://open.bigmodel.cn/api/paas/v4", "models": {
                "glm-5": {"name": "GLM-5", "limit": {"context": 204800, "output": 131072}, "modalities": {"input": ["text"], "output": ["text"]}, "reasoning": true, "cost": {"input": 1.0, "output": 3.2, "cache_read": 0.2, "cache_write": 0.0}}
            }},
            "zai": {"models": {"glm-4.6": {"limit": {"context": 204800}}}}
        })
    }

    #[test]
    fn lookup_uses_runtime_endpoint_and_provider_identity() {
        let catalog = dev_catalog();
        assert!(modelsdev_lookup(
            &catalog,
            "Zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5"
        )
        .is_some());
        assert!(
            modelsdev_lookup(&catalog, "z-ai", "https://api.z.ai/api/paas/v4", "glm-4.6").is_some()
        );
        assert!(
            modelsdev_lookup(&catalog, "whatever", "https://example.com/v1", "glm-5").is_none()
        );
        assert!(modelsdev_lookup(
            &catalog,
            "whatever",
            "https://example.com/v1",
            "glm-unknown"
        )
        .is_none());
    }

    #[test]
    fn lookup_resolves_prefixed_model_ids() {
        let catalog = json!({"zai": {"models": {"glm-4.6": {"limit": {"context": 204800}}}}});
        assert!(
            modelsdev_lookup(&catalog, "z-ai", "https://api.z.ai/v1", "z-ai/glm-4.6").is_some()
        );
    }

    #[test]
    fn normalizes_catalog_field_aliases() {
        // OpenRouter 风格：context_length、architecture.input_modalities、per-token 字符串价格
        let item = json!({
            "id": "z-ai/glm-4.6",
            "context_length": 204800,
            "pricing": {"prompt": "0.0000006", "completion": "0.0000022", "input_cache_read": "0.0000001"},
            "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]},
            "reasoning": {"supported_efforts": ["low", "high"]}
        });
        let meta = normalize_provider_model(&item);
        assert_eq!(meta.context_window, Some(204800));
        assert_eq!(
            meta.input_modalities.as_deref(),
            Some(["text".to_string(), "image".to_string()].as_slice())
        );
        assert_eq!(meta.reasoning, Some(true));
        let json = meta.to_json();
        assert_eq!(json["pricing"]["input"], 0.6);
        assert_eq!(json["pricing"]["output"], 2.2);
        assert_eq!(json["pricing"]["cacheRead"], 0.1);
        assert_eq!(json["thinking_levels"]["high"], "high");

        // Vercel Gateway 风格：context_window/max_tokens、modalities 对象
        let item = json!({
            "id": "glm-5.2",
            "context_window": 1000000,
            "max_tokens": 128000,
            "modalities": {"input": ["text", "image"], "output": ["text"]}
        });
        let meta = normalize_provider_model(&item);
        assert_eq!(meta.context_window, Some(1000000));
        assert_eq!(meta.max_output_tokens, Some(128000));
        assert_eq!(
            meta.input_modalities.as_deref(),
            Some(["text".to_string(), "image".to_string()].as_slice())
        );
    }

    #[test]
    fn merge_fills_only_missing_fields() {
        let item = json!({"id": "glm-5"});
        let mut meta = normalize_provider_model(&item);
        assert_eq!(meta.context_window, None);
        let dev = dev_catalog();
        let entry = modelsdev_lookup(
            &dev,
            "Zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5",
        )
        .unwrap();
        merge_meta(&mut meta, normalize_modelsdev_model(entry));
        assert_eq!(meta.context_window, Some(204800));
        assert_eq!(meta.max_output_tokens, Some(131072));
        assert_eq!(meta.reasoning, Some(true));
        assert_eq!(meta.name.as_deref(), Some("GLM-5"));
        assert_eq!(meta.pricing.as_ref().unwrap()["output"], 3.2);

        // 接口已有值不被覆盖；models.dev 未覆盖的字段保持 None
        let item =
            json!({"id": "glm-5", "context_length": 999, "input_modalities": ["text", "image"]});
        let mut meta = normalize_provider_model(&item);
        let dev = dev_catalog();
        let entry = modelsdev_lookup(
            &dev,
            "Zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "glm-5",
        )
        .unwrap();
        merge_meta(&mut meta, normalize_modelsdev_model(entry));
        assert_eq!(meta.context_window, Some(999));
        assert_eq!(
            meta.input_modalities.as_deref(),
            Some(["text".to_string(), "image".to_string()].as_slice())
        );
        assert_eq!(meta.max_output_tokens, Some(131072));
    }

    #[test]
    fn pi_model_from_meta_drives_pi_context() {
        let entry = json!({
            "id": "glm-5",
            "name": "GLM-5",
            "context_window": 204800,
            "max_output_tokens": 131072,
            "input_modalities": ["text"],
            "output_modalities": ["text"],
            "reasoning": true,
            "pricing": {"input": 1.0, "output": 3.2, "cacheRead": 0.2, "cacheWrite": 0.0}
        });
        let model = pi_model_from_meta(&entry).unwrap();
        assert_eq!(model["id"], "glm-5");
        assert_eq!(model["name"], "GLM-5");
        assert_eq!(model["contextWindow"], 204800);
        assert_eq!(model["maxTokens"], 131072);
        assert_eq!(model["input"], json!(["text"]));
        assert_eq!(model["reasoning"], true);
        assert_eq!(
            model["cost"],
            json!({"input": 1.0, "output": 3.2, "cacheRead": 0.2, "cacheWrite": 0.0})
        );
        // thinking_levels 非空时开启 reasoning 并写入映射
        let entry = json!({"id": "m", "reasoning": false, "thinking_levels": {"low": "low", "high": "high"}});
        let model = pi_model_from_meta(&entry).unwrap();
        assert_eq!(model["reasoning"], true);
        assert_eq!(model["thinkingLevelMap"]["high"], "high");
    }

    #[test]
    fn pi_model_from_meta_omits_non_positive_limits() {
        let entry = json!({
            "id": "image-model",
            "context_window": 0,
            "max_output_tokens": 0,
            "input_modalities": ["text", "image"]
        });
        let model = pi_model_from_meta(&entry).unwrap();
        assert!(model.get("contextWindow").is_none());
        assert!(model.get("maxTokens").is_none());
    }
}

/// Pi 流式事件在 Rust→JS 这一层的攒批策略。
///
/// Pi 在流式输出时会为每个 delta 写一行 JSONL（message_update /
/// tool_execution_update，一个 32ms 窗口内可达几十条）。如果逐条 `Channel.send`，
/// 每一条都要走一次 JSON 编码 → IPC → WebView JSON 解码 → JS 回调，主线程被切碎，
/// 打字/IME 抢不到帧（掉帧），而 JS 侧那层 32ms 合并只合并了 store 提交，
/// 合并不了被唤醒与编解码的次数。这里把连发事件攒成一条批量消息发过去，
/// 内容、顺序、JS 侧的合并时机完全不变。
///
/// 分类沿用 JS 侧 `burstEvents`（src/lib/rpc.ts）——只有这两类会高频连发；
/// 其余事件（message_end / agent_* / tool_execution_start 等）必须立即转发，
/// 保证落定、错误与响应的时序和以前完全一致。
const PI_BURST_EVENT_TYPES: [&str; 2] = ["message_update", "tool_execution_update"];
/// 一批最多多少条。实际冲刷时机通常是"上游缓冲区排空"，这个上限只在持续满速
/// 输出时才起作用；64 条（数十 KB）既能把 eval 次数压下来，又不会让单条 IPC 变重。
const PI_EVENT_BATCH_MAX: usize = 64;
/// 一批最多攒多久。只要 BufReader 缓冲区已排空就直接冲刷，所以这个上限只在
/// 上游持续满速输出时才会用到。
const PI_EVENT_BATCH_WINDOW: Duration = Duration::from_millis(16);

fn is_pi_burst_event(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| PI_BURST_EVENT_TYPES.contains(&kind))
}

/// 攒批状态机（独立出来便于单测）。
struct PiEventBatch {
    events: Vec<Value>,
    since: Instant,
    max: usize,
    window: Duration,
}

impl PiEventBatch {
    fn new(max: usize, window: Duration) -> Self {
        Self { events: Vec::new(), since: Instant::now(), max, window }
    }

    /// 记一个连发事件；`drain_more` = 上游缓冲区里还有待读数据。
    /// 返回 `Some(批次)` 表示现在就该把这一批发出去。
    fn push(&mut self, value: Value, drain_more: bool) -> Option<Vec<Value>> {
        if self.events.is_empty() {
            self.since = Instant::now();
        }
        self.events.push(value);
        if drain_more && self.events.len() < self.max && self.since.elapsed() < self.window {
            return None;
        }
        self.take()
    }

    /// 取出当前已攒下的事件（没有则返回 None）。
    fn take(&mut self) -> Option<Vec<Value>> {
        if self.events.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.events))
    }
}

#[tauri::command]
pub async fn pi_connect(
    app: AppHandle,
    cwd: String,
    on_event: Channel<Value>,
    state: State<'_, Bridge>,
    connection_id: Option<String>,
) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        let _ = (app, cwd, on_event, state, connection_id);
        return Err("移动端通过 Orbit Host 连接 Pi，不能启动本地 Pi 进程".into());
    }
    #[cfg(desktop)]
    {
        let path = project(&cwd)?;
        let runtime = RuntimePaths::resolve(&app, &path)?;
        repair_custom_model_costs(&runtime.agent_dir)?;
        let pi = runtime.pi.clone();
        let node = runtime.node.clone();
        // Explicit executable paths also work when Finder's PATH lacks the Node version manager.
        // Connection id lets one project keep multiple live Pi processes (one session each).
        let id = connection_id
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| cwd.clone());
        state.stop_project(&id);
        // macOS: start Pi through Orbit's disclaim launcher so the stable
        // Orbit Agent runtime, not Orbit itself, owns Accessibility (see
        // disclaim.rs). Falls back to a direct spawn if the path is unknown.
        #[cfg(target_os = "macos")]
        let mut command = match std::env::current_exe() {
            Ok(orbit) => {
                let mut command = Command::new(orbit);
                command.arg(crate::disclaim::FLAG).arg(&node);
                command
            }
            Err(_) => Command::new(&node),
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = Command::new(&node);
        command.arg(&pi).args(["--mode", "rpc", "--offline"]);
        command
            .arg("--extension")
            .arg(&runtime.extension)
            .current_dir(&path);
        apply_orbit_runtime_env(
            &mut command,
            &node,
            &pi,
            runtime.pi_source,
            &runtime.pi_version,
            &runtime.node_modules,
        );
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Pi stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("Pi stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Pi stderr unavailable")?;
        let child = Arc::new(Mutex::new(child));
        state.0.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Worker {
                child: child.clone(),
                stdin,
                cwd: path.clone(),
            },
        );
        let output_channel = on_event.clone();
        let remote_app = app.clone();
        let remote_project = id.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut record = Vec::new();
            let mut batch = PiEventBatch::new(PI_EVENT_BATCH_MAX, PI_EVENT_BATCH_WINDOW);
            // 一批 = 一条 Channel 消息。顺序与逐条发送完全一致：任何别的消息
            // （非连发事件 / 协议错误 / 退出）之前都先把已攒的批冲掉。
            let send_batch = |events: Vec<Value>| output_channel
                .send(json!({"kind":"rpc-batch","payloads":events}))
                .is_ok();
            loop {
                record.clear();
                match reader.read_until(b'\n', &mut record) {
                    Ok(0) => {
                        if let Some(events) = batch.take() {
                            send_batch(events);
                        }
                        break;
                    }
                    Ok(_) => match serde_json::from_slice::<Value>(&record) {
                        Ok(value) => {
                            crate::remote::publish_pi_event(&remote_app, &remote_project, &value);
                            if is_pi_burst_event(&value) {
                                // BufReader 里还有没读完的整行，说明这一波还没结束，
                                // 可以继续攒；缓冲空了就立刻冲刷，绝不把已到手的事件
                                // 压在批里等下一行（首 token / 慢速逐字都不额外延后）。
                                let drain_more = !reader.buffer().is_empty();
                                if let Some(events) = batch.push(value, drain_more) {
                                    if !send_batch(events) {
                                        break;
                                    }
                                }
                                continue;
                            }
                            match batch.take() {
                                Some(events) => if !send_batch(events) { break },
                                None => {}
                            }
                            if output_channel
                                .send(json!({"kind":"rpc","payload":value}))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(_) => {
                            if let Some(events) = batch.take() {
                                if !send_batch(events) { break }
                            }
                            let _=output_channel.send(json!({"kind":"protocol_error","message":"Pi 输出了无效 JSONL 记录"}));
                        }
                    },
                    Err(error) => {
                        if let Some(events) = batch.take() {
                            send_batch(events);
                        }
                        let _ = output_channel
                            .send(json!({"kind":"protocol_error","message":error.to_string()}));
                        break;
                    }
                }
            }
        });
        // Keep a small bounded buffer. Only a filtered, redacted summary may
        // leave the native process when Pi exits.
        let diagnostic_lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let stderr_lines = diagnostic_lines.clone();
        let stderr_thread = thread::spawn(move || {
            for record in BufReader::new(stderr).split(b'\n') {
                let Ok(record) = record else { break };
                let line = String::from_utf8_lossy(&record).trim().to_string();
                if line.is_empty() {
                    continue;
                }
                if let Ok(mut lines) = stderr_lines.lock() {
                    lines.push(line);
                    let overflow = lines.len().saturating_sub(32);
                    if overflow > 0 {
                        lines.drain(..overflow);
                    }
                }
            }
        });
        let workers = state.0.clone();
        let watched_child = child.clone();
        let watched_id = id.clone();
        let exit_app = app.clone();
        let diagnostic_home = runtime.home.clone();
        thread::spawn(move || loop {
            let status = watched_child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok().flatten());
            if let Some(status) = status {
                let _ = stderr_thread.join();
                let diagnostic = diagnostic_lines
                    .lock()
                    .ok()
                    .and_then(|lines| safe_pi_diagnostic(&lines, &diagnostic_home));
                let removed = remove_worker_if_current(&workers, &watched_id, &watched_child);
                if removed {
                    crate::remote::publish_connection_closed(&exit_app, &watched_id);
                    let _ = on_event
                        .send(json!({"kind":"exit","code":status.code(),"message":diagnostic}));
                }
                break;
            }
            thread::sleep(Duration::from_millis(150));
        });
        Ok(
            json!({"pid":pid,"cwd":path,"pi":pi,"node":node,"piSource":runtime.pi_source,"piVersion":runtime.pi_version,"connectionId":id}),
        )
    }
}
#[tauri::command]
pub fn pi_send(project: String, command: Value, state: State<'_, Bridge>) -> Result<(), String> {
    state.send(&project, command)
}
#[tauri::command]
pub fn pi_disconnect(app: AppHandle, project: String, state: State<'_, Bridge>) {
    state.stop_project(&project);
    crate::remote::publish_connection_closed(&app, &project);
}
#[tauri::command]
pub async fn list_sessions(app: AppHandle, cwd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = project(&cwd)?;
        let runtime = RuntimePaths::resolve(&app, &path)?;
        let sdk = runtime.pi.parent().ok_or("Invalid Pi path")?.join("index.js");
        // SDK SessionManager.list is the documented session index, not a guessed JSONL parser.
        let code = "const {pathToFileURL}=require('node:url'); (async()=>{const {SessionManager}=await import(pathToFileURL(process.argv[1]).href);const sessions=await SessionManager.list(process.argv[2]);const result=sessions.map(({allMessagesText,...session})=>{let icon;try{const entries=SessionManager.open(session.path).getEntries();const meta=[...entries].reverse().find(entry=>entry.type==='custom'&&entry.customType==='pi-gui-session-meta');if(meta?.data&&typeof meta.data.icon==='string')icon=meta.data.icon}catch{}return {...session,...(icon?{icon}:{})}});console.log(JSON.stringify(result));})().catch(()=>process.exit(1));";
        let output = Command::new(runtime.node).args(["-e",code]).arg(sdk).arg(path).output().map_err(|e|e.to_string())?;
        if !output.status.success() { return Err("Pi SDK 无法读取会话列表".into()); }
        serde_json::from_slice(&output.stdout).map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn list_project_files(cwd: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project(&cwd)?;
        let mut files = Vec::new();
        collect_project_files(&root, &root, &mut files);
        files.sort_unstable();
        Ok(json!(files))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn delete_session(session_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_dir()?
            .canonicalize()
            .map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path)
            .canonicalize()
            .map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl")
            || !target.starts_with(&root)
        {
            return Err("只能删除 Pi 会话目录中的 JSONL 文件".into());
        }
        fs::remove_file(target).map_err(|e| format!("删除会话失败：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_sessions(state: State<'_, Bridge>) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        let _ = state;
        return Err("清空会话历史请在电脑端执行".into());
    }
    #[cfg(desktop)]
    {
        // Stop every project worker first so no process keeps an open session
        // file while the history directory is being cleared.
        state.stop();
        tauri::async_runtime::spawn_blocking(|| {
            let removed = remove_jsonl_files(&sessions_dir()?)?;
            Ok(json!({ "removed": removed }))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}
#[tauri::command]
pub async fn session_turn_durations(app: AppHandle, session_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = sessions_dir()?.canonicalize().map_err(|_| "Pi 会话目录不可用".to_string())?;
        let target = PathBuf::from(&session_path).canonicalize().map_err(|_| "会话文件不存在".to_string())?;
        if target.extension().and_then(|value| value.to_str()) != Some("jsonl") || !target.starts_with(&root) { return Err("只能读取 Pi 会话目录中的 JSONL 文件".into()); }
        let code = r#"const fs=require('node:fs');const out={};let turn=null;const flush=()=>{if(turn?.id&&Number.isFinite(turn.start)&&Number.isFinite(turn.end)&&turn.end>=turn.start)out[turn.id]=turn.end-turn.start;turn=null};for(const line of fs.readFileSync(process.argv[1],'utf8').split('\n')){if(!line.trim())continue;let entry;try{entry=JSON.parse(line)}catch{continue}if(entry.type!=='message'||!entry.message)continue;const role=entry.message.role;const at=Date.parse(entry.timestamp);if(role==='user'){flush();turn={start:at,end:null,id:null};continue}if(role!=='assistant'||!turn)continue;if(!turn.id){const stamp=entry.message.timestamp;if(Number.isFinite(stamp))turn.id=`timestamp:${stamp}`;else{const call=Array.isArray(entry.message.content)&&entry.message.content.find(part=>part?.type==='toolCall'&&part.id);if(call)turn.id=`tool:${call.id}`}}if(Number.isFinite(at))turn.end=at}flush();process.stdout.write(JSON.stringify(out));"#;
        let runtime = RuntimePaths::resolve(&app, &home_dir()?)?;
        let output = Command::new(runtime.node).args(["-e", code]).arg(&target).output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err("Pi 会话耗时读取失败".into()); }
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn open_pi_terminal(
    app: AppHandle,
    cwd: String,
    session: Option<String>,
    pi_args: Option<Vec<String>>,
) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (app, cwd, session, pi_args);
        return Err("移动端不能启动电脑终端".into());
    }
    #[cfg(desktop)]
    {
        let path = project(&cwd)?;
        let runtime = RuntimePaths::resolve(&app, &path)?;
        let pi = runtime.pi;
        let node = runtime.node;
        let mut arguments = Vec::new();
        if let Some(session) = session {
            arguments.extend(["--session".to_string(), session]);
        }
        arguments.extend(pi_args.unwrap_or_default());

        #[cfg(windows)]
        {
            fn powershell_quote(value: &str) -> String {
                format!("'{}'", value.replace('\'', "''"))
            }
            let suffix = arguments
                .iter()
                .map(|argument| powershell_quote(argument))
                .collect::<Vec<_>>()
                .join(" ");
            let script = format!(
                "Set-Location -LiteralPath {}; & {} {} {}",
                powershell_quote(&path.to_string_lossy()),
                powershell_quote(&node.to_string_lossy()),
                powershell_quote(&pi.to_string_lossy()),
                suffix
            );
            Command::new("cmd.exe")
                .args([
                    "/C",
                    "start",
                    "",
                    "powershell.exe",
                    "-NoExit",
                    "-Command",
                    &script,
                ])
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            fn shell_quote(value: &str) -> String {
                format!("'{}'", value.replace('\'', "'\\''"))
            }
            let suffix = arguments
                .iter()
                .map(|argument| shell_quote(argument))
                .collect::<Vec<_>>()
                .join(" ");
            let command = format!(
                "cd -- {} && {} {} {}",
                shell_quote(&path.to_string_lossy()),
                shell_quote(&node.to_string_lossy()),
                shell_quote(&pi.to_string_lossy()),
                suffix
            );

            #[cfg(target_os = "macos")]
            {
                let literal = command.replace('\\', "\\\\").replace('"', "\\\"");
                let status = Command::new("/usr/bin/osascript").args(["-e",&format!("tell application \"Terminal\"\nactivate\ndo script \"{literal}\"\nend tell")]).status().map_err(|e|e.to_string())?;
                return if status.success() {
                    Ok(())
                } else {
                    Err("无法打开系统终端".into())
                };
            }

            #[cfg(target_os = "linux")]
            {
                let shell = std::env::var_os("SHELL")
                    .map(PathBuf::from)
                    .filter(|path| path.is_file())
                    .unwrap_or_else(|| PathBuf::from("/bin/sh"));
                for terminal in [
                    "konsole",
                    "x-terminal-emulator",
                    "gnome-terminal",
                    "kgx",
                    "kitty",
                    "foot",
                ] {
                    let Ok(path) = executable(terminal) else {
                        continue;
                    };
                    let mut process = Command::new(path);
                    match terminal {
                        "gnome-terminal" | "kgx" => {
                            process.arg("--").arg(&shell).args(["-lc", &command]);
                        }
                        "kitty" | "foot" => {
                            process.arg(&shell).args(["-lc", &command]);
                        }
                        _ => {
                            process.arg("-e").arg(&shell).args(["-lc", &command]);
                        }
                    }
                    if process.spawn().is_ok() {
                        return Ok(());
                    }
                }
                return Err("找不到可用终端；请安装 Konsole 或其他常用终端".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_event_batch_holds_only_while_upstream_still_has_data() {
        let mut batch = PiEventBatch::new(8, Duration::from_secs(60));
        assert!(batch.push(json!({"type": "message_update"}), true).is_none());
        assert!(batch.push(json!({"type": "message_update"}), true).is_none());
        // 缓冲区排空 → 立刻冲刷，不把已到手的事件压着等下一行
        let flushed = batch.push(json!({"type": "message_update"}), false).unwrap();
        assert_eq!(flushed.len(), 3);
        assert!(batch.take().is_none(), "flush 之后批必须是空的");
    }

    #[test]
    fn pi_event_batch_flushes_at_the_size_cap() {
        let mut batch = PiEventBatch::new(3, Duration::from_secs(60));
        assert!(batch.push(json!({"type": "message_update"}), true).is_none());
        assert!(batch.push(json!({"type": "message_update"}), true).is_none());
        let flushed = batch.push(json!({"type": "message_update"}), true).unwrap();
        assert_eq!(flushed.len(), 3);
    }

    #[test]
    fn pi_event_batch_take_is_none_when_empty() {
        let mut batch = PiEventBatch::new(8, Duration::from_secs(60));
        assert!(batch.take().is_none());
    }

    #[test]
    fn pi_event_batching_only_swallows_burst_events() {
        // 只有连发的流式事件允许进批；落定/响应/错误类必须逐条立即转发。
        for kind in ["message_update", "tool_execution_update"] {
            assert!(is_pi_burst_event(&json!({"type": kind, "payload": {}})));
        }
        for kind in [
            "message_start",
            "message_end",
            "agent_start",
            "agent_end",
            "agent_settled",
            "tool_execution_start",
            "tool_execution_end",
            "response",
            "queue_update",
        ] {
            assert!(!is_pi_burst_event(&json!({"type": kind})), "{kind} must not be batched");
        }
        assert!(!is_pi_burst_event(&json!({"type": 12})));
        assert!(!is_pi_burst_event(&json!({})));
    }

    fn temporary_root(label: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pi-gui-{label}-{}-{suffix}", std::process::id()))
    }

    #[test]
    fn project_pi_resolution_prefers_the_bundled_cli_for_nested_workspaces() {
        let root = temporary_root("pi-resolution");
        let nested = root.join("packages/app/src");
        let bundle = root.join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        fs::write(&bundle, "#!/usr/bin/env node\n").unwrap();

        let (resolved, source) = pi_path_for_project(None, &nested).unwrap();
        assert_eq!(resolved, bundle.canonicalize().unwrap());
        assert_eq!(source, "project");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_pi_resolution_uses_bundle_entrypoint_when_both_builds_exist() {
        let root = temporary_root("pi-resolution-order");
        let nested = root.join("workspace");
        let bundle = root.join("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
        let legacy = root.join("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        fs::write(&bundle, "bundle").unwrap();
        fs::write(&legacy, "legacy").unwrap();

        assert_eq!(
            bundled_pi_path(&nested).unwrap(),
            bundle.canonicalize().unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pi_diagnostics_are_bounded_redacted_and_ignore_secrets() {
        let home = PathBuf::from("/Users/example");
        let lines = vec![
            "Authorization: Bearer private-value".to_string(),
            "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/example/runtime/helper.ts'"
                .to_string(),
        ];
        let message = safe_pi_diagnostic(&lines, &home).unwrap();
        assert!(message.contains("ERR_MODULE_NOT_FOUND"));
        assert!(message.contains("~/runtime/helper.ts"));
        assert!(!message.contains("private-value"));
        assert!(message.len() <= 500);
    }

    fn worker() -> Worker {
        let mut child = Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        Worker {
            child: Arc::new(Mutex::new(child)),
            stdin,
            cwd: std::env::temp_dir(),
        }
    }
    #[test]
    fn disconnecting_one_project_keeps_the_other_process_alive() {
        let bridge = Bridge::default();
        let a = worker();
        let b = worker();
        let b_child = b.child.clone();
        bridge.0.lock().unwrap().insert("a".into(), a);
        bridge.0.lock().unwrap().insert("b".into(), b);
        bridge.stop_project("a");
        assert!(!bridge.0.lock().unwrap().contains_key("a"));
        assert!(bridge.0.lock().unwrap().contains_key("b"));
        assert!(b_child.lock().unwrap().try_wait().unwrap().is_none());
        bridge.stop();
        assert!(b_child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn stale_exit_cannot_remove_a_replacement_worker() {
        let bridge = Bridge::default();
        let first = worker();
        let first_child = first.child.clone();
        bridge.0.lock().unwrap().insert("same".into(), first);
        let replacement = worker();
        let replacement_child = replacement.child.clone();
        bridge.0.lock().unwrap().insert("same".into(), replacement);

        assert!(!remove_worker_if_current(&bridge.0, "same", &first_child));
        assert!(bridge.0.lock().unwrap().contains_key("same"));
        assert!(remove_worker_if_current(
            &bridge.0,
            "same",
            &replacement_child
        ));
        assert!(!bridge.0.lock().unwrap().contains_key("same"));

        if let Ok(mut child) = first_child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut child) = replacement_child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        };
    }

    #[test]
    fn send_accepts_a_canonical_alias_for_an_existing_project_worker() {
        let bridge = Bridge::default();
        let root = temporary_root("bridge-alias");
        fs::create_dir_all(&root).unwrap();
        let alias = format!("{}/", root.display());
        let worker = worker();
        bridge.0.lock().unwrap().insert(
            alias,
            Worker {
                cwd: root.canonicalize().unwrap(),
                ..worker
            },
        );

        bridge
            .send(&root.to_string_lossy(), json!({"type":"get_state"}))
            .unwrap();
        bridge.stop();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remove_jsonl_files_clears_nested_session_history_only() {
        let root = temporary_root("clear-sessions");
        let nested = root.join("project");
        fs::create_dir_all(&nested).unwrap();
        fs::write(root.join("one.jsonl"), "{}").unwrap();
        fs::write(nested.join("two.jsonl"), "{}").unwrap();
        fs::write(nested.join("keep.txt"), "keep").unwrap();

        assert_eq!(remove_jsonl_files(&root).unwrap(), 2);
        assert!(!root.join("one.jsonl").exists());
        assert!(!nested.join("two.jsonl").exists());
        assert!(nested.join("keep.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
