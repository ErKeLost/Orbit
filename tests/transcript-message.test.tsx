import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPhases, TranscriptGroupView } from "../src/features/chat/Transcript";
import { buildPhases, formatWorkingDuration, projectTurn, proseSummary, workCategory, workSummaryLine } from "../src/features/chat/turnModel";
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

  test("renders the prompt as markdown", () => {
    const html = render([{ id: "u", message: { role: "user", content: "**重点**\n\n- 一\n- 二" } }]);
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<ul>");
    // 渲染后只剩正文（星号是语法，不是字）；「复制消息」复制的仍是原文。
    expect(text(html)).toContain("重点");
    expect(text(html)).not.toContain("**");
  });

  test("clamps a long prompt until 显示全部", () => {
    const html = render([{ id: "u", message: { role: "user", content: "第一行\n第二行" } }]);
    expect(html).toContain("user-message-markdown");
    expect(html).toContain("max-h-20 overflow-hidden");
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

  test("the live tail prose is promoted while streaming; earlier narration stays in the fold", () => {
    const live: DisplayMessage[] = [
      { id: "a1", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: "第一段小结" },
        { type: "toolCall", id: "read", name: "read", arguments: { path: "src/app.ts" } },
      ] } },
      { id: "a2", message: { role: "assistant", content: [{ type: "text", text: "第二段小结，还在流式输出" }] } },
    ];
    // 最终回答要逐字出现：流式中（还未 message_end）尾部正文就提升到回答区。
    const streamingTurn = projectTurn(live, phaseTools, true);
    expect(streamingTurn.answer.map((step) => step.text)).toEqual(["第二段小结，还在流式输出"]);
    expect(streamingTurn.work.some((step) => step.text === "第一段小结")).toBe(true);

    // message_end 之后依然无工具 → 还是最终总结，不回到折叠区。
    const settledTurn = projectTurn(
      live.map((item, index) => (index === live.length - 1 ? { ...item, settled: true } : item)),
      phaseTools,
      true,
    );
    expect(settledTurn.answer.map((step) => step.text)).toEqual(["第二段小结，还在流式输出"]);
    expect(settledTurn.work.some((step) => step.text === "第一段小结")).toBe(true);
  });

  test("a live message that ends on a tool call keeps its prose in the fold", () => {
    const live: DisplayMessage[] = [
      { id: "t1", message: { role: "assistant", content: [
        { type: "text", text: "我先看一下入口" },
        { type: "toolCall", id: "read", name: "read", arguments: { path: "src/app.ts" } },
      ] } },
    ];
    const turn = projectTurn(live, { read: { name: "read", running: true } }, true);
    expect(turn.answer).toEqual([]);
    expect(turn.work.some((step) => step.text === "我先看一下入口")).toBe(true);
  });

  test("a settled streaming message that ends on a tool call never promotes its prose", () => {
    const live: DisplayMessage[] = [
      { id: "s1", settled: true, message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "text", text: "中间叙述，后面还有工具" },
        { type: "toolCall", id: "test", name: "bash", arguments: { command: "bun test" } },
      ] } },
    ];
    const turn = projectTurn(live, { ...phaseTools, test: { ...phaseTools.test, running: true } }, true);
    expect(turn.answer).toEqual([]);
    expect(turn.work.some((step) => step.text === "中间叙述，后面还有工具")).toBe(true);
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

  test("a browser or desktop `*_task` is a tool, not a delegated sub-agent", () => {
    expect(workCategory("browser_task")).toBe("computer");
    expect(workCategory("gui_task")).toBe("computer");
    expect(workCategory("spawn_agent")).toBe("agent");
    expect(workCategory("wait_agent")).toBe("agent");
    expect(workCategory("delegate")).toBe("agent");
  });

  test("the fold line never claims a sub-agent for a browser task", () => {
    const items: DisplayMessage[] = [
      { id: "a", message: { role: "assistant", stopReason: "toolUse", content: [
        { type: "toolCall", id: "bt", name: "browser_task", arguments: { goal: "打开页面" } },
        { type: "toolCall", id: "sh", name: "bash", arguments: { command: "ls" } },
      ] } },
    ];
    const tools: Record<string, Tool> = {
      bt: { name: "browser_task", running: false, result: "ok" },
      sh: { name: "bash", running: false, result: "ok" },
    };
    const line = workSummaryLine(projectTurn(items, tools, false).work, tools);
    expect(line).not.toContain("子 agent");
    expect(line).toContain("操作了电脑");
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

  test("opens a live turn to its phase row, with the step detail still shut", () => {
    const live: DisplayMessage[] = [{ id: "live", message: { role: "assistant", content: [
      { type: "thinking", thinking: "正在检查" },
      { type: "toolCall", id: "run", name: "bash", arguments: { command: "bun test" } },
    ] } }];
    const html = render(live, { run: { name: "bash", running: true } }, true);
    expect(html).toContain("shimmer-text");
    expect(text(html)).toContain("Working");
    // 层级：计时行是展开的，第二层（正在做什么）一眼可见，第三层（每一步）
    // 默认收着；折行上也不再拼一句尾啜摘要。
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("zen-fold-rail");
    expect(text(html)).toContain("正在运行命令");
    expect(html).toContain('aria-label="展开 正在运行命令 的步骤"');
    expect(text(html)).not.toContain("bun test");
    expect(html).not.toContain('aria-label="复制回复"');
  });

  test("streams an unanswered reply as full-size prose in the answer area", () => {
    // 回归：之前要等 message_end 才把正文提升到回答区，整段回答就一次性出现
    // （“不是流式输出了”）。流式中的尾部正文必须立即在回答区渲染 markdown。
    const prose = "第一段流式正文，还在继续输出";
    const html = render([{ id: "live-plain", message: { role: "assistant", content: [{ type: "text", text: prose }] } }], {}, true);
    expect(text(html)).toContain(prose);
    expect(html).toContain("agent-markdown");
    expect(html).toContain("is-streaming");
    expect(html).toContain('data-chat-message-role="assistant"');
    // 正文在回答区，不在折叠过程区。
    expect(html).not.toContain("zen-phase-body");
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
    const tools = { "run-failed": { name: "bash", running: false, result: "failed", isError: true } } as unknown as Record<string, Tool>;
    // 步骤行现在默认折起来，所以直接渲染过程内容本身。
    const html = renderToStaticMarkup(<ActivityPhases steps={projectTurn(items, tools, true).work} tools={tools} done={false} />);
    expect(html).toContain("失败的工具调用");
    expect(html).toContain("text-red-400");
  });

  test("does not turn transient provider errors into answers", () => {
    const html = render([{ id: "err", message: { role: "assistant", content: [], errorMessage: "Our servers are currently overloaded." } }], {}, true);
    expect(html).not.toContain("最终结果");
  });
});
