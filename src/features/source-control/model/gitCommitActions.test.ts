import { describe, expect, it } from "bun:test";
import type {
  GitChangedFile,
  GitDiffIndex,
  GitPr,
  GitRangeContext,
} from "../../../platform/tauri/fs";
import {
  canPullBranch,
  commitGate,
  createPrTitle,
  discardAllConfirm,
  discardFileConfirm,
  prContentFromRange,
  prNumberFromUrl,
  syncActionTitle,
  upstreamRef,
  viewPrTitle,
} from "./gitCommitActions";

function index(overrides: Partial<GitDiffIndex> = {}): GitDiffIndex {
  return {
    branch: "feature/x",
    head: "abc123",
    files: [],
    additions: 0,
    deletions: 0,
    remote: "origin",
    upstream: "origin/feature/x",
    defaultBranch: "main",
    ahead: 0,
    behind: 0,
    aheadOfDefault: 0,
    headPushed: true,
    ...overrides,
  };
}

function file(relative: string, overrides: Partial<GitChangedFile> = {}): GitChangedFile {
  return {
    path: `/repo/${relative}`,
    relative,
    status: "modified",
    additions: 1,
    deletions: 0,
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

const pr: GitPr = {
  number: 42,
  title: "Add the thing",
  url: "https://example.test/pull/42",
  state: "open",
};

function gate(overrides: Partial<Parameters<typeof commitGate>[0]> = {}) {
  return commitGate({
    index: index(),
    pr: null,
    stagedCount: 0,
    fileCount: 0,
    amend: false,
    message: "",
    busy: null,
    remoteProject: false,
    ...overrides,
  });
}

describe("commit gate", () => {
  it("needs a staged file and a message before committing", () => {
    expect(gate({ stagedCount: 1, message: "fix" }).canCommit).toBe(true);
    expect(gate({ stagedCount: 1, message: "   " }).canCommit).toBe(false);
    expect(gate({ stagedCount: 0, message: "fix" }).canCommit).toBe(false);
    expect(gate({ amend: true, message: "fix" }).canCommit).toBe(true);
    expect(gate({ stagedCount: 1, message: "fix", busy: "commit" }).canCommit).toBe(false);
  });

  it("only generates a message for changed files, without a busy git run", () => {
    expect(gate({ fileCount: 1 }).canGenerate).toBe(true);
    expect(gate({ fileCount: 0 }).canGenerate).toBe(false);
    expect(gate({ fileCount: 1, busy: "generate" }).canGenerate).toBe(false);
    expect(gate({ fileCount: 1, remoteProject: true }).canGenerate).toBe(false);
  });

  it("offers Commit & Push only on a synced branch with a remote", () => {
    expect(gate({ stagedCount: 1, message: "fix" }).canCommitPush).toBe(true);
    expect(gate({ stagedCount: 1, message: "fix", index: index({ remote: null }) }).canCommitPush).toBe(false);
    expect(
      gate({ stagedCount: 1, message: "fix", index: index({ ahead: 1, behind: 1 }) }).canCommitPush,
    ).toBe(false);
    expect(
      gate({
        stagedCount: 1,
        message: "fix",
        amend: true,
        index: index({ headPushed: false }),
      }).canCommitPush,
    ).toBe(true);
    expect(
      gate({ stagedCount: 1, message: "fix", amend: true, index: index({ headPushed: true }) }).canCommitPush,
    ).toBe(false);
  });

  it("hides Commit & Push PR on the default branch or with an open PR", () => {
    const ready = { stagedCount: 1, message: "fix" };
    expect(gate(ready).canCommitPushPr).toBe(true);
    expect(gate({ ...ready, index: index({ branch: "main" }) }).canCommitPushPr).toBe(false);
    expect(gate({ ...ready, pr }).canCommitPushPr).toBe(false);
  });

  it("publishes only a branch without upstream and syncs only when ahead or behind", () => {
    const publish = gate({ index: index({ upstream: null }) });
    expect(publish.canPublish).toBe(true);
    expect(publish.canSync).toBe(false);
    expect(gate({ index: index({ ahead: 1 }) }).canSync).toBe(true);
    expect(gate({ index: index({ behind: 1 }) }).canSync).toBe(true);
    expect(gate({ index: index() }).canSync).toBe(false);
  });

  it("creates a PR only for a clean branch ahead of a non-default base", () => {
    const ready = { index: index({ ahead: 1, aheadOfDefault: 2 }) };
    expect(gate(ready).canCreatePr).toBe(true);
    expect(gate({ ...ready, fileCount: 1 }).canCreatePr).toBe(false);
    expect(gate({ ...ready, index: index({ branch: "main", ahead: 1, aheadOfDefault: 2 }) }).canCreatePr).toBe(false);
    expect(gate({ ...ready, index: index({ aheadOfDefault: 0, ahead: 1 }) }).canCreatePr).toBe(false);
    expect(gate({ ...ready, index: index({ ahead: 1, aheadOfDefault: 2, behind: 1 }) }).canCreatePr).toBe(false);
    expect(gate({ ...ready, pr }).canCreatePr).toBe(false);
    expect(gate({ ...ready, index: index({ ahead: 1, aheadOfDefault: 2, remote: null }) }).canCreatePr).toBe(false);
  });

  it("exposes the open PR state and action visibility", () => {
    expect(gate({ pr }).canViewPr).toBe(true);
    expect(gate({ pr: { ...pr, url: "" } }).canViewPr).toBe(false);
    expect(gate({ pr }).showViewPr).toBe(true);
    expect(gate({ pr }).showCreatePr).toBe(false);
    expect(gate({}).showCreatePr).toBe(true);
    expect(gate({ index: index({ branch: "main" }) }).showCreatePr).toBe(false);
  });

  it("gates the message box and the options menu", () => {
    expect(gate({ stagedCount: 1 }).canEditMessage).toBe(true);
    expect(gate({ amend: true }).canEditMessage).toBe(true);
    expect(gate({ stagedCount: 1, busy: "commit" }).canEditMessage).toBe(false);
    expect(gate({}).canOpenMenu).toBe(true);
    expect(gate({ index: index({ branch: null }) }).canOpenMenu).toBe(false);
    expect(gate({ busy: "pull" }).canOpenMenu).toBe(false);
  });
});

describe("pull gate", () => {
  it("needs both a remote and an upstream", () => {
    expect(canPullBranch(index())).toBe(true);
    expect(canPullBranch(index({ upstream: null }))).toBe(false);
    expect(canPullBranch(index({ remote: null }))).toBe(false);
    expect(canPullBranch(null)).toBe(false);
  });
});

describe("sync and PR action titles", () => {
  it("describes publish, sync and push targets", () => {
    expect(
      syncActionTitle({ index: index({ ahead: 1 }), canPublish: false, syncing: false }),
    ).toBe("Push 1 commit to origin/feature/x");
    expect(
      syncActionTitle({ index: index({ ahead: 2 }), canPublish: false, syncing: false }),
    ).toBe("Push 2 commits to origin/feature/x");
    expect(
      syncActionTitle({ index: index({ behind: 1 }), canPublish: false, syncing: false }),
    ).toBe("Pull 1 commit from origin/feature/x");
    expect(
      syncActionTitle({
        index: index({ ahead: 2, behind: 1 }),
        canPublish: false,
        syncing: false,
      }),
    ).toBe("Pull 1 and push 2 commits between origin/feature/x");
    expect(
      syncActionTitle({ index: index({ upstream: null }), canPublish: true, syncing: false }),
    ).toBe('Publish Branch "feature/x"');
    expect(
      syncActionTitle({
        index: index({ branch: null, upstream: null }),
        canPublish: true,
        syncing: false,
      }),
    ).toBe("Publish Branch");
    expect(
      syncActionTitle({ index: index({ ahead: 1 }), canPublish: false, syncing: true }),
    ).toBe("Synchronizing Changes...");
  });

  it("falls back to remote/branch when there is no upstream", () => {
    expect(upstreamRef(index({ upstream: null }))).toBe("origin/feature/x");
    expect(upstreamRef(index({ upstream: null, remote: null, branch: null }))).toBe(
      "origin/HEAD",
    );
    expect(upstreamRef(index())).toBe("origin/feature/x");
  });

  it("labels the create and view PR buttons", () => {
    expect(createPrTitle(index())).toBe("Create a pull request into main");
    expect(createPrTitle(index({ defaultBranch: null }))).toBe("创建 PR");
    expect(viewPrTitle(pr)).toBe("View PR #42: Add the thing");
    expect(viewPrTitle({ ...pr, title: "" })).toBe("查看 PR");
    expect(viewPrTitle(null)).toBe("查看 PR");
  });
});

describe("discard confirmations", () => {
  it("asks to delete an untracked file and to discard a tracked one", () => {
    expect(discardFileConfirm(file("n.ts", { status: "untracked" }))).toEqual({
      message: "Delete untracked file n.ts?",
      okLabel: "Delete",
    });
    expect(discardFileConfirm(file("src/n.ts"))).toEqual({
      message: "Discard changes in n.ts? This cannot be undone.",
      okLabel: "Discard",
    });
  });

  it("names the single file and counts many", () => {
    expect(discardAllConfirm([])).toBeNull();
    expect(discardAllConfirm([file("a.ts", { status: "untracked" })])).toEqual({
      message: "Delete untracked file a.ts?",
      okLabel: "Delete",
    });
    expect(discardAllConfirm([file("a.ts")])).toEqual({
      message: "Discard changes in a.ts? This cannot be undone.",
      okLabel: "Discard",
    });
    expect(discardAllConfirm([file("a.ts"), file("b.ts")])).toEqual({
      message: "Discard all unstaged changes in 2 files? This cannot be undone.",
      okLabel: "Discard",
    });
  });
});

describe("PR content", () => {
  const range: GitRangeContext = {
    base: "main",
    head: "feature/x",
    commitSummary: "abc123 Fix the flow\ndef456 Add coverage",
    diffSummary: "2 files changed, 4 insertions(+)\n",
    diffPatch: "",
  };

  it("uses the first commit as title and both summaries as body", () => {
    expect(prContentFromRange(range)).toEqual({
      title: "Fix the flow",
      body: "## Commits\n\nabc123 Fix the flow\ndef456 Add coverage\n\n## Changes\n\n2 files changed, 4 insertions(+)",
      base: "main",
      head: "feature/x",
    });
  });

  it("falls back to the head ref when the range has no commits", () => {
    const empty: GitRangeContext = {
      ...range,
      commitSummary: "  \n",
      diffSummary: "",
    };
    expect(prContentFromRange(empty)).toEqual({
      title: "Changes on feature/x",
      body: "Changes on feature/x",
      base: "main",
      head: "feature/x",
    });
  });

  it("reads the pull request number out of a URL", () => {
    expect(prNumberFromUrl("https://example.test/pull/42")).toBe(42);
    expect(prNumberFromUrl("https://example.test/pull/42/checks?x=1")).toBe(42);
    expect(prNumberFromUrl("https://example.test/pull/42#top")).toBe(42);
    expect(prNumberFromUrl("https://example.test/pull/0")).toBeNull();
    expect(prNumberFromUrl("https://example.test/repo")).toBeNull();
  });
});
