import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { readTextFile } from "../../lib/git";
import { onFilesInvalidated, watchFilePath } from "../files/model/fileWatch";
import { setDraftFor, useDrafts } from "../../lib/drafts";
import { saveFileDraft } from "../../lib/file-save";
import { CodeEditor } from "./CodeEditor";
import { useWorkspace } from "../../lib/store";
import { toast } from "../../shared/ui/toast";
import { formatBytes, mediaKind, useMediaMeta, type MediaKind } from "../../lib/media";
import { Markdown } from "../../components/Markdown";
import { splitMarkdownFrontmatter } from "../../shared/lib/markdownFrontmatter";
import { MarkdownViewShell, useMarkdownMode } from "../chat/MarkdownModeToggle";
import { ChevronDown, ChevronRight, ImagePlus, Loader } from "../../shared/ui/icons";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { SurfaceTabs } from "./SurfaceTabs";
import { useActiveWorkspace } from "./shellStore";

function MediaView({ file, kind }: { file: { path: string; name: string }; kind: MediaKind }) {
  const meta = useMediaMeta(file.path, kind);
  // The asset protocol streams the bytes; nothing is base64'd over IPC.
  const src = convertFileSrc(file.path);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-content/2 p-6">
      {kind === "image" ? (
        <button
          type="button"
          title="点击放大"
          onClick={(event) => {
            const img = event.currentTarget.querySelector("img");
            event.currentTarget.classList.toggle("p-0");
            img?.classList.toggle("max-h-full");
            img?.classList.toggle("max-h-[85vh]");
          }}
          className="cursor-zoom-in rounded-xl border border-content/10 bg-content/4 p-2"
        >
          <img src={src} alt={file.name} draggable={false} className="max-h-[60vh] max-w-full rounded-lg object-contain" />
        </button>
      ) : kind === "audio" ? (
        <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border border-content/10 bg-content/4 px-6 py-8">
          <ImagePlus className="size-8 text-content/25" strokeWidth={1.5} />
          <audio src={src} controls className="w-full" />
        </div>
      ) : kind === "video" ? (
        <video src={src} controls className="max-h-[70vh] max-w-full rounded-xl border border-content/10 bg-black" />
      ) : (
        <object data={src} type="application/pdf" className="h-full w-full rounded-xl border border-content/10">
          <p className="p-4 text-[13px] text-content/50">此浏览器无法内嵌预览 PDF。</p>
        </object>
      )}
      <p className="shrink-0 font-mono text-[11px] text-content/40">
        {file.name}
        {meta.data ? ` · ${meta.data.mime} · ${formatBytes(meta.data.size)}` : meta.isFetching ? " · 读取中…" : ""}
      </p>
    </div>
  );
}

/** MonoCode's `isMarkdownPath`: the extensions that open in preview mode. */
function isMarkdownPath(path: string): boolean {
  const extension = (path.split(".").pop() ?? "").toLowerCase();
  return extension === "md" || extension === "mdx" || extension === "markdown";
}

/** MonoCode's `MarkdownDocumentPreview`: rendered body with folded frontmatter. */
function MarkdownDocumentPreview({ text }: { text: string }) {
  const { metadata, body } = useMemo(() => splitMarkdownFrontmatter(text), [text]);
  return (
    <>
      {metadata !== null ? (
        <details className="group/metadata mb-6 rounded-lg border border-content/10 bg-content/[0.03]">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-content/60 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-content/50 group-open/metadata:hidden" strokeWidth={1.75} />
            <ChevronDown aria-hidden className="hidden size-3.5 shrink-0 text-content/50 group-open/metadata:block" strokeWidth={1.75} />
            属性
          </summary>
          <pre className="whitespace-pre-wrap break-words border-t border-stroke px-3 py-2 font-mono text-[12px] leading-5 text-content/70">{metadata}</pre>
        </details>
      ) : null}
      <Markdown content={body} />
    </>
  );
}

