//! The Pi RPC worker: one long-lived `pi --mode rpc` process per connection,
//! its stdin writer, and the stdout/stderr/exit threads that feed the UI channel.
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, State};

#[cfg(desktop)]
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use crate::bridge::{
    apply_orbit_runtime_env, project, remove_worker_if_current, Bridge, RuntimePaths, Worker,
};
#[cfg(target_os = "linux")]
use crate::bridge::executable;
use crate::mcp::ensure_mcp_auto_codemode_default;
use crate::providers::repair_custom_model_costs;

pub(crate) fn safe_pi_diagnostic(lines: &[String], home: &Path) -> Option<String> {
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

pub(crate) fn is_pi_burst_event(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| PI_BURST_EVENT_TYPES.contains(&kind))
}

/// 攒批状态机（独立出来便于单测）。
pub(crate) struct PiEventBatch {
    events: Vec<Value>,
    since: Instant,
    max: usize,
    window: Duration,
}

impl PiEventBatch {
    pub(crate) fn new(max: usize, window: Duration) -> Self {
        Self { events: Vec::new(), since: Instant::now(), max, window }
    }

    /// 记一个连发事件；`drain_more` = 上游缓冲区里还有待读数据。
    /// 返回 `Some(批次)` 表示现在就该把这一批发出去。
    pub(crate) fn push(&mut self, value: Value, drain_more: bool) -> Option<Vec<Value>> {
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
    pub(crate) fn take(&mut self) -> Option<Vec<Value>> {
        if self.events.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.events))
    }
}

/// One-shot text generation through the project's Pi CLI (no session, no tools).
/// Powers AI commit messages and PR descriptions without touching the chat.
#[tauri::command]
pub async fn pi_oneshot(app: AppHandle, cwd: String, prompt: String) -> Result<String, String> {
    #[cfg(mobile)]
    {
        let _ = (&app, &cwd, &prompt);
        return Err("移动端通过 Orbit Host 使用 Pi，不能启动本地 Pi 进程".into());
    }
    #[cfg(desktop)]
    {
        let path = project(&cwd)?;
        let runtime = RuntimePaths::resolve(&app, &path)?;
        let pi = runtime.pi.clone();
        let node = runtime.node.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let output = Command::new(&node)
                .arg(&pi)
                .args([
                    "--print",
                    "--no-session",
                    "--no-extensions",
                    "--no-skills",
                    "--no-tools",
                ])
                .arg(&prompt)
                .current_dir(&path)
                .stdin(Stdio::null())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return Err(if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    format!("pi 退出码 {:?}", output.status.code())
                });
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Pi's stdout pump: JSONL in, one Channel message per batch out.
///
/// 历史里的图片落盘后换成路径：桌面 webview 不该为它们付 169 MB 的 IPC 和内存
/// （见 `media::offload_history` 里的测量）。
#[cfg(desktop)]
fn pi_reader_loop(
    stdout: ChildStdout,
    output_channel: Channel<Value>,
    remote_app: AppHandle,
    remote_project: String,
    media_dir: Option<PathBuf>,
) {
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
                Ok(mut value) => {
                    // 手机先拿到原样的 payload：它读不到本机路径，图片还是 base64。
                    crate::remote::publish_pi_event(&remote_app, &remote_project, &value);
                    if let Some(dir) = media_dir.as_deref() {
                        crate::media::offload_history(&mut value, dir);
                    }
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
                    if let Some(events) = batch.take() { if !send_batch(events) { break } }
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
}

/// Poll the child for exit, then publish the redacted diagnostic once. The
/// stderr thread is joined first so its last lines are part of it.
#[cfg(desktop)]
#[allow(clippy::too_many_arguments)]
fn spawn_exit_watcher(
    stderr_thread: thread::JoinHandle<()>,
    workers: Arc<Mutex<HashMap<String, Worker>>>,
    watched_child: Arc<Mutex<Child>>,
    watched_id: String,
    on_event: Channel<Value>,
    exit_app: AppHandle,
    diagnostic_lines: Arc<Mutex<Vec<String>>>,
    diagnostic_home: PathBuf,
) {
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
        ensure_mcp_auto_codemode_default(&runtime.agent_dir)?;
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
        let media_dir = crate::media::session_media_dir(&app);
        thread::spawn(move || {
            pi_reader_loop(stdout, output_channel, remote_app, remote_project, media_dir)
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
        spawn_exit_watcher(
            stderr_thread,
            workers,
            watched_child,
            watched_id,
            on_event,
            exit_app,
            diagnostic_lines,
            diagnostic_home,
        );
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
                if status.success() {
                    Ok(())
                } else {
                    Err("无法打开系统终端".into())
                }
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
