import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader } from "../../../shared/ui/icons";
import {
  gitDiffIndex,
  gitDiscardFile,
  gitFileDiff,
  gitStageFile,
  notifyGitChanged,
  subscribeGitChanged,
  type GitFileDiffKind,
} from "../../../platform/tauri/fs";
import { forEachConcurrent } from "../../../shared/lib/concurrent";
import { buildUnifiedFile, type UnifiedFileDiff } from "../model/unifiedDiff";
import {
  prioritizeWorkingTreeDiffEntries,
  workingTreeDiffEntries,
  workingTreeDiffEntryLabel,
  workingTreeDiffFocusId,
} from "../model/workingTreeDiff";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "./UnifiedDiffView";

type Props = {
  cwd: string;
  focusPath?: string;
  focusKind?: GitFileDiffKind;
};

type LoadedDiff = {
  binary: boolean;
  tooLarge: boolean;
  unified: UnifiedFileDiff | null;
  error?: string;
};

const DIFF_LOAD_CONCURRENCY = 4;

/**
 * 工作区变更的整版审阅：把某一侧（已暂存 / 未暂存，或不指定）的全部文件
 * 堆在一个 unified diff 里。与源码管理侧栏共享数据通道（gitDiffIndex +
 * gitFileDiff），文件级的暂存 / 放弃直接复用侧栏的命令。
 */
export function WorkingTreeDiffView({ cwd, focusPath, focusKind }: Props) {
  const [files, setFiles] = useState<Awaited<ReturnType<typeof gitDiffIndex>> | null>(null);
  const [diffs, setDiffs] = useState<Map<string, LoadedDiff>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd || cwd === "~") {
      setFiles(null);
      setDiffs(new Map());
      return;
    }

    let disposed = false;
    let generation = 0;

    const run = () => {
      const current = ++generation;
      setDiffs(new Map());
      void gitDiffIndex(cwd)
        .then(async (index) => {
          if (disposed || current !== generation) return;
          setFiles(index);
          setError(null);
          const entries = workingTreeDiffEntries(index.files, focusKind);
          const loadOrder = prioritizeWorkingTreeDiffEntries(entries, focusPath, focusKind);
          await forEachConcurrent(
            loadOrder,
            DIFF_LOAD_CONCURRENCY,
            async (entry) => {
              let loaded: LoadedDiff;
              try {
                const diff = await gitFileDiff(cwd, entry.file.relative, entry.kind);
                const unified = !diff.binary && !diff.tooLarge ? buildUnifiedFile(diff.original, diff.current) : null;
                loaded = { binary: diff.binary, tooLarge: diff.tooLarge, unified };
              } catch (caught: unknown) {
                loaded = {
                  binary: false,
                  tooLarge: false,
                  unified: null,
                  error: caught instanceof Error ? caught.message : String(caught),
                };
              }
              if (disposed || current !== generation) return;
              setDiffs((existing) => {
                const next = new Map(existing);
                next.set(entry.id, loaded);
                return next;
              });
            },
            () => !disposed && current === generation,
          );
        })
        .catch((caught: unknown) => {
          if (disposed || current !== generation) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          setFiles(null);
        });
    };

    run();
    let refreshFrame = 0;
    const scheduleRun = () => {
      if (refreshFrame) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = 0;
        run();
      });
    };
    const unsub = subscribeGitChanged(scheduleRun);
    const onFocus = () => {
      if (!document.hidden) scheduleRun();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      disposed = true;
      if (refreshFrame) window.cancelAnimationFrame(refreshFrame);
      unsub();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [cwd, focusKind]);

  // 从「变更」或「已暂存」一节打开的审阅只显示该侧。
  const entries = useMemo(
    () => workingTreeDiffEntries(files?.files ?? [], focusKind),
    [files, focusKind],
  );

  const models = useMemo<UnifiedDiffFileModel[]>(() => {
    if (!files) return [];
    return entries.map((entry) => {
      const { file, kind } = entry;
      const loaded = diffs.get(entry.id);
      const unified = loaded?.unified ?? null;
      const unchanged = unified != null && unified.additions === 0 && unified.deletions === 0 && !loaded?.binary;
      const canUseIndexCounts = loaded != null && !loaded.error && !(file.staged && file.unstaged);
      return {
        id: entry.id,
        path: file.path,
        label: workingTreeDiffEntryLabel(entry),
        binary: loaded?.binary,
        tooLarge: loaded?.tooLarge,
        emptyMessage:
          loaded == null
            ? "正在加载…"
            : loaded.error
              ? `无法加载差异：${loaded.error}`
              : unchanged
                ? kind === "staged"
                  ? "没有已暂存的更改"
                  : "没有未暂存的更改"
                : undefined,
        additions: unified?.additions ?? (canUseIndexCounts ? file.additions : 0),
        deletions: unified?.deletions ?? (canUseIndexCounts ? file.deletions : 0),
        blocks: unchanged ? [] : (unified?.blocks ?? []),
        canStage: kind === "unstaged",
        canDiscard: kind === "unstaged",
      };
    });
  }, [diffs, entries, files]);

  const totals = useMemo(
    () =>
      models.reduce(
        (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    [models],
  );

  const focusId = useMemo(
    () => workingTreeDiffFocusId(entries, focusPath, focusKind),
    [entries, focusKind, focusPath],
  );

  const onStageFile = useCallback(
    async (id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.kind !== "unstaged") return;
      setBusyId(id);
      try {
        await gitStageFile(cwd, entry.file.relative);
        notifyGitChanged();
      } finally {
        setBusyId(null);
      }
    },
    [cwd, entries],
  );

  const onDiscardFile = useCallback(
    async (id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.kind !== "unstaged") return;
      setBusyId(id);
      try {
        await gitDiscardFile(cwd, entry.file.relative);
        notifyGitChanged();
      } finally {
        setBusyId(null);
      }
    },
    [cwd, entries],
  );

  if (!cwd || cwd === "~") {
    return <p className="grid h-full place-items-center text-[13px] text-content/45">没有项目文件夹</p>;
  }
  if (error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <AlertCircle className="mx-auto mb-3 size-5 text-red-400" />
        <p className="text-[13px] text-content">无法加载变更</p>
        <p className="mt-1 text-[12px] text-content/50">{error}</p>
      </div>
    );
  }
  if (files == null) {
    return (
      <div className="grid h-full place-items-center text-content/40">
        <Loader className="size-4 animate-spin" strokeWidth={1.75} />
      </div>
    );
  }

  return (
    <UnifiedDiffView
      files={models}
      fileCount={focusKind ? entries.length : files.files.length}
      focusId={focusId}
      busyId={busyId}
      totals={totals}
      onStageFile={onStageFile}
      onDiscardFile={onDiscardFile}
    />
  );
}
