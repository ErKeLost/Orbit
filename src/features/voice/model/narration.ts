/**
 * 语音 Agent 的「旁白」：把工具和弹窗事件说成人话。
 *
 * 为什么必须在前端合成、不能让模型说：pi 的一轮由模型驱动，一次工具调用跑 40 秒，
 * 中间它不会自己冒出一句「还在跑」。等模型写旁白 = 多一个 round trip + 几十个 token，
 * 而且它随时会忘。这里只是一次字符串拼接，加上往**已经开着的那条 TTS 流**里写一行字，
 * 端到端比一个 IPC 往返还短。
 *
 * 因此这一层刻意做成纯函数：不碰 React、不碰 store，能在事件回调里直接调，也好测。
 *
 * 两条硬性约束：
 *
 * * **短语必须短。** Rime 的首字延迟随文本长度上升，长句只是更慢，且更容易被用户打断。
 * * **默认英文。** Rime 的 `lang` 里没有中文（见 `rime.rs` 的 LANGS），而
 *   `VOICE_PREFIX` 也已经要求模型用英文说话。多语言模板等真有人切语言再补。
 */
import type { UiRequest } from "@/lib/protocol";
import { toolKind, type ToolKind } from "@/lib/tool-activity";

/** 越小越先说。critical 只给「它卡住等你拍板」这种事。 */
export type NarrationPriority = 0 | 1 | 2 | 3;

export const NARRATION = {
  critical: 0 as NarrationPriority,
  high: 1 as NarrationPriority,
  normal: 2 as NarrationPriority,
  low: 3 as NarrationPriority,
} as const;

export type Narration = { text: string; priority: NarrationPriority };

/** 两句话之间至少隔多久（按后一句的优先级）。旁白比模型的话更该克制。 */
const GAPS: Record<NarrationPriority, number> = { 0: 0, 1: 300, 2: 1_000, 3: 3_000 };

/** 念出来的长度上限：超过这个长度的「短语」已经不是旁白了。 */
const MAX_CHARS = 72;

type Args = Record<string, unknown> | undefined;

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** 路径念最后一段：`src/lib/rpc.ts` 念成 `rpc.ts`，全路径听起来是噪音。 */
function shortPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[\\/]+$/, "");
  const base = clean.split(/[\\/]/).pop() ?? clean;
  return base.slice(0, 40);
}

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_CHARS ? `${single.slice(0, MAX_CHARS - 1)}…` : single;
}

/** 工具名 → 主目标（文件、命令、查询词）。键名在工具之间不统一，按重要性依次取。 */
function target(args: Args): string | undefined {
  return (
    shortPath(str(args?.command) ?? str(args?.cmd) ?? str(args?.script)) ??
    shortPath(str(args?.path) ?? str(args?.file) ?? str(args?.file_path) ?? str(args?.filename)) ??
    str(args?.pattern) ?? str(args?.query) ?? str(args?.q) ?? str(args?.url) ?? str(args?.task)
  );
}

const START_VERB: Record<ToolKind, string> = {
  command: "Running",
  read: "Reading",
  search: "Searching for",
  edit: "Editing",
  computer: "Working on the screen",
  other: "Calling",
};

/** 工具开跑。已结束的历史工具不该念，调用方负责只对新出现的 running 调用。 */
export function toolStartPhrase(name: string, args: Args): string | null {
  const kind = toolKind(name);
  const verb = START_VERB[kind];
  const what = target(args);
  if (kind === "computer") return "Working on the screen.";
  if (!what) return kind === "other" ? `${verb} ${name}.` : `${verb}.`;
  return clip(`${verb} ${what}.`);
}

/**
 * 工具结束。
 *
 * 成功的短工具一律不念：一轮里十几个 `read`，念出来只会盖住模型。只有**出错**
 * 和**跑得久**（≥ 6 秒）值得开口——前者要人，后者说明刚发生了一件有分量的事。
 */
export function toolEndPhrase(
  name: string,
  args: Args,
  outcome: { durationMs?: number; isError?: boolean },
): Narration | null {
  const what = target(args);
  const subject = what ? clip(what) : name;
  if (outcome.isError) return { text: `That failed: ${subject}.`, priority: NARRATION.high };
  const duration = outcome.durationMs ?? 0;
  if (duration < 6_000) return null;
  const seconds = Math.round(duration / 1_000);
  return { text: `${START_VERB[toolKind(name)]} done in ${seconds} seconds.`, priority: NARRATION.low };
}

