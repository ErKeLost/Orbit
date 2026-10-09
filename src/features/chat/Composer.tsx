import { invoke } from "../../lib/native";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useWorkspace } from "../../lib/store";
import { perfMarkSend } from "../../lib/perf-log";
import { ensureSessionModes, recallQueue, report, sendPrompt, setComputerUseMode, setMultiAgentMode, steerFollowUp, stop } from "../../lib/rpc";
import { useSessionTarget } from "../shell/use-session-target";
import { base64ToBlob } from "../../lib/image-bytes";
import { encodeBlobToBase64, encodeClipboardImage } from "../../lib/image-encode";
import { shouldSubmitComposer } from "../../lib/composer";
import { useMetrics } from "../../hooks/use-metrics";
import { Popover } from "../../shared/ui/Popover";
import { ImageLightbox } from "../../shared/ui/ImageLightbox";
import { toast } from "../../shared/ui/toast";
import { ArrowUp, CursorMagicSelection, ImagePlus, Square, Ungroup, X, Plus } from "../../shared/ui/icons";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { ADD_NOTE_TO_CHAT_EVENT, appendNoteReference, type NoteComposerCard } from "../notes/notes";
import { ModelPicker } from "./ModelPicker";
import { MessageQueueView } from "./MessageQueueView";
import { ComposerPalette, paletteRequest, type PalettePick, type PaletteRequest } from "./ComposerPalette";
import { ComposerHighlight } from "./ComposerHighlight";
import { useComposerTokens } from "./composerTokens";
import { expandMentionLabels, type MentionFile } from "./fileMentions";
import { ContextMeter } from "./ContextMeter";
import { WorkspaceRoots } from "./WorkspaceRoots";
import { ExtensionDialog } from "../../components/panels/ExtensionDialog";

type ImageAttachment = { kind: "image"; id: string; name: string; mimeType: string; blob: Blob };
type FileAttachment = { kind: "file"; id: string; name: string; path: string };
type Attachment = ImageAttachment | FileAttachment;

const draftCache = new Map<string, string>();
const attachmentCache = new Map<string, Attachment[]>();
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

function lruCache<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
}

function imageAttachments(files: Iterable<File>): Attachment[] {
  return Array.from(files).flatMap((file) =>
    file.type.startsWith("image/") ? [{ kind: "image" as const, id: crypto.randomUUID(), name: file.name || "粘贴的图片", mimeType: file.type, blob: file }] : [],
  );
}

async function readClipboardImage(): Promise<ImageAttachment | null> {
  const image = await readImage();
  try {
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    const blob = await encodeClipboardImage({ width, height, rgba });
    return { kind: "image", id: crypto.randomUUID(), name: "粘贴的图片.png", mimeType: "image/png", blob };
  } finally {
    await image.close();
  }
}

async function nativeClipboardImage() {
  try {
    return await readClipboardImage();
  } catch {
    try { return await readClipboardImage(); } catch { return null; }
  }
}

