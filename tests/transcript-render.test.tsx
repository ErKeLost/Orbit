import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPhases, TranscriptGroupView } from "../src/features/chat/Transcript";
import { projectTurn } from "../src/features/chat/turnModel";
import type { DisplayMessage, Tool } from "../src/lib/protocol";

const item = (id: string, message: Record<string, unknown>): DisplayMessage =>
  ({ id, message }) as unknown as DisplayMessage;

/** Count occurrences a reader can actually see (accessibility labels excluded). */
const visibleCount = (html: string, needle: string) =>
  html.replace(/aria-label="[^"]*"/g, "").split(needle).length - 1;

/** The phase rows themselves — the part that now lives behind the fold. */
const renderWork = (items: DisplayMessage[], tools: Record<string, Tool>, streaming: boolean) =>
  renderToStaticMarkup(<ActivityPhases steps={projectTurn(items, tools, streaming).work} tools={tools} done={!streaming} />);

/**
 * Work folds behind the "working…" line by default, in every state: the reader
 * opens it, it does not open itself mid-run. The live summary stays on the fold
 * line, so folding never hides *what* the agent is doing.
 *
 * The phase rows below are tested directly, because that is where the content
 * rules live (a short block prints once, an image read renders pixels).
 */
describe("work fold rendering", () => {
  test("the live fold stays closed and carries the doing line", () => {
    const items = [
      item("m1", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先看一下目录。", thinkingComplete: true },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      }),
    ];
    const html = renderToStaticMarkup(
      <TranscriptGroupView group={{ id: "g", items }} tools={{} as Record<string, Tool>} streaming />,
    );
    // Closed: no step rows, and the caret says what a click would do.
    expect(html).toContain('aria-label="展开过程"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("zen-fold-rail");
    expect(visibleCount(html, "先看一下目录。")).toBe(0);
    // Still legible while running: the shimmer plus the current activity.
    expect(html).toContain("shimmer-text");
    expect(html).toContain("正在运行命令");
  });

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
    const html = renderWork(items, {} as Record<string, Tool>, true);
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
    const html = renderWork(items, {} as Record<string, Tool>, true);
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
    const html = renderWork(items, {} as Record<string, Tool>, true);
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
    const html = renderWork(items, tools, true);
    // The pixels are what the reader wants: render them, and drop the text that
    // only existed to stand in for them.
    expect(html).toContain("data:image/png;base64,AAAA");
    expect(html).not.toContain("Read image file");
    expect(html).not.toContain("未返回输出");
  });
});
