import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { readTextFile } from "../../../lib/git";
import { onFilesInvalidated, watchFilePath } from "../../files/model/fileWatch";
import { setDraftFor, useDrafts } from "../../../lib/drafts";
import { saveFileDraft } from "../../../lib/file-save";
import { useWorkspace } from "../../../lib/store";
import { toast } from "../../../shared/ui/toast";
import { formatBytes, mediaKind, readMediaFile, useMediaMeta, type MediaKind } from "../../../lib/media";
import { base64ToBytes, planMediaPreview } from "../../../lib/media-preview";
import { Markdown } from "../../../components/Markdown";
import { splitMarkdownFrontmatter } from "../../../shared/lib/markdownFrontmatter";
import { mdxToMarkdown } from "../../../shared/lib/mdxLite";
import { MarkdownViewShell, useMarkdownMode } from "../../chat/MarkdownModeToggle";
import { ChevronDown, ChevronRight, ImagePlus, Loader, Pause, Play } from "../../../shared/ui/icons";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { SurfaceTabs } from "../tabs/SurfaceTabs";
import { BrowserTab } from "../../browser/BrowserTab";
import { useActiveWorkspace, useShell } from "../shellStore";
import { DirectoryView } from "./DirectoryView";
import { usePathMeta } from "../../../lib/path-meta";
import { GitFileDiffView } from "../../source-control/ui/GitFileDiffView";
import { CommitDiffView } from "../../source-control/ui/CommitDiffView";
import { WorkingTreeDiffView } from "../../source-control/ui/WorkingTreeDiffView";

/** CodeMirror 全家桶只在真的打开文件编辑时才加载，不进首屏 chunk。 */
const CodeEditor = lazy(() => import("../editor/CodeEditor").then((m) => ({ default: m.CodeEditor })));
const EditorFallback = (
  <div className="grid h-full place-items-center text-content/40">
    <Loader className="size-4 animate-spin" />
  </div>
);
/** Refusing to preview, or a fetch that failed: the same shape either way. */
/**
 * 视频预览（monocode 0.12 的增强集）：原生控制条 + 尺寸/时长/大小/格式元信息，
 * 标签页或窗口隐藏时自动暂停，关闭时释放 src。
 */
function VideoPlayer({ src, path, mimeType }: { src: string; path: string; mimeType?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [meta, setMeta] = useState<{ width: number; height: number; duration: number } | null>(null);
  const stat = usePathMeta(path, true);
  const ext = (path.split(".").pop() ?? "").toUpperCase();

  // 页面或标签页不可见时暂停，回到前台不自动重播（不打扰）。
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const pause = () => video.pause();
    document.addEventListener("visibilitychange", pause);
    window.addEventListener("blur", pause);
    return () => {
      document.removeEventListener("visibilitychange", pause);
      window.removeEventListener("blur", pause);
    };
  }, []);

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return "–:––";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const sizeLabel = stat.data?.size ? formatBytes(stat.data.size) : null;
  const format = (mimeType?.split("/")[1] ?? (ext || "video")).replace("quicktime", "mov").toUpperCase();

  return (
    <div className="flex max-h-full max-w-full flex-col items-center gap-2">
      <video
        ref={videoRef}
        src={src}
        controls
        playsInline
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setMeta({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
        }}
        className="max-h-[64vh] max-w-full rounded-xl border border-content/10 bg-black"
      />
      <p className="shrink-0 font-mono text-[11px] text-content/45">
        {meta ? `${meta.width}×${meta.height} · ` : ""}
        {meta ? `${formatTime(meta.duration)} · ` : ""}
        {[format, sizeLabel].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

function MediaNotice({ message, path }: { message: string; path: string }) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-xl border border-content/10 bg-content/4 px-6 py-8 text-center">
      <ImagePlus className="size-8 text-content/25" strokeWidth={1.5} />
      <p className="text-[13px] leading-5 text-content/70">{message}</p>
      <p className="break-all font-mono text-[11px] leading-4 text-content/40">{path}</p>
    </div>
  );
}

function formatAudioTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** A compact player that keeps the file preview in Orbit's visual language. */
function AudioPlayer({ src, name, mime, size }: { src: string; name: string; mime?: string; size?: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
  }, [src]);

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setPlaying(true);
      } catch {
        setError("音频无法播放，请检查文件格式或编码");
      }
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-content/10 bg-content/[0.045] shadow-[0_18px_60px_color-mix(in_srgb,var(--color-content)_8%,transparent)]">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTime(0); }}
        onError={() => setError("音频无法加载，请检查文件格式或文件是否完整")}
        className="hidden"
      />
      <div className="flex items-center gap-4 px-5 py-5">
        <div className="relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-accent/80 via-accent/35 to-content/10 text-content shadow-inner">
          <span className="absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_30%_20%,white_0,transparent_55%)]" />
          <span className="relative text-3xl font-serif leading-none">♪</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-content" title={name}>{name}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-content/40">{[mime?.split("/").at(-1)?.toUpperCase(), size == null ? null : formatBytes(size)].filter(Boolean).join(" · ")}</p>
          <div className="mt-4 flex items-center gap-2">
            <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular-nums text-content/45">{formatAudioTime(time)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.01}
              value={Math.min(time, duration || 0)}
              aria-label="音频进度"
              onChange={(event) => {
                const next = Number(event.target.value);
                if (audioRef.current) audioRef.current.currentTime = next;
                setTime(next);
              }}
              className="audio-progress h-1.5 min-w-0 flex-1 accent-[var(--color-accent)]"
            />
            <span className="w-9 shrink-0 font-mono text-[10px] tabular-nums text-content/45">{formatAudioTime(duration)}</span>
          </div>
        </div>
        <button type="button" onClick={() => void toggle()} aria-label={playing ? "暂停音频" : "播放音频"} className="grid size-10 shrink-0 place-items-center rounded-full bg-content text-background-base transition-transform hover:scale-105 active:scale-95">
          {playing ? <Pause className="size-4" strokeWidth={2} /> : <Play className="size-4 translate-x-px" strokeWidth={2} />}
        </button>
      </div>
      {error ? <p className="border-t border-content/10 px-5 py-2.5 text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}

/**
 * One object URL per payload, revoked when it is replaced or the view goes away.
 *
 * The bytes arrive as base64 because the wire has no binary frame small enough
 * to be worth one; a `Blob` is what `<img>`/`<video>`/`<embed>` can actually
 * point at. An object URL pins its bytes for as long as the document lives, and
 * a phone has nowhere to put them, so the revocation is not optional.
 */
function useMediaObjectUrl(payload: { mime: string; data: string } | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (payload === undefined) return;
    const next = URL.createObjectURL(new Blob([base64ToBytes(payload.data)], { type: payload.mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [payload]);
  return url;
}

function MediaView({ file, kind, remote }: { file: { path: string; name: string }; kind: MediaKind; remote: boolean }) {
  const meta = useMediaMeta(file.path, kind);
  // The asset protocol is "this webview reads this machine's disk", so it is the
  // whole answer on the desktop and no answer at all on a phone; the phone takes
  // the bytes over the pairing socket instead. See `lib/media-preview.ts`.
  const plan = planMediaPreview({ remote, kind, size: meta.data?.size ?? null });
  const bytes = useQuery({
    queryKey: ["media-bytes", file.path],
    queryFn: () => readMediaFile(file.path),
    enabled: plan.mode === "socket",
    staleTime: 30_000,
  });
  // Unconditional, like every hook here: `plan` moves from `socket` to
  // `blocked` when `media_meta` answers, so a hook call that followed it would
  // change the hook order between renders.
  const objectUrl = useMediaObjectUrl(bytes.data);
  const src = plan.mode === "asset" ? convertFileSrc(file.path) : objectUrl;
  const notice =
    plan.mode === "blocked" ? plan.message
    : bytes.isError ? String(bytes.error)
    : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-content/2 p-6">
      {notice !== null ? (
        <MediaNotice message={notice} path={file.path} />
      ) : src == null ? (
        <Loader className="size-5 animate-spin text-content/30" />
      ) : kind === "image" ? (
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
        <AudioPlayer src={src} name={file.name} mime={meta.data?.mime} size={meta.data?.size} />
      ) : kind === "video" ? (
        <VideoPlayer src={src} path={file.path} mimeType={meta.data?.mime} />
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

/**
 * A path that is not there any more — a chat link to something since moved, a
 * tab restored after a `git clean`. Saying so is the whole job; `read_text_file`
 * used to answer this case with a raw `No such file or directory (os error 2)`.
 */
function MissingFileNotice({ path }: { path: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <ImagePlus className="size-8 text-content/20" strokeWidth={1.5} />
      <p className="text-[13px] text-content/60">文件不存在</p>
      <p className="max-w-md break-all font-mono text-[11px] leading-4 text-content/35">{path}</p>
    </div>
  );
}

/** Orbit's `isMarkdownPath`: the extensions that open in preview mode. */
function isMarkdownPath(path: string): boolean {
  const extension = (path.split(".").pop() ?? "").toLowerCase();
  return extension === "md" || extension === "mdx" || extension === "markdown";
}

/** Orbit's `MarkdownDocumentPreview`: rendered body with folded frontmatter. */
function MarkdownDocumentPreview({ text }: { text: string }) {
  const { metadata, body } = useMemo(() => splitMarkdownFrontmatter(text), [text]);
  // docs 站点存档是 MDX：<Tip>/<Frame>/<img> 会被渲染器按字面打印，先折叠成
  // 等价 markdown（纯 markdown 原样通过，聊天流不经过这里）。
  const markdown = useMemo(() => mdxToMarkdown(body), [body]);
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
      <Markdown content={markdown} />
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
  // A browser tab's content is a real web view, not a file to read.
  const browser = file?.browser ? file : null;
  // 审阅标签页（单文件 diff、整版变更、历史提交）都是合成路径，后面没有
  // 真实文件，磁盘相关的 stat / 读取 / 监听全部跳过。
  const review = file != null && (file.diff != null || file.changes != null || file.commit != null);
  // A diff tab is a read-only view of a working-tree comparison, not a file.
  const diff = file?.diff;
  const kind = file && !review ? mediaKind(file.path) : null;
  // 目录不是「恰好没有扩展名的媒体」：扩展名里根本没有这个信息，只有 stat 有。
  // 所以每一条路径都问一次磁盘，同时接受标签页带过来的答案（树本来就知道那是
  // 文件夹），磁盘仍然是否决权更高的那个。
  //
  // 顺序是刻意的：不阻塞地先发一次文本读取，让常见情况（打开源码文件）不必等
  // 一次往返；只有目录会白跑那一趟，而目录本来就不常从聊天里的路径块打开。
  const stat = usePathMeta(file && !review ? file.path : null, !review);
  const isDirectory = stat.data?.isDir ?? file?.isDir ?? false;
  const missing = stat.isSuccess && stat.data === null;
  // 只对真正的文件读文本：目录读下去只会得到 `EISDIR (os error 21)`。
  const textEnabled = file != null && !review && kind == null && !isDirectory;
  const markdown = file ? isMarkdownPath(file.path) : false;
  // Like Orbit, markdown documents open as preview and remember the mode per file.
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
  const openFile = useShell((state) => state.openFile);
  const contents = useQuery({
    queryKey: ["file", file?.path ?? ""],
    queryFn: () => readTextFile(file?.path ?? ""),
    enabled: textEnabled,
    staleTime: 2000,
    refetchOnWindowFocus: true,
  });
  const queryClient = useQueryClient();
  // 磁盘变更感知：Agent（或任何进程）改了正在显示的文件，轮询发现后重读。
  // 有未保存草稿时跳过——绝不能让磁盘版本覆盖用户正在打的内容。
  const watchPath = textEnabled ? file?.path ?? null : null;
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
      {/* Orbit keeps a pane's tabs inside the pane (`FilePane` → `SurfaceTabs`),
          so the file name sits above the content it belongs to. */}
      <SurfaceTabs paneId={paneId} showGrip={showGrip} onPaneDragStart={onPaneDragStart} />
      {browser ? (
        <BrowserTab paneId={paneId} path={browser.path} />
      ) : file?.commit ? (
        <CommitDiffView cwd={cwd} sha={file.commit.sha} />
      ) : file?.changes && file.diff ? (
        <WorkingTreeDiffView cwd={cwd} focusKind={file.diff} />
      ) : diff ? (
        <GitFileDiffView cwd={cwd} path={file.path} kind={diff} />
      ) : isDirectory ? (
        <DirectoryView
          path={file.path}
          cwd={cwd}
          remote={remote}
          onOpen={(path, isDir) => openFile(path, { pin: true, isDir })}
        />
      ) : missing ? (
        <MissingFileNotice path={file.path} />
      ) : kind != null ? (
        <MediaView file={file} kind={kind} remote={remote} />
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
            <Suspense fallback={EditorFallback}>
              <CodeEditor
                key={`${file.path}:source`}
                value={draft ?? contents.data}
                fileName={file.name}
                onChange={(text) => setDraftFor(file.path, text)}
                onSave={() => void save()}
              />
            </Suspense>
          }
        />
      ) : (
        <div ref={lockOverscroll} className="file-view flex min-h-0 flex-1 flex-col overflow-hidden">
          {contents.isPending ? (
            <div className="grid h-full place-items-center text-content/40"><Loader className="size-4 animate-spin" /></div>
          ) : contents.isError ? (
            <p className="px-4 py-3 text-[12px] text-content/50">{String(contents.error)}</p>
          ) : (
            <Suspense fallback={EditorFallback}>
              <CodeEditor
                key={file.path}
                value={draft ?? contents.data ?? ""}
                fileName={file.name}
                onChange={(text) => setDraftFor(file.path, text)}
                onSave={() => void save()}
              />
            </Suspense>
          )}
        </div>
      )}
      <div className={`flex h-7 shrink-0 items-center gap-2 border-t border-stroke px-3 font-mono text-[11px] text-content/45 ${review || browser ? "hidden" : ""}`}>
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
