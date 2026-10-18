import { describe, expect, test } from "bun:test";
import type { PrDiff, WorkItem } from "../src/lib/inbox";
import type { PrDiffFile } from "../src/features/source-control/model/prDiff";
import {
  buildInboxDiffFiles,
  canPostComment,
  checkDotClass,
  checkDurationSeconds,
  commentBody,
  describeGithubConnection,
  detailTabs,
  filterInboxRows,
  firstInboxError,
  inboxRowKey,
  isAnyFetching,
  isPrActionVisible,
  mergeInboxRows,
  reviewDecisionLabel,
  selectActiveRow,
  selectInboxRows,
  stateLabel,
  statePillClass,
  toDiffFileModel,
  toUnifiedLine,
  visibleDetailTabs,
} from "../src/features/inbox/model/inboxView";

function item(overrides: Partial<WorkItem> & Pick<WorkItem, "repo" | "kind" | "number">): WorkItem {
  return {
    provider: "github",
    title: `${overrides.repo}#${overrides.number}`,
    url: "",
    state: "open",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    ...overrides,
  };
}

describe("inbox rows", () => {
  test("keys by provider, repo, kind and number", () => {
    expect(inboxRowKey(item({ repo: "acme/app", kind: "pr", number: 7 }))).toBe("github:acme/app:pr:7");
  });

  test("merges lists, dedupes by key and keeps newest first", () => {
    const older = item({ repo: "a", kind: "issue", number: 1, updatedAt: "2026-01-01T00:00:00Z" });
    const newer = item({ repo: "a", kind: "pr", number: 2, updatedAt: "2026-02-01T00:00:00Z" });
    const duplicate = item({ repo: "a", kind: "issue", number: 1, updatedAt: "2026-01-01T00:00:00Z" });
    const rows = mergeInboxRows([[older], [newer, duplicate]]);
    expect(rows.map((row) => row.key)).toEqual(["github:a:pr:2", "github:a:issue:1"]);
  });

  test("filters by kind without mutating the merged rows", () => {
    const rows = mergeInboxRows([
      [item({ repo: "a", kind: "issue", number: 1 })],
      [item({ repo: "a", kind: "pr", number: 2, updatedAt: "2026-03-01T00:00:00Z" })],
    ]);
    expect(filterInboxRows(rows, "pr").map((row) => row.kind)).toEqual(["pr"]);
    expect(filterInboxRows(rows, "all")).toEqual(rows);
    expect(rows).toHaveLength(2);
  });

  test("github needs a project; gitlab merges every list", () => {
    const gh = [item({ repo: "a", kind: "issue", number: 1 })];
    const gl = [item({ provider: "gitlab", repo: "b", kind: "pr", number: 2 })];
    expect(selectInboxRows("github", "", "all", { github: [gh], gitlab: [gl] })).toEqual([]);
    expect(selectInboxRows("github", "/p", "all", { github: [gh], gitlab: [gl] })).toHaveLength(1);
    expect(selectInboxRows("gitlab", "", "pr", { github: [gh], gitlab: [gl] })).toHaveLength(1);
  });

  test("resolves the selected row by key", () => {
    const rows = mergeInboxRows([
      [item({ repo: "a", kind: "issue", number: 1 })],
      [item({ repo: "a", kind: "pr", number: 2 })],
    ]);
    expect(selectActiveRow(rows, "github:a:pr:2")?.number).toBe(2);
    expect(selectActiveRow(rows, null)).toBeNull();
    expect(selectActiveRow(rows, "missing")).toBeNull();
  });

  test("picks the first real error and ignores nullish values", () => {
    expect(firstInboxError([undefined, null, "boom", "later"])).toBe("boom");
    expect(firstInboxError([null, undefined])).toBeNull();
    expect(isAnyFetching([false, false])).toBe(false);
    expect(isAnyFetching([false, true])).toBe(true);
  });
});