/** MonoCode `AttachmentChip`. */
function AttachmentChip({ attachment, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  const url = useMemo(() => (attachment.kind === "image" ? URL.createObjectURL(attachment.blob) : ""), [attachment]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const [preview, setPreview] = useState(false);
  const image = attachment.kind === "image";
  return (
    <>
      <div className={`group relative flex min-w-0 items-center gap-1.5 rounded-md ${image ? "" : "bg-content/10 py-0.5 pl-1 pr-1"}`} title={attachment.kind === "file" ? attachment.path : attachment.name}>
        {image ? (
          <button type="button" aria-label={`全屏查看 ${attachment.name}`} onClick={() => setPreview(true)} className="shrink-0 cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
            <img src={url} alt="" draggable={false} className="size-9 rounded-lg object-cover" />
          </button>
        ) : (
          <>
            <span className="grid size-5 shrink-0 place-items-center">
              <FileTypeIcon name={attachment.name} isDir={false} size={16} />
            </span>
            <span className="min-w-0 max-w-[140px] truncate text-[11px] leading-none text-content/80">{attachment.name}</span>
          </>
        )}
        <button
          type="button"
          title="移除"
          aria-label={`移除 ${attachment.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className={`grid shrink-0 place-items-center rounded-full text-content/70 hover:bg-content/15 hover:text-content ${
            image ? "absolute -right-1 -top-1 size-5 bg-content/20 opacity-100 shadow-sm backdrop-blur-sm" : "size-4 text-content/40"
          }`}
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      </div>
      {image && preview ? <ImageLightbox src={url} alt={attachment.name} onClose={() => setPreview(false)} /> : null}
    </>
  );
}

/** MonoCode `ToolButton` — the square `+` in the composer row. */
function ToolButton({ active, disabled, label, onClick, children }: { active?: boolean; disabled?: boolean; label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-6.5 shrink-0 place-items-center rounded-md ${
        active ? "bg-selection-emphasis text-content" : "bg-selection text-content/50 hover:bg-selection-hover hover:text-content"
      } disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/50`}
    >
      {children}
    </button>
  );
}

/** MonoCode `AccessPicker`-shaped pills for Pi's session modes. */
/** MonoCode `ComposerAction`: white square send / stop. */
function ComposerAction({ busy, disabled, hasValue, onSend, onStop }: { busy: boolean; disabled: boolean; hasValue: boolean; onSend: () => void; onStop: () => void }) {
  if (disabled) {
    return (
      <button type="button" title="Send" aria-label="发送" disabled className="composer-send primary-action grid size-6.5 place-items-center rounded-md disabled:cursor-default">
        <ArrowUp className="size-3.5" strokeWidth={2.25} />
      </button>
    );
  }
  if (busy) {
    return hasValue ? (
      <button type="button" title="引导当前回复 (Enter) · 排队 (⌥Enter)" aria-label="发送引导" onClick={onSend} className="composer-send primary-action grid size-6.5 place-items-center rounded-md">
        <ArrowUp className="size-3.5" strokeWidth={2.25} />
      </button>
    ) : (
      <button type="button" title="Stop" aria-label="停止" onClick={onStop} className="grid size-6.5 place-items-center rounded-md bg-white text-black hover:bg-white/90">
        <Square className="size-2.5 fill-current" strokeWidth={0} />
      </button>
    );
  }
  return (
    <button type="button" title="Send" aria-label="发送" disabled={!hasValue} onClick={onSend} className="composer-send primary-action grid size-6.5 place-items-center rounded-md disabled:cursor-default">
      <ArrowUp className="size-3.5" strokeWidth={2.25} />
    </button>
  );
}

type DraftHandle = {
  clear: () => void;
  restore: (text: string) => void;
  focus: () => void;
  value: () => string;
  caret: () => number;
  setText: (text: string, caret: number) => void;
};

/**
 * The textarea is its own leaf so keystrokes never re-render the toolbar. Its
 * text is transparent: `ComposerHighlight` paints the same draft underneath, so
 * `/` and `@` tokens keep their palette styling once they land in the text.
 */
const DraftField = memo(
  forwardRef<DraftHandle, {
    composerKey: string;
    placeholder: string;
    disabled: boolean;
    paletteOpen: boolean;
    skillNames: ReadonlySet<string>;
    mentionLabels: ReadonlyMap<string, MentionFile>;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onHasValue: (has: boolean) => void;
    onPalette: (request: PaletteRequest | null) => void;
  }>(function DraftField(
    { composerKey, placeholder, disabled, paletteOpen, skillNames, mentionLabels, onKeyDown, onHasValue, onPalette },
    ref,
  ) {
      const [draft, setDraft] = useState(() => useWorkspace.getState().draft || draftCache.get(composerKey) || "");
      const field = useRef<HTMLTextAreaElement>(null);
      const highlight = useRef<HTMLDivElement>(null);
      const caret = useRef(0);
      const resize = (el: HTMLTextAreaElement | null) => {
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      };
      useImperativeHandle(
        ref,
        () => ({
          clear: () => setDraft(""),
          restore: (text) => setDraft((current) => (current ? `${text}${current}` : text)),
          focus: () => field.current?.focus(),
          value: () => field.current?.value ?? "",
          caret: () => caret.current,
          setText: (text, position) => {
            caret.current = position;
            setDraft(text);
            requestAnimationFrame(() => {
              const el = field.current;
              el?.focus();
              el?.setSelectionRange(position, position);
            });
          },
        }),
        [],
      );
      useEffect(() => {
        lruCache(draftCache, composerKey, draft);
        onHasValue(Boolean(draft.trim()));
        resize(field.current);
      }, [composerKey, draft, onHasValue]);
      // Extensions can push text into the editor (Pi `set_editor_text`).
      const external = useWorkspace((state) => state.draft);
      useEffect(() => {
        if (external) setDraft(external);
      }, [external]);
      const syncCaret = (el: HTMLTextAreaElement) => {
        caret.current = el.selectionStart ?? el.value.length;
        onPalette(paletteRequest(el.value, caret.current));
      };
      return (
        <div className="relative">
          <div
            ref={highlight}
            aria-hidden
            className="composer-highlight pointer-events-none absolute inset-0 max-h-40 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 font-sans text-sm leading-5.5 text-content"
          >
            <ComposerHighlight text={draft} names={skillNames} mentions={mentionLabels} />
          </div>
          <textarea
            ref={field}
            rows={1}
            spellCheck={false}
            value={draft}
            disabled={disabled}
            placeholder={placeholder}
            aria-label="消息"
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              syncCaret(event.currentTarget);
            }}
            onKeyDown={(event) => {
              // While the palette is open it owns the arrows, Enter and Escape.
              if (paletteOpen && ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) {
                event.preventDefault();
                return;
              }
              onKeyDown(event);
            }}
            onKeyUp={(event) => syncCaret(event.currentTarget)}
            onClick={(event) => syncCaret(event.currentTarget)}
            onSelect={(event) => syncCaret(event.currentTarget)}
            onScroll={(event) => {
              const el = event.currentTarget;
              if (!highlight.current) return;
              highlight.current.scrollTop = el.scrollTop;
              highlight.current.scrollLeft = el.scrollLeft;
            }}
            className="composer-field scrollbar-none relative max-h-40 w-full resize-none overflow-x-hidden whitespace-pre-wrap break-words bg-transparent px-3 py-3 font-sans text-sm leading-5.5 outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap"
          />
        </div>
      );
    },
  ),
);

