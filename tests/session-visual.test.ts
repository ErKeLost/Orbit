import { describe, expect, test } from "bun:test";
import { compactTitle } from "../src/lib/session-visual";

describe("compactTitle", () => {
  test("compacts first-message titles for the header", () => {
    expect(compactTitle("  还有一个\n你看看这个是 我用户的 也是可以支持 user message 气泡  ")).toBe(
      "还有一个 你看看这个是 我用户的 也是可以支持…",
    );
    expect(compactTitle("设置")).toBe("设置");
    expect(compactTitle("   ")).toBe("新会话");
  });

});
