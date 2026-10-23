import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SOURCE_KEYS,
  compactionThreshold,
  contextBarSegments,
  estimateContextSources,
  estimateTextTokens,
  fitToUsed,
  IMAGE_TOKENS,
  type ContextSources,
} from "../src/features/chat/contextBreakdown";
import type { DisplayMessage } from "../src/lib/protocol";

const total = (sources: ContextSources) => CONTEXT_SOURCE_KEYS.reduce((sum, key) => sum + sources[key], 0);

describe("context breakdown estimation", () => {
  test("counts CJK by character and Latin by four characters", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("a".repeat(400))).toBe(100);
    // 11 个汉字 → 7.7 → 8（0.7 token/字，向上取整）。
    expect(estimateTextTokens("上下文占用估算示例文本")).toBe(8);
    expect(estimateTextTokens(undefined)).toBe(0);
  });

  test("splits system, conversation, tools and attachments without double counting", () => {
    const messages: DisplayMessage[] = [
      { id: "user", message: { role: "user", content: [{ type: "text", text: "a".repeat(400) }, { type: "image", data: "x", mimeType: "image/png" }] } },
      {
        id: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "b".repeat(400) },
            { type: "thinking", thinking: "c".repeat(400) },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
          ],
        },
      },
      // 工具结果的消息体不进 messages；数了就会和下面的 tools 重复。
      { id: "result", message: { role: "toolResult", content: "d".repeat(4000), toolCallId: "call-1" } },
    ];
    const sources = estimateContextSources({
      systemPrompt: "s".repeat(2000),
      toolSchemaChars: 4000,
      messages,
      tools: { "call-1": { result: "e".repeat(800), args: { path: "a.ts" } } },
    });
    expect(sources.system).toBe(500 + 1000);
    expect(sources.conversation).toBe(300);
    expect(sources.app).toBe(IMAGE_TOKENS);
    // 调用参数（来自 assistant 的 toolCall part）+ 工具输出（来自 transcript.tools）。
    const callChars = JSON.stringify({ path: "a.ts" }).length;
    const argsChars = JSON.stringify({ path: "a.ts" }).length;
    expect(sources.tools).toBe(Math.ceil(callChars / 4) + 200 + Math.ceil(argsChars / 4));
  });
});

describe("fitting estimates onto the provider total", () => {
  test("keeps the provider number exactly and only changes the proportions", () => {
    const fitted = fitToUsed({ system: 10, conversation: 20, tools: 5, app: 1 }, 48000);
    expect(total(fitted)).toBe(48000);
    expect(fitted.conversation).toBeGreaterThan(fitted.system);
    expect(fitted.system).toBeGreaterThan(fitted.tools);
    expect(fitted.app).toBeGreaterThan(0);
  });

  test("returns zeros instead of inventing a breakdown it cannot see", () => {
    expect(fitToUsed({ system: 0, conversation: 0, tools: 0, app: 0 }, 48000)).toEqual({ system: 0, conversation: 0, tools: 0, app: 0 });
    expect(fitToUsed({ system: 10, conversation: 0, tools: 0, app: 0 }, 0)).toEqual({ system: 0, conversation: 0, tools: 0, app: 0 });
  });

  test("never leaves a 1-token source behind for rounding", () => {
    // 极小窗口下四段都可能被分配 0，但不能把没有量的来源凭空算出来。
    const fitted = fitToUsed({ system: 100, conversation: 0, tools: 0, app: 0 }, 3);
    expect(total(fitted)).toBe(3);
    expect(fitted.conversation).toBe(0);
    expect(fitted.tools).toBe(0);
    expect(fitted.app).toBe(0);
  });
});

describe("context bar segments", () => {
  test("lays out the used sources, never past the window", () => {
    const buckets = { system: 8000, conversation: 18000, tools: 16000, app: 6000 };
    const segments = contextBarSegments(buckets, 128000);
    expect(segments.map((segment) => segment.key)).toEqual(["system", "conversation", "tools", "app"]);
    // 48K / 128K = 37.5% 的窗口。
    const end = segments[segments.length - 1];
    expect(end.left + end.width).toBeCloseTo(37.5, 5);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].left).toBeCloseTo(segments[index - 1].left + segments[index - 1].width, 10);
    }
  });

  test("shrinks proportionally when the provider total exceeds the window", () => {
    const segments = contextBarSegments({ system: 90000, conversation: 30000, tools: 0, app: 0 }, 100000);
    const end = segments[segments.length - 1];
    expect(end.left + end.width).toBeCloseTo(100, 6);
    expect(end.key).toBe("conversation");
  });

  test("draws nothing without a window", () => {
    expect(contextBarSegments({ system: 1, conversation: 0, tools: 0, app: 0 }, 0)).toEqual([]);
    expect(contextBarSegments({ system: 0, conversation: 0, tools: 0, app: 0 }, 128000)).toEqual([]);
  });
});

describe("compaction threshold", () => {
  test("marks the line where Pi starts compacting", () => {
    // 1M 窗口 + 16K 预留 = 98.4% 才开始压缩，所以 98% 显示「快满了」但不动手。
    const threshold = compactionThreshold({ used: 982000, window: 1_000_000 }, { reserveTokens: 16384 });
    expect(threshold).not.toBeNull();
    expect(threshold?.tokens).toBe(983616);
    expect(threshold?.ratio).toBeCloseTo(0.983616, 6);
  });

  test("draws nothing when compaction is off, unknown, or the reserve swallows the window", () => {
    expect(compactionThreshold(undefined, { reserveTokens: 16384 })).toBeNull();
    expect(compactionThreshold({ used: 1, window: 0 }, { reserveTokens: 16384 })).toBeNull();
    expect(compactionThreshold({ used: 1, window: 1000 }, { enabled: false, reserveTokens: 10 })).toBeNull();
    expect(compactionThreshold({ used: 1, window: 1000 }, { reserveTokens: 1000 })).toBeNull();
  });

  test("treats a missing reserve as no reserve", () => {
    expect(compactionThreshold({ used: 1, window: 1000 }, null)?.ratio).toBe(1);
    expect(compactionThreshold({ used: 1, window: 1000 }, { reserveTokens: -5 })?.tokens).toBe(1000);
  });
});
