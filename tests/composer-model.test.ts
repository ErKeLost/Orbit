import { beforeEach, describe, expect, test } from "bun:test";
import type { PalettePick } from "../src/features/chat/ComposerPalette";
import {
  appendDraftText,
  attachmentCache,
  attachmentNameFromPath,
  buildPromptMessage,
  canSubmitPrompt,
  clipboardImageName,
  contextMeterUsage,
  draftCache,
  draftKeyIntent,
  forgetDraft,
  hasCommand,
  historyArrowMode,
  imageAttachment,
  insertPalettePick,
  isImageFileName,
  isImagePath,
  lruCache,
  pasteIntent,
  prepareImageFiles,
  previewUserMessage,
  recallAttachments,
  recallDraft,
  rememberAttachments,
  rememberDraft,
  sendBehavior,
  showsOptimisticPreview,
  splitAttachments,
  suggestCommandMessage,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
  type PickedFile,
} from "../src/features/chat/composerModel";
import type { PreparedImage } from "../src/lib/image-attachment";

/**
 * The composer's decisions, without the composer.
 *
 * Each case here is something the view used to inline: whether Enter is a send
 * or a newline, whether an arrow is history or a caret move, what a paste is
 * asking for, and what the harness actually receives. Getting one of these
 * wrong is silent — the send still happens, just with the wrong text or the
 * wrong attachment in it.
 */

const image = (id = "img-1", name = "shot.png"): ImageAttachment => ({
  kind: "image",
  id,
  name,
  mimeType: "image/png",
  blob: new Blob([]),
});

const chip = (id = "file-1", path = "/repo/src/App.tsx"): FileAttachment => ({
  kind: "file",
  id,
  name: attachmentNameFromPath(path),
  path,
});

const caret = (start: number, end = start, length = end) => ({ start, end, length });

const file = (relative: string): PalettePick["file"] => ({
  path: `/repo/${relative}`,
  relative,
  name: relative.split("/").at(-1) ?? relative,
  isDir: false,
});

beforeEach(() => {
  draftCache.clear();
  attachmentCache.clear();
});

describe("send conditions", () => {
  test("needs text or an attachment, and whitespace alone is nothing", () => {
    expect(canSubmitPrompt("", 0)).toBe(false);
    expect(canSubmitPrompt("   \n\t", 0)).toBe(false);
    expect(canSubmitPrompt("hi", 0)).toBe(true);
    expect(canSubmitPrompt("", 1)).toBe(true);
  });

  test("⌥Enter queues a follow-up, Enter steers", () => {
    expect(sendBehavior(false)).toBe("steer");
    expect(sendBehavior(true)).toBe("followUp");
  });

  test("a steer into a running turn gets no optimistic bubble", () => {
    expect(showsOptimisticPreview(0, false, "steer")).toBe(false);
    expect(showsOptimisticPreview(1, false, "steer")).toBe(true);
    expect(showsOptimisticPreview(1, true, "steer")).toBe(false);
    expect(showsOptimisticPreview(1, true, "followUp")).toBe(true);
  });

  test("a text-only preview stays a string; an image makes it parts", () => {
    const text = [{ type: "text" as const, text: "hi" }];
    const mixed = [...text, { type: "image" as const, mimeType: "image/png", url: "blob:1" }];
    expect(previewUserMessage("hi", text)).toBe("hi");
    expect(previewUserMessage("hi", mixed)).toEqual(mixed);
    expect(previewUserMessage("hi", [])).toEqual([]);
  });
});

