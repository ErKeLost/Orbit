//! Shared Pi bridge state: the RPC connection registry, the runtime discovery
//! it is started from, and the small file helpers every Pi-facing module uses.
//!
//! The domain commands live next to their own data: `pi_session` (RPC worker and
//! streaming), `providers`, `mcp`, `gui_settings`, `computer_use`, `attachments`
//! and `sessions_cmd`. This module only keeps what more than one of them needs.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::computer_use::{
    cloudflare_token_path, computer_use_decision_model, computer_use_jev_model,
    read_computer_use_config, typesafe_key_path,
};

// Pi credentials are written by the Providers page and read by the image, web
// search and speech pages, which all reach them through this module.
pub(crate) use crate::providers::{store_provider_api_key, stored_api_key};

#[cfg(test)]
mod tests;

pub(crate) struct Worker {
    pub(crate) child: Arc<Mutex<Child>>,
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    pub(crate) cwd: PathBuf,
}
#[derive(Default)]
pub struct Bridge(pub(crate) Arc<Mutex<HashMap<String, Worker>>>);
pub(crate) fn remove_worker_if_current(
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
/**
 * The live worker key that serves `project`.
 *
 * A caller may hold an older path spelling (a trailing slash, a symlinked
 * parent such as `/tmp` on macOS) while the worker keeps the canonical
 * directory it was started in. Resolve that alias rather than reporting a
 * missing connection. Exact connection ids still win, so concurrent sessions
 * on one project stay isolated.
 */
fn worker_key(workers: &HashMap<String, Worker>, project: &str) -> Option<String> {
    if workers.contains_key(project) {
        return Some(project.to_owned());
    }
    let canonical = PathBuf::from(project).canonicalize().ok()?;
    workers
        .iter()
        .find_map(|(id, worker)| (worker.cwd == canonical).then(|| id.clone()))
}

impl Bridge {
    pub fn send(&self, project: &str, command: Value) -> Result<(), String> {
        if !command.is_object() || command.get("type").and_then(Value::as_str).is_none() {
            return Err("RPC command requires a type".into());
        }
        let mut bytes = serde_json::to_vec(&command).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        // The registry lock only resolves the connection. A slow/full stdin pipe
        // must not block sends, lookups and shutdowns for every other worker.
        let stdin = {
            let mut slot = self.0.lock().map_err(|e| e.to_string())?;
            let key = worker_key(&slot, project).ok_or("项目尚未连接")?;
            slot.get_mut(&key).ok_or("项目尚未连接")?.stdin.clone()
        };
        let mut stdin = stdin.lock().map_err(|e| e.to_string())?;
        stdin
            .write_all(&bytes)
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    /// The connection that serves `project`, as `(connection id, canonical directory)`.
    ///
    /// This is the same resolution `send` uses, which is what lets a phone
    /// attach to whatever the desktop has open instead of reproducing the
    /// desktop's own path rules.
    pub fn resolve(&self, project: &str) -> Option<(String, String)> {
        let workers = self.0.lock().ok()?;
        let key = worker_key(&workers, project)?;
        let worker = workers.get(&key)?;
        Some((key, worker.cwd.to_string_lossy().into_owned()))
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
        let worker = self
            .0
            .lock()
            .ok()
            .and_then(|mut workers| workers.remove(project));
        // Do not hold the registry across process teardown: wait() can take
        // arbitrarily long and other connections still need to make progress.
        if let Some(worker) = worker {
            drop(worker.stdin);
            if let Ok(mut child) = worker.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
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
pub(crate) fn executable(name: &str) -> Result<PathBuf, String> {
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
pub(crate) fn executable(name: &str) -> Result<PathBuf, String> {
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

/// Everything the app knows about one `pi --version` attempt.
///
/// The probe used to return `Option<String>` and send stderr to `Stdio::null()`,
/// so a broken runtime on an installed Windows build produced exactly one
/// sentence no matter whether the process could not spawn, hung, exited 1, or
/// printed something unexpected. The diagnostics page and every error message
/// now read this instead.
#[derive(Clone, Debug)]
pub(crate) struct ProbeOutcome {
    pub(crate) ok: bool,
    pub(crate) version: Option<String>,
    pub(crate) invocation: String,
    pub(crate) elapsed_ms: u64,
    pub(crate) exit_code: Option<i32>,
    pub(crate) timed_out: bool,
    pub(crate) stdout_tail: String,
    pub(crate) stderr_tail: String,
    pub(crate) reason: Option<String>,
}

impl ProbeOutcome {
    fn failed(invocation: String, elapsed_ms: u64, reason: String) -> Self {
        Self {
            ok: false,
            version: None,
            invocation,
            elapsed_ms,
            exit_code: None,
            timed_out: false,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
            reason: Some(reason),
        }
    }

    pub(crate) fn json(&self) -> Value {
        json!({
            "ok": self.ok,
            "version": self.version,
            "invocation": self.invocation,
            "elapsedMs": self.elapsed_ms,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "stdoutTail": self.stdout_tail,
            "stderrTail": self.stderr_tail,
            "reason": self.reason,
        })
    }

    /// One line for a toast or a console status: the reason plus whatever the
    /// runtime printed, because the first stack frame is what identifies a
    /// missing chunk.
    pub(crate) fn message(&self) -> String {
        let reason = self.reason.clone().unwrap_or_else(|| "Pi 没有返回版本号".into());
        let detail = if !self.stderr_tail.is_empty() {
            format!("：{}", self.stderr_tail)
        } else if !self.stdout_tail.is_empty() {
            format!("：{}", self.stdout_tail)
        } else {
            String::new()
        };
        format!(
            "{reason}（耗时 {:.1}s，退出码 {}）{detail}",
            self.elapsed_ms as f64 / 1000.0,
            self.exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "无".into())
        )
    }
}

/// Last few hundred characters of captured output. A Node stack trace ends with
/// the interesting line; a huge one must not travel through an IPC payload.
fn tail(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let start = trimmed
        .char_indices()
        .rev()
        .nth(limit.saturating_sub(1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    trimmed[start..].to_string()
}

fn parse_pi_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|word| word.trim_start_matches('v'))
        .find(|word| {
            word.split('.').count() == 3 && word.split('.').all(|part| part.parse::<u32>().is_ok())
        })
        .map(str::to_string)
}

const PI_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Probe `<node> <cli.js> --version` (or `<pi> --version` for a real binary).
fn probe_pi_once(
    node: &Path,
    pi: &Path,
    executable: bool,
    settings: &crate::pi_runtime_settings::PiRuntimeSettings,
    timeout: std::time::Duration,
) -> ProbeOutcome {
    let started = std::time::Instant::now();
    let invocation = if executable {
        format!("{} --version", pi.display())
    } else {
        format!("{} {} --version", node.display(), pi.display())
    };
    let mut command = Command::new(if executable { pi } else { node });
    if !executable {
        command.arg(pi);
    }
    settings.apply_environment(&mut command);
    crate::hide_window_console(&mut command);
    let mut child = match command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return ProbeOutcome::failed(
                invocation,
                started.elapsed().as_millis() as u64,
                format!("无法启动进程：{error}"),
            )
        }
    };
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                return ProbeOutcome::failed(
                    invocation,
                    started.elapsed().as_millis() as u64,
                    format!("等待 Pi 退出失败：{error}"),
                );
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let mut outcome = ProbeOutcome::failed(
                invocation,
                started.elapsed().as_millis() as u64,
                format!("--version 在 {:.0} 秒内没有退出", timeout.as_secs_f64()),
            );
            outcome.timed_out = true;
            return outcome;
        }
        thread::sleep(std::time::Duration::from_millis(25));
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => {
            return ProbeOutcome::failed(invocation, elapsed_ms, format!("读取 Pi 输出失败：{error}"))
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let version = output.status.success().then(|| parse_pi_version(&stdout)).flatten();
    let reason = if !output.status.success() {
        Some(match output.status.code() {
            Some(code) => format!("Pi --version 退出码 {code}"),
            None => "Pi --version 被信号终止".to_string(),
        })
    } else if version.is_none() {
        Some("Pi --version 没有输出可识别的版本号".to_string())
    } else {
        None
    };
    ProbeOutcome {
        ok: version.is_some(),
        version,
        invocation,
        elapsed_ms,
        exit_code: output.status.code(),
        timed_out: false,
        stdout_tail: tail(&stdout, 400),
        stderr_tail: tail(&stderr, 600),
        reason,
    }
}

/// Probe with the platform's retry policy.
///
/// A cold start on Windows pays for the antivirus scan of `node.exe` plus every
/// runtime chunk, so a *timeout* there is worth one retry with a longer budget:
/// the second attempt runs against warm file cache. A non-zero exit or an
/// unparsable version is not retried, because neither is a timing problem and
/// retrying would only double the time the user waits for a real error.
fn pi_version(
    node: &Path,
    pi: &Path,
    executable: bool,
    settings: &crate::pi_runtime_settings::PiRuntimeSettings,
) -> ProbeOutcome {
    let first = probe_pi_once(node, pi, executable, settings, PI_VERSION_TIMEOUT);
    if first.ok || !cfg!(windows) || !first.timed_out {
        return first;
    }
    let mut second = probe_pi_once(node, pi, executable, settings, PI_VERSION_TIMEOUT * 3);
    if !second.ok {
        if let Some(reason) = second.reason.take() {
            second.reason = Some(format!(
                "{}（首次 {:.1}s 失败后重试仍失败）",
                reason,
                first.elapsed_ms as f64 / 1000.0
            ));
        }
    }
    second
}

fn pi_is_executable(path: &Path) -> bool {
    use std::io::Read;
    if path.extension().is_some_and(|extension| ["js", "mjs", "cjs"].iter().any(|value| extension == *value)) { return false; }
    let mut prefix = Vec::new();
    if let Ok(file) = fs::File::open(path) { let _ = file.take(256).read_to_end(&mut prefix); }
    let first_line = String::from_utf8_lossy(&prefix).lines().next().unwrap_or("").to_string();
    !(first_line.starts_with("#!") && first_line.contains("node"))
}

fn node_version(node: &Path) -> Result<String, String> {
    const REQUIRED: (u32, u32) = (22, 19);
    let mut command = Command::new(node);
    command.arg("--version");
    // Without this the packaged Windows build flashes a console window on every
    // launch: this probe runs before any session exists.
    crate::hide_window_console(&mut command);
    let output = command
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

/// Every file the app insists on before Pi may start. The diagnostics page
/// renders the same list, so a runtime file cleaned up by an installer or an
/// antivirus is visible inside the app instead of only as a failed launch.
fn required_resources(
    resources_dir: &Path,
    node_modules: &Path,
    extension: &Path,
) -> Vec<(PathBuf, &'static str)> {
    vec![
        (
            resources_dir.join("pi-runtime/index.js"),
            "Pi SDK",
        ),
        (
            resources_dir.join("pi-runtime/provider-auth.js"),
            "Provider authentication helper",
        ),
        (
            resources_dir.join("pi-runtime/terminal.js"),
            "Private terminal launcher",
        ),
        (extension.to_path_buf(), "GUI extension"),
        (
            resources_dir.join("context-payload.ts"),
            "Context payload helper",
        ),
        (
            resources_dir.join("request-budget.ts"),
            "Request budget helper",
        ),
        (resources_dir.join("question.ts"), "Question tool helper"),
        (
            resources_dir.join("workspace.ts"),
            "Workspace roots helper",
        ),
        (
            resources_dir.join("subagents/index.ts"),
            "Subagent extension",
        ),
        (
            resources_dir.join("computer-use/mode.ts"),
            "Computer use extension",
        ),
        (
            node_modules.join("@typesafe-ai/sdk/package.json"),
            "TypeSafe SDK",
        ),
        (
            node_modules.join("@mariozechner/clipboard/package.json"),
            "Clipboard runtime",
        ),
    ]
}

#[derive(Clone)]
pub(crate) struct RuntimePaths {
    pub(crate) home: PathBuf,
    pub(crate) agent_dir: PathBuf,
    pub(crate) sessions_dir: PathBuf,
    pub(crate) resources_dir: PathBuf,
    pub(crate) node: PathBuf,
    pub(crate) host_node: PathBuf,
    pub(crate) node_version: String,
    pub(crate) pi: PathBuf,
    pub(crate) pi_source: &'static str,
    pub(crate) pi_executable: bool,
    pub(crate) launch_args: Vec<String>,
    pub(crate) settings: crate::pi_runtime_settings::PiRuntimeSettings,
    pub(crate) pi_version: String,
    /// The probe that produced `pi_version`. `pi_version` is `"unknown"` when it
    /// failed; the diagnostics page and `probe_pi_runtime` read the detail here.
    pub(crate) probe: ProbeOutcome,
    pub(crate) node_modules: PathBuf,
    pub(crate) extension: PathBuf,
}

impl RuntimePaths {
    pub(crate) fn resolve(app: &AppHandle, cwd: &Path) -> Result<Self, String> {
        Self::resolve_with_settings(app, cwd, crate::pi_runtime_settings::load()?)
    }

    pub(crate) fn resolve_with_settings(app: &AppHandle, cwd: &Path, settings: crate::pi_runtime_settings::PiRuntimeSettings) -> Result<Self, String> {
        let home = home_dir()?;
        let agent_dir = settings.agent_dir()?;
        let launch_args = settings.arguments()?;
        let sessions_dir = agent_dir.join("sessions");
        // `resource_dir()` is unavailable in some Tauri dev runners (it
        // returns the opaque `unknown path` error). Resolve the same directory
        // through the resource base first, then keep the packaged-app fallback.
        let resources_dir = app
            .path()
            .resolve("resources", BaseDirectory::Resource)
            .or_else(|_| app.path().resource_dir().map(|path| path.join("resources")))
            .map_err(|error| format!("无法定位 Orbit resources：{error}"))?;
        let host_node = bundled_node_path(app)?;
        let node_version = node_version(&host_node)?;
        let node = orbit_process_node(host_node.clone(), app, &node_version)?;
        let (pi, pi_source) = if let Some(configured) = settings.resolved_binary()? {
            (configured, "configured")
        } else {
            let (pi, source) = pi_path_for_project(Some(app), cwd)?;
            if source != "bundled" { return Err("Orbit 内置 Pi runtime 缺失，请重新安装应用".into()); }
            (pi, source)
        };
        let pi_executable = pi_is_executable(&pi);
        let node_modules = resources_dir.join("node_modules");
        let extension = resources_dir.join("gui-extension.ts");
        require_file(&pi, "Pi CLI")?;
        for (path, label) in required_resources(&resources_dir, &node_modules, &extension) {
            require_file(&path, label)?;
        }
        // Computer Use is optional. A dev checkout may not have run the native
        // worker build yet, but that must never prevent ordinary Pi sessions
        // from connecting; the feature reports its own unavailable state when
        // the user actually enables it.
        require_dir(&node_modules, "Node modules")?;
        // A failed probe is reported, not fatal. Turning it into one error here
        // used to make the whole application unusable with a single opaque
        // toast; the diagnostics page now shows the real reason, and a session
        // that really cannot start fails with Pi's own stderr attached.
        let probe = pi_version(&node, &pi, pi_executable, &settings);
        let pi_version = probe
            .version
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
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
            pi_executable,
            probe,
            launch_args,
            settings,
            pi_version,
            node_modules,
            extension,
        })
    }

    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(if self.pi_executable { &self.pi } else { &self.node });
        if !self.pi_executable { command.arg(&self.pi); }
        self.apply_environment(&mut command);
        crate::hide_window_console(&mut command);
        command
    }

    pub(crate) fn apply_environment(&self, command: &mut Command) {
        self.settings.apply_environment(command);
        command.env("PI_CODING_AGENT_DIR", &self.agent_dir)
            .env("ORBIT_PI_EXECUTABLE", if self.pi_executable { "1" } else { "0" });
    }

    pub(crate) fn diagnostics(&self, cwd: &Path) -> Value {
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
            "piExecutable": self.pi_executable,
            "nodeModules": &self.node_modules,
            "extension": &self.extension,
            "launchArgs": &self.launch_args,
            "probe": self.probe.json(),
            "cwd": cwd,
        })
    }
}

