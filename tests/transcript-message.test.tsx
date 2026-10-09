import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptGroupView } from "../src/features/chat/Transcript";
import { buildPhases, formatWorkingDuration, projectTurn, proseSummary, workSummaryLine } from "../src/features/chat/turnModel";
import type { DisplayMessage, Tool } from "../src/lib/protocol";

const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "");

function render(items: DisplayMessage[], tools: Record<string, Tool> = {}, streaming = false, elapsedMs?: number) {
  return renderToStaticMarkup(
    <TranscriptGroupView group={{ id: items[0]?.id ?? "g", items, elapsedMs }} tools={tools} streaming={streaming} modelName="GPT-6.1-Sol" />,
  );
}

const phases: DisplayMessage[] = [
  { id: "first", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "第一轮思考", thinkingComplete: true },
    { type: "text", text: "先检查实现" },
    { type: "toolCall", id: "read", name: "read", arguments: { path: "src/app.ts" } },
  ] } },
  { id: "second", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "text", text: "现在运行验证" },
    { type: "toolCall", id: "test", name: "bash", arguments: { command: "bun test" } },
  ] } },
  { id: "final", message: { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "准备总结", thinkingComplete: true },
    { type: "text", text: "最终结果：已完成" },
  ] } },
];

const phaseTools: Record<string, Tool> = {
  read: { name: "read", running: false, result: "source" },
  test: { name: "bash", running: false, result: "passed" },
};

describe("user messages", () => {
  test("renders a Orbit chat bubble with copy and time below it", () => {
    const html = render([{ id: "u", message: { role: "user", content: "你好", timestamp: Date.UTC(2026, 8, 17, 6, 0) } }]);
    expect(html).toContain("user-message-bubble");
    expect(html).toContain("rounded-full");
    expect(html).toContain('aria-label="复制消息"');
    expect(html).toContain("<time");
  });

  test("uses a rounded card instead of a pill for multi-line prompts", () => {
    const html = render([{ id: "u", message: { role: "user", content: "第一行\n第二行" } }]);
    expect(html).toContain("rounded-xl");
    expect(html).not.toContain("rounded-full");
  });
});

describe("turn projection", () => {
  test("splits the final prose out as the answer and everything before as work", () => {
    const turn = projectTurn(phases, phaseTools, false);
    expect(turn.answer.map((step) => step.text)).toEqual(["最终结果：已完成"]);
    expect(turn.work.some((step) => step.kind === "tool")).toBe(true);
    expect(turn.work.some((step) => step.text === "先检查实现")).toBe(true);
  });

  test("a turn that ends on a tool call has no answer to fold behind", () => {
    const turn = projectTurn(phases.slice(0, 2), phaseTools, false);
    expect(turn.answer).toEqual([]);
  });

  test("streaming tail prose reads as the answer; narration before a tool call stays in the fold", () => {
    const live: DisplayMessage[] = [
      { id: "a1", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: "第一段小结" },
        { type: "toolCall", id: "read", name: "read", arguments: { path: "src/app.ts" } },
      ] } },
      { id: "a2", message: { role: "assistant", content: [{ type: "text", text: "第二段小结，还在流式输出" }] } },
    ];
    const turn = projectTurn(live, phaseTools, true);
    expect(turn.answer.map((step) => step.text)).toEqual(["第二段小结，还在流式输出"]);
    expect(turn.work.some((step) => step.text === "第一段小结")).toBe(true);
  });

  test("successful image generations lift out of the work fold as content", () => {
    const messages: DisplayMessage[] = [
      { id: "img1", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: "给你生成" },
        { type: "toolCall", id: "img", name: "generate_image", arguments: { prompt: "猫" } },
      ] } },
      { id: "img2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "图片好了" }] } },
    ];
    const ok: Record<string, Tool> = { img: { name: "generate_image", running: false, images: [{ data: "x", mimeType: "image/png" }] } };
    const turn = projectTurn(messages, ok, false);
    expect(turn.images).toHaveLength(1);
    expect(turn.work.some((step) => step.part?.id === "img")).toBe(false);

    const failed: Record<string, Tool> = { img: { name: "generate_image", running: false, isError: true } };
    const broken = projectTurn(messages, failed, false);
    expect(broken.images).toHaveLength(0);
    expect(broken.work.some((step) => step.part?.id === "img")).toBe(true);
  });

  test("narration starts a new phase and titles it", () => {
    const turn = projectTurn(phases, phaseTools, false);
    const built = buildPhases(turn.work, phaseTools);
    expect(built.map((phase) => phase.headline?.text)).toEqual(["先检查实现", "现在运行验证", undefined]);
    expect(built[0]?.kind).toBe("research");
    expect(built[1]?.kind).toBe("run");
  });

  test("summarises work the way Orbit does, in Chinese", () => {
    const turn = projectTurn(phases, phaseTools, false);
    expect(workSummaryLine(turn.work, phaseTools)).toBe("读取了 1 个文件 · 运行了命令");
    expect(workSummaryLine([], {}, true)).toBe("正在思考");
  });

  test("strips markdown from narration summaries", () => {
    expect(proseSummary("## 计划\n\n先看 `src/app.ts` 的 **入口**")).toBe("计划");
    expect(proseSummary("先看 `src/app.ts` 的 **入口**")).toBe("先看 src/app.ts 的 入口");
  });

  test("formats the fold line like Orbit", () => {
    expect(formatWorkingDuration(14_000, "GPT-6.1-Sol", true)).toBe("GPT-6.1-Sol worked for 14s");
    expect(formatWorkingDuration(95_000, undefined, true)).toBe("Worked for 1m 35s");
    expect(formatWorkingDuration(null, "Pi", false)).toBe("Pi working…");
  });
});

