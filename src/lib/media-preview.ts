import { formatBytes, type MediaKind } from "./media";

/**
 * How a media file gets from the machine that owns it to the screen showing it.
 *
 * The desktop webview streams through Tauri's asset protocol, which is "this
 * webview reads this machine's disk" — a sentence, and a URL shape, that means
 * nothing on a paired phone: the file is not on the phone, and the relay only
 * forwards the pairing socket, so there is no address the WebView could fetch.
 * The phone asks for the bytes over that socket instead (`read_media_file`) and
 * points the same `<img>`/`<video>` markup at an object URL.
 *
 * The cap is what makes this a decision rather than a branch. base64 in a
 * webview is memory, and a phone asked to hold a video does not degrade
 * gracefully; past the limit the honest answer is the one the desktop already
 * gives for a file it cannot preview. `media_meta` answers with the size first,
 * so the doomed request is not sent — and if it is, the command refuses with its
 * own message, which stays the authority. This constant mirrors
 * `media::MAX_REMOTE_MEDIA_BYTES`; `tests/media-preview.test.ts` fails if the
 * two drift.
 */
export const MAX_REMOTE_PREVIEW_BYTES = 24 * 1024 * 1024;

/** The noun a preview names, so a refusal says which kind it is refusing. */
export const MEDIA_LABEL: Record<MediaKind, string> = { image: "图片", audio: "音频", video: "视频", pdf: "PDF" };

export type MediaPreviewPlan =
  /** The desktop: let the asset protocol stream it, with no size limit. */
  | { mode: "asset" }
  /** A phone: fetch the bytes over the pairing socket. */
  | { mode: "socket" }
  /** A phone, and the file is too large to be worth sending. */
  | { mode: "blocked"; message: string };

export function planMediaPreview({ remote, kind, size }: {
  /** Whether this window is a paired phone rather than the machine with the disk. */
  remote: boolean;
  kind: MediaKind;
  /** `media_meta`'s size, or `null` while it is unknown or unreadable. */
  size: number | null;
}): MediaPreviewPlan {
  if (!remote) return { mode: "asset" };
  // Size unknown: ask anyway and let the Host refuse with its own reason, rather
  // than inventing a second refusal here that could disagree with it.
  if (size === null) return { mode: "socket" };
  if (size > MAX_REMOTE_PREVIEW_BYTES) return { mode: "blocked", message: tooLargeMessage(kind, size) };
  return { mode: "socket" };
}

export function tooLargeMessage(kind: MediaKind, size: number): string {
  const limit = formatBytes(MAX_REMOTE_PREVIEW_BYTES);
  return `${MEDIA_LABEL[kind]} ${formatBytes(size)}，超过手机预览上限 ${limit}；请在电脑上查看`;
}

/**
 * base64 → bytes, for the socket path.
 *
 * Media is bytes, not text, so nothing here may treat it as a string: a JPEG has
 * no characters. Throws on malformed input, which the caller reports exactly the
 * way it reports any other failed fetch.
 *
 * The return type names its buffer on purpose. A byte array over a
 * `SharedArrayBuffer` is not a `BlobPart`, and spelling out `ArrayBuffer` is
 * what lets these bytes go straight into a `Blob` with no cast.
 */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
