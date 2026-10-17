import { invoke } from "../../lib/native";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useWorkspace } from "../../lib/store";
import { perfMarkSend } from "../../lib/perf-log";
import { ensureSessionModes, recallQueue, report, request, sendPrompt, setBrowserUseMode, setComputerUseMode, setMultiAgentMode, steerFollowUp, stop, transcribeAudio } from "../../lib/rpc";
import { useSessionTarget } from "../shell/use-session-target";
import { base64ToBlob } from "../../lib/image-bytes";
import { encodeBlobToBase64, encodeClipboardImage } from "../../lib/image-encode";
import { prepareImageAttachment, resolveImageMime } from "../../lib/image-attachment";
import { shouldSubmitComposer } from "../../lib/composer";
import { useMetrics } from "../../hooks/use-metrics";
import { Popover } from "../../shared/ui/Popover";
import { ImageLightbox } from "../../shared/ui/ImageLightbox";
import { toast } from "../../shared/ui/toast";
import { ArrowUp, CursorMagicSelection, Globe, ImagePlus, Square, Sparkles, Ungroup, X, Plus } from "../../shared/ui/icons";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { ADD_NOTE_TO_CHAT_EVENT, appendNoteReference, type NoteComposerCard } from "../notes/notes";
import { ModelPicker } from "./ModelPicker";
import { MessageQueueView } from "./MessageQueueView";
import { ComposerPalette, paletteRequest, type PalettePick, type PaletteRequest } from "./ComposerPalette";
import { ComposerHighlight } from "./ComposerHighlight";
import { useComposerTokens } from "./composerTokens";
import { expandMentionLabels, type MentionFile } from "./fileMentions";
import { ContextMeter } from "./ContextMeter";
import { stepInputHistory, inputHistoryEntries } from "./input-history";
import {
  PROMPT_SUGGESTION_DEBOUNCE_MS,
  PROMPT_SUGGESTION_STATUS,
  acceptSuggestion,
  claimTurnSuggestion,
  loadPromptSuggestion,
  parseSuggestion,
  savePromptSuggestion,
  shouldAskNextStep,
  suggestionFor,
  transcriptTurn,
} from "./promptSuggestion";
import { userText } from "./turnModel";
import { SpeechInput } from "../../components/ai-elements/speech-input";
import { WorkspaceRoots } from "./WorkspaceRoots";
import { ProjectPicker } from "./ProjectPicker";
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

/**
 * Picked files → attachments that can actually be sent.
 *
 * Both halves of this are phone problems. A camera JPEG is several megabytes in
 * a single WebSocket frame, and Android's picker returns `content://` sources
 * whose `File.type` is empty often enough that the type has to come from the
 * name. `prepareImageAttachment` decides both; a file it refuses is reported and
 * skipped rather than attached and dropped at the far end.
 */
async function prepareAttachments(files: Iterable<File>): Promise<Attachment[]> {
  const prepared = await Promise.all(
    Array.from(files).map(async (file): Promise<Attachment | null> => {
      try {
        const image = await prepareImageAttachment({ name: file.name, type: file.type, size: file.size, blob: file });
        return { kind: "image", id: crypto.randomUUID(), name: image.name, mimeType: image.mimeType, blob: image.blob };
      } catch (error) {
        report(error);
        return null;
      }
    }),
  );
  return prepared.filter((item): item is Attachment => item !== null);
}

function addPrepared(setAttachments: (update: (current: Attachment[]) => Attachment[]) => void, files: Iterable<File>) {
  void prepareAttachments(files).then((next) => {
    if (next.length) setAttachments((current) => [...current, ...next]);
  });
}

