import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, FileDiff, LoaderCircle } from "../../../shared/ui/icons";
import { buildUnifiedFile, type UnifiedLine } from "../model/unifiedDiff";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "./UnifiedDiffView";
import { gitFileDiff, type GitFileDiffKind } from "../../../platform/tauri/fs";
import { LAYER } from "../../../shared/lib/layers";

const KIND_LABEL: Record<GitFileDiffKind, string> = {
  staged: "已暂存 vs HEAD",
  unstaged: "工作区 vs HEAD",
};

function toModel(
  path: string,
  diff: { original: string; current: string; binary: boolean; tooLarge: boolean; status: string },
): UnifiedDiffFileModel {
  if (diff.binary || diff.tooLarge) {
    return {
      id: path,
      path,
      label: path,
      binary: diff.binary,
      emptyMessage: diff.binary
        ? "二进制文件，无法展示差异"
        : "文件过大，无法展示差异（可在编辑器中打开）",
      additions: 0,
      deletions: 0,
      blocks: [],
    };
  }
  const built = buildUnifiedFile(diff.original, diff.current);
  return {
    id: path,
    path,
    label: path,
    binary: false,
    additions: built.additions,
    deletions: built.deletions,
    blocks: built.blocks,
  };
}

/**
 * 变更面板的 diff 弹层：点变更文件看差异，而不是打开整个文件。
 *
 * 走既有的 `git_file_diff`（HEAD 与工作区各一份全文），本地算行级差异。
 * `onOpenInEditor` 保留原有的「在编辑器打开全文」路径。
 */
export function GitFileDiffModal({
  cwd,
  path,
  kind,
  onClose,
  onOpenInEditor,
}: {
  cwd: string;
  path: string;
  kind: GitFileDiffKind;
  onClose: () => void;
  onOpenInEditor?: (path: string, kind: GitFileDiffKind) => void;
}) {
  const query = useQuery({
    queryKey: ["git", "file-diff", cwd, path, kind],
    queryFn: () => gitFileDiff(cwd, path, kind),
    staleTime: 0,
    gcTime: 0,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const file = query.data;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4 sm:p-8"
      style={{ zIndex: LAYER.dialog }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="panel-surface relative flex h-full w-full max-w-5xl min-h-0 flex-col overflow-hidden rounded-xl border border-stroke shadow-2xl">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-stroke px-3">
          <FileDiff className="size-4 shrink-0 text-content/50" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">{path}</span>
          <span className="shrink-0 rounded-full bg-selection px-2 py-0.5 text-[10px] font-medium text-content/70">
            {KIND_LABEL[kind]}
          </span>
          {onOpenInEditor ? (
            <button
              type="button"
              onClick={() => {
                onOpenInEditor(path, kind);
                onClose();
              }}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] text-content/60 hover:bg-content/10 hover:text-content"
            >
              在编辑器打开
            </button>
          ) : null}
          <button
            type="button"
            title="关闭"
            aria-label="关闭差异视图"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-content/50 hover:bg-content/10 hover:text-content"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {query.isPending ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-16 text-content/50">
              <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
              <span className="text-[13px]">正在读取差异…</span>
            </div>
          ) : query.isError ? (
            <div className="flex flex-1 items-center justify-center py-16 text-[13px] text-danger">
              读取差异失败：{query.error instanceof Error ? query.error.message : String(query.error)}
            </div>
          ) : file ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <UnifiedDiffView
                files={[toModel(path, file)]}
                fill={false}
                fileLayout="cards"
                initialExpansion="all"
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// 统一行构造保留给未来扩展（例如展示行内词级差异）。
export type { UnifiedLine };
