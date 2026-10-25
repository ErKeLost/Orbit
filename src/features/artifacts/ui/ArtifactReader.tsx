import { useEffect, useRef, useState } from "react";
import { Copy, Trash, X } from "../../../shared/ui/icons";
import { artifactLabel, deleteArtifact } from "../artifacts";
import { ArtifactContent, useArtifact } from "./ArtifactContent";

/**
 * 一份产物的读者页：标题栏、正文、两个动作。
 *
 * 标题栏走 app 自己的 `PageHeader` 形状（关掉 + 名字 + 动作），所以它既能当整页
 * 也能当面板里的一层，不需要为容器再写一套。
 */
export function ArtifactReader({ id, onClose }: { id: string; onClose: () => void }) {
  const { artifact, loaded, error, setError } = useArtifact(id);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setCopied(false), [id]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  const label = artifact ? artifactLabel(artifact.kind) : "产物";

  async function onDelete() {
    if (!artifact || deleting) return;
    if (!window.confirm(`删除「${artifact.title}」？`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteArtifact(artifact.id);
      if (mounted.current) onClose();
    } catch {
      setError(`无法删除这个${label}。`);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-stroke px-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
          className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">
          {artifact?.title ?? label}
        </span>
        {artifact ? (
          <>
            <button
              type="button"
              disabled={deleting}
              onClick={() => void onDelete()}
              aria-label={`删除${label}`}
              title={`删除${label}`}
              className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
            >
              <Trash className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard?.writeText(artifact.body).then(
                  () => setCopied(true),
                  () => setError(`无法复制这个${label}。`),
                )
              }
              aria-label={copied ? "已复制" : `复制${label}`}
              title={copied ? "已复制" : `复制${label}`}
              className="grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
            >
              <Copy className="size-3.5" strokeWidth={1.75} />
            </button>
          </>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none px-4 py-3">
        {!loaded ? (
          <p role="status" className="text-[13px] text-content/50">读取中…</p>
        ) : error && !artifact ? (
          <p role="alert" className="text-[13px] text-content/65">{error}</p>
        ) : !artifact ? (
          <p role="status" className="text-[13px] text-content/50">这个产物已经不在了（会话里那条卡片来自一次没有落盘的保存）。</p>
        ) : (
          <article data-artifact-reader={artifact.id}>
            <ArtifactContent artifact={artifact} />
            {error ? (
              <p role="alert" className="mt-3 text-[12px] text-content/60">{error}</p>
            ) : null}
          </article>
        )}
      </div>
    </div>
  );
}
