import { invoke } from "@tauri-apps/api/core";

/** Git data layer for the source-control surface (MonoCode's platform git API). */

export type GitDiffStats = {
  files: number;
  additions: number;
  deletions: number;
};

export function gitDiffStats(cwd: string): Promise<GitDiffStats> {
  return invoke<GitDiffStats>("git_diff_stats", { cwd });
}

export type GitChangedFile = {
  path: string;
  relative: string;
  status: "modified" | "added" | "deleted" | "untracked" | string;
  additions: number;
  deletions: number;
  staged: boolean;
  unstaged: boolean;
};

export type GitDiffIndex = {
  branch: string | null;
  head: string | null;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  remote: string | null;
  upstream: string | null;
  defaultBranch: string | null;
  ahead: number;
  behind: number;
  aheadOfDefault: number;
  headPushed: boolean;
};

export function gitDiffIndex(cwd: string): Promise<GitDiffIndex> {
  return invoke<GitDiffIndex>("git_diff_index", { cwd });
}

/** File list and counts only, for diff content views that do not need sync data. */
export function gitDiffFiles(cwd: string): Promise<GitDiffIndex> {
  return invoke<GitDiffIndex>("git_diff_files", { cwd });
}

export type GitFileDiff = {
  path: string;
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  tooLarge: boolean;
};

export type GitFileDiffKind = "staged" | "unstaged";

export function gitFileDiff(
  cwd: string,
  relative: string,
  kind: GitFileDiffKind = "unstaged",
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_file_diff", {
    cwd,
    relative,
    staged: kind === "staged",
  });
}

export type GitHistoryRef = {
  name: string;
  kind: "local" | "remote" | "tag" | string;
};

export type GitHistoryCommit = {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  timestamp: number;
  subject: string;
  refs: GitHistoryRef[];
  head: boolean;
};

export type GitHistory = {
  head: string | null;
  commits: GitHistoryCommit[];
};

export function gitHistory(cwd: string, limit = 200): Promise<GitHistory> {
  return invoke<GitHistory>("git_history", { cwd, limit });
}

export function gitCommitFiles(
  cwd: string,
  sha: string,
): Promise<GitChangedFile[]> {
  return invoke<GitChangedFile[]>("git_commit_files", { cwd, sha });
}

export function gitCommitFileDiff(
  cwd: string,
  sha: string,
  relative: string,
): Promise<GitFileDiff> {
  return invoke<GitFileDiff>("git_commit_file_diff", { cwd, sha, relative });
}

export function gitStageContents(
  cwd: string,
  relative: string,
  contents: string,
): Promise<void> {
  return invoke<void>("git_stage_contents", { cwd, relative, contents });
}

export function gitStageFile(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_stage_file", { cwd, relative });
}

export function gitUnstageFile(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_unstage_file", { cwd, relative });
}

export function gitDiscardFile(cwd: string, relative: string): Promise<void> {
  return invoke<void>("git_discard_file", { cwd, relative });
}

export function gitDiscardAll(cwd: string): Promise<void> {
  return invoke<void>("git_discard_all", { cwd });
}

export function gitStageAll(cwd: string): Promise<void> {
  return invoke<void>("git_stage_all", { cwd });
}

export function gitUnstageAll(cwd: string): Promise<void> {
  return invoke<void>("git_unstage_all", { cwd });
}

export function gitCommit(
  cwd: string,
  message: string,
  amend = false,
): Promise<void> {
  return invoke<void>("git_commit", { cwd, message, amend });
}

export function gitHeadMessage(cwd: string): Promise<string> {
  return invoke<string>("git_head_message", { cwd });
}

export type GitStagedContext = {
  branch: string | null;
  summary: string;
  patch: string;
};

export function gitStagedContext(cwd: string): Promise<GitStagedContext> {
  return invoke<GitStagedContext>("git_staged_context", { cwd });
}

export function gitPush(cwd: string): Promise<void> {
  return invoke<void>("git_push", { cwd });
}

export function gitPull(cwd: string): Promise<void> {
  return invoke<void>("git_pull", { cwd });
}

export function gitSync(cwd: string): Promise<void> {
  return invoke<void>("git_sync", { cwd });
}

export type GitRangeContext = {
  base: string;
  head: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
};

export function gitRangeContext(cwd: string): Promise<GitRangeContext> {
  return invoke<GitRangeContext>("git_range_context", { cwd });
}

export type GitPr = {
  number: number;
  title: string;
  url: string;
  state: string;
};

export function gitPrStatus(cwd: string): Promise<GitPr | null> {
  return invoke<GitPr | null>("git_pr_status", { cwd });
}

export function gitPrCreate(
  cwd: string,
  title: string,
  body: string,
  base: string,
  head: string,
): Promise<string> {
  return invoke<string>("git_pr_create", { cwd, title, body, base, head });
}

export type GitBranchInfo = {
  name: string;
  current: boolean;
  remote: string | null;
};

export type GitBranches = {
  current: string | null;
  detached: boolean;
  branches: GitBranchInfo[];
};

export function gitBranches(cwd: string): Promise<GitBranches> {
  return invoke<GitBranches>("git_branches", { cwd });
}

export function gitCheckout(
  cwd: string,
  name: string,
  remote?: string | null,
): Promise<string> {
  return invoke<string>("git_checkout", { cwd, name, remote: remote ?? null });
}

export function gitCreateBranch(cwd: string, name: string): Promise<string> {
  return invoke<string>("git_create_branch", { cwd, name });
}

export function gitStash(cwd: string, message?: string): Promise<void> {
  return invoke<void>("git_stash", { cwd, message: message ?? null });
}

/** Git refused a checkout because the working tree would be overwritten. */
export function isCheckoutBlockedByChanges(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("would be overwritten") ||
    text.includes("commit your changes or stash") ||
    text.includes("please move or remove them before")
  );
}

const GIT_CHANGED = "monocode-git-changed";

/** Tell git UIs (diff pane, branch picker) to reload after a local git mutation. */
export function notifyGitChanged() {
  window.dispatchEvent(new Event(GIT_CHANGED));
}

export function subscribeGitChanged(listener: () => void): () => void {
  window.addEventListener(GIT_CHANGED, listener);
  return () => window.removeEventListener(GIT_CHANGED, listener);
}

export function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}
