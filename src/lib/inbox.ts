import { invoke } from "./native";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "./store";

/**
 * Inbox model layer for GitHub (via `gh` CLI) and GitLab (via REST + PAT),
 * ported from Orbit's `githubTasks.ts` / `gitlab.ts`. Both providers share
 * the same work-item shape so the UI stays provider-agnostic.
 */

export type WorkItemKind = "issue" | "pr";
export type InboxProvider = "github" | "gitlab";
export type WorkItemState = "open" | "all";

export type InboxLabel = { name: string; color: string };
export type InboxAssignee = { login: string; avatarUrl?: string };

export type WorkItem = {
  provider: InboxProvider;
  kind: WorkItemKind;
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: InboxLabel[];
  assignees: InboxAssignee[];
  draft: boolean;
  repo: string;
  /** GitLab todo action, such as `mentioned` or `review_requested`. */
  attentionReason?: string;
};

export type GithubStatus = { connected: boolean; installed: boolean; authenticated: boolean };
export type GitlabStatus = { connected: boolean; url: string };

export type WorkItemDetails = {
  body: string;
  author: string;
  authorAvatarUrl?: string;
  baseRefName?: string;
  headRefName?: string;
  reviewDecision?: string;
};

export type WorkItemComment = {
  id: string;
  kind: string;
  author: string;
  authorAvatarUrl?: string;
  body: string;
  createdAt: string;
  url: string;
  state: string;
  path: string;
  line: number | null;
  resolved: boolean;
  threadId: string;
  replies: WorkItemComment[];
};

export type WorkItemThread = {
  comments: WorkItemComment[];
  commits: { oid: string; messageHeadline: string; author: string; committedDate: string; url: string }[];
  truncated: boolean;
  reviewDecision: string;
  baseRefName: string;
  headRefName: string;
};

export type PrDiff = {
  additions: number;
  deletions: number;
  files: { path: string; additions: number; deletions: number }[];
  patch: string;
  truncated: boolean;
};

