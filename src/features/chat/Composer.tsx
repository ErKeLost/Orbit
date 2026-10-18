import { invoke } from "../../lib/native";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useWorkspace } from "../../lib/store";
import { perfMarkSend } from "../../lib/perf-log";
import { ensureSessionModes, recallQueue, report, request, sendPrompt, setBrowserUseMode, setComputerUseMode, setMultiAgentMode, steerFollowUp, stop, transcribeAudio } from "../../lib/rpc";
import { useSessionTarget } from "../shell/use-session-target";
import { base64ToBlob } from "../../lib/image-bytes";
import { encodeBlobToBase64, encodeClipboardImage } from "../../lib/image-encode";
import { shouldSubmitComposer } from "../../lib/composer";
import { useMetrics } from "../../hooks/use-metrics";
import { useGitBranches } from "../../lib/git";
import { Popover } from "../../shared/ui/Popover";
import { ImageLightbox } from "../../shared/ui/ImageLightbox";
import { toast } from "../../shared/ui/toast";
import { ArrowUp, CursorMagicSelection, Globe, ImagePlus, Square, Sparkles, Ungroup, X, Plus } from "../../shared/ui/icons";
import { FileTypeIcon } from "../shell/FileTypeIcon";
import { ADD_NOTE_TO_CHAT_EVENT, appendNoteReference, type NoteComposerCard } from "../notes/notes";
import { ModelPicker } from "./ModelPicker";
import { BranchPicker } from "./BranchPicker";
import { MessageQueueView } from "./MessageQueueView";
import { ComposerPalette, type PalettePick, type PaletteRequest } from "./ComposerPalette";
import { DraftField, type DraftHandle } from "./ComposerDraftField";
import { useComposerTokens } from "./composerTokens";
import {
  appendDraftText,
  attachmentNameFromPath,
  buildPromptMessage,
  canSubmitPrompt,
  clipboardImageName,
  contextMeterUsage,
  forgetDraft,
  hasCommand,
  historyArrowMode,
  imageAttachment,
  insertPalettePick,
  isImagePath,
  pasteIntent,
  prepareImageFiles,
  previewUserMessage,
  recallAttachments,
  rememberAttachments,
  rememberDraft,
  sendBehavior,
  showsOptimisticPreview,
  splitAttachments,
  suggestCommandMessage,
  type Attachment,
  type ImageAttachment,
} from "./composerModel";
import { expandMentionLabels } from "./fileMentions";
import { ContextMeter } from "./ContextMeter";
import { stepInputHistory, inputHistoryEntries } from "./input-history";
import { loadPromptSuggestion, savePromptSuggestion, transcriptTurn } from "./promptSuggestion";
import { userText } from "./turnModel";
import { SpeechInput } from "../../components/ai-elements/speech-input";
import { ProjectPicker } from "./ProjectPicker";
import { ExtensionDialog } from "../../components/panels/ExtensionDialog";

/**
 * Picked files → attachments that can actually be sent, plus the ones that were
 * refused. A camera JPEG is several megabytes in a single WebSocket frame, and
 * Android's picker returns `content://` sources whose `File.type` is empty often
 * enough that the type has to come from the name; `prepareImageAttachment`
 * decides both, and a file it refuses is reported rather than attached and
 * dropped at the far end.
 */
