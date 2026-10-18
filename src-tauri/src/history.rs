//! Session history, read from the JSONL instead of asked of Pi.
//!
//! `get_messages` makes Pi serialize the whole session on every load: on the
//! 169 MB session that motivated this, 1.09 s and 168.8 MB for 1049 messages,
//! 98.5% of it base64 images. The file Pi is holding is on this disk, and the
//! projection rule is small (see `pi`'s `buildSessionPath` / `buildContextEntries`
//! / `sessionEntryToContextMessages`), so Rust can produce the same list directly:
//! measured 150–250 ms for the same file, images referenced by line offset.
//!
//! Correctness is not assumed. The projection is used only when
//!
//! * the path contains no compaction / branch summary / context edit (those three
//!   rewrite history in ways this module deliberately does not reimplement), and
//! * the projected message count equals `get_state`'s `messageCount`.
//!
//! Anything else falls back to `get_messages`, so a projection bug costs speed,
//! never content.
//!
//! Concurrency: this module keeps no per-session state. Every call re-reads the
//! file it is given, so any number of sessions can load at the same time.

use serde::Deserialize;
use serde_json::{json, Number, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// What the display needs, and what the caller can check against Pi.
pub struct Projection {
    /// Pi-shaped messages, in order, images replaced by `{at, ordinal, session}`.
    pub messages: Vec<Value>,
    /// `messages.len()` as a number, so it can be compared with `messageCount`.
    pub count: usize,
    /// False when Pi must be asked: the file uses history rewriting this module
    /// does not reproduce.
    pub exact: bool,
    /// Last entry id in the file (Pi's leaf after a reload).
    pub leaf: Option<String>,
}

#[derive(Deserialize, Default)]
struct PeekMessage {
    role: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EntryMeta {
    id: Option<String>,
    parent_id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    summary: Option<String>,
    first_kept_entry_id: Option<String>,
    tokens_before: Option<Number>,
    system_message: Option<Value>,
    from_id: Option<String>,
    custom_type: Option<String>,
    display: Option<bool>,
    details: Option<Value>,
    target_id: Option<String>,
    replacement: Option<Value>,
    message: Option<PeekMessage>,
}

struct Line {
    meta: EntryMeta,
    offset: u64,
    length: usize,
}

fn valid_root(path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("jsonl")
}

/// Read the entries' identity/parent chain without parsing message bodies.
///
/// The bodies are where the bytes are: a 169 MB session parses in one pass here
/// because `serde` skips the unknown `message.content` field without allocating.
fn index(path: &Path) -> Result<Vec<Line>, String> {
    let file = File::open(path).map_err(|error| format!("会话文件不可读：{error}"))?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut raw: Vec<u8> = Vec::with_capacity(8192);
    let mut lines: Vec<Line> = Vec::new();
    let mut offset: u64 = 0;
    loop {
        raw.clear();
        let length = reader
            .read_until(b'\n', &mut raw)
            .map_err(|error| format!("会话文件不可读：{error}"))?;
        if length == 0 {
            break;
        }
        let slice = crate::sessions::trim_line_pub(&raw);
        if !slice.is_empty() {
            if let Ok(meta) = serde_json::from_slice::<EntryMeta>(slice) {
                // The header is not part of the tree: Pi's index skips it, so a
                // header-only file has no leaf and no messages.
                if meta.kind.as_deref() != Some("session") {
                    lines.push(Line {
                        meta,
                        offset,
                        length,
                    });
                }
            }
        }
        offset += length as u64;
    }
    Ok(lines)
}

fn read_line(file: &mut File, offset: u64, length: usize) -> Result<Value, String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer).map_err(|error| error.to_string())?;
    serde_json::from_slice(crate::sessions::trim_line_pub(&buffer))
        .map_err(|error| format!("会话记录无法解析：{error}"))
}

/// Where a message's images live: Pi stores one message per entry, and the
/// renderer resolves `{session, at, ordinal}` by replaying this same walk.
fn primary_content(message: &mut Value) -> Option<&mut Value> {
    let content = message.get_mut("content")?;
    content.is_array().then_some(content)
}

