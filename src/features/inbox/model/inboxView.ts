import type {
  GithubPrAction,
  InboxProvider,
  PrCheck,
  PrDiff,
  WorkItem,
  WorkItemKind,
} from "../../../lib/inbox";
import { mergePrDiff, parsePrPatch, type PrDiffFile, type PrDiffLine } from "../../source-control/model/prDiff";
import { blocksFromLines, type UnifiedBlock, type UnifiedLine } from "../../source-control/model/unifiedDiff";

/**
 * Pure Inbox view model: list merging, badge/label mapping, diff conversion and
 * detail-pane decisions. Data loading stays in `lib/inbox` + react-query.
 */

export type InboxKindFilter = "all" | WorkItemKind;
export type InboxTabId = "overview" | "discussion" | "changes" | "checks";
export type InboxRowItem = WorkItem & { key: string };

export type InboxDiffFileModel = {
  id: string;
  path: string;
  label: string;
  binary?: boolean;
  emptyMessage?: string;
  additions: number;
  deletions: number;
  blocks: UnifiedBlock[];
};

export function inboxRowKey(item: WorkItem): string {
  return `${item.provider}:${item.repo}:${item.kind}:${item.number}`;
}

/** Deduplicate across provider list queries, then newest first. */
export function mergeInboxRows(lists: readonly (readonly WorkItem[] | undefined)[]): InboxRowItem[] {
  const seen = new Set<string>();
  const rows: InboxRowItem[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = inboxRowKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...item, key });
    }
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rows;
}

export function filterInboxRows(rows: readonly InboxRowItem[], kindFilter: InboxKindFilter): InboxRowItem[] {
  if (kindFilter === "all") return [...rows];
  return rows.filter((item) => item.kind === kindFilter);
}

export function selectActiveRow(rows: readonly InboxRowItem[], activeKey: string | null): InboxRowItem | null {
  return rows.find((item) => item.key === activeKey) ?? null;
}

export function selectInboxRows(
  source: InboxProvider,
  project: string,
  kindFilter: InboxKindFilter,
  lists: { github: readonly (readonly WorkItem[] | undefined)[]; gitlab: readonly (readonly WorkItem[] | undefined)[] },
): InboxRowItem[] {
  if (source === "github" && !project) return [];
  return filterInboxRows(mergeInboxRows(source === "github" ? lists.github : lists.gitlab), kindFilter);
}

export function firstInboxError<T>(errors: readonly (T | null | undefined)[]): T | null {
  for (const error of errors) {
    if (error !== null && error !== undefined) return error;
  }
  return null;
}

export function isAnyFetching(flags: readonly boolean[]): boolean {
  return flags.some(Boolean);
}

/* ---------------------------------------------------------------- labels */

export const STATE_LABEL: Record<string, string> = {
  open: "打开",
  closed: "已关闭",
  merged: "已合并",
};

export const REVIEW_DECISION_LABEL: Record<string, string> = {
  APPROVED: "已批准",
  CHANGES_REQUESTED: "等待修改",
  REVIEW_REQUIRED: "等待评审",
};

export const CHECK_DOT: Record<string, string> = {
  pass: "bg-emerald-400",
  fail: "bg-red-400",
  pending: "bg-amber-400 animate-pulse",
  skipping: "bg-content/30",
  cancel: "bg-content/40",
  unknown: "bg-content/30",
};

export function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? state;
}

export function statePillClass(state: string): string {
  if (state === "open") return "text-emerald-400 bg-emerald-400/10";
  if (state === "merged") return "text-violet-400 bg-violet-400/10";
  return "text-content/50 bg-content/8";
}

export function reviewDecisionLabel(decision: string): string {
  return REVIEW_DECISION_LABEL[decision] ?? decision;
}

export function checkDotClass(state: string): string {
  return CHECK_DOT[state] ?? "bg-content/30";
}

/** Rounded whole seconds, or null when the check has no start/finish pair. */
export function checkDurationSeconds(check: Pick<PrCheck, "startedAt" | "completedAt">): number | null {
  if (!check.startedAt || !check.completedAt) return null;
  return Math.max(1, Math.round((Date.parse(check.completedAt) - Date.parse(check.startedAt)) / 1000));
}