/** One editor pane: its tab strip (`SurfaceTabs`) above the focused file. */
export function FileView({
  paneId,
  cwd,
  showGrip,
  onPaneDragStart,
}: {
  paneId: string;
  cwd: string;
  showGrip: boolean;
  onPaneDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const pane = useActiveWorkspace((workspace) => workspace.panes[paneId]);
  const file = pane?.files.find((item) => item.path === pane.activeFile) ?? pane?.files[0] ?? null;
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const kind = file ? mediaKind(file.path) : null;
  const markdown = file ? isMarkdownPath(file.path) : false;
  // Like MonoCode, markdown documents open as preview and remember the mode per file.
  const [mode, setMode] = useMarkdownMode(file?.path ?? "", "preview");
  const [saving, setSaving] = useState(false);
  // The mobile shell has no ⌘S, so its save affordance lives in the footer and
  // only while there is something to save. The desktop edits and saves with the
  // keyboard alone.
  const remote = useWorkspace((state) => state.runtimeTarget) === "mobile";
  // Files open editable: typing *is* how a draft begins, and the draft — not the
  // editor component — holds the unsaved text until it is saved, which is what
  // makes closing a tab (or switching panes) safe.
  const draft = useDrafts((state) => (file ? state.drafts[file.path] : undefined));
  const dirty = draft !== undefined;
  const contents = useQuery({
    queryKey: ["file", file?.path ?? ""],
    queryFn: () => readTextFile(file?.path ?? ""),
    enabled: file != null && kind == null,
    staleTime: 2000,
    refetchOnWindowFocus: true,
  });
  const queryClient = useQueryClient();
  // 磁盘变更感知：Agent（或任何进程）改了正在显示的文件，轮询发现后重读。
  // 有未保存草稿时跳过——绝不能让磁盘版本覆盖用户正在打的内容。
  const watchPath = file != null && kind == null ? file.path : null;
  useEffect(() => {
    if (!watchPath) return;
    const stopWatching = watchFilePath(watchPath);
    const offInvalidated = onFilesInvalidated((paths) => {
      if (paths && !paths.includes(watchPath)) return;
      if (useDrafts.getState().drafts[watchPath] !== undefined) return;
      void queryClient.invalidateQueries({ queryKey: ["file", watchPath] });
    });
    return () => {
      stopWatching();
      offInvalidated();
    };
  }, [watchPath, queryClient]);
  if (!file) return null;
  const relative = cwd && file.path.startsWith(cwd) ? file.path.slice(cwd.length).replace(/^\//, "") : file.path;
  // Saving is silent: the tab dot disappearing and the text being on disk are
  // the answer. Only a failure is announced.
  async function save() {
    setSaving(true);
    try {
      await saveFileDraft(file!.path);
    } catch (error) {
      toast.error(String(error instanceof Error ? error.message : error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={file.name}>
      {/* MonoCode keeps a pane's tabs inside the pane (`FilePane` → `SurfaceTabs`),
          so the file name sits above the content it belongs to. */}
      <SurfaceTabs paneId={paneId} showGrip={showGrip} onPaneDragStart={onPaneDragStart} />
      {kind != null ? (
        <MediaView file={file} kind={kind} />
      ) : markdown && contents.data != null ? (
        <MarkdownViewShell
          mode={mode}
          onModeChange={setMode}
          preview={
            <div className="markdown-preview h-full overflow-auto px-5 pb-8 pt-12">
              <MarkdownDocumentPreview text={contents.data} />
            </div>
          }
          source={
            <CodeEditor
              key={`${file.path}:source`}
              value={draft ?? contents.data}
              fileName={file.name}
              onChange={(text) => setDraftFor(file.path, text)}
              onSave={() => void save()}
            />
          }
        />
      ) : (
        <div ref={lockOverscroll} className="file-view flex min-h-0 flex-1 flex-col overflow-hidden">
          {contents.isPending ? (
            <div className="grid h-full place-items-center text-content/40"><Loader className="size-4 animate-spin" /></div>
          ) : contents.isError ? (
            <p className="px-4 py-3 text-[12px] text-content/50">{String(contents.error)}</p>
          ) : (
            <CodeEditor
              key={file.path}
              value={draft ?? contents.data ?? ""}
              fileName={file.name}
              onChange={(text) => setDraftFor(file.path, text)}
              onSave={() => void save()}
            />
          )}
        </div>
      )}
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-stroke px-3 font-mono text-[11px] text-content/45">
        <span className="min-w-0 truncate">{relative}</span>
        {remote && dirty ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="ml-auto shrink-0 rounded-md bg-accent px-2.5 py-0.5 font-sans text-[11px] font-medium text-white disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
