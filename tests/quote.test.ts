import { describe, expect, test } from "bun:test";
import { encodeQuote, quoteExcerpt, splitQuote } from "../src/features/chat/quote";
import { applyFileDrag, downloadUrl, fileUrl } from "../src/lib/file-drag";
import { otherComposerTargets } from "../src/features/chat/composerModel";
import { previewKind } from "../src/features/files/preview/kind";

describe("quote marker", () => {
  test("round-trips a quote without leaving it in the body", () => {
    const encoded = encodeQuote({ role: "assistant", text: "先看 diff" }, "为什么这里改了？");
    const split = splitQuote(encoded);
    expect(split.quote).toEqual({ role: "assistant", text: "先看 diff" });
    expect(split.body).toBe("为什么这里改了？");
    expect(split.body.includes("```")).toBe(false);
  });

  test("leaves an ordinary message alone", () => {
    expect(splitQuote("hello\n<<<orbit-quote role=\"user\">>>")).toEqual({
      quote: null,
      body: "hello\n<<<orbit-quote role=\"user\">>>",
    });
  });

  test("folds whitespace in the card excerpt", () => {
    expect(quoteExcerpt("一\n\n二")).toBe("一 二");
  });
});

describe("file drag payload", () => {
  test("encodes a path Finder can take", () => {
    expect(fileUrl("/tmp/a b.png")).toBe("file:///tmp/a%20b.png");
    expect(downloadUrl("/tmp/a b.png")).toBe("application/octet-stream:a%20b.png:file:///tmp/a%20b.png");
  });

  test("writes the three payloads a drop reads", () => {
    const data = new Map<string, string>();
    const transfer = {
      effectAllowed: "",
      setData(type: string, value: string) {
        data.set(type, value);
      },
    } as DataTransfer;
    applyFileDrag(transfer, "/Users/me/note.md");
    expect(data.get("text/plain")).toBe("/Users/me/note.md");
    expect(data.get("DownloadURL")).toContain("note.md");
    expect(data.get("text/uri-list")).toBe("file:///Users/me/note.md");
  });
});

describe("copy a screenshot to another composer", () => {
  test("skips the composer that already has the image", () => {
    const targets = otherComposerTargets("a", [
      { connectionId: "a", path: "/s/a", title: "当前", cwd: "/repo" },
      { connectionId: "b", path: "/s/b", title: "另一条", cwd: "/repo" },
      { connectionId: "b", path: "/s/b2", title: "重复", cwd: "/repo" },
    ]);
    expect(targets).toEqual([{ key: "b", title: "另一条" }]);
  });
});

describe("preview kind", () => {
  test("names the formats the file view previews instead of opening as text", () => {
    expect(previewKind("/a/book.epub")).toBe("epub");
    expect(previewKind("/a/notes.ipynb")).toBe("notebook");
    expect(previewKind("/a/app.sqlite")).toBe("sqlite");
    expect(previewKind("/a/sheet.xlsx")).toBe("sheet");
    expect(previewKind("/a/sheet.csv")).toBe("sheet");
    expect(previewKind("/a/deck.pptx")).toBe("slides");
    expect(previewKind("/a/memo.docx")).toBe("document");
    expect(previewKind("/a/pack.zip")).toBe("archive");
    expect(previewKind("/a/Display.woff2")).toBe("font");
    expect(previewKind("/a/main.ts")).toBe(null);
  });
});
