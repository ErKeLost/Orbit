//! Pi 会话索引的原生实现。
//!
//! 之前 `list_sessions` 每次都 spawn 一个新 Node 进程：Node 冷启动 + 动态 import
//! 整个 Pi SDK（数百毫秒）之后，`SessionManager.list` 把全部会话 JSONL 完整解析
//! 一遍（还顺手拼出被立刻丢弃的 `allMessagesText`），随后每个会话再
//! `open().getEntries()` 把同一个文件完整解析第二遍来找 icon。大会话目录上单次
//! 刷新轻松超过 1.5s，而新建/切换会话都会触发刷新。
//!
//! 这里直接在 Rust 里单遍扫描 JSONL，并按 (mtime, size) 做增量缓存：缓存命中
//! 零解析，新建会话后只有新文件需要扫描，整表在毫秒级返回。字段语义与 SDK
//! 的 `SessionManager.list` 保持一致（header 校验、name 覆盖、firstMessage 取
//! 第一条带文本的用户消息、modified 取消息时间最大值等）。

use serde::Deserialize;
use serde_json::{Map, Number, Value};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

/// SDK 的 ENV_AGENT_DIR（`APP_NAME.toUpperCase()}_CODING_AGENT_DIR`）。
const ENV_AGENT_DIR: &str = "PI_CODING_AGENT_DIR";
/// gui 扩展写入会话 icon 的自定义条目类型。
const META_MARKER: &[u8] = b"pi-gui-session-meta";
const COMPACT_TYPE_PREFIX: &[u8] = b"{\"type\":\"";

// ---------------------------------------------------------------------------
// 目录布局
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "找不到用户目录".into())
}

/// 与 SDK `getAgentDir()` 一致：尊重 `PI_CODING_AGENT_DIR`（支持 ~ 前缀），
/// 否则 `~/.pi/agent`。
pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(ENV_AGENT_DIR).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        if path.as_os_str() == "~" {
            return home_dir();
        }
        if let Ok(rest) = path.strip_prefix("~") {
            return Ok(home_dir()?.join(rest));
        }
        return Ok(path);
    }
    Ok(home_dir()?.join(".pi/agent"))
}

/// 全部会话的根目录（`~/.pi/agent/sessions`）。
pub(crate) fn sessions_root() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("sessions"))
}

/// 复刻 SDK `getDefaultSessionDirPath`：`sessions/--<cwd 中 / \ : 换成 --->--`。
pub(crate) fn encoded_sessions_dir(cwd: &Path) -> PathBuf {
    let text = cwd.to_string_lossy();
    let trimmed = text
        .strip_prefix('/')
        .or_else(|| text.strip_prefix('\\'))
        .unwrap_or(&text);
    let mut safe = String::from("--");
    safe.extend(trimmed.chars().map(|ch| match ch {
        '/' | '\\' | ':' => '-',
        other => other,
    }));
    safe.push_str("--");
    sessions_root()
        .unwrap_or_else(|_| PathBuf::from("sessions"))
        .join(safe)
}