/// A never-failing runtime report for the diagnostics page.
///
/// `RuntimePaths::resolve` deliberately refuses to start without a complete
/// runtime, which is exactly when a report is needed. This function therefore
/// repeats the same steps without short-circuiting and collects one entry per
/// step, so the page can show a broken install instead of an empty error.
#[cfg(desktop)]
pub(crate) fn runtime_health(
    app: &AppHandle,
    cwd: &Path,
    settings: crate::pi_runtime_settings::PiRuntimeSettings,
) -> Value {
    let public = settings.public_view();
    let home = home_dir();
    let resources_dir = app
        .path()
        .resolve("resources", BaseDirectory::Resource)
        .or_else(|_| app.path().resource_dir().map(|path| path.join("resources")));
    let node_modules = resources_dir
        .as_ref()
        .ok()
        .map(|dir| dir.join("node_modules"));
    let extension = resources_dir
        .as_ref()
        .ok()
        .map(|dir| dir.join("gui-extension.ts"));

    // Node: the version check is the first thing a broken install fails.
    let host_node = bundled_node_path(app);
    let node_report = match &host_node {
        Ok(path) => {
            let started = std::time::Instant::now();
            let result = node_version(path);
            json!({
                "path": path.display().to_string(),
                "exists": path.is_file(),
                "version": result.as_ref().ok(),
                "error": result.as_ref().err(),
                "elapsedMs": started.elapsed().as_millis() as u64,
            })
        }
        Err(error) => json!({ "path": Value::Null, "exists": false, "error": error }),
    };

    // Pi: which file Orbit would launch, and what happened when it did.
    let (pi, pi_source) = match settings.resolved_binary() {
        Ok(Some(configured)) => (Some(configured), "configured"),
        Ok(None) => match pi_path_for_project(Some(app), cwd) {
            Ok((path, source)) => (Some(path), source),
            Err(_) => (None, "missing"),
        },
        Err(_) => (None, "invalid"),
    };
    let probe = match (&host_node, &pi) {
        (Ok(node), Some(pi)) => {
            let executable = pi_is_executable(pi);
            let outcome = pi_version(node, pi, executable, &settings);
            json!({
                "executable": executable,
                "probe": outcome.json(),
            })
        }
        _ => json!({ "executable": Value::Null, "probe": Value::Null }),
    };

    let resources = match (&resources_dir, &node_modules, &extension) {
        (Ok(dir), Some(node_modules), Some(extension)) => required_resources(dir, node_modules, extension)
            .into_iter()
            .map(|(path, label)| {
                json!({
                    "label": label,
                    "path": path.display().to_string(),
                    "exists": path.is_file(),
                })
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let resources_error = resources_dir
        .as_ref()
        .err()
        .map(|error| error.to_string());
    let node_modules_report = node_modules.as_ref().map(|path| {
        json!({
            "path": path.display().to_string(),
            "exists": path.is_dir(),
        })
    });

    json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "home": home.as_ref().ok().map(|path| path.display().to_string()),
        "homeError": home.as_ref().err().cloned(),
        "cwd": cwd.display().to_string(),
        "resourcesDir": resources_dir.as_ref().ok().map(|path| path.display().to_string()),
        "resourcesError": resources_error,
        "nodeModules": node_modules_report,
        "node": node_report,
        "pi": json!({
            "path": pi.as_ref().map(|path| path.display().to_string()),
            "source": pi_source,
            "exists": pi.as_ref().is_some_and(|path| path.is_file()),
        }),
        "probe": probe,
        "resources": resources,
        "agentDir": public.agent_dir().ok().map(|path| path.display().to_string()),
        "agentDirError": public.agent_dir().err(),
        "launchArgs": public.launch_args,
        "environment": public
            .environment
            .iter()
            .map(|variable| json!({
                "name": variable.name,
                "sensitive": variable.sensitive,
                "hasValue": !variable.value.is_empty(),
            }))
            .collect::<Vec<_>>(),
    })
}

fn orbit_process_node(node: PathBuf, app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        macos_orbit_agent(&node, app, version)
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

pub(crate) fn apply_orbit_runtime_env(
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
    // Browser Use: the Pi extension drives the same Chrome the dock shows, and
    // it gets there by running this binary with `--browser-ensure` (browser.rs).
    // The path travels explicitly because `tauri dev` and the bundled app have
    // different locations, and the extension must not guess either.
    if let Ok(executable) = std::env::current_exe() {
        command.env("ORBIT_APP_BINARY", executable);
    }
    if let Ok(key_path) = typesafe_key_path() {
        command.env("ORBIT_TYPESAFE_KEY_PATH", key_path);
    }
    // Computer Use decision backend: Jev (TypeSafe/SystemOne) or Cloudflare
    // Clef. The non-secret selection travels as plain values; secrets are
    // passed as file paths so no key is copied into the process environment.
    let computer_use = read_computer_use_config();
    command.env(
        "ORBIT_CU_DECISION_MODEL",
        computer_use_decision_model(&computer_use),
    );
    command.env("ORBIT_CU_JEV_MODEL", computer_use_jev_model(&computer_use));
    if let Some(account) = computer_use
        .get("cloudflareAccountId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        command.env("ORBIT_CF_ACCOUNT_ID", account);
    }
    if let Some(base) = computer_use
        .get("systemoneBaseUrl")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        command.env("ORBIT_CU_SYSTEMONE_BASE_URL", base);
    }
    if let Ok(token_path) = cloudflare_token_path() {
        command.env("ORBIT_CF_API_TOKEN_PATH", token_path);
    }
    // Extension imports are resolved only from Orbit's pinned resources.
    // User NODE_PATH entries can contain incompatible copies of these packages.
    command.env("NODE_PATH", node_modules);
}
/// 命令输出带进界面之前先截断：安装日志可能很长，但用户要看的是结尾。
pub(crate) fn clip_output(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let kept: String = trimmed
        .chars()
        .skip(trimmed.chars().count() - limit)
        .collect();
    format!("[前段省略]\n{kept}")
}

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "找不到用户目录".into())
}
pub(crate) fn project(cwd: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|e| format!("工作目录不可用：{e}"))?;
    if !path.is_dir() {
        return Err("请选择文件夹".into());
    }
    Ok(path)
}

pub(crate) fn read_json_file(path: PathBuf, label: &str) -> Result<Value, String> {
    serde_json::from_str(&fs::read_to_string(path).map_err(|_| format!("{label} 不可读"))?)
        .map_err(|_| format!("{label} 不是有效 JSON"))
}

/// 写一份 0600 的 JSON：凭据和本机配置都落在这个形状上。
///
/// 权限是内容的一部分：`auth.json` 里是 API key，`request-budget.json` 决定请求带
/// 多少历史，都不该比登录用户更公开。写失败要报出真实的 IO 错误，静默降级成 0644
/// 才是更糟的那种“成功”。
pub(crate) fn write_private_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 {} 权限失败：{e}", path.display()))?;
    }
    file.write_all((text + "\n").as_bytes()).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(())
}

pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    // 与 SDK getAgentDir() 同源：尊重 PI_CODING_AGENT_DIR，否则 ~/.pi/agent。
    crate::sessions::agent_dir()
}

pub(crate) fn sessions_dir() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("sessions"))
}

pub(crate) fn settings_path(dir: &std::path::Path) -> PathBuf {
    dir.join("settings.json")
}
