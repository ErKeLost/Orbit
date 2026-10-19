/**
 * The composer's decisions, without the composer.
 *
 * Everything that can be answered from plain values lives here: what a pick
 * writes into the draft, whether an arrow key is history or caret movement,
 * which attachments a paste is asking for, and what can actually be sent. The
 * view keeps the parts that need a textarea, an event or the Tauri bridge.
 */

import { prepareImageAttachment, resolveImageMime, type PreparedImage } from "../../lib/image-attachment";
import type { PalettePick, PaletteRequest } from "./ComposerPalette";

export type ImageAttachment = { kind: "image"; id: string; name: string; mimeType: string; blob: Blob };
export type FileAttachment = { kind: "file"; id: string; name: string; path: string };
export type Attachment = ImageAttachment | FileAttachment;

/** Extensions we are willing to re-open through `read_file_attachment`. */
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/**
 * Drafts and attachments survive a composer remount (home → session, session →
 * home), which is the difference between "my unsent text is still here" and
 * "the app ate it". Four keys is enough for the panes of a split view.
 */
const CACHE_LIMIT = 4;
export const draftCache = new Map<string, string>();
export const attachmentCache = new Map<string, Attachment[]>();

export function lruCache<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

export function forgetDraft(key: string): void {
  draftCache.delete(key);
}

export function rememberDraft(key: string, draft: string): void {
  lruCache(draftCache, key, draft);
}

export function rememberAttachments(key: string, attachments: Attachment[]): void {
  lruCache(attachmentCache, key, attachments);
}

export function recallDraft(key: string): string {
  return draftCache.get(key) ?? "";
}

export function recallAttachments(key: string): Attachment[] {
  return attachmentCache.get(key) ?? [];
}

/** Picked files, structurally, so the model stays free of `File` globals. */
export type PickedFile = { name: string; type: string; size: number; blob: Blob };

/**
 * Picked files → attachments that can actually be sent, plus the ones that were
 * refused. A camera JPEG is several megabytes in a single WebSocket frame, and
 * Android's picker returns `content://` sources whose `File.type` is empty often
 * enough that the type has to come from the name; `prepareImageAttachment`
 * decides both, and a file it refuses is reported by the caller rather than
 * attached and dropped at the far end.
 */
export async function prepareImageFiles<T extends PickedFile>(
  files: Iterable<T>,
  prepare: (file: PickedFile) => Promise<PreparedImage> = prepareImageAttachment,
): Promise<{ images: PreparedImage[]; errors: unknown[] }> {
  const settled = await Promise.all(
    Array.from(files).map(async (file) => {
      try {
        return { image: await prepare(file), error: null as unknown };
      } catch (error) {
        return { image: null as PreparedImage | null, error };
      }
    }),
  );
  const images: PreparedImage[] = [];
  const errors: unknown[] = [];
  for (const item of settled) {
    if (item.image) images.push(item.image);
    else errors.push(item.error);
  }
  return { images, errors };
}

export function imageAttachment(image: PreparedImage): ImageAttachment {
  return { kind: "image", id: crypto.randomUUID(), name: image.name, mimeType: image.mimeType, blob: image.blob };
}

/** What a paste is asking for, before any of it is awaited. */
export type PasteIntent<T> =
  | { kind: "images"; images: T[] }
  /** Real files the DOM handed us, and at least one is not an image: the paths come from the native clipboard. */
  | { kind: "files"; files: T[] }
  | { kind: "native-clipboard" }
  | { kind: "text" };

/**
 * A paste inside the composer box.
 *
 * Files win: a screenshot arrives as both a file and (sometimes) no text. A set
 * of files that is not all images (a video, a PDF, a .zip) is still an
 * attachment, so it is not allowed to fall through as text. With nothing in the
 * DOM at all, the paste is a native one — Finder paths or a screenshot the
 * clipboard manager did not expose as a file — and has to be read through the
 * bridge. Anything else is ordinary text and keeps the browser's default insert.
 */