// ---------------------------------------------------------------------------
// 时间：ISO 8601 <-> 毫秒（无 chrono，自带 civil 日期算法）
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 解析 pi 写入的 ISO 时间戳（`2025-01-02T03:04:05.678Z`，也容忍 ±HH[:]MM 偏移
/// 和空格分隔）。解析失败返回 None，等价 JS `Date.parse` 的 NaN 分支。
pub(crate) fn iso_to_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| {
        let slice = text.get(range)?;
        if slice.bytes().any(|b| !b.is_ascii_digit()) {
            return None;
        }
        slice.parse::<u32>().ok()
    };
    let year = num(0..4)? as i64;
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let month = num(5..7)?;
    let day = num(8..10)?;
    if bytes[10] != b'T' && bytes[10] != b' ' && bytes[10] != b't' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let hour = num(11..13)?;
    let minute = num(14..16)?;
    let second = num(17..19)?;
    let mut rest = &text[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: usize = frac.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits == 0 {
            return None;
        }
        let mut value = String::with_capacity(3);
        for ch in frac[..digits].chars().take(3) {
            value.push(ch);
        }
        while value.len() < 3 {
            value.push('0');
        }
        millis = value.parse::<i64>().ok()?;
        rest = &frac[digits..];
    }
    // 时区：Z / ±HH:MM / ±HHMM / ±HH；缺省按 UTC（pi 自己写的是 Z）。
    let offset_ms = match rest.bytes().next() {
        None => 0,
        Some(b'Z') | Some(b'z') if rest.len() == 1 => 0,
        Some(sign @ (b'+' | b'-')) => {
            let digits: String = rest[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let magnitude = match digits.len() {
                2 => digits.parse::<i64>().ok()? * 3_600_000,
                4 => {
                    digits[..2].parse::<i64>().ok()? * 3_600_000
                        + digits[2..].parse::<i64>().ok()? * 60_000
                }
                _ => return None,
            };
            if sign == b'-' {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    Some(
        days * 86_400_000
            + i64::from(hour) * 3_600_000
            + i64::from(minute) * 60_000
            + i64::from(second) * 1000
            + millis
            + offset_ms,
    )
}

fn ms_to_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let second_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z",
        h = second_of_day / 3600,
        m = (second_of_day % 3600) / 60,
        s = second_of_day % 60,
    )
}

/// 给会话追加一条 `session_info` —— 这正是 pi 的 `setSessionName` 写的那条记录。
///
/// 名字按「最后一条生效」覆盖，所以重命名只需要在文件末尾追加，既不改写历史，
/// 也不会破坏会话树（`parentId` 取文件里最后一条记录的 id，等价于 pi 的 leafId）。
pub fn rename_session_file(path: &Path, name: &str) -> Result<(), String> {
    use std::io::Write;

    let clean = name
        .replace(['\r', '\n'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if clean.is_empty() {
        return Err("标题不能为空".into());
    }
    let clean: String = clean.chars().take(80).collect();

    let content = fs::read(path).map_err(|error| format!("读取会话失败：{error}"))?;
    let mut parent: Option<String> = None;
    for line in content.split(|byte| *byte == b'\n') {
        let line = trim_line(line);
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                parent = Some(id.to_string());
            }
        }
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let entry = serde_json::json!({
        "type": "session_info",
        "id": &id[..8],
        "parentId": parent,
        "timestamp": ms_to_iso(now_ms),
        "name": clean,
    });

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|error| format!("会话文件不可写：{error}"))?;
    if !content.ends_with(b"\n") {
        file.write_all(b"\n").map_err(|error| error.to_string())?;
    }
    writeln!(file, "{entry}").map_err(|error| format!("写入会话失败：{error}"))
}

// ---------------------------------------------------------------------------
// 行级轻量解析
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct KindProbe {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct HeaderLine {
    id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "parentSession")]
    parent_session: Option<String>,
}

#[derive(Deserialize)]
struct InfoLine {
    name: Option<String>,
}

#[derive(Deserialize)]
struct CustomLine {
    #[serde(rename = "customType")]
    custom_type: Option<String>,
    data: Option<Value>,
}

/// message 行的轻量视图：`content` 不具名 → serde 按未知字段快速跳过，
/// 不为图片/长文本买单。
#[derive(Deserialize)]
struct MessageLine {
    timestamp: Option<String>,
    message: Option<RoleStamp>,
}

#[derive(Deserialize)]
struct RoleStamp {
    role: String,
    timestamp: Option<Number>,
}

/// 只有需要提取文本/工具调用 id 的行才用这份完整视图。
#[derive(Deserialize)]
struct MessageFull {
    message: Option<ContentOnly>,
}

#[derive(Deserialize)]
struct ContentOnly {
    content: Option<Value>,
}

/// 提取行首 `{"type":"..."` 的 kind。pi 用 `JSON.stringify` 追加，type 恒为首键；
/// 其他布局回退到让 serde 跳过其余字段的小解析。
fn line_kind(line: &[u8]) -> Option<String> {
    if let Some(rest) = line.strip_prefix(COMPACT_TYPE_PREFIX) {
        let end = rest.iter().position(|&b| b == b'"')?;
        return std::str::from_utf8(&rest[..end]).ok().map(str::to_string);
    }
    serde_json::from_slice::<KindProbe>(line)
        .ok()
        .map(|p| p.kind)
}

