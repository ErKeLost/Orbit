/**
 * 在 Worker 里把剪贴板拿到的 RGBA 编成图片 Blob。
 *
 * `canvas.toBlob()` 的 PNG 编码是同步占用主线程的：2560×1680（4.3MP）≈ 50ms，
 * 5120×2880（14.7MP）≈ 172ms —— 粘贴截图时"卡一下"就是它，正好撞在流式输出的
 * 主线程碎片上。这里把整段工作（putImageData + 降采样 + PNG 编码）挪到 Worker
 * 的 OffscreenCanvas 上，RGBA 用 transferable 零拷贝过去。
 *
 * 另外顺手做长边降采样：截图常带 2x Retina 尺寸（14.7MP），编码耗时和 base64
 * 体积都随像素数走，降到长边 2048 之后文字依然清晰，但编码从 172ms 掉到 ~15ms。
 */

export type RgbaImage = { width: number; height: number; rgba: Uint8Array };

/** 长边上限；只缩小不放大。 */
export const MAX_IMAGE_EDGE = 2048;

const ENCODE_TIMEOUT_MS = 20_000;

type EncodeRequest = { id: number; width: number; height: number; rgba: ArrayBuffer; mimeType: string; maxEdge: number };
type EncodeResponse = { id: number; blob?: Blob; error?: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void; timer: number }>();

function workerSupported() {
  return typeof Worker !== "undefined"
    && typeof OffscreenCanvas === "function"
    && typeof OffscreenCanvas.prototype.convertToBlob === "function"
    && typeof ImageData === "function";
}

function ensureWorker() {
  if (worker) return worker;
  const created = new Worker(new URL("./image-encode.worker.ts", import.meta.url), { type: "module" });
  created.addEventListener("error", () => {
    // Worker 起不来/挂了：让所有在途请求失败，调用方会退回主线程路径。
    for (const [id, entry] of pending) {
      window.clearTimeout(entry.timer);
      entry.reject(new Error("图片编码 Worker 不可用"));
      pending.delete(id);
    }
    created.terminate();
    if (worker === created) worker = null;
  });
  created.addEventListener("message", (event: MessageEvent<EncodeResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    window.clearTimeout(entry.timer);
    if (event.data.blob) entry.resolve(event.data.blob);
    else entry.reject(new Error(event.data.error ?? "图片编码失败"));
  });
  worker = created;
  return created;
}

function encodeInWorker(image: RgbaImage, mimeType: string): Promise<Blob> {
  const target = ensureWorker();
  const id = nextId++;
  return new Promise<Blob>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error("图片编码超时"));
    }, ENCODE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    // 只有整块 buffer 就是这块像素时才敢 transfer（否则切片，避免把别人的内存搬走）。
    const exact = image.rgba.byteOffset === 0 && image.rgba.byteLength === image.rgba.buffer.byteLength;
    const request: EncodeRequest = {
      id,
      width: image.width,
      height: image.height,
      rgba: exact ? image.rgba.buffer as ArrayBuffer : image.rgba.slice().buffer as ArrayBuffer,
      mimeType,
      maxEdge: MAX_IMAGE_EDGE,
    };
    try {
      target.postMessage(request, [request.rgba]);
    } catch (error) {
      window.clearTimeout(timer);
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function encodeOnMainThread(image: RgbaImage, mimeType: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) { reject(new Error("无法创建 2D 上下文")); return; }
    context.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height));
    if (scale >= 1) {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片编码失败")), mimeType);
      return;
    }
    const scaled = document.createElement("canvas");
    scaled.width = Math.max(1, Math.round(image.width * scale));
    scaled.height = Math.max(1, Math.round(image.height * scale));
    const scaledContext = scaled.getContext("2d");
    if (!scaledContext) { reject(new Error("无法创建 2D 上下文")); return; }
    scaledContext.imageSmoothingQuality = "high";
    scaledContext.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    scaled.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片编码失败")), mimeType);
  });
}

/**
 * RGBA → 图片 Blob（默认在 Worker 里做）。
 * 只在 Worker 真的不可用时才退到主线程；调用方拿到异常时可以重新读一次剪贴板再试。
 */
export async function encodeClipboardImage(image: RgbaImage, mimeType = "image/png"): Promise<Blob> {
  if (workerSupported()) return encodeInWorker(image, mimeType);
  return encodeOnMainThread(image, mimeType);
}
