/**
 * A picked image, made small enough to actually reach the model.
 *
 * Two things are true of a phone photo and not of a desktop screenshot, and both
 * of them break the send rather than the view:
 *
 * * **It is huge.** A 12 MP camera JPEG is 4–6 MB, and base64 makes it a third
 *   larger again, in a single WebSocket frame. Pasting a screenshot already goes
 *   through `encodeClipboardImage` and its 2048px ceiling; picking a file did
 *   not, which is the difference between the two ways in.
 * * **It may have no MIME type.** Android's picker hands back a `content://`
 *   source, and `File.type` is empty for enough of them that the desktop path
 *   derives the type from the file name instead. An attachment sent with an
 *   empty `mimeType` reaches the provider as nothing it can decode, and renders
 *   as `data:;base64,…` — which no browser will show either.
 *
 * The decisions are pure and the pixels are behind `ImageCodec`, so the rules
 * below are testable without a canvas, a device or a 6 MB fixture.
 */

/** Extensions worth accepting when the picker does not say what it picked. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
};

/** The long-edge ceiling, the same one a pasted screenshot already gets. */
export const MAX_ATTACHMENT_EDGE = 2048;
/** Under this, an image is sent as it came: re-encoding a small image loses more than it saves. */
export const RECODE_ABOVE_BYTES = 2 * 1024 * 1024;
/** Above this, the attachment is refused by name rather than sent and dropped somewhere. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/**
 * The type of an attachment, from the picker or from the name.
 *
 * Returns null for something that is not an image, which the caller reports:
 * attaching a JPEG as `application/octet-stream` is how it silently stops
 * working at the far end.
 */
export function resolveImageMime(file: { name?: string; type?: string }): string | null {
  const declared = file.type?.trim().toLowerCase();
  if (declared?.startsWith("image/")) return declared;
  const extension = file.name?.split(".").pop()?.toLowerCase();
  const guessed = extension ? MIME_BY_EXTENSION[extension] : undefined;
  return guessed ?? null;
}

/**
 * Whether to re-encode. An image that is already small in both senses is left
 * exactly as it is: the point is to get a phone photo through, not to touch
 * every attachment.
 */
export function shouldReencode({ width, height, bytes }: { width: number; height: number; bytes: number }): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return true;
  return Math.max(width, height) > MAX_ATTACHMENT_EDGE || bytes > RECODE_ABOVE_BYTES;
}

/**
 * What to encode to. PNG stays PNG — a screenshot re-encoded as JPEG puts
 * ringing around every glyph — and everything else becomes JPEG, which is what
 * a photograph wanted anyway.
 */
export function outputMimeFor(inputMime: string): "image/png" | "image/jpeg" {
  return inputMime === "image/png" ? "image/png" : "image/jpeg";
}

export type PreparedImage = { blob: Blob; mimeType: string; name: string; width: number; height: number; recoded: boolean };

/** The pixel work, injected so the decisions above can be tested without it. */
export type ImageCodec = {
  /** Intrinsic size, without keeping the decoded bitmap around. */
  measure(blob: Blob): Promise<{ width: number; height: number }>;
  /** Re-encode at or below `maxEdge`. `image/jpeg` may take a quality setting. */
  rescale(blob: Blob, maxEdge: number, mimeType: string): Promise<Blob>;
};

export async function prepareImageAttachment(
  file: { name: string; type: string; size: number; blob: Blob },
  codec: ImageCodec = browserImageCodec(),
): Promise<PreparedImage> {
  const mimeType = resolveImageMime(file);
  if (!mimeType) throw new Error(`不是图片：${file.name || "未命名文件"}`);
  const base = { name: file.name || "图片", mimeType };
  let size: { width: number; height: number };
  try {
    size = await codec.measure(file.blob);
  } catch {
    // A format the WebView cannot decode (HEIC on older builds) is still a file
    // the user meant to send; keep it whole rather than refusing it here.
    return { ...base, blob: file.blob, width: 0, height: 0, recoded: false };
  }
  if (!shouldReencode({ ...size, bytes: file.size })) {
    return { ...base, blob: file.blob, ...size, recoded: false };
  }
  const blob = await codec.rescale(file.blob, MAX_ATTACHMENT_EDGE, outputMimeFor(mimeType));
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${base.name} 压缩后仍有 ${(blob.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
  }
  return { ...base, blob, mimeType: outputMimeFor(mimeType), ...size, recoded: true };
}

/** The real one: `createImageBitmap` where it exists, a DOM canvas otherwise. */
export function browserImageCodec(): ImageCodec {
  return {
    async measure(blob) {
      if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob);
        try {
          return { width: bitmap.width, height: bitmap.height };
        } finally {
          bitmap.close();
        }
      }
      const image = await loadImageElement(blob);
      return { width: image.naturalWidth, height: image.naturalHeight };
    },
    async rescale(blob, maxEdge, mimeType) {
      const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : await loadImageElement(blob);
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      if (typeof OffscreenCanvas === "function") {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法创建 2D 上下文");
        context.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
        return canvas.convertToBlob({ type: mimeType, quality: 0.85 });
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建 2D 上下文");
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("图片编码失败"))), mimeType, 0.85);
      });
    },
  };
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法解码图片"));
    };
    image.src = url;
  });
}
