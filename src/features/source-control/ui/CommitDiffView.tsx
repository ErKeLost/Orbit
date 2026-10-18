import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, Loader } from "../../../shared/ui/icons";
import {
  gitCommitFileDiff,
  gitCommitFiles,
  type GitChangedFile,
} from "../../../platform/tauri/fs";
import { useLazyFileDiffs } from "../hooks/useLazyFileDiffs";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "./UnifiedDiffView";

type Props = {
  cwd: string;
  sha: string;
};

/**
 * 单个历史提交的整版审阅：列出该提交触及的文件，并发的把每个文件的
 * unified diff 加载进同一个堆叠视图。数据通道是 git_commit_files /
 * git_commit_file_diff 两条 Tauri 命令。
 */
export function CommitDiffView({ cwd, sha }: Props) {
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cwd || cwd === "~" || !sha) {
      setFiles([]);
      return;
    }

    let disposed = false;
    let generation = 0;
    setFiles(null);

    const run = () => {
      const current = ++generation;
      void gitCommitFiles(cwd, sha)
        .then((listed) => {
          if (disposed || current !== generation) return;
          setFiles(listed);
              setError(null);

        })
        .catch((caught: unknown) => {
          if (disposed || current !== generation) return;
          setError(caught instanceof Error ? caught.message : String(caught));
          setFiles([]);
        });
    };

    run();
    return () => {
      disposed = true;
    };
  }, [cwd, sha]);

  const listedIds = useMemo(() => new Set(files?.map((file) => file.relative) ?? []), [files]);
  const loadFile = useCallback((id: string) => listedIds.has(id)
    ? gitCommitFileDiff(cwd, sha, id)
    : Promise.resolve(undefined), [cwd, sha, listedIds]);
  const { diffs, onFileVisibility } = useLazyFileDiffs(files, loadFile);

  const models = useMemo<UnifiedDiffFileModel[]>(() => {
    if (!files) return [];
    return files.map((file) => {
      const loaded = diffs.get(file.relative);
      const unified = loaded?.unified ?? null;
      return {
        id: file.relative,
        path: file.path,
        label: file.relative,
        binary: loaded?.binary,
        tooLarge: loaded?.tooLarge,
        emptyMessage:
          loaded == null
            ? "正在加载…"
            : loaded.error
              ? `无法加载差异：${loaded.error}`
              : unified != null && unified.additions === 0 && unified.deletions === 0 && !loaded.binary
                ? "没有文本差异"
                : undefined,
        additions: unified?.additions ?? file.additions,
        deletions: unified?.deletions ?? file.deletions,
        blocks: unified?.blocks ?? [],
      };
    });
  }, [diffs, files]);

  const totals = useMemo(
    () =>
      models.reduce(
        (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
      ),
    [models],
  );

  if (!cwd || cwd === "~") {
    return <p className="grid h-full place-items-center text-[13px] text-content/45">没有项目文件夹</p>;
  }
  if (error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <CircleAlert className="mx-auto mb-3 size-5 text-red-400" />
        <p className="text-[13px] text-content">无法加载提交</p>
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

  return <UnifiedDiffView files={models} totals={totals} onFileVisibility={onFileVisibility} />;
}
