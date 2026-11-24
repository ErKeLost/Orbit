//! 跨会话用量与费用聚合。
//!
//! 每次 assistant 回答都会在会话 JSONL 里留下一条带 `usage` 的条目（token 拆分、
//! 缓存读写、按模型目录价算出的费用），但此前只有**单个会话**能看到上下文构成，
//! 没有任何地方能回答「这个月花了多少」「缓存到底省了多少」。
//!
//! 这里沿用 `sessions.rs` 的做法：单遍扫描 JSONL，按 `(mtime, size)` 做增量缓存，
//! 缓存命中零解析。会话目录可能有几千个文件，所以聚合结果按
//! `(日期, provider, model, 项目, 类型)` 先合并成一个很小的点集再存进缓存，
//! 而不是把每条消息都留在内存里。
//!
//! 日期桶用 Pi 自己写进条目里的 ISO 时间戳前 10 个字符：那是该时间戳自身偏移下的
//! 日期，不引入时区库，也不会把晚上 8 点算到第二天。
//!
//! **口径**：费用按「会话文件里记录的每次请求」累加。分叉会话（`/fork`）会把父会话
//! 的条目原样复制进新文件，因此继承的那部分历史在两个文件里都算一次——那些请求本身
//! 并没有重新发生。这里不按 entry id 去重（需要对每条条目留指纹，几个 GB 的会话目录
//! 撑不住），而是把分叉数量报给界面，让读数的人知道这笔账的口径。

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

/// 一条 assistant 回答、一次压缩、一次缓存预热都算一次「请求」。
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total: u64,
    cost: f64,
    requests: u64,
}

impl Totals {
    fn add(&mut self, usage: &Value) {
        let number = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        let input = number("input");
        let output = number("output");
        let cache_read = number("cacheRead");
        let cache_write = number("cacheWrite");
        let total = number("totalTokens");
        self.input = self.input.saturating_add(input);
        self.output = self.output.saturating_add(output);
        self.cache_read = self.cache_read.saturating_add(cache_read);
        self.cache_write = self.cache_write.saturating_add(cache_write);
        self.total = self
            .total
            .saturating_add(if total > 0 { total } else { input + output + cache_read + cache_write });
        self.cost += usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        self.requests += 1;
    }

    fn merge(&mut self, other: &Totals) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.total = self.total.saturating_add(other.total);
        self.cost += other.cost;
        self.requests = self.requests.saturating_add(other.requests);
    }
}

/// One aggregate bucket inside a session file. Kept tiny so a cached file stays
/// a few hundred bytes instead of every message it contains.
#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    day: String,
    provider: String,
    model: String,
    project: String,
    kind: String,
}

#[derive(Clone, Default)]
struct FileUsage {
    points: Vec<(Key, Totals)>,
    /// 文件里最后一条带时间戳的日期，用于按区间过滤。
    latest_day: String,
    cwd: String,
    name: String,
    /// 分叉出来的会话（header 带 `parentSession`）。
    forked: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    mtime_secs: i64,
    mtime_nanos: u32,
    size: u64,
}

/// 按 (mtime, size) 缓存每个会话文件的聚合结果。
static CACHE: LazyLock<Mutex<HashMap<PathBuf, (Stamp, FileUsage)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn with_cache<T>(action: impl FnOnce(&mut HashMap<PathBuf, (Stamp, FileUsage)>) -> T) -> T {
    let mut guard = match CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    action(&mut guard)
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let elapsed = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(Stamp {
        mtime_secs: elapsed.as_secs() as i64,
        mtime_nanos: elapsed.subsec_nanos(),
        size: metadata.len(),
    })
}

fn day_of(timestamp: &str) -> String {
    let day = timestamp.get(..10).unwrap_or_default();
    if day.len() == 10 && day.as_bytes()[4] == b'-' {
        day.to_string()
    } else {
        String::new()
    }
}