export const Composer = memo(function Composer({ onSubmitted, centered = false }: { onSubmitted: () => void; centered?: boolean }) {
  const project = useWorkspace((state) => state.cwd);
  // Sends go to this pane's pi connection, not the shell's projected one.
  const target = useSessionTarget();
  const connectionId = useWorkspace((state) => state.connectionId);
  const running = useWorkspace((state) => state.transcript.running);
  const compacting = useWorkspace((state) => state.transcript.compacting);
  const queue = useWorkspace((state) => state.transcript.queue);
  const online = useWorkspace((state) => state.connection === "online");
  const runtimeTarget = useWorkspace((state) => state.runtimeTarget);
  const runtimePlatform = useWorkspace((state) => state.runtimePlatform);
  const multiAgent = useWorkspace((state) => state.multiAgentEnabled);
  const computerUse = useWorkspace((state) => state.computerUseEnabled);
  const homeDir = useWorkspace((state) => state.homeDir);
  const dialog = useWorkspace((state) => state.dialogs[0]);
  const composerKey = connectionId || project;
  const tokens = useComposerTokens(project);
  const mentionLabels = tokens.index.labels;
  const [attachments, setAttachments] = useState<Attachment[]>(() => attachmentCache.get(composerKey) ?? []);
  const [hasValue, setHasValue] = useState(false);
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [fileDrag, setFileDrag] = useState(false);
  const draftRef = useRef<DraftHandle>(null);
  const plusRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const { stats } = useMetrics();
  const desktopMac = runtimeTarget === "desktop" && runtimePlatform === "macos";

  useEffect(() => { lruCache(attachmentCache, composerKey, attachments); }, [attachments, composerKey]);

  // Notes 的「Add to chat」：把笔记正文前置进当前草稿（MonoCode 同名事件）。
  useEffect(() => {
    const onAdd = (event: Event) => {
      const card = (event as CustomEvent<NoteComposerCard>).detail;
      if (!card?.id) return;
      draftRef.current?.restore(appendNoteReference("", card.title, card.body));
    };
    window.addEventListener(ADD_NOTE_TO_CHAT_EVENT, onAdd);
    return () => window.removeEventListener(ADD_NOTE_TO_CHAT_EVENT, onAdd);
  }, []);


  const addFilePaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
    void Promise.all(
      paths.map(async (path): Promise<Attachment> => {
        const name = path.split(/[\\/]/).pop() || path;
        if (IMAGE_EXTENSIONS.has(name.includes(".") ? name.split(".").pop()!.toLowerCase() : "")) {
          try {
            const file = await invoke<{ name: string; data: string; mimeType: string }>("read_file_attachment", { path });
            return { kind: "image", id: crypto.randomUUID(), name: file.name, mimeType: file.mimeType, blob: base64ToBlob(file.data, file.mimeType) };
          } catch { /* fall back to a path chip */ }
        }
        return { kind: "file", id: crypto.randomUUID(), name, path };
      }),
    ).then((next) => setAttachments((current) => [...current, ...next])).catch(report);
  }, []);

  useEffect(() => {
    const onPaste = async (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-composer-box]")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length) {
        event.preventDefault();
        setAttachments((current) => [...current, ...imageAttachments(images)]);
        return;
      }
      if (files.length === 0 && !event.clipboardData?.getData("text/plain") && runtimeTarget === "desktop") {
        event.preventDefault();
        const paths = await invoke<string[]>("clipboard_file_paths").catch(() => [] as string[]);
        if (paths.length) {
          addFilePaths(paths);
          return;
        }
        const image = await nativeClipboardImage();
        if (image) setAttachments((current) => [...current, image]);
      }
    };
    const listener = (event: ClipboardEvent) => void onPaste(event);
    window.addEventListener("paste", listener);
    return () => window.removeEventListener("paste", listener);
  }, [addFilePaths, runtimeTarget]);

  useEffect(() => {
    if (runtimeTarget !== "desktop") return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") setFileDrag(true);
        else setFileDrag(false);
        if (event.payload.type === "drop") addFilePaths(event.payload.paths);
      })
      .then((dispose) => { unlisten = dispose; })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [addFilePaths, runtimeTarget]);

  /** Write a picked `/command` or `@mention` token into the draft. */
  const insertPick = useCallback(
    (pick: PalettePick) => {
      const field = draftRef.current;
      const current = field?.value() ?? "";
      // A mention rewrites the whole `@word` token; a command only the prefix
      // the user typed. The caret is the boundary in both cases.
      const start = palette?.start ?? current.length;
      const end = palette ? (pick.file ? palette.end : field?.caret() ?? current.length) : current.length;
      const rest = current.slice(end);
      // `@label` stays glued to whatever follows, exactly like MonoCode's
      // `replaceMentionToken`, so the highlight can still find the token.
      const spacer = pick.file && !rest.startsWith(" ") ? " " : "";
      const next = `${current.slice(0, start)}${pick.text}${spacer}${rest}`;
      let cursor = start + pick.text.length + spacer.length;
      if (next[cursor] === " ") cursor += 1;
      setPalette(null);
      field?.setText(next, cursor);
    },
    [palette],
  );

  const submit = useCallback(
    async (streamingBehavior: "steer" | "followUp") => {
      const draftText = draftRef.current?.value() ?? "";
      if (!draftText.trim() && attachments.length === 0) return;
      // The composer shows `@name`; the harness gets a path it can resolve.
      const text = expandMentionLabels(draftText, mentionLabels);
      perfMarkSend();
      useWorkspace.getState().event({ type: "prompt_submitted" });
      const previewId = `queued-${crypto.randomUUID()}`;
      const fileChips = attachments.filter((item): item is FileAttachment => item.kind === "file");
      const images = attachments.filter((item): item is ImageAttachment => item.kind === "image");
      const prefix = fileChips.map((item) => `[文件] ${item.path}`).join("\n");
      const message = prefix ? `${prefix}\n\n${text}`.trim() : text;
      const before = attachments;
      setAttachments([]);
      draftRef.current?.clear();
      // 从首页（EmptySession）发出的第一条消息会把整个 composer 重挂载到会话底部。
      // 被卸载的实例不会再 flush effect，draft/attachment 缓存里仍留着刚发出的内容，
      // 重挂载的 composer 会按同一个 composerKey 把它们原样捞回来（发出去的消息
      // 「回到输入框」）。这里必须同步清掉当前会话的缓存，不能只清本地状态。
      draftCache.delete(composerKey);
      lruCache(attachmentCache, composerKey, []);
      const previewUrls: string[] = [];
      const previewContent = [
        ...(message ? [{ type: "text" as const, text: message }] : []),
        ...images.map((item) => {
          const url = URL.createObjectURL(item.blob);
          previewUrls.push(url);
          return { type: "image" as const, mimeType: item.mimeType, url };
        }),
      ];
      // Steering goes into the running turn; only a fresh prompt or a
      // follow-up appears optimistically as a new bubble.
      if (previewContent.length && !(running && streamingBehavior === "steer")) {
        useWorkspace.getState().event({
          type: "queued_preview",
          id: previewId,
          message: { role: "user", content: previewContent.length === 1 && previewContent[0]?.type === "text" ? message : previewContent, timestamp: Date.now() },
        });
        onSubmitted();
      }
      try {
        const payload = Promise.all(images.map(async (item) => ({ type: "image" as const, data: await encodeBlobToBase64(item.blob), mimeType: item.mimeType })));
        if (!running) await ensureSessionModes(target);
        await sendPrompt({ type: "prompt", message, images: await payload, ...(running ? { streamingBehavior } : {}) }, target, running);
        onSubmitted();
        window.setTimeout(() => previewUrls.forEach((url) => URL.revokeObjectURL(url)), 15000);
      } catch (error) {
        previewUrls.forEach((url) => URL.revokeObjectURL(url));
        useWorkspace.getState().event({ type: "queued_preview_revert", id: previewId });
        useWorkspace.getState().event({ type: "prompt_settled" });
        if (draftRef.current) {
          // composer 还挂着（会话内发送失败）：直接恢复，缓存由它的 effect 回写。
          setAttachments((current) => [...before, ...current]);
          draftRef.current.restore(draftText);
        } else {
          // composer 已随视图切换重挂载，ref 已被置空；把草稿写回缓存，
          // 让重挂载（回退首页或底部新实例）的 composer 恢复内容。
          lruCache(draftCache, composerKey, draftText);
          lruCache(attachmentCache, composerKey, before);
        }
        report(error);
      }
    },
    [attachments, composerKey, mentionLabels, onSubmitted, project, running, target],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }, false)) return;
      event.preventDefault();
      if (!online) return;
      // Enter steers a running turn; ⌥Enter queues it as a follow-up.
      void submit(event.altKey ? "followUp" : "steer");
    },
    [online, submit],
  );

  const usage = stats?.contextUsage;
  const context = usage && usage.tokens != null && usage.contextWindow ? { used: usage.tokens, window: usage.contextWindow } : undefined;
  const queueVisible = queue.steering.length + queue.followUp.length > 0;
  const projectFolder = project && project !== homeDir ? project : "";

  return (
    <div className={`relative mx-auto w-full max-w-4xl ${centered ? "" : "p-1.5 pt-0"}`} data-session-composer>
      {dialog ? <ExtensionDialog key={dialog.id} dialog={dialog} /> : null}
      {queueVisible ? (
        <MessageQueueView
          steering={queue.steering}
          followUp={queue.followUp}
          onSteer={(text) => void steerFollowUp(text, target).catch(report)}
          onClear={() => void recallQueue(target).catch(report)}
        />
      ) : null}
      <div className="relative overflow-visible">
        {palette && !plusOpen ? (
          <div className="absolute inset-x-0 bottom-full z-30 mb-1">
            <ComposerPalette request={palette} onPick={insertPick} onClose={() => setPalette(null)} />
          </div>
        ) : null}
        <div
          ref={boxRef}
          data-composer-box
          className={`relative z-10 rounded-lg border bg-content/3 backdrop-blur-sm ${fileDrag ? "border-accent/60" : "border-content/10 has-focus:border-content/20"}`}
        >
          {fileDrag ? (
            <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-lg bg-accent/8 text-[12px] text-content/70">拖放文件以附加</div>
          ) : null}
          <div className="flex min-w-0 items-center gap-2.5 overflow-hidden px-3 pt-2.5">
            {projectFolder ? <WorkspaceRoots projectFolder={projectFolder} disabled={running} /> : null}
            <div className="ml-auto flex shrink-0 items-center">
              <ContextMeter usage={context} compacting={compacting} />
            </div>
          </div>

          {attachments.length ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
              {attachments.map((item) => (
                <AttachmentChip key={item.id} attachment={item} onRemove={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))} />
              ))}
            </div>
          ) : null}

          <DraftField
            key={composerKey}
            ref={draftRef}
            composerKey={composerKey}
            disabled={false}
            paletteOpen={palette !== null}
            skillNames={tokens.skills}
            mentionLabels={mentionLabels}
            placeholder={running ? "引导当前回复，⌥Enter 排队…" : "Ask, build, / for commands, @ for references..."}
            onKeyDown={onKeyDown}
            onHasValue={setHasValue}
            onPalette={setPalette}
          />

          <div className="flex items-center gap-1 px-2 pb-2">
            <div ref={plusRef} className="relative shrink-0">
              <ToolButton label="添加图片或选择模式" active={plusOpen} onClick={() => setPlusOpen((value) => !value)}>
                <Plus className="size-3.5" strokeWidth={1.5} />
              </ToolButton>
              {plusOpen ? (
                <Popover anchor={plusRef} side="top" align="start" width={250} onDismiss={() => setPlusOpen(false)} data-composer-plus className="p-1.5">
                  <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">添加到消息</p>
                  <button
                    type="button"
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10"
                    onClick={() => {
                      setPlusOpen(false);
                      fileInput.current?.click();
                    }}
                  >
                    <ImagePlus className="mt-0.5 size-3.5 shrink-0 text-content/70" strokeWidth={1.75} />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium leading-5">图片</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-content/50">从磁盘选择，或直接粘贴截图</span>
                    </span>
                  </button>
                  <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">模式</p>
                  <button
                    type="button"
                    disabled={!online || running}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      setPlusOpen(false);
                      void setMultiAgentMode(!multiAgent).catch(report);
                    }}
                  >
                    <Ungroup className={`mt-0.5 size-3.5 shrink-0 ${multiAgent ? "text-accent" : "text-content/70"}`} strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-5">多 agent 协作</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-content/50">可委派子 agent 并行处理</span>
                    </span>
                    {multiAgent ? <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                  </button>
                  {desktopMac ? (
                    <button
                      type="button"
                      disabled={!online || running}
                      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10 disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => {
                        setPlusOpen(false);
                        void setComputerUseMode(!computerUse)
                          .then(() => toast.success(computerUse ? "电脑操作已关闭" : "电脑操作已开启，直接说要做什么即可"))
                          .catch(report);
                      }}
                    >
                      <CursorMagicSelection className={`mt-0.5 size-3.5 shrink-0 ${computerUse ? "text-accent" : "text-content/70"}`} strokeWidth={1.75} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium leading-5">操作电脑</span>
                        <span className="mt-0.5 block text-[11px] leading-4 text-content/50">用自然语言让助手点选本机界面</span>
                      </span>
                      {computerUse ? <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    </button>
                  ) : null}
                </Popover>
              ) : null}
            </div>
            <input
              type="file"
              multiple
              accept="image/*"
              hidden
              ref={fileInput}
              onChange={(event) => {
                const files = event.target.files;
                if (files) setAttachments((current) => [...current, ...imageAttachments(files)]);
                event.target.value = "";
              }}
            />
            <div className="composer-toolbar flex min-w-0 flex-1 items-center">
              <div className="flex shrink-0 items-center gap-1">
                <ModelPicker />
            </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <ToolButton
                active={multiAgent}
                disabled={!online || running}
                label={running ? "任务运行中不可切换" : multiAgent ? "多 agent 协作（已开启）" : "开启多 agent 协作"}
                onClick={() =>
                  void setMultiAgentMode(!multiAgent)
                    .then(() => toast.success(multiAgent ? "已切回单线工作流" : "已开启多 agent：可以委派子 agent 并行处理"))
                    .catch(report)
                }
              >
                <Ungroup className="size-3.5" strokeWidth={1.75} />
              </ToolButton>
              {desktopMac ? (
                <ToolButton
                  active={computerUse}
                  disabled={!online || running}
                  label={running ? "任务运行中不可切换" : computerUse ? "电脑操作（已开启）" : "开启电脑操作"}
                  onClick={() =>
                    void setComputerUseMode(!computerUse)
                      .then(() => toast.success(computerUse ? "电脑操作已关闭" : "电脑操作已开启，直接说要做什么即可"))
                      .catch(report)
                  }
                >
                  <CursorMagicSelection className="size-3.5" strokeWidth={1.75} />
                </ToolButton>
              ) : null}
              <ComposerAction
                busy={running}
                disabled={!online}
                hasValue={hasValue || attachments.length > 0}
                onSend={() => void submit("steer")}
                onStop={() => void stop(target).catch(report)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
