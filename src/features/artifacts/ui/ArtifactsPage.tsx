import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChartBreakoutSquare, File, Loader, Plus, RefreshCw } from "../../../shared/ui/icons";
import { ARTIFACTS_CHANGED_EVENT, artifactLabel, listArtifacts, type Artifact } from "../artifacts";
import { ArtifactReader } from "./ArtifactReader";
import { subscribeArtifactOpen } from "./openArtifact";

/**
 * 所有产物的一页。
 *
 * monocode 里它们从对话里的卡片进；我们也支持那条路（`/gui-artifact`），但
 * 还需要一个「我有哪些东西」的地方——否则 create 之后就找不回来了。
 */
export function ArtifactsPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  // 对话里的卡片跳过来：挂载时先取走那一次点击，之后再跟着事件走。
  useEffect(() => subscribeArtifactOpen(setOpenId), []);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["artifacts"], queryFn: listArtifacts, staleTime: 5_000 });

  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ARTIFACTS_CHANGED_EVENT, refresh);
  }, [queryClient]);

  if (openId) return <ArtifactReader id={openId} onClose={() => setOpenId(null)} />;

  const artifacts = query.data ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-stroke px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">产物</span>
        <span className="shrink-0 text-[11px] tabular-nums text-content/40">{artifacts.length}</span>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          aria-label="重新读取"
          title="重新读取"
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          {query.isFetching ? <Loader className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" strokeWidth={1.75} />}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none p-2">
        {query.isPending ? (
          <p className="px-2 py-3 text-[12px] text-content/45">读取中…</p>
        ) : artifacts.length === 0 ? (
          <EmptyArtifacts />
        ) : (
          <ul className="flex flex-col gap-px">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <ArtifactRow artifact={artifact} onOpen={() => setOpenId(artifact.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArtifactRow({ artifact, onOpen }: { artifact: Artifact; onOpen: () => void }) {
  const Icon = artifact.kind === "html" ? ChartBreakoutSquare : File;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${artifact.title}\n${artifactLabel(artifact.kind)} · ${new Date(artifact.updatedAt).toLocaleString()}`}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-content/5"
    >
      <Icon className="size-4 shrink-0 text-content/55" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-content">{artifact.title}</span>
      <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-content/40">{artifactLabel(artifact.kind)}</span>
    </button>
  );
}

function EmptyArtifacts() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Plus className="size-6 text-content/20" strokeWidth={1.5} />
      <p className="text-[13px] text-content/60">还没有产物</p>
      <p className="max-w-xs text-[12px] leading-5 text-content/40">
        agent 用 <code className="font-mono text-content/60">/gui-artifact</code> 写一份文档或一页 HTML，就会出现在这里。
      </p>
    </div>
  );
}
