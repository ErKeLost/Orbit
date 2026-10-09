//! Workspace Git and file-tree backend for the Orbit-style shell.
//!
//! Adapted from MonoCode's `src-tauri/src/fs.rs` (MIT, Copyright (c) 2026
//! Nick): uncommitted diff stats, branch listing/switching and a gitignore
//! aware directory listing for the Explorer. Pi still owns every agent turn;
//! this module only reads and switches the working copy the user opened.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_DIR_ENTRIES: usize = 5_000;

/// Expand a leading `~`. Shared with the remote Host, whose project requests
/// arrive as paths the phone typed or picked.
pub(crate) fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

fn path_to_js(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn git_cmd() -> Command {
    let cmd = Command::new("git");
    #[cfg(windows)]
    let cmd = {
        let mut cmd = cmd;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    cmd
}

fn git_status_ok(status: &std::process::ExitStatus, args: &[&str]) -> bool {
    status.success()
        || (status.code() == Some(1) && matches!(args.first().copied(), Some("diff" | "grep")))
}

fn git_run(root: &Path, args: &[&str]) -> Option<String> {
    let output = git_cmd()
        .arg("--no-pager")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    git_status_ok(&output.status, args).then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_stdout(root: &Path, args: &[&str]) -> Option<String> {
    git_run(root, args)
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

fn git_checked(root: &Path, args: &[&str]) -> Result<(), String> {
    let output = git_cmd()
        .arg("--no-pager")
        .arg("-C")
        .arg(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("git {} failed", args.join(" "))
    })
}

fn git_is_work_tree(root: &Path) -> bool {
    git_stdout(root, &["rev-parse", "--is-inside-work-tree"]).as_deref() == Some("true")
}

fn git_head_branch(root: &Path) -> Option<String> {
    git_stdout(root, &["symbolic-ref", "--short", "HEAD"]).filter(|branch| branch != "HEAD")
}

fn git_ref_exists(root: &Path, name: &str) -> bool {
    git_run(root, &["show-ref", "--verify", "--quiet", name]).is_some()
}

fn git_remote_name(root: &Path) -> Option<String> {
    let remotes = git_stdout(root, &["remote"])?;
    let names: Vec<&str> = remotes.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    names
        .iter()
        .find(|name| **name == "origin")
        .or_else(|| names.first())
        .map(|name| name.to_string())
}

fn valid_branch_name(root: &Path, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Branch name is empty".into());
    }
    if git_run(root, &["check-ref-format", "--branch", name]).is_none() {
        return Err(format!("{name} is not a valid branch name"));
    }
    Ok(name.to_string())
}

#[derive(Clone, Default)]
struct FileAcc {
    additions: i64,
    deletions: i64,
    untracked: bool,
}

fn normalize_diff_path(path: &str) -> String {
    let path = path.trim();
    // `src/{old => new}.ts` keeps the shared prefix/suffix around the braces;
    // a plain `old => new` rename replaces the whole path.
    if let (Some(open), Some(close)) = (path.find('{'), path.rfind('}')) {
        if let Some((_, new)) = path[open + 1..close].split_once(" => ") {
            let joined = format!("{}{}{}", &path[..open], new, &path[close + 1..]);
            return path_to_js(Path::new(&joined.replace("//", "/")));
        }
    }
    let path = path.split_once(" => ").map_or(path, |(_, new)| new);
    path_to_js(Path::new(path))
}

fn add_numstat_map(text: &str, files: &mut HashMap<String, FileAcc>) {
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let relative = normalize_diff_path(path);
        if relative.is_empty() {
            continue;
        }
        let entry = files.entry(relative).or_default();
        if add != "-" && del != "-" {
            entry.additions += add.parse::<i64>().unwrap_or(0);
            entry.deletions += del.parse::<i64>().unwrap_or(0);
        }
    }
}

fn text_line_count(path: &Path) -> i64 {
    let Ok(meta) = std::fs::metadata(path) else { return 0 };
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_UNTRACKED_BYTES {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else { return 0 };
    if bytes.contains(&0) {
        return 0;
    }
    let mut lines = 1 + bytes.iter().filter(|b| **b == b'\n').count() as i64;
    if bytes.last() == Some(&b'\n') {
        lines -= 1;
    }
    lines
}

fn add_untracked_map(root: &Path, files: &mut HashMap<String, FileAcc>) {
    let Some(stdout) = git_run(root, &["ls-files", "-o", "--exclude-standard", "-z", "--", "."]) else {
        return;
    };
    for rel in stdout.split('\0').filter(|rel| !rel.is_empty()) {
        let entry = files.entry(path_to_js(Path::new(rel))).or_default();
        entry.untracked = true;
        if entry.additions == 0 {
            entry.additions = text_line_count(&root.join(rel));
        }
    }
}

fn changed_files(root: &Path) -> HashMap<String, FileAcc> {
    let mut files = HashMap::new();
    if let Some(text) = git_run(root, &["diff", "--relative", "--no-ext-diff", "--numstat", "HEAD", "--", "."]) {
        add_numstat_map(&text, &mut files);
    } else {
        // A repository without a first commit has no HEAD to diff against.
        if let Some(text) = git_run(root, &["diff", "--relative", "--no-ext-diff", "--numstat", "--", "."]) {
            add_numstat_map(&text, &mut files);
        }
        if let Some(text) = git_run(root, &["diff", "--relative", "--no-ext-diff", "--cached", "--numstat", "--", "."]) {
            add_numstat_map(&text, &mut files);
        }
    }
    add_untracked_map(root, &mut files);
    files
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffStats {
    pub files: i64,
    pub additions: i64,
    pub deletions: i64,
}

/// Uncommitted line counts: staged + unstaged vs HEAD, plus untracked files.
#[tauri::command]
pub async fn git_diff_stats(cwd: String) -> Result<GitDiffStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if !git_is_work_tree(&root) {
            return GitDiffStats::default();
        }
        let files = changed_files(&root);
        GitDiffStats {
            files: files.len() as i64,
            additions: files.values().map(|f| f.additions).sum(),
            deletions: files.values().map(|f| f.deletions).sum(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
}

/// Changed files with a one-letter status (M, A, D, U) for the Explorer.
#[tauri::command]
pub async fn git_changed_files(cwd: String) -> Result<Vec<GitChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if !git_is_work_tree(&root) {
            return Vec::new();
        }
        let mut statuses: HashMap<String, String> = HashMap::new();
        if let Some(text) = git_run(&root, &["diff", "--relative", "--name-status", "--no-renames", "HEAD", "--", "."]) {
            for line in text.lines() {
                if let Some((code, rest)) = line.split_once('\t') {
                    let letter = match code.as_bytes().first() {
                        Some(b'A') => "A",
                        Some(b'D') => "D",
                        _ => "M",
                    };
                    statuses.insert(path_to_js(Path::new(rest.trim())), letter.into());
                }
            }
        }
        let mut list: Vec<GitChangedFile> = changed_files(&root)
            .into_iter()
            .map(|(path, acc)| GitChangedFile {
                status: if acc.untracked {
                    "U".into()
                } else {
                    statuses.get(&path).cloned().unwrap_or_else(|| "M".into())
                },
                path,
                additions: acc.additions,
                deletions: acc.deletions,
            })
            .collect();
        list.sort_by(|a, b| a.path.cmp(&b.path));
        list
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<GitBranchEntry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEntry {
    pub name: String,
    pub current: bool,
    pub remote: Option<String>,
}

/// Local branches, plus remote-only branches that can be checked out.
#[tauri::command]
pub async fn git_branches(cwd: String) -> Result<GitBranches, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if !git_is_work_tree(&root) {
            return GitBranches::default();
        }
        let current_branch = git_head_branch(&root);
        let head_sha = git_stdout(&root, &["rev-parse", "--short", "HEAD"]);
        let detached = current_branch.is_none() && head_sha.is_some();
        let current = current_branch.clone().or(head_sha);
        let mut branches = Vec::new();
        let mut local = HashSet::new();
        if let Some(text) = git_run(&root, &["for-each-ref", "--format=%(refname:short)\t%(HEAD)", "--sort=-committerdate", "refs/heads"]) {
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                let (name, head) = line.split_once('\t').unwrap_or((line, ""));
                local.insert(name.to_string());
                branches.push(GitBranchEntry { name: name.into(), current: head.trim() == "*", remote: None });
            }
        }
        if let Some(remote) = git_remote_name(&root) {
            let prefix = format!("refs/remotes/{remote}");
            if let Some(text) = git_run(&root, &["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", &prefix]) {
                for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
                    let Some(name) = line.strip_prefix(&format!("{remote}/")) else { continue };
                    if name == "HEAD" || local.contains(name) {
                        continue;
                    }
                    branches.push(GitBranchEntry { name: name.into(), current: false, remote: Some(remote.clone()) });
                }
            }
        }
        GitBranches { current, detached, branches }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Switch to an existing branch, or create a local tracking branch from a remote.
#[tauri::command]
pub async fn git_checkout(cwd: String, name: String, remote: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if !git_is_work_tree(&root) {
            return Err("Not a git repository".to_string());
        }
        let name = valid_branch_name(&root, &name)?;
        if git_head_branch(&root).as_deref() == Some(name.as_str()) {
            return Ok(name);
        }
        if let Some(remote) = remote.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            git_checked(&root, &["checkout", "--track", &format!("{remote}/{name}")])?;
            return Ok(name);
        }
        if git_ref_exists(&root, &format!("refs/heads/{name}")) {
            git_checked(&root, &["checkout", &name])?;
            return Ok(name);
        }
        Err(format!("Branch {name} does not exist"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a branch from HEAD and switch to it.
#[tauri::command]
pub async fn git_create_branch(cwd: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if !git_is_work_tree(&root) {
            return Err("Not a git repository".to_string());
        }
        let name = valid_branch_name(&root, &name)?;
        if git_ref_exists(&root, &format!("refs/heads/{name}")) {
            return Err(format!("Branch {name} already exists"));
        }
        git_checked(&root, &["checkout", "-b", &name])?;
        Ok(name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub ignored: bool,
}

/// One directory level for the Explorer, folders first, gitignore aware.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = expand_home(&path);
        let read = std::fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut entries: Vec<DirEntry> = read
            .flatten()
            .take(MAX_DIR_ENTRIES)
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".git" || name == ".DS_Store" {
                    return None;
                }
                let full = entry.path();
                let is_dir = std::fs::metadata(&full).map(|m| m.is_dir()).unwrap_or(false);
                Some(DirEntry { name, path: path_to_js(&full), is_dir, ignored: false })
            })
            .collect();
        if git_is_work_tree(&dir) && !entries.is_empty() {
            let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
            let mut cmd = git_cmd();
            cmd.arg("-C").arg(&dir).args(["check-ignore", "--"]).args(&names);
            if let Ok(output) = cmd.output() {
                let ignored: HashSet<String> = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(|line| line.trim().trim_end_matches('/').to_string())
                    .collect();
                for entry in &mut entries {
                    entry.ignored = ignored.contains(&entry.name);
                }
            }
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A UTF-8 text file for the read-only editor tab.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
        if meta.len() > MAX_TEXT_BYTES {
            return Err("File is too large to preview".to_string());
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        if bytes.iter().take(8_000).any(|b| *b == 0) {
            return Err("Binary file".to_string());
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 打开中文件的轻量元信息（mtime + size），供编辑器轮询感知磁盘变更。
/// 文件不存在返回 `null`——被删掉也是一种需要通知的变更。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub mtime_ms: u64,
    pub size: u64,
}

#[tauri::command]
pub async fn file_meta(path: String) -> Result<Option<FileMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        match std::fs::metadata(&file) {
            Ok(meta) => {
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                Ok(Some(FileMeta { mtime_ms, size: meta.len() }))
            }
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a text file, creating the directories it needs.
///
/// The desktop editor tab is read-only today, so this exists for the writer the
/// phone *is*: a paired phone can edit a file on this machine, which is the
/// point of mirroring the workspace rather than previewing it.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = expand_home(&path);
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&file, contents).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a directory (and its parents).
#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(expand_home(&path)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Move or rename a path. A destination that exists is refused, so a rename
/// cannot silently destroy whatever was there.
#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = expand_home(&from);
        let destination = expand_home(&to);
        if destination.exists() {
            return Err(format!("{} 已存在", destination.display()));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&source, &destination).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a file, or a directory and everything under it.
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let target = expand_home(&path);
        let meta = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&target).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(&target).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_counts_and_renames() {
        let mut files = HashMap::new();
        add_numstat_map("3\t1\tsrc/a.ts\n-\t-\timg.png\n2\t0\tsrc/{old => new}.ts\n", &mut files);
        assert_eq!(files["src/a.ts"].additions, 3);
        assert_eq!(files["src/a.ts"].deletions, 1);
        assert_eq!(files["img.png"].additions, 0);
        assert!(files.contains_key("src/new.ts"));
    }
}

// ── Source-control surface (Orbit's git API surface, Orbit's git plumbing) ──

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffIndex {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub files: Vec<SourceControlFile>,
    pub additions: i64,
    pub deletions: i64,
    pub remote: Option<String>,
    pub upstream: Option<String>,
    pub default_branch: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub ahead_of_default: i64,
    pub head_pushed: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceControlFile {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub relative: String,
    pub status: String,
    pub original: String,
    pub current: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryRef {
    pub name: String,
    pub kind: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryCommit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub subject: String,
    pub refs: Vec<GitHistoryRef>,
    pub head: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitHistory {
    pub head: Option<String>,
    pub commits: Vec<GitHistoryCommit>,
}

/// Per-file staged/unstaged bookkeeping, so the panel can split rows like
/// Orbit's Changes list does.
fn index_files(root: &Path) -> Vec<SourceControlFile> {
    let mut staged_map: HashMap<String, FileAcc> = HashMap::new();
    if let Some(text) = git_run(root, &["diff", "--relative", "--no-ext-diff", "--cached", "--numstat", "--", "."]) {
        add_numstat_map(&text, &mut staged_map);
    }
    let mut unstaged_map: HashMap<String, FileAcc> = HashMap::new();
    if let Some(text) = git_run(root, &["diff", "--relative", "--no-ext-diff", "--numstat", "--", "."]) {
        add_numstat_map(&text, &mut unstaged_map);
    }
    if let Some(text) = git_run(root, &["ls-files", "-o", "--exclude-standard", "-z", "--", "."]) {
        for rel in text.split('\0').filter(|rel| !rel.is_empty()) {
            let entry = unstaged_map.entry(path_to_js(Path::new(rel))).or_default();
            entry.untracked = true;
            if entry.additions == 0 {
                entry.additions = text_line_count(&root.join(rel));
            }
        }
    }
    // Rename detection keeps the status letters honest for renamed files.
    let mut statuses: HashMap<String, String> = HashMap::new();
    for args in [
        vec!["diff", "--relative", "--name-status", "--no-renames", "--cached", "--", "."],
        vec!["diff", "--relative", "--name-status", "--no-renames", "--", "."],
    ] {
        if let Some(text) = git_run(root, &args) {
            for line in text.lines() {
                if let Some((code, rest)) = line.split_once('\t') {
                    let letter = match code.as_bytes().first() {
                        Some(b'A') => "added",
                        Some(b'D') => "deleted",
                        _ => "modified",
                    };
                    statuses.entry(normalize_diff_path(rest.trim())).or_insert(letter.into());
                }
            }
        }
    }
    if let Some(text) = git_run(root, &["ls-files", "-o", "--exclude-standard", "-z", "--", "."]) {
        for rel in text.split('\0').filter(|rel| !rel.is_empty()) {
            statuses.entry(path_to_js(Path::new(rel))).or_insert("untracked".into());
        }
    }

    let mut paths: Vec<String> = staged_map.keys().chain(unstaged_map.keys()).cloned().collect();
    paths.sort();
    paths.dedup();
    let mut files = Vec::new();
    for path in paths {
        let staged = staged_map.contains_key(&path);
        let unstaged_acc = unstaged_map.get(&path);
        let untracked = unstaged_acc.map(|acc| acc.untracked).unwrap_or(false);
        let acc_add = staged_map.get(&path).map(|acc| acc.additions).unwrap_or(0)
            + unstaged_acc.map(|acc| acc.additions).unwrap_or(0);
        let acc_del = staged_map.get(&path).map(|acc| acc.deletions).unwrap_or(0)
            + unstaged_acc.map(|acc| acc.deletions).unwrap_or(0);
        files.push(SourceControlFile {
            relative: path.clone(),
            path: root.join(&path).to_string_lossy().replace('\\', "/"),
            status: statuses.get(&path).cloned().unwrap_or_else(|| "modified".into()),
            additions: acc_add,
            deletions: acc_del,
            staged,
            unstaged: unstaged_acc.is_some() || untracked,
        });
    }
    files
}

fn default_branch(root: &Path, remote: &str) -> Option<String> {
    if let Some(name) = git_stdout(root, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")]) {
        return name.strip_prefix(&format!("{remote}/")).map(str::to_string);
    }
    for candidate in ["main", "master"] {
        if git_ref_exists(root, &format!("refs/remotes/{remote}/{candidate}")) {
            return Some(candidate.into());
        }
    }
    None
}

fn diff_index(root: &Path, include_sync: bool) -> GitDiffIndex {
    if !git_is_work_tree(root) {
        return GitDiffIndex::default();
    }
    let branch = git_head_branch(root);
    let head = git_stdout(root, &["rev-parse", "HEAD"]);
    let files = index_files(root);
    let additions = files.iter().map(|file| file.additions).sum();
    let deletions = files.iter().map(|file| file.deletions).sum();
    let remote = git_remote_name(root);
    let upstream = branch
        .as_deref()
        .and_then(|branch| git_stdout(root, &["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")]));
    let mut ahead = 0;
    let mut behind = 0;
    if let Some(upstream) = upstream.as_deref() {
        if let Some(count) = git_stdout(root, &["rev-list", "--count", &format!("{upstream}..HEAD")]) {
            ahead = count.parse().unwrap_or(0);
        }
        if let Some(count) = git_stdout(root, &["rev-list", "--count", &format!("HEAD..{upstream}")]) {
            behind = count.parse().unwrap_or(0);
        }
    }
    let default_branch = remote.as_deref().and_then(|remote| default_branch(root, remote));
    let mut ahead_of_default = 0;
    let mut head_pushed = false;
    if let (Some(remote), Some(default_branch)) = (remote.as_deref(), default_branch.as_deref()) {
        if let Some(count) = git_stdout(root, &["rev-list", "--count", &format!("{remote}/{default_branch}..HEAD")]) {
            ahead_of_default = count.parse().unwrap_or(0);
        }
        head_pushed = git_run(root, &["branch", "-r", "--contains", "HEAD"]).is_some();
    }
    let _ = include_sync;
    GitDiffIndex {
        branch,
        head,
        files,
        additions,
        deletions,
        remote,
        upstream,
        default_branch,
        ahead,
        behind,
        ahead_of_default,
        head_pushed,
    }
}

/// Full change index: staged + unstaged rows with ahead/behind sync state.
#[tauri::command]
pub async fn git_diff_index(cwd: String) -> Result<GitDiffIndex, String> {
    tauri::async_runtime::spawn_blocking(move || diff_index(&expand_home(&cwd), true))
        .await
        .map_err(|e| e.to_string())
}

/// File list and counts only, for diff views that do not need sync data.
#[tauri::command]
pub async fn git_diff_files(cwd: String) -> Result<GitDiffIndex, String> {
    tauri::async_runtime::spawn_blocking(move || diff_index(&expand_home(&cwd), false))
        .await
        .map_err(|e| e.to_string())
}

const DIFF_MAX_BYTES: u64 = 2 * 1024 * 1024;

fn blob_or_empty(root: &Path, spec: &str) -> String {
    git_run(root, &["show", spec]).unwrap_or_default()
}

fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

/// Full original/current contents for one file's unstaged or staged diff.
#[tauri::command]
pub async fn git_file_diff(cwd: String, relative: String, staged: bool) -> Result<GitFileDiff, String> {
    // Keep the RPC argument for older clients; the combined Changes view
    // compares HEAD with the working tree for both staged and unstaged rows.
    let _ = staged;
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let relative = relative.trim_start_matches('/');
        let worktree = root.join(relative);
        let current_bytes = std::fs::read(&worktree).unwrap_or_default();
        let original_bytes = if git_run(&root, &["cat-file", "-e", &format!("HEAD:{relative}")]).is_some() {
            blob_or_empty(&root, &format!("HEAD:{relative}")).into_bytes()
        } else {
            Vec::new()
        };
        let status = if std::fs::metadata(&worktree).is_err() {
            "deleted"
        } else if original_bytes.is_empty() {
            "untracked"
        } else {
            "modified"
        };
        let binary = is_binary_bytes(&current_bytes) || is_binary_bytes(&original_bytes);
        let too_large = current_bytes.len() as u64 > DIFF_MAX_BYTES || original_bytes.len() as u64 > DIFF_MAX_BYTES;
        let decode = |bytes: &[u8]| -> String {
            if binary || too_large { String::new() } else { String::from_utf8_lossy(bytes).into_owned() }
        };
        Ok(GitFileDiff {
            path: worktree.to_string_lossy().replace('\\', "/"),
            relative: relative.to_string(),
            status: status.into(),
            original: decode(&original_bytes),
            current: decode(&current_bytes),
            binary,
            too_large,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_history(root: &Path, limit: Option<u32>) -> GitHistory {
    let head = git_stdout(root, &["rev-parse", "HEAD"]);
    let limit = limit.unwrap_or(200).clamp(1, 2_000);
    let field_count = 6;
    let Some(text) = git_run(
        root,
        &[
            "log",
            "--date-order",
            &format!("--max-count={limit}"),
            "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%s%x1e",
            "--decorate=full",
        ],
    ) else {
        return GitHistory { head, commits: Vec::new() };
    };
    let head_refs: Vec<String> = git_run(root, &["for-each-ref", "--format=%(refname:short)\t%(objectname)", "refs/heads", "refs/remotes", "refs/tags"])
        .map(|text| {
            text.lines()
                .filter_map(|line| line.split_once('\t'))
                .map(|(name, sha)| format!("{sha}\t{name}"))
                .collect()
        })
        .unwrap_or_default();
    let mut commits = Vec::new();
    for entry in text.split('\u{1e}').filter(|entry| !entry.trim().is_empty()) {
        let fields: Vec<&str> = entry.trim_matches('\n').split('\u{1f}').collect();
        if fields.len() < field_count {
            continue;
        }
        let sha = fields[0].trim().to_string();
        if sha.is_empty() {
            continue;
        }
        let decorated = git_run(root, &["log", "-1", "--pretty=%D", &sha]).unwrap_or_default();
        let refs: Vec<GitHistoryRef> = decorated
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty() && *name != "HEAD" && *name != "origin/HEAD")
            .map(|name| {
                let kind = if name.starts_with("tag:") {
                    "tag"
                } else if name.contains('/') {
                    "remote"
                } else {
                    "local"
                };
                GitHistoryRef {
                    name: name.trim_start_matches("tag: ").to_string(),
                    kind: kind.into(),
                }
            })
            .collect();
        let _ = &head_refs;
        commits.push(GitHistoryCommit {
            short_sha: fields[1].trim().to_string(),
            parents: fields[2].split_whitespace().map(str::to_string).collect(),
            author: fields[3].trim().to_string(),
            timestamp: fields[4].trim().parse().unwrap_or(0),
            subject: fields[5].trim().to_string(),
            refs,
            head: head.as_deref() == Some(sha.as_str()),
            sha,
        });
    }
    GitHistory { head, commits }
}

/// Commit history for the graph, newest first.
#[tauri::command]
pub async fn git_history(cwd: String, limit: Option<u32>) -> Result<GitHistory, String> {
    tauri::async_runtime::spawn_blocking(move || parse_history(&expand_home(&cwd), limit))
        .await
        .map_err(|e| e.to_string())
}

/// Files touched by one commit, with per-file numstat.
#[tauri::command]
pub async fn git_commit_files(cwd: String, sha: String) -> Result<Vec<SourceControlFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let mut files = Vec::new();
        let Some(text) = git_run(&root, &["show", "--relative", "--no-ext-diff", "--numstat", "--no-renames", "--format=", &sha]) else {
            return files;
        };
        for line in text.lines() {
            let mut parts = line.splitn(3, '\t');
            let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            let relative = normalize_diff_path(path);
            if relative.is_empty() {
                continue;
            }
            files.push(SourceControlFile {
                path: root.join(&relative).to_string_lossy().replace('\\', "/"),
                relative: relative.clone(),
                status: "modified".into(),
                additions: add.parse().unwrap_or(0),
                deletions: del.parse().unwrap_or(0),
                staged: true,
                unstaged: false,
            });
        }
        files
    })
    .await
    .map_err(|e| e.to_string())
}

/// Full original/current contents for one file inside one commit.
#[tauri::command]
pub async fn git_commit_file_diff(cwd: String, sha: String, relative: String) -> Result<GitFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let original = blob_or_empty(&root, &format!("{sha}^:{relative}"));
        let current = blob_or_empty(&root, &format!("{sha}:{relative}"));
        let binary = is_binary_bytes(original.as_bytes()) || is_binary_bytes(current.as_bytes());
        let too_large = original.len() as u64 > DIFF_MAX_BYTES || current.len() as u64 > DIFF_MAX_BYTES;
        let decode = |text: String| -> String {
            if binary || too_large { String::new() } else { text }
        };
        Ok(GitFileDiff {
            path: root.join(&relative).to_string_lossy().replace('\\', "/"),
            relative,
            status: "modified".into(),
            original: decode(original),
            current: decode(current),
            binary,
            too_large,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage_file(cwd: String, relative: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        git_checked(&root, &["add", "--", &relative])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage_contents(cwd: String, relative: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let tmp = root.join(".git").join("orbit-stage-contents.tmp");
        std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
        let sha = git_stdout(&root, &["hash-object", "-w", "--", ".git/orbit-stage-contents.tmp"])
            .ok_or_else(|| "hash-object failed".to_string())?;
        let result = git_checked(&root, &["update-index", "--cacheinfo", &format!("100644,{sha},{relative}")]);
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage_file(cwd: String, relative: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if git_run(&root, &["rev-parse", "--verify", "HEAD"]).is_some() {
            git_checked(&root, &["reset", "HEAD", "--", &relative])
        } else {
            git_checked(&root, &["rm", "--cached", "--", &relative])
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard_file(cwd: String, relative: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if git_run(&root, &["ls-files", "--error-unmatch", "--", &relative]).is_some() {
            git_checked(&root, &["checkout", "HEAD", "--", &relative])?;
        }
        // Untracked files have no HEAD copy; deleting is the only discard.
        let worktree = root.join(&relative);
        if !git_run(&root, &["ls-files", "--", &relative]).is_some_and(|text| !text.trim().is_empty()) {
            let _ = std::fs::remove_file(&worktree);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_discard_all(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        git_checked(&root, &["checkout", "HEAD", "--", "."])?;
        git_checked(&root, &["clean", "-fd", "--", "."])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stage_all(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        git_checked(&root, &["add", "-A", "--", "."])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_unstage_all(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if git_run(&root, &["rev-parse", "--verify", "HEAD"]).is_some() {
            git_checked(&root, &["reset", "HEAD", "--", "."])
        } else {
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Commit the staged tree; `amend` keeps the author date and reuses the message.
#[tauri::command]
pub async fn git_commit(cwd: String, message: String, amend: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        if git_run(&root, &["rev-parse", "--verify", "HEAD"]).is_none() {
            // A repository without commits cannot amend or use HEAD-relative forms.
            if amend {
                return Err("Nothing to amend".into());
            }
            return git_checked(&root, &["commit", "-m", &message]);
        }
        if amend {
            let args: &[&str] = if message.trim().is_empty() {
                &["commit", "--amend", "--no-edit"]
            } else {
                &["commit", "--amend", "-m", &message]
            };
            git_checked(&root, args)
        } else {
            git_checked(&root, &["commit", "-m", &message])
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_head_message(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        git_stdout(&root, &["log", "-1", "--pretty=%s"]).ok_or_else(|| "No commits yet".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn push_args(root: &Path) -> Vec<String> {
    let branch = git_head_branch(root);
    let remote = git_remote_name(root);
    match (branch, remote) {
        (Some(branch), Some(remote)) => {
            if git_ref_exists(root, &format!("refs/remotes/{remote}/{branch}")) {
                vec!["push".into()]
            } else {
                vec!["push".into(), "--set-upstream".into(), remote, branch]
            }
        }
        _ => vec!["push".into()],
    }
}

#[tauri::command]
pub async fn git_push(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let args = push_args(&root);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_checked(&root, &refs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_pull(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        git_checked(&root, &["pull", "--no-rebase"])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pull then push in one click, so the branch ends up published and current.
#[tauri::command]
pub async fn git_sync(cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        git_checked(&root, &["pull", "--no-rebase"])?;
        let args = push_args(&root);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_checked(&root, &refs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStagedContext {
    pub branch: Option<String>,
    pub summary: String,
    pub patch: String,
}

/// What is staged right now, for AI commit-message generation.
#[tauri::command]
pub async fn git_staged_context(cwd: String) -> Result<GitStagedContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let branch = git_head_branch(&root);
        let summary = git_run(&root, &["diff", "--cached", "--stat", "--no-ext-diff"]).unwrap_or_default();
        let patch = git_run(&root, &["diff", "--cached", "--no-ext-diff"]).unwrap_or_default();
        Ok(GitStagedContext { branch, summary, patch })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitRangeContext {
    pub base: String,
    pub head: String,
    pub commit_summary: String,
    pub diff_summary: String,
    pub diff_patch: String,
}

/// Everything a PR description needs: commits and the full diff for the range.
#[tauri::command]
pub async fn git_range_context(cwd: String) -> Result<GitRangeContext, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let remote = git_remote_name(&root).ok_or_else(|| "No remote found".to_string())?;
        let default_branch = default_branch(&root, &remote);
        let base = default_branch
            .map(|branch| format!("{remote}/{branch}"))
            .or_else(|| git_stdout(&root, &["rev-parse", "HEAD"])) 
            .ok_or_else(|| "No default branch found".to_string())?;
        let head = git_head_branch(&root).or_else(|| git_stdout(&root, &["rev-parse", "--short", "HEAD"])).ok_or_else(|| "No branch found".to_string())?;
        let range = format!("{base}..{head}");
        let commit_summary = git_run(&root, &["log", "--pretty=format:%h %s", &range]).unwrap_or_default();
        let diff_summary = git_run(&root, &["diff", "--stat", "--no-ext-diff", &range]).unwrap_or_default();
        let diff_patch = git_run(&root, &["diff", "--no-ext-diff", &range]).unwrap_or_default();
        Ok(GitRangeContext { base, head, commit_summary, diff_summary, diff_patch })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitPr {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
}

fn gh_command(root: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("gh");
    cmd.arg("-C").arg(root).args(args).env("GIT_TERMINAL_PROMPT", "0");
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The open PR for the current branch, if the `gh` CLI is installed.
#[tauri::command]
pub async fn git_pr_status(cwd: String) -> Result<Option<GitPr>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let Some(text) = gh_command(&root, &["pr", "view", "--json", "number,title,url,state"]) else {
            return Ok(None);
        };
        #[derive(serde::Deserialize)]
        struct RawPr {
            number: i64,
            title: String,
            url: String,
            state: String,
        }
        let parsed: RawPr = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(Some(GitPr {
            number: parsed.number,
            title: parsed.title,
            url: parsed.url,
            state: parsed.state,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a PR from the current branch via the `gh` CLI; returns the PR URL.
#[tauri::command]
pub async fn git_pr_create(cwd: String, title: String, body: String, base: String, head: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = expand_home(&cwd);
        let output = Command::new("gh")
            .arg("-C")
            .arg(&root)
            .args(["pr", "create", "--title", &title, "--body", &body, "--base", &base, "--head", &head])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() { stdout.trim().to_string() } else { stderr });
        }
        stdout
            .lines()
            .rev()
            .find(|line| line.starts_with("http"))
            .map(str::to_string)
            .ok_or_else(|| stdout.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
