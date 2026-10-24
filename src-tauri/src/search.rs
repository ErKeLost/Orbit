//! Search backend for the Search view: file names, file contents (through
//! `git grep` when the folder is a repository, otherwise a bounded walk), and
//! past Pi sessions (titles plus message text).

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_CONTENT_HITS: usize = 60;
const MAX_NAME_HITS: usize = 60;
const MAX_SESSION_HITS: usize = 40;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SESSIONS_SCANNED: usize = 400;

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn sessions_dir() -> Option<PathBuf> {
    if let Ok(current) = crate::sessions::sessions_root() {
        if current.is_dir() {
            return Some(current);
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let legacy = PathBuf::from(home).join(".pi/sessions");
    legacy.is_dir().then_some(legacy)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub relative: String,
    pub line: Option<u32>,
    pub snippet: Option<String>,
    /** "name" when the query matched the path, "content" when it matched text. */
    pub kind: String,
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = cmd
        .arg("--no-pager")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !output.status.success() && output.status.code() != Some(1) {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn name_hits(root: &Path, query: &str) -> Vec<FileHit> {
    let needle = query.to_lowercase();
    let listed = git(root, &["ls-files", "--cached", "--others", "--exclude-standard"])
        .unwrap_or_default();
    let mut hits = Vec::new();
    for line in listed.lines().filter(|line| !line.trim().is_empty()) {
        let relative = line.trim().to_string();
        if !relative.to_lowercase().contains(&needle) {
            continue;
        }
        hits.push(FileHit {
            path: root.join(&relative).to_string_lossy().into_owned(),
            relative,
            line: None,
            snippet: None,
            kind: "name".into(),
        });
        if hits.len() >= MAX_NAME_HITS {
            break;
        }
    }
    hits
}

fn content_hits(root: &Path, query: &str, skip: &[String]) -> Vec<FileHit> {
    // `-F` means a literal query. Escaping a BRE by hand is not equivalent:
    // sequences such as `\+` and `\?` become operators in GNU basic regex.
    let Some(text) = git(
        root,
        &["grep", "-n", "-I", "--no-color", "-m", "2", "-F", "-e", query],
    ) else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    for line in text.lines() {
        let Some((relative, rest)) = line.split_once(':') else { continue };
        if skip.iter().any(|item| item == relative) {
            continue;
        }
        let (line_number, snippet) = rest.split_once(':').unwrap_or(("0", rest));
        hits.push(FileHit {
            path: root.join(relative).to_string_lossy().into_owned(),
            relative: relative.to_string(),
            line: line_number.parse().ok(),
            snippet: Some(snippet.trim().chars().take(240).collect()),
            kind: "content".into(),
        });
        if hits.len() >= MAX_CONTENT_HITS {
            break;
        }
    }
    hits
}

fn walk_names(root: &Path, query: &str, hits: &mut Vec<FileHit>) {
    let needle = query.to_lowercase();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if hits.len() >= MAX_NAME_HITS {
            return;
        }
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            let path = entry.path();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if name.to_lowercase().contains(&needle) {
                hits.push(FileHit {
                    path: path.to_string_lossy().into_owned(),
                    relative: relative_to(root, &path),
                    line: None,
                    snippet: None,
                    kind: "name".into(),
                });
            }
            if is_dir {
                stack.push(path);
            }
        }
    }
}

/// File names first, then content matches; bounded so a broad query stays fast.
#[tauri::command]
pub async fn search_files(cwd: String, query: String, limit: Option<usize>) -> Result<Vec<FileHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let limit = limit.unwrap_or(MAX_NAME_HITS + MAX_CONTENT_HITS);
        let mut hits = if git(&root, &["rev-parse", "--is-inside-work-tree"]).is_some() {
            name_hits(&root, &query)
        } else {
            let mut found = Vec::new();
            walk_names(&root, &query, &mut found);
            found
        };
        let names: Vec<String> = hits.iter().map(|hit| hit.relative.clone()).collect();
        hits.extend(content_hits(&root, &query, &names));
        hits.truncate(limit.max(1));
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    pub path: String,
    pub title: String,
    pub snippet: Option<String>,
    pub modified: String,
}

/// Map a byte offset in `text.to_lowercase()` back to a UTF-8 boundary in the
/// original. Lowercasing can expand a character, so this must not treat the
/// offset as a character count (or blindly slice at the same byte).
fn original_offset(text: &str, folded_offset: usize) -> usize {
    let mut current = 0usize;
    for (index, character) in text.char_indices() {
        if current >= folded_offset {
            return index;
        }
        current += character
            .to_lowercase()
            .map(|part| part.len_utf8())
            .sum::<usize>();
        if current > folded_offset {
            return index;
        }
    }
    text.len()
}

fn matching_snippet(text: &str, query: &str) -> Option<String> {
    let folded_at = text.to_lowercase().find(query)?;
    let matched_at = original_offset(text, folded_at);
    let prefix = &text[..matched_at];
    let start = prefix
        .char_indices()
        .rev()
        .nth(59)
        .map(|(index, _)| index)
        .unwrap_or(0);
    let mut end = text.len();
    for (count, (offset, _)) in text[start..].char_indices().enumerate() {
        if count == 200 {
            end = start + offset;
            break;
        }
    }
    Some(text[start..end].replace('\n', " "))
}

/// Search one JSONL file incrementally. Real Pi records nest role/content under
/// `message`; accepting the root as a fallback also keeps older fixtures valid.
/// A hit returns as soon as its title and snippet are known, instead of building
/// a second lowercase copy of the entire conversation first.
fn session_hit(path: &Path, query: &str) -> Option<SessionHit> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES * 8 {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut raw = Vec::with_capacity(8192);
    let mut title = String::new();
    let mut title_match = false;
    let mut snippet = None;
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return None,
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else { continue };
        let message = value.get("message").unwrap_or(&value);
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let text = message
            .get("content")
            .map(|content| match content {
                serde_json::Value::String(text) => text.clone(),
                serde_json::Value::Array(parts) => parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            })
            .unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        if title.is_empty() && role == "user" {
            title = text.trim().replace('\n', " ").chars().take(90).collect();
            title_match = title.to_lowercase().contains(query);
            if title_match {
                break;
            }
        }
        if snippet.is_none() {
            snippet = matching_snippet(&text, query);
        }
        if snippet.is_some() && !title.is_empty() {
            break;
        }
    }
    if !title_match && snippet.is_none() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_secs().to_string())
        .unwrap_or_default();
    Some(SessionHit {
        path: path.to_string_lossy().into_owned(),
        title: if title.is_empty() {
            path.file_stem().map(|v| v.to_string_lossy().into_owned()).unwrap_or_default()
        } else {
            title
        },
        snippet,
        modified,
    })
}