fn strip_images(node: &mut Value, session: &str, at: u64, ordinal: &mut usize) -> usize {
    match node {
        Value::Array(items) => items
            .iter_mut()
            .map(|item| strip_images(item, session, at, ordinal))
            .sum(),
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") {
                if map.get("data").and_then(Value::as_str).is_none() {
                    return 0;
                }
                let index = *ordinal;
                *ordinal += 1;
                map.insert("at".into(), json!(at));
                map.insert("ordinal".into(), json!(index));
                map.insert("session".into(), Value::String(session.to_string()));
                map.remove("data");
                return 1;
            }
            if let Some(content) = map.get_mut("content") {
                strip_images(content, session, at, ordinal)
            } else {
                0
            }
        }
        _ => 0,
    }
}

fn iso_ms(text: Option<&str>) -> Option<i64> {
    text.and_then(crate::sessions::iso_to_ms)
}

fn message_of(kind: &str, line: &Value, meta: &EntryMeta) -> Vec<Value> {
    match kind {
        "message" => {
            let Some(mut message) = line.get("message").cloned() else { return Vec::new() };
            // Pi repairs hand-edited or pre-migration records the same way:
            // known roles get an empty body instead of `null`.
            let role = message.get("role").and_then(Value::as_str).unwrap_or_default().to_string();
            if message.get("content").map(Value::is_null).unwrap_or(true) {
                match role.as_str() {
                    "system" => message["content"] = Value::String(String::new()),
                    "user" | "assistant" | "toolResult" => message["content"] = Value::Array(Vec::new()),
                    _ => {}
                }
            }
            vec![message]
        }
        "custom_message" => {
            let mut message = json!({
                "role": "custom",
                "customType": meta.custom_type,
            });
            let map = message.as_object_mut().expect("object");
            map.insert("content".into(), line.get("content").cloned().unwrap_or_else(|| json!([])));
            if let Some(display) = meta.display {
                map.insert("display".into(), json!(display));
            }
            if let Some(details) = &meta.details {
                map.insert("details".into(), details.clone());
            }
            if let Some(timestamp) = iso_ms(meta.timestamp.as_deref()) {
                map.insert("timestamp".into(), json!(timestamp));
            }
            vec![message]
        }
        "branch_summary" => {
            let Some(summary) = &meta.summary else { return Vec::new() };
            let mut message = json!({"role": "branchSummary", "summary": summary, "fromId": meta.from_id});
            if let Some(timestamp) = iso_ms(meta.timestamp.as_deref()) {
                message["timestamp"] = json!(timestamp);
            }
            vec![message]
        }
        "compaction" => {
            let Some(summary) = &meta.summary else { return Vec::new() };
            let mut messages = Vec::new();
            if let Some(system) = &meta.system_message {
                messages.push(system.clone());
            }
            let mut message = json!({"role": "compactionSummary", "summary": summary});
            if let Some(tokens) = &meta.tokens_before {
                message["tokensBefore"] = Value::Number(tokens.clone());
            }
            if let Some(timestamp) = iso_ms(meta.timestamp.as_deref()) {
                message["timestamp"] = json!(timestamp);
            }
            messages.push(message);
            messages
        }
        _ => Vec::new(),
    }
}

/// Apply a `context_edit` to a message, exactly as Pi's `projectContextEntry`.
fn apply_edit(message: &mut Value, replacement: &Value) {
    if replacement.is_null() {
        *message = Value::Null;
        return;
    }
    let role = message.get("role").and_then(Value::as_str).unwrap_or_default().to_string();
    if !matches!(role.as_str(), "user" | "assistant" | "toolResult" | "custom") {
        return;
    }
    let content = replacement.get("content").cloned().unwrap_or(Value::Null);
    let next = if matches!(role.as_str(), "assistant" | "toolResult") && content.is_string() {
        json!([{"type": "text", "text": content}])
    } else {
        content
    };
    message["content"] = next;
}

