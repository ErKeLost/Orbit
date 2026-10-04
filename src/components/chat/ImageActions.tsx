import { useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Image as ClipboardImage } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { base64ToBlob } from "../../lib/image-bytes";
import { desktopRuntime, ensureSessionModes, report, sendPrompt } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { Icon } from "../Icon";
import { Button } from "../UI";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Textarea } from "../ui/textarea";

const EXTENSIONS: Record<string, string> = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", gif: "gif" };

function notify(message: string) {
  useWorkspace.getState().set({ notices: [...useWorkspace.getState().notices, message].slice(-5) });
}

/** `data:image/jpeg;base64,…` → `{ mimeType, base64 }`, or null for anything else. */
function splitDataUrl(dataUrl: string | null) {
  if (!dataUrl) return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1] ?? "image/png", base64: match[2] ?? "" };
}

function suggestedName(path: string | undefined, mimeType: string) {
  const fromPath = path?.split(/[\\/]/).filter(Boolean).at(-1);
  if (fromPath) return fromPath;
  const extension = EXTENSIONS[mimeType.split("/")[1]?.toLowerCase() ?? ""] ?? "png";
  return `orbit-image-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${extension}`;
}

/** Copy the decoded pixels, because the clipboard plugin also accepts paths. */
async function copyPixels(base64: string, mimeType: string) {
  const bitmap = await createImageBitmap(base64ToBlob(base64, mimeType));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法读取图片像素");
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  await writeImage(await ClipboardImage.new(new Uint8Array(data.buffer), width, height));
}

async function sendEditPrompt(path: string, description: string) {
  const store = useWorkspace.getState();
  const project = store.cwd;
  const running = store.transcript.running;
  store.event({ type: "prompt_submitted" });
  try {
    if (!running) await ensureSessionModes(project);
    await sendPrompt(
      { type: "prompt", message: `以 ${path} 为参考图重新生成：${description}`, images: [], ...(running ? { streamingBehavior: "steer" as const } : {}) },
      project,
      running,
    );
  } catch (error) {
    // 模式同步这一步失败也会走到这里，等待位同样要撤下（未置位时是空操作）。
    store.event({ type: "prompt_settled" });
    throw error;
  }
}

type ImageActionsMenuProps = {
  /** The rendered image, as a `data:` URL, or null while it is still generating. */
  dataUrl: string | null;
  /** Local file the runtime wrote, when the tool result reported one. */
  path?: string;
  /** The prompt that produced the image, reused as the edit draft. */
  prompt?: string;
  children: ReactNode;
};

/**
 * Right-click actions for a generated image: edit it again with AI (reusing the
 * file as a reference image), save a copy, reveal it, and copy it or its text.
 */
export function ImageActionsMenu({ dataUrl, path, prompt, children }: ImageActionsMenuProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const decoded = splitDataUrl(dataUrl);
  const desktop = isTauri() && desktopRuntime();

  async function run(kind: string, action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }

  function startEditing() {
    if (!path) return;
    setDraft(prompt?.trim() ?? "");
    setEditing(true);
  }

  async function submitEdit() {
    if (!path) return;
    const description = draft.trim();
    if (!description) return;
    await run("edit", async () => {
      await sendEditPrompt(path, description);
      setEditing(false);
      notify("已把这张图作为参考图发给助手");
    });
  }

  return <>
    <ContextMenu>
      <ContextMenuTrigger render={<div className="tool-image-frame" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem disabled={!path || !desktop} onClick={startEditing}><Icon name="sparkle" />AI 编辑这张图…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!decoded || busy === "save"} onClick={() => void run("save", async () => {
          const destination = await saveDialog({ defaultPath: suggestedName(path, decoded?.mimeType ?? "image/png"), title: "保存图片" });
          if (!destination) return;
          await invoke<string>("save_media_file", { data: decoded?.base64 ?? "", destination });
          notify("图片已保存");
        })}><Icon name="download" />另存为…</ContextMenuItem>
        <ContextMenuItem disabled={!path || !desktop} onClick={() => void run("reveal", async () => { if (path) await revealItemInDir(path); })}><Icon name="folder-open" />在文件夹中显示</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!decoded || !desktop} onClick={() => void run("copy", async () => {
          if (!decoded) return;
          await copyPixels(decoded.base64, decoded.mimeType);
          notify("图片已复制到剪贴板");
        })}><Icon name="copy" />复制图片</ContextMenuItem>
        <ContextMenuItem disabled={!path} onClick={() => void run("copy-path", async () => { if (path) await navigator.clipboard.writeText(path); notify("文件路径已复制"); })}><Icon name="copy" />复制文件路径</ContextMenuItem>
        <ContextMenuItem disabled={!prompt} onClick={() => void run("copy-prompt", async () => { if (prompt) await navigator.clipboard.writeText(prompt); notify("提示词已复制"); })}><Icon name="copy" />复制提示词</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    <Dialog open={editing} onOpenChange={next => { if (!next) setEditing(false); }}>
      <DialogContent className="image-edit-dialog">
        <DialogHeader><DialogTitle>AI 编辑这张图</DialogTitle></DialogHeader>
        <div className="image-edit-body">
          {dataUrl && <img className="image-edit-thumb" src={dataUrl} alt="参考图" />}
          <p className="image-edit-hint">把这张图片作为参考图重新生成，可以只改一处（比如「换成夜景」「去掉杯子」），也可以重写整段描述。</p>
          <Textarea autoFocus rows={6} value={draft} onChange={event => setDraft(event.target.value)} placeholder="描述你想怎么改…" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditing(false)}>取消</Button>
          <Button disabled={!draft.trim() || busy === "edit"} onClick={() => void submitEdit()}>{busy === "edit" ? "正在发送…" : "生成"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
