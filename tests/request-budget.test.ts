import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_KEEP_RECENT_IMAGES,
  DEFAULT_REQUEST_BUDGET_BYTES,
  applyRequestBudget,
  estimateRequestBytes,
  resolveRequestBudgetSettings,
  type BudgetMessage,
  type RequestBudgetSettings,
} from "../src-tauri/resources/request-budget";

/** 一张「图」：base64 长度就是它占的字节数，这里用可数的字符造。 */
const image = (chars: number, mimeType = "image/png") => ({ type: "image", data: "A".repeat(chars), mimeType });
const user = (content: unknown): BudgetMessage => ({ role: "user", content, timestamp: 1 });
const assistant = (text: string): BudgetMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2 });
const settings = (over: Partial<RequestBudgetSettings> = {}): RequestBudgetSettings => ({
  enabled: true,
  maxRequestBytes: 1_000_000,
  keepRecentImages: DEFAULT_KEEP_RECENT_IMAGES,
  ...over,
});

describe("request budget settings", () => {
  test("defaults keep images, 24MiB, and the two most recent pictures", () => {
    const resolved = resolveRequestBudgetSettings(null);
    expect(resolved).toEqual({ enabled: true, maxRequestBytes: DEFAULT_REQUEST_BUDGET_BYTES, keepRecentImages: DEFAULT_KEEP_RECENT_IMAGES });
    expect(resolveRequestBudgetSettings("nonsense")).toEqual(resolved);
    expect(resolveRequestBudgetSettings({ maxRequestBytes: -1, keepRecentImages: "2" })).toEqual(resolved);
  });

  test("a model that declares its own request limit leaves the reserve behind", () => {
    // 目录里声明的 8MiB 是服务端肯收的上限，预算要刨掉工具 schema 与包装的预留。
    expect(resolveRequestBudgetSettings(null, 8 * 1024 * 1024).maxRequestBytes).toBe(8 * 1024 * 1024 - 512 * 1024);
    // 文件说了算。
    expect(resolveRequestBudgetSettings({ maxRequestBytes: 2_000_000 }, 8 * 1024 * 1024).maxRequestBytes).toBe(2_000_000);
    // 再小的声明也不会压到下限以下。
    expect(resolveRequestBudgetSettings(null, 1000).maxRequestBytes).toBe(512 * 1024);
  });

  test("enabled:false and a zero image floor survive the round trip", () => {
    expect(resolveRequestBudgetSettings({ enabled: false }).enabled).toBe(false);
    expect(resolveRequestBudgetSettings({ keepRecentImages: 0 }).keepRecentImages).toBe(0);
  });
});

describe("request size estimate", () => {
  test("counts base64 characters, not the empty string that replaces them", () => {
    const messages = [user([{ type: "text", text: "看这个" }, image(4000)]), assistant("收到")];
    expect(estimateRequestBytes(messages)).toBe(estimateRequestBytes([user([{ type: "text", text: "看这个" }, { type: "image", data: "", mimeType: "image/png" }]), assistant("收到")]) + 4000);
  });

  test("counts UTF-8 bytes, so Chinese history is not undercounted threefold", () => {
    const messages = [user("汽水音乐窗口没出来")];
    expect(estimateRequestBytes(messages)).toBe(Buffer.byteLength(JSON.stringify(messages), "utf8"));
    expect(estimateRequestBytes(messages)).toBeGreaterThan(JSON.stringify(messages).length);
  });

  test("a message without images is left alone", () => {
    expect(estimateRequestBytes([user("纯文本"), assistant("好")])).toBe(Buffer.byteLength(JSON.stringify([user("纯文本"), assistant("好")]), "utf8"));
  });
});

