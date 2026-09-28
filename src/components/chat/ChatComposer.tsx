import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { AnimatePresence, m } from "motion/react";
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from "react";
import { useWorkspace } from "../../lib/store";
import { report, request, stop, syncComputerUseMode, syncMultiAgentMode } from "../../lib/rpc";
import { Beam } from "../Effects";
import { Icon } from "../Icon";
import { PromptInput, PromptInputSubmit, PromptInputTextarea, type PromptInputMessage } from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import { ComposerModelSelector } from "./ComposerModelSelector";
import { ComposerContext } from "./ComposerContext";
import { ComposerAgentMode } from "./ComposerAgentMode";

type ImageAttachment = { kind: "image"; id: string; name: string; data: string; mimeType: string };
type FileAttachment = { kind: "file"; id: string; name: string; path: string };
type Attachment = ImageAttachment | FileAttachment;
// 草稿与附件分开缓存：草稿由叶子组件自管理，附件留在 ChatComposer，
// 两边各自维护 LRU，互不依赖对方的 state。
const draftCache = new Map<string, string>();
const attachmentCache = new Map<string, Attachment[]>();

function lruCache<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
}

type DraftHandle = { clear: () => void };

// 草稿叶子组件：击键只会重渲染这一个 textarea。此前每次击键都会重建
// 整个 composer（BorderBeam 动画层、模型选择器、模式切换、上下文面板），
// 流式期间这些重渲染与聊天输出争抢主线程，是输入卡顿的主因之一。
const ComposerTextarea = memo(forwardRef<DraftHandle, {
  composerKey: string;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}>(function ComposerTextarea({ composerKey, onKeyDown }, ref) {
  const [draft, setDraft] = useState(() => useWorkspace.getState().draft || draftCache.get(composerKey) || "");
  useImperativeHandle(ref, () => ({ clear: () => setDraft("") }), []);
  useEffect(() => { lruCache(draftCache, composerKey, draft); }, [composerKey, draft]);
  return <PromptInputTextarea placeholder="输入消息，发送给助手…" value={draft} onChange={event => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} />;
}));

function imageAttachments(files: Iterable<File>) {
  return Promise.all(Array.from(files).flatMap(file => file.type.startsWith("image/") ? [new Promise<Attachment>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ kind: "image", id: crypto.randomUUID(), name: file.name || "粘贴的图片", data: String(reader.result).split(",")[1], mimeType: file.type });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })] : []));
}