/// The path from the leaf to the root, root first.
fn session_path<'a>(lines: &'a [Line], leaf: Option<&str>) -> Vec<&'a Line> {
    let mut by_id: HashMap<&str, &Line> = HashMap::new();
    for line in lines {
        if let Some(id) = line.meta.id.as_deref() {
            by_id.insert(id, line);
        }
    }
    let mut current = leaf.and_then(|id| by_id.get(id).copied()).or_else(|| lines.last());
    let mut path: Vec<&Line> = Vec::new();
    let mut guard = 0usize;
    while let Some(line) = current {
        path.push(line);
        guard += 1;
        if guard > lines.len() + 1 {
            // A malformed file could point in a cycle; stop instead of hanging.
            break;
        }
        current = line.meta.parent_id.as_deref().and_then(|id| by_id.get(id).copied());
    }
    path.reverse();
    path
}

/// `buildContextEntries`: keep the newest compaction, the entries it says it kept,
/// and everything after it. Sessions without compaction return their path as-is.
fn context_entries(path: Vec<&Line>) -> (Vec<&Line>, bool) {
    let compaction = path.iter().rev().find(|line| line.meta.kind.as_deref() == Some("compaction"));
    let Some(compaction) = compaction else {
        let rewritten = path.iter().any(|line| matches!(line.meta.kind.as_deref(), Some("branch_summary") | Some("context_edit")));
        return (path, !rewritten);
    };
    let Some(index) = path.iter().position(|line| line.meta.id == compaction.meta.id) else {
        return (path, false);
    };
    let mut entries: Vec<&Line> = vec![compaction];
    let mut found_first_kept = false;
    for line in &path[..index] {
        if line.meta.id == compaction.meta.first_kept_entry_id {
            found_first_kept = true;
        }
        let system = line.meta.kind.as_deref() == Some("message")
            && line.meta.message.as_ref().and_then(|message| message.role.as_deref()) == Some("system");
        if found_first_kept && !system {
            entries.push(line);
        }
    }
    entries.extend(path[index + 1..].iter().copied());
    (entries, false)
}

pub fn project(path: &Path, leaf: Option<&str>) -> Result<Projection, String> {
    if !valid_root(path) {
        return Err("只能读取 Pi 会话目录中的 JSONL 文件".into());
    }
    let lines = index(path)?;
    // 一个句柄读完所有叶路径条目：一千多条消息不该开一千多次文件。
    let mut file = File::open(path).map_err(|error| format!("会话文件不可读：{error}"))?;
    let leaf_id = lines
        .iter()
        .rev()
        .find_map(|line| line.meta.id.clone());
    let path_entries = session_path(&lines, leaf);
    let (context, exact) = context_entries(path_entries);
    let session = path.to_string_lossy().into_owned();
    let mut messages: Vec<Value> = Vec::new();
    // `context_edit` entries target another entry's content; collect them first.
    let mut edits: HashMap<String, Value> = HashMap::new();
    for line in &context {
        if line.meta.kind.as_deref() == Some("context_edit") {
            if let (Some(target), Some(replacement)) = (&line.meta.target_id, &line.meta.replacement) {
                edits.insert(target.clone(), replacement.clone());
            }
        }
    }
    for (position, line) in context.iter().enumerate() {
        let Some(kind) = line.meta.kind.as_deref() else { continue };
        // A retained compaction that is not the newest contributes a checkpoint,
        // not a second summary (Pi's `index > 0` rule).
        if kind == "compaction" && position > 0 {
            continue;
        }
        if !matches!(kind, "message" | "custom_message" | "branch_summary" | "compaction") {
            continue;
        }
        let full = read_line(&mut file, line.offset, line.length)?;
        let mut produced = message_of(kind, &full, &line.meta);
        for message in &mut produced {
            if message.is_null() {
                continue;
            }
            if let Some(id) = line.meta.id.as_deref() {
                if let Some(replacement) = edits.get(id) {
                    apply_edit(message, replacement);
                }
            }
            if message.is_null() {
                continue;
            }
            // Only the entry's own body can be resolved by line offset; the rare
            // compaction `systemMessage` keeps its bytes inline.
            if kind == "message" || kind == "custom_message" {
                if let Some(content) = primary_content(message) {
                    let mut ordinal = 0usize;
                    strip_images(content, &session, line.offset, &mut ordinal);
                }
            }
            messages.push(std::mem::take(message));
        }
    }
    let count = messages.len();
    Ok(Projection {
        messages,
        count,
        exact,
        leaf: leaf_id,
    })
}