describe("applyRequestBudget", () => {
  test("leaves a request that already fits exactly as it came", () => {
    const messages = [user([image(1000)]), assistant("ok")];
    const result = applyRequestBudget(messages, settings());
    expect(result.dropped).toBe(0);
    expect(result.messages).toBe(messages);
    expect(result.bytesAfter).toBe(result.bytesBefore);
  });

  test("drops the oldest pictures first and leaves one placeholder per message", () => {
    const messages = [
      user([{ type: "text", text: "第一轮" }, image(300_000), image(300_000)]),
      assistant("看到了"),
      user([{ type: "text", text: "第二轮" }, image(300_000)]),
      assistant("还是不行"),
      user([{ type: "text", text: "第三轮" }, image(300_000)]),
    ];
    const result = applyRequestBudget(messages, settings({ maxRequestBytes: 700_000, keepRecentImages: 1 }));
    // 预算里只放得下两张：最近的一张（floor），加上第二新的那张；第一轮的两张一起走。
    expect(result.dropped).toBe(2);
    expect(result.bytesAfter).toBeLessThanOrEqual(700_000);
    // 最新那张永远在。
    expect(JSON.stringify(result.messages[4])).toContain("A".repeat(300_000));
    // 第一轮的两张合并成一行占位，插在原来第一张的位置。
    const first = result.messages[0].content as { type: string; text?: string }[];
    expect(first[1]).toEqual({ type: "text", text: expect.stringContaining("略去较早的 2 张") });
    expect(first.some(block => block.type === "image")).toBe(false);
    expect(String(first[1].text)).toContain("0.7MiB");
    // 原数组没被改动。
    expect(messages[0]).not.toBe(result.messages[0]);
    expect(JSON.stringify(messages[0])).toContain("A".repeat(300_000));
  });

  test("the current turn's pictures are never what gets dropped", () => {
    // 预算只够一张图，可这一轮用户拖进来三张 —— 三张都留着，丢的是更早的历史。
    const history = Array.from({ length: 4 }, (_, index) => user([image(200_000, `image/png#${index}`)]));
    const current = user([image(200_000), image(200_000), image(200_000)]);
    const result = applyRequestBudget([...history, current], settings({ maxRequestBytes: 700_000, keepRecentImages: 3 }));
    expect(result.dropped).toBe(4);
    const latest = result.messages.at(-1);
    expect(latest).toBe(current);
    const blocks = (latest?.content ?? []) as { type?: string }[];
    expect(blocks.filter(block => block.type === "image")).toHaveLength(3);
    for (const index of [0, 1, 2, 3]) expect(JSON.stringify(result.messages[index])).not.toContain("A".repeat(200_000));
  });

  test("tool result images are history too", () => {
    const toolResult: BudgetMessage = { role: "toolResult", content: [{ type: "text", text: "screenshot" }, image(400_000)], timestamp: 3 };
    const result = applyRequestBudget([toolResult, assistant("看完了"), user([image(50_000)])], settings({ maxRequestBytes: 200_000, keepRecentImages: 1 }));
    expect(result.dropped).toBe(1);
    const content = result.messages[0].content as { type: string; text?: string }[];
    expect(content[0]).toEqual({ type: "text", text: "screenshot" });
    expect(content[1].type).toBe("text");
  });

  test("an image-only message keeps a body after its pictures leave", () => {
    const result = applyRequestBudget([user([image(400_000)]), user([image(100_000)])], settings({ maxRequestBytes: 200_000, keepRecentImages: 1 }));
    const content = result.messages[0].content as { type: string; text?: string }[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(String(content[0].text)).toContain("图片已省略");
  });

  test("disabled, or no images at all, is a no-op", () => {
    const messages = [user([image(9_000_000)]), assistant("ok")];
    expect(applyRequestBudget(messages, settings({ enabled: false, maxRequestBytes: 1000 })).dropped).toBe(0);
    expect(applyRequestBudget([user("没有图"), assistant("ok")], settings({ maxRequestBytes: 1000 })).dropped).toBe(0);
  });

  test("the 51MB session that started this stops being a 413", () => {
    // 十八张 2048px 截图，base64 各约 2.6MB —— 复现当初那份会话的体量。
    const messages: BudgetMessage[] = [];
    for (let turn = 0; turn < 18; turn += 1) {
      messages.push(user([{ type: "text", text: `第 ${turn + 1} 轮` }, image(2_600_000)]));
      messages.push(assistant("好"));
    }
    const before = estimateRequestBytes(messages);
    expect(before).toBeGreaterThan(46_000_000);
    const result = applyRequestBudget(messages, resolveRequestBudgetSettings(null));
    expect(result.bytesAfter).toBeLessThanOrEqual(DEFAULT_REQUEST_BUDGET_BYTES);
    // 24MiB 装得下最近九张左右；其余全部换成占位。
    expect(result.dropped).toBeGreaterThan(0);
    expect(before - result.bytesAfter).toBeGreaterThan(20_000_000);
    // 最近两张还在：被问的那一轮图没有被自己的历史挤掉。
    expect(result.messages.at(-2)).toBe(messages.at(-2));
    expect(JSON.stringify(result.messages.at(-2))).toContain("A".repeat(2_600_000));
    // 留下的一定是最新的一段：旧图还在、更新的图却没了，不会发生。
    const droppedImages = result.messages.filter(message => !JSON.stringify(message).includes("A".repeat(2_600_000)) && String(message.role) === "user");
    expect(droppedImages).toHaveLength(result.dropped);
    expect(JSON.stringify(result.messages[0])).not.toContain("A".repeat(2_600_000));
  });
  test("the reported size is the size that is sent, placeholders included", () => {
    // 这个数被拿去判断“装得下吗”，所以它必须是发出去的东西本身的体积。先前它是
    // “非图片部分 + 保留的图片”拼出来的，漏掉了裁剪自己插进去的占位文本 —— 于是一份
    // 其实还超限的请求会报成装得下。
    const messages = [user([image(300_000, "image/png#old")]), user([image(50_000)])];
    const result = applyRequestBudget(messages, settings({ maxRequestBytes: 200_000, keepRecentImages: 1 }));
    expect(result.dropped).toBe(1);
    expect(result.bytesAfter).toBe(estimateRequestBytes(result.messages));
    expect(result.bytesAfter).toBeGreaterThan(50_000);
    // 占位文本本身在请求里，就应在估算里。
    expect(result.bytesAfter - result.bytesBefore).toBeLessThan(0);
    expect(result.overLimit).toBe(false);
  });

  test("a request the trim cannot rescue says so instead of pretending", () => {
    // 两种救不了的情况都必须报 overLimit：非图片部分自己就超了（占位也没用），以及
    // “最新的一定留”那几张加起来就超了。报出来的意义是让下一个 413 变成可解释的。
    const textOnly = applyRequestBudget([user("x".repeat(400_000))], settings({ maxRequestBytes: 512 * 1024 }));
    expect(textOnly.dropped).toBe(0);
    expect(textOnly.overLimit).toBe(false);

    const heavy = applyRequestBudget([user([image(400_000)]), user([image(400_000)])], settings({ maxRequestBytes: 512 * 1024, keepRecentImages: 2 }));
    expect(heavy.dropped).toBe(0);
    expect(heavy.overLimit).toBe(true);
    expect(heavy.bytesAfter).toBe(estimateRequestBytes(heavy.messages));
  });
});

describe("packaging", () => {
  test("gui-extension 的每个同级依赖都在 tauri 的 resources 清单里", () => {
    // 少一个文件不是“功能少一半”，是扩展整个加载失败 —— 而本地 dev 与打包都从这份清单
    // 拷资源，所以在清单上钉住它。
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(config.bundle.resources).toContain("resources/gui-extension.ts");
    expect(config.bundle.resources).toContain("resources/request-budget.ts");
    const extension = readFileSync(new URL("../src-tauri/resources/gui-extension.ts", import.meta.url), "utf8");
    expect(extension).toContain("from './request-budget.ts'");
  });

  test("每个隔离运行时脚本都带上了 gui-extension 的静态依赖", () => {
    // 这两个脚本手工列资源文件，而扩展是静态 import：少拷一个文件不是“功能少一块”，
    // 是扩展整个加载失败（实测：`Cannot find module './request-budget.ts'`），而
    // `bun run check` 不会跑这两个脚本，所以只能在这里钉住。
    const extension = readFileSync(new URL("../src-tauri/resources/gui-extension.ts", import.meta.url), "utf8");
    const siblings = [...extension.matchAll(/from '\.\/([\w.-]+\.ts)'/g)].map(match => match[1]!);
    expect(siblings).toContain("request-budget.ts");
    for (const script of ["../scripts/smoke-pi.mjs", "../scripts/e2e-gui-task.mjs"]) {
      const source = readFileSync(new URL(script, import.meta.url), "utf8");
      const missing = siblings.filter(name => !source.includes(`'${name}'`) && !source.includes(`"${name}"`));
      expect({ [script]: missing }).toEqual({ [script]: [] });
    }
  });
});
