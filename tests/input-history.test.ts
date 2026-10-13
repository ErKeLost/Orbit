import { describe, expect, test } from "bun:test";
import { inputHistoryEntries, stepInputHistory } from "../src/features/chat/input-history";

describe("composer input history", () => {
  test("up enters at the newest entry and walks back to the oldest", () => {
    expect(stepInputHistory(3, null, "up")).toEqual({ index: 2, restore: false });
    expect(stepInputHistory(3, 2, "up")).toEqual({ index: 1, restore: false });
    expect(stepInputHistory(3, 1, "up")).toEqual({ index: 0, restore: false });
    // At the oldest there is nothing further: swallow the key, do not fall
    // through to moving the caret.
    expect(stepInputHistory(3, 0, "up")).toBeNull();
  });

  test("down walks forward and then restores the reader's own draft", () => {
    expect(stepInputHistory(3, 0, "down")).toEqual({ index: 1, restore: false });
    expect(stepInputHistory(3, 1, "down")).toEqual({ index: 2, restore: false });
    expect(stepInputHistory(3, 2, "down")).toEqual({ index: null, restore: true });
  });

  test("down does nothing until the reader is browsing", () => {
    expect(stepInputHistory(3, null, "down")).toBeNull();
  });

  test("an empty history never handles the key", () => {
    expect(stepInputHistory(0, null, "up")).toBeNull();
    expect(stepInputHistory(0, null, "down")).toBeNull();
    expect(stepInputHistory(0, 0, "up")).toBeNull();
  });

  test("collects only the reader's own non-empty messages, oldest first", () => {
    const messages = [
      { message: { role: "user", content: "first" } },
      { message: { role: "assistant", content: "ignored" } },
      { message: { role: "user", content: "   " } },
      { message: { role: "toolResult", content: "ignored" } },
      { message: { role: "user", content: "second" } },
    ];
    const text = (message: { content: string }) => message.content;
    expect(inputHistoryEntries(messages, text as never)).toEqual(["first", "second"]);
  });
});