/// One image out of a session entry, by (byte offset, image ordinal).
///
/// The bytes never existed anywhere else: they are base64 inside that line, so
/// this decodes only what the screen actually shows. `at` and `ordinal` come from
/// `project`, which numbered the images in the same walk order.
pub fn read_image(path: &Path, at: u64, ordinal: usize) -> Result<(String, String), String> {
    if !valid_root(path) {
        return Err("只能读取 Pi 会话目录中的 JSONL 文件".into());
    }
    let file = File::open(path).map_err(|error| format!("会话文件不可读：{error}"))?;
    let mut reader = BufReader::with_capacity(1 << 16, file);
    reader.seek(SeekFrom::Start(at)).map_err(|error| error.to_string())?;
    let mut raw: Vec<u8> = Vec::new();
    reader.read_until(b'\n', &mut raw).map_err(|error| error.to_string())?;
    // A single entry can be tens of MB (a screenshot is ~1–10 MB of base64).
    if raw.len() > 256 * 1024 * 1024 {
        return Err("会话记录过大".into());
    }
    let entry: Value = serde_json::from_slice(crate::sessions::trim_line_pub(&raw))
        .map_err(|error| format!("会话记录无法解析：{error}"))?;
    let content = entry
        .pointer("/message/content")
        .filter(|value| value.is_array())
        .or_else(|| entry.get("content").filter(|value| value.is_array()))
        .ok_or_else(|| "这条记录没有图片".to_string())?;
    let mut images: Vec<(&str, &str)> = Vec::new();
    collect_images(content, &mut images);
    let (mime, data) = images.get(ordinal).copied().ok_or_else(|| "图片不存在".to_string())?;
    if data.len() > 48 * 1024 * 1024 {
        return Err("图片太大".into());
    }
    Ok((mime.to_string(), data.to_string()))
}