export type PrCheck = {
  name: string;
  workflow: string;
  state: string;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PrChecks = { headOid: string; checks: PrCheck[] };

/**
 * Whether a workspace backend exists: the desktop, or a phone whose paired
 * desktop answers (`native.ts` routes the call). The browser preview has none.
 */
const hasBackend = () => {
  const target = useWorkspace.getState().runtimeTarget;
  return target === "desktop" || target === "mobile";
};

/* ------------------------------------------------------------------ shared */

export function normalizePathKey(path: string): string {
  return path.replace(/\/+$/, "").toLowerCase();
}

function itemKey(repo: string, kind: WorkItemKind, number: number): string {
  return `${repo.trim().toLowerCase()}:${kind}:${number}`;
}

export function clearInboxCaches() {
  repoByPath.clear();
  repositoriesByPath.clear();
  workItemByKey.clear();
  workItemInflight.clear();
  detailsByKey.clear();
  detailsInflight.clear();
  threadByKey.clear();
  threadInflight.clear();
  diffByKey.clear();
  diffInflight.clear();
}

const relativeFormatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

/** Orbit's `formatRelativeTime`, verbatim. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = Math.round((then - now) / 1000);
  const abs = Math.abs(delta);
  const divisions: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = delta;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let amount = abs;
  for (const [step, next] of divisions) {
    unit = next;
    if (amount < step) break;
    value = Math.round(value / step);
    amount = Math.abs(value);
  }
  try {
    return relativeFormatter.format(value, unit);
  } catch {
    return "";
  }
}

export function formatGithubQuery(query: {
  assignedToMe: boolean;
  kind: WorkItemKind;
  state: WorkItemState;
  search: string;
}): string {
  const parts: string[] = [];
  if (query.assignedToMe) parts.push("assignee:@me");
  parts.push(query.kind === "pr" ? "is:pr" : "is:issue");
  if (query.state === "open") parts.push("is:open");
  const text = query.search.trim();
  if (text) parts.push(text);
  return parts.join(" ");
}

export function githubAvatarUrl(login: string, size = 64): string {
  const name = login.trim();
  if (!name) return "";
  return `https://avatars.githubusercontent.com/${encodeURIComponent(name)}?s=${size}`;
}

/* ------------------------------------------------------------------ github */

const repoByPath = new Map<string, string>();
const repositoriesByPath = new Map<string, string[]>();
const workItemByKey = new Map<string, WorkItem>();
const workItemInflight = new Map<string, Promise<WorkItem>>();
const detailsByKey = new Map<string, WorkItemDetails>();
const detailsInflight = new Map<string, Promise<WorkItemDetails>>();
const threadByKey = new Map<string, WorkItemThread>();
const threadInflight = new Map<string, Promise<WorkItemThread>>();
const diffByKey = new Map<string, PrDiff>();
const diffInflight = new Map<string, Promise<PrDiff>>();

export function githubStatus(): Promise<GithubStatus> {
  return invoke<GithubStatus>("git_github_status");
}

export async function githubRepo(cwd: string): Promise<string> {
  const key = normalizePathKey(cwd);
  const cached = repoByPath.get(key);
  if (cached !== undefined) return cached;
  const repositories = repositoriesByPath.get(key);
  if (repositories?.[0]) return repositories[0];
  const repo = await invoke<string>("git_github_repo", { cwd });
  repoByPath.set(key, repo);
  return repo;
}

export async function githubRepositories(cwd: string): Promise<string[]> {
  const key = normalizePathKey(cwd);
  const cached = repositoriesByPath.get(key);
  if (cached) return cached;
  const repositories = await invoke<string[]>("git_github_repositories", { cwd });
  if (repositories.length === 0) {
    throw new Error("GitHub did not return a repository");
  }
  repositoriesByPath.set(key, repositories);
  repoByPath.set(key, repositories[0]);
  return repositories;
}

type GithubWorkItemRow = {
  kind: WorkItemKind;
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string;
  createdAt?: string;
  updatedAt: string;
  labels: InboxLabel[];
  assignees: InboxAssignee[];
  draft: boolean;
  repo: string;
};

function toWorkItem(row: GithubWorkItemRow, provider: InboxProvider): WorkItem {
  return { provider, ...row };
}

export function listGithubWorkItems(
  cwd: string,
  repo: string,
  query: { kind: WorkItemKind; assignedToMe: boolean; state: WorkItemState; search: string; limit?: number },
): Promise<WorkItem[]> {
  return invoke<GithubWorkItemRow[]>("git_github_work_items", {
    cwd,
    repo,
    kind: query.kind,
    assignedToMe: query.assignedToMe,
    state: query.state,
    search: query.search.trim(),
    limit: query.limit,
  }).then((rows) => rows.map((row) => toWorkItem(row, "github")));
}

export function githubWorkItem(
  cwd: string,
  repo: string,
  kind: WorkItemKind,
  number: number,
  options?: { force?: boolean },
): Promise<WorkItem> {
  const key = itemKey(repo, kind, number);
  const cached = workItemByKey.get(key);
  if (cached && !options?.force) return Promise.resolve(cached);
  const pending = workItemInflight.get(key);
  if (pending) return pending;
  const promise = invoke<GithubWorkItemRow>("git_github_work_item", { cwd, repo, kind, number })
    .then((row) => {
      const item = toWorkItem(row, "github");
      workItemByKey.set(key, item);
      return item;
    })
    .finally(() => {
      if (workItemInflight.get(key) === promise) workItemInflight.delete(key);
    });
  workItemInflight.set(key, promise);
  return promise;
}

export async function githubWorkItemDetails(
  cwd: string,
  repo: string,
  kind: WorkItemKind,
  number: number,
): Promise<WorkItemDetails> {
  const key = itemKey(repo, kind, number);
  const pending = detailsInflight.get(key);
  if (pending) return pending;
  const promise = invoke<WorkItemDetails>("git_github_work_item_details", { cwd, repo, kind, number })
    .then((details) => {
      detailsByKey.set(key, details);
      return details;
    })
    .finally(() => {
      if (detailsInflight.get(key) === promise) detailsInflight.delete(key);
    });
  detailsInflight.set(key, promise);
  return promise;
}

export function githubWorkItemThread(
  cwd: string,
  repo: string,
  kind: WorkItemKind,
  number: number,
  options?: { force?: boolean },
): Promise<WorkItemThread> {
  const key = itemKey(repo, kind, number);
  if (options?.force) {
    threadByKey.delete(key);
    threadInflight.delete(key);
  }
  const cached = threadInflight.get(key);
  if (cached) return cached;
  const pending = invoke<WorkItemThread>("git_github_work_item_thread", { cwd, repo, kind, number })
    .then((thread) => {
      threadByKey.set(key, thread);
      return thread;
    })
    .finally(() => {
      if (threadInflight.get(key) === pending) threadInflight.delete(key);
    });
  threadInflight.set(key, pending);
  return pending;
}

export async function githubWorkItemComment(
  cwd: string,
  repo: string,
  kind: WorkItemKind,
  number: number,
  body: string,
  inReplyTo = "",
): Promise<string> {
  const url = await invoke<string>("git_github_work_item_comment", {
    cwd,
    repo,
    kind,
    number,
    body: body.trim(),
    inReplyTo,
  });
  await githubWorkItemThread(cwd, repo, kind, number, { force: true }).catch(() => undefined);
  return url;
}

export type GithubPrAction =
  | "merge" | "squash" | "rebase" | "draft" | "ready" | "close" | "reopen";

export async function githubPrAction(
  cwd: string,
  repo: string,
  number: number,
  action: GithubPrAction,
): Promise<WorkItem> {
  const row = await invoke<GithubWorkItemRow>("git_github_pr_action", { cwd, repo, number, action });
  const item = toWorkItem(row, "github");
  workItemByKey.set(itemKey(repo, "pr", number), item);
  return item;
}

export function githubPrDiff(
  cwd: string,
  repo: string,
  number: number,
  fullContext = false,
): Promise<PrDiff> {
  const key = `${itemKey(repo, "pr", number)}:${fullContext ? "full" : "plain"}`;
  const cached = diffInflight.get(key);
  if (cached) return cached;
  const pending = invoke<PrDiff>("git_github_pr_diff", { cwd, repo, number, fullContext })
    .then((diff) => {
      diffByKey.set(key, diff);
      return diff;
    })
    .finally(() => {
      if (diffInflight.get(key) === pending) diffInflight.delete(key);
    });
  diffInflight.set(key, pending);
  return pending;
}

export function githubPrChecks(cwd: string, repo: string, number: number): Promise<PrChecks> {
  return invoke<PrChecks>("git_github_pr_checks", { cwd, repo, number });
}

/* ------------------------------------------------------------------ gitlab */

export const GITLAB_CHANGE_EVENT = "orbit:gitlab-change";

export function notifyGitlabChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(GITLAB_CHANGE_EVENT));
}