/// SDK `extractTextContent`：字符串原样；数组取 text 块用空格连接
/// （JS join 会把 undefined 变空串）。
fn text_of_content(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let mut out = String::new();
            for part in parts {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(part.get("text").and_then(Value::as_str).unwrap_or(""));
                }
            }
            Some(out)
        }
        _ => None,
    }
}

fn number_as_i64(number: &Number) -> Option<i64> {
    number.as_i64().or_else(|| {
        number
            .as_f64()
            .and_then(|v| if v.is_finite() { Some(v as i64) } else { None })
    })
}

// ---------------------------------------------------------------------------
// 单文件扫描
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct SessionSummary {
    pub path: String,
    pub id: Option<String>,
    pub cwd: String,
    pub name: Option<String>,
    pub icon: Option<String>,
    pub created: Option<String>,
    pub modified: String,
    pub modified_ms: i64,
    pub message_count: u64,
    pub first_message: String,
    pub parent_session_path: Option<String>,
}

pub(crate) fn summary_to_value(summary: &SessionSummary) -> Value {
    let mut object = Map::new();
    object.insert("path".into(), Value::from(summary.path.clone()));
    if let Some(id) = &summary.id {
        object.insert("id".into(), Value::from(id.clone()));
    }
    object.insert("cwd".into(), Value::from(summary.cwd.clone()));
    if let Some(name) = &summary.name {
        object.insert("name".into(), Value::from(name.clone()));
    }
    if let Some(icon) = &summary.icon {
        object.insert("icon".into(), Value::from(icon.clone()));
    }
    object.insert(
        "created".into(),
        match &summary.created {
            Some(created) => Value::from(created.clone()),
            None => Value::Null,
        },
    );
    object.insert("modified".into(), Value::from(summary.modified.clone()));
    object.insert("messageCount".into(), Value::from(summary.message_count));
    object.insert(
        "firstMessage".into(),
        Value::from(summary.first_message.clone()),
    );
    if let Some(parent) = &summary.parent_session_path {
        object.insert("parentSessionPath".into(), Value::from(parent.clone()));
    }
    Value::Object(object)
}