/* ------------------------------------------------------------- discussion */

export function commentBody(draft: string): string {
  return draft.trim();
}

/** Composer state machine: an empty or in-flight draft cannot be posted. */
export function canPostComment(draft: string, posting: boolean): boolean {
  return Boolean(draft.trim()) && !posting;
}

/* ------------------------------------------------------------- pr actions */

export const PR_ACTIONS: { id: GithubPrAction; label: string; danger?: boolean }[] = [
  { id: "ready", label: "标记就绪" },
  { id: "draft", label: "转草稿" },
  { id: "merge", label: "合并" },
  { id: "squash", label: "压缩合并" },
  { id: "rebase", label: "Rebase 合并" },
  { id: "close", label: "关闭", danger: true },
  { id: "reopen", label: "重新打开" },
];

/** Only offer transitions that make sense for the current PR state. */
export function isPrActionVisible(id: GithubPrAction, item: Pick<WorkItem, "state" | "draft">): boolean {
  switch (id) {
    case "reopen":
      return item.state === "closed";
    case "close":
      return item.state !== "closed";
    case "draft":
      return item.draft;
    case "ready":
      return !item.draft;
    default:
      return true;
  }
}

export function detailTabs(provider: InboxProvider, kind: WorkItemKind): { id: InboxTabId; label: string; show: boolean }[] {
  return [
    { id: "overview", label: "概览", show: true },
    { id: "discussion", label: "讨论", show: true },
    { id: "changes", label: "变更", show: kind === "pr" },
    { id: "checks", label: "检查", show: provider === "github" && kind === "pr" },
  ];
}

export function visibleDetailTabs(
  provider: InboxProvider,
  kind: WorkItemKind,
): { id: InboxTabId; label: string }[] {
  return detailTabs(provider, kind)
    .filter((entry) => entry.show)
    .map(({ id, label }) => ({ id, label }));
}

/* ------------------------------------------------------------------ diff */

export function toUnifiedLine(line: PrDiffLine): UnifiedLine {
  return {
    kind: line.kind,
    text: line.text,
    oldNumber: line.oldNumber ?? null,
    newNumber: line.newNumber ?? null,
  };
}

export function toDiffFileModel(file: PrDiffFile, truncated: boolean, context?: number): InboxDiffFileModel {
  const lines = file.lines.map(toUnifiedLine);
  return {
    id: file.path,
    path: file.path,
    label:
      file.status === "renamed" && file.previousPath
        ? `${file.previousPath} → ${file.path}`
        : file.path,
    binary: file.binary,
    emptyMessage:
      !file.binary && file.lines.length === 0
        ? truncated
          ? "变更过大，无法展示补丁"
          : "没有文本差异"
        : undefined,
    additions: file.additions,
    deletions: file.deletions,
    blocks: blocksFromLines(lines, context),
  };
}

export function buildInboxDiffFiles(diff: PrDiff, fullFile: boolean): InboxDiffFileModel[] {
  const parsed = mergePrDiff(diff.files, parsePrPatch(diff.patch));
  const context = fullFile ? Number.POSITIVE_INFINITY : undefined;
  return parsed.map((file) => toDiffFileModel(file, diff.truncated, context));
}

/* -------------------------------------------------------------- settings */

export type GithubConnectionTone = "ok" | "warn" | "off";
export type GithubConnectionState = "pending" | "connected" | "installed" | "missing";

export function describeGithubConnection(input: {
  pending: boolean;
  authenticated: boolean;
  installed: boolean;
}): { state: GithubConnectionState; tone: GithubConnectionTone; label: string } {
  if (input.pending) return { state: "pending", tone: "off", label: "检测中…" };
  if (input.authenticated) return { state: "connected", tone: "ok", label: "已登录" };
  if (input.installed) return { state: "installed", tone: "warn", label: "未登录" };
  return { state: "missing", tone: "off", label: "未安装" };
}