export function pasteIntent<T extends { name?: string; type?: string }>(input: {
  files: readonly T[];
  text: string;
  desktop: boolean;
}): PasteIntent<T> {
  const images = input.files.filter((file) => resolveImageMime(file) !== null);
  if (images.length === input.files.length && images.length > 0) return { kind: "images", images };
  if (input.files.length) return input.desktop ? { kind: "files", files: [...input.files] } : { kind: "text" };
  if (!input.text && input.desktop) return { kind: "native-clipboard" };
  return { kind: "text" };
}

/**
 * Whether pasted text could be a file reference rather than prose. Only then is
 * it worth asking the native clipboard whether it holds files: the answer costs
 * a bridge call, and a paste of ordinary code must not pay for it.
 *
 * A whole absolute path (`/…`, `~/…`, `file://…`, `C:\…`) or anything that ends
 * in an extension (`demo.mp4`, `报价单.pdf`, several of them on separate lines)
 * both count. Finder's ⌘V does not say which of the two it will hand over, and a
 * name with spaces is still a name. A false positive costs one probe and
 * nothing else: prose the clipboard does not back as a file is left as text.
 */
export function couldBeFileReference(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 50 || text.length > 2000) return false;
  return lines.every(
    (line) => /^(?:file:\/\/|\/|~\/|[A-Za-z]:[\\/])/.test(line) || /^.{1,200}\.[A-Za-z0-9]{1,8}$/.test(line),
  );
}

/** The draft without the text a paste just inserted, when that text is still its tail. */
export function stripPastedSuffix(draft: string, pasted: string): string {
  return pasted && draft.endsWith(pasted) ? draft.slice(0, -pasted.length) : draft;
}

/** `~/shots/x.PNG` → `x.PNG`, with the last segment kept whole. */
export function attachmentNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function isImageFileName(name: string): boolean {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(extension);
}

export function isImagePath(path: string): boolean {
  return isImageFileName(attachmentNameFromPath(path));
}

/**
 * Large screenshots are re-encoded as JPEG by `encodeClipboardImage`, so the
 * name follows the bytes rather than assuming PNG.
 */
