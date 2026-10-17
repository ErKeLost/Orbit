/**
 * 图片编码 Worker：putImageData → 长边降采样 → PNG 编码，全程不占主线程。
 * 见 src/lib/image-encode.ts 的说明。
 *
 * 另外提供 base64 转换：把附件发给 Pi 前必须转成 base64，几 MB 的截图在主线程
 * 上转要几百毫秒（弱机器 1~2 秒），正是"发图片卡一下"的来源。
 */
import { PNG_FALLBACK_BYTES } from "./image-limits";

type EncodeRequest = { kind: "encode"; id: number; width: number; height: number; rgba: ArrayBuffer; mimeType: string; maxEdge: number };
type Base64Request = { kind: "base64"; id: number; buffer: ArrayBuffer };
type WorkerRequest = EncodeRequest | Base64Request;
type WorkerResponse = { id: number; blob?: Blob; mimeType?: string; base64?: string; error?: string };

const post = (message: WorkerResponse) => (self as unknown as { postMessage: (message: WorkerResponse) => void }).postMessage(message);

const CHUNK = 0x8000;

/** 分块拼字符串：String.fromCharCode 一次吃不下大数组（参数上限/调用栈）。 */
function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * PNG 是截图的正确默认值（字形不带振铃），但一张 Retina 照片或噪声渐变仍能编到
 * 好几 MB，而那些字节就是纯上传延迟。过了阈值就把同一块 canvas 再编一次 JPEG ——
 * 不用重画，canvas 还在手上，代价只是多一遍编码。
 */
async function handleEncode(request: EncodeRequest) {
  const { width, height, rgba, mimeType, maxEdge } = request;
  const source = new OffscreenCanvas(width, height);
  const context = source.getContext("2d");
  if (!context) throw new Error("无法创建 2D 上下文");
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  let target = source;
  if (scale < 1) {
    target = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const scaledContext = target.getContext("2d");
    if (!scaledContext) throw new Error("无法创建 2D 上下文");
    scaledContext.imageSmoothingQuality = "high";
    scaledContext.drawImage(source, 0, 0, target.width, target.height);
  }

  const blob = await target.convertToBlob({ type: mimeType });
  if (mimeType === "image/png" && blob.size > PNG_FALLBACK_BYTES) {
    return { blob: await target.convertToBlob({ type: "image/jpeg", quality: 0.9 }), mimeType: "image/jpeg" };
  }
  return { blob, mimeType };
}

async function handleBase64(request: Base64Request) {
  return toBase64(request.buffer);
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const work = request.kind === "base64"
    ? handleBase64(request).then(base64 => post({ id: request.id, base64 }))
    : handleEncode(request).then(({ blob, mimeType: encoded }) => post({ id: request.id, blob, mimeType: encoded }));
  void work.catch(error => {
    post({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  });
});
