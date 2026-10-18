import { describe, expect, it } from "bun:test";
import type { GitChangedFile, GitDiffIndex } from "../../../platform/tauri/fs";
import {
  buildChangeTree,
  changeBasename,
  changeDirname,
  changedFilePaths,
  filesUnderFolder,
  isActiveChangeFile,
  sameDiffIndex,
  splitByStage,
  statusColor,
  statusLetter,
  syncStatusLabel,
} from "./gitChanges";

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

function index(overrides: Partial<GitDiffIndex> = {}): GitDiffIndex {
  return {
    branch: "main",
    head: "abc123",
    files: [],
    additions: 0,
    deletions: 0,
    remote: "origin",
    upstream: "origin/main",
    defaultBranch: "main",
    ahead: 0,
    behind: 0,
    aheadOfDefault: 0,
    headPushed: true,
    ...overrides,
  };
}

describe("change paths", () => {
  it("takes the last segment and normalizes windows separators", () => {
    expect(changeBasename("src/app/main.ts")).toBe("main.ts");
    expect(changeBasename("src\\app\\main.ts")).toBe("main.ts");
    expect(changeBasename("main.ts")).toBe("main.ts");
  });

  it("returns the folder part, but never a leading slash", () => {
    expect(changeDirname("src/app/main.ts")).toBe("src/app");
    expect(changeDirname("main.ts")).toBe("");
    expect(changeDirname("/main.ts")).toBe("");
  });
});

describe("status badges", () => {
  it("maps git status to a letter", () => {
    expect(statusLetter("untracked")).toBe("U");
    expect(statusLetter("added")).toBe("A");
    expect(statusLetter("deleted")).toBe("D");
    expect(statusLetter("modified")).toBe("M");
    expect(statusLetter("renamed")).toBe("M");
  });

  it("maps git status to a text color", () => {
    expect(statusColor("untracked")).toBe("text-sky-400");
    expect(statusColor("added")).toBe("text-diff-add-fg");
    expect(statusColor("deleted")).toBe("text-diff-del-fg");
    expect(statusColor("modified")).toBe("text-amber-400");
  });
});

describe("selection", () => {
  const changed = file("src/app.ts");

  it("matches only the same relative path and kind", () => {
    expect(isActiveChangeFile(changed, "src/app.ts", "unstaged", "unstaged")).toBe(true);
    expect(isActiveChangeFile(changed, "src/app.ts", undefined, "staged")).toBe(true);
    expect(isActiveChangeFile(changed, "src/app.ts", "staged", "unstaged")).toBe(false);
    expect(isActiveChangeFile(changed, "src/other.ts", undefined, "unstaged")).toBe(false);
  });
});

describe("sections", () => {
  it("splits staged and unstaged files, keeping files that have both", () => {
    const both = file("both.ts", { staged: true, unstaged: true });
    const { staged, unstaged } = splitByStage([
      file("plain.ts"),
      file("ready.ts", { staged: true, unstaged: false }),
      both,
    ]);
    expect(staged.map((entry) => entry.relative)).toEqual(["ready.ts", "both.ts"]);
    expect(unstaged.map((entry) => entry.relative)).toEqual(["plain.ts", "both.ts"]);
  });

  it("finds the files under one folder prefix only", () => {
    const files = [
      file("src/app.ts"),
      file("src/nested/one.ts"),
      file("src-other/two.ts"),
    ];
    expect(filesUnderFolder(files, "src").map((entry) => entry.relative)).toEqual([
      "src/app.ts",
      "src/nested/one.ts",
    ]);
  });
});

describe("change tree", () => {
  it("nests files under folders and sorts both levels", () => {
    const tree = buildChangeTree([
      file("src/zeta.ts"),
      file("src/nested/one.ts"),
      file("docs/readme.md"),
      file("src/alpha.ts"),
    ]);
    expect(tree.dirs.map((dir) => dir.name)).toEqual(["docs", "src"]);
    const src = tree.dirs[1]!;
    expect(src.dirs.map((dir) => dir.name)).toEqual(["nested"]);
    expect(src.files.map((entry) => entry.relative)).toEqual([
      "src/alpha.ts",
      "src/zeta.ts",
    ]);
    expect(src.dirs[0]!.path).toBe("src/nested");
    // Each file lives in exactly one node, once.
    expect(JSON.stringify(tree).match(/src\/alpha\.ts/g)?.length).toBe(2);
  });

  it("rolls a shared status up and reports mixed folders as null", () => {
    const shared = buildChangeTree([
      file("a/one.ts", { status: "added" }),
      file("a/two.ts", { status: "added" }),
    ]);
    expect(shared.status).toBe("added");
    expect(shared.dirs[0]!.status).toBe("added");

    const mixed = buildChangeTree([
      file("a/one.ts", { status: "added" }),
      file("a/two.ts", { status: "modified" }),
    ]);
    expect(mixed.status).toBeNull();
    expect(mixed.dirs[0]!.status).toBeNull();
  });
});

describe("index snapshots", () => {
  it("lists new, changed and removed paths", () => {
    const prev = index({
      files: [
        file("keep.ts"),
        file("edited.ts"),
        file("gone.ts"),
        file("staged.ts", { staged: true, unstaged: false }),
      ],
    });
    const next = index({
      files: [
        file("keep.ts"),
        file("edited.ts", { additions: 9 }),
        file("fresh.ts", { status: "untracked" }),
        file("staged.ts", { staged: false, unstaged: true }),
      ],
    });
    expect(changedFilePaths(prev, next)).toEqual([
      "/repo/edited.ts",
      "/repo/fresh.ts",
      "/repo/staged.ts",
      "/repo/gone.ts",
    ]);
  });

  it("treats equal snapshots as unchanged and ignores the first load", () => {
    const snapshot = index({ files: [file("a.ts")] });
    expect(sameDiffIndex(null, snapshot)).toBe(false);
    expect(sameDiffIndex(snapshot, snapshot)).toBe(true);
    expect(sameDiffIndex(snapshot, index({ files: [file("a.ts")] }))).toBe(true);
    expect(sameDiffIndex(snapshot, index({ files: [file("a.ts", { deletions: 2 })] }))).toBe(false);
    expect(sameDiffIndex(snapshot, index({ files: [file("a.ts")], ahead: 1 }))).toBe(false);
    expect(sameDiffIndex(snapshot, index({ files: [file("a.ts")], headPushed: false }))).toBe(false);
  });
});

describe("empty list copy", () => {
  it("explains ahead, behind, diverged and clean states", () => {
    expect(syncStatusLabel(index({ ahead: 1, behind: 1 }))).toBe(
      "Diverged from origin/main",
    );
    expect(syncStatusLabel(index({ ahead: 1, upstream: null }))).toBe(
      "1 unpushed commit",
    );
    expect(syncStatusLabel(index({ ahead: 3 }))).toBe("3 unpushed commits");
    expect(syncStatusLabel(index({ behind: 2 }))).toBe("2 incoming commits");
    expect(syncStatusLabel(index({ behind: 1 }))).toBe("1 incoming commit");
    expect(syncStatusLabel(index())).toBe("没有文件");
  });
});
