import { useEffect, useState } from "react";
import { GitBranch, Loader, Undo, X } from "../../shared/ui/icons";
import { buildUnifiedFile } from "../source-control/model/unifiedDiff";
import { gitCheckpointDiff, type CheckpointFileDiff } from "../../lib/git";
import { UnifiedDiffView, type UnifiedDiffFileModel } from "../source-control/ui/UnifiedDiffView";
import {
  keepCheckpoint,
  useLatestPendingCheckpoint,
  undoCheckpoint,
  type TurnCheckpoint,
} from "../source-control/model/checkpoints";

/**
 * 回合检查点横幅：一轮对话结束后若改了文件，在 composer 上方提示
 * 「查看 diff / 撤销 / 保留」，对应 monocode 的 keep / undo controls。
 */
export function CheckpointBanner({ sessionFile }: { sessionFile: string | null }) {
  const pending = useLatestPendingCheckpoint(sessionFile);
  const [open, setOpen] = useState<TurnCheckpoint | null>(null);
  const latest = pending;
  if (!latest || open === latest) return null;
  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-stroke px-3 text-[12px]">
        <GitBranch className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-content/70">
          上一轮改动了文件，已生成检查点
          <span className="ml-1.5 text-content/40">{new Date(latest.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </span>
        <button
          type="button"
          onClick={() => setOpen(latest)}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-content/70 hover:bg-content/10 hover:text-content"
        >
          查看 diff
        </button>
        <button
          type="button"
          onClick={() => void undoCheckpoint(latest)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-content/70 hover:bg-content/10 hover:text-content"
        >
          <Undo className="size-3.5" strokeWidth={1.75} />
          撤销
        </button>
        <button
          type="button"
          title="保留改动，关闭提示"
          aria-label="保留改动"
          onClick={() => keepCheckpoint(latest)}
          className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {open ? <CheckpointDiffDialog checkpoint={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function CheckpointDiffDialog({ checkpoint, onClose }: { checkpoint: TurnCheckpoint; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="本轮改动"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full max-h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-content/10 bg-background-base shadow-2xl">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-stroke px-3">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">本轮改动 · 检查点</span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await undoCheckpoint(checkpoint);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
            className="flex shrink-0 items-center gap-1 rounded-md bg-content/10 px-2.5 py-1 text-[12px] text-content hover:bg-content/15 disabled:opacity-50"
          >
            <Undo className="size-3.5" strokeWidth={1.75} />
            撤销本轮
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              keepCheckpoint(checkpoint);
              onClose();
            }}
            className="shrink-0 rounded-md bg-content/10 px-2.5 py-1 text-[12px] text-content hover:bg-content/15 disabled:opacity-50"
          >
            保留
          </button>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </header>
        <CheckpointDiffBody checkpoint={checkpoint} />
      </div>
    </div>
  );
}

/** 两个 tree 之间的差异，复用 unified diff 视图（shiki 高亮）。 */
function CheckpointDiffBody({ checkpoint }: { checkpoint: TurnCheckpoint }) {
  const [state, setState] = useState<{ files: UnifiedDiffFileModel[]; error: string | null; loading: boolean }>({
    files: [],
    error: null,
    loading: true,
  });
  const before = checkpoint.before;
  const after = checkpoint.after ?? checkpoint.before;

  useEffect(() => {
    let active = true;
    setState({ files: [], error: null, loading: true });
    gitCheckpointDiff(checkpoint.cwd, before, after)
      .then((diffs: CheckpointFileDiff[]) => {
        if (!active) return;
        setState(
          {
            files: diffs.map((file) => {
              const unified = buildUnifiedFile(file.original, file.current);
              return {
                id: file.relative,
                path: file.path,
                label: file.relative,
                binary: file.binary,
                tooLarge: file.too_large,
                additions: unified.additions,
                deletions: unified.deletions,
                blocks: unified.blocks,
              };
            }),
            error: null,
            loading: false,
          },
        );
      })
      .catch((error: unknown) => {
        if (active) setState({ files: [], error: error instanceof Error ? error.message : String(error), loading: false });
      });
    return () => {
      active = false;
    };
  }, [after, before, checkpoint.cwd]);

  const totals = state.files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );

  if (state.loading) {
    return (
      <div className="grid flex-1 place-items-center text-content/40">
        <Loader className="size-4 animate-spin" />
      </div>
    );
  }
  if (state.error) {
    return <p className="grid flex-1 place-items-center px-6 text-center text-[13px] text-content/55">{state.error}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <UnifiedDiffView files={state.files} totals={totals} />
    </div>
  );
}
