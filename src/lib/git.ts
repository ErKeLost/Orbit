import { invoke } from "./native";
import { useQuery } from "@tanstack/react-query";
import { useWorkspace } from "./store";
import { usePageVisible } from "./page-visibility";

export type GitDiffStats = { files: number; additions: number; deletions: number };
export type GitChangedFile = { path: string; status: "M" | "A" | "D" | "U"; additions: number; deletions: number };
export type GitBranchEntry = { name: string; current: boolean; remote: string | null };
export type GitBranches = { current: string | null; detached: boolean; branches: GitBranchEntry[] };
/** One listing row. `size` is 0 for folders; `mtimeMs` is 0 when unknown. */
export type DirEntry = { name: string; path: string; isDir: boolean; ignored: boolean; size: number; mtimeMs: number };

/**
 * Whether a workspace backend exists at all.
 *
 * Git data comes from the machine that owns the workspace: the local backend on
 * the desktop, or the desktop over the paired socket on a phone (`native.ts`
 * routes it). Only the browser preview has no backend, and asking it for a
 * diff would be a request to nothing.
 */
function hasWorkspaceBackend() {
  const target = useWorkspace.getState().runtimeTarget;
  return target === "desktop" || target === "mobile";
}

export const gitDiffStats = (cwd: string) => invoke<GitDiffStats>("git_diff_stats", { cwd });
export const gitChangedFiles = (cwd: string) => invoke<GitChangedFile[]>("git_changed_files", { cwd });

export const gitBranches = (cwd: string) => invoke<GitBranches>("git_branches", { cwd });
export const gitCheckout = (cwd: string, name: string, remote?: string | null) =>
  invoke<string>("git_checkout", { cwd, name, remote: remote ?? null });
export const gitCreateBranch = (cwd: string, name: string) => invoke<string>("git_create_branch", { cwd, name });
export const listDir = (path: string) => invoke<DirEntry[]>("list_dir", { path });
export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });
/** Write a text file, creating missing parent directories. */
export const writeTextFile = (path: string, contents: string) => invoke<void>("write_text_file", { path, contents });
export const createDir = (path: string) => invoke<void>("create_dir", { path });
/** Move or rename; a destination that already exists is refused. */
export const renamePath = (from: string, to: string) => invoke<void>("rename_path", { from, to });
export const deletePath = (path: string) => invoke<void>("delete_path", { path });

/** Uncommitted +/- for a folder, refreshed like Orbit's project cards. */
export function useGitDiffStats(cwd: string | undefined, enabled = true) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: ["git", "diff-stats", cwd],
    queryFn: () => gitDiffStats(cwd!),
    enabled: Boolean(cwd) && enabled && hasWorkspaceBackend(),
    refetchInterval: visible ? 5000 : false,
    staleTime: 2000,
  });
}

export function useGitChangedFiles(cwd: string | undefined, enabled = true) {
  const visible = usePageVisible();
  return useQuery({
    queryKey: ["git", "changed-files", cwd],
    queryFn: () => gitChangedFiles(cwd!),
    enabled: Boolean(cwd) && enabled && hasWorkspaceBackend(),
    refetchInterval: visible ? 5000 : false,
    staleTime: 2000,
  });
}

export function useGitBranches(cwd: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["git", "branches", cwd],
    queryFn: () => gitBranches(cwd!),
    enabled: Boolean(cwd) && enabled && hasWorkspaceBackend(),
    staleTime: 3000,
  });
}

/* ------------------------------ 回合检查点 ------------------------------ */

export type CheckpointFileDiff = {
  path: string;
  relative: string;
  status: string;
  original: string;
  current: string;
  binary: boolean;
  too_large: boolean;
};

/** 把当前工作区（含未跟踪）捕获成 tree sha；不动暂存区与工作区。 */
export function gitCheckpointCapture(cwd: string): Promise<string> {
  return invoke<string>("git_checkpoint_capture", { cwd });
}

export function gitCheckpointDiff(cwd: string, from: string, to: string): Promise<CheckpointFileDiff[]> {
  return invoke<CheckpointFileDiff[]>("git_checkpoint_diff", { cwd, from, to });
}

/** 撤销 = 工作区恢复到检查点；会覆盖当前未提交改动，调用方先确认。 */
export function gitCheckpointRestore(cwd: string, tree: string): Promise<void> {
  return invoke<void>("git_checkpoint_restore", { cwd, tree });
}
