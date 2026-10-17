import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptGroupView } from "../src/features/chat/Transcript";
import type { DisplayMessage, Tool } from "../src/lib/protocol";

const item = (id: string, message: Record<string, unknown>): DisplayMessage =>
  ({ id, message }) as unknown as DisplayMessage;

/** Count occurrences a reader can actually see (accessibility labels excluded). */
const visibleCount = (html: string, needle: string) =>
  html.replace(/aria-label="[^"]*"/g, "").split(needle).length - 1;

/**
 * The work fold renders each reasoning block as a collapsed summary line that
 * expands to the full text. When the block was short, the summary *was* the
 * text, so opening it printed the same words twice — which is how a stray
 * "Summarize." from the model's reasoning showed up as a duplicated line.
 *
 * `streaming` with no answer keeps the fold open, which is the state the reader
 * actually sees the steps in.
 */
describe("work fold rendering", () => {
  const foldOpen = { stream: true, streaming: true } as const;

  test("a short reasoning block prints once", () => {
    const items = [
      item("m1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Summarize.", thinkingComplete: true },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      }),
    ];
    const html = renderToStaticMarkup(
      <TranscriptGroupView
        group={{ id: "g", items }}
        tools={{} as Record<string, Tool>}
        streaming={foldOpen.streaming}
      />,
    );
    expect(visibleCount(html, "Summarize.")).toBe(1);
  });

  test("a long reasoning block keeps its expand affordance", () => {
    const first = "我先读一下这个文件，然后核对依赖版本。";
    const thinking = `${first}\n\n然后还要看构建脚本和 CI 配置，最后给出结论。`;
    const items = [
      item("m1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking, thinkingComplete: true },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      }),
    ];
    const html = renderToStaticMarkup(
      <TranscriptGroupView
        group={{ id: "g", items }}
        tools={{} as Record<string, Tool>}
        streaming={foldOpen.streaming}
      />,
    );
    // The summary line is a first-paragraph digest, so the block can expand.
    expect(html).toContain("展开思考");
    expect(visibleCount(html, first)).toBe(1);
    // The rest of the block only appears once the reader expands it.
    expect(visibleCount(html, "构建脚本")).toBe(0);
  });

  test("a short prose-only phase prints once", () => {
    const items = [
      item("m1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "先看两条命令。" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      }),
      item("m2", {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Summarize." },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "git log" } },
        ],
      }),
    ];
    const html = renderToStaticMarkup(
      <TranscriptGroupView
        group={{ id: "g", items }}
        tools={{} as Record<string, Tool>}
        streaming={foldOpen.streaming}
      />,
    );
    expect(visibleCount(html, "Summarize.")).toBe(1);
  });

  test("an image read shows the picture, not its placeholder note", () => {
    const items = [
      item("m1", {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/tmp/out/preview-1.png" } }],
      }),
    ];
    const tools = {
      c1: {
        name: "read",
        running: false,
        result: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        images: [{ data: "AAAA", mimeType: "image/png" }],
      },
    } as unknown as Record<string, Tool>;
    const html = renderToStaticMarkup(
      <TranscriptGroupView group={{ id: "g", items }} tools={tools} streaming={foldOpen.streaming} />,
    );
    // The pixels are what the reader wants: render them, and drop the text that
    // only existed to stand in for them.
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain("Read image file");
    expect(html).not.toContain("未返回输出");
  });
});
