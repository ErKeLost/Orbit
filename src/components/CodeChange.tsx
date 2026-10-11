import { useMemo } from "react";
import {
  blocksFromLines,
  buildUnifiedFile,
  type UnifiedLine,
} from "../features/source-control/model/unifiedDiff";
import { parsePrPatch } from "../features/source-control/model/prDiff";
import {
  UnifiedDiffView,
  type UnifiedDiffFileModel,
} from "../features/source-control/ui/UnifiedDiffView";
import { FileHighlighter } from "./FileHighlighter";
import type { Change } from "../lib/changes";

function modelsFromChange(change: Change): UnifiedDiffFileModel[] {
  if (change.kind === "file") return [];
  if (change.kind === "patch") {
    return parsePrPatch(change.patch).map((file) => ({
      id: file.path,
      path: file.path,
      label: file.path,
      binary: file.binary,
      emptyMessage:
        file.binary
          ? undefined
          : file.lines.length > 0 && file.additions + file.deletions === 0
            ? "没有差异"
            : undefined,
      additions: file.additions,
      deletions: file.deletions,
      blocks: file.binary ? [] : blocksFromLines(file.lines as UnifiedLine[]),
    }));
  }
  const built = buildUnifiedFile(change.before, change.after);
  return [
    {
      id: change.name,
      path: change.name,
      label: change.name,
      emptyMessage: built.additions + built.deletions === 0 && built.lines.length > 0 ? "没有差异" : undefined,
      additions: built.additions,
      deletions: built.deletions,
      blocks: built.blocks,
    },
  ];
}

function modelsKey(models: UnifiedDiffFileModel[]) {
  return models
    .map((model) => `${model.id}:${model.additions}:${model.deletions}:${model.blocks.length}`)
    .join("|");
}

/**
 * Chat 工具卡片里的 diff / 文件内容。
 *
 * Diff 渲染与源码管理面板同源：monocode 的 unified diff 模型 + 自家
 * `UnifiedDiffView`（shiki 高亮），不再依赖 @pierre/diffs。patch（可能是
 * 多文件）逐个解析成 UnifiedDiffFileModel；snippet 用前后文本现算 diff。
 */
export function CodeChange({ change, compact = false }: { change: Change; compact?: boolean; wrap?: boolean }) {
  const models = useMemo(() => modelsFromChange(change), [change]);
  const label = change.label ?? false;

  if (change.kind === "file") {
    return (
      <div className={`code-change${compact ? " is-compact" : ""}`}>
        {change.label !== false ? <div className="diff-toolbar">{change.label ?? change.name}</div> : null}
        <div className="max-h-[520px] overflow-auto p-3">
          <FileHighlighter code={change.contents} fileName={change.name} wrap />
        </div>
      </div>
    );
  }

  if (models.length === 0) {
    const fallback = change.kind === "patch" ? change.patch : change.after;
    return (
      <div className={`code-change${compact ? " is-compact" : ""}`}>
        {label ? <div className="diff-toolbar"><span className="min-w-0 truncate">{label}</span></div> : null}
        <pre className="diff-loading-fallback">{fallback}</pre>
      </div>
    );
  }

  return (
    <div className={`code-change${compact ? " is-compact" : ""}`}>
      {label ? <div className="diff-toolbar"><span className="min-w-0 truncate">{label}</span></div> : null}
      <div className="unified-diff-embed max-h-[520px] overflow-y-auto overscroll-none">
        <UnifiedDiffView key={modelsKey(models)} files={models} fill={false} initialExpansion="all" />
      </div>
    </div>
  );
}
