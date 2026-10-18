import type {
  GitChangedFile,
  GitDiffIndex,
  GitFileDiffKind,
} from "../../../platform/tauri/fs";

/** Tree-view nesting node; `path` is relative to the repo root, "" for the root. */
export type ChangeDir = {
  name: string;
  /** Path relative to the repo root; "" for the implicit root. */
  path: string;
  dirs: ChangeDir[];
  files: GitChangedFile[];
  /** Status shared by every descendant, or null when they differ. */
  status: string | null;
};

export type StagedChanges = {
  staged: GitChangedFile[];
  unstaged: GitChangedFile[];
};

/** Trailing path segment, normalizing Windows separators like the platform does. */
export function changeBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function changeDirname(relative: string): string {
  const index = relative.lastIndexOf("/");
  return index > 0 ? relative.slice(0, index) : "";
}

/** One-letter git status badge ("U", "A", "D", "M"). */
export function statusLetter(status: string): string {
  if (status === "untracked") return "U";
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

/** Tailwind text color for a git status badge. */
export function statusColor(status: string): string {
  if (status === "untracked") return "text-sky-400";
  if (status === "added") return "text-diff-add-fg";
  if (status === "deleted") return "text-diff-del-fg";
  return "text-amber-400";
}

/** True when the selected diff pane is showing this file in this section. */
export function isActiveChangeFile(
  file: GitChangedFile,
  selected: string | undefined,
  selectedKind: GitFileDiffKind | undefined,
  kind: GitFileDiffKind,
): boolean {
  return selected === file.relative && (!selectedKind || selectedKind === kind);
}

/** Splits the index file list into the two sections shown in the panel. */
export function splitByStage(files: GitChangedFile[]): StagedChanges {
  return {
    staged: files.filter((file) => file.staged),
    unstaged: files.filter((file) => file.unstaged),
  };
}

/** Files nested under a folder path, used to invalidate one folder mutation. */
export function filesUnderFolder(
  files: GitChangedFile[],
  relative: string,
): GitChangedFile[] {
  const prefix = `${relative}/`;
  return files.filter((file) => file.relative.startsWith(prefix));
}

/** Nests changed files under their directories, VS Code's tree view. */
export function buildChangeTree(files: GitChangedFile[]): ChangeDir {
  const root: ChangeDir = {
    name: "",
    path: "",
    dirs: [],
    files: [],
    status: null,
  };
  for (const file of files) {
    const segments = file.relative.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const path = node.path ? `${node.path}/${segment}` : segment;
      let next = node.dirs.find((dir) => dir.path === path);
      if (!next) {
        next = { name: segment, path, dirs: [], files: [], status: null };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  sortChangeDir(root);
  return root;
}

/** Sorts each level (folders first) and rolls descendant status upward. */
export function sortChangeDir(dir: ChangeDir): string | null {
  dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
  dir.files.sort((a, b) =>
    changeBasename(a.relative).localeCompare(changeBasename(b.relative)),
  );
  let status: string | null = null;
  let mixed = false;
  const merge = (next: string | null) => {
    if (next === null) mixed = true;
    else if (status === null) status = next;
    else if (status !== next) mixed = true;
  };
  for (const child of dir.dirs) merge(sortChangeDir(child));
  for (const file of dir.files) merge(file.status);
  dir.status = mixed ? null : status;
  return dir.status;
}

/** Paths whose content may have changed between two index snapshots. */
export function changedFilePaths(
  prev: GitDiffIndex,
  next: GitDiffIndex,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const previous = new Map(prev.files.map((file) => [file.relative, file]));
  const current = new Set(next.files.map((file) => file.relative));
  for (const file of next.files) {
    const before = previous.get(file.relative);
    if (
      !before ||
      before.status !== file.status ||
      before.additions !== file.additions ||
      before.deletions !== file.deletions ||
      before.staged !== file.staged ||
      before.unstaged !== file.unstaged
    ) {
      paths.push(file.path);
      seen.add(file.path);
    }
  }
  for (const file of prev.files) {
    if (!current.has(file.relative) && !seen.has(file.path)) {
      paths.push(file.path);
    }
  }
  return paths;
}

/** Whether two index snapshots are identical, so the poll can skip a re-render. */
export function sameDiffIndex(
  prev: GitDiffIndex | null,
  next: GitDiffIndex,
): boolean {
  if (!prev) return false;
  if (
    prev.branch !== next.branch ||
    prev.head !== next.head ||
    prev.additions !== next.additions ||
    prev.deletions !== next.deletions ||
    prev.files.length !== next.files.length ||
    prev.remote !== next.remote ||
    prev.upstream !== next.upstream ||
    prev.defaultBranch !== next.defaultBranch ||
    prev.ahead !== next.ahead ||
    prev.behind !== next.behind ||
    prev.aheadOfDefault !== next.aheadOfDefault ||
    prev.headPushed !== next.headPushed
  ) {
    return false;
  }
  return prev.files.every((file, i) => {
    const other = next.files[i];
    return (
      other &&
      file.relative === other.relative &&
      file.status === other.status &&
      file.additions === other.additions &&
      file.deletions === other.deletions &&
      file.staged === other.staged &&
      file.unstaged === other.unstaged
    );
  });
}

/** Empty-list copy that explains ahead/behind when nothing is modified. */
export function syncStatusLabel(index: GitDiffIndex): string {
  if (index.ahead > 0 && index.behind > 0) {
    return `Diverged from ${index.upstream ?? "upstream"}`;
  }
  if (index.ahead > 0) {
    const n = index.ahead;
    return `${n} unpushed commit${n === 1 ? "" : "s"}`;
  }
  if (index.behind > 0) {
    const n = index.behind;
    return `${n} incoming commit${n === 1 ? "" : "s"}`;
  }
  return "没有文件";
}
