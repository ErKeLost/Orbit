//! GitHub inbox through the GitHub CLI (`gh`). Ported from MonoCode's `fs.rs`
//! inbox section: work items, details, conversation threads, comments, PR
//! actions, diffs (with a large-context git fallback), and CI checks.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_PR_DIFF_BYTES: usize = 2 * 1024 * 1024;
const PR_FULL_CONTEXT_LINES: &str = "999999";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubLabel {
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAssignee {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubWorkItem {
    pub kind: String,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub state_reason: String,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<GitHubLabel>,
    pub assignees: Vec<GitHubAssignee>,
    pub draft: bool,
    pub repo: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub connected: bool,
    pub installed: bool,
    pub authenticated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubWorkItemDetails {
    pub body: String,
    pub author: String,
    pub author_avatar_url: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub review_decision: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubWorkItemComment {
    pub id: String,
    pub kind: String,
    pub author: String,
    pub author_avatar_url: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
    pub state: String,
    pub path: String,
    pub line: Option<i64>,
    pub resolved: bool,
    pub thread_id: String,
    pub replies: Vec<GitHubWorkItemComment>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubWorkItemCommit {
    pub oid: String,
    pub message_headline: String,
    pub author: String,
    pub committed_date: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubWorkItemThread {
    pub comments: Vec<GitHubWorkItemComment>,
    pub commits: Vec<GitHubWorkItemCommit>,
    pub truncated: bool,
    pub review_decision: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrFile {
    pub path: String,
    pub additions: i64,
    pub deletions: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrDiff {
    pub additions: i64,
    pub deletions: i64,
    pub files: Vec<GitHubPrFile>,
    pub patch: String,
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrCheck {
    pub name: String,
    pub workflow: String,
    pub state: String,
    pub url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPrChecks {
    pub head_oid: String,
    pub checks: Vec<GitHubPrCheck>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCheckDetails {
    pub steps: Vec<GitHubCheckStep>,
    pub annotations: Vec<GitHubCheckAnnotation>,
    pub notice: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCheckStep {
    pub name: String,
    pub state: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GitHubCheckAnnotation {
    #[serde(default)]
    pub path: String,
    #[serde(default, rename(deserialize = "start_line"))]
    pub line: u64,
    #[serde(default)]
    pub message: String,
    #[serde(default, rename(deserialize = "annotation_level"))]
    pub level: String,
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().filter(|value| !value.is_empty())
}

fn expand_home(input: &str) -> PathBuf {
    if input == "~" {
        return dirs_home()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(input));
    }
    if let Some(rest) = input.strip_prefix("~/") {
        return dirs_home()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(rest);
    }
    PathBuf::from(input)
}

/// Whether the GitHub CLI is installed and has an active authenticated account.
#[tauri::command]
pub async fn git_github_status() -> Result<GitHubStatus, String> {
    tauri::async_runtime::spawn_blocking(git_github_status_for)
        .await
        .map_err(|error| error.to_string())
}

fn git_github_status_for() -> GitHubStatus {
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "status", "--active", "--hostname", "github.com"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GIT_PAGER", "cat");
    crate::hide_window_console(&mut cmd);
    let authenticated = cmd
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    GitHubStatus {
        connected: authenticated,
        installed: true,
        authenticated,
    }
}

/// `owner/repo` for the GitHub remote of this working copy, via `gh`.
#[tauri::command]
pub async fn git_github_repo(cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_github_repo_for(&expand_home(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

/// The GitHub remote of this working copy and, when it is a fork, its parent.
#[tauri::command]
pub async fn git_github_repositories(cwd: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_github_repositories_for(&expand_home(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

/// Open issues or pull requests for one GitHub repository, via `gh`.
#[tauri::command]
pub async fn git_github_work_items(
    cwd: String,
    repo: String,
    kind: String,
    assigned_to_me: bool,
    state: String,
    search: String,
    limit: Option<u32>,
) -> Result<Vec<GitHubWorkItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_work_items_for(
            &expand_home(&cwd),
            &repo,
            &kind,
            assigned_to_me,
            &state,
            &search,
            limit.unwrap_or(40),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One issue or pull request by number.
#[tauri::command]
pub async fn git_github_work_item(
    cwd: String,
    repo: String,
    kind: String,
    number: i64,
) -> Result<GitHubWorkItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_work_item_for(&expand_home(&cwd), &repo, &kind, number)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Issue or pull request body for the inbox detail pane.
#[tauri::command]
pub async fn git_github_work_item_details(
    cwd: String,
    repo: String,
    kind: String,
    number: i64,
) -> Result<GitHubWorkItemDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_work_item_details_for(&expand_home(&cwd), &repo, &kind, number)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Conversation for the inbox detail pane: comments, reviews, and review threads.
#[tauri::command]
pub async fn git_github_work_item_thread(
    cwd: String,
    repo: String,
    kind: String,
    number: i64,
) -> Result<GitHubWorkItemThread, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_work_item_thread_for(&expand_home(&cwd), &repo, &kind, number)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Post a conversation comment, or a reply on a review thread.
#[tauri::command]
pub async fn git_github_work_item_comment(
    cwd: String,
    repo: String,
    kind: String,
    number: i64,
    body: String,
    in_reply_to: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_work_item_comment_for(
            &expand_home(&cwd),
            &repo,
            &kind,
            number,
            &body,
            &in_reply_to,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Merge or change the lifecycle state of a GitHub pull request via `gh`.
#[tauri::command]
pub async fn git_github_pr_action(
    cwd: String,
    repo: String,
    number: i64,
    action: String,
) -> Result<GitHubWorkItem, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_pr_action_for(&expand_home(&cwd), &repo, number, &action)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unified diff and file stats for a pull request, via `gh`.
/// When `full_context` is true, prefer a large-context `git diff` between the PR OIDs.
#[tauri::command]
pub async fn git_github_pr_diff(
    cwd: String,
    repo: String,
    number: i64,
    full_context: Option<bool>,
) -> Result<GitHubPrDiff, String> {
    let full_context = full_context.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        git_github_pr_diff_for(&expand_home(&cwd), &repo, number, full_context)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// CI checks for one pull request, targeted explicitly by `repo` and `number` via `gh`.
#[tauri::command]
pub async fn git_github_pr_checks(
    cwd: String,
    repo: String,
    number: i64,
) -> Result<GitHubPrChecks, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_github_pr_checks_for(&expand_home(&cwd), &repo, number)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_github_check_details(
    cwd: String,
    repo: String,
    job_id: String,
) -> Result<GitHubCheckDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github_check_details_with(&repo, &job_id, |endpoint| {
            gh_checked(
                &expand_home(&cwd),
                &["api", "--hostname", "github.com", endpoint],
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn github_check_details_with(
    repo: &str,
    job_id: &str,
    mut fetch: impl FnMut(&str) -> Result<String, String>,
) -> Result<GitHubCheckDetails, String> {
    let (owner, name) = split_github_repo(repo)?;
    // Only repository slugs and numeric IDs can enter API paths.
    if [&owner, &name].iter().any(|part| {
        matches!(part.as_str(), "." | "..")
            || !part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    }) || job_id.parse::<u64>().ok().filter(|id| *id > 0).is_none()
        || !job_id.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("Invalid GitHub repository or job ID".into());
    }
    #[derive(Deserialize)]
    struct Step {
        name: String,
        status: String,
        conclusion: Option<String>,
        started_at: Option<String>,
        completed_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct Job {
        id: u64,
        #[serde(default)]
        steps: Vec<Step>,
        check_run_url: Option<String>,
    }
    let prefix = format!("repos/{owner}/{name}");
    let json = fetch(&format!("{prefix}/actions/jobs/{job_id}"))?;
    let job: Job = serde_json::from_str(&json).map_err(|error| error.to_string())?;
    if job.id.to_string() != job_id {
        return Err("GitHub returned a different job".into());
    }
    let mut details = GitHubCheckDetails {
        steps: job
            .steps
            .into_iter()
            .map(|step| GitHubCheckStep {
                name: step.name,
                state: github_check_state(
                    &step.status,
                    step.conclusion.as_deref().unwrap_or_default(),
                ),
                started_at: step.started_at,
                completed_at: step.completed_at,
            })
            .collect(),
        annotations: vec![],
        notice: None,
    };
    let check_prefix = format!("https://api.github.com/{prefix}/check-runs/");
    let check_id = job
        .check_run_url
        .as_deref()
        .and_then(|value| value.strip_prefix(&check_prefix))
        .filter(|value| !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()));
    if let Some(check_id) = check_id {
        let annotations = fetch(&format!(
            "{prefix}/check-runs/{check_id}/annotations?per_page=100"
        ))
        .and_then(|json| {
            serde_json::from_str::<Vec<GitHubCheckAnnotation>>(&json)
                .map_err(|error| error.to_string())
        });
        match annotations {
            Ok(annotations) => {
                if annotations.len() == 100 {
                    details.notice = Some(
                        "Showing the first 100 annotations. View the full log on GitHub for more."
                            .into(),
                    );
                }
                details.annotations = annotations;
            }
            Err(_) => {
                details.notice =
                    Some("Could not load error annotations. View the full log on GitHub.".into())
            }
        }
    } else {
        details.notice =
            Some("Error annotations are unavailable. View the full log on GitHub.".into());
    }
    Ok(details)
}

fn git_github_repo_for(root: &Path) -> Result<String, String> {
    let json = gh_checked(root, &["repo", "view", "--json", "nameWithOwner"])?;
    #[derive(Deserialize)]
    struct View {
        #[serde(rename = "nameWithOwner")]
        name_with_owner: String,
    }
    let view: View = serde_json::from_str(&json).map_err(|error| error.to_string())?;
    let slug = view.name_with_owner.trim();
    if slug.is_empty() || !slug.contains('/') {
        return Err("GitHub did not return a repository".into());
    }
    Ok(slug.to_string())
}

fn git_github_repositories_for(root: &Path) -> Result<Vec<String>, String> {
    let json = gh_checked(root, &["repo", "view", "--json", "nameWithOwner,parent"])?;
    parse_github_repositories(&json)
}

fn parse_github_repositories(json: &str) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct Owner {
        login: String,
    }
    #[derive(Deserialize)]
    struct Parent {
        name: String,
        owner: Owner,
    }
    #[derive(Deserialize)]
    struct View {
        #[serde(rename = "nameWithOwner")]
        name_with_owner: String,
        #[serde(default)]
        parent: Option<Parent>,
    }

    let view: View = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let (owner, name) = split_github_repo(&view.name_with_owner)?;
    let mut repos = vec![format!("{owner}/{name}")];
    if let Some(parent) = view.parent {
        let parent = format!("{}/{}", parent.owner.login, parent.name);
        let (owner, name) = split_github_repo(&parent)?;
        let parent = format!("{owner}/{name}");
        if !repos[0].eq_ignore_ascii_case(&parent) {
            repos.push(parent);
        }
    }
    Ok(repos)
}

fn git_github_work_items_for(
    root: &Path,
    repo: &str,
    kind: &str,
    assigned_to_me: bool,
    state: &str,
    search: &str,
    limit: u32,
) -> Result<Vec<GitHubWorkItem>, String> {
    let kind = kind.trim();
    if kind != "issue" && kind != "pr" {
        return Err("Unknown GitHub task kind".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let state = if state.trim().eq_ignore_ascii_case("all") {
        "all"
    } else {
        "open"
    };
    let limit = limit.clamp(1, 100).to_string();
    let fields = if kind == "pr" {
        "number,title,url,state,createdAt,updatedAt,labels,assignees,isDraft"
    } else {
        "number,title,url,state,stateReason,createdAt,updatedAt,labels,assignees"
    };
    let mut args = vec![
        kind.to_string(),
        "list".into(),
        "--state".into(),
        state.into(),
        "--limit".into(),
        limit,
        "--repo".into(),
        repo.clone(),
        "--json".into(),
        fields.into(),
    ];
    if assigned_to_me {
        args.push("--assignee".into());
        args.push("@me".into());
    }
    let search = search.trim();
    if !search.is_empty() {
        args.push("--search".into());
        args.push(search.to_string());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let json = gh_checked(root, &refs)?;
    parse_github_work_items(&json, kind, &repo)
}

fn git_github_work_item_for(
    root: &Path,
    repo: &str,
    kind: &str,
    number: i64,
) -> Result<GitHubWorkItem, String> {
    let kind = kind.trim();
    if kind != "issue" && kind != "pr" {
        return Err("Unknown GitHub task kind".into());
    }
    if number <= 0 {
        return Err("GitHub task number must be positive".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let number = number.to_string();
    let fields = if kind == "pr" {
        "number,title,url,state,createdAt,updatedAt,labels,assignees,isDraft"
    } else {
        "number,title,url,state,stateReason,createdAt,updatedAt,labels,assignees"
    };
    let json = gh_checked(
        root,
        &[kind, "view", &number, "--repo", &repo, "--json", fields],
    )?;
    parse_github_work_item(&json, kind, &repo)
}

fn github_pr_action_args(repo: &str, number: i64, action: &str) -> Result<Vec<String>, String> {
    if number <= 0 {
        return Err("GitHub pull request number must be positive".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let number = number.to_string();
    let args = match action.trim() {
        "merge" => vec!["pr", "merge", &number, "--repo", &repo, "--merge"],
        "squash" => vec!["pr", "merge", &number, "--repo", &repo, "--squash"],
        "rebase" => vec!["pr", "merge", &number, "--repo", &repo, "--rebase"],
        "draft" => vec!["pr", "ready", &number, "--repo", &repo, "--undo"],
        "ready" => vec!["pr", "ready", &number, "--repo", &repo],
        "close" => vec!["pr", "close", &number, "--repo", &repo],
        "reopen" => vec!["pr", "reopen", &number, "--repo", &repo],
        _ => return Err("Unknown GitHub pull request action".into()),
    };
    Ok(args.into_iter().map(str::to_string).collect())
}

fn git_github_pr_action_for(
    root: &Path,
    repo: &str,
    number: i64,
    action: &str,
) -> Result<GitHubWorkItem, String> {
    let args = github_pr_action_args(repo, number, action)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    // Successful mutation commands do not always write to stdout. Their exit
    // status confirms the action ran; the follow-up view fetches the new state.
    gh_run(root, &refs, true)?;
    git_github_work_item_for(root, repo, "pr", number)
}

fn git_github_work_item_details_for(
    root: &Path,
    repo: &str,
    kind: &str,
    number: i64,
) -> Result<GitHubWorkItemDetails, String> {
    let kind = kind.trim();
    if kind != "issue" && kind != "pr" {
        return Err("Unknown GitHub task kind".into());
    }
    if number <= 0 {
        return Err("Invalid GitHub item number".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let number = number.to_string();
    let fields = if kind == "pr" {
        "body,author,baseRefName,headRefName,reviewDecision"
    } else {
        "body,author"
    };
    let json = gh_checked(
        root,
        &[kind, "view", &number, "--repo", &repo, "--json", fields],
    )?;
    parse_github_work_item_details(&json)
}

fn parse_github_work_item_details(json: &str) -> Result<GitHubWorkItemDetails, String> {
    #[derive(Deserialize)]
    struct Author {
        #[serde(default)]
        login: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        #[serde(default)]
        body: String,
        #[serde(default)]
        author: Option<Author>,
        #[serde(default)]
        base_ref_name: String,
        #[serde(default)]
        head_ref_name: String,
        #[serde(default)]
        review_decision: Option<String>,
    }
    let row: Row = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let author = row.author.map(|author| author.login).unwrap_or_default();
    let author_avatar_url = github_avatar_url(&author);
    Ok(GitHubWorkItemDetails {
        body: row.body,
        author,
        author_avatar_url,
        base_ref_name: row.base_ref_name,
        head_ref_name: row.head_ref_name,
        review_decision: row.review_decision.unwrap_or_default(),
    })
}

const GITHUB_ISSUE_THREAD_QUERY: &str = r#"
query InboxIssueThread($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: 40) {
        totalCount
        nodes {
          id
          author { login }
          body
          createdAt
          url
          isMinimized
        }
      }
    }
  }
}
"#;

const GITHUB_PR_THREAD_QUERY: &str = r#"
query InboxPullRequestThread($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      baseRefName
      headRefName
      commits(last: 40) {
        totalCount
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
            url
            author {
              name
              user { login }
            }
          }
        }
      }
      comments(last: 40) {
        totalCount
        nodes {
          id
          author { login }
          body
          createdAt
          url
          isMinimized
        }
      }
      reviews(last: 40) {
        totalCount
        nodes {
          id
          author { login }
          body
          state
          submittedAt
          url
        }
      }
      reviewThreads(last: 20) {
        totalCount
        nodes {
          id
          isResolved
          path
          comments(first: 8) {
            totalCount
            nodes {
              id
              author { login }
              body
              createdAt
              url
              path
              line
              originalLine
              isMinimized
            }
          }
        }
      }
    }
  }
}
"#;

const GITHUB_REVIEW_REPLY_MUTATION: &str = r#"
mutation InboxReviewReply($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {
    pullRequestReviewThreadId: $threadId
    body: $body
  }) {
    comment { url }
  }
}
"#;

fn git_github_work_item_thread_for(
    root: &Path,
    repo: &str,
    kind: &str,
    number: i64,
) -> Result<GitHubWorkItemThread, String> {
    let kind = kind.trim();
    if kind != "issue" && kind != "pr" {
        return Err("Unknown GitHub task kind".into());
    }
    if number <= 0 {
        return Err("Invalid GitHub item number".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let query = if kind == "pr" {
        GITHUB_PR_THREAD_QUERY
    } else {
        GITHUB_ISSUE_THREAD_QUERY
    };
    let owner_field = format!("owner={owner}");
    let name_field = format!("name={name}");
    let number_field = format!("number={number}");
    let json = gh_checked(
        root,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-F",
            &owner_field,
            "-F",
            &name_field,
            "-F",
            &number_field,
        ],
    )?;
    parse_github_work_item_thread(&json, kind)
}

fn github_comment_input<'a>(
    kind: &'a str,
    number: i64,
    body: &'a str,
) -> Result<(&'a str, &'a str), String> {
    let kind = kind.trim();
    if kind != "issue" && kind != "pr" {
        return Err("Unknown GitHub task kind".into());
    }
    if number <= 0 {
        return Err("Invalid GitHub item number".into());
    }
    let body = body.trim();
    if body.is_empty() {
        return Err("Comment cannot be empty".into());
    }
    Ok((kind, body))
}

fn git_github_work_item_comment_for(
    root: &Path,
    repo: &str,
    kind: &str,
    number: i64,
    body: &str,
    in_reply_to: &str,
) -> Result<String, String> {
    let (kind, body) = github_comment_input(kind, number, body)?;
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let reply = in_reply_to.trim();
    if !reply.is_empty() {
        return git_github_review_reply_for(root, reply, body);
    }
    let number = number.to_string();
    with_temp_markdown(body, |path| {
        let output = gh_checked(
            root,
            &[
                kind,
                "comment",
                &number,
                "--repo",
                &repo,
                "--body-file",
                path,
            ],
        )?;
        github_url_from_output(&output, "GitHub did not return a comment URL")
    })
}

fn git_github_review_reply_for(root: &Path, thread_id: &str, body: &str) -> Result<String, String> {
    if !valid_github_node_id(thread_id) {
        return Err("Invalid review thread".into());
    }
    let thread_field = format!("threadId={thread_id}");
    with_temp_markdown(body, |path| {
        let body_field = format!("body=@{path}");
        let json = gh_checked(
            root,
            &[
                "api",
                "graphql",
                "-f",
                &format!("query={GITHUB_REVIEW_REPLY_MUTATION}"),
                "-F",
                &thread_field,
                "-F",
                &body_field,
            ],
        )?;
        parse_github_review_reply_url(&json)
    })
}

fn with_temp_markdown(
    body: &str,
    run: impl FnOnce(&str) -> Result<String, String>,
) -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("orbit-comment-{stamp}.md"));
    fs::write(&path, body).map_err(|error| error.to_string())?;
    let path_str = path.to_string_lossy().into_owned();
    let result = run(&path_str);
    let _ = fs::remove_file(&path);
    result
}

fn valid_github_node_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty()
        && id.len() < 256
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '='))
}

fn github_url_from_output(output: &str, missing: &str) -> Result<String, String> {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| line.starts_with("http://") || line.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| {
            if output.trim().is_empty() {
                missing.to_string()
            } else {
                output.trim().to_string()
            }
        })
}

fn parse_github_review_reply_url(json: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    if let Some(message) = value
        .get("errors")
        .and_then(|errors| errors.as_array())
        .and_then(|errors| errors.first())
        .and_then(|error| error.get("message"))
        .and_then(|message| message.as_str())
        .map(str::trim)
        .filter(|message| !message.is_empty())
    {
        return Err(message.to_string());
    }
    let url = value
        .pointer("/data/addPullRequestReviewThreadReply/comment/url")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    if url.starts_with("http://") || url.starts_with("https://") {
        return Ok(url.to_string());
    }
    Err("GitHub did not return a comment URL".into())
}

fn split_github_repo(slug: &str) -> Result<(String, String), String> {
    let slug = slug.trim();
    let Some((owner, name)) = slug.split_once('/') else {
        return Err("GitHub did not return a repository".into());
    };
    let owner = owner.trim();
    let name = name.trim();
    if owner.is_empty()
        || name.is_empty()
        || name.contains('/')
        || owner.chars().any(char::is_whitespace)
        || name.chars().any(char::is_whitespace)
    {
        return Err("GitHub did not return a repository".into());
    }
    Ok((owner.to_string(), name.to_string()))
}

#[derive(Deserialize)]
struct GithubGraphqlEnvelope {
    #[serde(default)]
    data: Option<GithubGraphqlData>,
    #[serde(default)]
    errors: Vec<GithubGraphqlError>,
}

#[derive(Deserialize)]
struct GithubGraphqlError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct GithubGraphqlData {
    repository: Option<GithubGraphqlRepository>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubGraphqlRepository {
    issue: Option<GithubGraphqlIssue>,
    pull_request: Option<GithubGraphqlPullRequest>,
}

#[derive(Deserialize)]
struct GithubGraphqlIssue {
    #[serde(default)]
    comments: GithubGraphqlNodes<GithubGraphqlComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubGraphqlPullRequest {
    #[serde(default)]
    review_decision: Option<String>,
    #[serde(default)]
    base_ref_name: String,
    #[serde(default)]
    head_ref_name: String,
    #[serde(default)]
    commits: GithubGraphqlNodes<GithubGraphqlCommitNode>,
    #[serde(default)]
    comments: GithubGraphqlNodes<GithubGraphqlComment>,
    #[serde(default)]
    reviews: GithubGraphqlNodes<GithubGraphqlReview>,
    #[serde(default)]
    review_threads: GithubGraphqlNodes<GithubGraphqlReviewThread>,
}

#[derive(Deserialize)]
struct GithubGraphqlCommitNode {
    commit: GithubGraphqlCommit,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubGraphqlCommit {
    #[serde(default)]
    oid: String,
    #[serde(default)]
    message_headline: String,
    #[serde(default)]
    committed_date: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    author: Option<GithubGraphqlCommitAuthor>,
}

#[derive(Deserialize)]
struct GithubGraphqlCommitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    user: Option<GithubGraphqlActor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubGraphqlNodes<T> {
    total_count: i64,
    nodes: Vec<T>,
}

impl<T> Default for GithubGraphqlNodes<T> {
    fn default() -> Self {
        Self {
            total_count: 0,
            nodes: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubGraphqlComment {
    #[serde(default)]
    id: String,
    #[serde(default)]
    author: Option<GithubGraphqlActor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_minimized: bool,
    #[serde(default)]
    path: String,
    #[serde(default)]
    line: Option<i64>,
    #[serde(default)]
    original_line: Option<i64>,
}

#[derive(Deserialize)]
struct GithubGraphqlReview {
    #[serde(default)]
    id: String,
    #[serde(default)]
    author: Option<GithubGraphqlActor>,
    #[serde(default)]
    body: String,
    #[serde(default)]
    state: String,
    #[serde(default, rename = "submittedAt")]
    submitted_at: Option<String>,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubGraphqlReviewThread {
    #[serde(default)]
    id: String,
    #[serde(default)]
    is_resolved: bool,
    #[serde(default)]
    path: String,
    #[serde(default)]
    comments: GithubGraphqlNodes<GithubGraphqlComment>,
}

#[derive(Deserialize)]
struct GithubGraphqlActor {
    #[serde(default)]
    login: String,
}

fn parse_github_work_item_thread(json: &str, kind: &str) -> Result<GitHubWorkItemThread, String> {
    let envelope: GithubGraphqlEnvelope =
        serde_json::from_str(json).map_err(|error| error.to_string())?;
    let graphql_error = envelope
        .errors
        .iter()
        .map(|error| error.message.trim())
        .find(|message| !message.is_empty())
        .map(str::to_string);
    let Some(repository) = envelope.data.and_then(|data| data.repository) else {
        return Err(graphql_error.unwrap_or_else(|| "GitHub item not found".into()));
    };

    let mut comments = Vec::new();
    let mut commits = Vec::new();
    let mut truncated = false;
    let mut review_decision = String::new();
    let mut base_ref_name = String::new();
    let mut head_ref_name = String::new();

    if kind == "pr" {
        let Some(pull) = repository.pull_request else {
            return Err(graphql_error.unwrap_or_else(|| "GitHub pull request not found".into()));
        };
        review_decision = pull.review_decision.unwrap_or_default();
        base_ref_name = pull.base_ref_name;
        head_ref_name = pull.head_ref_name;
        truncated |= github_nodes_truncated(&pull.commits);
        commits.extend(pull.commits.nodes.into_iter().filter_map(|node| {
            let commit = node.commit;
            if commit.oid.trim().is_empty() || commit.committed_date.trim().is_empty() {
                return None;
            }
            let author = commit
                .author
                .map(|author| {
                    author
                        .user
                        .map(|user| user.login)
                        .filter(|login| !login.trim().is_empty())
                        .unwrap_or(author.name)
                })
                .unwrap_or_default();
            Some(GitHubWorkItemCommit {
                oid: commit.oid,
                message_headline: commit.message_headline,
                author,
                committed_date: commit.committed_date,
                url: commit.url,
            })
        }));
        truncated |= github_nodes_truncated(&pull.comments);
        comments.extend(
            pull.comments
                .nodes
                .into_iter()
                .filter_map(github_issue_comment),
        );
        truncated |= github_nodes_truncated(&pull.reviews);
        comments.extend(
            pull.reviews
                .nodes
                .into_iter()
                .filter_map(github_review_comment),
        );
        truncated |= github_nodes_truncated(&pull.review_threads);
        comments.extend(
            pull.review_threads
                .nodes
                .into_iter()
                .filter_map(github_review_thread),
        );
    } else {
        let Some(issue) = repository.issue else {
            return Err(graphql_error.unwrap_or_else(|| "GitHub issue not found".into()));
        };
        truncated |= github_nodes_truncated(&issue.comments);
        comments.extend(
            issue
                .comments
                .nodes
                .into_iter()
                .filter_map(github_issue_comment),
        );
    }

    comments.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(GitHubWorkItemThread {
        comments,
        commits,
        truncated,
        review_decision,
        base_ref_name,
        head_ref_name,
    })
}

fn github_nodes_truncated<T>(nodes: &GithubGraphqlNodes<T>) -> bool {
    (nodes.nodes.len() as i64) < nodes.total_count
}

fn github_actor_login(author: Option<GithubGraphqlActor>) -> String {
    author
        .map(|author| author.login)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn github_comment_id(kind: &str, id: &str, author: &str, created_at: &str) -> String {
    let id = id.trim();
    if !id.is_empty() {
        return id.to_string();
    }
    format!("{kind}:{author}:{created_at}")
}

fn github_issue_comment(comment: GithubGraphqlComment) -> Option<GitHubWorkItemComment> {
    github_mapped_comment(comment, "comment", "", false)
}

fn github_mapped_comment(
    comment: GithubGraphqlComment,
    kind: &str,
    fallback_path: &str,
    resolved: bool,
) -> Option<GitHubWorkItemComment> {
    if comment.is_minimized {
        return None;
    }
    let author = github_actor_login(comment.author);
    let created_at = comment.created_at.trim().to_string();
    let path = if comment.path.trim().is_empty() {
        fallback_path.trim().to_string()
    } else {
        comment.path.trim().to_string()
    };
    Some(GitHubWorkItemComment {
        id: github_comment_id(kind, &comment.id, &author, &created_at),
        kind: kind.to_string(),
        author_avatar_url: github_avatar_url(&author),
        author,
        body: comment.body,
        created_at,
        url: comment.url,
        state: String::new(),
        path,
        line: comment.line.or(comment.original_line),
        resolved,
        thread_id: String::new(),
        replies: Vec::new(),
    })
}

fn github_review_comment(review: GithubGraphqlReview) -> Option<GitHubWorkItemComment> {
    let state = review.state.trim().to_uppercase();
    if state.is_empty() || state == "PENDING" {
        return None;
    }
    let body = review.body.trim();
    if state == "COMMENTED" && body.is_empty() {
        return None;
    }
    let created_at = review
        .submitted_at
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    if created_at.is_empty() {
        return None;
    }
    let author = github_actor_login(review.author);
    Some(GitHubWorkItemComment {
        id: github_comment_id("review", &review.id, &author, &created_at),
        kind: "review".into(),
        author_avatar_url: github_avatar_url(&author),
        author,
        body: review.body,
        created_at,
        url: review.url,
        state,
        path: String::new(),
        line: None,
        resolved: false,
        thread_id: String::new(),
        replies: Vec::new(),
    })
}

fn github_review_thread(thread: GithubGraphqlReviewThread) -> Option<GitHubWorkItemComment> {
    let thread_id = thread.id.trim().to_string();
    let mut mapped = thread.comments.nodes.into_iter().filter_map(|comment| {
        github_mapped_comment(comment, "review_comment", &thread.path, thread.is_resolved)
    });
    let mut first = mapped.next()?;
    first.thread_id = thread_id.clone();
    first.replies = mapped
        .map(|mut reply| {
            reply.thread_id = thread_id.clone();
            reply
        })
        .collect();
    Some(first)
}

fn github_avatar_url(login: &str) -> String {
    let login = login.trim();
    if login.is_empty() {
        return String::new();
    }
    let mut encoded = String::with_capacity(login.len());
    for byte in login.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("https://avatars.githubusercontent.com/{encoded}?s=64")
}

fn git_github_pr_diff_for(
    root: &Path,
    repo: &str,
    number: i64,
    full_context: bool,
) -> Result<GitHubPrDiff, String> {
    if number <= 0 {
        return Err("Invalid pull request number".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let number = number.to_string();
    let fields = if full_context {
        "files,additions,deletions,baseRefOid,headRefOid"
    } else {
        "files,additions,deletions"
    };
    let json = gh_run(
        root,
        &["pr", "view", &number, "--repo", &repo, "--json", fields],
        false,
    )?;
    let mut diff = parse_github_pr_diff_meta(&json)?;
    let (patch, truncated) = if full_context {
        let (base, head) = parse_github_pr_oids(&json)?;
        git_diff_full_context(root, &base, &head)?
    } else {
        (
            gh_run(root, &["pr", "diff", &number, "--repo", &repo], true)?,
            false,
        )
    };
    if truncated || patch.len() > MAX_PR_DIFF_BYTES {
        diff.truncated = true;
    } else {
        diff.patch = patch;
    }
    if diff.additions == 0 && diff.deletions == 0 {
        diff.additions = diff.files.iter().map(|file| file.additions).sum();
        diff.deletions = diff.files.iter().map(|file| file.deletions).sum();
    }
    Ok(diff)
}

fn parse_github_pr_oids(json: &str) -> Result<(String, String), String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        base_ref_oid: String,
        head_ref_oid: String,
    }
    let row: Row = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let base = row.base_ref_oid.trim();
    let head = row.head_ref_oid.trim();
    if base.is_empty() || head.is_empty() {
        return Err("Pull request is missing base or head commit".into());
    }
    Ok((base.to_string(), head.to_string()))
}

fn git_github_pr_checks_for(
    root: &Path,
    repo: &str,
    number: i64,
) -> Result<GitHubPrChecks, String> {
    let args = github_pr_checks_args(repo, number)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let json = gh_checked(root, &refs)?;
    parse_github_pr_checks(&json)
}

fn github_pr_checks_args(repo: &str, number: i64) -> Result<Vec<String>, String> {
    if number <= 0 {
        return Err("GitHub pull request number must be positive".into());
    }
    let (owner, name) = split_github_repo(repo)?;
    let repo = format!("{owner}/{name}");
    let number = number.to_string();
    Ok(vec![
        "pr".into(),
        "view".into(),
        number,
        "--repo".into(),
        repo,
        "--json".into(),
        "headRefOid,statusCheckRollup".into(),
    ])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHubStatusCheckRow {
    #[serde(default, rename = "__typename")]
    typename: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    workflow_name: String,
    #[serde(default)]
    details_url: Option<String>,
    #[serde(default)]
    target_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    completed_at: Option<String>,
}

fn parse_github_pr_checks(json: &str) -> Result<GitHubPrChecks, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        #[serde(default)]
        head_ref_oid: String,
        #[serde(default)]
        status_check_rollup: Option<Vec<GitHubStatusCheckRow>>,
    }
    let row: Row = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let head_oid = row.head_ref_oid.trim().to_string();
    if head_oid.is_empty() {
        return Err("Pull request is missing head commit".into());
    }
    Ok(GitHubPrChecks {
        head_oid,
        checks: row
            .status_check_rollup
            .unwrap_or_default()
            .into_iter()
            .map(github_pr_check_from_row)
            .collect(),
    })
}

fn github_pr_check_from_row(row: GitHubStatusCheckRow) -> GitHubPrCheck {
    let is_status_context = if row.typename.is_empty() {
        !row.context.is_empty()
    } else {
        row.typename.eq_ignore_ascii_case("StatusContext")
    };
    if is_status_context {
        return GitHubPrCheck {
            name: row.context,
            workflow: String::new(),
            state: github_check_conclusion_state(&row.state),
            url: row.target_url.filter(|url| !url.trim().is_empty()),
            started_at: row.created_at,
            completed_at: None,
        };
    }
    GitHubPrCheck {
        name: row.name,
        workflow: row.workflow_name,
        state: github_check_state(&row.status, row.conclusion.as_deref().unwrap_or_default()),
        url: row.details_url.filter(|url| !url.trim().is_empty()),
        started_at: row.started_at,
        completed_at: row.completed_at,
    }
}

/// An unfinished CheckRun reports its execution state instead of a stale
/// conclusion. Only a completed or entirely missing status trusts the
/// conclusion; any other nonempty status stays unknown.
fn github_check_state(status: &str, conclusion: &str) -> String {
    match status.trim().to_ascii_uppercase().as_str() {
        "QUEUED" | "IN_PROGRESS" | "PENDING" | "WAITING" | "REQUESTED" => {
            return "pending".into();
        }
        "COMPLETED" | "" => return github_check_conclusion_state(conclusion),
        _ => {}
    }
    "unknown".into()
}

fn github_check_conclusion_state(value: &str) -> String {
    match value.trim().to_ascii_uppercase().as_str() {
        "SUCCESS" => "pass".into(),
        "FAILURE" | "ERROR" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => "fail".into(),
        "QUEUED" | "IN_PROGRESS" | "PENDING" | "WAITING" | "REQUESTED" => "pending".into(),
        "NEUTRAL" | "SKIPPED" => "skipping".into(),
        "CANCELLED" => "cancel".into(),
        _ => "unknown".into(),
    }
}

fn git_diff_full_context(root: &Path, base: &str, head: &str) -> Result<(String, bool), String> {
    ensure_git_commit(root, base)?;
    ensure_git_commit(root, head)?;
    ensure_merge_base(root, base, head)?;
    let context = format!("-U{PR_FULL_CONTEXT_LINES}");
    let three_dot = format!("{base}...{head}");
    let (bytes, truncated) = git_output_capped(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &context,
            &three_dot,
        ],
        MAX_PR_DIFF_BYTES,
        None,
    )
    .ok_or_else(|| format!("git diff failed for {base}...{head}"))?;
    if truncated {
        return Ok((String::new(), true));
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), false))
}

fn ensure_merge_base(root: &Path, base: &str, head: &str) -> Result<(), String> {
    if merge_base_exists(root, base, head) {
        return Ok(());
    }
    if let Some(remote) = github_fetch_remote(root) {
        for deepen in ["50", "200", "800"] {
            let _ = git_stdout(root, &["fetch", "--no-tags", "--deepen", deepen, &remote]);
            if merge_base_exists(root, base, head) {
                return Ok(());
            }
        }
    }
    Err(format!(
        "Cannot find a merge base for {base} and {head}. Fetch more history and try again."
    ))
}

fn merge_base_exists(root: &Path, base: &str, head: &str) -> bool {
    git_stdout(root, &["merge-base", base, head]).is_some()
}

fn ensure_git_commit(root: &Path, oid: &str) -> Result<(), String> {
    let spec = format!("{oid}^{{commit}}");
    if git_stdout(root, &["cat-file", "-e", &spec]).is_some() {
        return Ok(());
    }
    if let Some(remote) = github_fetch_remote(root) {
        let _ = git_stdout(root, &["fetch", "--no-tags", "--depth", "1", &remote, oid]);
    }
    if git_stdout(root, &["cat-file", "-e", &spec]).is_some() {
        return Ok(());
    }
    Err(format!(
        "Missing git commit {oid}. Fetch the pull request refs and try again."
    ))
}

fn github_fetch_remote(root: &Path) -> Option<String> {
    if let Some(name) = gh_resolved_remote(root) {
        return Some(name);
    }
    if let Some(url) = gh_repo_view_url(root) {
        if let Some(name) = remote_matching_github_url(root, &url) {
            return Some(name);
        }
    }
    git_remote_name(root)
}

fn gh_resolved_remote(root: &Path) -> Option<String> {
    let listed = git_stdout(
        root,
        &["config", "--get-regexp", r"remote\..*\.gh-resolved"],
    )?;
    for line in listed.lines() {
        let key = line.split_whitespace().next()?;
        let name = key.strip_prefix("remote.")?.strip_suffix(".gh-resolved")?;
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

fn gh_repo_view_url(root: &Path) -> Option<String> {
    let text = gh_stdout(root, &["repo", "view", "--json", "url"])?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get("url")?
        .as_str()
        .map(str::to_owned)
        .filter(|url| !url.trim().is_empty())
}

fn remote_matching_github_url(root: &Path, url: &str) -> Option<String> {
    let remotes = git_stdout(root, &["remote", "-v"])?;
    let wanted = normalize_github_remote_url(url);
    for line in remotes.lines() {
        let mut parts = line.split_whitespace();
        let name = parts.next()?;
        let remote_url = parts.next()?;
        if normalize_github_remote_url(remote_url) == wanted {
            return Some(name.to_string());
        }
    }
    None
}

fn normalize_github_remote_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    if let Some((_, rest)) = trimmed.split_once("github.com:") {
        return format!(
            "github.com/{}",
            rest.trim_start_matches('/').to_ascii_lowercase()
        );
    }
    if let Some((_, rest)) = trimmed.split_once("github.com/") {
        return format!(
            "github.com/{}",
            rest.trim_start_matches('/').to_ascii_lowercase()
        );
    }
    trimmed.to_ascii_lowercase()
}

fn git_remote_name(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .arg("remote")
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn parse_github_pr_diff_meta(json: &str) -> Result<GitHubPrDiff, String> {
    #[derive(Deserialize)]
    struct FileRow {
        path: String,
        #[serde(default)]
        additions: i64,
        #[serde(default)]
        deletions: i64,
    }
    #[derive(Deserialize)]
    struct Row {
        #[serde(default)]
        additions: i64,
        #[serde(default)]
        deletions: i64,
        #[serde(default)]
        files: Vec<FileRow>,
    }
    let row: Row = serde_json::from_str(json).map_err(|error| error.to_string())?;
    Ok(GitHubPrDiff {
        additions: row.additions,
        deletions: row.deletions,
        files: row
            .files
            .into_iter()
            .map(|file| GitHubPrFile {
                path: file.path,
                additions: file.additions,
                deletions: file.deletions,
            })
            .collect(),
        patch: String::new(),
        truncated: false,
    })
}

fn parse_github_work_items(
    json: &str,
    kind: &str,
    repo: &str,
) -> Result<Vec<GitHubWorkItem>, String> {
    #[derive(Deserialize)]
    struct RowLabel {
        name: String,
        #[serde(default)]
        color: String,
    }
    #[derive(Deserialize)]
    struct RowAssignee {
        login: String,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Row {
        number: i64,
        title: String,
        url: String,
        state: String,
        #[serde(default)]
        state_reason: String,
        #[serde(default)]
        created_at: String,
        #[serde(default)]
        updated_at: String,
        #[serde(default)]
        labels: Vec<RowLabel>,
        #[serde(default)]
        assignees: Vec<RowAssignee>,
        #[serde(default)]
        is_draft: bool,
    }
    let rows: Vec<Row> = serde_json::from_str(json).map_err(|error| error.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| GitHubWorkItem {
            kind: kind.to_string(),
            number: row.number,
            title: row.title,
            url: row.url,
            state: row.state.to_lowercase(),
            state_reason: row.state_reason.to_lowercase(),
            created_at: row.created_at,
            updated_at: row.updated_at,
            labels: row
                .labels
                .into_iter()
                .map(|label| GitHubLabel {
                    name: label.name,
                    color: label.color,
                })
                .collect(),
            assignees: row
                .assignees
                .into_iter()
                .map(|assignee| GitHubAssignee {
                    avatar_url: github_avatar_url(&assignee.login),
                    login: assignee.login,
                })
                .collect(),
            draft: row.is_draft,
            repo: repo.to_string(),
        })
        .collect())
}

fn parse_github_work_item(json: &str, kind: &str, repo: &str) -> Result<GitHubWorkItem, String> {
    let wrapped = format!("[{json}]");
    parse_github_work_items(&wrapped, kind, repo)?
        .into_iter()
        .next()
        .ok_or_else(|| "GitHub did not return a work item".into())
}

fn git_stdout(root: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("--no-pager").args(args).current_dir(root);
    crate::hide_window_console(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn git_output_capped(
    root: &Path,
    args: &[&str],
    cap: usize,
    _: Option<()>,
) -> Option<(Vec<u8>, bool)> {
    let mut cmd = Command::new("git");
    cmd.arg("--no-pager").args(args).current_dir(root);
    crate::hide_window_console(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let mut bytes = output.stdout;
    let truncated = bytes.len() > cap;
    if truncated {
        bytes.truncate(cap);
    }
    Some((bytes, truncated))
}

fn gh_stdout(root: &Path, args: &[&str]) -> Option<String> {
    gh_run(root, args, false).ok()
}

fn gh_checked(root: &Path, args: &[&str]) -> Result<String, String> {
    gh_run(root, args, false)
}

struct GitHubRateLimitBackoff {
    until: SystemTime,
    error: String,
}

// Shared by all webviews, including background Inbox and PR checks requests.
static GITHUB_RATE_LIMIT_BACKOFF: Mutex<Option<GitHubRateLimitBackoff>> = Mutex::new(None);

fn gh_run(root: &Path, args: &[&str], allow_empty: bool) -> Result<String, String> {
    gh_with_backoff(
        &GITHUB_RATE_LIMIT_BACKOFF,
        args,
        allow_empty,
        |args, allow_empty| gh_run_raw(root, args, allow_empty),
    )
}

fn github_rate_limit_error(
    backoff: &mut Option<GitHubRateLimitBackoff>,
    now: SystemTime,
) -> Option<String> {
    if let Some(active) = backoff.as_ref().filter(|active| now < active.until) {
        return Some(active.error.clone());
    }
    *backoff = None;
    None
}

fn gh_with_backoff(
    backoff: &Mutex<Option<GitHubRateLimitBackoff>>,
    args: &[&str],
    allow_empty: bool,
    mut run: impl FnMut(&[&str], bool) -> Result<String, String>,
) -> Result<String, String> {
    if let Ok(mut slot) = backoff.lock() {
        if let Some(error) = github_rate_limit_error(&mut slot, SystemTime::now()) {
            return Err(error);
        }
    }
    let result = run(args, allow_empty);
    let Err(error) = &result else {
        return result;
    };
    let message = error.to_lowercase();
    let primary = message.contains("api rate limit") && message.contains("exceeded");
    let secondary = message.contains("secondary rate limit") || message.contains("abuse detection");
    if !primary && !secondary {
        return result;
    }
    // Port note: MonoCode resolves the exact reset instant via a GraphQL
    // rateLimit query. Without the `time` crate pinned here we fall back to a
    // one-minute cooldown, which still stops request storms.
    if let Ok(mut slot) = backoff.lock() {
        if github_rate_limit_error(&mut slot, SystemTime::now()).is_some() {
            return result;
        }
        *slot = Some(GitHubRateLimitBackoff {
            until: SystemTime::now() + Duration::from_secs(60),
            error: error.clone(),
        });
    }
    result
}

fn gh_run_raw(root: &Path, args: &[&str], allow_empty: bool) -> Result<String, String> {
    let mut cmd = Command::new("gh");
    cmd.current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_PAGER", "cat")
        .env("GIT_PAGER", "cat");
    crate::hide_window_console(&mut cmd);
    let output = cmd.output().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "GitHub CLI (`gh`) is not installed.".to_string()
        } else {
            error.to_string()
        }
    })?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            if allow_empty {
                return Ok(String::new());
            }
            return Err("gh returned no output".into());
        }
        return Ok(text);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("gh {} failed", args.join(" "))
    };
    Err(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_github_work_items_maps_issue_fields() {
        let json = r#"[{
            "number": 12,
            "title": "Fix login",
            "url": "https://github.com/acme/web/issues/12",
            "state": "OPEN",
            "stateReason": "DONE",
            "createdAt": "2026-09-01T10:00:00Z",
            "updatedAt": "2026-09-02T10:00:00Z",
            "labels": [{"name": "bug", "color": "ff0000"}],
            "assignees": [{"login": "maya"}]
        }]"#;
        let items = parse_github_work_items(json, "issue", "acme/web").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].number, 12);
        assert_eq!(items[0].state, "open");
        assert_eq!(items[0].state_reason, "done");
        assert_eq!(items[0].labels[0].color, "ff0000");
        assert_eq!(items[0].assignees[0].avatar_url.contains("maya"), true);
    }

    #[test]
    fn parse_github_work_items_reads_draft_prs() {
        let json = r#"[{
            "number": 3,
            "title": "WIP change",
            "url": "https://github.com/acme/web/pull/3",
            "state": "OPEN",
            "createdAt": "2026-09-01T10:00:00Z",
            "updatedAt": "2026-09-02T10:00:00Z",
            "labels": [],
            "assignees": [],
            "isDraft": true
        }]"#;
        let items = parse_github_work_items(json, "pr", "acme/web").unwrap();
        assert!(items[0].draft);
    }

    #[test]
    fn parse_github_work_item_reads_view_shape() {
        let json = r#"{
            "number": 7,
            "title": "Solo item",
            "url": "https://github.com/acme/web/issues/7",
            "state": "OPEN",
            "createdAt": "2026-09-01T10:00:00Z",
            "updatedAt": "2026-09-01T11:00:00Z",
            "labels": [],
            "assignees": []
        }"#;
        let item = parse_github_work_item(json, "issue", "acme/web").unwrap();
        assert_eq!(item.number, 7);
    }

    #[test]
    fn parse_github_work_item_details_reads_body_and_author() {
        let json = r#"{"body": "Hello", "author": {"login": "ada"}}"#;
        let details = parse_github_work_item_details(json).unwrap();
        assert_eq!(details.body, "Hello");
        assert_eq!(details.author, "ada");
        assert!(details.author_avatar_url.contains("ada"));
    }

    #[test]
    fn parse_github_work_item_details_reads_pr_review_meta() {
        let json = r#"{
            "body": "",
            "author": {"login": "ada"},
            "baseRefName": "main",
            "headRefName": "feature",
            "reviewDecision": "APPROVED"
        }"#;
        let details = parse_github_work_item_details(json).unwrap();
        assert_eq!(details.base_ref_name, "main");
        assert_eq!(details.head_ref_name, "feature");
        assert_eq!(details.review_decision, "APPROVED");
    }

    #[test]
    fn split_github_repo_rejects_bad_slugs() {
        assert_eq!(
            split_github_repo("acme/web").unwrap(),
            ("acme".into(), "web".into())
        );
        assert!(split_github_repo("acme").is_err());
        assert!(split_github_repo("acme/web/deep").is_err());
        assert!(split_github_repo("acme web/x").is_err());
    }

    #[test]
    fn check_state_maps_execution_status_before_conclusion() {
        assert_eq!(github_check_state("IN_PROGRESS", ""), "pending");
        assert_eq!(github_check_state("COMPLETED", "SUCCESS"), "pass");
        assert_eq!(github_check_state("COMPLETED", "TIMED_OUT"), "fail");
        assert_eq!(github_check_state("", "SKIPPED"), "skipping");
        assert_eq!(github_check_state("WEIRD", "SUCCESS"), "unknown");
    }

    #[test]
    fn pr_action_args_cover_lifecycle() {
        assert_eq!(
            github_pr_action_args("acme/web", 5, "squash").unwrap(),
            vec!["pr", "merge", "5", "--repo", "acme/web", "--squash"]
        );
        assert_eq!(
            github_pr_action_args("acme/web", 5, "draft").unwrap(),
            vec!["pr", "ready", "5", "--repo", "acme/web", "--undo"]
        );
        assert!(github_pr_action_args("acme/web", 5, "explode").is_err());
    }

    #[test]
    fn parses_pull_request_thread_conversation() {
        let json = json!({
            "data": {"repository": {"pullRequest": {
                "reviewDecision": "APPROVED",
                "baseRefName": "main",
                "headRefName": "feature",
                "commits": {"totalCount": 1, "nodes": [{"commit": {
                    "oid": "abc", "messageHeadline": "Do it",
                    "committedDate": "2026-09-01T10:00:00Z", "url": "u",
                    "author": {"name": "Ada", "user": {"login": "ada"}}
                }}]},
                "comments": {"totalCount": 1, "nodes": [{
                    "id": "c1", "author": {"login": "bee"}, "body": "Hi",
                    "createdAt": "2026-09-01T11:00:00Z", "url": "u", "isMinimized": false
                }]},
                "reviews": {"totalCount": 1, "nodes": [{
                    "id": "r1", "author": {"login": "cat"}, "body": "LGTM",
                    "state": "APPROVED", "submittedAt": "2026-09-01T12:00:00Z", "url": "u"
                }]},
                "reviewThreads": {"totalCount": 1, "nodes": [{
                    "id": "t1", "isResolved": false, "path": "src/x.ts",
                    "comments": {"totalCount": 2, "nodes": [
                        {"id": "rc1", "author": {"login": "cat"}, "body": "here",
                         "createdAt": "2026-09-01T13:00:00Z", "url": "u",
                         "path": "src/x.ts", "line": 3, "isMinimized": false},
                        {"id": "rc2", "author": {"login": "ada"}, "body": "fixed",
                         "createdAt": "2026-09-01T13:10:00Z", "url": "u",
                         "path": "src/x.ts", "line": 3, "isMinimized": false}
                    ]}
                }]}
            }}}
        })
        .to_string();
        let thread = parse_github_work_item_thread(&json, "pr").unwrap();
        assert_eq!(thread.review_decision, "APPROVED");
        assert_eq!(thread.commits.len(), 1);
        assert_eq!(thread.commits[0].author, "ada");
        // comment + review + review thread head, sorted by time
        assert_eq!(thread.comments.len(), 3);
        assert_eq!(thread.comments[0].kind, "comment");
        assert_eq!(thread.comments[1].kind, "review");
        assert_eq!(thread.comments[2].kind, "review_comment");
        assert_eq!(thread.comments[2].replies.len(), 1);
        assert_eq!(thread.comments[2].replies[0].thread_id, "t1");
        assert!(!thread.truncated);
    }

    #[test]
    fn parses_issue_thread_comments() {
        let json = json!({
            "data": {"repository": {"issue": {
                "comments": {"totalCount": 2, "nodes": [
                    {"id": "c1", "author": {"login": "bee"}, "body": "one",
                     "createdAt": "2026-09-01T11:00:00Z", "url": "u", "isMinimized": false},
                    {"id": "c2", "author": {"login": "cat"}, "body": "two",
                     "createdAt": "2026-09-01T12:00:00Z", "url": "u", "isMinimized": true}
                ]}
            }}}
        })
        .to_string();
        let thread = parse_github_work_item_thread(&json, "issue").unwrap();
        assert_eq!(thread.comments.len(), 1);
        assert_eq!(thread.comments[0].author, "bee");
    }

    #[test]
    fn surfaces_graphql_errors() {
        let json = json!({"errors": [{"message": "Not Found"}]}).to_string();
        let error = parse_github_work_item_thread(&json, "issue").unwrap_err();
        assert_eq!(error, "Not Found");
    }

    #[test]
    fn parses_pr_checks_rollup() {
        let json = json!({
            "headRefOid": "abc123",
            "statusCheckRollup": [
                {"__typename": "CheckRun", "name": "build", "workflowName": "CI",
                 "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://x"},
                {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS"}
            ]
        })
        .to_string();
        let checks = parse_github_pr_checks(&json).unwrap();
        assert_eq!(checks.head_oid, "abc123");
        assert_eq!(checks.checks.len(), 2);
        assert_eq!(checks.checks[0].state, "fail");
        assert_eq!(checks.checks[0].workflow, "CI");
        assert_eq!(checks.checks[1].name, "deploy");
        assert_eq!(checks.checks[1].state, "pass");
    }

    #[test]
    fn normalizes_github_remote_urls() {
        assert_eq!(
            normalize_github_remote_url("git@github.com:acme/web.git"),
            "github.com/acme/web"
        );
        assert_eq!(
            normalize_github_remote_url("https://github.com/Acme/Web/"),
            "github.com/acme/web"
        );
    }

    #[test]
    fn review_reply_urls_parse_from_mutation_response() {
        let ok = json!({"data": {"addPullRequestReviewThreadReply": {
            "comment": {"url": "https://github.com/acme/web/pull/5#discussion_r1"}
        }}})
        .to_string();
        assert_eq!(
            parse_github_review_reply_url(&ok).unwrap(),
            "https://github.com/acme/web/pull/5#discussion_r1"
        );
        let err = json!({"errors": [{"message": "Bad thread"}]}).to_string();
        assert_eq!(parse_github_review_reply_url(&err).unwrap_err(), "Bad thread");
    }
}