fn collect_images<'a>(node: &'a Value, out: &mut Vec<(&'a str, &'a str)>) {
    match node {
        Value::Array(items) => items.iter().for_each(|item| collect_images(item, out)),
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("image") {
                // 序号必须和 `strip_images` 的计数完全一致：只要求 `data`，
                // mimeType 缺失时用兜底值，否则后面所有图片的 ordinal 都会错位。
                if let Some(data) = map.get("data").and_then(Value::as_str) {
                    let mime = map.get("mimeType").and_then(Value::as_str).unwrap_or("image/png");
                    out.push((mime, data));
                }
                return;
            }
            if let Some(content) = map.get("content") {
                collect_images(content, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "orbit-history-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, lines: &[String]) {
        let mut file = fs::File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    const HEADER: &str = r#"{"type":"session","version":3,"id":"s1","timestamp":"2025-03-01T10:00:00.000Z","cwd":"/tmp"}"#;

    fn message(id: &str, parent: &str, role: &str, timestamp: &str, content: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":"{parent}","timestamp":"{timestamp}","message":{{"role":"{role}","content":{content},"timestamp":1000}}}}"#
        )
    }

    #[test]
    fn reads_the_leaf_path_and_counts_like_pi() {
        let dir = temp_dir("plain");
        let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"\x89PNG");
        let path = dir.join("s.jsonl");
        write(
            &path,
            &[
                HEADER.into(),
                message("m1", "s1", "user", "2025-03-01T10:00:01.000Z", r#""hi""#),
                message("m2", "m1", "assistant", "2025-03-01T10:00:02.000Z", r#"[{"type":"text","text":"ok"}]"#),
                format!(
                    r#"{{"type":"custom_message","id":"m3","parentId":"m2","timestamp":"2025-03-01T10:00:03.000Z","customType":"subagent_result","content":[{{"type":"image","mimeType":"image/png","data":"{png}"}}],"display":true}}"#
                ),
                r#"{"type":"session_info","id":"m4","parentId":"m3","timestamp":"2025-03-01T10:00:04.000Z","name":"renamed"}"#.into(),
            ],
        );
        let projection = project(&path, None).unwrap();
        assert!(projection.exact);
        assert_eq!(projection.count, 3);
        assert_eq!(projection.messages[0]["role"], "user");
        assert_eq!(projection.messages[1]["role"], "assistant");
        let custom = &projection.messages[2];
        assert_eq!(custom["role"], "custom");
        assert_eq!(custom["customType"], "subagent_result");
        // 时间戳换成毫秒，与 pi 的 `createCustomMessage` 一致。
        assert_eq!(custom["timestamp"], 1_740_823_203_000i64);
        // 图片换成偏移引用，base64 不留在消息里。
        let image = &custom["content"][0];
        assert!(image.get("data").is_none());
        assert_eq!(image["ordinal"], 0);
        let at = image["at"].as_u64().unwrap();
        assert_eq!(image["session"], path.to_string_lossy().as_ref());
        let (mime, data) = read_image(&path, at, 0).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, png);
        assert!(read_image(&path, at, 7).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "needs ORBIT_HISTORY_BENCH=<session.jsonl> and ORBIT_HISTORY_EXPECT=<get_messages response line>"]
    fn projection_matches_pi_on_a_real_session() {
        let Ok(path) = std::env::var("ORBIT_HISTORY_BENCH") else { return };
        let Ok(expect_path) = std::env::var("ORBIT_HISTORY_EXPECT") else { return };
        let expected: Value =
            serde_json::from_slice(&std::fs::read(&expect_path).expect("expectation readable")).expect("expectation is JSON");
        let expected = expected["data"]["messages"].as_array().cloned().unwrap_or_default();
        let started = std::time::Instant::now();
        let projection = project(Path::new(&path), None).expect("projection");
        println!(
            "projected {} messages (pi: {}) in {:?}, exact={}",
            projection.count,
            expected.len(),
            started.elapsed(),
            projection.exact
        );
        assert_eq!(projection.count, expected.len(), "message count must match pi");
        for (index, (ours, theirs)) in projection.messages.iter().zip(expected.iter()).enumerate() {
            assert_eq!(ours["role"], theirs["role"], "role at {index}");
            assert_eq!(ours["timestamp"], theirs["timestamp"], "timestamp at {index}");
        }
    }

    #[test]
    fn compaction_marks_the_read_as_inexact_instead_of_guessing() {
        let dir = temp_dir("compaction");
        let path = dir.join("s.jsonl");
        write(
            &path,
            &[
                HEADER.into(),
                message("m1", "s1", "user", "2025-03-01T10:00:01.000Z", r#""hi""#),
                message("m2", "m1", "assistant", "2025-03-01T10:00:02.000Z", r#""ok""#),
                r#"{"type":"compaction","id":"m3","parentId":"m2","timestamp":"2025-03-01T10:00:03.000Z","summary":"sum","firstKeptEntryId":"m2","tokensBefore":42}"#.into(),
                message("m4", "m3", "user", "2025-03-01T10:00:04.000Z", r#""next""#),
            ],
        );
        let projection = project(&path, None).unwrap();
        assert!(!projection.exact, "compaction must be answered by pi");
        // 仍然给出可用的近似（供调用方决定是否先画），但不会被当成权威。
        assert!(projection.count >= 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_branch_leaf_only_contains_its_own_path() {
        let dir = temp_dir("branch");
        let path = dir.join("s.jsonl");
        write(
            &path,
            &[
                HEADER.into(),
                message("m1", "s1", "user", "2025-03-01T10:00:01.000Z", r#""hi""#),
                message("a1", "m1", "assistant", "2025-03-01T10:00:02.000Z", r#""a""#),
                message("b1", "m1", "assistant", "2025-03-01T10:00:03.000Z", r#""b""#),
            ],
        );
        let last = project(&path, None).unwrap();
        assert_eq!(last.count, 2, "the file's last entry is b1, so m1+b1");
        let first = project(&path, Some("a1")).unwrap();
        assert_eq!(first.count, 2);
        assert_eq!(first.messages[1]["content"], "a");
        let _ = fs::remove_dir_all(&dir);
    }
}