/** 它卡在弹窗上等你：这条必须说，否则语音里就是「假死」。 */
export function dialogPhrase(request: UiRequest): string | null {
  switch (request.method) {
    case "confirm": {
      const question = str(request.message) ?? request.title;
      return clip(`It needs your go-ahead: ${question}. Say yes or no.`);
    }
    case "select": {
      const options = request.options.slice(0, 4).map((option, index) => `${index + 1} ${option}`).join(", ");
      return clip(`Pick one: ${options}.`);
    }
    case "input":
      return clip(`It needs a value: ${str(request.placeholder) ?? request.title}.`);
    case "editor":
      return clip(`It needs you to write: ${request.title}.`);
    default:
      return null;
  }
}

/** 中文没有词边界，所以 yes/no 用 `includes`，并且两边都命中时判为「没听清」。 */
const YES = ["好", "可以", "确认", "执行", "同意", "行", "对", "嗯", "是", "干吧", "跑吧", "yes", "yeah", "yep", "ok", "okay", "sure", "confirm", "allow", "proceed", "go ahead", "do it"];
const NO = ["不", "别", "取消", "算了", "不行", "停", "不要", "跳过", "no", "nope", "cancel", "stop", "skip", "deny"];

const ORDINALS: Record<string, number> = {
  "1": 0, "一": 0, "第一": 0, "第一个": 0, "first": 0, one: 0,
  "2": 1, "二": 1, "第二": 1, "第二个": 1, "second": 1, two: 1,
  "3": 2, "三": 2, "第三": 2, "第三个": 2, "third": 2, three: 2,
  "4": 3, "四": 3, "第四": 3, "第四个": 3, "fourth": 3, four: 3,
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，。、,.!?！？~…]+/g, " ").trim();
}

/**
 * 这句话里有没有这个词。
 *
 * 英文按词边界算；中文没有边界，只能退一步：**句子很短**（≤ 4 字）时才接受包含关系。
 * 不这么做，「今天天气不错」里的「不」会被当成一句「不要执行」。
 */
function says(said: string, words: string[]): boolean {
  if (words.some((word) => new RegExp(`(^|\\s)${word}(\\s|$)`).test(said))) return true;
  return said.length <= 4 && words.some((word) => said.includes(word));
}

/** 长的先试：「the third one」里的 `one` 不能盖过 `third`。 */
const ORDINAL_KEYS = Object.keys(ORDINALS).sort((a, b) => b.length - a.length);

/**
 * 语音回答 → `extension_ui_response`。
 *
 * 只做确定性映射，不经过模型：弹窗正在**阻塞** pi 的主循环，这时候再发一句 prompt
 * 只会排队排到弹窗之后。匹配不上就返回 `null`，由调用方追问一句，别猜。
 */
export function replyToDialog(
  text: string,
  request: UiRequest,
): { value?: string; confirmed?: boolean; cancelled?: boolean } | null {
  const said = normalize(text);
  if (!said) return null;
  if (request.method === "confirm") {
    const yes = says(said, YES);
    const no = says(said, NO);
    if (yes === no) return null;
    return yes ? { confirmed: true } : { confirmed: false };
  }
  if (request.method === "select") {
    const options = request.options;
    for (const word of ORDINAL_KEYS) {
      const index = ORDINALS[word]!;
      if (index < options.length && new RegExp(`(^| )${word}( |$)`).test(said)) return { value: options[index]! };
    }
    const matches = options.filter((option) => said.includes(normalize(option)));
    if (matches.length === 1) return { value: matches[0]! };
    return null;
  }
  if (request.method === "input" || request.method === "editor") return { value: text.trim() };
  return null;
}

/**
 * 只留一句待播：新的高优先级直接顶掉旧的，同优先级也让新的顶掉旧的。
 *
 * 旁白最怕「攒着播」——工具早跑完了，你还在听上一句的开头。所以队列深度就是 1，
 * 丢掉的都是过时的。
 */
export class NarrationQueue {
  private pending: Narration | null = null;
  private spokenAt = Number.NEGATIVE_INFINITY;

  push(item: Narration): void {
    if (!item.text) return;
    if (!this.pending || item.priority <= this.pending.priority) this.pending = item;
  }

  clear(): void {
    this.pending = null;
  }

  get size(): number {
    return this.pending ? 1 : 0;
  }

  /** 现在能说的那一句；`null` 表示还不到时候（或者本来就没话说）。 */
  take(now: number): Narration | null {
    const item = this.pending;
    if (!item) return null;
    if (now - this.spokenAt < GAPS[item.priority]) return null;
    this.pending = null;
    this.spokenAt = now;
    return item;
  }

  /** 还要等多久才轮得到下一句；没有待播返回 `null`。 */
  waitMs(now: number): number | null {
    if (!this.pending) return null;
    return Math.max(0, GAPS[this.pending.priority] - (now - this.spokenAt));
  }
}