describe("assistant turns", () => {
  test("folds settled work behind the worked-for line and keeps the answer full size", () => {
    const html = render(phases, phaseTools, false, 14_000);
    expect(text(html)).toContain("Worked for 14s");
    expect(html).toContain('aria-label="展开过程"');
    // Settled work is folded away entirely; only the line remains.
    expect(html).not.toContain("zen-fold-rail");
    expect(html).not.toContain("先检查实现");
    expect(text(html)).toContain("最终结果：已完成");
    expect(html).toContain('aria-label="复制回复"');
    expect(html).toContain('aria-label="分支到新聊天"');
  });

  test("shows the live work open and shimmering while streaming", () => {
    const live: DisplayMessage[] = [{ id: "live", message: { role: "assistant", content: [
      { type: "thinking", thinking: "正在检查" },
      { type: "toolCall", id: "run", name: "bash", arguments: { command: "bun test" } },
    ] } }];
    const html = render(live, { run: { name: "bash", running: true } }, true);
    expect(html).toContain("shimmer-text");
    expect(text(html)).toContain("Working");
    expect(html).toContain('data-fold-state="open"');
    expect(html).not.toContain('aria-label="复制回复"');
  });

  test("a plain reply has no work fold, only the answer and footer", () => {
    const html = render([{ id: "plain", message: { role: "assistant", stopReason: "stop", content: "直接回复" } }], {}, false, 3_000);
    expect(text(html)).toContain("直接回复");
    expect(html).not.toContain("zen-fold-rail");
    expect(text(html)).toContain("Worked for 3s");
  });

  test("marks failed tool rows in red with an error glyph", () => {
    const items: DisplayMessage[] = [{ id: "failed", message: { role: "assistant", stopReason: "toolUse", content: [
      { type: "toolCall", id: "run-failed", name: "bash", arguments: { command: "bun test" } },
    ] } }];
    const html = render(items, { "run-failed": { name: "bash", running: false, result: "failed", isError: true } }, true);
    expect(html).toContain("失败的工具调用");
    expect(html).toContain("text-red-400");
  });

  test("does not turn transient provider errors into answers", () => {
    const html = render([{ id: "err", message: { role: "assistant", content: [], errorMessage: "Our servers are currently overloaded." } }], {}, true);
    expect(html).not.toContain("最终结果");
  });
});