/// 单遍扫描一个会话 JSONL。没有合法 session header 的文件返回 None
/// （与 SDK `buildSessionInfo` 一致）。
fn scan_session_file(path: &Path, fallback_mtime_ms: i64) -> Option<SessionSummary> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut raw: Vec<u8> = Vec::with_capacity(8192);
    let mut header: Option<HeaderLine> = None;
    let mut name: Option<String> = None;
    let mut message_count: u64 = 0;
    let mut last_activity_ms: Option<i64> = None;
    let mut first_message: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut need_first_user_text = true;
    loop {
        raw.clear();
        if reader.read_until(b'\n', &mut raw).ok()? == 0 {
            break;
        }
        let line = trim_line(&raw);
        if line.is_empty() {
            continue;
        }
        let Some(kind) = line_kind(line) else {
            continue;
        };
        match kind.as_str() {
            // SDK 要求第一条可解析记录是 session header，否则整个文件视为无效。
            "session" if header.is_none() => {
                header = serde_json::from_slice::<HeaderLine>(line).ok();
            }
            "session_info" => {
                if let Ok(info) = serde_json::from_slice::<InfoLine>(line) {
                    name = info
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|clean| !clean.is_empty())
                        .map(str::to_string);
                }
            }
            "custom" if line.len() >= META_MARKER.len() => {
                // 先做字节级子串过滤，绝大多数 custom 条目在这里就被跳过。
                if line
                    .windows(META_MARKER.len())
                    .any(|window| window == META_MARKER)
                {
                    if let Ok(custom) = serde_json::from_slice::<CustomLine>(line) {
                        if custom.custom_type.as_deref() == Some("pi-gui-session-meta") {
                            if let Some(icon_text) = custom
                                .data
                                .as_ref()
                                .and_then(|data| data.get("icon"))
                                .and_then(Value::as_str)
                            {
                                icon = Some(icon_text.to_string());
                            }
                        }
                    }
                }
            }
            "message" => {
                message_count += 1;
                let Ok(line_msg) = serde_json::from_slice::<MessageLine>(line) else {
                    continue;
                };
                let Some(message) = line_msg.message else {
                    continue;
                };
                let role = message.role.as_str();
                if role != "user" && role != "assistant" {
                    continue;
                }
                // 活动时间 = message.timestamp（数字）否则 entry.timestamp（ISO）。
                let activity = message
                    .timestamp
                    .as_ref()
                    .and_then(number_as_i64)
                    .or_else(|| line_msg.timestamp.as_deref().and_then(iso_to_ms));
                if let Some(at) = activity {
                    last_activity_ms = Some(last_activity_ms.map_or(at, |best| best.max(at)));
                }
                // firstMessage = 第一条**带文本**的用户消息。
                if need_first_user_text && role == "user" {
                    if let Ok(full) = serde_json::from_slice::<MessageFull>(line) {
                        if let Some(content) = full.message.and_then(|m| m.content) {
                            if let Some(text) = text_of_content(&content) {
                                if !text.is_empty() {
                                    first_message = Some(text);
                                    need_first_user_text = false;
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let header = header?;
    let header_ms = header.timestamp.as_deref().and_then(iso_to_ms);
    let modified_ms = last_activity_ms.or(header_ms).unwrap_or(fallback_mtime_ms);
    Some(SessionSummary {
        path: path.to_string_lossy().into_owned(),
        id: header.id,
        cwd: header.cwd.unwrap_or_default(),
        name,
        icon,
        created: header_ms.map(ms_to_iso),
        modified: ms_to_iso(modified_ms),
        modified_ms,
        message_count,
        first_message: first_message.unwrap_or_else(|| "(no messages)".into()),
        parent_session_path: header.parent_session,
    })
}

fn trim_line(raw: &[u8]) -> &[u8] {
    let mut line = raw;
    while let [rest @ .., last] = line {
        if last.is_ascii_whitespace() {
            line = rest;
        } else {
            break;
        }
    }
    while let [first, rest @ ..] = line {
        if first.is_ascii_whitespace() {
            line = rest;
        } else {
            break;
        }
    }
    line
}

// ---------------------------------------------------------------------------
// 列表 + (mtime, size) 增量缓存
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct FileStamp {
    mtime_secs: i64,
    mtime_nanos: u32,
    size: u64,
}

struct CachedFile {
    stamp: FileStamp,
    summary: SessionSummary,
}

type ListCacheMap = HashMap<PathBuf, HashMap<String, CachedFile>>;

/// dir -> 文件名 -> 缓存。按目录分桶，互不挤占。
static LIST_CACHE: Mutex<Option<ListCacheMap>> = Mutex::new(None);

fn with_list_cache<T>(action: impl FnOnce(&mut ListCacheMap) -> T) -> T {
    let mut guard = LIST_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    action(guard.get_or_insert_with(HashMap::new))
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = fs::metadata(path).ok()?;
    let mtime = metadata.modified().ok()?;
    let elapsed = mtime.duration_since(UNIX_EPOCH).ok()?;
    Some(FileStamp {
        mtime_secs: elapsed.as_secs() as i64,
        mtime_nanos: elapsed.subsec_nanos(),
        size: metadata.len(),
    })
}

fn stamp_matches(stamp: &FileStamp, cached: &FileStamp) -> bool {
    stamp.mtime_secs == cached.mtime_secs
        && stamp.mtime_nanos == cached.mtime_nanos
        && stamp.size == cached.size
}

fn fallback_mtime_ms(stamp: Option<FileStamp>) -> i64 {
    stamp.map_or(0, |s| {
        s.mtime_secs * 1000 + i64::from(s.mtime_nanos) / 1_000_000
    })
}

/// 列出某个项目的全部会话（与 SDK `SessionManager.list(cwd)` 同源同序）。
pub(crate) fn list_project_sessions(cwd: &Path) -> Result<Vec<SessionSummary>, String> {
    let dir = encoded_sessions_dir(cwd);
    let read_dir = match fs::read_dir(&dir) {
        Ok(read) => read,
        // SDK 对不存在的目录返回空列表。
        Err(_) => return Ok(Vec::new()),
    };
    let mut files: Vec<(String, PathBuf)> = read_dir
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".jsonl"))
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            )
        })
        .collect();
    // SDK 先按文件名倒序，再按 modified 稳定排序，同名平局顺序可复现。
    files.sort_by(|a, b| b.0.cmp(&a.0));

    let mut stamps: Vec<Option<FileStamp>> = Vec::with_capacity(files.len());
    let mut slots: Vec<Option<SessionSummary>>;
    let mut misses: Vec<usize> = Vec::new();
    {
        let mut hit_by_index: Vec<Option<SessionSummary>> = Vec::with_capacity(files.len());
        with_list_cache(|cache| {
            let per_dir = cache.entry(dir.clone()).or_default();
            for (file_name, path) in files.iter() {
                let stamp = file_stamp(path);
                let hit = stamp.and_then(|fresh| {
                    per_dir
                        .get(file_name)
                        .filter(|cached| stamp_matches(&fresh, &cached.stamp))
                        .map(|cached| cached.summary.clone())
                });
                if hit.is_none() {
                    misses.push(hit_by_index.len());
                }
                stamps.push(stamp);
                hit_by_index.push(hit);
            }
        });
        slots = hit_by_index;
    }

    // 冷扫描并行化：miss 分片给多个线程，只花一次的钱。
    if !misses.is_empty() {
        let chunk = misses.len().div_ceil(scan_threads(misses.len()));
        let scanned: Mutex<Vec<(usize, Option<SessionSummary>)>> = Mutex::new(Vec::new());
        std::thread::scope(|scope| {
            for group in misses.chunks(chunk.max(1)) {
                let files = &files;
                let stamps = &stamps;
                let scanned = &scanned;
                scope.spawn(move || {
                    for index in group {
                        let summary =
                            scan_session_file(&files[*index].1, fallback_mtime_ms(stamps[*index]));
                        if let Ok(mut bucket) = scanned.lock() {
                            bucket.push((*index, summary));
                        }
                    }
                });
            }
        });
        let bucket = scanned.lock().ok();
        with_list_cache(|cache| {
            let per_dir = cache.entry(dir.clone()).or_default();
            if let Some(bucket) = bucket.as_ref() {
                for (index, summary) in bucket.iter() {
                    slots[*index] = summary.clone();
                    match (summary, stamps[*index]) {
                        (Some(summary), Some(stamp)) => {
                            per_dir.insert(
                                files[*index].0.clone(),
                                CachedFile {
                                    stamp,
                                    summary: summary.clone(),
                                },
                            );
                        }
                        // 解析失败的文件不入缓存，下次列表重试。
                        _ => {
                            per_dir.remove(&files[*index].0);
                        }
                    }
                }
            }
        });
    }

    // 剪掉已消失的缓存项，避免删除会话后残留。
    with_list_cache(|cache| {
        if let Some(per_dir) = cache.get_mut(&dir) {
            let live: std::collections::HashSet<&str> =
                files.iter().map(|(name, _)| name.as_str()).collect();
            per_dir.retain(|name, _| live.contains(name.as_str()));
        }
    });

    let mut list: Vec<SessionSummary> = slots.into_iter().flatten().collect();
    list.sort_by_key(|summary| std::cmp::Reverse(summary.modified_ms));
    Ok(list)
}

fn scan_threads(misses: usize) -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(8)
        .min(misses)
        .max(1)
}

