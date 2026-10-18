import type {
  GitChangedFile,
  GitDiffIndex,
  GitPr,
  GitRangeContext,
} from "../../../platform/tauri/fs";
import { changeBasename } from "./gitChanges";

export type CommitGateInput = {
  index: GitDiffIndex | null;
  pr: GitPr | null;
  /** Files with staged changes; drives commit availability. */
  stagedCount: number;
  /** Every changed file, staged or not. */
  fileCount: number;
  amend: boolean;
  message: string;
  /** Id of the running git mutation, or null when idle. */
  busy: string | null;
  /** The project lives behind a remote workspace, so no local harness. */
  remoteProject: boolean;
};

export type CommitGate = {
  hasRemote: boolean;
  hasOpenPr: boolean;
  diverged: boolean;
  onDefault: boolean;
  canGenerate: boolean;
  canCommit: boolean;
  canCreatePr: boolean;
  canViewPr: boolean;
  canPublish: boolean;
  canSync: boolean;
  canCommitPush: boolean;
  canCommitPushPr: boolean;
  canEditMessage: boolean;
  canOpenMenu: boolean;
  showCreatePr: boolean;
  showViewPr: boolean;
};

/** Every enablement flag of the commit box and sync row, derived in one place. */
export function commitGate({
  index,
  pr,
  stagedCount,
  fileCount,
  amend,
  message,
  busy,
  remoteProject,
}: CommitGateInput): CommitGate {
  const hasRemote = Boolean(index?.remote);
  const hasOpenPr = pr?.state === "open";
  const diverged = (index?.ahead ?? 0) > 0 && (index?.behind ?? 0) > 0;
  const onDefault =
    !!index?.branch &&
    !!index.defaultBranch &&
    index.branch === index.defaultBranch;
  const canGenerate = fileCount > 0 && !busy && !remoteProject;
  const canCommit = (stagedCount > 0 || amend) && message.trim().length > 0 && !busy;
  const canCreatePr =
    hasRemote &&
    !!index?.branch &&
    !!index.defaultBranch &&
    !hasOpenPr &&
    !onDefault &&
    !diverged &&
    fileCount === 0 &&
    (index?.aheadOfDefault ?? 0) > 0 &&
    (index?.behind ?? 0) === 0;
  const canViewPr = hasOpenPr && !!pr?.url;
  const canPublish = hasRemote && !index?.upstream;
  const canSync =
    hasRemote &&
    Boolean(index?.upstream) &&
    ((index?.ahead ?? 0) > 0 || (index?.behind ?? 0) > 0);
  const canCommitPush =
    canCommit && hasRemote && !diverged && (!amend || !index?.headPushed);
  const canCommitPushPr = canCommitPush && !hasOpenPr && !onDefault;
  const canEditMessage = (stagedCount > 0 || amend) && !busy;
  const canOpenMenu = !!index?.branch && !busy;
  return {
    hasRemote,
    hasOpenPr,
    diverged,
    onDefault,
    canGenerate,
    canCommit,
    canCreatePr,
    canViewPr,
    canPublish,
    canSync,
    canCommitPush,
    canCommitPushPr,
    canEditMessage,
    canOpenMenu,
    showCreatePr: !hasOpenPr && !onDefault,
    showViewPr: hasOpenPr,
  };
}

/** The pull item is only usable once the branch has both remote and upstream. */
export function canPullBranch(index: GitDiffIndex | null): boolean {
  return Boolean(index?.remote) && Boolean(index?.upstream);
}

function commits(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

/** Tooltip for the publish/sync button. */
export function syncActionTitle({
  index,
  canPublish,
  syncing,
}: {
  index: GitDiffIndex;
  canPublish: boolean;
  syncing: boolean;
}): string {
  if (syncing) return "Synchronizing Changes...";
  const { ahead, behind } = index;
  const dest = upstreamRef(index);
  if (canPublish) {
    return index.branch ? `Publish Branch "${index.branch}"` : "Publish Branch";
  }
  if (behind > 0 && ahead > 0) {
    return `Pull ${behind} and push ${ahead} commits between ${dest}`;
  }
  if (behind > 0) return `Pull ${commits(behind)} from ${dest}`;
  return `Push ${commits(ahead)} to ${dest}`;
}

/** `origin/main` style label for the remote branch the sync targets. */
export function upstreamRef(index: GitDiffIndex): string {
  return index.upstream ?? `${index.remote ?? "origin"}/${index.branch ?? "HEAD"}`;
}

export function createPrTitle(index: GitDiffIndex): string {
  return index.defaultBranch
    ? `Create a pull request into ${index.defaultBranch}`
    : "创建 PR";
}

export function viewPrTitle(pr: GitPr | null): string {
  return pr?.title ? `View PR #${pr.number}: ${pr.title}` : "查看 PR";
}

/** Confirmation copy before discarding one file. */
export function discardFileConfirm(file: GitChangedFile): {
  message: string;
  okLabel: string;
} {
  const name = changeBasename(file.relative);
  if (file.status === "untracked") {
    return { message: `Delete untracked file ${name}?`, okLabel: "Delete" };
  }
  return {
    message: `Discard changes in ${name}? This cannot be undone.`,
    okLabel: "Discard",
  };
}

/** Confirmation copy before discarding every unstaged change; null when none. */
export function discardAllConfirm(
  unstaged: GitChangedFile[],
): { message: string; okLabel: string } | null {
  const count = unstaged.length;
  if (count === 0) return null;
  const only = unstaged[0];
  const untrackedOnly = count === 1 && only?.status === "untracked";
  if (untrackedOnly && only) {
    return {
      message: `Delete untracked file ${changeBasename(only.relative)}?`,
      okLabel: "Delete",
    };
  }
  if (count === 1 && only) {
    return {
      message: `Discard changes in ${changeBasename(only.relative)}? This cannot be undone.`,
      okLabel: "Discard",
    };
  }
  return {
    message: `Discard all unstaged changes in ${count} files? This cannot be undone.`,
    okLabel: "Discard",
  };
}

export type PrContent = {
  title: string;
  body: string;
  base: string;
  head: string;
};

/** Builds PR text from the host-side git range, without any local harness. */
export function prContentFromRange(range: GitRangeContext): PrContent {
  const commitsSummary = range.commitSummary.trim();
  const firstCommit = commitsSummary
    .split(/\r?\n/, 1)[0]
    ?.replace(/^[0-9a-f]+\s+/i, "")
    .trim();
  const title = firstCommit || `Changes on ${range.head}`;
  const body = [
    commitsSummary && `## Commits\n\n${commitsSummary}`,
    range.diffSummary.trim() && `## Changes\n\n${range.diffSummary.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { title, body: body || title, base: range.base, head: range.head };
}

/** Pull request number from a GitHub URL, when it has one. */
export function prNumberFromUrl(url: string): number | null {
  const number = Number(/\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}