describe("what the harness receives", () => {
  test("file chips become [文件] path lines above the text", () => {
    expect(buildPromptMessage("explain", [])).toBe("explain");
    expect(buildPromptMessage("explain", [chip("a", "/r/a.ts")])).toBe("[文件] /r/a.ts\n\nexplain");
    expect(buildPromptMessage("explain", [chip("a", "/r/a.ts"), chip("b", "/r/b.ts")])).toBe(
      "[文件] /r/a.ts\n[文件] /r/b.ts\n\nexplain",
    );
  });

  test("chips alone still send, without a trailing blank line", () => {
    expect(buildPromptMessage("", [chip("a", "/r/a.ts")])).toBe("[文件] /r/a.ts");
  });

  test("attachments split into bytes and path chips", () => {
    const list: Attachment[] = [image(), chip(), image("img-2")];
    const { images, files } = splitAttachments(list);
    expect(images.map((item) => item.id)).toEqual(["img-1", "img-2"]);
    expect(files.map((item) => item.path)).toEqual(["/repo/src/App.tsx"]);
  });

  test("an image attachment keeps the prepared name and type, with a fresh id", () => {
    const prepared: PreparedImage = { blob: new Blob([]), mimeType: "image/jpeg", name: "photo.jpg", width: 1, height: 1, recoded: true };
    const attachment = imageAttachment(prepared);
    expect(attachment).toMatchObject({ kind: "image", name: "photo.jpg", mimeType: "image/jpeg" });
    expect(attachment.id).toBeTruthy();
    expect(attachment.id).not.toBe(imageAttachment(prepared).id);
  });
});

describe("attachment pre-processing", () => {
  const picked = (name: string, type = ""): PickedFile => ({ name, type, size: 10, blob: new Blob([]) });

  test("picked files are prepared, and a refused file is reported not attached", async () => {
    const seen: string[] = [];
    const { images, errors } = await prepareImageFiles(
      [picked("a.png", "image/png"), picked("big.jpg", "image/jpeg")],
      async (file) => {
        seen.push(file.name);
        if (file.name === "big.jpg") throw new Error("too big");
        return { blob: file.blob, mimeType: "image/png", name: file.name, width: 4, height: 4, recoded: false };
      },
    );
    expect(seen).toEqual(["a.png", "big.jpg"]);
    expect(images.map((item) => item.name)).toEqual(["a.png"]);
    expect(errors).toHaveLength(1);
  });

  test("a drop is an image only when the extension says so", () => {
    expect(isImagePath("/repo/shot.PNG")).toBe(true);
    expect(isImagePath("C:\\shots\\a.jpeg")).toBe(true);
    expect(isImagePath("/repo/notes.md")).toBe(false);
    expect(isImagePath("/repo/noext")).toBe(false);
    expect(isImageFileName("archive.tar.gz")).toBe(false);
    expect(attachmentNameFromPath("/repo/src/App.tsx")).toBe("App.tsx");
    // A path ending in a separator has no last segment; the whole path is a
    // better chip name than an empty string.
    expect(attachmentNameFromPath("/repo/trailing/")).toBe("/repo/trailing/");
  });

  test("the clipboard image name follows the bytes, not an assumed PNG", () => {
    expect(clipboardImageName("image/jpeg")).toBe("粘贴的图片.jpg");
    expect(clipboardImageName("image/png")).toBe("粘贴的图片.png");
  });
});

describe("paste intent", () => {
  test("image files win over text, and only images are prepared", () => {
    const files = [{ name: "a.png", type: "" }, { name: "notes.txt", type: "text/plain" }, { name: "b.jpg", type: "image/jpeg" }];
    const intent = pasteIntent({ files, text: "hello", desktop: true });
    expect(intent.kind).toBe("images");
    expect(intent.kind === "images" && intent.images.map((item) => item.name)).toEqual(["a.png", "b.jpg"]);
  });

  test("an image is recognised by MIME even without a helpful name", () => {
    const intent = pasteIntent({ files: [{ name: "blob", type: "image/webp" }], text: "", desktop: true });
    expect(intent.kind).toBe("images");
  });

  test("no files and no text on desktop asks the native clipboard", () => {
    expect(pasteIntent({ files: [], text: "", desktop: true }).kind).toBe("native-clipboard");
  });

  test("no files and no text elsewhere falls through to the browser", () => {
    expect(pasteIntent({ files: [], text: "", desktop: false }).kind).toBe("text");
  });

  test("pasted text is left to the browser", () => {
    expect(pasteIntent({ files: [], text: "hello", desktop: true }).kind).toBe("text");
  });

  test("non-image files are left to the browser", () => {
    expect(pasteIntent({ files: [{ name: "a.zip", type: "" }], text: "", desktop: true }).kind).toBe("text");
  });
});

