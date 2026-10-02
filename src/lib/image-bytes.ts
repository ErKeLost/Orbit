/**
 * 图片字节与 base64 之间的纯函数工具。
 *
 * 附件在 state 里只存 Blob（预览用 object URL），base64 只在"真正要发给
 * Pi 的那一刻"生成——一张 4.3MP 截图的 base64 有 1.4MB、14.7MP 的有 8MB，
 * 常驻堆里同时存 state 一份 + `<img src>` 一份，是流式期间 GC 停顿的来源之一。
 */

/** 分块拼字符串：String.fromCharCode 一次吃不下大数组（参数上限/调用栈）。 */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  return new Blob([base64ToBytes(base64)], { type: mimeType });
}