async function prepareAttachments(files: Iterable<File>): Promise<Attachment[]> {
  const { images, errors } = await prepareImageFiles(
    Array.from(files, (file) => ({ name: file.name, type: file.type, size: file.size, blob: file })),
  );
  errors.forEach(report);
  return images.map(imageAttachment);
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
    return { kind: "image", id: crypto.randomUUID(), name: clipboardImageName(mimeType), mimeType, blob };
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
  const dialog = useWorkspace((state) => state.dialogs[0]);
  // 分支名放在输入框下方：随时能看到当前 checkout，点开就能切分支 / 新建分支。
  const branches = useGitBranches(project).data;
  const composerKey = connectionId || project;
  const tokens = useComposerTokens(project);
  const mentionLabels = tokens.index.labels;
  const [attachments, setAttachments] = useState<Attachment[]>(() => recallAttachments(composerKey));
  const [hasValue, setHasValue] = useState(false);
  const [palette, setPalette] = useState<PaletteRequest | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // 提示词联想（ghost text）：只在每个 run 结束时猜一次，所以默认开着。
  const [suggestEnabled, setSuggestEnabled] = useState(loadPromptSuggestion);
  // 只有当前运行的 Pi 真的注册了这条命令才启用：否则 `/gui-suggest …` 会被当成
  // 普通消息发给模型。
  const suggestAvailable = hasCommand(tokens.commands, "gui-suggest");
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

  useEffect(() => { rememberAttachments(composerKey, attachments); }, [attachments, composerKey]);

  // A different session has a different history; drop any cursor into the old one.
  useEffect(() => {
    historyIndex.current = null;
    historyStash.current = "";
  }, [composerKey]);

  const navigateHistory = useCallback(
    (direction: "up" | "down", caret: { start: number; end: number; length: number }) => {
      const browsing = historyIndex.current !== null;
      if (!historyArrowMode(direction, caret, browsing)) return false;
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
        const name = attachmentNameFromPath(path);
        if (isImagePath(path)) {
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
      // 只在没有文件时才读文本：有文件就是图片粘贴，文本是什么都不影响。
      const intent = pasteIntent({
        files,
        text: files.length === 0 ? (event.clipboardData?.getData("text/plain") ?? "") : "",
        desktop: runtimeTarget === "desktop",
      });
      if (intent.kind === "images") {
        event.preventDefault();
        addPrepared(setAttachments, intent.images);
        return;
      }
      if (intent.kind === "native-clipboard") {
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

  const insertPick = useCallback(
    (pick: PalettePick) => {
      const field = draftRef.current;
      const next = insertPalettePick({ text: field?.value() ?? "", caret: field?.caret() ?? 0, request: palette, pick });
      setPalette(null);
      field?.setText(next.text, next.caret);
    },
    [palette],
  );

  const submit = useCallback(
    async (streamingBehavior: "steer" | "followUp") => {
      const draftText = draftRef.current?.value() ?? "";
      if (!canSubmitPrompt(draftText, attachments.length)) return;
      // The composer shows `@name`; the harness gets a path it can resolve.
      const text = expandMentionLabels(draftText, mentionLabels);
      perfMarkSend();
      const attachmentsAtSend = attachments;
      const { images, files: fileChips } = splitAttachments(attachmentsAtSend);
      // 张数交给等待位：带图的一轮慢在上传，说“正在发送图片”比笼统的“正在思考”
      // 更能区分“在干活”和“卡住了”。
      useWorkspace.getState().event({ type: "prompt_submitted", images: images.length });
      const previewId = `queued-${crypto.randomUUID()}`;
      const message = buildPromptMessage(text, fileChips);
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
      forgetDraft(composerKey);
      rememberAttachments(composerKey, []);
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
      if (showsOptimisticPreview(previewContent.length, running, streamingBehavior)) {
        useWorkspace.getState().event({
          type: "queued_preview",
          id: previewId,
          message: { role: "user", content: previewUserMessage(message, previewContent), timestamp: Date.now() },
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
          rememberDraft(composerKey, draftText);
          rememberAttachments(composerKey, before);
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
      void request({ type: "prompt", message: suggestCommandMessage(draft, turn) }, 30000, target).catch(() => undefined);
    },
    [online, suggestAvailable, target],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!shouldSubmitComposer({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode }, false)) return;
      event.preventDefault();
      if (!online) return;
      // Enter steers a running turn; ⌥Enter queues it as a follow-up.
      void submit(sendBehavior(event.altKey));
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
    const next = appendDraftText(field?.value() ?? "", text);
    field?.setText(next, next.length);
  }, []);

  const context = contextMeterUsage(stats?.contextUsage);
  const queueVisible = queue.steering.length + queue.followUp.length > 0;

  return (
    <div className={`relative mx-auto w-full max-w-4xl ${centered ? "" : "p-1.5 pt-0"}`} data-session-composer>
      {dialog ? <ExtensionDialog key={dialog.id} dialog={dialog} /> : null}
      {queueVisible ? (
        <MessageQueueView
          steering={queue.steering}
          followUp={queue.followUp}
          running={running}
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
            {/* 新会话（首页）：头部带项目选择器，发送前就能切项目 / 不在文件夹里工作。
                会话开始后（centered=false）撤下选择器——中途切范围等于打断会话。 */}
            {centered ? <ProjectPicker disabled={running} /> : null}
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
            <div className="composer-toolbar flex min-w-0 flex-1 items-center gap-1">
              <BranchPicker cwd={project} current={branches?.current ?? null} disabled={running} />
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