/// Past conversations whose title or message text matches.
#[tauri::command]
pub async fn search_sessions(query: String) -> Result<Vec<SessionHit>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SessionHit>, String> {
        let Some(dir) = sessions_dir() else { return Ok(Vec::new()) };
        let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
        let mut stack = vec![dir];
        while let Some(current) = stack.pop() {
            let Ok(read) = std::fs::read_dir(&current) else { continue };
            for entry in read.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
                    let modified = entry
                        .metadata()
                        .and_then(|meta| meta.modified())
                        .unwrap_or(std::time::UNIX_EPOCH);
                    files.push((path, modified));
                }
            }
        }
        files.sort_by_key(|a| std::cmp::Reverse(a.1));
        let mut hits = Vec::new();
        for (path, _) in files.into_iter().take(MAX_SESSIONS_SCANNED) {
            if let Some(hit) = session_hit(&path, &query) {
                hits.push(hit);
                if hits.len() >= MAX_SESSION_HITS {
                    break;
                }
            }
        }
        Ok(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "orbit-search-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn session_search_reads_nested_pi_messages() {
        let path = fixture(
            "nested.jsonl",
            concat!(
                "{\"type\":\"session\",\"id\":\"s1\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"第一句\"}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"需要优化 Rust 搜索\"}]}}\n"
            ),
        );
        let hit = session_hit(&path, "rust").expect("nested assistant text is searchable");
        assert_eq!(hit.title, "第一句");
        assert_eq!(hit.snippet.as_deref(), Some("需要优化 Rust 搜索"));
        assert!(session_hit(&path, "not-present").is_none());
        let title = session_hit(&path, "第一").expect("the first user message is the title");
        assert_eq!(title.snippet, None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn snippets_keep_utf8_and_original_case() {
        let snippet = matching_snippet("这是中文前缀，需要检索 Rust 性能", "性能").unwrap();
        assert_eq!(snippet, "这是中文前缀，需要检索 Rust 性能");
        let expanded = matching_snippet("xİy", "y").unwrap();
        assert_eq!(expanded, "xİy");
    }
}