export function gitlabStatus(): Promise<GitlabStatus> {
  return invoke<GitlabStatus>("gitlab_status");
}

export async function saveGitlabConfig(url: string, token: string): Promise<GitlabStatus> {
  const status = await invoke<GitlabStatus>("gitlab_set_config", {
    url: url.trim(),
    token: token.trim(),
  });
  clearInboxCaches();
  notifyGitlabChange();
  return status;
}

export async function disconnectGitlab(url: string): Promise<GitlabStatus> {
  const status = await invoke<GitlabStatus>("gitlab_set_config", { url: url.trim(), token: "" });
  clearInboxCaches();
  notifyGitlabChange();
  return status;
}

export async function gitlabRepo(cwd: string): Promise<string> {
  const key = normalizePathKey(cwd);
  const cached = repoByPath.get(key);
  if (cached !== undefined) return cached;
  const repo = await invoke<string>("gitlab_repo", { cwd });
  repoByPath.set(key, repo);
  return repo;
}

type GitlabWorkItemRow = Omit<WorkItem, "provider">;

export function listGitlabWorkItems(
  cwd: string,
  query: { kind: WorkItemKind; assignedToMe: boolean; state: WorkItemState; limit?: number },
): Promise<WorkItem[]> {
  return invoke<GitlabWorkItemRow[]>("gitlab_list_work_items", {
    cwd,
    kind: query.kind,
    assignedToMe: query.assignedToMe,
    state: query.state,
    limit: query.limit,
  }).then((rows) => rows.map((row) => toWorkItem(row, "gitlab")));
}