function blobData(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function nativeClipboardImage(): Promise<ImageAttachment | null> {
  try {
    const image = await readImage();
    try {
      const [{ width, height }, rgba] = await Promise.all([image.size(), image.rgba()]);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) return null;
      return { kind: "image", id: crypto.randomUUID(), name: "粘贴的图片.png", data: await blobData(blob), mimeType: "image/png" };
    } finally {
      await image.close();
    }
  } catch {
    return null;
  }
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const BADGE_TONES: Record<string, string> = {
  pdf: "red", doc: "blue", docx: "blue", pages: "blue", rtf: "blue",
  xls: "green", xlsx: "green", csv: "green", numbers: "green",
  ppt: "orange", pptx: "orange", key: "orange",
  md: "violet", tsx: "violet", ts: "violet", jsx: "violet", js: "violet", py: "violet", rs: "violet", go: "violet", rb: "violet", java: "violet", c: "violet", cpp: "violet", h: "violet", swift: "violet", kt: "violet", sh: "violet", sql: "violet", html: "violet", css: "violet", json: "violet", yaml: "violet", yml: "violet", toml: "violet", lock: "violet",
  zip: "amber", rar: "amber", "7z": "amber", tar: "amber", gz: "amber", dmg: "amber",
  mp4: "pink", mov: "pink", mp3: "pink", wav: "pink", aac: "pink",
};

function fileBadge(name: string): { text: string; tone: string } {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const text = (extension || "file").slice(0, 4).toUpperCase();
  return { text, tone: BADGE_TONES[extension] ?? "neutral" };
}

function fileKindLabel(name: string): string {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return extension ? extension.toUpperCase() : "文件";
}

export const ChatComposer = memo(function ChatComposer({ compacting, onSubmitted }: { compacting: boolean; onSubmitted: () => void }) {
  const project = useWorkspace(state => state.cwd);
  const connectionId = useWorkspace(state => state.connectionId);
  const transcriptRunning = useWorkspace(state => state.transcript.running);
  const online = useWorkspace(state => state.connection === "online");
  const runtimeTarget = useWorkspace(state => state.runtimeTarget);
  const composerKey = connectionId || project;
  const [attachments, setAttachments] = useState<Attachment[]>(() => attachmentCache.get(composerKey) ?? []);
  const draftRef = useRef<DraftHandle>(null);
  const deliveryOverride = useRef<"steer" | "followUp" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerForm = useRef<HTMLFormElement>(null);
  const handleDraftKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) deliveryOverride.current = event.altKey ? "followUp" : "steer";
  }, []);

  const addFilePaths = useCallback((paths: string[]) => {
    if (!paths.length) return;
    void Promise.all(paths.map(async path => {
      const name = path.split("/").pop() || path.split("\\").pop() || path;
      if (IMAGE_EXTENSIONS.has(name.includes(".") ? name.split(".").pop()!.toLowerCase() : "")) {
        try {
          const file = await invoke<{ name: string; data: string; mimeType: string }>("read_file_attachment", { path });
          return { kind: "image", id: crypto.randomUUID(), ...file } as Attachment;
        } catch { /* fall through to a path chip */ }
      }
      return { kind: "file", id: crypto.randomUUID(), name, path } as Attachment;
    })).then(next => setAttachments(current => [...current, ...next])).catch(report);
  }, []);

  useEffect(() => {
    const pasteInto = async (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".composer")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      const fileImages = files.filter(file => file.type.startsWith("image/"));
      const images = fileImages.length > 0 ? fileImages : Array.from(event.clipboardData?.items ?? []).flatMap(item => {
        if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
        const file = item.getAsFile();
        return file ? [file] : [];
      });
      if (images.length > 0) {
        event.preventDefault();
        void imageAttachments(images).then(next => setAttachments(current => [...current, ...next])).catch(report);
        return;
      }
      // WebKit can omit clipboard image/file payloads, especially on Linux.
      // Ask the native clipboard for file paths first, then raw image pixels.
      if (files.length === 0 && !event.clipboardData?.getData("text/plain")) {
        event.preventDefault();
        const paths = await invoke<string[]>("clipboard_file_paths");
        if (paths.length > 0) {
          addFilePaths(paths);
          return;
        }
        const image = await nativeClipboardImage();
        if (image) setAttachments(current => [...current, image]);
      }
    };
    window.addEventListener("paste", listener);
    function listener(event: ClipboardEvent) { void pasteInto(event); }
    return () => window.removeEventListener("paste", listener);
  }, [addFilePaths]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(event => {
      if (event.payload.type === "drop") addFilePaths(event.payload.paths);
    }).then(dispose => { unlisten = dispose; });
    return () => unlisten?.();
  }, [addFilePaths]);

  useEffect(() => { lruCache(attachmentCache, composerKey, attachments); }, [attachments, composerKey]);

  async function submit(message: PromptInputMessage) {
    const streamingBehavior = deliveryOverride.current ?? "steer";
    deliveryOverride.current = null;
    useWorkspace.getState().event({ type: "prompt_submitted" });
    const previewId = `queued-${crypto.randomUUID()}`;
    try {
      if (!transcriptRunning) await Promise.all([syncMultiAgentMode(project), syncComputerUseMode(project)]);
    const fileChips = attachments.filter((attachment): attachment is FileAttachment => attachment.kind === "file");
    const images = attachments.filter((attachment): attachment is ImageAttachment => attachment.kind === "image");
    const prefix = fileChips.map(attachment => `[文件] ${attachment.path}`).join("\n");
    const text = prefix ? `${prefix}\n\n${message.text}`.trim() : message.text;
      if (transcriptRunning) {
        const content = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...images.map(attachment => ({ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType })),
        ];
        useWorkspace.getState().event({
          type: "queued_preview",
          id: previewId,
          message: { role: "user", content: content.length === 1 && content[0]?.type === "text" ? text : content, timestamp: Date.now() },
        });
      }
      await request({ type: "prompt", message: text, images: images.map(attachment => ({ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType })), ...(transcriptRunning ? { streamingBehavior } : {}) }, 45000, project);
      setAttachments([]);
      draftRef.current?.clear();
      onSubmitted();
    } catch (error) {
      if (transcriptRunning) useWorkspace.getState().event({ type: "queued_preview_revert", id: previewId });
      report(error);
    }
  }

  return <div className="composer-container tessera-composer-dock"><div className="tessera-composer-form">
    <Beam className="studio-composer-beam" size="line" borderRadius={14} active={transcriptRunning || compacting}>
      <PromptInput ref={composerForm} onSubmit={message => void submit(message)} className="composer studio-composer" allowEmpty={attachments.length > 0}>
        <AnimatePresence>{attachments.length > 0 && <m.div className="attachments" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
          {attachments.map(attachment => attachment.kind === "image"
            ? <div className="attachment-preview" key={attachment.id}><img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} decoding="async" /><Button type="button" variant="secondary" size="icon" className="attachment-remove" title={`移除 ${attachment.name}`} aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><Icon name="x" /></Button></div>
            : <div className="attachment-file" key={attachment.id}>
              <span className={`attachment-file-badge tone-${fileBadge(attachment.name).tone}`}>{fileBadge(attachment.name).text}</span>
              <span className="attachment-file-meta">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>{fileKindLabel(attachment.name)}</small>
              </span>
              <Button type="button" variant="secondary" size="icon" className="attachment-remove" title={`移除 ${attachment.name}`} aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><Icon name="x" /></Button>
            </div>)}
        </m.div>}</AnimatePresence>
        {/* key 变化时重挂载叶子，草稿按项目/连接取缓存 */}
        <ComposerTextarea key={composerKey} ref={draftRef} composerKey={composerKey} onKeyDown={handleDraftKeyDown} />
        <div className="composer-bottom">
          <input type="file" multiple accept="image/*" hidden ref={fileInput} onChange={event => { const files = event.target.files; if (files) void imageAttachments(files).then(next => setAttachments(current => [...current, ...next])).catch(report); event.target.value = ""; }} />
          <div className="composer-tool-cluster"><Button variant="ghost" className="size-8 rounded-full p-0 text-muted-foreground hover:text-foreground hover:bg-accent" aria-label="上传附件" title="上传图片" onClick={() => fileInput.current?.click()}><Icon name="plus" className="size-4" /></Button></div>
          <ComposerModelSelector />
          <ComposerAgentMode />
          {runtimeTarget !== "mobile" && <ComposerContext container={composerForm} />}
          <PromptInputSubmit status={transcriptRunning ? "streaming" : "ready"} disabled={!online} title={transcriptRunning ? "暂停生成" : "发送消息"} aria-label={transcriptRunning ? "暂停生成" : "发送消息"} onClick={transcriptRunning ? () => void stop().catch(report) : undefined} />
        </div>
      </PromptInput>
    </Beam>
  </div></div>;
});