fn text_of(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// 一条 JSONL 条目 → 用量。assistant 消息、`usage` 条目、压缩与分支摘要都会花钱，
/// 分类记录，前端可以只看对话或连缓存预热一起看。
fn entry_usage(entry: &Value) -> Option<(String, String, String, &Value)> {
    let kind = entry.get("type").and_then(Value::as_str)?;
    match kind {
        "message" => {
            let message = entry.get("message")?;
            if message.get("role").and_then(Value::as_str)? != "assistant" {
                return None;
            }
            let usage = message.get("usage")?;
            Some((
                "message".to_string(),
                text_of(message.get("provider")),
                text_of(message.get("model")),
                usage,
            ))
        }
        "usage" => {
            let usage = entry.get("usage")?;
            let kind = text_of(entry.get("kind"));
            Some((
                if kind.is_empty() { "usage".to_string() } else { kind },
                text_of(entry.get("provider")),
                text_of(entry.get("model")),
                usage,
            ))
        }
        "compaction" | "branch_summary" => {
            let usage = entry.get("usage")?;
            Some((kind.to_string(), String::new(), String::new(), usage))
        }
        _ => None,
    }
}

fn scan_file(path: &Path) -> Option<FileUsage> {
    let file = File::open(path).ok()?;
    let mut usage = FileUsage::default();
    let mut buckets: HashMap<Key, Totals> = HashMap::new();
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            usage.cwd = text_of(entry.get("cwd"));
            usage.forked = entry.get("parentSession").and_then(Value::as_str).is_some();
            usage.name = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_default();
            continue;
        }
        let Some((kind, provider, model, entry_usage)) = entry_usage(&entry) else { continue };
        let timestamp = text_of(entry.get("timestamp"));
        let day = day_of(&timestamp);
        if day.is_empty() {
            continue;
        }
        if day > usage.latest_day {
            usage.latest_day = day.clone();
        }
        let key = Key {
            day,
            provider,
            model,
            project: usage.cwd.clone(),
            kind,
        };
        buckets.entry(key).or_default().add(entry_usage);
    }
    usage.points = buckets.into_iter().collect();
    Some(usage)
}

fn file_usage(path: &Path, stamp: Stamp) -> FileUsage {
    with_cache(|cache| {
        if let Some((cached, usage)) = cache.get(path) {
            if *cached == stamp {
                return usage.clone();
            }
        }
        let usage = scan_file(path).unwrap_or_default();
        cache.insert(path.to_path_buf(), (stamp, usage.clone()));
        usage
    })
}

/// `<agentDir>/sessions` 下的全部 `.jsonl`。Pi 按项目分子目录。
fn session_files(root: &Path) -> Vec<(PathBuf, Stamp)> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else { continue };
            if file_type.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|extension| extension == "jsonl") {
                if let Some(stamp) = stamp_of(&path) {
                    files.push((path, stamp));
                }
            }
        }
    }
    files
}

/// 超过这个数量的已删除文件会一直留在缓存里，每 200 个新文件清一次。
fn prune_cache(present: &[PathBuf]) {
    with_cache(|cache| {
        if cache.len() <= present.len() + 200 {
            return;
        }
        let known: std::collections::HashSet<&PathBuf> = present.iter().collect();
        let stale: Vec<PathBuf> = cache
            .keys()
            .filter(|path| !known.contains(path))
            .cloned()
            .collect();
        for path in stale {
            cache.remove(&path);
        }
    });
}

pub(crate) fn sessions_root(agent_dir: &Path) -> PathBuf {
    agent_dir.join("sessions")
}