describe("inbox badges", () => {
  test("maps states and review decisions with raw fallbacks", () => {
    expect(stateLabel("open")).toBe("打开");
    expect(stateLabel("unknown")).toBe("unknown");
    expect(reviewDecisionLabel("APPROVED")).toBe("已批准");
    expect(reviewDecisionLabel("COMMENTED")).toBe("COMMENTED");
    expect(statePillClass("open")).toContain("emerald");
    expect(statePillClass("merged")).toContain("violet");
    expect(statePillClass("closed")).toContain("content/50");
  });

  test("maps check dots with a neutral fallback", () => {
    expect(checkDotClass("pass")).toContain("emerald");
    expect(checkDotClass("pending")).toContain("animate-pulse");
    expect(checkDotClass("mystery")).toBe(checkDotClass("unknown"));
  });

  test("formats check durations in rounded seconds", () => {
    expect(
      checkDurationSeconds({ startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:05Z" }),
    ).toBe(65);
    expect(
      checkDurationSeconds({ startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:00.200Z" }),
    ).toBe(1);
    expect(checkDurationSeconds({ startedAt: null, completedAt: "2026-01-01T00:00:00Z" })).toBeNull();
    expect(checkDurationSeconds({ startedAt: "2026-01-01T00:00:00Z", completedAt: null })).toBeNull();
  });
});

describe("inbox discussion composer", () => {
  test("trims drafts and blocks empty or in-flight posts", () => {
    expect(commentBody("  hello  ")).toBe("hello");
    expect(canPostComment("hello", false)).toBe(true);
    expect(canPostComment("  ", false)).toBe(false);
    expect(canPostComment("hello", true)).toBe(false);
  });
});

describe("inbox pr actions", () => {
  test("only offers transitions valid for the current state", () => {
    const open = { state: "open", draft: false };
    const draft = { state: "open", draft: true };
    const closed = { state: "closed", draft: false };
    expect(isPrActionVisible("reopen", open)).toBe(false);
    expect(isPrActionVisible("reopen", closed)).toBe(true);
    expect(isPrActionVisible("close", closed)).toBe(false);
    expect(isPrActionVisible("close", open)).toBe(true);
    expect(isPrActionVisible("ready", draft)).toBe(false);
    expect(isPrActionVisible("draft", draft)).toBe(true);
    expect(isPrActionVisible("ready", open)).toBe(true);
    expect(isPrActionVisible("draft", open)).toBe(false);
    expect(isPrActionVisible("merge", open)).toBe(true);
  });

  test("hides provider-specific tabs", () => {
    expect(detailTabs("github", "pr").map((tab) => tab.id)).toEqual([
      "overview",
      "discussion",
      "changes",
      "checks",
    ]);
    expect(visibleDetailTabs("gitlab", "pr").map((tab) => tab.id)).toEqual([
      "overview",
      "discussion",
      "changes",
    ]);
    expect(visibleDetailTabs("github", "issue").map((tab) => tab.id)).toEqual(["overview", "discussion"]);
  });
});

describe("inbox diff model", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    " const c = 3;",
  ].join("\n");

  test("converts unified lines and preserves numbers", () => {
    expect(
      toUnifiedLine({ kind: "add", text: "x", oldNumber: null, newNumber: 4 }),
    ).toEqual({ kind: "add", text: "x", oldNumber: null, newNumber: 4 });
  });

  test("builds unified file models from a pr patch", () => {
    const diff: PrDiff = {
      additions: 1,
      deletions: 0,
      files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
      patch,
      truncated: false,
    };
    const files = buildInboxDiffFiles(diff, false);
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe("src/a.ts");
    expect(files[0].label).toBe("src/a.ts");
    expect(files[0].emptyMessage).toBeUndefined();
    expect(files[0].blocks.reduce((total, block) => total + block.lines.length, 0)).toBe(4);
    expect(buildInboxDiffFiles(diff, true)[0].blocks.reduce((total, block) => total + block.lines.length, 0)).toBe(4);
  });

  test("labels renamed files and explains empty/truncated/binary patches", () => {
    const renamed: PrDiffFile = {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      binary: false,
      additions: 2,
      deletions: 1,
      lines: [],
    };
    const model = toDiffFileModel(renamed, false);
    expect(model.label).toBe("src/old.ts → src/new.ts");
    expect(model.emptyMessage).toBe("没有文本差异");
    expect(toDiffFileModel(renamed, true).emptyMessage).toBe("变更过大，无法展示补丁");
    expect(toDiffFileModel({ ...renamed, binary: true }, true).emptyMessage).toBeUndefined();
  });
});

describe("github connection presentation", () => {
  test("maps pending, connected, installed and missing", () => {
    expect(describeGithubConnection({ pending: true, authenticated: false, installed: false })).toEqual({
      state: "pending",
      tone: "off",
      label: "检测中…",
    });
    expect(describeGithubConnection({ pending: false, authenticated: true, installed: true })).toEqual({
      state: "connected",
      tone: "ok",
      label: "已登录",
    });
    expect(describeGithubConnection({ pending: false, authenticated: false, installed: true })).toEqual({
      state: "installed",
      tone: "warn",
      label: "未登录",
    });
    expect(describeGithubConnection({ pending: false, authenticated: false, installed: false })).toEqual({
      state: "missing",
      tone: "off",
      label: "未安装",
    });
  });
});
