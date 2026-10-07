//! Workspace Git and file-tree backend for the MonoCode-style shell.
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

fn expand_home(path: &str) -> PathBuf {
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
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
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
