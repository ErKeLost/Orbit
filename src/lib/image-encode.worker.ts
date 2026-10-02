/**
 * 图片编码 Worker：putImageData → 长边降采样 → PNG 编码，全程不占主线程。
 * 见 src/lib/image-encode.ts 的说明。
 */
type EncodeRequest = { id: number; width: number; height: number; rgba: ArrayBuffer; mimeType: string; maxEdge: number };
type EncodeResponse = { id: number; blob?: Blob; error?: string };

const post = (message: EncodeResponse) => (self as unknown as { postMessage: (message: EncodeResponse) => void }).postMessage(message);

async function handle(request: EncodeRequest) {
  try {
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
    post({ id: request.id, blob });
  } catch (error) {
    post({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
}

self.addEventListener("message", (event: MessageEvent<EncodeRequest>) => { void handle(event.data) });