/// 最近 `days` 天的聚合；`days = 0` 表示全部历史。
pub(crate) fn report(agent_dir: &Path, days: u32, now_ms: i64) -> Value {
    let root = sessions_root(agent_dir);
    let files = session_files(&root);
    prune_cache(&files.iter().map(|(path, _)| path.clone()).collect::<Vec<_>>());
    let cutoff = if days == 0 {
        String::new()
    } else {
        day_from_epoch_ms(now_ms - i64::from(days) * 86_400_000)
    };

    let mut totals = Totals::default();
    let mut by_day: BTreeMap<String, Totals> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Totals> = BTreeMap::new();
    let mut by_project: BTreeMap<String, Totals> = BTreeMap::new();
    let mut by_kind: BTreeMap<String, Totals> = BTreeMap::new();
    let mut scanned = 0usize;
    let mut forked = 0usize;

    for (path, stamp) in &files {
        let usage = file_usage(path, *stamp);
        if usage.points.is_empty() {
            continue;
        }
        if !cutoff.is_empty() && usage.latest_day < cutoff {
            continue;
        }
        scanned += 1;
        if usage.forked {
            forked += 1;
        }
        for (key, point) in &usage.points {
            if !cutoff.is_empty() && key.day < cutoff {
                continue;
            }
            totals.merge(point);
            by_day.entry(key.day.clone()).or_default().merge(point);
            by_kind.entry(key.kind.clone()).or_default().merge(point);
            if !key.model.is_empty() {
                let label = if key.provider.is_empty() || key.provider == "unknown" {
                    key.model.clone()
                } else {
                    format!("{}/{}", key.provider, key.model)
                };
                by_model.entry(label).or_default().merge(point);
            }
            if !key.project.is_empty() {
                by_project.entry(key.project.clone()).or_default().merge(point);
            }
        }
    }

    let prompt_tokens = totals.input.saturating_add(totals.cache_read);
    let cache_read_share = if prompt_tokens > 0 {
        totals.cache_read as f64 / prompt_tokens as f64
    } else {
        0.0
    };

    let series: Vec<Value> = by_day
        .iter()
        .map(|(day, totals)| {
            let mut value = serde_json::to_value(totals).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert("day".into(), Value::String(day.clone()));
            }
            value
        })
        .collect();
    let models: Vec<Value> = ranked(by_model);
    let projects: Vec<Value> = ranked(by_project);
    let kinds: Vec<Value> = ranked(by_kind);

    serde_json::json!({
        "days": days,
        "totals": totals,
        "cacheReadShare": cache_read_share,
        "series": series,
        "models": models,
        "projects": projects,
        "kinds": kinds,
        "sessions": scanned,
        "forked": forked,
        "files": files.len(),
        "root": root.display().to_string(),
    })
}

fn ranked(map: BTreeMap<String, Totals>) -> Vec<Value> {
    let mut rows: Vec<(String, Totals)> = map.into_iter().collect();
    rows.sort_by(|a, b| b.1.cost.total_cmp(&a.1.cost).then(b.1.total.cmp(&a.1.total)));
    rows.into_iter()
        .map(|(key, totals)| {
            let mut value = serde_json::to_value(totals).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert("key".into(), Value::String(key));
            }
            value
        })
        .collect()
}