// ---------------------------------------------------------------------------
// 会话内每轮耗时（原 `session_turn_durations` 的 Node 脚本原生版）
// ---------------------------------------------------------------------------

struct TurnScan {
    start: Option<i64>,
    end: Option<i64>,
    id: Option<String>,
}

/// 复刻原 Node 脚本：user 消息开一轮，assistant 消息补 id（message.timestamp
/// 优先，否则第一个 toolCall id）并推进 end；输出 `轮id -> 毫秒`。
pub(crate) fn turn_durations(path: &Path) -> Result<Value, String> {
    let file = File::open(path).map_err(|e| format!("会话文件不可读：{e}"))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut raw: Vec<u8> = Vec::with_capacity(8192);
    let mut out = Map::new();
    let mut turn: Option<TurnScan> = None;
    let flush = |turn: &mut Option<TurnScan>, out: &mut Map<String, Value>| {
        if let Some(finished) = turn.take() {
            if let (Some(start), Some(end), Some(id)) = (finished.start, finished.end, finished.id)
            {
                if end >= start {
                    out.insert(id, Value::from(end - start));
                }
            }
        }
    };
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("会话文件不可读：{error}")),
        }
        let line = trim_line(&raw);
        if line.is_empty() {
            continue;
        }
        let Some(kind) = line_kind(line) else {
            continue;
        };
        if kind != "message" {
            continue;
        }
        let Ok(line_msg) = serde_json::from_slice::<MessageLine>(line) else {
            continue;
        };
        let Some(message) = line_msg.message else {
            continue;
        };
        let at = line_msg.timestamp.as_deref().and_then(iso_to_ms);
        match message.role.as_str() {
            "user" => {
                flush(&mut turn, &mut out);
                turn = Some(TurnScan {
                    start: at,
                    end: None,
                    id: None,
                });
            }
            "assistant" => {
                let Some(active) = turn.as_mut() else {
                    continue;
                };
                if active.id.is_none() {
                    // 序列化用 Number 原样输出，与 JS `${stamp}` 保持一致（不取整）。
                    if let Some(stamp) = message.timestamp.as_ref().map(Number::to_string) {
                        active.id = Some(format!("timestamp:{stamp}"));
                    } else if let Ok(full) = serde_json::from_slice::<MessageFull>(line) {
                        if let Some(Value::Array(parts)) = full.message.and_then(|m| m.content) {
                            for part in parts {
                                if part.get("type").and_then(Value::as_str) == Some("toolCall") {
                                    if let Some(id) = part.get("id").and_then(Value::as_str) {
                                        active.id = Some(format!("tool:{id}"));
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(at) = at {
                    active.end = Some(at);
                }
            }
            _ => {}
        }
    }
    flush(&mut turn, &mut out);
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "orbit-sessions-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(path: &Path, lines: &[String]) {
        let mut file = File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn header_json(id: &str, cwd: &str, timestamp: &str) -> String {
        format!(r#"{{"type":"session","id":"{id}","cwd":"{cwd}","timestamp":"{timestamp}"}}"#)
    }

    fn message_json(role: &str, content: &str, timestamp: &str, message_timestamp: u64) -> String {
        format!(
            r#"{{"type":"message","id":"m-{timestamp}","timestamp":"{timestamp}","message":{{"role":"{role}","content":"{content}","timestamp":{message_timestamp}}}}}"#
        )
    }

    // 2025-03-01T10:00:00Z
    const T_10: u64 = 1_740_823_200_000;

    #[test]
    fn encodes_session_dir_like_sdk() {
        let dir = encoded_sessions_dir(Path::new("/Users/work/pi-gui"));
        assert_eq!(dir.file_name().unwrap(), "--Users-work-pi-gui--");
        assert!(dir.starts_with(agent_dir().unwrap().join("sessions")));
    }

    #[test]
    fn scans_summary_fields() {
        let dir = temp_dir("scan");
        let path = dir.join("a.jsonl");
        write_session(
            &path,
            &[
                header_json("s1", "/tmp/demo", "2025-03-01T10:00:00.000Z"),
                r#"{"type":"session_info","timestamp":"2025-03-01T10:00:01.000Z","name":"  改名会话  "}"#.into(),
                message_json("user", "第一句", "2025-03-01T10:00:02.000Z", T_10 + 2_000),
                message_json("assistant", "回复", "2025-03-01T10:00:09.000Z", T_10 + 9_000),
                r#"{"type":"custom","customType":"pi-gui-session-meta","data":{"icon":"bug"}}"#.into(),
                message_json("user", "第二句", "2025-03-01T10:01:00.000Z", T_10 + 60_000),
            ],
        );
        let summary = scan_session_file(&path, 0).unwrap();
        assert_eq!(summary.id.as_deref(), Some("s1"));
        assert_eq!(summary.cwd, "/tmp/demo");
        assert_eq!(summary.name.as_deref(), Some("改名会话"));
        assert_eq!(summary.message_count, 3);
        assert_eq!(summary.first_message, "第一句");
        assert_eq!(summary.icon.as_deref(), Some("bug"));
        assert_eq!(summary.created.as_deref(), Some("2025-03-01T10:00:00.000Z"));
        assert_eq!(summary.modified, "2025-03-01T10:01:00.000Z");
        assert_eq!(summary.parent_session_path, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_appends_a_session_info_entry() {
        let dir = temp_dir("rename");
        let path = dir.join("a.jsonl");
        write_session(
            &path,
            &[
                header_json("s1", "/tmp/demo", "2025-03-01T10:00:00.000Z"),
                message_json("user", "第一句", "2025-03-01T10:00:02.000Z", T_10 + 2_000),
            ],
        );

        rename_session_file(&path, "  发布  流程\n梳理  ").unwrap();

        let summary = scan_session_file(&path, 0).unwrap();
        assert_eq!(summary.name.as_deref(), Some("发布 流程 梳理"));
        // 追加不动历史：消息还在，标题只是最后一条 session_info
        assert_eq!(summary.message_count, 1);
        assert_eq!(summary.first_message, "第一句");

        let raw = fs::read_to_string(&path).unwrap();
        let last = raw.lines().last().unwrap();
        assert!(last.contains("\"type\":\"session_info\""));
        assert!(last.contains("\"parentId\":\""));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rejects_an_empty_name() {
        let dir = temp_dir("rename-empty");
        let path = dir.join("a.jsonl");
        write_session(
            &path,
            &[header_json("s1", "/tmp/demo", "2025-03-01T10:00:00.000Z")],
        );
        assert!(rename_session_file(&path, "   \n  ").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_files_without_session_header() {
        let dir = temp_dir("header");
        let path = dir.join("broken.jsonl");
        write_session(
            &path,
            &[r#"{"type":"message","message":{"role":"user","content":"hi"}}"#.into()],
        );
        assert!(scan_session_file(&path, 0).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_message_skips_empty_user_texts() {
        let dir = temp_dir("first");
        let path = dir.join("a.jsonl");
        write_session(
            &path,
            &[
                header_json("s1", "/tmp/demo", "2025-03-01T10:00:00.000Z"),
                message_json("user", "", "2025-03-01T10:00:01.000Z", T_10 + 1_000),
                format!(
                    r#"{{"type":"message","timestamp":"2025-03-01T10:00:02.000Z","message":{{"role":"user","content":[{{"type":"image"}},{{"type":"text","text":"图片之后的问题"}}],"timestamp":2}}}}"#
                ),
            ],
        );
        let summary = scan_session_file(&path, 0).unwrap();
        assert_eq!(summary.first_message, "图片之后的问题");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn listing_sorts_and_caches() {
        let cwd = temp_dir("list-root");
        let dir = encoded_sessions_dir(&cwd);
        fs::create_dir_all(&dir).unwrap();
        write_session(
            &dir.join("new.jsonl"),
            &[header_json(
                "n1",
                cwd.to_str().unwrap(),
                "2025-03-02T10:00:00.000Z",
            )],
        );
        write_session(
            &dir.join("old.jsonl"),
            &[header_json(
                "o1",
                cwd.to_str().unwrap(),
                "2025-03-01T10:00:00.000Z",
            )],
        );
        let listed = list_project_sessions(&cwd).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id.as_deref(), Some("n1"));

        // 缓存命中：不变更文件时重复调用结果一致。
        let again = list_project_sessions(&cwd).unwrap();
        assert_eq!(again[0].id.as_deref(), Some("n1"));

        // 追加内容（size 变化）→ 只重扫该文件，modified 变化。
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(dir.join("old.jsonl"))
            .unwrap();
        // 2025-03-05T10:00:00Z：必须晚于 new.jsonl 的 header 时间才能翻转排序。
        writeln!(
            file,
            "{}",
            message_json(
                "user",
                "追加了",
                "2025-03-05T10:00:00.000Z",
                1_741_168_800_000
            )
        )
        .unwrap();
        let refreshed = list_project_sessions(&cwd).unwrap();
        assert_eq!(refreshed[0].id.as_deref(), Some("o1"));
        assert_eq!(refreshed[0].message_count, 1);
        assert_eq!(refreshed[0].first_message, "追加了");

        // 删除文件 → 缓存同步清理。
        fs::remove_file(dir.join("new.jsonl")).unwrap();
        let shrunk = list_project_sessions(&cwd).unwrap();
        assert_eq!(shrunk.len(), 1);
        let names = with_list_cache(|cache| {
            cache
                .get(&dir)
                .map(|per| per.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default()
        });
        assert_eq!(names, ["old.jsonl".to_string()]);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&cwd);
    }

    #[test]
    fn summary_value_matches_protocol_shape() {
        let summary = SessionSummary {
            path: "/p.jsonl".into(),
            id: Some("s1".into()),
            cwd: "/tmp".into(),
            name: None,
            icon: Some("bug".into()),
            created: None,
            modified: "2025-03-01T10:00:00.000Z".into(),
            modified_ms: 1,
            message_count: 3,
            first_message: "hi".into(),
            parent_session_path: None,
        };
        let value = summary_to_value(&summary);
        assert_eq!(value["path"], "/p.jsonl");
        assert_eq!(value["icon"], "bug");
        assert_eq!(value["messageCount"], 3);
        assert!(value.get("name").is_none());
        assert_eq!(value["created"], Value::Null);
    }

    #[test]
    fn turn_durations_tracks_user_assistant_pairs() {
        let dir = temp_dir("turns");
        let path = dir.join("t.jsonl");
        write_session(
            &path,
            &[
                header_json("s1", "/tmp", "2025-03-01T10:00:00.000Z"),
                message_json("user", "q1", "2025-03-01T10:00:01.000Z", 1),
                message_json("assistant", "a1", "2025-03-01T10:00:05.000Z", 2),
                r#"{"type":"custom","customType":"other"}"#.into(),
                message_json("user", "q2", "2025-03-01T10:01:00.000Z", 3),
                r#"{"type":"message","timestamp":"2025-03-01T10:01:10.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"call-9"}]}}"#.into(),
            ],
        );
        let durations = turn_durations(&path).unwrap();
        assert_eq!(durations["timestamp:2"], 4000);
        assert_eq!(durations["tool:call-9"], 10_000);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn iso_roundtrip_and_offsets() {
        assert_eq!(
            iso_to_ms("2025-03-01T10:00:00.000Z"),
            Some(1_740_823_200_000)
        );
        assert_eq!(iso_to_ms("2025-03-01T10:00:00Z"), Some(1_740_823_200_000));
        assert_eq!(
            iso_to_ms("2025-03-01T18:00:00+08:00"),
            Some(1_740_823_200_000)
        );
        assert_eq!(
            iso_to_ms("2025-03-01T18:00:00+0800"),
            Some(1_740_823_200_000)
        );
        assert_eq!(
            iso_to_ms("2025-03-01 10:00:00.500Z"),
            Some(1_740_823_200_500)
        );
        assert_eq!(iso_to_ms("nope"), None);
        assert_eq!(ms_to_iso(1_740_823_200_000), "2025-03-01T10:00:00.000Z");
        assert_eq!(ms_to_iso(-1), "1969-12-31T23:59:59.999Z");
    }
}
