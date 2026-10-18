import { describe, expect, test } from "bun:test";
import { groupDisplayMessages, type DisplayMessage } from "../src/lib/protocol";
import { turnDurationId, turnElapsedMs } from "../src/lib/turn-duration";

const assistant = (timestamp: number, extra: Partial<DisplayMessage> = {}): DisplayMessage => ({
  id: `assistant-${timestamp}`,
  message: { role: "assistant", timestamp, content: [{ type: "text", text: "hi" }] },
  ...extra,
});

const custom = (id: string): DisplayMessage => ({
  id,
  message: { role: "custom", content: [{ type: "text", text: "worker result" }] },
});

describe("turn duration", () => {
  test("a single run reports its own elapsed time", () => {
    expect(turnElapsedMs([assistant(1_000, { startedAt: 1_000, elapsedMs: 14_000 })])).toBe(14_000);
  });

  // 旧数据/防御：升级前 reducer 给每段运行各写一个耗时，取最后一个会把 11m45s 的一轮
  // 显示成最后 2s 的那一段。求和至少把整轮的工作都算进去。
  test("sums every run that carries its own clock", () => {
    const items = [
      assistant(1_000, { startedAt: 1_000, elapsedMs: 705_000 }),
      custom("delivery"),
      assistant(900_000, { startedAt: 899_000, elapsedMs: 2_000 }),
    ];
    expect(turnElapsedMs(items)).toBe(707_000);
  });

  // 分组规则本身就是这个 bug 的一半：`custom`（worker 的结果）并进当前这一组，
  // 所以两次运行落在同一个可见的轮里——耗时在这一层算。
  test("a worker delivery stays in the same group", () => {
    const groups = groupDisplayMessages([
      assistant(1_000, { startedAt: 1_000, elapsedMs: 705_000 }),
      custom("delivery"),
      assistant(900_000, { startedAt: 899_000, elapsedMs: 2_000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(turnElapsedMs(groups[0]!.items)).toBe(707_000);
  });

  test("a run with no assistant reply yet does not erase an earlier one", () => {
    const items = [assistant(1_000, { startedAt: 1_000, elapsedMs: 60_000 }), custom("in-flight")];
    expect(turnElapsedMs(items)).toBe(60_000);
  });

  test("history without per-run timings falls back to the saved duration", () => {
    const items = [assistant(2_000), custom("delivery"), assistant(3_000)];
    const id = turnDurationId(items)!;
    expect(id).toBe("timestamp:2000");
    expect(turnElapsedMs(items, { [id]: 95_000 })).toBe(95_000);
  });

  test("a live group never adds the saved value on top of its own runs", () => {
    const items = [assistant(4_000, { startedAt: 4_000, elapsedMs: 5_000 }), custom("delivery")];
    const id = turnDurationId(items)!;
    expect(turnElapsedMs(items, { [id]: 700_000 })).toBe(5_000);
  });
});
