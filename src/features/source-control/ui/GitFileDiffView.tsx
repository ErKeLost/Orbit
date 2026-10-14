import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { FileDiff, LoaderCircle } from "../../../shared/ui/icons";
import { gitFileDiff, type GitFileDiffKind } from "../../../platform/tauri/fs";
import { buildUnifiedFileAsync } from "../model/asyncUnifiedDiff";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "./UnifiedDiffView";

/**
 * 变更标签页的内容：用应用自己的 `UnifiedDiffView`（主题化的绿/红行、
 * 行号、+/− 标记）展示一份文件的 diff。它就是编辑器面板里的一个标签页，
 * 与文件标签共享同一套三栏布局。
 */
export function GitFileDiffView({ cwd, path, kind }: { cwd: string; path: string; kind: GitFileDiffKind }) {
  const root = cwd.replace(/\/+$/, "");
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

  const query = useQuery({
    queryKey: ["git", "file-diff", cwd, relative, kind],
    queryFn: async ({ signal }) => {
      const file = await gitFileDiff(cwd, relative, kind);
      const built = file.binary || file.tooLarge ? null : await buildUnifiedFileAsync(file.original, file.current, signal);
      return { binary: file.binary, tooLarge: file.tooLarge, built };
    },
    staleTime: 0,
    gcTime: 0,
  });

  const file = query.data;
  const model = useMemo<UnifiedDiffFileModel | null>(() => {
    if (!file) return null;
    const built = file.built;
    return {
      id: relative,
      path: relative,
      label: relative,
      binary: file.binary,
      tooLarge: file.tooLarge,
      emptyMessage:
        !file.binary && !file.tooLarge && built != null && built.lines.length > 0 && built.additions + built.deletions === 0
          ? "没有差异"
          : undefined,
      additions: built?.additions ?? 0,
      deletions: built?.deletions ?? 0,
      blocks: built?.blocks ?? [],
    };
  }, [file, relative]);

  if (query.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-content/50">
        <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
        <span className="text-[13px]">正在读取差异…</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[13px] text-danger">
        读取差异失败：{query.error instanceof Error ? query.error.message : String(query.error)}
      </div>
    );
  }
  if (!model) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-9 shrink-0 select-none items-center gap-2 border-b border-stroke px-3">
        <FileDiff className="size-4 shrink-0 text-content/50" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-content/85" title={relative}>
          <span className="text-content/45">{relative.slice(0, Math.max(0, relative.length - basename(relative).length))}</span>
          {basename(relative)}
        </span>
      </header>
      <UnifiedDiffView key={`${relative}:${kind}`} files={[model]} />
    </div>
  );
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
