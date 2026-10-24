import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_HIGHLIGHT_CHARS,
  highlightHtml,
  highlightLines,
} from "../src/lib/highlight/core";
import {
  highlightToHtml,
  highlightToLines,
  peekHtml,
  peekLines,
  resetHighlightCache,
  setHighlightTransport,
} from "../src/lib/highlight";
import type { HighlightResult } from "../src/lib/highlight/types";

afterEach(() => {
  setHighlightTransport(null);
  resetHighlightCache();
});

describe("shiki core (runs wherever it is asked to)", () => {
  test("html carries both palettes so a theme switch needs no second pass", async () => {
    const html = await highlightHtml("const a = 1", "ts");
    expect(html).toContain("shiki-themes");
    expect(html).toContain("--shiki-dark");
    // 浅色是行内 color 的默认值，深色只作为变量存在。
    expect(html).toMatch(/color:#[0-9a-f]{6}/i);
  });

  test("diff lines keep their text and expose a dark variant per token", async () => {
    const lines = await highlightLines("const a = 1;\nreturn a;", "ts");
    expect(lines.join("\n")).not.toBe("");
    expect(lines.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe(
      "const a = 1;\nreturn a;",
    );
    const colored = lines.flat().filter((token) => token.color);
    expect(colored.length).toBeGreaterThan(0);
    expect(colored.every((token) => Boolean(token.darkColor))).toBe(true);
  });

  test("an oversized or empty source is declined instead of blocking a frame", async () => {
    expect(await highlightHtml("", "ts")).toBe("");
    expect(await highlightHtml("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ts")).toBe("");
    expect(await highlightLines("   \n", "ts")).toEqual([]);
  });
});

describe("highlight transport", () => {
  test("identical sources share one pass, and the result is reusable synchronously", async () => {
    let calls = 0;
    setHighlightTransport(async (kind, code) => {
      calls += 1;
      return kind === "html"
        ? ({ kind: "html", html: `<pre class="shiki">${code}</pre>` } as HighlightResult)
        : ({ kind: "lines", lines: [[{ text: code, color: "#000", darkColor: "#fff" }]] } as HighlightResult);
    });

    const [first, second] = await Promise.all([
      highlightToHtml("same()", "ts"),
      highlightToHtml("same()", "ts"),
    ]);
    expect(first).toBe('<pre class="shiki">same()</pre>');
    expect(second).toBe(first);
    expect(calls).toBe(1);

    // 另一种输出形态是另一条缓存线，但同样只算一次。
    await highlightToLines("same()", "ts");
    await highlightToLines("same()", "ts");
    expect(calls).toBe(2);

    // 命中缓存：重开会话时第一帧就能上色，不必等一次往返。
    expect(peekHtml("same()", "ts")).toBe(first);
    expect(peekLines("same()", "ts")?.[0]?.[0]?.darkColor).toBe("#fff");
  });

  test("the same source in another kind or language is a separate entry", async () => {
    let calls = 0;
    setHighlightTransport(async (kind, code, lang) => {
      calls += 1;
      return kind === "html"
        ? ({ kind: "html", html: `${lang}:${code}` } as HighlightResult)
        : ({ kind: "lines", lines: [] } as HighlightResult);
    });
    const html = await highlightToHtml("x", "ts");
    const other = await highlightToHtml("x", "rs");
    expect(html).toBe("ts:x");
    expect(other).toBe("rs:x");
    expect(calls).toBe(2);
  });

  test("a failing transport degrades to null instead of throwing into the UI", async () => {
    setHighlightTransport(() => Promise.reject(new Error("no worker here")));
    expect(await highlightToHtml("const a = 1", "ts")).toBeNull();
    expect(await highlightToLines("const a = 1", "ts")).toBeNull();
    // 失败不写缓存：下一次仍会重试，而不是把「没有颜色」记成结论。
    setHighlightTransport(async () => ({ kind: "html", html: "ok" }));
    expect(await highlightToHtml("const a = 1", "ts")).toBe("ok");
  });

  test("an unknown language degrades to plain text", async () => {
    setHighlightTransport(async (kind, code, lang) => {
      if (lang === "nonsense") throw new Error("Unknown language: nonsense");
      return kind === "html"
        ? ({ kind: "html", html: code } as HighlightResult)
        : ({ kind: "lines", lines: [] } as HighlightResult);
    });
    expect(await highlightToHtml("x", "nonsense")).toBeNull();
    expect(await highlightToHtml("x", "ts")).toBe("x");
  });

  test("resetHighlightCache drops what was remembered", async () => {
    setHighlightTransport(async () => ({ kind: "html", html: "cached" }));
    expect(await highlightToHtml("a", "ts")).toBe("cached");
    expect(peekHtml("a", "ts")).toBe("cached");
    resetHighlightCache();
    expect(peekHtml("a", "ts")).toBeNull();
  });
});