describe("palette picks", () => {
  test("a mention rewrites the whole token and keeps the rest glued", () => {
    const draft = "look at @App and more";
    const result = insertPalettePick({
      text: draft,
      caret: "look at @Ap".length,
      request: { kind: "mention", query: "Ap", start: 8, end: 12 },
      pick: { text: "@src/App.tsx", file: file("src/App.tsx"), label: "App.tsx" },
    });
    expect(result.text).toBe("look at @src/App.tsx and more");
    // The caret steps over the existing space rather than sitting before it.
    expect(result.caret).toBe("look at @src/App.tsx ".length);
  });

  test("a mention gets a spacer when nothing follows, and not two", () => {
    const pick: PalettePick = { text: "@a.ts", file: file("a.ts") };
    const empty = insertPalettePick({ text: "@a", caret: 2, request: { kind: "mention", query: "a", start: 0, end: 2 }, pick });
    expect(empty.text).toBe("@a.ts ");
    expect(empty.caret).toBe(6);

    const spaced = insertPalettePick({ text: "@a rest", caret: 2, request: { kind: "mention", query: "a", start: 0, end: 2 }, pick });
    expect(spaced.text).toBe("@a.ts rest");
    expect(spaced.caret).toBe("@a.ts ".length);
  });

  test("a command replaces only the prefix the user typed", () => {
    const result = insertPalettePick({
      text: "/mo rest of the line",
      caret: 3,
      request: { kind: "slash", query: "mo", start: 0, end: 3 },
      pick: { text: "/model " },
    });
    expect(result.text).toBe("/model  rest of the line");
    expect(result.caret).toBe(8);
  });

  test("with no request the pick is written at the caret boundary", () => {
    const result = insertPalettePick({ text: "tail", caret: 4, request: null, pick: { text: "/model " } });
    expect(result.text).toBe("tail/model ");
    expect(result.caret).toBe(11);
  });

  test("a caret sitting on a space steps over it instead of doubling it", () => {
    const result = insertPalettePick({
      text: "/mo abc",
      caret: 3,
      request: { kind: "slash", query: "mo", start: 0, end: 3 },
      pick: { text: "/model" },
    });
    expect(result.text).toBe("/model abc");
    expect(result.caret).toBe(7);
  });
});

describe("draft text", () => {
  test("transcribed speech is appended with one separating space", () => {
    expect(appendDraftText("", "hello")).toBe("hello");
    expect(appendDraftText("hello", "world")).toBe("hello world");
    expect(appendDraftText("hello ", "world")).toBe("hello world");
    expect(appendDraftText("hello\n", "world")).toBe("hello\nworld");
  });
});

describe("history arrows", () => {
  test("a selection or a caret mid-text keeps the arrow", () => {
    expect(historyArrowMode("up", caret(2, 5), false)).toBe(false);
    expect(historyArrowMode("up", caret(3), false)).toBe(false);
  });

  test("up at the very start enters history; down there does not", () => {
    expect(historyArrowMode("up", caret(0), false)).toBe(true);
    expect(historyArrowMode("down", caret(0), false)).toBe(false);
  });

  test("while browsing, both arrows keep stepping regardless of position", () => {
    expect(historyArrowMode("down", caret(4, 4, 9), true)).toBe(true);
    expect(historyArrowMode("up", caret(9, 9, 9), true)).toBe(true);
  });
});