async function readClipboardImage(): Promise<ImageAttachment | null> {
  const image = await readImage();
  try {
    const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
    const { blob, mimeType } = await encodeClipboardImage({ width, height, rgba });
    // 超大截图会被编码器回退成 JPEG，附件的类型跟着字节走，而不是假定 PNG。
    const extension = mimeType === "image/jpeg" ? "jpg" : "png";
    return { kind: "image", id: crypto.randomUUID(), name: `粘贴的图片.${extension}`, mimeType, blob };
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

/** Orbit `AttachmentChip`. */
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

/** Orbit `ToolButton` — the square `+` in the composer row. */
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

/** Orbit `AccessPicker`-shaped pills for Pi's session modes. */
/** Orbit `ComposerAction`: white square send / stop. */
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
 *
 * The prompt suggestion (联想) lives here too, for the same reason: the draft,
 * the caret and the ghost text are one piece of state, and the toolbar has no
 * business re-rendering when a suggestion lands.
 */
const DraftField = memo(
  forwardRef<DraftHandle, {
    composerKey: string;
    placeholder: string;
    disabled: boolean;
    paletteOpen: boolean;
    skillNames: ReadonlySet<string>;
    mentionLabels: ReadonlyMap<string, MentionFile>;
    /** Ask Pi for a "what next" guess once a turn settles. */
    suggestEnabled: boolean;
    /** Identity of the conversation, so a stale "what next" guess can be dropped. */
    turnKey: string;
    /** Increments when a turn settles; 0 means "no turn finished in this view". */
    nextStepSeq: number;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onHasValue: (has: boolean) => void;
    onPalette: (request: PaletteRequest | null) => void;
    onSuggest: (draft: string, turn: string) => void;

    /**
     * Shell-style recall of what the reader already sent. Returns true when the
     * arrow key was consumed as history, in which case it must not also move the
     * caret. The field decides *when* an arrow means history; the composer owns
     * the entries and the cursor into them.
     */
    onHistory: (direction: "up" | "down", caret: { start: number; end: number; length: number }) => boolean;
  }>(function DraftField(
    { composerKey, placeholder, disabled, paletteOpen, skillNames, mentionLabels, suggestEnabled, turnKey, nextStepSeq, onKeyDown, onHasValue, onPalette, onSuggest, onHistory },
    ref,
  ) {
      const [draft, setDraft] = useState(() => useWorkspace.getState().draft || draftCache.get(composerKey) || "");
      const field = useRef<HTMLTextAreaElement>(null);
      const highlight = useRef<HTMLDivElement>(null);
      const caret = useRef(0);
      // The continuation is only ever appended, so "caret at the very end" is
      // the whole condition. Tracking the *boundary* rather than the offset
      // keeps moving the caret from re-rendering this leaf.
      const [atEnd, setAtEnd] = useState(true);
      /**
       * What the reader pressed Escape on. The "what next" guess is dismissed
       * per turn: it has no draft to be keyed on.
       */
      const ghostKey = draft.trim() ? draft : `turn:${turnKey}`;
      const [dismissed, setDismissed] = useState<string | null>(null);
      /**
       * Which finished turn we already paid for. Counted in turns, not in
       * `turnKey`: that key is derived from the transcript and can shift right
       * after a settle (Pi drops still-queued previews), which would otherwise
       * buy the same turn a second call.
       */
      const askedTurn = useRef(0);
      const reply = parseSuggestion(useWorkspace((state) => state.statuses[PROMPT_SUGGESTION_STATUS]));
      // A reply is used only for the draft (or the turn) it was asked about, so
      // a slow answer can never land on newer text or a newer conversation.
      const ghost = suggestEnabled && dismissed !== ghostKey ? suggestionFor(reply, draft, atEnd, turnKey) : null;
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
            // Recalled text can start with `/` or `@`: keep the palette in step
            // with the draft instead of waiting for the next keystroke.
            onPalette(paletteRequest(text, position));
            requestAnimationFrame(() => {
              const el = field.current;
              el?.focus();
              el?.setSelectionRange(position, position);
            });
          },
        }),
        [onPalette],
      );
      useEffect(() => {
        lruCache(draftCache, composerKey, draft);
        onHasValue(Boolean(draft.trim()));
        resize(field.current);
      }, [composerKey, draft, onHasValue]);
      // 回合结束、输入框空着：猜「你下一句想说什么」。**一轮只问一次** ——
      // 重渲染、切光标、开合面板、把草稿删回空白都不会再花一次调用。
      // 打字过程本身永远不调模型：联想只在 agent 每次 run 结束时产生一次。
      useEffect(() => {
        const wanted = shouldAskNextStep({ enabled: suggestEnabled, paletteOpen, atEnd, draft, settleSeq: nextStepSeq, askedSeq: askedTurn.current });
        if (!wanted) return;
        const timer = window.setTimeout(() => {
          // 认领在真正发请求的那一刻才算数：分屏里另一个 pane 先到就它发。
          if (!claimTurnSuggestion(composerKey, turnKey)) return;
          askedTurn.current = nextStepSeq;
          onSuggest("", turnKey);
        }, PROMPT_SUGGESTION_DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
      }, [atEnd, composerKey, draft, nextStepSeq, onSuggest, paletteOpen, suggestEnabled, turnKey]);
      // Extensions can push text into the editor (Pi `set_editor_text`).
      const external = useWorkspace((state) => state.draft);
      useEffect(() => {
        if (external) setDraft(external);
      }, [external]);
      const syncCaret = (el: HTMLTextAreaElement) => {
        caret.current = el.selectionStart ?? el.value.length;
        setAtEnd(caret.current >= el.value.length);
        onPalette(paletteRequest(el.value, caret.current));
      };
      /** Tab / →: take the continuation as real text. */
      const takeGhost = () => {
        const accepted = acceptSuggestion(draft, atEnd, ghost);
        if (!accepted) return false;
        caret.current = accepted.caret;
        setDraft(accepted.text);
        setAtEnd(true);
        onPalette(paletteRequest(accepted.text, accepted.caret));
        requestAnimationFrame(() => field.current?.setSelectionRange(accepted.caret, accepted.caret));
        return true;
      };
      return (
        <div className="relative">
          <div
            ref={highlight}
            aria-hidden
            className="composer-highlight pointer-events-none absolute inset-0 max-h-40 overflow-hidden whitespace-pre-wrap break-words px-3 py-3 font-sans text-sm leading-5.5 text-content"
          >
            <ComposerHighlight text={draft} names={skillNames} mentions={mentionLabels} ghost={ghost} />
          </div>
          <textarea
            ref={field}
            rows={1}
            spellCheck={false}
            value={draft}
            disabled={disabled}
            placeholder={ghost ? "" : placeholder}
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
              if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey) {
                const el = event.currentTarget;
                if (onHistory(event.key === "ArrowUp" ? "up" : "down", { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, length: el.value.length })) {
                  event.preventDefault();
                  return;
                }
              }
              // While an IME is composing, Tab and → belong to the candidate list.
              if (ghost && !event.nativeEvent.isComposing) {
                if (event.key === "Tab" || (event.key === "ArrowRight" && !event.shiftKey && !event.altKey && !event.metaKey)) {
                  // ArrowRight at the very end of the text does nothing otherwise,
                  // so taking it costs the reader nothing.
                  if (takeGhost()) {
                    event.preventDefault();
                    return;
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDismissed(ghostKey);
                  return;
                }
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
  const browserUse = useWorkspace((state) => state.browserUseEnabled);
  const homeDir = useWorkspace((state) => state.homeDir);
  const dialog = useWorkspace((state) => state.dialogs[0]);
  const composerKey = connectionId || project;
  const tokens = useComposerTokens(project);
  const mentionLabels = tokens.index.labels;
  const [attachments, setAttachments] = useState<Attachment[]>(() => attachmentCache.get(composerKey) ?? []);
  const [hasValue, setHasValue] = useState(false);
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // 提示词联想（ghost text）：只在每个 run 结束时猜一次，所以默认开着。
  const [suggestEnabled, setSuggestEnabled] = useState(loadPromptSuggestion);
  // 只有当前运行的 Pi 真的注册了这条命令才启用：否则 `/gui-suggest …` 会被当成
  // 普通消息发给模型。
  const suggestAvailable = tokens.commands.some((command) => command.name === "gui-suggest");
  const [fileDrag, setFileDrag] = useState(false);
  // 回合结束的计数：联想猜的是「你下一句想说什么」，得等 agent 说完再看，
  // 所以触发点是 running 真的从 true 落到 false，而不是每次重渲染。
  const [settleSeq, setSettleSeq] = useState(0);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setSettleSeq((value) => value + 1);
    wasRunning.current = running;
  }, [running]);
  const turnKey = transcriptTurn(useWorkspace((state) => state.transcript.messages));
  const draftRef = useRef<DraftHandle>(null);
  // Shell-style recall of what the reader already sent. Kept in refs, and the
  // transcript is read lazily inside the handler: subscribing to it here would
  // re-render the composer on every streamed token.
  const historyIndex = useRef<number | null>(null);
  const historyStash = useRef("");
  const plusRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const { stats } = useMetrics();
  const desktopMac = runtimeTarget === "desktop" && runtimePlatform === "macos";

  useEffect(() => { lruCache(attachmentCache, composerKey, attachments); }, [attachments, composerKey]);

  // A different session has a different history; drop any cursor into the old one.
  useEffect(() => {
    historyIndex.current = null;
    historyStash.current = "";
  }, [composerKey]);

  const navigateHistory = useCallback(
    (direction: "up" | "down", caret: { start: number; end: number; length: number }) => {
      // A selection, or a caret sitting mid-text, keeps the arrow for itself: a
      // multi-line draft must still be editable with the keyboard.
      if (caret.start !== caret.end) return false;
      const browsing = historyIndex.current !== null;
      // Entering history wants the caret at the very start (bash's rule); while
      // browsing, the caret sits at the end of the recalled line, so the same
      // rule would trap the reader on the newest entry.
      if (!browsing && !(direction === "up" && caret.start === 0)) return false;
      const entries = inputHistoryEntries(
        useWorkspace.getState().transcript.messages,
        userText as (message: never) => string,
      );
      const step = stepInputHistory(entries.length, historyIndex.current, direction);
      if (!step) return browsing;
      if (!browsing) historyStash.current = draftRef.current?.value() ?? "";
      historyIndex.current = step.index;
      const text = step.restore ? historyStash.current : entries[step.index ?? 0] ?? "";
      if (step.restore) historyStash.current = "";
      draftRef.current?.setText(text, text.length);
      return true;
    },
    [],
  );

  // Notes 的「Add to chat」：把笔记正文前置进当前草稿（Orbit 同名事件）。
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
      const images = files.filter((file) => resolveImageMime(file) !== null);
      if (images.length) {
        event.preventDefault();
        addPrepared(setAttachments, images);
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
      // `@label` stays glued to whatever follows, exactly like Orbit's
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
      const attachmentsAtSend = attachments;
      const images = attachmentsAtSend.filter((item): item is ImageAttachment => item.kind === "image");
      // 张数交给等待位：带图的一轮慢在上传，说“正在发送图片”比笼统的“正在思考”
      // 更能区分“在干活”和“卡住了”。
      useWorkspace.getState().event({ type: "prompt_submitted", images: images.length });
      const previewId = `queued-${crypto.randomUUID()}`;
      const fileChips = attachmentsAtSend.filter((item): item is FileAttachment => item.kind === "file");
      const prefix = fileChips.map((item) => `[文件] ${item.path}`).join("\n");
      const message = prefix ? `${prefix}\n\n${text}`.trim() : text;
      const before = attachmentsAtSend;
      setAttachments([]);
      draftRef.current?.clear();
      // A freshly sent message is now the newest history entry.
      historyIndex.current = null;
      historyStash.current = "";
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

  /** 把草稿交给 Pi 的扩展命令续写；结果由 `gui-suggest` 的 status 回来。 */
  const requestSuggestion = useCallback(
    (draft: string, turn: string) => {
      if (!online || !suggestAvailable) return;
      // The response only acknowledges the prompt; the suggestion itself arrives
      // later as a status and is matched against the draft (or the turn) there.
      void request({ type: "prompt", message: `/gui-suggest ${JSON.stringify({ draft, turn })}` }, 30000, target).catch(() => undefined);
    },
    [online, suggestAvailable, target],
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

  // 语音输入：录音 → speech.json 配置的转写端点 → 文字追加进草稿。没检测到人声
  // 是「再说一次」而不是故障，不给 report（那会再弹一个红色错误 toast）。
  const transcribeRecording = useCallback(async (blob: Blob) => {
    try {
      const { text, noSpeech } = await transcribeAudio(await encodeBlobToBase64(blob), blob.type || "audio/webm");
      if (noSpeech) {
        toast.warning("没听到你说话", { description: "点开后正常说一句话再点停止；仍然失败就检查系统麦克风输入设备", showTimestamp: false });
        return "";
      }
      return text;
    } catch (error) {
      report(error);
      toast.warning("语音转写失败", { description: error instanceof Error ? error.message : String(error) });
      return "";
    }
  }, []);

  const appendTranscript = useCallback((text: string) => {
    if (!text) return;
    const field = draftRef.current;
    const current = field?.value() ?? "";
    const spacer = current && !/\s$/.test(current) ? " " : "";
    const next = `${current}${spacer}${text}`;
    field?.setText(next, next.length);
  }, []);

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
            {/* 新会话（首页）：头部带范围选择器，发送前就能切项目 / 不在文件夹里工作
                （Codex 的「项目 | 环境 | 分支」形式）。会话开始后（centered=false）
                撤下选择器——中途切范围等于打断会话。 */}
            {centered ? <ProjectPicker disabled={running} /> : null}
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
            suggestEnabled={suggestEnabled && suggestAvailable}
            turnKey={turnKey}
            nextStepSeq={settleSeq}
            onSuggest={requestSuggestion}
            placeholder={running ? "引导当前回复，⌥Enter 排队…" : "Ask, build, / for commands, @ for references..."}
            onKeyDown={onKeyDown}
            onHasValue={setHasValue}
            onPalette={setPalette}
            onHistory={navigateHistory}
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
                  <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">输入</p>
                  <button
                    type="button"
                    disabled={!suggestAvailable}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      const next = !suggestEnabled;
                      setSuggestEnabled(next);
                      savePromptSuggestion(next);
                    }}
                  >
                    <Sparkles className={`mt-0.5 size-3.5 shrink-0 ${suggestEnabled ? "text-accent" : "text-content/70"}`} strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-5">提示词联想</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-content/50">每轮回答结束后，猜你下一句想说什么填进输入框；打字过程不会调用模型。Tab 或 → 采纳，Esc 忽略。每轮只算一次模型调用</span>
                    </span>
                    {suggestEnabled && suggestAvailable ? <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" /> : null}
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
                  <button
                    type="button"
                    disabled={!online || running}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left text-content hover:bg-content/10 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={() => {
                      setPlusOpen(false);
                      void setBrowserUseMode(!browserUse)
                        .then(() => toast.success(browserUse ? "浏览器操作已关闭" : "浏览器操作已开启，可以直接给出网址和目标"))
                        .catch(report);
                    }}
                  >
                    <Globe className={`mt-0.5 size-3.5 shrink-0 ${browserUse ? "text-accent" : "text-content/70"}`} strokeWidth={1.75} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-5">操作浏览器</span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-content/50">在右侧第三栏里用真实 Chrome 打开并操作网页</span>
                    </span>
                    {browserUse ? <span className="mt-1 size-1.5 shrink-0 rounded-full bg-accent" /> : null}
                  </button>
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
                if (files) addPrepared(setAttachments, files);
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
              <ToolButton
                active={browserUse}
                disabled={!online || running}
                label={running ? "任务运行中不可切换" : browserUse ? "浏览器操作（已开启）" : "开启浏览器操作"}
                onClick={() =>
                  void setBrowserUseMode(!browserUse)
                    .then(() => toast.success(browserUse ? "浏览器操作已关闭" : "浏览器操作已开启，可以直接给出网址和目标"))
                    .catch(report)
                }
              >
                <Globe className="size-3.5" strokeWidth={1.75} />
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
              <SpeechInput
                title="语音输入"
                aria-label="语音输入"
                onAudioRecorded={transcribeRecording}
                onTranscriptionChange={appendTranscript}
              />
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
