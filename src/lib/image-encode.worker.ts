/**
 * 图片编码 Worker：putImageData → 长边降采样 → PNG 编码，全程不占主线程。
 * 见 src/lib/image-encode.ts 的说明。
 *
 * 另外提供 base64 转换：把附件发给 Pi 前必须转成 base64，几 MB 的截图在主线程
 * 上转要几百毫秒（弱机器 1~2 秒），正是"发图片卡一下"的来源。
 */
type EncodeRequest = { kind: "encode"; id: number; width: number; height: number; rgba: ArrayBuffer; mimeType: string; maxEdge: number };
type Base64Request = { kind: "base64"; id: number; buffer: ArrayBuffer };
type WorkerRequest = EncodeRequest | Base64Request;
type WorkerResponse = { id: number; blob?: Blob; base64?: string; error?: string };

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

  return target.convertToBlob({ type: mimeType });
}

async function handleBase64(request: Base64Request) {
  return toBase64(request.buffer);
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const work = request.kind === "base64"
    ? handleBase64(request).then(base64 => post({ id: request.id, base64 }))
    : handleEncode(request).then(blob => post({ id: request.id, blob }));
  void work.catch(error => {
    post({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  });
});