export function clipboardImageName(mimeType: string): string {
  return `粘贴的图片.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
}

/** Attachments split the way a send needs them: bytes first, path chips second. */
export function splitAttachments(attachments: readonly Attachment[]): { images: ImageAttachment[]; files: FileAttachment[] } {
  return {
    images: attachments.filter((item): item is ImageAttachment => item.kind === "image"),
    files: attachments.filter((item): item is FileAttachment => item.kind === "file"),
  };
}

/**
 * The prompt Pi receives. File chips become `[文件] <path>` lines because a chip
 * carries a path, not text; an empty draft with only chips still sends.
 */
export function buildPromptMessage(text: string, files: readonly FileAttachment[]): string {
  const prefix = files.map((item) => `[文件] ${item.path}`).join("\n");
  return prefix ? `${prefix}\n\n${text}`.trim() : text;
}

/** Nothing to send: neither text nor an attachment. */
export function canSubmitPrompt(text: string, attachmentCount: number): boolean {
  return Boolean(text.trim()) || attachmentCount > 0;
}

/** Enter steers a running turn; ⌥Enter queues it as a follow-up. */
export function sendBehavior(altKey: boolean): "steer" | "followUp" {
  return altKey ? "followUp" : "steer";
}

/**
 * A steer goes into the running turn, so it gets no bubble of its own; a fresh
 * prompt or a follow-up appears optimistically right away.
 */
export function showsOptimisticPreview(partCount: number, running: boolean, behavior: "steer" | "followUp"): boolean {
  return partCount > 0 && !(running && behavior === "steer");
}

export type PreviewPart = { type: "text"; text: string } | { type: "image"; mimeType: string; url: string };

/** Text alone stays a string; anything with an image goes as parts. */
export function previewUserMessage(message: string, parts: PreviewPart[]): string | PreviewPart[] {
  return parts.length === 1 && parts[0]?.type === "text" ? message : parts;
}

export type CaretRange = { start: number; end: number; length: number };

/**
 * Whether an arrow key is history navigation rather than caret movement.
 *
 * A selection or a caret sitting mid-text keeps the arrow for itself: a
 * multi-line draft must still be editable with the keyboard. Entering history
 * wants the caret at the very start (bash's rule); while browsing, the caret
 * sits at the end of the recalled line, so the same rule would trap the reader
 * on the newest entry.
 */
export function historyArrowMode(direction: "up" | "down", caret: CaretRange, browsing: boolean): boolean {
  if (caret.start !== caret.end) return false;
  if (!browsing) return direction === "up" && caret.start === 0;
  return true;
}

/** What the context meter draws: the used/window pair, when both are known. */
export function contextMeterUsage(usage: { tokens?: number | null; contextWindow?: number | null } | null | undefined) {
  if (!usage || usage.tokens == null || !usage.contextWindow) return undefined;
  return { used: usage.tokens, window: usage.contextWindow };
}

/**
 * Write a picked `/command` or `@mention` token into the draft.
 *
 * A mention rewrites the whole `@word` token; a command only the prefix the user
 * typed. The caret is the boundary in both cases. `@label` stays glued to
 * whatever follows, exactly like Orbit's `replaceMentionToken`, so the highlight
 * can still find the token.
 */
export function insertPalettePick(input: {
  text: string;
  caret: number;
  request: PaletteRequest | null;
  pick: PalettePick;
}): { text: string; caret: number } {
  const { pick, request } = input;
  const start = request?.start ?? input.text.length;
  const end = request ? (pick.file ? request.end : input.caret) : input.text.length;
  const rest = input.text.slice(end);
  const spacer = pick.file && !rest.startsWith(" ") ? " " : "";
  const next = `${input.text.slice(0, start)}${pick.text}${spacer}${rest}`;
  let caret = start + pick.text.length + spacer.length;
  if (next[caret] === " ") caret += 1;
  return { text: next, caret };
}

/** Transcribed speech is appended to whatever is already in the draft. */
export function appendDraftText(current: string, text: string): string {
  const spacer = current && !/\s$/.test(current) ? " " : "";
  return `${current}${spacer}${text}`;
}

/** `/gui-suggest` is only offered when the running Pi registered it. */
export function hasCommand(commands: readonly { name: string }[], name: string): boolean {
  return commands.some((command) => command.name === name);
}

/**
 * The extension command that asks for the next-step guess. JSON so a draft with
 * newlines or quotes cannot split the command line.
 */
export function suggestCommandMessage(draft: string, turn: string): string {
  return `/gui-suggest ${JSON.stringify({ draft, turn })}`;
}

export type DraftKeyInput = {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  composing: boolean;
};

export type DraftKeyIntent = "palette" | "history" | "ghost" | "dismiss-ghost" | "composer";

const PALETTE_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]);

/**
 * Which handler owns a key pressed in the draft.
 *
 * The order is the contract: an open palette owns its keys outright, history
 * comes next, the ghost suggestion third, and only what is left is a composer
 * shortcut. Tab and → belong to the IME candidate list while composing, so the
 * ghost is not offered then.
 */
export function draftKeyIntent(
  event: DraftKeyInput,
  options: { paletteOpen: boolean; hasGhost: boolean },
): DraftKeyIntent {
  if (options.paletteOpen && PALETTE_KEYS.has(event.key)) return "palette";
  const plain = !event.shiftKey && !event.altKey && !event.metaKey;
  if (plain && (event.key === "ArrowUp" || event.key === "ArrowDown")) return "history";
  if (options.hasGhost && !event.composing) {
    if (event.key === "Tab" || (event.key === "ArrowRight" && plain)) return "ghost";
    if (event.key === "Escape") return "dismiss-ghost";
  }
  return "composer";
}
