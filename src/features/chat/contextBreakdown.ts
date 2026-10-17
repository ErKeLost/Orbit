import type { DisplayMessage } from "../../lib/protocol";

/**
 * 上下文占用卡的分色估算。
 *
 * 只有一个数是准的：provider 回报的总用量（`get_session_stats` 的
 * `contextUsage.tokens`）。**分类**没有任何接口会给 —— Pi 只知道总量，harness 的
 * 控制消息、工具 schema、provider 的请求包装都是出了 GUI 之后才拼进请求体的。
 * 所以四段颜色只能拿本地手上有的三份材料折算：
 *
 * 1. `runtime.systemPrompt`：`/gui-observe` 回传的完整系统提示词；
 * 2. `runtime.breakdown.toolChars`：`before_provider_request` 里数到的工具 schema 字符数；
 * 3. transcript：消息正文、思考、工具调用与工具结果。
 *
 * 折算出来的四段再**按比例缩放到 provider 给的总量**上（`fitToUsed`），所以四段
 * 加起来永远等于那个真数，估的只是它们之间的比例。卡片底部那句「分类值为预估」
 * 说的就是这件事，不是客套话。
 */

/** 一段来源。`app` 是 GUI 自己塞进请求的东西：截图、图片附件。 */
export type ContextSourceKey = "system" | "conversation" | "tools" | "app";
export type ContextSources = Record<ContextSourceKey, number>;

export const CONTEXT_SOURCE_KEYS: ContextSourceKey[] = ["system", "conversation", "tools", "app"];

/**
 * 一张图折多少 token。
 *
 * 视觉模型按图块计费（约 750 px²/token），Pi 又会把长边压到模型的上限，所以真实
 * 值随 provider、分辨率、宽高比浮动，拿不到。这里取 896×896 这一档的中位值：
 * 宁可低估一张不显眼的图，也不要把一张截图算成对话的十倍。
 */
export const IMAGE_TOKENS = 1_100;

const zero = (): ContextSources => ({ system: 0, conversation: 0, tools: 0, app: 0 });

/**
 * 字符 → token。
 *
 * 中日韩字符按 0.7 token/字（cl100k 与 DeepSeek 分词器的中位表现），其余按
 * 4 字符/token。够用来分比例，不够用来当账本 —— 账本那一半是 provider 给的。
 */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK 部首、假名、统一表意文字、兼容区与全角标点。
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.7 + other / 4);
}

type ToolSnapshot = { result?: unknown; args?: unknown; images?: readonly unknown[] };

export type ContextSourcesInput = {
  systemPrompt?: string | null;
  /** 工具定义的序列化字符数（`runtime.breakdown.toolChars`）。 */
  toolSchemaChars?: number;
  messages?: readonly DisplayMessage[];
  tools?: Readonly<Record<string, ToolSnapshot>>;
};

/** 从三份本地材料折出四段估算值（未缩放）。 */
export function estimateContextSources({ systemPrompt, toolSchemaChars, messages = [], tools = {} }: ContextSourcesInput): ContextSources {
  const sources = zero();
  // 系统提示词 + 工具定义。工具 schema 是 JSON，基本全是 ASCII，字符数 / 4 就够。
  sources.system = estimateTextTokens(systemPrompt) + Math.ceil((toolSchemaChars ?? 0) / 4);
  for (const entry of messages) {
    const message = entry.message;
    // 工具结果的消息体不进 messages（它们归到 transcript.tools），数了就重复。
    if (message.role === "toolResult") continue;
    const content = message.content;
    if (typeof content === "string") {
      sources.conversation += estimateTextTokens(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "image") {
        sources.app += IMAGE_TOKENS;
        continue;
      }
      if (part.type === "toolCall") {
        // 调用参数只在这里数一次：transcript.tools 里那份是同一通调用。
        sources.tools += estimateTextTokens(part.arguments ? JSON.stringify(part.arguments) : part.argsText);
        continue;
      }
      sources.conversation += estimateTextTokens(part.text ?? part.thinking);
    }
  }
  for (const tool of Object.values(tools)) {
    const result = typeof tool.result === "string" ? tool.result : tool.result == null ? "" : JSON.stringify(tool.result);
    sources.tools += estimateTextTokens(result) + estimateTextTokens(tool.args ? JSON.stringify(tool.args) : "");
    sources.app += IMAGE_TOKENS * (tool.images?.length ?? 0);
  }
  return sources;
}

/**
 * 把估算的四段缩放成和 provider 总量一致。
 *
 * 用最大余数法分配取整误差，四段之和严格等于 `used`：条形图的宽度、列表里的数字
 * 和顶部那个大数必须是同一套账，否则用户一眼就看出「加起来不对」。
 */
export function fitToUsed(sources: ContextSources, used: number): ContextSources {
  const target = Math.max(0, Math.round(used));
  const total = CONTEXT_SOURCE_KEYS.reduce((sum, key) => sum + Math.max(0, sources[key] ?? 0), 0);
  if (target <= 0 || total <= 0) return zero();
  const scaled = CONTEXT_SOURCE_KEYS.map((key) => (Math.max(0, sources[key] ?? 0) * target) / total);
  const tokens = scaled.map(Math.floor);
  const fractions = scaled.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction);
  let rest = target - tokens.reduce((sum, value) => sum + value, 0);
  for (const { index } of fractions) {
    if (rest <= 0) break;
    // 只给本来就有量的一段加，别凭空造出一段 1 token 的来源。
    if (scaled[index] < 1) continue;
    tokens[index] += 1;
    rest -= 1;
  }
  return { system: tokens[0], conversation: tokens[1], tools: tokens[2], app: tokens[3] };
}

export type ContextSegment = { key: ContextSourceKey; left: number; width: number };

/**
 * 条形图的每一段，单位是窗口的百分比。
 *
 * 用量超过窗口时（刚压缩完、或 provider 报的数比配置的窗口还大）等比缩到窗口
 * 以内：一条溢出容器的进度条会让人以为上下文还能超发。
 */
export function contextBarSegments(buckets: ContextSources, window: number): ContextSegment[] {
  if (!(window > 0)) return [];
  const entries = CONTEXT_SOURCE_KEYS.map((key) => ({ key, tokens: Math.max(0, buckets[key] ?? 0) }));
  const total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
  if (total <= 0) return [];
  const shrink = total > window ? window / total : 1;
  const segments: ContextSegment[] = [];
  let left = 0;
  for (const { key, tokens } of entries) {
    const width = ((tokens / window) * 100) * shrink;
    if (width > 0) segments.push({ key, left, width });
    left += width;
  }
  return segments;
}
