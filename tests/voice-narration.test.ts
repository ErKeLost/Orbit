/**
 * 语音旁白：工具/弹窗 → 一句话，以及「一句话 → 弹窗回答」。
 *
 * 这一层错了不会抛异常，只会出现三种糟糕的体验：念了一堆没用的（把模型的回答盖掉）、
 * 该开口时一片安静（弹窗把 pi 卡住，人以为它还在跑）、或者猜错弹窗的答案（跑了个
 * 你并不想跑的命令）。所以用例都写成「用户听到什么」和「点了哪个按钮」。
 */
import { describe, expect, test } from "bun:test";
import {
  NARRATION,
  NarrationQueue,
  dialogPhrase,
  replyToDialog,
  toolEndPhrase,
  toolStartPhrase,
} from "../src/features/voice/model/narration";
import type { UiRequest } from "../src/lib/protocol";

const confirm = (message: string): UiRequest => ({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Confirm", message });
const select = (options: string[]): UiRequest => ({ type: "extension_ui_request", id: "d2", method: "select", title: "Pick", options });
const input = (): UiRequest => ({ type: "extension_ui_request", id: "d3", method: "input", title: "Name", placeholder: "Session name" });

describe("toolStartPhrase", () => {
  test("命令念出来的是真的那条命令", () => {
    expect(toolStartPhrase("bash", { command: "npm test" })).toBe("Running npm test.");
  });

  test("路径只念最后一段，不念整条 src/lib", () => {
    expect(toolStartPhrase("read", { path: "/Users/work/pi-gui/src/lib/rpc.ts" })).toBe("Reading rpc.ts.");
  });

  test("搜索念查询词", () => {
    expect(toolStartPhrase("grep", { pattern: "rive_tts_stream" })).toBe("Searching for rive_tts_stream.");
  });

  test("操作屏幕的工具不带参数，也不念参数", () => {
    expect(toolStartPhrase("gui_task", { goal: "点开设置" })).toBe("Working on the screen.");
  });

  test("不认识的工具退化成工具名", () => {
    expect(toolStartPhrase("some_mcp_tool", undefined)).toBe("Calling some_mcp_tool.");
  });

  test("超长命令被截断：念长度就是念延迟", () => {
    const phrase = toolStartPhrase("bash", { command: "a".repeat(200) })!;
    expect(phrase.length).toBeLessThanOrEqual(73);
  });
});

describe("toolEndPhrase", () => {
  test("出错的工具必须说，而且优先级高", () => {
    const phrase = toolEndPhrase("bash", { command: "npm test" }, { isError: true })!;
    expect(phrase.text).toBe("That failed: npm test.");
    expect(phrase.priority).toBe(NARRATION.high);
  });

  test("跑完的短工具不念：一轮里十几个 read 会把模型盖掉", () => {
    expect(toolEndPhrase("read", { path: "a.ts" }, { durationMs: 120 })).toBeNull();
  });

  test("跑了很久的工具念一句，带秒数", () => {
    const phrase = toolEndPhrase("bash", { command: "npm run build" }, { durationMs: 42_400 })!;
    expect(phrase.text).toBe("Running done in 42 seconds.");
    expect(phrase.priority).toBe(NARRATION.low);
  });
});

describe("dialogPhrase", () => {
  test("确认框念的是真正要确认的那句话", () => {
    expect(dialogPhrase(confirm("Run rm -rf dist?"))).toBe("It needs your go-ahead: Run rm -rf dist?. Say yes or no.");
  });

  test("选择框把前四个选项编号念出来", () => {
    const phrase = dialogPhrase(select(["Allow once", "Always allow", "Deny"]))!;
    expect(phrase).toContain("1 Allow once");
    expect(phrase).toContain("3 Deny");
  });

  test("输入框念它的 placeholder，不然用户不知道该说什么", () => {
    expect(dialogPhrase(input())).toBe("It needs a value: Session name.");
  });

  test("非阻塞的通知不进对话", () => {
    expect(dialogPhrase({ type: "extension_ui_request", id: "n", method: "notify", message: "hi" })).toBeNull();
  });
});

describe("replyToDialog", () => {
  test("确认框：中文的「行」就是同意", () => {
    expect(replyToDialog("行，跑吧", confirm("Run it?"))).toEqual({ confirmed: true });
  });

  test("确认框：中文的「算了」就是不同意", () => {
    expect(replyToDialog("算了", confirm("Run it?"))).toEqual({ confirmed: false });
  });

  test("确认框：英文 yes / cancel", () => {
    expect(replyToDialog("yes", confirm("Run it?"))).toEqual({ confirmed: true });
    expect(replyToDialog("cancel it", confirm("Run it?"))).toEqual({ confirmed: false });
  });

  test("确认框：一句话里既有同意又有否定，算没听清", () => {
    expect(replyToDialog("好的不行", confirm("Run it?"))).toBeNull();
  });

  test("确认框：完全不相关的话算没听清，绝不猜", () => {
    expect(replyToDialog("今天天气不错", confirm("Run it?"))).toBeNull();
  });

  test("选择框：序数词选中那一项", () => {
    expect(replyToDialog("第二个", select(["Allow once", "Always allow", "Deny"]))).toEqual({ value: "Always allow" });
    expect(replyToDialog("the third one", select(["Allow once", "Always allow", "Deny"]))).toEqual({ value: "Deny" });
  });

  test("选择框：直接念选项文字也算", () => {
    expect(replyToDialog("always allow", select(["Allow once", "Always allow", "Deny"]))).toEqual({ value: "Always allow" });
  });

  test("选择框：序号越界且文字也不匹配时不猜", () => {
    expect(replyToDialog("第五个", select(["Allow once", "Deny"]))).toBeNull();
  });

  test("输入框：原话就是答案", () => {
    expect(replyToDialog("重构登录", input())).toEqual({ value: "重构登录" });
  });
});

describe("NarrationQueue", () => {
  test("只留一句：后到的同优先级顶掉前一句（过时的旁白不该排队）", () => {
    const queue = new NarrationQueue();
    queue.push({ text: "first", priority: NARRATION.low });
    queue.push({ text: "second", priority: NARRATION.low });
    expect(queue.size).toBe(1);
    expect(queue.take(0)?.text).toBe("second");
  });

  test("更高优先级会插到前面", () => {
    const queue = new NarrationQueue();
    queue.push({ text: "low", priority: NARRATION.low });
    queue.push({ text: "needs you", priority: NARRATION.critical });
    expect(queue.take(0)?.text).toBe("needs you");
  });

  test("低优先级插不进正在等的高优先级", () => {
    const queue = new NarrationQueue();
    queue.push({ text: "needs you", priority: NARRATION.critical });
    queue.push({ text: "low", priority: NARRATION.low });
    expect(queue.take(0)?.text).toBe("needs you");
  });

  test("间隔没到就取不到，并且能算出还差多久", () => {
    const queue = new NarrationQueue();
    queue.push({ text: "one", priority: NARRATION.normal });
    expect(queue.take(0)?.text).toBe("one");
    queue.push({ text: "two", priority: NARRATION.normal });
    expect(queue.take(500)).toBeNull();
    expect(queue.waitMs(500)).toBe(500);
    expect(queue.take(1_000)?.text).toBe("two");
  });

  test("critical 不等待：它卡住了，一秒都不该拖", () => {
    const queue = new NarrationQueue();
    queue.push({ text: "done", priority: NARRATION.low });
    queue.take(0);
    queue.push({ text: "needs you", priority: NARRATION.critical });
    expect(queue.take(0)?.text).toBe("needs you");
  });
});
