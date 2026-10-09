import { useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "../../lib/native";
import { Image as ClipboardImage } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { base64ToBlob } from "../../lib/image-bytes";
import { desktopRuntime, ensureSessionModes, report, sendPrompt } from "../../lib/rpc";
import { useWorkspace } from "../../lib/store";
import { Modal } from "../../shared/ui/Modal";
import { ImageLightbox } from "../../shared/ui/ImageLightbox";
import { MenuItem, MenuSeparator, PointMenu, TextArea } from "../../shared/ui/controls";
import { Copy, FolderOpen, ArrowDownCircle, Sparkles, Loader } from "../../shared/ui/icons";

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

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(false);
  const pick = (action: () => void) => { setMenu(null); action(); };

  return <>
    <div
      className="tool-image-frame cursor-zoom-in"
      onClick={() => { if (dataUrl) setZoom(true); }}
      onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}
    >
      {children}
    </div>
    {menu ? (
      <PointMenu x={menu.x} y={menu.y} label="图片操作" width={232} onClose={() => setMenu(null)}>
        <MenuItem disabled={!path || !desktop} icon={<Sparkles strokeWidth={1.75} />} onClick={() => pick(startEditing)}>AI 编辑这张图…</MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!decoded || busy === "save"} icon={<ArrowDownCircle strokeWidth={1.75} />} onClick={() => pick(() => void run("save", async () => {
          const destination = await saveDialog({ defaultPath: suggestedName(path, decoded?.mimeType ?? "image/png"), title: "保存图片" });
          if (!destination) return;
          await invoke<string>("save_media_file", { data: decoded?.base64 ?? "", destination });
          notify("图片已保存");
        }))}>另存为…</MenuItem>
        <MenuItem disabled={!path || !desktop} icon={<FolderOpen strokeWidth={1.75} />} onClick={() => pick(() => void run("reveal", async () => { if (path) await revealItemInDir(path); }))}>在文件夹中显示</MenuItem>
        <MenuSeparator />
        <MenuItem disabled={!decoded || !desktop} icon={<Copy strokeWidth={1.75} />} onClick={() => pick(() => void run("copy", async () => {
          if (!decoded) return;
          await copyPixels(decoded.base64, decoded.mimeType);
          notify("图片已复制到剪贴板");
        }))}>复制图片</MenuItem>
        <MenuItem disabled={!path} onClick={() => pick(() => void run("copy-path", async () => { if (path) await navigator.clipboard.writeText(path); notify("文件路径已复制"); }))}>复制文件路径</MenuItem>
        <MenuItem disabled={!prompt} onClick={() => pick(() => void run("copy-prompt", async () => { if (prompt) await navigator.clipboard.writeText(prompt); notify("提示词已复制"); }))}>复制提示词</MenuItem>
      </PointMenu>
    ) : null}
    {zoom && dataUrl ? <ImageLightbox src={dataUrl} alt={prompt ?? "生成的图片"} onClose={() => setZoom(false)} /> : null}
    {editing ? (
      <Modal title="AI 编辑这张图" description="把这张图作为参考图重新生成" size="md" onClose={() => setEditing(false)}>
        <form className="flex flex-col gap-3.5 p-4 text-[13px]" onSubmit={event => { event.preventDefault(); void submitEdit(); }}>
          <div className="flex gap-3">
            {dataUrl ? <img className="size-20 shrink-0 rounded-lg border border-content/10 object-cover" src={dataUrl} alt="参考图" /> : null}
            <p className="text-[12px] leading-relaxed text-content/55">可以只改一处（比如「换成夜景」「去掉杯子」），也可以重写整段描述。</p>
          </div>
          <TextArea autoFocus rows={6} value={draft} onChange={event => setDraft(event.target.value)} placeholder="描述你想怎么改…" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="rounded-md px-3 py-1.5 hover:bg-content/8 active:scale-[0.97]">取消</button>
            <button type="submit" disabled={!draft.trim() || busy === "edit"} className="inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 font-medium text-background-base hover:bg-content/80 active:scale-[0.97] disabled:opacity-40">
              {busy === "edit" ? <Loader className="size-3.5 animate-spin" /> : null}
              生成
            </button>
          </div>
        </form>
      </Modal>
    ) : null}
  </>;
}
