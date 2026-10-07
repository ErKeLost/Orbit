import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { readTextFile } from "../../lib/git";
import { formatBytes, mediaKind, useMediaMeta, type MediaKind } from "../../lib/media";
import { FileHighlighter } from "../../components/FileHighlighter";
import { Markdown } from "../../components/Markdown";
import { splitMarkdownFrontmatter } from "../../shared/lib/markdownFrontmatter";
import { MarkdownViewShell, useMarkdownMode } from "../chat/MarkdownModeToggle";
import { ChevronDown, ChevronRight, ImagePlus, Loader } from "../../shared/ui/icons";
import { X } from "../../shared/ui/icons";
import { useLockOverscroll } from "../../shared/hooks/useLockOverscroll";
import { FileTypeIcon } from "./FileTypeIcon";
import { useShell, type OpenFile } from "./shellStore";

function MediaView({ file, kind }: { file: OpenFile; kind: MediaKind }) {
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

/** A read-only file pane in MonoCode's split layout; text renders on shiki. */
export function FileView({ file, cwd }: { file: OpenFile; cwd: string }) {
  const closeFile = useShell((state) => state.closeFile);
  const pinFile = useShell((state) => state.pinFile);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const kind = mediaKind(file.path);
  const markdown = isMarkdownPath(file.path);
  // Like MonoCode, markdown documents open as preview and remember the mode per file.
  const [mode, setMode] = useMarkdownMode(file.path, "preview");
  const contents = useQuery({
    queryKey: ["file", file.path],
    queryFn: () => readTextFile(file.path),
    enabled: kind == null,
    staleTime: 2000,
    refetchOnWindowFocus: true,
  });
  const relative = cwd && file.path.startsWith(cwd) ? file.path.slice(cwd.length).replace(/^\//, "") : file.path;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-stroke" aria-label={file.name}>
      <div className="flex h-9 shrink-0 select-none items-center gap-1.5 border-b border-stroke px-2">
        <div className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md bg-selection px-2" onDoubleClick={() => pinFile(file.path)}>
          <FileTypeIcon name={file.name} isDir={false} size={14} />
          <span className={`min-w-0 truncate text-[13px] text-content ${file.preview ? "italic" : ""}`}>{file.name}</span>
          <button type="button" title="关闭" aria-label={`关闭 ${file.name}`} onClick={() => closeFile(file.path)} className="grid size-5 shrink-0 place-items-center rounded text-content/50 hover:bg-content/10 hover:text-content">
            <X className="size-3" strokeWidth={1.75} />
          </button>
        </div>
      </div>
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
            <div className="h-full overflow-auto pt-10">
              <FileHighlighter code={contents.data} fileName={file.name} wrap />
            </div>
          }
        />
      ) : (
        <div ref={lockOverscroll} className="file-view min-h-0 flex-1 overflow-auto overscroll-none">
          {contents.isPending ? (
            <div className="grid h-full place-items-center text-content/40"><Loader className="size-4 animate-spin" /></div>
          ) : contents.isError ? (
            <p className="px-4 py-3 text-[12px] text-content/50">{String(contents.error)}</p>
          ) : (
            <FileHighlighter code={contents.data ?? ""} fileName={file.name} wrap />
          )}
        </div>
      )}
      <div className="flex h-7 shrink-0 items-center border-t border-stroke px-3 font-mono text-[11px] text-content/45">
        <span className="min-w-0 truncate">{relative}</span>
      </div>
    </section>
  );
}