describe("composer shortcuts", () => {
  const plain = { key: "a", shiftKey: false, altKey: false, metaKey: false, composing: false };
  const options = { paletteOpen: false, hasGhost: false };

  test("an open palette owns its keys outright", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]) {
      expect(draftKeyIntent({ ...plain, key }, { paletteOpen: true, hasGhost: true })).toBe("palette");
    }
    expect(draftKeyIntent({ ...plain, key: "ArrowUp" }, options)).toBe("history");
  });

  test("plain arrows are history; modified arrows are not", () => {
    expect(draftKeyIntent({ ...plain, key: "ArrowUp" }, options)).toBe("history");
    expect(draftKeyIntent({ ...plain, key: "ArrowDown" }, options)).toBe("history");
    expect(draftKeyIntent({ ...plain, key: "ArrowUp", shiftKey: true }, options)).toBe("composer");
    expect(draftKeyIntent({ ...plain, key: "ArrowDown", altKey: true }, options)).toBe("composer");
    expect(draftKeyIntent({ ...plain, key: "ArrowUp", metaKey: true }, options)).toBe("composer");
  });

  test("Tab and → take the ghost suggestion; Escape dismisses it", () => {
    expect(draftKeyIntent({ ...plain, key: "Tab" }, { paletteOpen: false, hasGhost: true })).toBe("ghost");
    expect(draftKeyIntent({ ...plain, key: "ArrowRight" }, { paletteOpen: false, hasGhost: true })).toBe("ghost");
    expect(draftKeyIntent({ ...plain, key: "Escape" }, { paletteOpen: false, hasGhost: true })).toBe("dismiss-ghost");
  });

  test("without a ghost, or while an IME is composing, those keys belong to the field", () => {
    expect(draftKeyIntent({ ...plain, key: "Tab" }, options)).toBe("composer");
    expect(draftKeyIntent({ ...plain, key: "ArrowRight" }, options)).toBe("composer");
    expect(draftKeyIntent({ ...plain, key: "Escape" }, options)).toBe("composer");
    expect(draftKeyIntent({ ...plain, key: "Tab", composing: true }, { paletteOpen: false, hasGhost: true })).toBe("composer");
    expect(draftKeyIntent({ ...plain, key: "Enter" }, { paletteOpen: false, hasGhost: true })).toBe("composer");
  });

  test("a modified → does not take the ghost", () => {
    expect(draftKeyIntent({ ...plain, key: "ArrowRight", metaKey: true }, { paletteOpen: false, hasGhost: true })).toBe("composer");
  });
});

describe("slash commands", () => {
  test("the suggestion command is only offered when Pi registered it", () => {
    expect(hasCommand([{ name: "review" }, { name: "gui-suggest" }], "gui-suggest")).toBe(true);
    expect(hasCommand([{ name: "review" }], "gui-suggest")).toBe(false);
    expect(hasCommand([], "gui-suggest")).toBe(false);
  });

  test("the draft and turn travel as JSON, so newlines cannot break the command", () => {
    const message = suggestCommandMessage('line "one"\nline two', "turn-1");
    expect(message.startsWith("/gui-suggest ")).toBe(true);
    const payload = JSON.parse(message.slice("/gui-suggest ".length));
    expect(payload).toEqual({ draft: 'line "one"\nline two', turn: "turn-1" });
    expect(message.includes("\n")).toBe(false);
  });
});

describe("context meter", () => {
  test("needs both halves of the pair", () => {
    expect(contextMeterUsage(undefined)).toBeUndefined();
    expect(contextMeterUsage(null)).toBeUndefined();
    expect(contextMeterUsage({ contextWindow: 200_000 })).toBeUndefined();
    expect(contextMeterUsage({ tokens: 10 })).toBeUndefined();
    expect(contextMeterUsage({ tokens: null, contextWindow: 200_000 })).toBeUndefined();
    expect(contextMeterUsage({ tokens: 10, contextWindow: 0 })).toBeUndefined();
  });

  test("a zero-token turn is still a reading", () => {
    expect(contextMeterUsage({ tokens: 0, contextWindow: 200_000 })).toEqual({ used: 0, window: 200_000 });
  });
});

describe("draft and attachment caches", () => {
  test("a draft survives a remount and is dropped on send", () => {
    rememberDraft("conn-1", "unsent words");
    expect(recallDraft("conn-1")).toBe("unsent words");
    forgetDraft("conn-1");
    expect(recallDraft("conn-1")).toBe("");
  });

  test("attachments come back for the same session only", () => {
    rememberAttachments("conn-1", [image()]);
    expect(recallAttachments("conn-1").map((item) => item.id)).toEqual(["img-1"]);
    expect(recallAttachments("conn-2")).toEqual([]);
  });

  test("only four sessions are kept, oldest evicted first", () => {
    const cache = new Map<string, number>();
    for (const [index, key] of ["a", "b", "c", "d"].entries()) lruCache(cache, key, index);
    expect([...cache.keys()]).toEqual(["a", "b", "c", "d"]);
    lruCache(cache, "a", 99);
    lruCache(cache, "e", 4);
    expect([...cache.keys()]).toEqual(["c", "d", "a", "e"]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(99);
  });
});