export function listGitlabTodos(query: { kind: WorkItemKind; limit?: number }): Promise<WorkItem[]> {
  return invoke<GitlabWorkItemRow[]>("gitlab_list_todos", {
    kind: query.kind,
    limit: query.limit,
  }).then((rows) => rows.map((row) => toWorkItem(row, "gitlab")));
}

export function gitlabWorkItemDetails(
  repo: string,
  kind: WorkItemKind,
  number: number,
): Promise<WorkItemDetails> {
  const key = itemKey(repo, kind, number);
  const pending = detailsInflight.get(key);
  if (pending) return pending;
  const promise = invoke<WorkItemDetails>("gitlab_work_item_details", { repo, kind, number })
    .then((details) => {
      detailsByKey.set(key, details);
      return details;
    })
    .finally(() => {
      if (detailsInflight.get(key) === promise) detailsInflight.delete(key);
    });
  detailsInflight.set(key, promise);
  return promise;
}

export function gitlabWorkItemThread(
  repo: string,
  kind: WorkItemKind,
  number: number,
  options?: { force?: boolean },
): Promise<WorkItemThread> {
  const key = itemKey(repo, kind, number);
  if (options?.force) {
    threadByKey.delete(key);
    threadInflight.delete(key);
  }
  const cached = threadInflight.get(key);
  if (cached) return cached;
  const pending = invoke<WorkItemThread>("gitlab_work_item_thread", { repo, kind, number })
    .then((thread) => {
      threadByKey.set(key, thread);
      return thread;
    })
    .finally(() => {
      if (threadInflight.get(key) === pending) threadInflight.delete(key);
    });
  threadInflight.set(key, pending);
  return pending;
}

export async function gitlabWorkItemComment(
  repo: string,
  kind: WorkItemKind,
  number: number,
  body: string,
): Promise<string> {
  const url = await invoke<string>("gitlab_work_item_comment", {
    repo,
    kind,
    number,
    body: body.trim(),
  });
  await gitlabWorkItemThread(repo, kind, number, { force: true }).catch(() => undefined);
  return url;
}

export function gitlabMrDiff(repo: string, number: number): Promise<PrDiff> {
  const key = itemKey(repo, "pr", number);
  const cached = diffInflight.get(key);
  if (cached) return cached;
  const pending = invoke<PrDiff>("gitlab_mr_diff", { repo, number })
    .then((diff) => {
      diffByKey.set(key, diff);
      return diff;
    })
    .finally(() => {
      if (diffInflight.get(key) === pending) diffInflight.delete(key);
    });
  diffInflight.set(key, pending);
  return pending;
}

/* ------------------------------------------------------------------- hooks */

export function useGithubStatus(enabled = true) {
  return useQuery({
    queryKey: ["inbox", "github-status"],
    queryFn: githubStatus,
    enabled: enabled && hasBackend(),
    staleTime: 60_000,
  });
}

export function useGitlabStatus(enabled = true) {
  return useQuery({
    queryKey: ["inbox", "gitlab-status"],
    queryFn: gitlabStatus,
    enabled: enabled && hasBackend(),
    staleTime: 60_000,
  });
}