/// 单个会话的合计，按费用降序。前端用它做「哪一次对话最贵」。
pub(crate) fn per_session(agent_dir: &Path, limit: usize, now_ms: i64) -> Value {
    let root = sessions_root(agent_dir);
    let files = session_files(&root);
    let cutoff = day_from_epoch_ms(now_ms - 30 * 86_400_000);
    let mut rows: Vec<Value> = Vec::new();
    for (path, stamp) in &files {
        let usage = file_usage(path, *stamp);
        if usage.points.is_empty() || usage.latest_day < cutoff {
            continue;
        }
        let mut totals = Totals::default();
        let mut latest = String::new();
        for (key, point) in &usage.points {
            totals.merge(point);
            if key.day > latest {
                latest = key.day.clone();
            }
        }
        rows.push(serde_json::json!({
            "path": path.display().to_string(),
            "name": usage.name,
            "cwd": usage.cwd,
            "day": latest,
            "forked": usage.forked,
            "totals": totals,
        }));
    }
    rows.sort_by(|a, b| {
        let cost = |value: &Value| {
            value
                .get("totals")
                .and_then(|totals| totals.get("cost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        };
        cost(b).total_cmp(&cost(a))
    });
    rows.truncate(limit);
    Value::Array(rows)
}

/// 与 `day_of` 同一口径（UTC）的日期串；只用于「最近 N 天」的截止线。
fn day_from_epoch_ms(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant 的 civil_from_days，避免为一次日期换算引入日期库。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn usage_report(days: Option<u32>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent_dir = crate::sessions::agent_dir()?;
        Ok(report(&agent_dir, days.unwrap_or(30), now_ms()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn usage_sessions(limit: Option<usize>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent_dir = crate::sessions::agent_dir()?;
        Ok(per_session(&agent_dir, limit.unwrap_or(20).clamp(1, 100), now_ms()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_session(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        let mut file = File::create(&path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        path
    }

    #[test]
    fn aggregates_assistant_usage_per_day_model_and_project() {
        let root = std::env::temp_dir().join(format!("orbit-usage-{}", uuid::Uuid::new_v4()));
        let sessions = root.join("sessions").join("project-a");
        write_session(
            &sessions,
            "s1.jsonl",
            &[
                r#"{"type":"session","id":"s1","timestamp":"2026-11-20T10:00:00.000Z","cwd":"/work/a"}"#,
                r#"{"type":"message","id":"m1","timestamp":"2026-11-20T10:00:00.000Z","message":{"role":"assistant","provider":"anthropic","model":"claude","usage":{"input":100,"output":20,"cacheRead":300,"cacheWrite":10,"totalTokens":430,"cost":{"total":0.05}}}}"#,
                r#"{"type":"message","id":"m2","timestamp":"2026-11-20T11:00:00.000Z","message":{"role":"user"}}"#,
                r#"{"type":"message","id":"m3","timestamp":"2026-11-21T09:00:00.000Z","message":{"role":"assistant","provider":"anthropic","model":"claude","usage":{"input":50,"output":10,"cacheRead":900,"cacheWrite":0,"totalTokens":960,"cost":{"total":0.02}}}}"#,
            ],
        );
        let value = report(&root, 0, 1_700_000_000_000);
        let totals = &value["totals"];
        assert_eq!(totals["requests"], 2);
        assert_eq!(totals["input"], 150);
        assert_eq!(totals["cacheRead"], 1200);
        assert!((value["cacheReadShare"].as_f64().unwrap() - 1200.0 / 1350.0).abs() < 1e-9);
        assert_eq!(value["series"].as_array().unwrap().len(), 2);
        assert_eq!(value["models"][0]["key"], "anthropic/claude");
        assert_eq!(value["projects"][0]["key"], "/work/a");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn day_filter_uses_the_entry_timestamp_and_ignores_broken_lines() {
        let root = std::env::temp_dir().join(format!("orbit-usage-{}", uuid::Uuid::new_v4()));
        let sessions = root.join("sessions");
        write_session(
            &sessions,
            "old.jsonl",
            &[
                r#"{"type":"session","id":"old","timestamp":"2020-01-01T00:00:00.000Z","cwd":"/work/old"}"#,
                r#"{"type":"message","id":"m1","timestamp":"2020-01-01T00:00:00.000Z","message":{"role":"assistant","provider":"p","model":"m","usage":{"input":1,"output":1,"totalTokens":2,"cost":{"total":1}}}}"#,
            ],
        );
        write_session(
            &sessions,
            "new.jsonl",
            &["not json", r#"{"type":"session","id":"new","timestamp":"2026-11-20T00:00:00.000Z","cwd":"/work/new"}"#, r#"{"type":"message","id":"m2","timestamp":"2026-11-20T00:00:00.000Z","message":{"role":"assistant","provider":"p","model":"m","usage":{"input":10,"output":5,"totalTokens":15,"cost":{"total":0.5}}}}"#],
        );
        let now = 1_798_675_200_000; // 2026-12-31
        assert_eq!(report(&root, 0, now)["totals"]["requests"], 2);
        // 400 天只留下 2026-11-20 那个文件，2020 的排除在外。
        assert_eq!(report(&root, 400, now)["totals"]["requests"], 1);
        // 30 天完全落在两个文件之后。
        assert_eq!(report(&root, 30, now)["totals"]["requests"], 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn civil_dates_match_the_epoch() {
        assert_eq!(day_from_epoch_ms(0), "1970-01-01");
        assert_eq!(day_from_epoch_ms(1_798_675_200_000), "2026-12-31");
        assert_eq!(day_from_epoch_ms(1_764_000_000_000), "2025-11-24");
    }
}
